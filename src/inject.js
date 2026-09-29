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
    /(^|\.)(video[^.]*\.fbcdn\.net|fbcdn\.net|cdninstagram\.com|googlevideo\.com|video\.twimg\.com|vimeocdn\.com|tiktokcdn\.com|tiktokcdn-us\.com|akamaized\.net|cloudfront\.net|mux\.com|bunnycdn\.com|streamable\.com|dailymotion\.com|viddler\.com|jwplayer\.com|brightcove\.net|kaltura\.com)$/i;

  const BAD_EXT_RE = /\.(jpe?g|png|gif|webp|svg|css|js|mjs|woff2?|ttf|ico|map)(\?|#|$)/i;

  // Lấy các module social đã đăng ký
  const socialModules = window.__VG_INJECT_MODULES__ || {};

  // Lưu trữ ánh xạ post -> video URL
  const postMap = new Map();
  const postKey = (platform, codeOrId) => `${platform}:${codeOrId}`;

  function recordPostVideo(platform, codeOrId, url, extra) {
    if (!codeOrId || typeof url !== 'string') return;
    const cleanUrl = url.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\\//g, '/')
      .replace(/\\\\/g, '\\');
    if (!/^https?:\/\//i.test(cleanUrl)) return;
    const key = postKey(platform, codeOrId);
    const rank = (extra && extra.rank) || 0;
    const previous = postMap.get(key);
    if (previous && previous.rank > rank) return;
    postMap.set(key, {
      code: String(codeOrId),
      url: cleanUrl,
      rank,
      quality: (extra && extra.quality) || 'HD',
      title: (extra && extra.title) || null,
    });
    log.info(`🎯 [postMap] Đã lưu ánh xạ [${key}] ->`, cleanUrl.slice(0, 80));
  }

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

    try {
      const host = new URL(url).hostname;

      // Kiểm tra qua module Instagram
      const igCandidate = socialModules.ig && socialModules.ig.isCandidate(url, host, via);
      const isIgVideo = igCandidate && igCandidate.isVideo;

      // Kiểm tra qua module Facebook
      const fbCandidate = socialModules.fb && socialModules.fb.isCandidate(url, host, via);
      const isFbVideo = fbCandidate && fbCandidate.isVideo;
      const isFbStreamSegment = fbCandidate && fbCandidate.isStreamSegment;

      if (/^scontent/i.test(host) && !MEDIA_EXT_RE.test(url)
        && !isIgVideo && !isFbVideo && !isFbStreamSegment) return false;

      // googlevideo.com chỉ cho phép qua YouTube parser (via yt-*)
      if (/(^|\.)googlevideo\.com$/i.test(host)) return false;

      if (MEDIA_EXT_RE.test(url)) return true;
      return MEDIA_HOST_RE.test(host);
    } catch {
      return false;
    }
  }

  let lastActiveVideoTime = 0;
  let lastActiveVideoEl = null;

  function report(url, via, meta) {
    try {
      // YouTube live capture
      if (socialModules.ytb && typeof socialModules.ytb.onFetchRequest === 'function') {
        socialModules.ytb.onFetchRequest(url, { log });
      }

      if (!isCandidate(url, via)) return;

      if ((via === 'fetch' || via === 'xhr') && Date.now() - lastActiveVideoTime < 3500
        && (!/(^|\.)(facebook\.com|fb\.com)$/i.test(location.hostname)
          || /[?&](?:bytestart|byteend)=/i.test(url))) {
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
    postMap,
    postKey,
    recordPostVideo,
    eachResponseObject,
  };

  // Trích xuất video từ React Fiber
  function extractVideoFromElement(videoEl) {
    if (!videoEl) return null;
    const directSrc = videoEl.currentSrc || videoEl.src;
    if (directSrc && /^https?:\/\//i.test(directSrc) && !directSrc.startsWith('blob:')) {
      return { url: directSrc };
    }

    try {
      const keys = Object.keys(videoEl);
      const fiberKey = keys.find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
      if (!fiberKey || !videoEl[fiberKey]) return null;

      let fiber = videoEl[fiberKey];
      let depth = 0;
      while (fiber && depth < 35) {
        depth++;
        const p = fiber.memoizedProps;
        if (p) {
          // Thử trích xuất qua module Instagram
          if (socialModules.ig && typeof socialModules.ig.extractFiberProps === 'function') {
            const igRes = socialModules.ig.extractFiberProps(p);
            if (igRes && igRes.url) return igRes;
          }
          // Thử trích xuất qua module Facebook
          if (socialModules.fb && typeof socialModules.fb.extractFiberProps === 'function') {
            const fbRes = socialModules.fb.extractFiberProps(p);
            if (fbRes && fbRes.url) return fbRes;
          }
        }
        fiber = fiber.return;
      }
    } catch { /* ignore */ }
    return null;
  }

  function handleActiveVideoPlay(videoEl) {
    if (!videoEl) return;
    lastActiveVideoTime = Date.now();
    lastActiveVideoEl = videoEl;

    // 1. YouTube
    if (socialModules.ytb && typeof socialModules.ytb.handleActivePlay === 'function') {
      if (socialModules.ytb.handleActivePlay(location.href, moduleContext)) return;
    }

    // 2. React Fiber
    const fromFiber = extractVideoFromElement(videoEl);
    if (fromFiber && fromFiber.url) {
      log.info('🎯 [ActivePlay] Trích xuất thành công từ React Fiber:', fromFiber.url.slice(0, 80));
      report(fromFiber.url, 'react-fiber', {
        isCurrent: true,
        label: 'Đang phát',
        title: fromFiber.title || null,
        code: fromFiber.code || null,
      });
      return;
    }

    // 3. Tìm link bài viết từ DOM container hoặc URL
    const container =
      videoEl.closest('article, [role="dialog"], [data-pagelet], div[role="feed"] > div') ||
      videoEl.parentElement;
    const link = container
      ? container.querySelector('a[href*="/reel/"], a[href*="/reels/"], a[href*="/p/"], a[href*="/videos/"]')
      : null;
    const href = (link && link.href) || location.href;

    // 4. Instagram
    if (socialModules.ig && typeof socialModules.ig.handleActivePlay === 'function') {
      if (socialModules.ig.handleActivePlay(href, moduleContext)) return;
    }

    // 5. Facebook
    if (socialModules.fb && typeof socialModules.fb.handleActivePlay === 'function') {
      if (socialModules.fb.handleActivePlay(href, moduleContext)) return;
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
          const matchedModules = Object.values(socialModules).filter(
            (m) => typeof m.isApiRequest === 'function' && m.isApiRequest(reqUrl)
          );

          if (matchedModules.length > 0) {
            promise.then((response) => {
              try {
                const cloned = response.clone();
                cloned.text().then((body) => {
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
      this.__vgMatchedModules = Object.values(socialModules).filter(
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
          if (this.responseType === '' || this.responseType === 'text') {
            for (const m of modules) {
              if (typeof m.scanResponse === 'function') {
                try { m.scanResponse(this.responseText, moduleContext); }
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
    for (const m of Object.values(socialModules)) {
      if (typeof m.resolveVideo === 'function') {
        if (m.resolveVideo(code, pageUrl, title, moduleContext)) {
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

  // Khởi tạo các module
  for (const m of Object.values(socialModules)) {
    if (typeof m.init === 'function') {
      try { m.init(moduleContext); }
      catch { /* ignore */ }
    }
  }
})();
