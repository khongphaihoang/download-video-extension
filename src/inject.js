/**
 * src/inject.js — Core chạy trong MAIN world của trang.
 *
 * Nhiệm vụ (KHÔNG chứa logic riêng của platform nào):
 *   - Hook fetch, XHR, video.src, video.play trong MAIN world.
 *   - Gọi interface chung của các social module đăng ký trong
 *     window.__VG_INJECT_MODULES__ (helper + default nằm ở src/social/base.js).
 *   - Chuyển tiếp candidate URL sang content script qua window.postMessage.
 *
 * Interface một social module (MAIN world):
 *   name, order, matchPage(), matchUrl(url, info), matchApi(url),
 *   onRequest(url, ctx), onResponse(body, ctx), onVideoPlay(videoEl, ctx),
 *   resolve(code, pageUrl, title, ctx), isCurrentRequest(url, ctx), init(ctx).
 */

(() => {
  'use strict';

  if (window.__videoGrabberInjected) return;   // chống cài hook trùng lặp
  window.__videoGrabberInjected = true;

  const base = window.__VG_SOCIAL_BASE__;
  if (!base) {
    console.warn('[VG:Inject] Thiếu src/social/base.js — kiểm tra manifest.json');
    return;
  }

  const log = {
    info: (msg, ...args) =>
      console.log(
        `%c[VG:Inject]%c ${msg}`,
        'background:#9333ea;color:#fff;padding:2px 6px;border-radius:3px;font-weight:600;',
        'color:inherit;',
        ...args
      ),
    warn: (msg, ...args) =>
      console.warn(
        `%c[VG:Inject]%c ${msg}`,
        'background:#d97706;color:#fff;padding:2px 6px;border-radius:3px;font-weight:600;',
        'color:inherit;',
        ...args
      ),
  };

  log.info('Đã nạp vào MAIN world thành công trên trang:', location.hostname);

  window.__VG_INJECT__ = {
    loadedAt: new Date().toISOString(),
    host: location.hostname,
    active: true,
  };

  // Thông báo cho content.js (ISOLATED world) biết inject.js đã chạy
  window.postMessage({ __videoGrabber: true, url: '', via: '__ping' }, '*');

  // Các module social đã đăng ký (manifest nạp module trước file này)
  const socialModules = Object.values(window.__VG_INJECT_MODULES__ || {});

  // Chỉ module thuộc platform của trang hiện tại mới được gọi.
  // Nhờ vậy các hook nặng (clone response, React Fiber, quét DOM...) không chạy
  // trên những website không liên quan.
  const activeModules = socialModules
    .filter((m) => {
      try { return !!m.matchPage(); } catch { return false; }
    })
    .sort((a, b) => (a.order || 50) - (b.order || 50));

  const activeSet = new Set(activeModules);

  /**
   * Candidate có phải media không?
   * Core chỉ tổng hợp phán quyết từ module (matchUrl) rồi áp heuristic chung.
   */
  function isCandidate(url, via) {
    if (typeof url !== 'string' || url.length < 12) return false;
    if (!/^https?:\/\//i.test(url)) return false;
    if (base.BAD_ASSET_RE.test(url)) return false;

    let host = '';
    try {
      host = new URL(url).hostname;
    } catch {
      return false;
    }

    let isPlatformVideo = false;
    let isStreamSegment = false;

    // Mọi module đều có quyền VETO (vd googlevideo không đến từ YT parser);
    // nhưng chỉ module của platform đang mở mới được "nhận diện" candidate.
    for (const m of socialModules) {
      let verdict = null;
      try { verdict = m.matchUrl(url, { host, via }); } catch { verdict = null; }
      if (!verdict) continue;
      if (verdict.reject) return false;
      if (!activeSet.has(m)) continue;
      if (verdict.isVideo || verdict.allow) isPlatformVideo = true;
      if (verdict.isStreamSegment) isStreamSegment = true;
    }

    if (/^scontent/i.test(host) && !base.MEDIA_EXT_RE.test(url)
      && !isPlatformVideo && !isStreamSegment) return false;

    if (base.MEDIA_EXT_RE.test(url)) return true;
    return base.MEDIA_HOST_RE.test(host);
  }

  let lastActiveVideoTime = 0;
  let lastActiveVideoEl = null;

  function report(url, via, meta) {
    try {
      // Cho module quan sát request gốc (YouTube bắt link videoplayback ở đây).
      // Hook này rẻ và tự kiểm tra URL, nên vẫn gọi cả khi module không active.
      for (const m of socialModules) {
        try { m.onRequest(url, moduleContext); } catch { /* ignore */ }
      }

      if (!isCandidate(url, via)) return;

      if (via === 'fetch' || via === 'xhr') {
        if (Date.now() - lastActiveVideoTime < 3500) {
          // Module quyết định request này có phải media đang phát không
          // (Facebook chỉ tính byte-range; platform khác mặc định có).
          let verdict = null;
          for (const m of activeModules) {
            let v = null;
            try { v = m.isCurrentRequest(url, moduleContext); } catch { v = null; }
            if (v !== null && v !== undefined) { verdict = !!v; break; }
          }
          if (verdict !== false) {
            meta = meta || {};
            meta.isCurrent = true;
            meta.label = 'Đang phát';
          }
        }
      }

      log.info(`🎯 [${via}] Bắt được candidate URL:`, url.slice(0, 90));
      window.postMessage({ __videoGrabber: true, url: String(url), via, meta }, '*');
    } catch { /* ignore */ }
  }

  // Ngữ cảnh dùng chung cho các module
  const moduleContext = {
    log,
    report,
    base,
    activeModules,
  };

  function handleActiveVideoPlay(videoEl) {
    if (!videoEl) return;
    lastActiveVideoTime = Date.now();
    lastActiveVideoEl = videoEl;

    // 1. <video> có src http thật (không phải blob:) → báo luôn.
    //    via giữ nguyên tên 'react-fiber' để tương thích dữ liệu/khớp source cũ.
    const directSrc = base.directMediaSrc(videoEl);
    if (directSrc) {
      report(directSrc, 'react-fiber', { isCurrent: true, label: 'Đang phát' });
      return;
    }

    // 2. Giao cho từng platform tự xử lý (React Fiber, postMap, player state...).
    //    Module trả true nghĩa là đã xử lý xong, không xét module tiếp theo.
    for (const m of activeModules) {
      try {
        if (m.onVideoPlay(videoEl, moduleContext)) return;
      } catch { /* ignore */ }
    }
  }

  // -------------------------------------------------- đọc response có kiểm soát
  // Chỉ đọc body khi: đúng API endpoint của platform + content-type phù hợp +
  // kích thước chấp nhận được (tránh clone/parse mọi response lớn).
  const MAX_SCAN_CHARS = 4 * 1024 * 1024;
  const SCANNABLE_TYPE_RE = /json|text|javascript/i;

  function apiModulesFor(url) {
    const matched = [];
    for (const m of activeModules) {
      let hit = false;
      try { hit = !!m.matchApi(url); } catch { hit = false; }
      if (hit) matched.push(m);
    }
    return matched;
  }

  function scanResponseBody(modules, response) {
    try {
      const contentType = (response.headers.get('content-type') || '').toLowerCase();
      if (contentType && !SCANNABLE_TYPE_RE.test(contentType)) return;

      const length = Number(response.headers.get('content-length') || 0);
      if (Number.isFinite(length) && length > MAX_SCAN_CHARS) return;

      response.clone().text().then((body) => {
        if (!body || body.length > MAX_SCAN_CHARS) return;
        for (const m of modules) {
          try { m.onResponse(body, moduleContext); } catch { /* ignore */ }
        }
      }).catch(() => { });
    } catch { /* ignore */ }
  }

  // ------------------------------------------------------------ hook fetch
  const nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = function (input) {
      let reqUrl = null;
      try {
        if (typeof input === 'string') reqUrl = input;
        else if (input && typeof input.url === 'string') reqUrl = input.url;
      } catch { /* ignore */ }

      if (reqUrl) report(reqUrl, 'fetch');

      const promise = nativeFetch.apply(this, arguments);

      try {
        if (reqUrl) {
          const matchedModules = apiModulesFor(reqUrl);
          if (matchedModules.length > 0) {
            promise.then((response) => scanResponseBody(matchedModules, response)).catch(() => { });
          }
        }
      } catch { /* ignore */ }

      return promise;
    };
  }

  // -------------------------------------------------------------- hook XHR
  const nativeOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      if (url) {
        const urlStr = String(url);
        report(urlStr, 'xhr');
        this.__vgMatchedModules = apiModulesFor(urlStr);
      }
    } catch { /* ignore */ }
    return nativeOpen.apply(this, arguments);
  };

  const nativeSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function () {
    const modules = this.__vgMatchedModules;
    if (Array.isArray(modules) && modules.length > 0) {
      this.addEventListener('load', function () {
        try {
          if (this.responseType === '' || this.responseType === 'text') {
            const body = this.responseText;
            if (body && body.length <= MAX_SCAN_CHARS) {
              for (const m of modules) {
                try { m.onResponse(body, moduleContext); } catch { /* ignore */ }
              }
            }
          }
        } catch { /* ignore */ }
      });
    }
    return nativeSend.apply(this, arguments);
  };

  // ------------------------------------------- hook gán src cho <video>
  const videoSrcDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
  if (videoSrcDesc && videoSrcDesc.set) {
    Object.defineProperty(HTMLMediaElement.prototype, 'src', {
      configurable: true,
      enumerable: videoSrcDesc.enumerable,
      get: videoSrcDesc.get,
      set(value) {
        report(String(value), 'media-src');
        return videoSrcDesc.set.call(this, value);
      },
    });
  }

  const nativeSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    try {
      if (typeof name === 'string' && name.toLowerCase() === 'src' && this.tagName === 'VIDEO') {
        report(String(value), 'video-src');
      }
    } catch { /* ignore */ }
    return nativeSetAttribute.apply(this, arguments);
  };

  // ------------------------------------------- hook play() của thẻ media
  const nativePlay = HTMLMediaElement.prototype.play;
  if (typeof nativePlay === 'function') {
    HTMLMediaElement.prototype.play = function () {
      try {
        if (this.tagName === 'VIDEO') {
          handleActiveVideoPlay(this);
        }
      } catch { /* ignore */ }
      return nativePlay.apply(this, arguments);
    };
  }

  // Lắng nghe yêu cầu giải mã video từ content.js
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.__videoGrabberAction !== 'resolveVideo') return;
    const { code, title, pageUrl } = e.data;

    let resolved = false;
    for (const m of activeModules) {
      let ok = false;
      try { ok = !!m.resolve(code, pageUrl, title, moduleContext); } catch { ok = false; }
      if (ok) {
        resolved = true;
        break;
      }
    }

    if (!resolved) {
      const activeVideo =
        lastActiveVideoEl ||
        document.querySelector('video:not([paused])') ||
        document.querySelector('video');
      if (activeVideo) {
        handleActiveVideoPlay(activeVideo);
      }
    }
  });

  // Khởi tạo các module của platform đang mở
  for (const m of activeModules) {
    try { m.init(moduleContext); } catch { /* ignore */ }
  }
})();
