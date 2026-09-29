/**
 * src/social/ig/content.js — Logic Instagram content script (chạy trong ISOLATED world).
 */

(() => {
  'use strict';

  window.__VG_CONTENT_MODULES__ = window.__VG_CONTENT_MODULES__ || {};

  const base = window.__VG_SOCIAL_BASE__;
  if (!base) {
    console.warn('[VG:ig] Thiếu src/social/base.js — kiểm tra manifest.json');
    return;
  }

  const IG_KEYS = [
    'video_url',
    'playback_url',
  ];

  const seenIgNodes = new WeakSet();

  const unescapeJson = base.unescapeJson;

  // Threads (Meta) dùng chung CDN với Instagram → cùng module
  const IG_PAGE_RE = /(^|\.)(instagram\.com|threads\.com|threads\.net)$/i;
  const THREADS_PAGE_RE = /(^|\.)(threads\.com|threads\.net)$/i;

  function isInstagramPage() {
    return IG_PAGE_RE.test(location.hostname);
  }

  function isThreadsPage() {
    return THREADS_PAGE_RE.test(location.hostname);
  }

  function extractIgJson(text, ctx) {
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
        if (/^https?:\/\//i.test(url) && ctx.add(url, 'ig-json', { label: key })) {
          ctx.bumpStat('ig-json');
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
        if (/^https?:\/\//i.test(url) && ctx.add(url, 'ig-json', { label: 'ig-version' })) {
          ctx.bumpStat('ig-json');
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
        if (/^https?:\/\//i.test(url) && ctx.add(url, 'ig-json', { label: 'ig-resource' })) {
          ctx.bumpStat('ig-json');
        }
      }
    }

    // 4. Quét BaseURL trong video_dash_manifest
    const buRe = /<BaseURL>([^<]{20,4000})<\/BaseURL>/g;
    let bm;
    while ((bm = buRe.exec(text)) !== null) {
      const url = unescapeJson(bm[1]);
      if (/^https?:\/\//i.test(url) && ctx.add(url, 'ig-json', { label: 'ig-manifest' })) {
        ctx.bumpStat('ig-json');
      }
    }

    // 5. Quét regex trực tiếp format video Instagram (/t16/ hoặc /t50.)
    const igDirectRe = /https?:\\\/\\\/[a-zA-Z0-9.-]*(?:cdninstagram\.com|fbcdn\.net)\\\/(?:o1\\\/v\\\/t16|v\\\/t50\.)[^\s"'\\]+/g;
    let dm;
    while ((dm = igDirectRe.exec(text)) !== null) {
      const url = unescapeJson(dm[0]);
      if (/^https?:\/\//i.test(url) && ctx.add(url, 'ig-json', { label: 'Instagram Video' })) {
        ctx.bumpStat('ig-json');
      }
    }
  }

  function scanIgScripts(script, ctx) {
    if (seenIgNodes.has(script)) return;
    seenIgNodes.add(script);
    const t = script.textContent;
    if (!t || t.length < 80) return;
    if (
      !t.includes('video_versions') &&
      !t.includes('video_url') &&
      !t.includes('playback_url') &&
      !t.includes('video_resources')
    ) {
      return;
    }
    extractIgJson(t, ctx);
  }

  window.__VG_CONTENT_MODULES__.ig = base.defineContentModule({
    name: 'ig',
    order: 20,

    matchPage: isInstagramPage,

    matchUrl(url, { host, source, extra }) {
      // Chặn ảnh Instagram giả dạng video: /t51. (photos) hoặc dst-jpg/dst-webp
      if (/(\/v\/t51\.|\/t51\.2885|dst-jpg|dst-webp)/i.test(url) && !base.FILE_EXT_RE.test(url)) {
        return { reject: 'Ảnh Instagram (t51/dst-jpg, không phải video)' };
      }

      const isIgHost = /(^|\.)(fbcdn\.net|cdninstagram\.com)$/i.test(host);
      const isIgSource = source === 'ig-json' || source === 'inject:ig-response'
        || source === 'inject:ig-single-post' || source === 'inject:shortcode-match'
        || source === 'inject:shortcode-resolved' || source === 'inject:react-fiber'
        || source === 'video-tag' || source === 'source-tag'
        || source === 'inject:media-src' || source === 'inject:video-src'
        || (source === 'network-media' && extra && extra.label === 'video')
        || /\/(?:o1\/v\/t16|v\/t50\.)/i.test(url);

      const isVideo = (isInstagramPage() && isIgHost && isIgSource) || host.includes('instagram')
        || url.includes('/o1/v/t16/') || (typeof source === 'string' && source.includes('ig'));

      if (!isVideo) return null;
      return {
        isVideo: true,
        allow: true,
        label: 'Instagram Video',
        platform: isThreadsPage() ? 'threads' : 'instagram',
      };
    },

    scanScripts: scanIgScripts,

    scanRoot(root, ctx) {
      if (!root) return;
      document.querySelectorAll('script').forEach((s) => scanIgScripts(s, ctx));
      try {
        extractIgJson(root.innerHTML, ctx);
      } catch { /* ignore */ }
    },

    extractPostCode(href) {
      if (!href) return null;
      const match = href.match(/\/(?:reel|reels|p)\/([A-Za-z0-9_-]+)/i);
      return match ? match[1] : null;
    },

    extractIgJson,
    unescapeJson,
    isThreadsPage,
  });
})();
