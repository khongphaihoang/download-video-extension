/**
 * src/inject.js — Bộ điều phối chạy trong MAIN world của trang.
 *
 * Nhiệm vụ:
 *   - Hook fetch, XHR, video src, video play trong MAIN world.
 *   - Điều phối các module social (fb, ig, ytb...) đăng ký trong window.__VG_INJECT_MODULES__.
 *   - Chuyển tiếp candidate URL sang content script qua window.postMessage.
 */

(() => {
  'use strict';

  if (window.__videoGrabberInjected) return;
  window.__videoGrabberInjected = true;

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

  const MEDIA_EXT_RE = /\.(mp4|m4v|m4s|webm|mkv|mov|avi|flv|m3u8|mpd|ts|f4v)(\?|#|$)/i;

  const MEDIA_HOST_RE =
    /(^|\.)(video[^.]*\.fbcdn\.net|scontent[^.]*\.fbcdn\.net|cdninstagram\.com|googlevideo\.com|video\.twimg\.com|vimeocdn\.com|tiktokcdn\.com|tiktokcdn-us\.com|byteoversea\.com|ibytedtos\.com|(v[0-9]+[^.]*|webapp[^.]*)\.tiktok\.com|akamaized\.net|cloudfront\.net|mux\.com|bunnycdn\.com|streamable\.com|dailymotion\.com|viddler\.com|jwplayer\.com|brightcove\.net|kaltura\.com)$/i;

  const BAD_EXT_RE = /\.(jpe?g|png|gif|webp|avif|heic|svg|css|js|mjs|woff2?|ttf|ico|map|json)(\?|#|$)/i;
  const MAX_SCAN_CHARS = 4 * 1024 * 1024;

  // Lấy các module social đã đăng ký
  const socialModules = window.__VG_INJECT_MODULES__ || {};
  const activeModules = Object.values(socialModules).filter((module) => {
    const matchPage = module.matchPage || module.isPage;
    return typeof matchPage !== 'function' || matchPage.call(module);
  });

  const statusWaiters = new Map();
  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || event.data.__videoGrabber !== true
      || event.data.via !== 'status-response') return;
    const resolve = statusWaiters.get(event.data.requestId);
    if (!resolve) return;
    statusWaiters.delete(event.data.requestId);
    resolve(event.data.status || null);
  });

  window.__VG__ = {
    status() {
      const requestId = `status-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      return new Promise((resolve) => {
        statusWaiters.set(requestId, resolve);
        window.postMessage({ __videoGrabber: true, via: 'status-request', requestId }, '*');
        setTimeout(() => {
          if (!statusWaiters.has(requestId)) return;
          statusWaiters.delete(requestId);
          resolve({ ok: false, error: 'content script không phản hồi' });
        }, 1200);
      }).then((status) => {
        console.log('[VideoGrabber] status', status);
        return status;
      });
    },
  };

  // Duyệt cây JSON an toàn
  function eachResponseObject(text, visit) {
    const payload = text.trim().replace(/^for\s*\(;;\);?\s*/, '');
    let roots;
    try {
      roots = [JSON.parse(payload)];
    } catch {
      roots = [];
      for (const line of payload.split(/\r?\n/)) {
        try { roots.push(JSON.parse(line.replace(/^for\s*\(;;\);?\s*/, ''))); }
        catch { /* ignore */ }
      }
    }
    const seen = new WeakSet();
    const stack = roots;
    while (stack.length) {
      const node = stack.pop();
      if (!node || typeof node !== 'object' || seen.has(node)) continue;
      seen.add(node);
      if (Array.isArray(node)) {
        for (const value of node) stack.push(value);
      } else {
        visit(node);
        for (const value of Object.values(node)) {
          if (value && typeof value === 'object') stack.push(value);
        }
      }
    }
  }

  function isCandidate(url, via) {
    if (typeof url !== 'string' || url.length < 12) return false;
    if (!/^https?:\/\//i.test(url)) return false;
    if (BAD_EXT_RE.test(url)) return false;
    if (/static[^.]*\.fbcdn\.net/i.test(url) || /\/btmanifest\//i.test(url) || /\/rsrc\.php\//i.test(url)) return false;

    try {
      const host = new URL(url).hostname;
      if (/static[^.]*\.fbcdn\.net/i.test(host)) return false;

      let acceptedByModule = false;
      for (const module of Object.values(socialModules)) {
        if (typeof module.isCandidate !== 'function') continue;
        const result = module.isCandidate(url, host, via);
        if (result && (result.allow === false || result.isStreamSegment)) return false;
        if (result === true || (result && (result.allow === true || result.isVideo))) acceptedByModule = true;
      }

      const hasMediaExt = MEDIA_EXT_RE.test(url);
      const isRecognizedPath = /\/(?:o1\/v\/|v\/t[0-9])/i.test(url)
        || /\/(?:video\/tos|video\/mime|play)/i.test(url)
        || /mime_type=video_mp4/i.test(url);

      if (!hasMediaExt && !acceptedByModule && !isRecognizedPath) return false;

      if (hasMediaExt) return true;
      return acceptedByModule || (MEDIA_HOST_RE.test(host) && isRecognizedPath);
    } catch {
      return false;
    }
  }

  let lastActiveVideoTime = 0;
  let lastActiveVideoEl = null;

  function report(url, via, meta) {
    try {
      for (const module of activeModules) {
        const onRequest = module.onRequest || module.onFetchRequest;
        if (typeof onRequest === 'function') onRequest.call(module, url, { log, report });
      }

      if (!isCandidate(url, via)) return;

      for (const module of activeModules) {
        if (typeof module.decorateCandidate === 'function') {
          meta = module.decorateCandidate(url, via, meta);
        }
      }

      let canMarkCurrent = true;
      for (const module of activeModules) {
        if (typeof module.isCurrentRequest === 'function'
          && !module.isCurrentRequest(url, via, lastActiveVideoTime)) canMarkCurrent = false;
      }
      if ((via === 'fetch' || via === 'xhr') && Date.now() - lastActiveVideoTime < 3500 && canMarkCurrent) {
        meta = meta || {};
        meta.isCurrent = true;
        meta.label = 'Đang phát';
      }

      log.info(`🎯 [${via}] Bắt được candidate URL:`, url.slice(0, 90));
      window.postMessage({ __videoGrabber: true, url: String(url), via, meta }, '*');
    } catch { /* ignore */ }
  }

  // Ngữ cảnh dùng chung cho các module
  const moduleContext = {
    log,
    report,
    eachResponseObject,
  };

  function handleActiveVideoPlay(videoEl) {
    if (!videoEl) return;
    lastActiveVideoTime = Date.now();
    lastActiveVideoEl = videoEl;

    const isSingleVideoUrl = /(?:\/reel\/|\/reels\/|\/watch|\/videos\/|\/video\/|\/v\/|\/photo\/)/i.test(location.pathname)
      || /[?&]v=[0-9]+/i.test(location.search);

    let href = location.href;
    if (!isSingleVideoUrl) {
      const container =
        videoEl.closest('article, [role="dialog"], [data-e2e="recommend-list-item-container"], div[role="feed"] > div') ||
        videoEl.parentElement;
      const link = container
        ? container.querySelector('a[href*="/reel/"], a[href*="/reels/"], a[href*="/p/"], a[href*="/videos/"], a[href*="/video/"]')
        : null;
      if (link && link.href) href = link.href;
    }

    const ctx = { ...moduleContext, videoEl, pageUrl: href };
    for (const module of activeModules) {
      if (typeof module.onVideoPlay === 'function' && module.onVideoPlay(videoEl, ctx)) return;
      if (typeof module.handleActivePlay === 'function' && module.handleActivePlay(href, ctx)) return;
    }
  }

  // ------------------------------------------------------------ hook fetch
  const nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = function (input, init) {
      try {
        let url = null;
        if (typeof input === 'string') url = input;
        else if (input && typeof input.url === 'string') url = input.url;
        if (url) report(url, 'fetch');
      } catch { /* ignore */ }

      const promise = nativeFetch.apply(this, arguments);

      try {
        let reqUrl = null;
        if (typeof input === 'string') reqUrl = input;
        else if (input && typeof input.url === 'string') reqUrl = input.url;

        if (reqUrl) {
          const matchedModules = activeModules.filter(
            (m) => typeof m.isApiRequest === 'function' && m.isApiRequest(reqUrl)
          );

          if (matchedModules.length > 0) {
            promise.then((response) => {
              try {
                const contentType = response.headers.get('content-type') || '';
                if (!/(?:json|javascript|text\/plain|text\/html)/i.test(contentType)) return;
                const cloned = response.clone();
                cloned.text().then((body) => {
                  if (body.length > MAX_SCAN_CHARS) return;
                  for (const m of matchedModules) {
                    if (typeof m.scanResponse === 'function') {
                      try { m.scanResponse(body, moduleContext); }
                      catch { /* ignore */ }
                    }
                  }
                }).catch(() => { });
              } catch { /* ignore */ }
            }).catch(() => { });
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
      if (url) report(String(url), 'xhr');
      const urlStr = String(url);
      this.__vgMatchedModules = activeModules.filter(
        (m) => typeof m.isApiRequest === 'function' && m.isApiRequest(urlStr)
      );
    } catch { /* ignore */ }
    return nativeOpen.apply(this, arguments);
  };

  const nativeSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function () {
    if (Array.isArray(this.__vgMatchedModules) && this.__vgMatchedModules.length > 0) {
      const modules = this.__vgMatchedModules;
      this.addEventListener('load', function () {
        try {
          let text = null;
          if (this.responseType === '' || this.responseType === 'text') {
            text = typeof this.responseText === 'string' ? this.responseText : null;
          } else if (this.responseType === 'json' && this.response && typeof this.response === 'object') {
            try { text = JSON.stringify(this.response); } catch { /* ignore */ }
          }
          if (text && text.length <= MAX_SCAN_CHARS) {
            for (const m of modules) {
              if (typeof m.scanResponse === 'function') {
                try { m.scanResponse(text, moduleContext); }
                catch { /* ignore */ }
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
      if (this.tagName === 'VIDEO') {
        try { handleActiveVideoPlay(this); }
        catch { /* ignore */ }
      }
      const result = nativePlay.apply(this, arguments);
      return result;
    };
  }

  // Lắng nghe yêu cầu giải mã video từ content.js
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.__videoGrabberAction !== 'resolveVideo') return;
    const { code, title, pageUrl } = e.data;

    let resolved = false;
    for (const m of activeModules) {
      const resolver = m.resolve || m.resolveVideo;
      if (typeof resolver === 'function') {
        if (resolver.call(m, code, pageUrl, title, { ...moduleContext, pageUrl })) {
          resolved = true;
          break;
        }
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

  // Lắng nghe thay đổi URL khi cuộn Reels / chuyển video SPA (pushState, replaceState, popstate)
  function onUrlChange() {
    setTimeout(() => {
      window.postMessage({ __videoGrabber: true, via: 'url-change', url: location.href }, '*');
      for (const m of activeModules) {
        if (typeof m.onUrlChange === 'function') {
          try { m.onUrlChange(location.href, moduleContext); }
          catch { /* ignore */ }
        }
      }
      const activeVideo =
        document.querySelector('video:not([paused])') ||
        lastActiveVideoEl ||
        document.querySelector('video');
      if (activeVideo) {
        handleActiveVideoPlay(activeVideo);
      }
    }, 120);
  }

  const origPushState = history.pushState;
  history.pushState = function () {
    const ret = origPushState.apply(this, arguments);
    try { onUrlChange(); } catch { /* ignore */ }
    return ret;
  };

  const origReplaceState = history.replaceState;
  history.replaceState = function () {
    const ret = origReplaceState.apply(this, arguments);
    try { onUrlChange(); } catch { /* ignore */ }
    return ret;
  };

  window.addEventListener('popstate', onUrlChange);

  // Khởi tạo các module
  for (const m of activeModules) {
    if (typeof m.init === 'function') {
      try { m.init(moduleContext); }
      catch { /* ignore */ }
    }
  }
})();
