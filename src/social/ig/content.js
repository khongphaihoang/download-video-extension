/**
 * src/social/ig/content.js — Logic Instagram content script (chạy trong ISOLATED world).
 */

(() => {
  'use strict';

  window.__VG_CONTENT_MODULES__ = window.__VG_CONTENT_MODULES__ || {};

  const IG_KEYS = [
    'video_url',
    'playback_url',
    'browser_native_hd_url',
    'browser_native_sd_url',
  ];

  const seenIgNodes = new WeakSet();

  function unescapeJson(s) {
    if (typeof s !== 'string') return '';
    return s
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\\//g, '/')
      .replace(/\\\\/g, '\\')
      .replace(/&amp;/g, '&')
      .trim();
  }

  function isInstagramPage() {
    return /(^|\.)instagram\.com$/i.test(location.hostname);
  }

  function cleanMediaUrl(raw) {
    if (typeof raw !== 'string') return raw;
    try {
      const u = new URL(raw);
      if (u.searchParams.has('bytestart') || u.searchParams.has('byteend')) {
        if (/(^|\.)(cdninstagram\.com|fbcdn\.net)$/i.test(u.hostname) || isInstagramPage()) {
          u.searchParams.delete('bytestart');
          u.searchParams.delete('byteend');
          return u.toString();
        }
      }
    } catch { /* ignore */ }
    return raw;
  }

  function matchVideoCode(href) {
    if (!href) return null;
    const match = href.match(/instagram\.com\/(?:reel|reels|p)\/([A-Za-z0-9_-]+)/i)
      || href.match(/\/(?:reel|reels|p)\/([A-Za-z0-9_-]+)/i);
    return match ? match[1] : null;
  }

  function extractIgJson(text, addFn, bumpStat) {
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
      !text.includes('browser_native_') &&
      !text.includes('cdninstagram.com')
    ) {
      return;
    }

    const currentCode = matchVideoCode(location.href);
    const meta = {
      label: currentCode ? 'Đang phát' : 'Instagram Video',
      code: currentCode || null,
      isCurrent: !!currentCode,
      pageUrl: location.href,
      title: document.title || 'Instagram Video',
    };

    function recordFound(rawUrl, labelOverride) {
      const clean = cleanMediaUrl(unescapeJson(rawUrl));
      if (!/^https?:\/\//i.test(clean)) return;
      if (/(\/v\/t51\.|\/t51\.2885|dst-jpg|dst-webp|\.jpe?g|\.png|\.webp)/i.test(clean)) return;
      if (addFn(clean, 'ig-json', { ...meta, label: labelOverride || meta.label })) {
        if (bumpStat) bumpStat('ig-json');
      }
    }

    // 1. Quét các key trực tiếp: video_url, playback_url, browser_native_hd_url, browser_native_sd_url
    for (const key of IG_KEYS) {
      const re = new RegExp('"' + key + '"\\s*:\\s*"([^"]{20,4000})"', 'g');
      let m;
      while ((m = re.exec(text)) !== null) {
        recordFound(m[1], key);
      }
    }

    // 2. Quét block "video_versions": [...]
    const vvRe = /"video_versions"\s*:\s*\[([\s\S]*?)\]/g;
    let vm;
    while ((vm = vvRe.exec(text)) !== null) {
      const block = vm[1];
      const urlRe = /"url"\s*:\s*"([^"]{20,4000})"/g;
      let um;
      while ((um = urlRe.exec(block)) !== null) {
        recordFound(um[1], 'ig-version');
      }
    }

    // 3. Quét block "video_resources": [...]
    const vrRe = /"video_resources"\s*:\s*\[([\s\S]*?)\]/g;
    let rm;
    while ((rm = vrRe.exec(text)) !== null) {
      const block = rm[1];
      const srcRe = /"src"\s*:\s*"([^"]{20,4000})"/g;
      let sm;
      while ((sm = srcRe.exec(block)) !== null) {
        recordFound(sm[1], 'ig-resource');
      }
    }

    // 4. Quét BaseURL trong video_dash_manifest
    const buRe = /<BaseURL>([^<]{20,4000})<\/BaseURL>/g;
    let bm;
    while ((bm = buRe.exec(text)) !== null) {
      recordFound(bm[1], 'ig-manifest');
    }

    // 5. Quét regex trực tiếp format video Instagram (cả dạng URL escape \/ và //)
    const directRes = [
      /https?:\\\/\\\/[a-zA-Z0-9.-]*(?:cdninstagram\.com|fbcdn\.net)\\\/(?:o1\\\/v\\\/t16|v\\\/t50\.|v\\\/t64\.|o1\\\/v\\\/t24)[^\s"'\\]+/g,
      /https?:\/\/[a-zA-Z0-9.-]*(?:cdninstagram\.com|fbcdn\.net)\/(?:o1\/v\/t16|v\/t50\.|v\/t64\.|o1\/v\/t24)[^\s"'\\]+/g,
    ];
    for (const re of directRes) {
      let dm;
      while ((dm = re.exec(text)) !== null) {
        recordFound(dm[0], 'Instagram Video');
      }
    }
  }

  window.__VG_CONTENT_MODULES__.ig = {
    name: 'ig',

    isPage: isInstagramPage,
    matchPage: isInstagramPage,
    cleanMediaUrl,
    normalize: cleanMediaUrl,
    matchVideoCode,

    isCandidate(url, host, source, extra) {
      const isIgPage = isInstagramPage();
      const isIgHost = /(^|\.)(fbcdn\.net|cdninstagram\.com)$/i.test(host);

      // Loại bỏ ảnh
      if (/(\/v\/t51\.|\/t51\.2885|dst-jpg|dst-webp|\.jpe?g|\.png|\.webp)/i.test(url)) return false;

      const isIgSource = source === 'ig-json'
        || source === 'inject:ig-response'
        || source === 'inject:ig-single-post'
        || source === 'inject:shortcode-match'
        || source === 'inject:shortcode-resolved'
        || source === 'inject:react-fiber'
        || source === 'inject:ig-active-stream'
        || source === 'video-tag'
        || source === 'source-tag'
        || source === 'video-play'
        || source === 'video-playing'
        || source === 'video-click'
        || source === 'reels-active'
        || source === 'inject:media-src'
        || source === 'inject:video-src'
        || source === 'network-media'
        || (typeof source === 'string' && source.includes('ig'));

      const hasVideoPath = /\/(?:o1\/v\/t16|v\/t50\.|v\/t64\.|o1\/v\/t24|o1\/v\/t72)/i.test(url)
        || /\.(mp4|m4v)(\?|#|$)/i.test(url)
        || /mime_type=video_mp4/i.test(url);

      const isIg = (isIgPage && isIgHost && (isIgSource || hasVideoPath))
        || (isIgPage && hasVideoPath)
        || host.includes('cdninstagram.com')
        || (typeof source === 'string' && source.includes('ig'));

      return isIg;
    },

    isRejected(url, FILE_RE) {
      // Chặn ảnh Instagram giả dạng video: chứa /t51. (photos) hoặc query dst-jpg/dst-webp
      if (/(\/v\/t51\.|\/t51\.2885|dst-jpg|dst-webp)/i.test(url) && !FILE_RE.test(url)) {
        return { reject: true, reason: 'Ảnh Instagram (t51/dst-jpg, không phải video)' };
      }
      return null;
    },

    scanScripts(s, addFn, bumpStat) {
      if (seenIgNodes.has(s)) return;
      seenIgNodes.add(s);
      const t = s.textContent;
      if (!t || t.length < 80) return;
      extractIgJson(t, addFn, bumpStat);
    },

    scanDeep(root, addFn, bumpStat) {
      if (!root) return;
      document.querySelectorAll('script').forEach((s) => {
        this.scanScripts(s, addFn, bumpStat);
      });
      try {
        extractIgJson(root.innerHTML, addFn, bumpStat);
      } catch { /* ignore */ }
    },

    extractIgJson,
  };
})();
