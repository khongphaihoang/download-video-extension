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
      if (
        host === 'www.instagram.com' ||
        host === 'instagram.com' ||
        host.endsWith('.instagram.com')
      ) {
        return true;
      }
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
              ctx.recordPostVideo('ig', code, version.url, { rank: area + 1 });
            }
          }
          for (const key of ['video_url', 'playback_url']) {
            if (typeof record[key] === 'string') {
              ctx.recordPostVideo('ig', code, record[key], { rank: 1 });
            }
          }
        });
      }

      const code = igCodeFromUrl(location.href);
      if (code) {
        const entry = ctx.postMap.get(ctx.postKey('ig', code));
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

    handleActivePlay(href, ctx) {
      const igCode = igCodeFromUrl(href);
      if (igCode) {
        const entry = ctx.postMap.get(ctx.postKey('ig', igCode));
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
      const entry = ctx.postMap.get(ctx.postKey('ig', code));
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
