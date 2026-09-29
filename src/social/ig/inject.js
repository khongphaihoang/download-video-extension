/**
 * src/social/ig/inject.js — Logic inject cho Instagram (chạy trong MAIN world).
 */

(() => {
  'use strict';

  window.__VG_INJECT_MODULES__ = window.__VG_INJECT_MODULES__ || {};

  const IG_KEYS = [
    'video_url',
    'playback_url',
  ];

  const postMap = new Map();
  const postKey = (code) => `ig:${code}`;

  function recordPostVideo(code, url, extra) {
    if (!code || typeof url !== 'string') return;
    const cleanUrl = url
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\\//g, '/')
      .replace(/\\\\/g, '\\');
    if (!/^https?:\/\//i.test(cleanUrl)) return;
    const key = postKey(code);
    const rank = (extra && extra.rank) || 0;
    const previous = postMap.get(key);
    if (previous && previous.rank > rank) return;
    postMap.set(key, { code: String(code), url: cleanUrl, rank, title: (extra && extra.title) || null });
  }

  function igCodeFromUrl(raw) {
    try {
      const u = new URL(raw, location.href);
      if (!/(^|\.)instagram\.com$/i.test(u.hostname)) return null;
      const match = u.pathname.match(/^\/(?:p|reel|reels)\/([A-Za-z0-9_-]+)(?:\/|$)/i);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  function isIgApiRequest(url) {
    if (typeof url !== 'string') return false;
    try {
      const u = new URL(url, location.href);
      const host = u.hostname;
      if (!/(^|\.)instagram\.com$/i.test(host)) return false;
      return /\/(?:graphql|api\/v1|api\/graphql|ajax)(?:\/|$)/i.test(u.pathname)
        || /(?:graphql|video|media)/i.test(u.search);
    } catch { /* ignore */ }
    return false;
  }

  window.__VG_INJECT_MODULES__.ig = {
    name: 'ig',

    isCandidate(url, host, via) {
      const isIgPage = /(^|\.)instagram\.com$/i.test(location.hostname);
      const isIgCdn = /(^|\.)(fbcdn\.net|cdninstagram\.com)$/i.test(host);

      const isVideo = isIgPage && isIgCdn && (
        ['ig-response', 'ig-single-post', 'shortcode-match', 'shortcode-resolved',
          'react-fiber', 'media-src', 'video-src'].includes(via)
        || /\/(?:o1\/v\/t16|v\/t50\.)/i.test(url)
      );

      return { isVideo };
    },

    isApiRequest(url) {
      return isIgApiRequest(url);
    },

    scanResponse(text, ctx) {
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

      if (ctx.eachResponseObject) {
        ctx.eachResponseObject(text, (record) => {
          const code = record.code || record.shortcode;
          if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{5,35}$/.test(code)) return;
          const versions = record.video_versions || record.videoVersions;
          if (Array.isArray(versions)) {
            for (const version of versions) {
              if (!version || typeof version.url !== 'string') continue;
              const area = (Number(version.width) || 0) * (Number(version.height) || 0);
              recordPostVideo(code, version.url, { rank: area + 1 });
            }
          }
          for (const key of ['video_url', 'playback_url']) {
            if (typeof record[key] === 'string') {
              recordPostVideo(code, record[key], { rank: 1 });
            }
          }
        });
      }

      const code = igCodeFromUrl(location.href);
      if (code) {
        const entry = postMap.get(postKey(code));
        if (entry) {
          ctx.report(entry.url, 'ig-single-post', { isCurrent: true, label: 'Đang phát' });
        }
      }
    },

    extractFiberProps(p) {
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
              title: item.caption?.text || item.title || null,
            };
          }
        }
      }
      return null;
    },

    onVideoPlay(videoEl, ctx) {
      if (!videoEl) return false;
      const keys = Object.keys(videoEl);
      const fiberKey = keys.find((key) => key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$'));
      let fiber = fiberKey && videoEl[fiberKey];
      for (let depth = 0; fiber && depth < 35; depth++, fiber = fiber.return) {
        const result = fiber.memoizedProps && this.extractFiberProps(fiber.memoizedProps);
        if (result && result.url) {
          ctx.report(result.url, 'react-fiber', {
            isCurrent: true,
            label: 'Đang phát',
            title: result.title || null,
            code: result.code || null,
          });
          return true;
        }
      }
      return this.handleActivePlay(location.href, ctx);
    },

    handleActivePlay(href, ctx) {
      const igCode = igCodeFromUrl(href);
      if (igCode) {
        const entry = postMap.get(postKey(igCode));
        if (entry && entry.url) {
          ctx.log.info(`🎯 [ActivePlay] Khớp chính xác Instagram Reel [${igCode}] từ postMap:`, entry.url.slice(0, 80));
          ctx.report(entry.url, 'shortcode-match', { isCurrent: true, label: 'Đang phát', code: igCode });
          return true;
        }
      }
      return false;
    },

    resolveVideo(code, pageUrl, title, ctx) {
      const isIg = pageUrl && igCodeFromUrl(pageUrl) === code;
      if (!isIg && !/^[A-Za-z0-9_-]{5,35}$/.test(code)) return false;
      const entry = postMap.get(postKey(code));
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

    igCodeFromUrl,
  };
})();
