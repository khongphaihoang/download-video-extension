/**
 * src/social/fb/inject.js — Logic inject cho Facebook (chạy trong MAIN world).
 */

(() => {
  'use strict';

  window.__VG_INJECT_MODULES__ = window.__VG_INJECT_MODULES__ || {};

  const base = window.__VG_SOCIAL_BASE__;
  if (!base) {
    console.warn('[VG:fb] Thiếu src/social/base.js — kiểm tra manifest.json');
    return;
  }

  const FB_KEYS = [
    'browser_native_hd_url',
    'browser_native_sd_url',
    'playable_url_quality_hd',
    'playable_url',
    'hd_src',
    'sd_src',
    'progressive_url',
  ];

  // Via (source) được coi là bằng chứng video của Facebook
  const FB_VIDEO_VIAS = [
    'fb-response',
    'fb-single-post',
    'fb-id-match',
    'shortcode-resolved',
    'react-fiber',
  ];

  // Sổ đăng ký post ID -> URL (trước đây là postMap trong core)
  const registry = base.createMediaRegistry('fb');

  const unescapeFbJson = base.unescapeJson;

  function isFacebookPage() {
    return /(^|\.)(facebook\.com|fb\.com)$/i.test(location.hostname);
  }

  function fbVideoIdFromUrl(raw) {
    try {
      const u = new URL(raw, location.href);
      if (!/(^|\.)(facebook\.com|fb\.com)$/i.test(u.hostname)) return null;
      const match = u.pathname.match(/\/(?:videos|reel)\/([0-9]+)(?:\/|$)/i);
      if (match) return match[1];
      if (/^\/watch\/?$/i.test(u.pathname)) {
        const id = u.searchParams.get('v');
        return id && /^[0-9]+$/.test(id) ? id : null;
      }
    } catch { /* ignore */ }
    return null;
  }

  /**
   * Chỉ quét response khi đúng endpoint GraphQL/AJAX của Facebook.
   * Trước đây mọi request tới *.facebook.com đều bị clone + đọc body.
   */
  function isFbApiRequest(url) {
    if (typeof url !== 'string') return false;
    try {
      const u = new URL(url, location.href);
      if (!/(^|\.)(facebook\.com|fb\.com)$/i.test(u.hostname)) return false;
      const path = u.pathname;
      return path.includes('/graphql') || path.includes('/ajax/') || path.includes('/api/');
    } catch { /* ignore */ }
    return false;
  }

  /** React Fiber là implementation detail của Facebook → nằm trong module này. */
  function extractFbFromFiber(videoEl) {
    return base.walkFiber(videoEl, (p) => {
      const fbHd = p.browser_native_hd_url || p.playable_url_quality_hd || p.hd_src;
      if (typeof fbHd === 'string' && /^https?:\/\//i.test(fbHd)) return { url: fbHd, quality: 'HD' };
      const fbSd = p.browser_native_sd_url || p.playable_url || p.sd_src;
      if (typeof fbSd === 'string' && /^https?:\/\//i.test(fbSd)) return { url: fbSd, quality: 'SD' };

      const item = p.item || p.media || p.post || p.videoData;
      if (item) {
        const ihd = item.browser_native_hd_url || item.playable_url_quality_hd || item.hd_src;
        if (typeof ihd === 'string' && /^https?:\/\//i.test(ihd)) return { url: ihd, quality: 'HD' };
        const isd = item.browser_native_sd_url || item.playable_url || item.sd_src;
        if (typeof isd === 'string' && /^https?:\/\//i.test(isd)) return { url: isd, quality: 'SD' };
      }
      return null;
    });
  }

  function recordFbPost(codeOrId, url, extra, log) {
    return registry.put(codeOrId, url, extra, log);
  }

  window.__VG_INJECT_MODULES__.fb = base.defineInjectedModule({
    name: 'fb',
    order: 30,

    matchPage: isFacebookPage,

    matchUrl(url, { host, via }) {
      const isFbCdn = /(^|\.)fbcdn\.net$/i.test(host);
      const isVideo = isFbCdn && FB_VIDEO_VIAS.includes(via);

      let isStreamSegment = false;
      try {
        const u = new URL(url);
        isStreamSegment = isFbCdn && (via === 'fetch' || via === 'xhr')
          && (u.searchParams.has('bytestart') || u.searchParams.has('byteend'));
      } catch { /* ignore */ }

      if (!isVideo && !isStreamSegment) return null;
      return { isVideo, isStreamSegment };
    },

    matchApi: isFbApiRequest,

    onResponse(text, ctx) {
      if (!text || text.length < 80) return;
      if (
        !text.includes('browser_native') &&
        !text.includes('playable_url') &&
        !text.includes('hd_src') &&
        !text.includes('sd_src') &&
        !text.includes('progressive_url')
      ) {
        return;
      }

      base.eachResponseObject(text, (record) => {
        const id = record.video_id || record.id;
        if (typeof id !== 'string' || !/^[0-9]{10,25}$/.test(id)) return;
        for (const key of FB_KEYS) {
          if (typeof record[key] !== 'string') continue;
          const isHd = key.includes('hd');
          recordFbPost(id, record[key], { quality: isHd ? 'HD' : 'SD', rank: isHd ? 2 : 1 }, ctx.log);
        }
      });

      for (const key of FB_KEYS) {
        const re = new RegExp('"' + key + '"\\s*:\\s*"([^"]{20,4000})"', 'g');
        let m;
        while ((m = re.exec(text)) !== null) {
          const url = unescapeFbJson(m[1]);
          if (/^https?:\/\//i.test(url)) ctx.report(url, 'fb-response');
        }
      }

      const fbId = fbVideoIdFromUrl(location.href);
      if (fbId) {
        const entry = registry.get(fbId);
        if (entry) {
          ctx.report(entry.url, 'fb-single-post', { isCurrent: true, label: 'Đang phát' });
        }
      }
    },

    /**
     * Facebook tự quyết định video nào đang phát:
     *   1. React Fiber (props của player)
     *   2. postMap theo ID video trong link bài viết
     */
    onVideoPlay(videoEl, ctx) {
      const fromFiber = extractFbFromFiber(videoEl);
      if (fromFiber && fromFiber.url) {
        ctx.log.info('🎯 [ActivePlay] Trích xuất thành công từ React Fiber:', fromFiber.url.slice(0, 80));
        ctx.report(fromFiber.url, 'react-fiber', {
          isCurrent: true,
          label: 'Đang phát',
          title: fromFiber.title || null,
          code: fromFiber.code || null,
        });
        return true;
      }

      const href = base.findPostHref(videoEl);
      const fbId = fbVideoIdFromUrl(href);
      if (fbId) {
        const entry = registry.get(fbId);
        if (entry && entry.url) {
          ctx.log.info(`🎯 [ActivePlay] Khớp chính xác Facebook Video [${fbId}] từ postMap:`, entry.url.slice(0, 80));
          ctx.report(entry.url, 'fb-id-match', { isCurrent: true, label: 'Đang phát' });
          return true;
        }
      }
      return false;
    },

    resolve(code, pageUrl, title, ctx) {
      const isFb = pageUrl && fbVideoIdFromUrl(pageUrl) === code;
      if (!isFb && !/^[0-9]+$/.test(code)) return false;
      const entry = registry.get(code);
      if (entry) {
        ctx.log.info(`🎯 [resolveVideo] Khớp postMap cho Facebook code [${code}]:`, entry.url.slice(0, 80));
        ctx.report(entry.url, 'shortcode-resolved', {
          isCurrent: true,
          label: 'Đang phát',
          code,
          title: title || entry.title,
          pageUrl,
        });
        return true;
      }
      return false;
    },

    /**
     * Trên trang Facebook, chỉ request byte-range của media đang phát mới được
     * coi là "video hiện tại" (trước đây core hard-code điều này).
     */
    isCurrentRequest(url) {
      if (!isFacebookPage()) return null;
      return base.BYTE_RANGE_RE.test(url);
    },

    // Sổ đăng ký của riêng Facebook — core không còn giữ postMap nữa
    recordMedia(code, url, extra, log) {
      return recordFbPost(code, url, extra, log);
    },

    lookupMedia(code) {
      return registry.get(code);
    },

    // Tiện ích nội bộ (giữ lại để debug)
    fbVideoIdFromUrl,
    unescapeFbJson,
    registry,
  });
})();
