/**
 * src/social/fb/content.js — Logic Facebook content script (chạy trong ISOLATED world).
 */

(() => {
  'use strict';

  window.__VG_CONTENT_MODULES__ = window.__VG_CONTENT_MODULES__ || {};

  const base = window.__VG_SOCIAL_BASE__;
  if (!base) {
    console.warn('[VG:fb] Thiếu src/social/base.js — kiểm tra manifest.json');
    return;
  }

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

  const unescapeJson = base.unescapeJson;

  function isFacebookPage() {
    return /(^|\.)(facebook\.com|fb\.com)$/i.test(location.hostname);
  }

  /**
   * Bỏ byte-range trên CDN Meta khi trang KHÔNG phải Facebook.
   *
   * fbcdn.net và cdninstagram.com là hạ tầng dùng chung của Facebook, Instagram
   * và Threads. Trên trang của Meta khác (IG/Threads), `bytestart/byteend` chỉ là
   * dấu vết của player DASH — giữ nguyên sẽ khiến URL bị coi là segment và bị loại,
   * nên phải bỏ để có link tải cả file. Trên chính trang Facebook thì giữ nguyên
   * (byte-range ở đó là cách player phát và được xử lý riêng ở onCandidate).
   */
  function normalizeMetaCdnUrl(raw) {
    if (typeof raw !== 'string') return raw;
    try {
      const u = new URL(raw);
      if (u.searchParams.has('bytestart') || u.searchParams.has('byteend')) {
        if (!isFacebookPage() && /(^|\.)(fbcdn\.net|cdninstagram\.com)$/i.test(u.hostname)) {
          u.searchParams.delete('bytestart');
          u.searchParams.delete('byteend');
          return u.toString();
        }
      }
    } catch { /* ignore */ }
    return raw;
  }

  function extractFbJson(text, ctx) {
    if (!text || text.length < 80) return;
    for (const key of FB_KEYS) {
      const re = new RegExp('"' + key + '"\\s*:\\s*"([^"]{20,4000})"', 'g');
      let m;
      while ((m = re.exec(text)) !== null) {
        const url = unescapeJson(m[1]);
        if (/^https?:\/\//i.test(url) && ctx.add(url, 'fb-json', { label: key })) {
          ctx.bumpStat('fb-json');
        }
      }
    }
  }

  function scanFbScripts(script, ctx) {
    if (!isFacebookPage()) return;
    if (seenNodes.has(script)) return;
    seenNodes.add(script);
    const t = script.textContent;
    if (!t || t.length < 80) return;
    if (!t.includes('browser_native') && !t.includes('playable_url')
      && !t.includes('hd_src') && !t.includes('sd_src') && !t.includes('progressive_url')) {
      return;
    }
    extractFbJson(t, ctx);
  }

  window.__VG_CONTENT_MODULES__.fb = base.defineContentModule({
    name: 'fb',
    order: 30,

    matchPage: isFacebookPage,

    normalize: normalizeMetaCdnUrl,

    /**
     * Facebook ghi nhớ media path đang phát (từ request byte-range) để suy ra
     * item nào là "đang xem" — trước đây đoạn này nằm trong core.
     */
    onCandidate({ url, source, extra, items, add }) {
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
            if (match) add(match.url, 'fb-active-range', { isCurrent: true });
          }
          const isCurrent = !!(fbMediaPath && fbMediaPath === activeFbMediaPath && Date.now() - activeFbMediaAt < 10000);
          return { isCurrent };
        }
      } catch { /* ignore */ }
      return { isCurrent: false };
    },

    matchUrl(url, { host, source }) {
      if (!isFacebookPage()) return null;

      const isFbCdn = /(^|\.)fbcdn\.net$/i.test(host);
      const isFbSource = source === 'fb-json' || source === 'inject:fb-response'
        || source === 'inject:fb-single-post' || source === 'inject:fb-id-match'
        || source === 'inject:shortcode-resolved' || source === 'inject:react-fiber';

      if (!isFbCdn || !isFbSource) return null;
      return { isVideo: true, allow: true, platform: 'facebook' };
    },

    scanScripts: scanFbScripts,

    scanRoot(root, ctx) {
      if (!root) return;
      if (isFacebookPage()) {
        document.querySelectorAll('script').forEach((s) => scanFbScripts(s, ctx));
      }
      try {
        extractFbJson(root.innerHTML, ctx);
      } catch { /* ignore */ }
    },

    extractPostCode(href) {
      if (!href) return null;
      const match = href.match(/\/(?:videos|reel)\/([0-9]+)/i) || href.match(/[?&]v=([0-9]+)/i);
      return match ? match[1] : null;
    },

    unescapeJson,
    extractFbJson,
    normalizeMediaUrl: normalizeMetaCdnUrl,
  });
})();
