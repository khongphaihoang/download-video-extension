/**
 * src/social/tiktok/content.js — Logic TikTok content script (chạy trong ISOLATED world).
 */

(() => {
  'use strict';

  window.__VG_CONTENT_MODULES__ = window.__VG_CONTENT_MODULES__ || {};

  const seenNodes = new WeakSet();

  function isTikTokPage() {
    return /(^|\.)tiktok\.com$/i.test(location.hostname);
  }

  function matchVideoCode(href) {
    if (!href) return null;
    const match = href.match(/\/(?:video|v|photo|share\/video)\/([0-9]{15,25})/i);
    return match ? match[1] : null;
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

  function extractUrlsFromObject(videoObj) {
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

    // 1. downloadAddr / download_addr
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

  function extractFromItemStruct(item, currentVideoId, addFn, bumpStat) {
    if (!item || typeof item !== 'object') return;
    const id = item.id || item.aweme_id || item.item_id || item.videoId;
    if (!id) return;

    const normalizedId = String(id);
    const title = item.desc || item.title || null;
    const videoObj = item.video || item;
    const urls = extractUrlsFromObject(videoObj);
    if (!urls.length) return;

    const isCurrent = !!(currentVideoId && normalizedId === String(currentVideoId));
    // Nếu đang ở trang video đơn lẻ, chỉ thêm video của trang hiện tại
    if (currentVideoId && !isCurrent) return;

    urls.sort((a, b) => b.rank - a.rank);
    const bestItem = urls[0];

    if (addFn(bestItem.url, 'tt-json', {
      label: isCurrent ? 'Đang phát' : 'TikTok Video',
      isCurrent,
      title,
      code: normalizedId,
      pageUrl: location.href,
    })) {
      if (bumpStat) bumpStat('dom');
    }
  }

  window.__VG_CONTENT_MODULES__.tiktok = {
    name: 'tiktok',

    isPage: isTikTokPage,
    matchPage: isTikTokPage,

    matchVideoCode,

    isCandidate(url, host, source, extra) {
      if (!isTikTokPage()) return false;

      // Loại bỏ API / telemetry
      if (/(^|\.)(mssdk|analytics|log|mon|webcast|snssdk)[^.]*\.tiktok\.com$/i.test(host)) return false;
      if (/\/(?:web\/(?:common|report|resource)|api\/|node-webapp\/|tiktok\/v1\/|community_notes\/|global-footer\/)/i.test(url)) return false;

      // Loại bỏ ảnh
      if (/(\/tos-[^/]+-avt|~tplv-tiktok-shrink|\/avatar\/|~tplv-photomode)/i.test(url)) return false;
      if (/\.(jpe?g|png|gif|webp|avif|heic|svg|ico|css|js|json)(\?|#|$)/i.test(url)) return false;

      const isDirectTtSource = [
        'tt-json', 'inject:tt-response', 'inject:tt-single-post', 'inject:tt-id-match',
        'inject:shortcode-resolved', 'inject:react-fiber', 'inject:media-src', 'inject:video-src'
      ].includes(source);

      if (isDirectTtSource) {
        return true;
      }

      const isTtHost = /(^|\.)(tiktokcdn\.com|tiktokcdn-us\.com|byteoversea\.com|ibytedtos\.com|(v[0-9]+[^.]*|webapp[^.]*)\.tiktok\.com)$/i.test(host);
      const hasVideoPath = /\/(?:video\/tos|tos-[a-z0-9-]+|video\/mime|play|mp4|aweme\/v1\/play)/i.test(url)
        || /mime_type=video_mp4/i.test(url)
        || /\.(mp4|m4v|webm|mov)(\?|#|$)/i.test(url);

      const isTtSource = source === 'video-tag' || source === 'source-tag' || source === 'video-play'
        || source === 'video-playing' || source === 'video-click' || source === 'reels-active'
        || source === 'inject:fetch' || source === 'inject:xhr';

      return isTtHost && hasVideoPath && isTtSource;
    },

    isRejected(url, FILE_RE) {
      if (/(^|\.)(mssdk|analytics|log|mon)[^.]*\.tiktok\.com/i.test(url)) {
        return { reject: true, reason: 'TikTok Telemetry/API' };
      }
      if (/\/(?:web\/(?:common|report|resource)|api\/|node-webapp\/|tiktok\/v1\/|community_notes\/|global-footer\/)/i.test(url)) {
        return { reject: true, reason: 'TikTok Internal API' };
      }
      if (/(\/tos-[^/]+-avt|~tplv-tiktok-shrink|\/avatar\/|~tplv-photomode)/i.test(url)) {
        return { reject: true, reason: 'Ảnh avatar/thumbnail TikTok' };
      }
      if (/\.(jpe?g|png|gif|webp|avif|heic|svg|ico)(\?|#|$)/i.test(url)) {
        return { reject: true, reason: 'Ảnh/Asset không phải video' };
      }
      return null;
    },

    scanScripts(s, addFn, bumpStat) {
      if (!isTikTokPage()) return;
      if (seenNodes.has(s)) return;
      seenNodes.add(s);

      const t = s.textContent;
      if (!t || t.length < 80) return;

      const currentVideoId = matchVideoCode(location.href);

      // 1. Quét các thẻ script đặc thù của TikTok
      const id = s.id || '';
      if (
        id === '__UNIVERSAL_DATA_FOR_REHYDRATION__' ||
        id === 'SIGI_STATE' ||
        id === '__NEXT_DATA__' ||
        s.type === 'application/json' ||
        t.includes('webapp.video-detail') ||
        t.includes('ItemModule') ||
        t.includes('itemStruct')
      ) {
        try {
          const parsed = JSON.parse(t.trim().replace(/^for\s*\(;;\);?\s*/, ''));
          const visited = new WeakSet();

          function walk(node) {
            if (!node || typeof node !== 'object' || visited.has(node)) return;
            visited.add(node);

            if (node.itemStruct) {
              extractFromItemStruct(node.itemStruct, currentVideoId, addFn, bumpStat);
            } else if (node.ItemModule && typeof node.ItemModule === 'object') {
              for (const item of Object.values(node.ItemModule)) {
                extractFromItemStruct(item, currentVideoId, addFn, bumpStat);
              }
            } else if (node.id && (node.video || node.playAddr || node.downloadAddr || node.bitrateInfo)) {
              extractFromItemStruct(node, currentVideoId, addFn, bumpStat);
            }

            if (Array.isArray(node)) {
              for (const item of node) walk(item);
            } else {
              for (const val of Object.values(node)) {
                if (val && typeof val === 'object') walk(val);
              }
            }
          }

          walk(parsed);
          return;
        } catch { /* ignore JSON parse error */ }
      }

      // 2. Quét regex trực tiếp nếu không parse được JSON
      if (t.includes('playAddr') || t.includes('downloadAddr') || t.includes('video/tos') || t.includes('tos-')) {
        const re = /"(?:playAddr|downloadAddr)"\s*:\s*"([^"]{20,4000})"/g;
        let m;
        while ((m = re.exec(t)) !== null) {
          const url = unescapeJson(m[1]);
          if (/^https?:\/\//i.test(url)) {
            if (addFn(url, 'tt-json', { label: 'TikTok Video' })) {
              if (bumpStat) bumpStat('dom');
            }
          }
        }
      }
    },
  };
})();
