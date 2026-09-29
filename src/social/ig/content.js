/**
 * src/social/ig/content.js — Logic Instagram content script (chạy trong ISOLATED world).
 */

(() => {
  'use strict';

  window.__VG_CONTENT_MODULES__ = window.__VG_CONTENT_MODULES__ || {};

  const IG_KEYS = [
    'video_url',
    'playback_url',
  ];

  const seenIgNodes = new WeakSet();

  function unescapeJson(s) {
    return s
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\\//g, '/')
      .replace(/\\\\/g, '\\');
  }

  function isInstagramPage() {
    return /(^|\.)instagram\.com$/i.test(location.hostname);
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
      !text.includes('BaseURL')
    ) {
      return;
    }

    // 1. Quét các key trực tiếp: video_url, playback_url
    for (const key of IG_KEYS) {
      const re = new RegExp('"' + key + '"\\s*:\\s*"([^"]{20,4000})"', 'g');
      let m;
      while ((m = re.exec(text)) !== null) {
        const url = unescapeJson(m[1]);
        if (/^https?:\/\//i.test(url) && addFn(url, 'ig-json', { label: key })) {
          if (bumpStat) bumpStat('ig-json');
        }
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
        const url = unescapeJson(um[1]);
        if (/^https?:\/\//i.test(url) && addFn(url, 'ig-json', { label: 'ig-version' })) {
          if (bumpStat) bumpStat('ig-json');
        }
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
        const url = unescapeJson(sm[1]);
        if (/^https?:\/\//i.test(url) && addFn(url, 'ig-json', { label: 'ig-resource' })) {
          if (bumpStat) bumpStat('ig-json');
        }
      }
    }

    // 4. Quét BaseURL trong video_dash_manifest
    const buRe = /<BaseURL>([^<]{20,4000})<\/BaseURL>/g;
    let bm;
    while ((bm = buRe.exec(text)) !== null) {
      const url = unescapeJson(bm[1]);
      if (/^https?:\/\//i.test(url) && addFn(url, 'ig-json', { label: 'ig-manifest' })) {
        if (bumpStat) bumpStat('ig-json');
      }
    }

    // 5. Quét regex trực tiếp format video Instagram (/t16/ hoặc /t50.)
    const igDirectRe = /https?:\\\/\\\/[a-zA-Z0-9.-]*(?:cdninstagram\.com|fbcdn\.net)\\\/(?:o1\\\/v\\\/t16|v\\\/t50\.)[^\s"'\\]+/g;
    let dm;
    while ((dm = igDirectRe.exec(text)) !== null) {
      const url = unescapeJson(dm[0]);
      if (/^https?:\/\//i.test(url) && addFn(url, 'ig-json', { label: 'Instagram Video' })) {
        if (bumpStat) bumpStat('ig-json');
      }
    }
  }

  window.__VG_CONTENT_MODULES__.ig = {
    name: 'ig',

    isPage: isInstagramPage,

    isCandidate(url, host, source, extra) {
      const isIgPage = isInstagramPage();
      const isIgHost = /(^|\.)(fbcdn\.net|cdninstagram\.com)$/i.test(host);
      const isIgSource = source === 'ig-json' || source === 'inject:ig-response'
        || source === 'inject:ig-single-post' || source === 'inject:shortcode-match'
        || source === 'inject:shortcode-resolved' || source === 'inject:react-fiber'
        || source === 'video-tag' || source === 'source-tag'
        || source === 'inject:media-src' || source === 'inject:video-src'
        || (source === 'network-media' && extra && extra.label === 'video')
        || /\/(?:o1\/v\/t16|v\/t50\.)/i.test(url);

      const isIg = (isIgPage && isIgHost && isIgSource) || host.includes('instagram')
        || url.includes('/o1/v/t16/') || (typeof source === 'string' && source.includes('ig'));

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
      if (
        !t.includes('video_versions') &&
        !t.includes('video_url') &&
        !t.includes('playback_url') &&
        !t.includes('video_resources')
      ) {
        return;
      }
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

    matchVideoCode(href) {
      if (!href) return null;
      const match = href.match(/\/(?:reel|reels|p)\/([A-Za-z0-9_-]+)/i);
      return match ? match[1] : null;
    },

    extractIgJson,
  };
})();
