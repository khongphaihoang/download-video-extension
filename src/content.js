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

  // Chống cài trùng trong CÙNG một world, nhưng vẫn cho phép tự phục hồi:
  //   - Instance cũ còn sống (extension vừa reload nhưng world của tab vẫn tồn tại,
  //     timer/listener cũ đã chết theo extension context) → thay thế nó.
  //   - Cơ chế: instance mới nhất luôn thắng; instance cũ được đánh dấu `retired` và
  //     tự rút lui ở vòng lặp kế tiếp (mọi callback đều kiểm tra instance.isCurrent()).
  const previousInstance = window.__VG_CONTENT_INSTANCE__;
  if (previousInstance) previousInstance.retired = true;

  const instance = { startedAt: Date.now(), ready: false, retired: false };
  instance.isCurrent = () => window.__VG_CONTENT_INSTANCE__ === instance && !instance.retired;
  window.__VG_CONTENT_INSTANCE__ = instance;

  const base = window.__VG_SOCIAL_BASE__;
  const mediaEngine = window.__VG_MEDIA_ENGINE__;
  if (!base || !mediaEngine) {
    const missing = [!base && 'src/social/base.js', !mediaEngine && 'src/media/engine.js']
      .filter(Boolean)
      .join(', ');
    console.error(`[VG:Content] Thiếu dependency: ${missing} — kiểm tra thứ tự file trong manifest.json`);

    // KHÔNG đánh dấu ready: nếu được inject lại (kèm đủ dep) thì file này còn chạy
    // được. Đồng thời trả lời chẩn đoán để popup hiện đúng nguyên nhân thay vì
    // "content script không phản hồi".
    try {
      chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        if (!msg || msg.type !== 'content:ping') return undefined;
        if (window.__VG_CONTENT_INSTANCE__ && window.__VG_CONTENT_INSTANCE__.ready) {
          return undefined;   // script thật đã chạy lại → để nó trả lời
        }
        sendResponse({
          ok: false,
          fatal: `Thiếu ${missing} — thứ tự file trong manifest.json không đúng?`,
          url: location.href,
        });
        return true;
      });
    } catch { /* ignore */ }
    return;
  }

  instance.ready = true;

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

  // Regex dùng chung nằm ở src/social/base.js
  const FILE_RE = base.FILE_EXT_RE;

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

  // Đã từng thấy dấu hiệu media trong frame này chưa? (dùng để quét thưa khi idle)
  let sawMediaHint = false;

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
  const socialModules = Object.values(window.__VG_CONTENT_MODULES__ || {});

  // Chỉ module thuộc platform của trang hiện tại mới được gọi:
  // trang thường vẫn chạy core (bắt MP4/WebM), nhưng không quét script lạ.
  const activeModules = socialModules
    .filter((m) => {
      try { return !!m.matchPage(); } catch { return false; }
    })
    .sort((a, b) => (a.order || 50) - (b.order || 50));

  const activeSet = new Set(activeModules);

  // Ngữ cảnh chia sẻ cho module (module là bên duy nhất hiểu dữ liệu platform)
  const moduleCtx = { add, bumpStat, log, base, mediaEngine };

  const hostOf = base.hostOf;
  const normalize = base.normalizeUrl;

  /**
   * Bước 1 — chuẩn hoá URL (chỉ module đang active được đụng vào URL).
   * Trả { url, steps }: url = null nghĩa là không phải http(s) hợp lệ.
   */
  function normalizeForPlatform(raw) {
    const steps = [];
    let cleaned = raw;

    // Hỏi MỌI module, không chỉ module của platform đang mở: chuẩn hoá URL là phép
    // biến đổi thuần trên host/query (vd bỏ byte-range của CDN Meta để tải cả file),
    // và cần chạy cả trên trang không thuộc platform nào (hành vi cũ).
    for (const m of socialModules) {
      if (typeof m.normalize !== 'function') continue;
      let out = null;
      try { out = m.normalize(cleaned); } catch { out = null; }
      if (typeof out === 'string' && out && out !== cleaned) {
        steps.push({ module: m.name, from: cleaned, to: out });
        cleaned = out;
      }
    }

    return { url: normalize(cleaned), steps };
  }

  /**
   * Bước 2+3 — chấm điểm thuần, KHÔNG đổi state.
   * Dùng chung cho add() (luồng thật) và __VG__.test() (debug).
   */
  function evaluateCandidate(url, source, extra) {
    const out = {
      url,
      source: typeof source === 'string' ? source : String(source || ''),
      host: hostOf(url),
      decisions: [],       // phán quyết của từng platform (kể cả module không active)
      stage: 'asset',      // đang bị loại ở bước nào
      reject: null,
      allow: false,
      isVideo: false,
      platform: null,
      label: null,
      kind: null,
    };

    if (base.BAD_MEDIA_RE.test(url)) {
      out.reject = 'Trùng BAD_RE (ảnh/style/script/segment/manifest)';
      return out;
    }

    // Hỏi từng platform: veto (mọi module) / nhận diện (chỉ module đang active)
    out.stage = 'platform';
    let forceAllow = false;
    let isPlatformVideo = false;
    let defaultLabel = null;
    let forcedKind = null;
    let platform = null;

    for (const m of socialModules) {
      if (typeof m.matchUrl !== 'function') continue;
      let verdict = null;
      try { verdict = m.matchUrl(url, { host: out.host, source, extra }); } catch { verdict = null; }
      if (!verdict) continue;

      out.decisions.push({ module: m.name, active: activeSet.has(m), verdict });
      if (verdict.reject) {
        out.reject = verdict.reject;
        return out;
      }
      if (!activeSet.has(m)) continue;

      if (verdict.allow) forceAllow = true;
      if (verdict.isVideo) isPlatformVideo = true;
      if (!defaultLabel && verdict.label) defaultLabel = verdict.label;
      if (!forcedKind && verdict.kind) forcedKind = verdict.kind;
      if (!platform && verdict.platform) platform = verdict.platform;
    }

    out.stage = 'scontent';
    if (/^scontent/i.test(out.host) && !FILE_RE.test(url) && !isPlatformVideo) {
      out.reject = 'Host scontent không có bằng chứng là video';
      return out;
    }

    out.stage = 'looks-media';
    // MEDIA_EXT_RE (không phải FILE_EXT_RE) để manifest/segment cũng đi tiếp và
    // bị Media Engine phán quyết — cho lý do reject dễ hiểu hơn.
    const looksMedia = forceAllow || isPlatformVideo
      || base.MEDIA_EXT_RE.test(url) || base.MEDIA_HOST_RE.test(out.host);
    if (!looksMedia) {
      out.reject = 'Không có đuôi video và không nằm trong Media Host list';
      return out;
    }

    // Media Engine quyết định đây là loại media nào và có tải được không
    out.stage = 'engine';
    out.kind = forcedKind || mediaEngine.classify(url);
    const engine = mediaEngine.engineFor(out.kind);
    if (!engine || !engine.downloadable) {
      out.reject = `Là '${out.kind}' (${engine ? engine.label : 'manifest/segment'}), không phải video file hoàn chỉnh`;
      return out;
    }

    out.allow = true;
    out.isVideo = isPlatformVideo;
    out.label = defaultLabel;
    out.platform = platform;
    return out;
  }

  function add(raw, source, extra) {
    const norm = normalizeForPlatform(raw);
    if (!norm.url) return false;
    const url = norm.url;

    // Hook trạng thái của platform (vd FB ghi nhớ media path đang phát).
    // Chạy TRƯỚC khi loại trừ để giữ nguyên hành vi cũ.
    let isCurrent = !!(extra && extra.isCurrent);
    for (const m of activeModules) {
      if (typeof m.onCandidate !== 'function') continue;
      let res = null;
      try { res = m.onCandidate({ url, source, extra, items, add }); } catch { res = null; }
      if (res && res.isCurrent) isCurrent = true;
    }

    const verdict = evaluateCandidate(url, source, extra);
    if (verdict.reject) {
      stats.rejected++;
      addLog('reject', source, url, {
        reason: verdict.reject,
        stage: verdict.stage,
        platform: verdict.platform,
      });
      return false;
    }

    const finalLabel = (extra && extra.label) || verdict.label;
    const existing = items.get(url);
    if (existing) {
      if (!existing.sources.includes(source)) existing.sources.push(source);
      if (finalLabel && !existing.label) existing.label = finalLabel;
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

    // Phân loại + kiểm tra tải được đã xong trong evaluateCandidate()
    if (isCurrent) {
      for (const it of items.values()) it.isCurrent = false;
    }

    const newItem = {
      url,
      observedUrl: (extra && extra.observedUrl) || url,
      host: verdict.host,
      platform: verdict.platform,
      kind: verdict.kind,
      mimeType: (extra && extra.mimeType) || null,
      sources: [source],
      label: finalLabel,
      poster: (extra && extra.poster) || null,
      title: (extra && extra.title) || null,
      isCurrent: isCurrent,
      pageUrl: (extra && extra.pageUrl) || location.href,
      pageTitle: (extra && extra.title) || document.title,
      foundAt: Date.now(),
      ytMeta: (extra && extra.ytMeta) || null,
    };

    items.set(url, newItem);
    sawMediaHint = true;
    log.info(`🎯 +[${source}] Thêm video [${verdict.kind}]${verdict.platform ? ' (' + verdict.platform + ')' : ''}: ${url.slice(0, 80)}`);
    addLog('accept', source, url, { kind: verdict.kind, label: newItem.label, platform: verdict.platform });

    scheduleFlush();
    return true;
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(flush, 400);
  }

  function flush() {
    flushTimer = null;
    if (!instance.isCurrent()) return;
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
  let bootError = null;

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.__videoGrabber !== true || typeof d.url !== 'string') return;

    if (d.via === '__ping') {
      injectAlive = true;
      log.info('Đã kết nối với inject.js (MAIN world)');
      addLog('system', 'inject', 'MAIN world script đã kết nối', {});
      return;
    }

    let extra = d.meta ? { ...d.meta } : undefined;

    // Platform tự bọc metadata của mình (vd YouTube → extra.ytMeta)
    for (const m of activeModules) {
      if (typeof m.decorateCandidate !== 'function') continue;
      try { extra = m.decorateCandidate(d.via, extra) || extra; } catch { /* ignore */ }
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
      sawMediaHint = true;
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

    if (base.MEDIA_HOST_RE.test(host)) {
      sawMediaHint = true;
      if (add(name, 'network-media', { label: initiatorType || 'cdn' })) bumpStat('network');
      return;
    }
    if (initiatorType === 'video' || initiatorType === 'audio') {
      sawMediaHint = true;
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
    if (!activeModules.length) return;
    const scripts = document.querySelectorAll('script');
    for (const m of activeModules) {
      if (typeof m.scanScripts !== 'function') continue;
      for (const s of scripts) {
        try { m.scanScripts(s, moduleCtx); } catch { /* ignore */ }
      }
    }
  }

  function scanDeep() {
    const root = document.documentElement;
    if (!root) return;
    for (const m of activeModules) {
      if (typeof m.scanRoot !== 'function') continue;
      try { m.scanRoot(root, moduleCtx); } catch { /* ignore */ }
    }
  }

  // ------------------------------------ theo dõi video đang phát / lướt tới
  function extractPostInfo(el) {
    if (!el) return { title: null, pageUrl: null, poster: null };
    const container =
      el.closest('article') ||
      el.closest('[role="dialog"]') ||
      el.closest('[data-pagelet]') ||
      el.closest('div[role="feed"] > div') ||
      el.parentElement;

    let title = null;
    let pageUrl = null;
    const poster = el.poster || null;

    if (container) {
      const textEl = container.querySelector('h1, h2, [dir="auto"], span[dir="auto"], p');
      if (textEl && textEl.textContent.trim().length > 3) {
        title = textEl.textContent.trim().slice(0, 100);
      }
      const linkEl = container.querySelector('a[href*="/reel/"], a[href*="/reels/"], a[href*="/p/"], a[href*="/videos/"]');
      if (linkEl && linkEl.href) {
        pageUrl = linkEl.href;
      }
    }
    return { title, pageUrl, poster };
  }

  function markVideoActive(videoEl, trigger) {
    if (!videoEl) return;
    if (!instance.isCurrent()) return;
    const src = videoEl.currentSrc || videoEl.src;
    const info = extractPostInfo(videoEl);

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
    for (const m of activeModules) {
      if (typeof m.extractPostCode !== 'function') continue;
      try { code = m.extractPostCode(href); } catch { code = null; }
      if (code) break;
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
    if (!instance.isCurrent()) return;
    if (isIdle()) return;   // frame chưa có media thì bỏ luôn phép đo viewport
    clearTimeout(scrollCheckTimer);
    scrollCheckTimer = setTimeout(checkViewportReels, 350);
  }, { passive: true });

  function scanAll() {
    if (!instance.isCurrent()) return;
    try { scanDom(); } catch { /* ignore */ }
    try { checkViewportReels(); } catch { /* ignore */ }
    try { scanAllScripts(); } catch { /* ignore */ }
  }

  /**
   * Frame chưa từng thấy dấu hiệu media → quét thưa hơn (1/10s thay vì 1/2.5s).
   * Đây là phần quan trọng của `all_frames: true`: một trang nhiều iframe sẽ
   * không còn chạy DOM scan dày đặc trong mọi frame vô can.
   */
  function isIdle() {
    return items.size === 0 && !sawMediaHint;
  }

  function boot() {
    scanAll();
    startPerfObserver();

    const mo = new MutationObserver(() => {
      if (!instance.isCurrent()) { mo.disconnect(); return; }
      clearTimeout(mo._t);
      mo._t = setTimeout(scanAll, isIdle() ? 5000 : 1000);
    });
    mo.observe(document, { childList: true, subtree: true });

    // Vòng quét định kỳ: giữ nguyên mốc dừng 10 phút như trước, nhưng giãn nhịp
    // khi frame không có media (chỉ tìm kiếm, không hook thêm gì nặng).
    const startedAt = Date.now();
    const MAX_MS = 10 * 60 * 1000;
    (function loop() {
      if (!instance.isCurrent() || Date.now() - startedAt > MAX_MS) return;
      setTimeout(() => {
        scanAll();
        loop();
      }, isIdle() ? 10000 : 2500);
    })();

    document.addEventListener('visibilitychange', scanAll);
    window.addEventListener('pagehide', flush, true);
  }

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
      /** true = frame chưa có media nên đang quét thưa (10s/lần thay vì 2.5s). */
      get idle() { return isIdle(); },
      stats,
      scan: () => {
        scanDeep();
        scanAll();
        flush();
        log.info(`Đã quét xong. Tổng video hiện có: ${items.size}`);
        return Array.from(items.values());
      },
      /**
       * Kiểm tra một URL bất kỳ theo đúng luồng chấm điểm của extension:
       * chuẩn hoá → veto/nhận diện của từng platform → scontent → media host → engine.
       * Không đổi state (không thêm item, không gọi hook stateful).
       */
      test: (raw, source = 'manual-test') => {
        const norm = normalizeForPlatform(String(raw || ''));
        if (!norm.url) {
          console.log('%c[VideoGrabber] URL không hợp lệ (không phải http/https)', 'color:#dc2626;font-weight:bold;', raw);
          return { ok: false, reason: 'URL không hợp lệ (không phải http/https)', url: null };
        }

        const verdict = evaluateCandidate(norm.url, source, undefined);
        const engine = verdict.kind ? mediaEngine.engineFor(verdict.kind) : null;
        const result = {
          ok: !verdict.reject,
          source,
          input: String(raw),
          normalized: verdict.url,
          observedUrl: norm.steps.length ? String(raw) : verdict.url,
          normalizeSteps: norm.steps,
          host: verdict.host,
          platform: verdict.platform,
          kind: verdict.kind,
          engine: engine ? engine.id : null,
          downloadable: !!verdict.allow,
          label: verdict.label,
          stage: verdict.stage,
          reason: verdict.reject,
          decisions: verdict.decisions,
        };

        console.group('%c[VideoGrabber] Kiểm tra URL', 'color:#16a34a;font-weight:bold;');
        console.log('URL      :', result.input);
        if (result.normalized !== result.input) console.log('Chuẩn hoá :', result.normalized);
        console.log('Host     :', result.host);
        console.log('Source   :', result.source);
        if (result.decisions.length) console.table(result.decisions.map((d) => ({ module: d.module, active: d.active, verdict: JSON.stringify(d.verdict) })));
        else console.log('Không platform nào nhận diện URL này.');
        if (result.ok) {
          console.log(
            `%c✓ HỢP LỆ%c kind=${result.kind} · engine=${result.engine} · platform=${result.platform || 'generic'}`,
            'color:#16a34a;font-weight:bold;', 'color:inherit;'
          );
        } else {
          console.log(
            `%c✗ BỊ LOẠI%c ${result.reason} (bước: ${result.stage})`,
            'color:#dc2626;font-weight:bold;', 'color:inherit;'
          );
        }
        console.groupEnd();
        return result;
      },
    };
  } catch { /* ignore */ }

  // ------------------------------------------------------------- API nội bộ
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return undefined;
    if (!instance.isCurrent()) return undefined;   // đã có instance mới thay thế

    if (msg.type === 'content:ping') {
      sendResponse({
        ok: true,
        url: location.href,
        isTop: window.top === window,
        localCount: items.size,
        hasObserver: !!perfObserver,
        hasInject: injectAlive,
        bootError,
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

  // Khởi động SAU khi listener chẩn đoán đã đăng ký: nếu boot() lỗi thì popup vẫn
  // nhận được lý do thật thay vì báo chung chung "content script không phản hồi".
  try {
    boot();
  } catch (err) {
    bootError = String((err && err.stack) || err);
    log.err('boot() thất bại:', err);
  }
})();
