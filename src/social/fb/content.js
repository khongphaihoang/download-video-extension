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
  let activeFbSession = 0;
  let activeFbPostId = null;
  let localFbSession = 0;
  let activeFbElement = null;
  let activeFbMainSession = 0;

  function unescapeJson(s) {
    return s
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\\//g, '/')
      .replace(/\\\\/g, '\\');
  }

  function isFacebookPage() {
    return /(^|\.)(facebook\.com|fb\.com)$/i.test(location.hostname);
  }

  function mediaPath(raw) {
    try {
      const url = new URL(raw, location.href);
      return /(^|\.)(scontent[^.]*|video[^.]*)\.fbcdn\.net$/i.test(url.hostname) ? url.pathname : null;
    } catch {
      return null;
    }
  }

  function setActiveVideo(video, meta) {
    const pageUrl = (meta && meta.pageUrl) || location.href;
    const suppliedSession = Number(meta && meta.sessionId);
    const sessionChanged = suppliedSession && suppliedSession !== activeFbSession;
    if (sessionChanged) {
      activeFbMediaPath = null;
      activeFbPostId = null;
    }
    if (suppliedSession) {
      activeFbSession = suppliedSession;
      activeFbMainSession = suppliedSession;
    } else if (activeFbMainSession === activeFbSession && activeFbMainSession) {
      activeFbMainSession = 0;
    } else if (!activeFbSession || (video && activeFbElement !== video)) {
      activeFbSession = ++localFbSession;
      activeFbMediaPath = null;
      activeFbPostId = null;
    }
    if (video) activeFbElement = video;
    activeFbPostId = (meta && meta.postId) || activeFbPostId;

    const nextPath = mediaPath(video && (video.currentSrc || video.src));
    if (nextPath) activeFbMediaPath = nextPath;
    if (meta && meta.mediaPath) activeFbMediaPath = meta.mediaPath;
    else if (!activeFbMediaPath && meta && meta.mediaUrl) activeFbMediaPath = mediaPath(meta.mediaUrl);

    return { sessionId: activeFbSession, postId: activeFbPostId, pageUrl };
  }

  function matchesActive(url, extra) {
    if (!activeFbSession) return false;
    if (extra && extra.sessionId && Number(extra.sessionId) !== activeFbSession) return false;
    const path = mediaPath(url);
    if (path && activeFbMediaPath && path === activeFbMediaPath) return true;
    return false;
  }

  function primeActiveMedia(extra) {
    if (!activeFbSession || !extra) return;
    if (extra.sessionId && Number(extra.sessionId) !== activeFbSession) return;
    if (!activeFbMediaPath && extra.activeMediaUrl) activeFbMediaPath = mediaPath(extra.activeMediaUrl);
  }

  function cleanMediaUrl(raw) {
    if (typeof raw !== 'string') return raw;
    try {
      const u = new URL(raw);
      if (u.searchParams.has('bytestart') || u.searchParams.has('byteend')) {
        if (/(^|\.)(scontent[^.]*|video[^.]*)\.fbcdn\.net$/i.test(u.hostname)) {
          u.searchParams.delete('bytestart');
          u.searchParams.delete('byteend');
          return u.toString();
        }
      }
    } catch { /* ignore */ }
    return raw;
  }

  function fbAssetIdFromUrl(raw) {
    try {
      const u = new URL(raw, location.href);
      const efg = u.searchParams.get('efg');
      if (efg) {
        const decoded = atob(efg.replace(/_/g, '/').replace(/-/g, '+'));
        const p = JSON.parse(decoded);
        return String(p.xpv_asset_id || p.video_id || '');
      }
    } catch { /* ignore */ }
    return null;
  }

  function extractFbJson(text, addFn, bumpStat) {
    if (!text || text.length < 80) return;
    const currentPostId = window.__VG_CONTENT_MODULES__.fb ? window.__VG_CONTENT_MODULES__.fb.matchVideoCode(location.href) : null;
    for (const key of FB_KEYS) {
      const re = new RegExp('"' + key + '"\\s*:\\s*"([^"]{20,4000})"', 'g');
      let m;
      while ((m = re.exec(text)) !== null) {
        const url = unescapeJson(m[1]);
        if (/^https?:\/\//i.test(url)) {
          const assetId = fbAssetIdFromUrl(url);
          const code = assetId || null;
          const isCurrent = !!(currentPostId && code && String(code) === String(currentPostId));
          if (addFn(url, 'fb-json', { label: key, code, isCurrent })) {
            if (bumpStat) bumpStat('fb-json');
          }
        }
      }
    }
  }

  window.__VG_CONTENT_MODULES__.fb = {
    name: 'fb',

    isPage: isFacebookPage,
    matchPage: isFacebookPage,

    cleanMediaUrl,
    normalize: cleanMediaUrl,

    onActiveContext(meta) {
      setActiveVideo(null, meta);
      if (meta && meta.mediaPath) {
        activeFbMediaPath = meta.mediaPath;
      } else if (meta && meta.mediaUrl) {
        const p = mediaPath(meta.mediaUrl);
        if (p) activeFbMediaPath = p;
      }
    },

    onVideoPlay(video, ctx) {
      setActiveVideo(video, { pageUrl: ctx && ctx.pageUrl });
      return { isCurrent: true };
    },

    onCandidate({ url, source, extra }) {
      if (!isFacebookPage()) return null;
      if (/static[^.]*\.fbcdn\.net/i.test(url) || /\/btmanifest\//i.test(url) || /\/rsrc\.php\//i.test(url)) {
        return { reject: true, reason: 'FB static/manifest asset' };
      }
      primeActiveMedia(extra);
      if (matchesActive(url, extra) || (extra && extra.isCurrent)) {
        return { isCurrent: true, label: (extra && extra.label) || 'Đang phát' };
      }
      return null;
    },

    onProcessUrl(url, source, extra, items, addFn) {
      if (!isFacebookPage()) return { isCurrent: false };
      try {
        const media = new URL(url);
        if (/(^|\.)(scontent[^.]*|video[^.]*)\.fbcdn\.net$/i.test(media.hostname)) {
          const fbMediaPath = media.pathname;
          if ((media.searchParams.has('bytestart') || media.searchParams.has('byteend'))
            && (source === 'inject:fetch' || source === 'inject:xhr' || source === 'inject:fb-active-stream')
            && extra && extra.isCurrent) {
            activeFbMediaPath = fbMediaPath;
            for (const item of items.values()) {
              try {
                if (new URL(item.url).pathname === fbMediaPath) {
                  item.isCurrent = true;
                  item.label = item.label || 'Đang phát';
                  item.foundAt = Date.now();
                }
              } catch { /* ignore */ }
            }
          }
          const isCurrent = !!(fbMediaPath && fbMediaPath === activeFbMediaPath);
          return { isCurrent };
        }
      } catch { /* ignore */ }
      return { isCurrent: false };
    },

    isCandidate(url, host, source, extra) {
      if (!isFacebookPage()) return false;
      if (/static[^.]*\.fbcdn\.net/i.test(host) || /\/btmanifest\//i.test(url) || /\/rsrc\.php\//i.test(url)) {
        return false;
      }
      const isFbHost = /(^|\.)(scontent[^.]*|video[^.]*)\.fbcdn\.net$/i.test(host);
      const isFbSource = source === 'fb-json' || source === 'inject:fb-response'
        || source === 'inject:fb-single-post' || source === 'inject:fb-id-match'
        || source === 'inject:shortcode-resolved' || source === 'inject:react-fiber'
        || source === 'inject:fb-active-stream' || source === 'video-play'
        || source === 'video-playing' || source === 'video-click' || source === 'reels-active'
        || source === 'inject:fetch' || source === 'inject:xhr';
      return isFbHost && isFbSource;
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

      const currentPostId = this.matchVideoCode(location.href);

      // Thử parse JSON có cấu trúc (Relay store / application/json)
      let parsed = null;
      if (s.type === 'application/json' || t.startsWith('{') || t.startsWith('for(;;);{')) {
        try {
          parsed = JSON.parse(t.replace(/^for\s*\(;;\);?\s*/, ''));
        } catch { /* ignore */ }
      }

      if (parsed) {
        const targetUrls = [];
        const otherUrls = [];
        const visited = new WeakSet();

        function walk(obj) {
          if (!obj || typeof obj !== 'object' || visited.has(obj)) return;
          visited.add(obj);

          const id = obj.id || obj.video_id || obj.videoId || obj.post_id || obj.story_fbid;
          const isTargetNode = currentPostId && String(id) === String(currentPostId);

          for (const key of FB_KEYS) {
            if (typeof obj[key] === 'string' && /^https?:\/\//i.test(obj[key])) {
              const u = unescapeJson(obj[key]);
              const assetId = fbAssetIdFromUrl(u);
              const item = { url: u, key, code: id ? String(id) : (assetId || null) };
              if (isTargetNode) targetUrls.push(item);
              else otherUrls.push(item);
            }
          }

          if (Array.isArray(obj)) {
            for (const item of obj) walk(item);
          } else {
            for (const val of Object.values(obj)) {
              if (val && typeof val === 'object') walk(val);
            }
          }
        }

        walk(parsed);

        for (const item of targetUrls) {
          addFn(item.url, 'fb-json', { isCurrent: true, label: item.key, code: item.code || currentPostId });
          if (bumpStat) bumpStat('fb-json');
        }
        for (const item of otherUrls) {
          addFn(item.url, 'fb-json', { isCurrent: false, label: item.key, code: item.code });
          if (bumpStat) bumpStat('fb-json');
        }
        return;
      }

      // Fallback regex: quét các chuỗi URL trong script
      for (const key of FB_KEYS) {
        const re = new RegExp('"' + key + '"\\s*:\\s*"([^"]{20,4000})"', 'g');
        let m;
        while ((m = re.exec(t)) !== null) {
          const url = unescapeJson(m[1]);
          if (/^https?:\/\//i.test(url)) {
            const assetId = fbAssetIdFromUrl(url);
            const code = assetId || null;
            const isCurrent = !!(currentPostId && code && String(code) === String(currentPostId));
            if (addFn(url, 'fb-json', { label: key, isCurrent, code })) {
              if (bumpStat) bumpStat('fb-json');
            }
          }
        }
      }
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
      const match = href.match(/\/(?:videos|reel|reels)\/([0-9]+)/i)
        || href.match(/[?&]v=([0-9]+)/i)
        || href.match(/\/posts\/([0-9]+)/i)
        || href.match(/[?&]story_fbid=([0-9]+)/i)
        || href.match(/[?&]fbid=([0-9]+)/i);
      return match ? match[1] : null;
    },

    unescapeJson,
    extractFbJson,
  };
})();
