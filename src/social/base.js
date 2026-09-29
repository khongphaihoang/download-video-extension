/**
 * src/social/base.js — Hạ tầng dùng chung cho core và các social module.
 *
 * Được nạp ĐẦU TIÊN trong cả hai world:
 *   MAIN world     : base.js → fb|ig|ytb/inject.js  → src/inject.js
 *   ISOLATED world : base.js → media/engine.js → fb|ig|ytb/content.js → src/content.js
 *
 * Mục tiêu: core (inject.js / content.js) chỉ gọi một interface chung, không cần
 * biết platform nào đang chạy. Mọi khác biệt nằm trong src/social/<platform>/.
 *
 * File này chỉ chứa helper thuần (regex, JSON, DOM, Fiber, registry) — không
 * chứa logic riêng của Facebook / Instagram / YouTube.
 */

(() => {
  'use strict';

  // Chống nạp trùng (idempotent): nếu entry đã chạy thì bỏ qua.
  if (window.__VG_SOCIAL_BASE__) return;

  // ------------------------------------------------------------ regex dùng chung
  const MEDIA_HOST_RE =
    /(^|\.)(video[^.]*\.fbcdn\.net|fbcdn\.net|cdninstagram\.com|googlevideo\.com|video\.twimg\.com|vimeocdn\.com|tiktokcdn\.com|tiktokcdn-us\.com|akamaized\.net|cloudfront\.net|mux\.com|bunnycdn\.com|streamable\.com|dailymotion\.com|viddler\.com|jwplayer\.com|brightcove\.net|kaltura\.com)$/i;

  /** Có đuôi media (kể cả manifest/segment). */
  const MEDIA_EXT_RE = /\.(mp4|m4v|m4s|webm|mkv|mov|avi|flv|m3u8|mpd|ts|f4v)(\?|#|$)/i;
  /** Chỉ file video hoàn chỉnh. */
  const FILE_EXT_RE = /\.(mp4|m4v|webm|mkv|mov|avi|flv|f4v)(\?|#|$)/i;
  /** Tài nguyên không bao giờ là video (dùng phía MAIN world). */
  const BAD_ASSET_RE = /\.(jpe?g|png|gif|webp|svg|css|js|mjs|woff2?|ttf|ico|map)(\?|#|$)/i;
  /**
   * Tài nguyên không bao giờ là video, bản đầy đủ cho ISOLATED world.
   * KHÔNG liệt kê m3u8/mpd/ts/m4s ở đây — manifest/segment là việc của
   * Media Engine (src/media/engine.js), nhờ vậy log có lý do rõ ràng:
   * "Là 'hls' (HLS chưa hỗ trợ)" thay vì "trùng regex tài nguyên".
   */
  const BAD_MEDIA_RE = /\.(jpe?g|png|gif|webp|svg|css|js|mjs|woff2?|ttf|ico|json|map)(\?|#|$)/i;
  /** Tham số byte-range của CDN (Facebook dùng để phát từng đoạn). */
  const BYTE_RANGE_RE = /[?&](?:bytestart|byteend)=/i;

  // ------------------------------------------------------------- helper URL/JSON
  function hostOf(url) {
    try {
      return new URL(url).hostname;
    } catch {
      return '';
    }
  }

  /** Giải mã các chuỗi URL bị escape trong JSON nhúng của FB/IG. */
  function unescapeJson(s) {
    return String(s)
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\\//g, '/')
      .replace(/\\\\/g, '\\');
  }

  /** Chuẩn hoá URL thô trước khi lưu (bỏ &amp;, khoảng trắng, #fragment). */
  function normalizeUrl(raw) {
    if (typeof raw !== 'string' || !raw) return null;
    const s = raw.replace(/&amp;/g, '&').replace(/^\s+|\s+$/g, '');
    if (!/^https?:\/\//i.test(s)) return null;
    return s.split('#')[0];
  }

  /**
   * Duyệt cây JSON/JSONL an toàn (dùng cho response GraphQL của FB/IG).
   * Chấp nhận cả prefix "for (;;);" của Facebook.
   */
  function eachResponseObject(text, visit) {
    const payload = String(text).trim().replace(/^for\s*\(;;\);?\s*/, '');
    let roots;
    try {
      roots = [JSON.parse(payload)];
    } catch {
      roots = [];
      for (const line of payload.split(/\r?\n/)) {
        try {
          roots.push(JSON.parse(line.replace(/^for\s*\(;;\);?\s*/, '')));
        } catch { /* ignore */ }
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

  // ---------------------------------------------------------------- helper DOM
  /** URL http(s) thật của thẻ <video> (trả null nếu là blob:/rỗng). */
  function directMediaSrc(videoEl) {
    if (!videoEl) return null;
    const src = videoEl.currentSrc || videoEl.src;
    if (src && /^https?:\/\//i.test(src) && !src.startsWith('blob:')) return src;
    return null;
  }

  /** Tìm link bài viết/reel gần thẻ video (dùng chung cho mọi platform dạng feed). */
  function findPostHref(videoEl) {
    const container = videoEl.closest('article, [role="dialog"], [data-pagelet], div[role="feed"] > div')
      || videoEl.parentElement;
    const link = container
      ? container.querySelector('a[href*="/reel/"], a[href*="/reels/"], a[href*="/p/"], a[href*="/videos/"]')
      : null;
    return (link && link.href) || location.href;
  }

  /**
   * Duyệt React Fiber từ một element và gọi `extract(props)` ở từng tầng.
   * Việc đọc props là implementation detail của từng platform (FB/IG).
   */
  function walkFiber(element, extract) {
    try {
      const keys = Object.keys(element);
      const fiberKey = keys.find(
        (k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')
      );
      if (!fiberKey || !element[fiberKey]) return null;

      let fiber = element[fiberKey];
      let depth = 0;
      while (fiber && depth < 35) {
        depth++;
        const props = fiber.memoizedProps;
        if (props) {
          const res = extract(props);
          if (res && res.url) return res;
        }
        fiber = fiber.return;
      }
    } catch { /* ignore */ }
    return null;
  }

  // ------------------------------------------------------- registry code -> URL
  /**
   * Sổ đăng ký riêng của từng platform: post ID / shortcode / video ID → URL.
   * Core không biết gì về nội dung của các key này.
   */
  function createMediaRegistry(platform) {
    const map = new Map();

    return {
      platform,

      key(code) {
        return `${platform}:${code}`;
      },

      /** Lưu URL tốt nhất cho một code. rank cao hơn thì ghi đè. */
      put(code, url, extra, log) {
        if (!code || typeof url !== 'string') return false;
        const cleanUrl = unescapeJson(url);
        if (!/^https?:\/\//i.test(cleanUrl)) return false;

        const id = String(code);
        const rank = (extra && Number(extra.rank)) || 0;
        const previous = map.get(id);
        if (previous && previous.rank > rank) return false;

        map.set(id, {
          platform,
          code: id,
          url: cleanUrl,
          rank,
          quality: (extra && extra.quality) || 'HD',
          title: (extra && extra.title) || null,
        });
        if (log) log.info(`🎯 [postMap] Đã lưu ánh xạ [${platform}:${id}] ->`, cleanUrl.slice(0, 80));
        return true;
      },

      get(code) {
        return map.get(String(code));
      },

      values() {
        return [...map.values()];
      },
    };
  }

  // ------------------------------------------------------- interface mặc định
  const noop = () => { };

  /** Gắn default no-op cho social module phía MAIN world. */
  function defineInjectedModule(spec) {
    return Object.assign(
      {
        order: 50,
        matchPage: () => false,
        matchUrl: () => null,
        matchApi: () => false,
        onRequest: noop,
        onResponse: noop,
        onVideoPlay: () => false,
        resolve: () => false,
        isCurrentRequest: () => null,
        init: noop,
      },
      spec
    );
  }

  /** Gắn default no-op cho social module phía ISOLATED world. */
  function defineContentModule(spec) {
    return Object.assign(
      {
        order: 50,
        matchPage: () => false,
        matchUrl: () => null,
        normalize: null,
        onCandidate: null,
        decorateCandidate: null,
        extractPostCode: null,
        scanScripts: null,
        scanRoot: null,
      },
      spec
    );
  }

  window.__VG_SOCIAL_BASE__ = {
    // regex
    MEDIA_HOST_RE,
    MEDIA_EXT_RE,
    FILE_EXT_RE,
    BAD_ASSET_RE,
    BAD_MEDIA_RE,
    BYTE_RANGE_RE,

    // helper
    hostOf,
    unescapeJson,
    normalizeUrl,
    eachResponseObject,
    directMediaSrc,
    findPostHref,
    walkFiber,

    // registry + interface
    createMediaRegistry,
    defineInjectedModule,
    defineContentModule,
  };
})();
