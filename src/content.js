/**
 * src/content.js — Bộ điều phối chạy trong ISOLATED world của mọi frame.
 *
 * Nhiệm vụ:
 *   - Lắng nghe sự kiện DOM, quan sát mạng (PerformanceObserver).
 *   - Điều phối các module social (fb, ig, ytb...) đăng ký trong window.__VG_CONTENT_MODULES__.
 *   - Quản lý danh sách video và gửi lên Service Worker (background.js).
 */

(() => {
  'use strict';

  // ---- Nâng Resource Timing buffer -----------------------------------------
  const BUFFER_SIZE = 20000;
  try {
    performance.setResourceTimingBufferSize(BUFFER_SIZE);
  } catch { /* ignore */ }
  try {
    performance.addEventListener('resourcetimingbufferfull', () => {
      performance.clearResourceTimings();
      performance.setResourceTimingBufferSize(BUFFER_SIZE);
    });
  } catch { /* ignore */ }

  const FILE_RE = /\.(mp4|m4v|webm|mkv|mov|avi|flv|f4v)(\?|#|$)/i;
  const BAD_RE = /\.(jpe?g|png|gif|webp|svg|css|js|mjs|woff2?|ttf|ico|json|map|m3u8|mpd|ts|m4s)(\?|#|$)/i;

  const MEDIA_HOST_RE =
    /(^|\.)(video[^.]*\.fbcdn\.net|scontent[^.]*\.fbcdn\.net|cdninstagram\.com|googlevideo\.com|video\.twimg\.com|vimeocdn\.com|tiktokcdn\.com|tiktokcdn-us\.com|akamaized\.net|cloudfront\.net|mux\.com|bunnycdn\.com|streamable\.com|dailymotion\.com|jwplayer\.com|brightcove\.net|kaltura\.com)$/i;

  // Logger
  const log = {
    info: (msg, ...args) =>
      console.log(
        `%c[VG:Content]%c ${msg}`,
        'background:#16a34a;color:#fff;padding:2px 6px;border-radius:3px;font-weight:600;',
        'color:inherit;',
        ...args
      ),
    warn: (msg, ...args) =>
      console.warn(
        `%c[VG:Content]%c ${msg}`,
        'background:#d97706;color:#fff;padding:2px 6px;border-radius:3px;font-weight:600;',
        'color:inherit;',
        ...args
      ),
    err: (msg, ...args) =>
      console.error(
        `%c[VG:Content]%c ${msg}`,
        'background:#dc2626;color:#fff;padding:2px 6px;border-radius:3px;font-weight:600;',
        'color:inherit;',
        ...args
      ),
  };

  const recentLogs = [];
  function addLog(type, source, text, detail) {
    const time = new Date().toLocaleTimeString();
    recentLogs.push({ time, type, source, text: String(text || '').slice(0, 150), detail });
    if (recentLogs.length > 50) recentLogs.shift();
  }

  const items = new Map();
  const sent = new Set();
  let flushTimer = null;

  const stats = {
    fromInject: 0,
    fromNetwork: 0,
    fromDom: 0,
    fromFbJson: 0,
    fromIgJson: 0,
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
    else if (source === 'ig-json') stats.fromIgJson++;
    else if (source === 'msg') stats.fromMsg++;
    else if (source === 'seg') stats.fromSeg++;
    else stats.fromDom++;
  }

  // Các module social đã nạp
  const socialModules = window.__VG_CONTENT_MODULES__ || {};

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
    if (!/^https?:\/\//i.test(s)) return null;
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
    } catch { /* ignore */ }
    return 'file';
  }

  function cleanMediaUrl(raw) {
    let cleaned = raw;
    for (const module of Object.values(socialModules)) {
      const normalizeUrl = module.normalize || module.cleanMediaUrl;
      if (typeof normalizeUrl !== 'function') continue;
      try {
        const next = normalizeUrl.call(module, cleaned);
        if (typeof next === 'string' && next !== cleaned) cleaned = next;
      } catch { /* ignore plugin normalization errors */ }
    }
    return cleaned;
  }

  function evaluateCandidate(url, source, extra) {
    let accepted = false;
    let isCurrent = false;
    let kind = null;
    let label = null;

    for (const module of Object.values(socialModules)) {
      let result = null;
      try {
        if (typeof module.matchUrl === 'function') {
          result = module.matchUrl(url, { source, extra, host: hostOf(url) });
        } else if (typeof module.isCandidate === 'function') {
          result = module.isCandidate(url, hostOf(url), source, extra);
        }
        const rejected = typeof module.isRejected === 'function' ? module.isRejected(url, FILE_RE) : null;
        if (rejected && rejected.reject) return { reject: true, reason: rejected.reason };
      } catch { /* ignore plugin matching errors */ }

      if (!result) continue;
      if (result.reject === true || result.allow === false) return { reject: true, reason: result.reason };
      if (result.allow === true || result.isVideo === true || result === true) accepted = true;
      if (result.isCurrent) isCurrent = true;
      if (result.kind) kind = result.kind;
      if (result.label) label = result.label;
    }

    for (const module of Object.values(socialModules)) {
      if (typeof module.onCandidate !== 'function') continue;
      try {
        const result = module.onCandidate({ url, source, extra, items, add });
        if (result && result.reject) return { reject: true, reason: result.reason };
        if (result && result.isCurrent) isCurrent = true;
        if (result && result.kind) kind = result.kind;
        if (result && result.label) label = result.label;
      } catch { /* ignore plugin candidate errors */ }
    }

    return { accepted, isCurrent, kind, label };
  }

  function add(raw, source, extra) {
    const observedUrl = raw;
    const cleaned = cleanMediaUrl(raw);
    const url = normalize(cleaned);
    if (!url) return false;

    if (BAD_RE.test(url) || /static[^.]*\.fbcdn\.net/i.test(url) || /\/btmanifest\//i.test(url) || /\/rsrc\.php\//i.test(url)) {
      addLog('reject', source, url, { reason: 'Trùng BAD_RE (ảnh/style/script/segment/manifest/static)' });
      return false;
    }

    const host = hostOf(url);
    if (/static[^.]*\.fbcdn\.net/i.test(host)) return false;

    const decision = evaluateCandidate(url, source, extra);
    if (decision.reject) {
      stats.rejected++;
      addLog('reject', source, url, { reason: decision.reason || 'Plugin từ chối candidate' });
      return false;
    }
    const isFromSocialPlugin = decision.accepted;

    if (/^scontent/i.test(host) && !FILE_RE.test(url) && !isFromSocialPlugin && !/\/(?:o1\/v\/|v\/t[0-9])/i.test(url)) {
      addLog('reject', source, url, { reason: 'Host scontent không có bằng chứng là video' });
      return false;
    }

    const hasMediaExt = FILE_RE.test(url);
    const isRecognizedPath = /\/(?:o1\/v\/|v\/t[0-9])/i.test(url);
    const looksMedia = hasMediaExt || isRecognizedPath || source === 'fb-json' || source === 'ig-json'
      || (typeof source === 'string' && (source.startsWith('inject:fb-') || source.startsWith('inject:ig-')))
      || isFromSocialPlugin;

    if (!looksMedia) {
      stats.rejected++;
      addLog('reject', source, url, { reason: 'Không có đuôi video và không có định dạng đường dẫn video hợp lệ' });
      return false;
    }

    const finalLabel = (extra && extra.label) || decision.label || null;

    let moduleProcessIsCurrent = false;
    for (const module of Object.values(socialModules)) {
      if (typeof module.onProcessUrl === 'function') {
        try {
          const res = module.onProcessUrl(url, source, extra, items, add);
          if (res && res.isCurrent) moduleProcessIsCurrent = true;
        } catch { /* ignore */ }
      }
    }

    const isCurrent = !!(extra && extra.isCurrent) || decision.isCurrent || moduleProcessIsCurrent;
    const existing = items.get(url);
    if (existing) {
      if (!existing.sources.includes(source)) existing.sources.push(source);
      if (finalLabel && !existing.label) existing.label = finalLabel;
      if (extra && extra.code && !existing.code) existing.code = extra.code;
      if (isCurrent) {
        for (const it of items.values()) it.isCurrent = false;
        existing.isCurrent = true;
        existing.foundAt = Date.now();
        existing._needsUpdate = true;
        if (extra && extra.title) existing.title = extra.title;
        if (extra && extra.pageUrl) existing.pageUrl = extra.pageUrl;
        scheduleFlush();
      }
      return false;
    }

    // Phân loại kind
    let kind = null;
    kind = decision.kind || (window.__VG_MEDIA_ENGINE__ && window.__VG_MEDIA_ENGINE__.classify(url,
      typeof source === 'string' && source.startsWith('inject:yt-') && source !== 'inject:yt-progressive'
        ? 'yt-adaptive' : null)) || classify(url);

    const downloadable = window.__VG_MEDIA_ENGINE__
      ? window.__VG_MEDIA_ENGINE__.isDownloadable(kind)
      : kind === 'file' || kind === 'yt-adaptive';
    if (!downloadable) {
      stats.rejected++;
      addLog('reject', source, url, { reason: `Là '${kind}' (segment/manifest), không phải video file hoàn chỉnh` });
      return false;
    }

    if (isCurrent) {
      for (const it of items.values()) it.isCurrent = false;
    }

    const newItem = {
      observedUrl,
      url,
      host,
      kind,
      type: kind,
      sources: [source],
      label: finalLabel,
      poster: (extra && extra.poster) || null,
      title: (extra && extra.title) || null,
      code: (extra && extra.code) || null,
      isCurrent: isCurrent,
      pageUrl: (extra && extra.pageUrl) || location.href,
      pageTitle: (extra && extra.title) || document.title,
      foundAt: Date.now(),
      sessionId: (extra && extra.sessionId) || null,
      ytMeta: (extra && extra.ytMeta) || null,
      mimeType: (extra && extra.mimeType) || null,
      width: (extra && extra.width) || 0,
      height: (extra && extra.height) || 0,
      fps: (extra && extra.fps) || 0,
      bitrate: (extra && extra.bitrate) || 0,
      hasAudio: extra && typeof extra.hasAudio === 'boolean' ? extra.hasAudio : null,
      hasVideo: extra && typeof extra.hasVideo === 'boolean' ? extra.hasVideo : true,
    };

    items.set(url, newItem);
    log.info(`🎯 +[${source}] Thêm video [${kind}]: ${url.slice(0, 80)}`);
    addLog('accept', source, url, { kind, label: newItem.label });

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
      if (sent.has(item.url) && !item._needsUpdate) continue;
      sent.add(item.url);
      item._needsUpdate = false;
      batch.push(item);
    }
    if (!batch.length) return;

    const retry = () => {
      stats.sendErrors++;
      batch.forEach((i) => sent.delete(i.url));
    };

    try {
      chrome.runtime.sendMessage({ type: 'media:add', items: batch }).catch(retry);
    } catch {
      retry();
    }
  }

  // ------------------------------- nhận message từ MAIN world (inject.js)
  let injectAlive = false;

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.__videoGrabber !== true) return;

    if (d.via === 'status-request') {
      window.postMessage({
        __videoGrabber: true,
        via: 'status-response',
        requestId: d.requestId,
        status: {
          ok: true,
          url: location.href,
          isTop: window.top === window,
          localCount: items.size,
          hasObserver: !!perfObserver,
          hasInject: injectAlive,
          stats: { ...stats },
          logs: recentLogs.slice(-25),
        },
      }, '*');
      return;
    }

    if (typeof d.url !== 'string') return;

    if (d.via === '__ping') {
      injectAlive = true;
      log.info('Đã kết nối với inject.js (MAIN world)');
      addLog('system', 'inject', 'MAIN world script đã kết nối', {});
      return;
    }

    if (d.via === 'fb-active') {
      for (const module of Object.values(socialModules)) {
        if (typeof module.onActiveContext === 'function') {
          try { module.onActiveContext(d.meta || {}); }
          catch { /* ignore plugin context errors */ }
        }
      }
      addLog('system', 'fb', 'ACTIVE VIDEO context updated', d.meta || {});
      return;
    }

    let extra = d.meta ? { ...d.meta } : undefined;

    // YouTube metadata wrapping
    if (socialModules.ytb && typeof socialModules.ytb.wrapMeta === 'function') {
      extra = socialModules.ytb.wrapMeta(d.via, extra);
    }

    const source = 'inject:' + d.via;
    if (add(d.url, source, extra)) {
      const isYt = d.via && d.via.startsWith('yt-');
      bumpStat(isYt ? 'yt' : 'inject');
    }
  });

  // ---------------------------------------------------------- nguồn DOM
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

  // ------------------------------------------------------- nguồn Mạng (Perf)
  function considerPerfEntry(name, initiatorType) {
    if (!name) return;
    const host = hostOf(name);

    if (MEDIA_HOST_RE.test(host)) {
      if (add(name, 'network-media', { label: initiatorType || 'cdn' })) bumpStat('network');
      return;
    }
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

  // --------------------------------- quét scripts thông qua các module social
  function scanAllScripts() {
    document.querySelectorAll('script').forEach((s) => {
      for (const m of Object.values(socialModules)) {
        if (typeof m.scanScripts === 'function') {
          m.scanScripts(s, add, bumpStat);
        }
      }
    });
  }

  function scanDeep() {
    const root = document.documentElement;
    if (!root) return;
    for (const m of Object.values(socialModules)) {
      if (typeof m.scanDeep === 'function') {
        try { m.scanDeep(root, add, bumpStat); }
        catch { /* ignore */ }
      }
    }
  }

  // ------------------------------------ theo dõi video đang phát / lướt tới
  function extractPostInfo(el) {
    if (!el) return { title: null, pageUrl: null, poster: null };
    const isSingleVideoUrl = /(?:\/reel\/|\/reels\/|\/watch|\/videos\/|\/posts\/|\/p\/)/i.test(location.pathname)
      || /[?&]v=[0-9]+/i.test(location.search);

    const container =
      el.closest('div[style*="scroll-snap-align"]') ||
      el.closest('div[data-video-id]') ||
      el.closest('article') ||
      el.closest('[role="dialog"]') ||
      el.closest('div[role="feed"] > div') ||
      el.closest('div[data-visualcompletion="ignore-dynamic-attribute"]') ||
      el.parentElement;

    let title = null;
    let pageUrl = isSingleVideoUrl ? location.href : null;
    const poster = el.poster || null;

    if (container) {
      const textEl = container.querySelector('h1, h2, [dir="auto"], span[dir="auto"], p');
      if (textEl && textEl.textContent.trim().length > 3) {
        title = textEl.textContent.trim().slice(0, 100);
      }
      if (!pageUrl) {
        const linkEl = container.querySelector(
          'a[href*="/reel/"], a[href*="/reels/"], a[href*="/p/"], a[href*="/videos/"], a[href*="/watch"], a[href*="?v="], a[href*="/posts/"], a[href*="story_fbid="], a[href*="/share/v/"], a[href*="/share/r/"]'
        );
        if (linkEl && linkEl.href) {
          pageUrl = linkEl.href;
        }
      }
    }
    return { title, pageUrl: pageUrl || location.href, poster };
  }

  function markVideoActive(videoEl, trigger) {
    if (!videoEl) return;
    const src = videoEl.currentSrc || videoEl.src;
    const info = extractPostInfo(videoEl);
    const activeContext = { videoEl, pageUrl: info.pageUrl || location.href, title: info.title, poster: info.poster };
    for (const module of Object.values(socialModules)) {
      if (typeof module.onVideoPlay !== 'function') continue;
      try { module.onVideoPlay(videoEl, activeContext); }
      catch { /* ignore plugin context errors */ }
    }

    if (src && /^https?:\/\//i.test(src) && !src.startsWith('blob:')) {
      log.info(`🎯 [${trigger}] Bắt video direct src:`, src.slice(0, 80));
      add(src, trigger, {
        label: 'Đang phát',
        isCurrent: true,
        poster: info.poster,
        title: info.title,
        pageUrl: info.pageUrl || location.href,
      });
      return;
    }

    const href = info.pageUrl || location.href;
    let code = null;
    for (const m of Object.values(socialModules)) {
      if (typeof m.matchVideoCode === 'function') {
        code = m.matchVideoCode(href);
        if (code) break;
      }
    }

    log.info(`🎯 [${trigger}] Video dùng blob:, yêu cầu MAIN world giải mã code [${code}]:`, href);
    window.postMessage(
      {
        __videoGrabberAction: 'resolveVideo',
        code: code,
        title: info.title,
        pageUrl: info.pageUrl || location.href,
      },
      '*'
    );
  }

  document.addEventListener('play', (e) => {
    if (e.target && e.target.tagName === 'VIDEO') markVideoActive(e.target, 'video-play');
  }, true);

  document.addEventListener('playing', (e) => {
    if (e.target && e.target.tagName === 'VIDEO') markVideoActive(e.target, 'video-playing');
  }, true);

  document.addEventListener('click', (e) => {
    const v =
      e.target.tagName === 'VIDEO'
        ? e.target
        : e.target.querySelector('video') || e.target.closest('article')?.querySelector('video');
    if (v) setTimeout(() => markVideoActive(v, 'video-click'), 200);
  }, true);

  let scrollCheckTimer = null;
  function checkViewportReels() {
    const videos = document.querySelectorAll('video');
    for (const v of videos) {
      if (v.paused) continue;
      const rect = v.getBoundingClientRect();
      const visibleHeight = Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0);
      const visibleWidth = Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0);
      if (visibleHeight > 150 && visibleWidth > 150) {
        markVideoActive(v, 'reels-active');
        break;
      }
    }
  }

  window.addEventListener('scroll', () => {
    clearTimeout(scrollCheckTimer);
    scrollCheckTimer = setTimeout(checkViewportReels, 350);
  }, { passive: true, capture: true });

  function scanAll() {
    try { scanDom(); } catch { /* ignore */ }
    try { checkViewportReels(); } catch { /* ignore */ }
    try { scanAllScripts(); } catch { /* ignore */ }
  }

  function boot() {
    scanAll();
    startPerfObserver();

    const mo = new MutationObserver(() => {
      clearTimeout(mo._t);
      mo._t = setTimeout(scanAll, 1000);
    });
    mo.observe(document, { childList: true, subtree: true });

    const loop = setInterval(scanAll, 2500);
    setTimeout(() => clearInterval(loop), 10 * 60 * 1000);

    document.addEventListener('visibilitychange', scanAll);
    window.addEventListener('pagehide', flush, true);
  }

  boot();

  log.info('Content script đã sẵn sàng', {
    url: location.href,
    isTop: window.top === window,
    buffer: BUFFER_SIZE,
  });

  // ---- Expose DevTools Global Helper
  try {
    window.__VG__ = window.__VIDEO_GRABBER__ = {
      status: () => {
        console.group('%c[VideoGrabber] Báo Cáo Trạng Thái', 'color:#16a34a;font-size:13px;font-weight:bold;');
        console.log('URL hiện tại:', location.href);
        console.log('Top Frame:', window.top === window);
        console.log('Tổng video bắt được:', items.size);
        console.log('Inject (MAIN world) sống:', injectAlive);
        console.log('PerformanceObserver:', !!perfObserver);
        console.table(stats);
        console.groupEnd();
        return '💡 Gõ __VG__.items để xem link, __VG__.logs để xem sự kiện, __VG__.scan() để quét lại ngay';
      },
      get items() { return Array.from(items.values()); },
      get logs() { return recentLogs; },
      stats,
      scan: () => {
        scanDeep();
        scanAll();
        flush();
        log.info(`Đã quét xong. Tổng video hiện có: ${items.size}`);
        return Array.from(items.values());
      },
    };
  } catch { /* ignore */ }

  // ------------------------------------------------------------- API nội bộ
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return undefined;

    if (msg.type === 'content:ping') {
      sendResponse({
        ok: true,
        url: location.href,
        isTop: window.top === window,
        localCount: items.size,
        hasObserver: !!perfObserver,
        hasInject: injectAlive,
        stats: { ...stats },
        logs: recentLogs.slice(-25),
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

    if (msg.type === 'content:probe') {
      (async () => {
        try {
          const res = await fetch(msg.url, {
            headers: { Range: 'bytes=0-1' },
            credentials: 'include',
          });
          sendResponse({
            ok: res.ok,
            status: res.status,
            contentType: res.headers.get('content-type') || '',
          });
        } catch (err) {
          sendResponse({ ok: false, status: 0, error: String(err) });
        }
      })();
      return true;
    }

    return undefined;
  });
})();
