/**
 * src/social/fb/content.js — Logic Facebook content script (chạy trong ISOLATED world).
 */

(() => {
  'use strict';

  window.__VG_CONTENT_MODULES__ = window.__VG_CONTENT_MODULES__ || {};

  const FB_KEYS = [
    'browser_native_hd_url',
    'browser_native_sd_url',
    'playable_url_quality_hd',
    'playable_url',
    'hd_src',
    'sd_src',
    'progressive_url',
  ];

  const seenNodes = new WeakSet();
  let activeFbMediaPath = null;
  let activeFbMediaAt = 0;

  function unescapeJson(s) {
    return s
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\\//g, '/')
      .replace(/\\\\/g, '\\');
  }

  function isFacebookPage() {
    return /(^|\.)(facebook\.com|fb\.com)$/i.test(location.hostname);
  }

  function cleanMediaUrl(raw) {
    if (typeof raw !== 'string') return raw;
    try {
      const u = new URL(raw);
      if (u.searchParams.has('bytestart') || u.searchParams.has('byteend')) {
        if (!isFacebookPage() && /(^|\.)fbcdn\.net$/i.test(u.hostname)) {
          u.searchParams.delete('bytestart');
          u.searchParams.delete('byteend');
          return u.toString();
        }
      }
    } catch { /* ignore */ }
    return raw;
  }

  function extractFbJson(text, addFn, bumpStat) {
    if (!text || text.length < 80) return;
    for (const key of FB_KEYS) {
      const re = new RegExp('"' + key + '"\\s*:\\s*"([^"]{20,4000})"', 'g');
      let m;
      while ((m = re.exec(text)) !== null) {
        const url = unescapeJson(m[1]);
        if (/^https?:\/\//i.test(url) && addFn(url, 'fb-json', { label: key })) {
          if (bumpStat) bumpStat('fb-json');
        }
      }
    }
  }

  window.__VG_CONTENT_MODULES__.fb = {
    name: 'fb',

    isPage: isFacebookPage,

    cleanMediaUrl,

    onProcessUrl(url, source, extra, items, addFn) {
      if (!isFacebookPage()) return { isCurrent: false };
      try {
        const media = new URL(url);
        if (/(^|\.)fbcdn\.net$/i.test(media.hostname)) {
          const fbMediaPath = media.pathname;
          if ((media.searchParams.has('bytestart') || media.searchParams.has('byteend'))
            && (source === 'inject:fetch' || source === 'inject:xhr') && extra && extra.isCurrent) {
            activeFbMediaPath = fbMediaPath;
            activeFbMediaAt = Date.now();
            const match = [...items.values()].find((item) => {
              try { return new URL(item.url).pathname === fbMediaPath; }
              catch { return false; }
            });
            if (match) addFn(match.url, 'fb-active-range', { isCurrent: true });
          }
          const isCurrent = !!(fbMediaPath && fbMediaPath === activeFbMediaPath && Date.now() - activeFbMediaAt < 10000);
          return { isCurrent };
        }
      } catch { /* ignore */ }
      return { isCurrent: false };
    },

    isCandidate(url, host, source) {
      const isFb = isFacebookPage() && /(^|\.)fbcdn\.net$/i.test(host);
      const isFbSource = source === 'fb-json' || source === 'inject:fb-response'
        || source === 'inject:fb-single-post' || source === 'inject:fb-id-match'
        || source === 'inject:shortcode-resolved' || source === 'inject:react-fiber';
      return isFb && isFbSource;
    },

    scanScripts(s, addFn, bumpStat) {
      if (!isFacebookPage()) return;
      if (seenNodes.has(s)) return;
      seenNodes.add(s);
      const t = s.textContent;
      if (!t || t.length < 80) return;
      if (!t.includes('browser_native') && !t.includes('playable_url')
        && !t.includes('hd_src') && !t.includes('sd_src') && !t.includes('progressive_url')) {
        return;
      }
      extractFbJson(t, addFn, bumpStat);
    },

    scanDeep(root, addFn, bumpStat) {
      if (!root) return;
      if (isFacebookPage()) {
        document.querySelectorAll('script').forEach((s) => {
          this.scanScripts(s, addFn, bumpStat);
        });
      }
      try {
        extractFbJson(root.innerHTML, addFn, bumpStat);
      } catch { /* ignore */ }
    },

    matchVideoCode(href) {
      if (!href) return null;
      const match = href.match(/\/(?:videos|reel)\/([0-9]+)/i) || href.match(/[?&]v=([0-9]+)/i);
      return match ? match[1] : null;
    },

    unescapeJson,
    extractFbJson,
  };
})();
