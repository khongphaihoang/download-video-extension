/**
 * inject.js — chạy trong MAIN world của trang (cùng ngữ cảnh với JS của trang).
 *
 * VÌ SAO CẦN FILE NÀY:
 * Facebook (và hầu hết site lớn) phát video qua MSE. Player dùng chính fetch()/XHR
 * của nó để tải từng segment, nên `initiatorType` trong Resource Timing là
 * 'fetch'/'xmlhttprequest' — KHÔNG BAO GIỜ là 'video'. Chỉ hook được fetch/XHR
 * mới bắt được luồng thật.
 *
 * MAIN world KHÔNG có API chrome.* → chỉ gửi kết quả qua window.postMessage.
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

  // Expose global debug object in MAIN world (DevTools console)
  window.__VG_INJECT__ = {
    loadedAt: new Date().toISOString(),
    host: location.hostname,
    active: true,
  };

  // Thông báo cho content.js (ISOLATED world) biết inject.js đã chạy.
  // content.js không thể đọc window.__videoGrabberInjected vì khác world.
  window.postMessage({ __videoGrabber: true, url: '', via: '__ping' }, '*');

  const MEDIA_EXT_RE = /\.(mp4|m4v|m4s|webm|mkv|mov|avi|flv|m3u8|mpd|ts|f4v)(\?|#|$)/i;

  // CDN phát video phổ biến — nhận cả URL không có đuôi file.
  const MEDIA_HOST_RE =
    /(^|\.)(video[^.]*\.fbcdn\.net|fbcdn\.net|googlevideo\.com|video\.twimg\.com|vimeocdn\.com|tiktokcdn\.com|tiktokcdn-us\.com|akamaized\.net|cloudfront\.net|mux\.com|bunnycdn\.com|streamable\.com|dailymotion\.com|viddler\.com|jwplayer\.com|brightcove\.net|kaltura\.com)$/i;

  const BAD_EXT_RE = /\.(jpe?g|png|gif|webp|svg|css|js|mjs|woff2?|ttf|ico|map)(\?|#|$)/i;

  function isCandidate(url) {
    if (typeof url !== 'string' || url.length < 12) return false;
    if (!/^https?:\/\//i.test(url)) return false; // blob:/data: không dùng được
    if (BAD_EXT_RE.test(url)) return false;
    try {
      const host = new URL(url).hostname;
      // loại scontent = ảnh của Facebook
      if (/^scontent/i.test(host)) return false;
      // googlevideo.com chỉ được phép khi đến từ YouTube parser
      // (hàm report bình thường sẽ bị chặn, chỉ reportYt mới gửi via yt-*)
      if (/(^|\.)googlevideo\.com$/i.test(host)) return false;
      if (MEDIA_EXT_RE.test(url)) return true;
      return MEDIA_HOST_RE.test(host);
    } catch {
      return false;
    }
  }

  function report(url, via) {
    try {
      if (!isCandidate(url)) return;
      log.info(`🎯 [${via}] Bắt được candidate URL:`, url.slice(0, 90));
      window.postMessage({ __videoGrabber: true, url: String(url), via }, '*');
    } catch {
      /* ignore */
    }
  }

  // ---- YouTube: trích xuất format từ ytInitialPlayerResponse ----------------

  const YT_HOST_RE = /^(www\.|m\.)?youtube\.com$/i;

  function isYouTubePage() {
    try { return YT_HOST_RE.test(location.hostname); } catch { return false; }
  }

  /** Gửi URL YouTube kèm metadata — bypass bộ lọc googlevideo.com thông thường. */
  function reportYt(url, via, meta) {
    try {
      if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return;
      window.postMessage({ __videoGrabber: true, url: String(url), via, meta }, '*');
    } catch { /* ignore */ }
  }

  /** Trích xuất progressive + adaptive formats từ player response. */
  function extractYouTubeFormats(playerResponse) {
    if (!playerResponse || !playerResponse.streamingData) return;
    const sd = playerResponse.streamingData;
    const title = (playerResponse.videoDetails && playerResponse.videoDetails.title) || '';
    const videoId = (playerResponse.videoDetails && playerResponse.videoDetails.videoId) || '';

    // Progressive formats — video+audio kết hợp, TẢI TRỰC TIẾP ĐƯỢC
    const formats = sd.formats || [];
    log.info(`YouTube: phát hiện ${formats.length} progressive format (tải trực tiếp) & ${(sd.adaptiveFormats || []).length} adaptive format`);
    for (const fmt of formats) {
      if (!fmt.url) continue; // bỏ qua signatureCipher
      reportYt(fmt.url, 'yt-progressive', {
        label: 'YT ' + (fmt.qualityLabel || '?'),
        quality: fmt.qualityLabel || '',
        mimeType: fmt.mimeType || '',
        width: fmt.width || 0,
        height: fmt.height || 0,
        title: title,
        videoId: videoId,
      });
    }

    // Adaptive formats — video-only hoặc audio-only
    const adaptive = sd.adaptiveFormats || [];
    for (const fmt of adaptive) {
      if (!fmt.url) continue;
      const isAudio = fmt.mimeType && fmt.mimeType.startsWith('audio/');
      const lbl = isAudio
        ? 'YT Audio ' + (fmt.audioQuality || '').replace('AUDIO_QUALITY_', '').toLowerCase()
        : 'YT ' + (fmt.qualityLabel || '?') + ' (chỉ hình)';
      reportYt(fmt.url, 'yt-adaptive', {
        label: lbl,
        quality: fmt.qualityLabel || (isAudio ? 'audio' : ''),
        mimeType: fmt.mimeType || '',
        width: fmt.width || 0,
        height: fmt.height || 0,
        contentLength: fmt.contentLength || '',
        title: title,
        videoId: videoId,
        isAdaptive: true,
        isAudio: !!isAudio,
      });
    }
  }

  // Poll chờ ytInitialPlayerResponse được set (page load)
  if (isYouTubePage()) {
    let _ytAttempts = 0;
    const _ytPoll = setInterval(() => {
      if (window.ytInitialPlayerResponse) {
        clearInterval(_ytPoll);
        extractYouTubeFormats(window.ytInitialPlayerResponse);
      }
      if (++_ytAttempts > 60) clearInterval(_ytPoll); // tối đa 6 giây
    }, 100);
  }

  // ---- Facebook video URL keys — dùng để quét JSON response ---------------
  const FB_KEYS = [
    'browser_native_hd_url',
    'browser_native_sd_url',
    'playable_url_quality_hd',
    'playable_url',
    'hd_src',
    'sd_src',
    'progressive_url',
  ];

  /** Giải mã chuỗi escape trong JSON nhúng của Facebook (\u0025 -> %, \/ -> /). */
  function unescapeFbJson(s) {
    return s
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\\//g, '/')
      .replace(/\\\\/g, '\\');
  }

  /** Quét text tìm Facebook video URL dựa trên các key đã biết. */
  function scanFbResponse(text) {
    if (!text || text.length < 80) return;
    // Kiểm tra nhanh: response có chứa keyword liên quan không?
    if (
      !text.includes('browser_native') &&
      !text.includes('playable_url') &&
      !text.includes('hd_src') &&
      !text.includes('sd_src') &&
      !text.includes('progressive_url')
    ) {
      return;
    }
    for (const key of FB_KEYS) {
      const re = new RegExp('"' + key + '"\\s*:\\s*"([^"]{20,4000})"', 'g');
      let m;
      while ((m = re.exec(text)) !== null) {
        const url = unescapeFbJson(m[1]);
        if (/^https?:\/\//i.test(url)) {
          log.info(`🎯 [fb-response] Tìm thấy key "${key}":`, url.slice(0, 90));
          report(url, 'fb-response');
        }
      }
    }
  }

  /**
   * Kiểm tra URL có phải là request tới Facebook API không.
   * Chỉ quét response body cho các request này để tránh gây lag.
   */
  function isFbApiRequest(url) {
    if (typeof url !== 'string') return false;
    try {
      const u = new URL(url);
      const host = u.hostname;
      // Request tới Facebook domain
      if (
        host === 'www.facebook.com' ||
        host === 'web.facebook.com' ||
        host === 'm.facebook.com' ||
        host.endsWith('.facebook.com') ||
        host.endsWith('.fb.com')
      ) {
        return true;
      }
    } catch {
      /* ignore */
    }
    return false;
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
      } catch {
        /* ignore */
      }

      const promise = nativeFetch.apply(this, arguments);

      // Quét response body cho Facebook API requests hoặc YouTube player API
      try {
        let reqUrl = null;
        if (typeof input === 'string') reqUrl = input;
        else if (input && typeof input.url === 'string') reqUrl = input.url;

        const isFb = reqUrl && isFbApiRequest(reqUrl);
        // YouTube SPA navigation gọi endpoint này khi mở video mới
        const isYtPlayer = reqUrl && /\/youtubei\/v1\/player/i.test(reqUrl);

        if (isFb || isYtPlayer) {
          promise.then((response) => {
            try {
              const cloned = response.clone();
              cloned.text().then((body) => {
                try {
                  if (isFb) scanFbResponse(body);
                  if (isYtPlayer) {
                    try {
                      const json = JSON.parse(body);
                      extractYouTubeFormats(json);
                    } catch { /* JSON parse fail — bỏ qua */ }
                  }
                } catch { /* ignore */ }
              }).catch(() => {});
            } catch { /* ignore */ }
          }).catch(() => {});
        }
      } catch {
        /* ignore */
      }

      return promise;
    };
  }

  // -------------------------------------------------------------- hook XHR

  const nativeOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      if (url) report(String(url), 'xhr');
      // Đánh dấu XHR request tới Facebook API để quét response body sau
      if (url && isFbApiRequest(String(url))) {
        this.__vgFbApi = true;
      }
    } catch {
      /* ignore */
    }
    return nativeOpen.apply(this, arguments);
  };

  // Quét response body của XHR tới Facebook API
  const nativeSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function () {
    if (this.__vgFbApi) {
      this.addEventListener('load', function () {
        try {
          if (this.responseType === '' || this.responseType === 'text') {
            scanFbResponse(this.responseText);
          }
        } catch {
          /* ignore */
        }
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
    } catch {
      /* ignore */
    }
    return nativeSetAttribute.apply(this, arguments);
  };
})();
