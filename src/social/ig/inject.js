/**
 * src/social/ig/inject.js — Logic inject cho Instagram (chạy trong MAIN world).
 */

(() => {
  'use strict';

  window.__VG_INJECT_MODULES__ = window.__VG_INJECT_MODULES__ || {};

  const base = window.__VG_SOCIAL_BASE__;
  if (!base) {
    console.warn('[VG:ig] Thiếu src/social/base.js — kiểm tra manifest.json');
    return;
  }

  const IG_KEYS = [
    'video_url',
    'playback_url',
  ];

  // Sổ đăng ký shortcode -> URL (trước đây là postMap trong core)
  const registry = base.createMediaRegistry('ig');

  const unescapeIgJson = base.unescapeJson;

  // Threads là app của Meta: dùng chung CDN (cdninstagram.com / fbcdn.net) và
  // hạ tầng GraphQL với Instagram, khác ở host và dạng URL bài viết.
  const IG_PAGE_RE = /(^|\.)(instagram\.com|threads\.com|threads\.net)$/i;
  const THREADS_PAGE_RE = /(^|\.)(threads\.com|threads\.net)$/i;

  function isInstagramPage() {
    return IG_PAGE_RE.test(location.hostname);
  }

  function isThreadsPage() {
    return THREADS_PAGE_RE.test(location.hostname);
  }

  /**
   * Lấy code bài viết (shortcode). Threads dùng cùng định dạng code với Instagram:
   *   Instagram: /p/CODE, /reel/CODE, /reels/CODE
   *   Threads  : /@user/post/CODE, /t/CODE
   */
  function igCodeFromUrl(raw) {
    try {
      const u = new URL(raw, location.href);
      if (!IG_PAGE_RE.test(u.hostname)) return null;
      const match = u.pathname.match(/^\/(?:p|reel|reels)\/([A-Za-z0-9_-]+)(?:\/|$)/i)
        || u.pathname.match(/^\/@[^/]+\/post\/([A-Za-z0-9_-]+)(?:\/|$)/i)
        || u.pathname.match(/^\/t\/([A-Za-z0-9_-]+)(?:\/|$)/i);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  /**
   * Chỉ quét response khi đúng endpoint GraphQL/API của Instagram/Threads.
   * Trước đây mọi request tới *.instagram.com đều bị clone + đọc body.
   */
  function isIgApiRequest(url) {
    if (typeof url !== 'string') return false;
    try {
      const u = new URL(url, location.href);
      if (!IG_PAGE_RE.test(u.hostname)) return false;
      const path = u.pathname;
      return path.includes('/graphql') || path.includes('/api/v1/') || path.includes('/api/graphql');
    } catch { /* ignore */ }
    return false;
  }

  /** React Fiber là implementation detail của Instagram → nằm trong module này. */
  function extractIgFromFiber(videoEl) {
    return base.walkFiber(videoEl, (p) => {
      const vv = p.video_versions || p.videoVersions;
      if (Array.isArray(vv) && vv.length > 0) {
        const sorted = vv
          .slice()
          .sort((a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0));
        if (sorted[0] && sorted[0].url) {
          return { url: sorted[0].url, quality: sorted[0].width ? `${sorted[0].width}p` : 'HD' };
        }
      }

      const item = p.item || p.media || p.post || p.videoData;
      if (item) {
        const ivv = item.video_versions || item.videoVersions;
        if (Array.isArray(ivv) && ivv.length > 0) {
          const sorted = ivv
            .slice()
            .sort((a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0));
          if (sorted[0] && sorted[0].url) {
            return {
              url: sorted[0].url,
              code: item.code || item.shortcode || null,
              title: (item.caption && item.caption.text) || item.title || null,
            };
          }
        }
      }
      return null;
    });
  }

  function recordIgPost(code, url, extra, log) {
    return registry.put(code, url, extra, log);
  }

  window.__VG_INJECT_MODULES__.ig = base.defineInjectedModule({
    name: 'ig',
    order: 20,

    matchPage: isInstagramPage,

    matchUrl(url, { host, via }) {
      const isIgCdn = /(^|\.)(fbcdn\.net|cdninstagram\.com)$/i.test(host);
      const isVideo = isIgCdn && (
        ['ig-response', 'ig-single-post', 'shortcode-match', 'shortcode-resolved',
          'react-fiber', 'media-src', 'video-src'].includes(via)
        || /\/(?:o1\/v\/t16|v\/t50\.)/i.test(url)
      );

      if (!isVideo) return null;
      return { isVideo };
    },

    matchApi: isIgApiRequest,

    onResponse(text, ctx) {
      if (!text || text.length < 80) return;
      if (
        !text.includes('video_versions') &&
        !text.includes('video_url') &&
        !text.includes('playback_url') &&
        !text.includes('video_resources') &&
        !text.includes('/t16/') &&
        !text.includes('/t50.') &&
        !text.includes('BaseURL')
      ) {
        return;
      }

      base.eachResponseObject(text, (record) => {
        const code = record.code || record.shortcode;
        if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{5,35}$/.test(code)) return;
        const versions = record.video_versions || record.videoVersions;
        if (Array.isArray(versions)) {
          for (const version of versions) {
            if (!version || typeof version.url !== 'string') continue;
            const area = (Number(version.width) || 0) * (Number(version.height) || 0);
            recordIgPost(code, version.url, { rank: area + 1 }, ctx.log);
          }
        }
        for (const key of ['video_url', 'playback_url']) {
          if (typeof record[key] === 'string') {
            recordIgPost(code, record[key], { rank: 1 }, ctx.log);
          }
        }
      });

      const code = igCodeFromUrl(location.href);
      if (code) {
        const entry = registry.get(code);
        if (entry) {
          ctx.report(entry.url, 'ig-single-post', { isCurrent: true, label: 'Đang phát' });
        }
      }
    },

    /**
     * Instagram tự quyết định video nào đang phát:
     *   1. React Fiber (props của player)
     *   2. postMap theo shortcode trong link Reel/bài viết
     */
    onVideoPlay(videoEl, ctx) {
      const fromFiber = extractIgFromFiber(videoEl);
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
      const igCode = igCodeFromUrl(href);
      if (igCode) {
        const entry = registry.get(igCode);
        if (entry && entry.url) {
          ctx.log.info(`🎯 [ActivePlay] Khớp chính xác Instagram Reel [${igCode}] từ postMap:`, entry.url.slice(0, 80));
          ctx.report(entry.url, 'shortcode-match', { isCurrent: true, label: 'Đang phát', code: igCode });
          return true;
        }
      }
      return false;
    },

    resolve(code, pageUrl, title, ctx) {
      const isIg = pageUrl && igCodeFromUrl(pageUrl) === code;
      if (!isIg && !/^[A-Za-z0-9_-]{5,35}$/.test(code)) return false;
      const entry = registry.get(code);
      if (entry) {
        ctx.log.info(`🎯 [resolveVideo] Khớp postMap cho Instagram code [${code}]:`, entry.url.slice(0, 80));
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

    /** Instagram SPA: request tới CDN trong lúc phát được coi là video hiện tại. */
    isCurrentRequest() {
      if (!isInstagramPage()) return null;
      return true;
    },

    // Sổ đăng ký của riêng Instagram — core không còn giữ postMap nữa
    recordMedia(code, url, extra, log) {
      return recordIgPost(code, url, extra, log);
    },

    lookupMedia(code) {
      return registry.get(code);
    },

    // Tiện ích nội bộ (giữ lại để debug)
    igCodeFromUrl,
    unescapeIgJson,
    registry,
    isThreadsPage,
  });
})();
