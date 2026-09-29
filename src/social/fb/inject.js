/**
 * src/social/fb/inject.js — Logic inject cho Facebook (chạy trong MAIN world).
 */

(() => {
  'use strict';

  window.__VG_INJECT_MODULES__ = window.__VG_INJECT_MODULES__ || {};

  const FB_KEYS = [
    'browser_native_hd_url',
    'browser_native_sd_url',
    'playable_url_quality_hd',
    'playable_url',
    'hd_src',
    'sd_src',
    'progressive_url',
  ];

  function unescapeFbJson(s) {
    return s
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\\//g, '/')
      .replace(/\\\\/g, '\\');
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

  function isFbApiRequest(url) {
    if (typeof url !== 'string') return false;
    try {
      const u = new URL(url, location.href);
      const host = u.hostname;
      if (
        host === 'www.facebook.com' ||
        host === 'web.facebook.com' ||
        host === 'm.facebook.com' ||
        host.endsWith('.facebook.com') ||
        host.endsWith('.fb.com')
      ) {
        return true;
      }
    } catch { /* ignore */ }
    return false;
  }

  window.__VG_INJECT_MODULES__.fb = {
    name: 'fb',

    isCandidate(url, host, via) {
      const isFbPage = /(^|\.)(facebook\.com|fb\.com)$/i.test(location.hostname);
      const isFbCdn = /(^|\.)fbcdn\.net$/i.test(host);

      const isVideo = isFbPage && isFbCdn && [
        'fb-response', 'fb-single-post', 'fb-id-match', 'shortcode-resolved', 'react-fiber'
      ].includes(via);

      let isStreamSegment = false;
      try {
        const u = new URL(url);
        isStreamSegment = isFbPage && isFbCdn && (via === 'fetch' || via === 'xhr')
          && (u.searchParams.has('bytestart') || u.searchParams.has('byteend'));
      } catch { /* ignore */ }

      return { isVideo, isStreamSegment };
    },

    isApiRequest(url) {
      return isFbApiRequest(url);
    },

    scanResponse(text, ctx) {
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

      if (ctx.eachResponseObject) {
        ctx.eachResponseObject(text, (record) => {
          const id = record.video_id || record.id;
          if (typeof id !== 'string' || !/^[0-9]{10,25}$/.test(id)) return;
          for (const key of FB_KEYS) {
            if (typeof record[key] !== 'string') continue;
            const isHd = key.includes('hd');
            ctx.recordPostVideo('fb', id, record[key], {
              quality: isHd ? 'HD' : 'SD',
              rank: isHd ? 2 : 1,
            });
          }
        });
      }

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
        const entry = ctx.postMap.get(ctx.postKey('fb', fbId));
        if (entry) {
          ctx.report(entry.url, 'fb-single-post', { isCurrent: true, label: 'Đang phát' });
        }
      }
    },

    extractFiberProps(p) {
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
    },

    handleActivePlay(href, ctx) {
      const fbId = fbVideoIdFromUrl(href);
      if (fbId) {
        const entry = ctx.postMap.get(ctx.postKey('fb', fbId));
        if (entry && entry.url) {
          ctx.log.info(`🎯 [ActivePlay] Khớp chính xác Facebook Video [${fbId}] từ postMap:`, entry.url.slice(0, 80));
          ctx.report(entry.url, 'fb-id-match', { isCurrent: true, label: 'Đang phát' });
          return true;
        }
      }
      return false;
    },

    resolveVideo(code, pageUrl, title, ctx) {
      const isFb = pageUrl && fbVideoIdFromUrl(pageUrl) === code;
      if (!isFb && !/^[0-9]+$/.test(code)) return false;
      const entry = ctx.postMap.get(ctx.postKey('fb', code));
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

    fbVideoIdFromUrl,
    unescapeFbJson,
  };
})();
