/**
 * src/social/ig/inject.js — Logic inject cho Instagram (chạy trong MAIN world).
 */

(() => {
  'use strict';

  window.__VG_INJECT_MODULES__ = window.__VG_INJECT_MODULES__ || {};

  const postMap = new Map();
  const postKey = (code) => `ig:${code}`;

  function cleanMediaUrl(raw) {
    if (typeof raw !== 'string') return raw;
    try {
      const u = new URL(raw);
      if (u.searchParams.has('bytestart') || u.searchParams.has('byteend')) {
        u.searchParams.delete('bytestart');
        u.searchParams.delete('byteend');
        return u.toString();
      }
    } catch { /* ignore */ }
    return raw;
  }

  function recordPostVideo(code, url, extra) {
    if (!code || typeof url !== 'string') return;
    const cleanUrl = cleanMediaUrl(
      url
        .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
        .replace(/\\\//g, '/')
        .replace(/\\\\/g, '\\')
        .replace(/&amp;/g, '&')
    );
    if (!/^https?:\/\//i.test(cleanUrl)) return;
    if (/(\/v\/t51\.|\/t51\.2885|dst-jpg|dst-webp|\.jpe?g|\.png|\.webp)/i.test(cleanUrl)) return;

    const key = postKey(code);
    const rank = (extra && extra.rank) || 0;
    const previous = postMap.get(key);
    if (previous && previous.rank > rank) return;

    postMap.set(key, {
      code: String(code),
      url: cleanUrl,
      rank,
      title: (extra && extra.title) || (previous && previous.title) || null,
      author: (extra && extra.author) || (previous && previous.author) || null,
      poster: (extra && extra.poster) || (previous && previous.poster) || null,
      variants: (extra && extra.variants) || (previous && previous.variants) || [],
    });
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
        || /(?:graphql|video|media|query)/i.test(u.search);
    } catch { /* ignore */ }
    return false;
  }

  function extractCaption(record) {
    if (!record) return null;
    if (record.caption && typeof record.caption.text === 'string') return record.caption.text;
    if (record.edge_media_to_caption && Array.isArray(record.edge_media_to_caption.edges)) {
      const edge = record.edge_media_to_caption.edges[0];
      if (edge && edge.node && typeof edge.node.text === 'string') return edge.node.text;
    }
    if (typeof record.title === 'string' && record.title) return record.title;
    return null;
  }

  function extractPoster(record) {
    if (!record) return null;
    if (record.image_versions2 && Array.isArray(record.image_versions2.candidates)) {
      const cand = record.image_versions2.candidates[0];
      if (cand && typeof cand.url === 'string') return cand.url;
    }
    if (typeof record.display_url === 'string') return record.display_url;
    if (typeof record.thumbnail_src === 'string') return record.thumbnail_src;
    return null;
  }

  function extractAuthor(record) {
    if (!record) return null;
    if (record.user && typeof record.user.username === 'string') return record.user.username;
    if (record.owner && typeof record.owner.username === 'string') return record.owner.username;
    return null;
  }

  window.__VG_INJECT_MODULES__.ig = {
    name: 'ig',

    cleanMediaUrl,

    isCandidate(url, host, via) {
      const isIgPage = /(^|\.)instagram\.com$/i.test(location.hostname);
      const isIgCdn = /(^|\.)(fbcdn\.net|cdninstagram\.com)$/i.test(host);

      if (!isIgPage || !isIgCdn) {
        return { isVideo: false, isStreamSegment: false };
      }

      // Loại bỏ ảnh
      if (/(\/v\/t51\.|\/t51\.2885|dst-jpg|dst-webp|\.jpe?g|\.png|\.webp)/i.test(url)) {
        return { isVideo: false, isStreamSegment: false };
      }

      let isStreamSegment = false;
      try {
        const u = new URL(url);
        isStreamSegment = (via === 'fetch' || via === 'xhr')
          && (u.searchParams.has('bytestart') || u.searchParams.has('byteend'));
      } catch { /* ignore */ }

      const isRecognizedVideoPath = /\/(?:o1\/v\/t16|v\/t50\.|v\/t64\.|o1\/v\/t24|o1\/v\/t72)/i.test(url)
        || /\.(mp4|m4v)(\?|#|$)/i.test(url)
        || /mime_type=video_mp4/i.test(url);

      const isVideoSource = [
        'ig-response', 'ig-single-post', 'shortcode-match', 'shortcode-resolved',
        'react-fiber', 'ig-active-stream', 'media-src', 'video-src'
      ].includes(via);

      const isVideo = isVideoSource || isRecognizedVideoPath;

      return { isVideo, isStreamSegment };
    },

    isApiRequest(url) {
      return isIgApiRequest(url);
    },

    onRequest(url, ctx) {
      if (!/(^|\.)instagram\.com$/i.test(location.hostname) || typeof url !== 'string') return;
      if (/static[^.]*\.fbcdn\.net/i.test(url) || /\/rsrc\.php\//i.test(url)) return;

      try {
        const u = new URL(url, location.href);
        if (!/(^|\.)(cdninstagram\.com|fbcdn\.net)$/i.test(u.hostname)) return;

        const isStream = u.searchParams.has('bytestart') || u.searchParams.has('byteend');
        if (isStream) {
          u.searchParams.delete('bytestart');
          u.searchParams.delete('byteend');
          const cleanUrl = u.toString();

          const currentCode = igCodeFromUrl(location.href);
          const entry = currentCode ? postMap.get(postKey(currentCode)) : null;

          const reportFn = ctx && ctx.report;
          if (typeof reportFn === 'function') {
            reportFn(cleanUrl, 'ig-active-stream', {
              isCurrent: true,
              label: 'Đang phát',
              code: currentCode || (entry && entry.code) || null,
              title: (entry && entry.title) || null,
              poster: (entry && entry.poster) || null,
              author: (entry && entry.author) || null,
              pageUrl: location.href,
            });
          }
        }
      } catch { /* ignore */ }
    },

    onUrlChange(newUrl, ctx) {
      const code = igCodeFromUrl(newUrl);
      if (code) {
        const entry = postMap.get(postKey(code));
        if (entry && entry.url && typeof ctx.report === 'function') {
          ctx.log.info(`🎯 [onUrlChange] Khớp Instagram Reel [${code}] từ postMap:`, entry.url.slice(0, 80));
          ctx.report(entry.url, 'shortcode-match', {
            isCurrent: true,
            label: 'Đang phát',
            code,
            title: entry.title,
            poster: entry.poster,
            author: entry.author,
            pageUrl: newUrl,
          });
        }
      }
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
        !text.includes('/t64.') &&
        !text.includes('BaseURL') &&
        !text.includes('browser_native_')
      ) {
        return;
      }

      const currentCode = igCodeFromUrl(location.href);

      function handleMediaRecord(rec, parentCode) {
        if (!rec || typeof rec !== 'object') return;
        const code = rec.code || rec.shortcode || parentCode;
        if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{5,35}$/.test(code)) return;

        const title = extractCaption(rec);
        const poster = extractPoster(rec);
        const author = extractAuthor(rec);

        const versions = rec.video_versions || rec.videoVersions;
        let bestUrl = null;
        let bestRank = 0;
        const variants = [];

        if (Array.isArray(versions) && versions.length > 0) {
          for (const v of versions) {
            if (!v || typeof v.url !== 'string') continue;
            const clean = cleanMediaUrl(v.url);
            const w = Number(v.width) || 0;
            const h = Number(v.height) || 0;
            const rank = (w * h) || 1;
            const quality = h >= 1080 ? '1080p' : h >= 720 ? '720p' : h ? `${h}p` : 'HD';
            variants.push({ url: clean, quality, width: w, height: h });
            if (rank > bestRank) {
              bestRank = rank;
              bestUrl = clean;
            }
          }
        }

        for (const key of ['video_url', 'playback_url', 'browser_native_hd_url', 'browser_native_sd_url']) {
          if (typeof rec[key] === 'string') {
            const clean = cleanMediaUrl(rec[key]);
            if (!bestUrl) {
              bestUrl = clean;
              bestRank = 1;
            }
            variants.push({ url: clean, quality: key.includes('hd') ? 'HD' : 'SD' });
          }
        }

        if (bestUrl) {
          recordPostVideo(code, bestUrl, {
            rank: bestRank,
            title,
            poster,
            author,
            variants,
          });

          const isCurrent = currentCode && code === currentCode;
          if (typeof ctx.report === 'function') {
            if (isCurrent) {
              ctx.report(bestUrl, 'ig-single-post', {
                isCurrent: true,
                label: 'Đang phát',
                code,
                title,
                poster,
                author,
                pageUrl: location.href,
              });
            } else {
              ctx.report(bestUrl, 'ig-response', {
                isCurrent: false,
                label: 'Instagram Video',
                code,
                title,
                poster,
                author,
                pageUrl: `https://www.instagram.com/reel/${code}/`,
              });
            }
          }
        }
      }

      if (ctx.eachResponseObject) {
        ctx.eachResponseObject(text, (record) => {
          // 1. Bản ghi trực tiếp
          handleMediaRecord(record);

          // 2. record.media (e.g. clips items)
          if (record.media && typeof record.media === 'object') {
            handleMediaRecord(record.media);
          }

          // 3. record.xdt_shortcode_media
          if (record.xdt_shortcode_media && typeof record.xdt_shortcode_media === 'object') {
            handleMediaRecord(record.xdt_shortcode_media);
          }

          // 4. carousel_media
          if (Array.isArray(record.carousel_media)) {
            const parentCode = record.code || record.shortcode;
            for (const item of record.carousel_media) {
              handleMediaRecord(item, parentCode);
            }
          }
        });
      }

      if (currentCode) {
        const entry = postMap.get(postKey(currentCode));
        if (entry && typeof ctx.report === 'function') {
          ctx.report(entry.url, 'ig-single-post', {
            isCurrent: true,
            label: 'Đang phát',
            code: currentCode,
            title: entry.title,
            poster: entry.poster,
            author: entry.author,
            pageUrl: location.href,
          });
        }
      }
    },

    extractFiberProps(p) {
      if (!p) return null;
      const vv = p.video_versions || p.videoVersions;
      if (Array.isArray(vv) && vv.length > 0) {
        const sorted = vv
          .slice()
          .sort((a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0));
        if (sorted[0] && sorted[0].url) {
          return {
            url: sorted[0].url,
            quality: sorted[0].width ? `${sorted[0].width}p` : 'HD',
            code: p.code || p.shortcode || null,
            title: extractCaption(p),
          };
        }
      }

      const item = p.item || p.media || p.post || p.videoData || p.clip || p.playbackItem || p.video;
      if (item && typeof item === 'object') {
        const ivv = item.video_versions || item.videoVersions;
        if (Array.isArray(ivv) && ivv.length > 0) {
          const sorted = ivv
            .slice()
            .sort((a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0));
          if (sorted[0] && sorted[0].url) {
            return {
              url: sorted[0].url,
              code: item.code || item.shortcode || null,
              title: extractCaption(item),
            };
          }
        }
        for (const k of ['video_url', 'playback_url', 'browser_native_hd_url', 'browser_native_sd_url']) {
          if (typeof item[k] === 'string') {
            return {
              url: item[k],
              code: item.code || item.shortcode || null,
              title: extractCaption(item),
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
            pageUrl: (ctx && ctx.pageUrl) || location.href,
          });
          return true;
        }
      }

      const targetUrl = (ctx && ctx.pageUrl) || location.href;
      return this.handleActivePlay(targetUrl, ctx);
    },

    handleActivePlay(href, ctx) {
      const igCode = igCodeFromUrl(href);
      if (igCode) {
        const entry = postMap.get(postKey(igCode));
        if (entry && entry.url) {
          ctx.log.info(`🎯 [ActivePlay] Khớp chính xác Instagram Reel [${igCode}] từ postMap:`, entry.url.slice(0, 80));
          ctx.report(entry.url, 'shortcode-match', {
            isCurrent: true,
            label: 'Đang phát',
            code: igCode,
            title: entry.title,
            poster: entry.poster,
            author: entry.author,
            pageUrl: href,
          });
          return true;
        }
      }
      return false;
    },

    resolveVideo(code, pageUrl, title, ctx) {
      const targetCode = code || igCodeFromUrl(pageUrl);
      if (!targetCode || !/^[A-Za-z0-9_-]{5,35}$/.test(targetCode)) return false;

      const entry = postMap.get(postKey(targetCode));
      if (entry && entry.url) {
        ctx.log.info(`🎯 [resolveVideo] Khớp postMap cho Instagram code [${targetCode}]:`, entry.url.slice(0, 80));
        ctx.report(entry.url, 'shortcode-resolved', {
          isCurrent: true,
          label: 'Đang phát',
          code: targetCode,
          title: title || entry.title,
          poster: entry.poster,
          author: entry.author,
          pageUrl: pageUrl || location.href,
        });
        return true;
      }
      return false;
    },

    igCodeFromUrl,
  };
})();
