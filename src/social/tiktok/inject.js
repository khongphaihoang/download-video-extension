/**
 * src/social/tiktok/inject.js — Logic inject cho TikTok (chạy trong MAIN world).
 */

(() => {
  'use strict';

  window.__VG_INJECT_MODULES__ = window.__VG_INJECT_MODULES__ || {};

  const postMap = new Map();
  const urlToPostMap = new Map();
  const postKey = (code) => `tt:${code}`;

  function isTikTokPage() {
    return /(^|\.)tiktok\.com$/i.test(location.hostname);
  }

  function ttVideoIdFromUrl(raw) {
    try {
      const u = new URL(raw, location.href);
      if (!/(^|\.)tiktok\.com$/i.test(u.hostname)) return null;
      const match = u.pathname.match(/\/(?:video|v|photo|share\/video)\/([0-9]{15,25})/i);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  function unescapeJson(s) {
    if (typeof s !== 'string') return '';
    return s
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\\//g, '/')
      .replace(/\\\\/g, '\\')
      .replace(/&amp;/g, '&')
      .trim();
  }

  function recordPostVideo(code, url, extra) {
    if (!code || typeof url !== 'string') return;
    const cleanUrl = unescapeJson(url);
    if (!/^https?:\/\//i.test(cleanUrl)) return;
    const key = postKey(code);
    const rank = (extra && extra.rank) || 0;
    const previous = postMap.get(key);
    if (!previous || previous.rank <= rank) {
      postMap.set(key, {
        code: String(code),
        url: cleanUrl,
        rank,
        title: (extra && extra.title) || (previous && previous.title) || null,
        author: (extra && extra.author) || (previous && previous.author) || null,
      });
    }
    urlToPostMap.set(cleanUrl, {
      code: String(code),
      title: (extra && extra.title) || null,
      author: (extra && extra.author) || null,
    });
  }

  function isTtApiRequest(url) {
    if (typeof url !== 'string') return false;
    try {
      const u = new URL(url, location.href);
      const host = u.hostname;
      if (!/(^|\.)tiktok\.com$/i.test(host)) return false;
      return /\/(?:api|feed|aweme|item|recommend|post|related)\//i.test(u.pathname)
        || /(?:item_list|detail|video_detail)/i.test(u.search);
    } catch { /* ignore */ }
    return false;
  }

  function extractUrlsFromVideoObject(videoObj) {
    const urls = [];
    if (!videoObj || typeof videoObj !== 'object') return urls;

    function addUrl(u, rank, label) {
      if (typeof u === 'string') {
        const clean = unescapeJson(u);
        if (/^https?:\/\//i.test(clean) && !/\.(jpe?g|png|gif|webp|avif|heic|svg|ico|css|js|json)(\?|#|$)/i.test(clean)) {
          urls.push({ url: clean, rank, label });
        }
      }
    }

    function addFromTarget(target, rank, label) {
      if (!target) return;
      if (typeof target === 'string') {
        addUrl(target, rank, label);
        return;
      }
      if (typeof target === 'object') {
        const list = target.url_list || target.urlList || target.UrlList || target.URLList || [];
        if (Array.isArray(list)) {
          for (const u of list) addUrl(u, rank, label);
        }
        if (typeof target.url === 'string') addUrl(target.url, rank, label);
        if (typeof target.main_url === 'string') addUrl(target.main_url, rank, label);
        if (typeof target.play_url === 'string') addUrl(target.play_url, rank, label);
      }
    }

    // 1. downloadAddr / download_addr (ưu tiên vì nét và ít watermark)
    addFromTarget(videoObj.downloadAddr, 4, 'download');
    addFromTarget(videoObj.download_addr, 4, 'download');

    // 2. playAddr / play_addr / playUrl / play_url
    addFromTarget(videoObj.playAddr, 2, 'play');
    addFromTarget(videoObj.play_addr, 2, 'play');
    addFromTarget(videoObj.playUrl, 2, 'play');
    addFromTarget(videoObj.play_url, 2, 'play');

    // 3. bitrateInfo / bitrate_info
    const bitrates = videoObj.bitrateInfo || videoObj.bitrate_info || videoObj.BitrateInfo;
    if (Array.isArray(bitrates)) {
      for (const b of bitrates) {
        if (!b) continue;
        const br = Number(b.Bitrate || b.bitrate || b.bit_rate) || 1000;
        const rank = 2 + (br / 1000000);
        const label = b.GearName || b.gear_name || 'bitrate';
        const target = b.PlayAddr || b.playAddr || b.play_addr;
        addFromTarget(target, rank, label);
      }
    }

    return urls;
  }

  function scanNodeForVideos(node, targetVideoId, ctx) {
    if (!node || typeof node !== 'object') return;
    const id = node.id || node.aweme_id || node.item_id || node.videoId;
    const normalizedId = id != null ? String(id) : null;
    const videoObj = node.video || (node.playAddr || node.downloadAddr || node.bitrateInfo || node.play_addr ? node : null);

    if (normalizedId && /^[0-9]{15,25}$/.test(normalizedId) && videoObj) {
      const desc = node.desc || node.title || null;
      const author = node.author?.uniqueId || node.author?.nickname || null;
      const urls = extractUrlsFromVideoObject(videoObj);
      if (urls.length > 0) {
        urls.sort((a, b) => b.rank - a.rank);
        const bestItem = urls[0];

        recordPostVideo(normalizedId, bestItem.url, {
          rank: bestItem.rank,
          title: desc,
          author,
        });

        const isMatchedPost = targetVideoId && normalizedId === String(targetVideoId);
        if (isMatchedPost) {
          ctx.report(bestItem.url, 'tt-single-post', {
            isCurrent: true,
            label: 'Đang phát',
            code: normalizedId,
            title: desc,
            pageUrl: location.href,
          });
        } else if (!targetVideoId) {
          ctx.report(bestItem.url, 'tt-response', {
            label: 'TikTok Video',
            code: normalizedId,
            title: desc,
          });
        }
      }
    }
  }

  function scanDataTree(root, targetVideoId, ctx) {
    if (!root || typeof root !== 'object') return;
    const visited = new WeakSet();
    const stack = [root];

    while (stack.length > 0) {
      const current = stack.pop();
      if (!current || typeof current !== 'object' || visited.has(current)) continue;
      visited.add(current);

      if (current.itemStruct) {
        scanNodeForVideos(current.itemStruct, targetVideoId, ctx);
      } else if (current.ItemModule && typeof current.ItemModule === 'object') {
        for (const item of Object.values(current.ItemModule)) {
          scanNodeForVideos(item, targetVideoId, ctx);
        }
      } else {
        scanNodeForVideos(current, targetVideoId, ctx);
      }

      if (Array.isArray(current)) {
        for (let i = 0; i < current.length; i++) {
          if (current[i] && typeof current[i] === 'object') stack.push(current[i]);
        }
      } else {
        for (const val of Object.values(current)) {
          if (val && typeof val === 'object') stack.push(val);
        }
      }
    }
  }

  function scanPageData(ctx) {
    if (!isTikTokPage()) return;
    const targetVideoId = ttVideoIdFromUrl(location.href);

    // 1. Quét biến toàn cục __UNIVERSAL_DATA_FOR_REHYDRATION__ và SIGI_STATE trong MAIN world
    try {
      if (typeof window.__UNIVERSAL_DATA_FOR_REHYDRATION__ === 'object' && window.__UNIVERSAL_DATA_FOR_REHYDRATION__) {
        scanDataTree(window.__UNIVERSAL_DATA_FOR_REHYDRATION__, targetVideoId, ctx);
      }
    } catch { /* ignore */ }

    try {
      if (typeof window.SIGI_STATE === 'object' && window.SIGI_STATE) {
        scanDataTree(window.SIGI_STATE, targetVideoId, ctx);
      }
    } catch { /* ignore */ }

    // 2. Quét thẻ script __UNIVERSAL_DATA_FOR_REHYDRATION__ hoặc SIGI_STATE trong DOM
    const scriptIds = ['__UNIVERSAL_DATA_FOR_REHYDRATION__', 'SIGI_STATE', '__NEXT_DATA__'];
    for (const sid of scriptIds) {
      const el = document.getElementById(sid);
      if (el && el.textContent && el.textContent.length > 60) {
        try {
          const parsed = JSON.parse(el.textContent.trim().replace(/^for\s*\(;;\);?\s*/, ''));
          scanDataTree(parsed, targetVideoId, ctx);
        } catch { /* ignore */ }
      }
    }

    // 3. Nếu tìm thấy targetVideoId trong postMap, báo cáo ngay
    if (targetVideoId) {
      const entry = postMap.get(postKey(targetVideoId));
      if (entry && entry.url) {
        ctx.log.info(`🎯 [scanPageData] Bắt trúng TikTok video hiện tại [${targetVideoId}]:`, entry.url.slice(0, 80));
        ctx.report(entry.url, 'tt-single-post', {
          isCurrent: true,
          label: 'Đang phát',
          code: targetVideoId,
          title: entry.title,
          pageUrl: location.href,
        });
      }
    }
  }

  window.__VG_INJECT_MODULES__.tiktok = {
    name: 'tiktok',

    init(ctx) {
      if (!isTikTokPage()) return;
      scanPageData(ctx);
      setTimeout(() => scanPageData(ctx), 300);
      setTimeout(() => scanPageData(ctx), 1000);
      setTimeout(() => scanPageData(ctx), 2500);
    },

    isCandidate(url, host, via) {
      if (!url || typeof url !== 'string') return { isVideo: false };
      const isTtPage = isTikTokPage();
      if (!isTtPage) return { isVideo: false };

      // 1. Loại bỏ hoàn toàn các host API, telemetry, log, analytics
      if (/(^|\.)(mssdk|analytics|log|mon|webcast|snssdk)[^.]*\.tiktok\.com$/i.test(host)) {
        return { isVideo: false, allow: false };
      }

      // 2. Loại bỏ các path API/JSON/config của TikTok
      if (/\/(?:web\/(?:common|report|resource)|api\/|node-webapp\/|tiktok\/v1\/|community_notes\/|global-footer\/)/i.test(url)) {
        return { isVideo: false, allow: false };
      }

      // 3. Loại bỏ ảnh avatar, thumbnail, shrink, cover photomode, và các định dạng ảnh
      if (/(\/tos-[^/]+-avt|~tplv-tiktok-shrink|\/avatar\/|~tplv-photomode)/i.test(url)) {
        return { isVideo: false, allow: false };
      }
      if (/\.(jpe?g|png|gif|webp|avif|heic|svg|ico|css|js|json)(\?|#|$)/i.test(url)) {
        return { isVideo: false, allow: false };
      }

      // 4. Host CDN video của TikTok
      const isTtCdn = /(^|\.)(tiktokcdn\.com|tiktokcdn-us\.com|byteoversea\.com|ibytedtos\.com|(v[0-9]+[^.]*|webapp[^.]*)\.tiktok\.com)$/i.test(host);

      // 5. Nguồn trực tiếp từ TikTok post metadata hoặc React Fiber
      const isDirectTtSource = [
        'tt-response', 'tt-single-post', 'tt-id-match', 'shortcode-resolved',
        'react-fiber', 'media-src', 'video-src'
      ].includes(via);

      if (isDirectTtSource) {
        return { isVideo: true, allow: true };
      }

      // 6. Đặc trưng video của TikTok (bao gồm cả các bucket tos- / obj-)
      const hasVideoPath = /\/(?:video\/tos|tos-[a-z0-9-]+|video\/mime|play|mp4|aweme\/v1\/play)/i.test(url)
        || /mime_type=video_mp4/i.test(url)
        || /\.(mp4|m4v|webm|mov)(\?|#|$)/i.test(url);

      if (via === 'fetch' || via === 'xhr') {
        const isVideo = isTtCdn && hasVideoPath;
        return { isVideo, allow: isVideo };
      }

      const isVideo = (isTtCdn && hasVideoPath);
      return { isVideo, allow: isVideo };
    },

    decorateCandidate(url, via, meta) {
      if (!isTikTokPage()) return meta;
      meta = meta || {};
      const clean = unescapeJson(url);

      // 1. Kiểm tra reverse lookup từ urlToPostMap
      const mapped = urlToPostMap.get(clean) || urlToPostMap.get(url);
      if (mapped) {
        if (!meta.code) meta.code = mapped.code;
        if (!meta.title && mapped.title) meta.title = mapped.title;
        return meta;
      }

      // 2. Chỉ gán code của trang hiện tại nếu URL này chính xác là URL đã ghi nhận của video đó
      const currentCode = ttVideoIdFromUrl(location.href);
      if (currentCode) {
        const entry = postMap.get(postKey(currentCode));
        if (entry && (entry.url === clean || entry.url === url)) {
          if (!meta.code) meta.code = currentCode;
          if (entry.title && !meta.title) meta.title = entry.title;
        }
      }
      return meta;
    },

    isCurrentRequest(url, via, lastActiveVideoTime) {
      if (!isTikTokPage()) return false;
      const currentCode = ttVideoIdFromUrl(location.href);
      if (!currentCode) return true;
      const entry = postMap.get(postKey(currentCode));
      if (!entry || !entry.url) return false;
      const clean = unescapeJson(url);
      return entry.url === clean || entry.url === url;
    },

    isApiRequest(url) {
      return isTtApiRequest(url);
    },

    scanResponse(text, ctx) {
      if (!text || text.length < 80) return;
      if (
        !text.includes('playAddr') &&
        !text.includes('downloadAddr') &&
        !text.includes('play_addr') &&
        !text.includes('bitrateInfo') &&
        !text.includes('video/tos') &&
        !text.includes('itemStruct') &&
        !text.includes('aweme_id')
      ) {
        return;
      }

      const targetVideoId = ttVideoIdFromUrl(location.href);

      if (ctx.eachResponseObject) {
        ctx.eachResponseObject(text, (record) => {
          scanNodeForVideos(record, targetVideoId, ctx);
        });
      }

      if (targetVideoId) {
        const entry = postMap.get(postKey(targetVideoId));
        if (entry && entry.url) {
          ctx.report(entry.url, 'tt-single-post', {
            isCurrent: true,
            label: 'Đang phát',
            code: targetVideoId,
            title: entry.title,
            pageUrl: location.href,
          });
        }
      }
    },

    extractFiberProps(p) {
      if (!p || typeof p !== 'object') return null;

      const item = p.itemStruct || p.itemInfo?.itemStruct || p.item || p.aweme || p.videoData || p.post || p.videoInfo;
      if (item) {
        const id = item.id || item.aweme_id || item.videoId;
        const video = item.video || item;
        const urls = extractUrlsFromVideoObject(video);
        if (urls.length > 0) {
          urls.sort((a, b) => b.rank - a.rank);
          return {
            url: urls[0].url,
            code: id ? String(id) : null,
            title: item.desc || item.title || null,
          };
        }
      }

      if (p.video) {
        const urls = extractUrlsFromVideoObject(p.video);
        if (urls.length > 0) {
          urls.sort((a, b) => b.rank - a.rank);
          return {
            url: urls[0].url,
            code: p.id ? String(p.id) : null,
            title: p.desc || p.title || null,
          };
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
        const result = (fiber.memoizedProps && this.extractFiberProps(fiber.memoizedProps))
          || (fiber.memoizedState && this.extractFiberProps(fiber.memoizedState));
        if (result && result.url) {
          if (result.code) {
            recordPostVideo(result.code, result.url, { title: result.title });
          }
          ctx.report(result.url, 'react-fiber', {
            isCurrent: true,
            label: 'Đang phát',
            title: result.title || null,
            code: result.code || null,
            pageUrl: location.href,
          });
          return true;
        }
      }

      return this.handleActivePlay(location.href, ctx);
    },

    handleActivePlay(href, ctx) {
      const code = ttVideoIdFromUrl(href);
      if (code) {
        const entry = postMap.get(postKey(code));
        if (entry && entry.url) {
          ctx.log.info(`🎯 [ActivePlay] Khớp chính xác TikTok [${code}] từ postMap:`, entry.url.slice(0, 80));
          ctx.report(entry.url, 'tt-id-match', {
            isCurrent: true,
            label: 'Đang phát',
            code,
            title: entry.title,
            pageUrl: href,
          });
          return true;
        }
      }
      return false;
    },

    resolveVideo(code, pageUrl, title, ctx) {
      scanPageData(ctx);

      const codeFromUrl = pageUrl && ttVideoIdFromUrl(pageUrl);
      const targetCode = code || codeFromUrl;
      if (!targetCode) return false;

      const entry = postMap.get(postKey(targetCode));
      if (entry && entry.url) {
        ctx.log.info(`🎯 [resolveVideo] Khớp postMap cho TikTok code [${targetCode}]:`, entry.url.slice(0, 80));
        ctx.report(entry.url, 'shortcode-resolved', {
          isCurrent: true,
          label: 'Đang phát',
          code: targetCode,
          title: title || entry.title,
          pageUrl: pageUrl || location.href,
        });
        return true;
      }
      return false;
    },

    onUrlChange(href, ctx) {
      scanPageData(ctx);
    },

    ttVideoIdFromUrl,
  };
})();
