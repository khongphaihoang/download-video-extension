/**
 * content.js — chạy trong mọi frame của mọi trang.
 *
 * Tìm link video từ 3 nguồn độc lập:
 *   1. DOM      : <video src>, <video><source>, <a href="...mp4">
 *   2. Mạng     : PerformanceObserver bắt request media mà trang thực hiện
 *   3. Facebook : regex JSON nhúng trong <script> (browser_native_*_url, playable_url…)
 *
 * Nguồn (3) là thứ khiến group private hoạt động: dữ liệu đó chỉ có được
 * vì content script chạy trong session đã đăng nhập của chính bạn.
 */

(() => {
  'use strict';

  // ---- Nâng Resource Timing buffer NGAY, trước mọi thứ khác ----------------
  // Mặc định Chrome chỉ giữ 250 entry. Khi đầy, entry MỚI BỊ VỨT BỎ hoàn toàn
  // và PerformanceObserver không hề hay biết → mất sạch video.
  const BUFFER_SIZE = 20000;
  try {
    performance.setResourceTimingBufferSize(BUFFER_SIZE);
  } catch {
    /* ignore */
  }
  try {
    performance.addEventListener('resourcetimingbufferfull', () => {
      // Đã harvest vào `items` rồi nên xoá buffer là an toàn.
      performance.clearResourceTimings();
      performance.setResourceTimingBufferSize(BUFFER_SIZE);
    });
  } catch {
    /* ignore */
  }

  // Chỉ nhận URL trông giống video hoàn chỉnh — bỏ manifest và segment.
  const FILE_RE = /\.(mp4|m4v|webm|mkv|mov|avi|flv|f4v)(\?|#|$)/i;
  // Loại trừ asset tĩnh và cả manifest/segment để tránh bắt nhầm.
  const BAD_RE = /\.(jpe?g|png|gif|webp|svg|css|js|mjs|woff2?|ttf|ico|json|map|m3u8|mpd|ts|m4s)(\?|#|$)/i;

  // CDN phát video phổ biến — nhận cả URL không có đuôi file (MSE/DASH).
  const MEDIA_HOST_RE =
    /(^|\.)(video[^.]*\.fbcdn\.net|fbcdn\.net|googlevideo\.com|video\.twimg\.com|vimeocdn\.com|tiktokcdn\.com|tiktokcdn-us\.com|akamaized\.net|cloudfront\.net|mux\.com|bunnycdn\.com|streamable\.com|dailymotion\.com|jwplayer\.com|brightcove\.net|kaltura\.com)$/i;

  // YouTube DASH segment — tải riêng lẻ không xem được (thiếu audio hoặc chỉ là 1 chunk)
  const YOUTUBE_HOST_RE = /(^|\.)googlevideo\.com$/i;

  const FB_KEYS = [
    'browser_native_hd_url',
    'browser_native_sd_url',
    'playable_url_quality_hd',
    'playable_url',
    'hd_src',
    'sd_src',
    'progressive_url',
  ];

  /** @type {Map<string, object>} url -> item */
  const items = new Map();
  const seenNodes = new WeakSet();
  const sent = new Set();
  let flushTimer = null;

  /** Đếm theo nguồn — dùng cho panel chẩn đoán trong popup. */
  const stats = {
    fromInject: 0,
    fromNetwork: 0,
    fromDom: 0,
    fromFbJson: 0,
    fromYt: 0,
    fromMsg: 0,
    fromSeg: 0,
    rejected: 0,
    sendErrors: 0,
  };

  function bumpStat(source) {
    if (source === 'inject') stats.fromInject++;
    else if (source === 'yt') stats.fromYt++;
    else if (source === 'network') stats.fromNetwork++;
    else if (source === 'fb-json') stats.fromFbJson++;
    else if (source === 'msg') stats.fromMsg++;
    else if (source === 'seg') stats.fromSeg++;
    else stats.fromDom++;
  }

  // ---------------------------------------------------------------- helpers

  /** Giải mã chuỗi escape trong JSON nhúng của Facebook (\u0025 -> %, \/ -> /). */
  function unescapeJson(s) {
    return s
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\\//g, '/')
      .replace(/\\\\/g, '\\');
  }

  function hostOf(url) {
    try {
      return new URL(url).hostname;
    } catch {
      return '';
    }
  }

  function normalize(raw) {
    if (typeof raw !== 'string' || !raw) return null;
    const s = raw.replace(/&amp;/g, '&').replace(/^\s+|\s+$/g, '');
    if (!/^https?:\/\//i.test(s)) return null; // bỏ blob:, data:, javascript:
    return s.split('#')[0];
  }

  function classify(url) {
    if (/\.m3u8(\?|#|$)/i.test(url)) return 'hls';
    if (/\.mpd(\?|#|$)/i.test(url)) return 'dash';
    try {
      const u = new URL(url);
      if (u.searchParams.has('bytestart') || u.searchParams.has('byteend')) return 'segment';
      if (/\.m4s(\?|#|$)/i.test(url)) return 'segment';
      if (/\.ts(\?|#|$)/i.test(url)) return 'segment';
    } catch {
      /* ignore */
    }
    return 'file';
  }

  /**
   * `add` cố tình dễ tính — người gọi đã tự lọc rồi. Ở đây chỉ chặn rác rõ ràng.
   * @returns {boolean} true nếu là URL mới.
   */
  function add(raw, source, extra) {
    const url = normalize(raw);
    if (!url) return false;
    if (BAD_RE.test(url)) return false;

    const host = hostOf(url);
    // scontent là host ảnh của Facebook — chặn, TRỪ khi URL có đuôi media rõ ràng.
    if (/^scontent/i.test(host) && !FILE_RE.test(url)) return false;

    // YouTube: cho phép URL googlevideo.com NẾU đến từ YouTube parser của chúng ta.
    const isFromYtParser = typeof source === 'string' && source.startsWith('inject:yt-');
    if (YOUTUBE_HOST_RE.test(host) && !isFromYtParser) {
      stats.rejected++;
      return false;
    }

    const looksMedia = FILE_RE.test(url) || MEDIA_HOST_RE.test(host) || source === 'fb-json'
      || (typeof source === 'string' && source.startsWith('inject:fb-'))
      || isFromYtParser;
    if (!looksMedia) {
      stats.rejected++;
      return false;
    }

    const existing = items.get(url);
    if (existing) {
      if (!existing.sources.includes(source)) existing.sources.push(source);
      if (extra && extra.label && !existing.label) existing.label = extra.label;
      return false;
    }

    // YouTube: gán kind đặc biệt để popup nhận ra
    let kind = classify(url);
    if (isFromYtParser) {
      kind = source === 'inject:yt-progressive' ? 'file' : 'yt-adaptive';
    }

    // CHỈ GIỮ LINK VIDEO HOÀN CHỈNH — loại bỏ segment, HLS manifest, DASH manifest
    if (kind !== 'file' && kind !== 'yt-adaptive') {
      stats.rejected++;
      return false;
    }

    items.set(url, {
      url,
      host,
      kind,
      sources: [source],
      label: (extra && extra.label) || null,
      poster: (extra && extra.poster) || null,
      pageUrl: location.href,
      pageTitle: document.title,
      foundAt: Date.now(),
      // metadata YouTube (nếu có)
      ytMeta: (extra && extra.ytMeta) || null,
    });

    scheduleFlush();
    return true;
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(flush, 400);
  }

  function flush() {
    flushTimer = null;
    const batch = [];
    for (const item of items.values()) {
      if (sent.has(item.url)) continue;
      sent.add(item.url);
      batch.push(item);
    }
    if (!batch.length) return;

    const retry = () => {
      stats.sendErrors++;
      batch.forEach((i) => sent.delete(i.url));
    };

    try {
      // sendMessage trả Promise: lỗi (SW ngủ, extension reload) nằm ở rejection,
      // KHÔNG phải ở try/catch đồng bộ.
      chrome.runtime.sendMessage({ type: 'media:add', items: batch }).catch(retry);
    } catch {
      retry();
    }
  }

  // ------------------------------- nguồn 1: message từ MAIN world (inject.js)

  // Cờ theo dõi inject.js đang sống — content.js (ISOLATED world) không thể
  // đọc window.__videoGrabberInjected (MAIN world), nên dùng postMessage ping.
  let injectAlive = false;

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.__videoGrabber !== true || typeof d.url !== 'string') return;

    // Nhận ping từ inject.js — chỉ ghi nhận, không add URL rỗng
    if (d.via === '__ping') {
      injectAlive = true;
      return;
    }

    // Truyền metadata YouTube qua extra
    const extra = d.meta ? { label: d.meta.label, ytMeta: d.meta } : undefined;
    const source = 'inject:' + d.via;
    if (add(d.url, source, extra)) {
      const isYt = d.via && d.via.startsWith('yt-');
      bumpStat(isYt ? 'yt' : 'inject');
      console.debug('[VideoGrabber] +inject/' + d.via, d.url);
    }
  });

  // ---------------------------------------------------------- nguồn 2: DOM

  function scanDom() {
    document.querySelectorAll('video').forEach((v) => {
      const src = v.currentSrc || v.src;
      if (src && add(src, 'video-tag', { poster: v.poster || null })) bumpStat('dom');
      v.querySelectorAll('source').forEach((s) => {
        if (s.src && add(s.src, 'source-tag')) bumpStat('dom');
      });
    });

    document.querySelectorAll('a[href]').forEach((a) => {
      const href = a.getAttribute('href');
      if (href && FILE_RE.test(href) && add(a.href, 'anchor')) bumpStat('dom');
    });
  }

  // ------------------------------------------------------- nguồn 3: mạng

  function considerPerfEntry(name, initiatorType) {
    if (!name) return;
    const host = hostOf(name);

    if (MEDIA_HOST_RE.test(host)) {
      if (add(name, 'network-media', { label: initiatorType || 'cdn' })) bumpStat('network');
      return;
    }
    // Trình duyệt tự tải media. Lưu ý: với MSE thì initiatorType là
    // 'fetch'/'xmlhttprequest', KHÔNG phải 'video' — nên nhánh dưới ít khi chạy.
    if (initiatorType === 'video' || initiatorType === 'audio') {
      if (add(name, 'network-media', { label: initiatorType })) bumpStat('network');
      return;
    }
    if (FILE_RE.test(name) && add(name, 'network')) bumpStat('network');
  }

  function scanPerf() {
    let entries;
    try {
      entries = performance.getEntriesByType('resource');
    } catch {
      return;
    }
    for (const e of entries) considerPerfEntry(e.name, e.initiatorType);
  }

  let perfObserver = null;

  function startPerfObserver() {
    if (perfObserver || typeof PerformanceObserver === 'undefined') return;
    try {
      perfObserver = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) considerPerfEntry(e.name, e.initiatorType);
      });
      perfObserver.observe({ type: 'resource', buffered: true });
    } catch {
      perfObserver = null;
    }
  }

  // ------------------------------------------- nguồn 3: JSON nhúng Facebook

  function extractFbJson(text) {
    for (const key of FB_KEYS) {
      const re = new RegExp('"' + key + '"\\s*:\\s*"([^"]{20,4000})"', 'g');
      let m;
      while ((m = re.exec(text)) !== null) {
        const url = unescapeJson(m[1]);
        if (/^https?:\/\//i.test(url) && add(url, 'fb-json', { label: key })) bumpStat('fb-json');
      }
    }
  }

  function scanFbScripts() {
    document.querySelectorAll('script').forEach((s) => {
      if (seenNodes.has(s)) return;
      seenNodes.add(s);
      const t = s.textContent;
      if (!t || t.length < 80) return;
      if (!t.includes('browser_native') && !t.includes('playable_url') && !t.includes('hd_src')) {
        return;
      }
      extractFbJson(t);
    });
  }

  /** Quét sâu toàn bộ HTML — chỉ gọi khi người dùng bấm "Quét sâu". */
  function scanDeep() {
    const root = document.documentElement;
    if (!root) return;
    try {
      extractFbJson(root.innerHTML);
    } catch {
      /* ignore */
    }
  }

  // --------------------------------------------------------------- vòng lặp

  /** Mỗi nguồn bọc try/catch riêng: một nguồn lỗi không được giết các nguồn khác. */
  function scanAll() {
    try {
      scanDom();
    } catch {
      /* ignore */
    }
    try {
      scanPerf();
    } catch {
      /* ignore */
    }
    try {
      scanFbScripts();
    } catch {
      /* ignore */
    }
  }

  function boot() {
    scanAll();
    startPerfObserver();

    // Quan sát `document` (luôn tồn tại), KHÔNG phải document.documentElement —
    // ở document_start thẻ <html> có thể chưa được tạo và observe() sẽ throw,
    // làm chết toàn bộ IIFE.
    const mo = new MutationObserver(() => {
      clearTimeout(mo._t);
      mo._t = setTimeout(scanAll, 800);
    });
    mo.observe(document, { childList: true, subtree: true });

    // Facebook là SPA: <script> mới xuất hiện khi bạn mở video.
    const loop = setInterval(scanAll, 2000);
    setTimeout(() => clearInterval(loop), 10 * 60 * 1000); // tự tắt sau 10 phút

    document.addEventListener('visibilitychange', scanAll);
    window.addEventListener('click', () => setTimeout(scanAll, 1200), true);
    window.addEventListener('pagehide', flush, true);
  }

  boot();

  console.debug('[VideoGrabber] content ready', {
    url: location.href,
    isTop: window.top === window,
    buffer: BUFFER_SIZE,
  });

  // ------------------------------------------------------------- API nội bộ

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return undefined;

    // Dùng để popup phân biệt "content script không chạy" vs "chạy nhưng không thấy gì".
    if (msg.type === 'content:ping') {
      sendResponse({
        ok: true,
        url: location.href,
        isTop: window.top === window,
        localCount: items.size,
        hasObserver: !!perfObserver,
        hasInject: injectAlive,
        stats: { ...stats },
      });
      return true;
    }

    if (msg.type === 'content:rescan') {
      scanDeep();
      scanAll();
      flush();
      sendResponse({ ok: true, count: items.size });
      return true;
    }

    return undefined;
  });
})();
