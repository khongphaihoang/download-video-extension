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

  const postMap = new Map();
  const postKey = (codeOrId) => `fb:${codeOrId}`;
  let activeVideoContext = null;
  let activeSession = 0;

  function isFacebookPage() {
    return /(^|\.)(facebook\.com|fb\.com)$/i.test(location.hostname);
  }

  function mediaPath(url) {
    try {
      const parsed = new URL(url, location.href);
      return /(^|\.)(scontent[^.]*|video[^.]*)\.fbcdn\.net$/i.test(parsed.hostname) ? parsed.pathname : null;
    } catch {
      return null;
    }
  }

  function fbAssetIdFromUrl(url) {
    if (typeof url !== 'string') return null;
    try {
      const u = new URL(url, location.href);
      const efg = u.searchParams.get('efg');
      if (efg) {
        const decoded = atob(efg.replace(/_/g, '/').replace(/-/g, '+'));
        const parsed = JSON.parse(decoded);
        if (parsed.xpv_asset_id) return String(parsed.xpv_asset_id);
        if (parsed.video_id) return String(parsed.video_id);
      }
    } catch { /* ignore */ }
    return null;
  }

  function matchesActiveMedia(url) {
    const path = mediaPath(url);
    return !!(path && activeVideoContext && activeVideoContext.mediaPaths.has(path));
  }

  function rememberActiveMedia(url) {
    const path = mediaPath(url);
    if (path && activeVideoContext) activeVideoContext.mediaPaths.add(path);
  }

  function findVideoUrlsInObject(obj, maxDepth = 4) {
    const results = [];
    const visited = new Set();
    function walk(o, d) {
      if (!o || typeof o !== 'object' || d > maxDepth || visited.has(o)) return;
      visited.add(o);
      for (const key of FB_KEYS) {
        if (typeof o[key] === 'string' && /^https?:\/\//i.test(o[key])) {
          results.push({ key, url: unescapeFbJson(o[key]) });
        }
      }
      for (const val of Object.values(o)) {
        if (val && typeof val === 'object') walk(val, d + 1);
      }
    }
    walk(obj, 0);
    return results;
  }

  function extractNodeIds(record) {
    const ids = new Set();
    const candidateFields = ['id', 'video_id', 'videoId', 'post_id', 'story_fbid', 'fbid', 'asset_id', 'xpv_asset_id'];
    for (const f of candidateFields) {
      const v = record[f];
      if (v != null && /^[0-9]{1,25}$/.test(String(v))) {
        ids.add(String(v));
      }
    }
    return Array.from(ids);
  }

  function setActiveVideo(videoEl, ctx) {
    activeSession += 1;
    const pageUrl = (ctx && ctx.pageUrl) || location.href;
    activeVideoContext = {
      element: videoEl,
      postId: fbVideoIdFromUrl(pageUrl),
      pageUrl,
      sessionId: activeSession,
      startedAt: Date.now(),
      mediaPaths: new Set(),
      reportedUrls: new Set(),
    };

    const directUrl = videoEl && (videoEl.currentSrc || videoEl.src);
    if (directUrl && /^https?:\/\//i.test(directUrl) && !directUrl.startsWith('blob:')) {
      rememberActiveMedia(directUrl);
    }

    notifyActiveContext();
    if (ctx && ctx.log) {
      ctx.log.info('[FB] ACTIVE VIDEO', {
        postId: activeVideoContext.postId,
        sessionId: activeSession,
        element: videoEl,
      });
    }
    return activeVideoContext;
  }

  function notifyActiveContext(mediaUrl) {
    if (!activeVideoContext) return;
    window.postMessage({
      __videoGrabber: true,
      url: '',
      via: 'fb-active',
      meta: {
        sessionId: activeVideoContext.sessionId,
        postId: activeVideoContext.postId,
        pageUrl: activeVideoContext.pageUrl,
        mediaUrl: mediaUrl || null,
        mediaPath: mediaUrl ? mediaPath(mediaUrl) : null,
      },
    }, '*');
  }

  function reportActive(url, via, meta, ctx) {
    if (!url || typeof url !== 'string') return false;
    const key = String(url).split('#')[0];
    if (activeVideoContext && activeVideoContext.reportedUrls.has(key)) return false;
    if (activeVideoContext) activeVideoContext.reportedUrls.add(key);

    rememberActiveMedia(url);
    notifyActiveContext(url);

    ctx.report(url, via, {
      ...(meta || {}),
      activeMediaUrl: url,
      sessionId: activeVideoContext ? activeVideoContext.sessionId : null,
      isCurrent: true,
      label: (meta && meta.label) || 'Đang phát',
    });
    return true;
  }

  function recordPostVideo(codeOrId, url, extra) {
    if (!codeOrId || typeof url !== 'string') return;
    const cleanUrl = unescapeFbJson(url);
    if (!/^https?:\/\//i.test(cleanUrl)) return;
    const key = postKey(codeOrId);
    const rank = (extra && extra.rank) || 0;
    const previous = postMap.get(key);
    if (previous && previous.rank > rank) return;
    postMap.set(key, {
      code: String(codeOrId),
      url: cleanUrl,
      rank,
      quality: (extra && extra.quality) || 'HD',
      title: (extra && extra.title) || null,
    });
  }

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

      // /videos/123, /reel/123, /reels/123
      const match = u.pathname.match(/\/(?:videos|reel|reels)\/([0-9]+)(?:\/|$)/i);
      if (match) return match[1];

      // /watch/?v=123 hoặc /watch/123
      if (u.pathname.startsWith('/watch')) {
        const v = u.searchParams.get('v');
        if (v && /^[0-9]+$/.test(v)) return v;
        const watchMatch = u.pathname.match(/\/watch\/([0-9]+)/i);
        if (watchMatch) return watchMatch[1];
      }

      // /posts/123
      const postMatch = u.pathname.match(/\/posts\/([0-9]+)(?:\/|$)/i);
      if (postMatch) return postMatch[1];

      // story_fbid=123
      const storyFbid = u.searchParams.get('story_fbid');
      if (storyFbid && /^[0-9]+$/.test(storyFbid)) return storyFbid;

      // permalink.php?story_fbid=123
      const fbid = u.searchParams.get('fbid');
      if (fbid && /^[0-9]+$/.test(fbid)) return fbid;
    } catch { /* ignore */ }
    return null;
  }

  function isFbApiRequest(url) {
    if (typeof url !== 'string') return false;
    try {
      const u = new URL(url, location.href);
      const host = u.hostname;
      if (!/(^|\.)(facebook\.com|fb\.com)$/i.test(host)) return false;
      return /\/(?:graphql|ajax|api)(?:\/|$)/i.test(u.pathname)
        || /(?:graphql|api|video|media)/i.test(u.search);
    } catch { /* ignore */ }
    return false;
  }

  window.__VG_INJECT_MODULES__.fb = {
    name: 'fb',

    isCandidate(url, host, via) {
      const isFbPage = isFacebookPage();
      const isFbCdn = /(^|\.)(scontent[^.]*|video[^.]*)\.fbcdn\.net$/i.test(host);

      if (/static[^.]*\.fbcdn\.net/i.test(host) || /\/btmanifest\//i.test(url) || /\/rsrc\.php\//i.test(url)) {
        return { isVideo: false, isStreamSegment: false };
      }

      const isVideo = isFbPage && isFbCdn && [
        'fb-response', 'fb-single-post', 'fb-id-match', 'shortcode-resolved',
        'react-fiber', 'fb-active-stream', 'fetch', 'xhr'
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

    onRequest(url, ctx) {
      if (!isFacebookPage() || typeof url !== 'string') return;
      if (/static[^.]*\.fbcdn\.net/i.test(url) || /\/btmanifest\//i.test(url) || /\/rsrc\.php\//i.test(url)) return;

      try {
        const u = new URL(url, location.href);
        if (!/(^|\.)(scontent[^.]*|video[^.]*)\.fbcdn\.net$/i.test(u.hostname)) return;

        const isStream = u.searchParams.has('bytestart') || u.searchParams.has('byteend');
        if (isStream) {
          const path = u.pathname;
          const assetId = fbAssetIdFromUrl(url);

          // Tạo URL sạch (bỏ byte range) để tải toàn bộ video
          u.searchParams.delete('bytestart');
          u.searchParams.delete('byteend');
          const cleanUrl = u.toString();

          const targetPostId = (activeVideoContext && activeVideoContext.postId) || fbVideoIdFromUrl(location.href);
          const postEntry = targetPostId ? postMap.get(postKey(targetPostId)) : null;
          const knownTargetPath = postEntry ? mediaPath(postEntry.url) : null;
          const knownTargetAssetId = postEntry ? fbAssetIdFromUrl(postEntry.url) : null;

          const isDirectMatch = activeVideoContext && (
            (activeVideoContext.mediaPaths.size > 0 && activeVideoContext.mediaPaths.has(path)) ||
            (knownTargetPath && path === knownTargetPath) ||
            (targetPostId && assetId && assetId === String(targetPostId)) ||
            (knownTargetAssetId && assetId && assetId === String(knownTargetAssetId))
          );

          // Chỉ khi active context mới khởi tạo, chưa có media path và chưa có trong postMap
          const isInitialStream = activeVideoContext
            && activeVideoContext.mediaPaths.size === 0
            && !postEntry
            && (Date.now() - activeVideoContext.startedAt < 2000);

          if (isDirectMatch || isInitialStream) {
            if (activeVideoContext) {
              activeVideoContext.mediaPaths.add(path);
            }
            notifyActiveContext(cleanUrl);

            if (activeVideoContext && !activeVideoContext.reportedUrls.has(cleanUrl)) {
              activeVideoContext.reportedUrls.add(cleanUrl);
              const reportFn = (ctx && ctx.report);
              if (typeof reportFn === 'function') {
                reportFn(cleanUrl, 'fb-active-stream', {
                  isCurrent: true,
                  label: 'Đang phát',
                  sessionId: activeVideoContext.sessionId,
                  code: targetPostId || assetId,
                });
              }
            }
          } else {
            // Stream preload của video khác: chỉ report ứng viên thường, KHÔNG cướp quyền "Đang phát"
            const reportFn = (ctx && ctx.report);
            if (typeof reportFn === 'function') {
              reportFn(cleanUrl, 'fb-response', {
                label: 'preload-stream',
                code: assetId,
              });
            }
          }
        }
      } catch { /* ignore */ }
    },

    isCurrentRequest(url, via, lastActiveVideoTime) {
      if (!isFacebookPage()) return false;
      if (/static[^.]*\.fbcdn\.net/i.test(url) || /\/btmanifest\//i.test(url)) return false;
      if (!activeVideoContext) return false;
      if (via !== 'fetch' && via !== 'xhr') return true;
      return matchesActiveMedia(url);
    },

    decorateCandidate(url, via, meta) {
      if (!activeVideoContext) return meta;
      if (/static[^.]*\.fbcdn\.net/i.test(url) || /\/btmanifest\//i.test(url)) return meta;
      const isCurrent = matchesActiveMedia(url)
        || via === 'fb-single-post' || via === 'fb-id-match' || via === 'react-fiber' || via === 'fb-active-stream';
      if (!isCurrent) return meta;
      return {
        ...(meta || {}),
        activeMediaUrl: url,
        sessionId: activeVideoContext.sessionId,
        isCurrent: true,
        label: (meta && meta.label) || 'Đang phát',
      };
    },

    scanResponse(text, ctx) {
      if (!text || text.length < 80) return;
      if (
        !text.includes('browser_native') &&
        !text.includes('playable_url') &&
        !text.includes('hd_src') &&
        !text.includes('sd_src') &&
        !text.includes('progressive_url') &&
        !text.includes('BaseURL')
      ) {
        return;
      }

      const activePostId = activeVideoContext && activeVideoContext.postId;
      const currentUrlPostId = fbVideoIdFromUrl(location.href);
      const targetPostId = activePostId || currentUrlPostId;

      if (ctx.eachResponseObject) {
        ctx.eachResponseObject(text, (record) => {
          const nodeIds = extractNodeIds(record);
          const videoUrls = findVideoUrlsInObject(record);
          if (!videoUrls.length) return;

          for (const item of videoUrls) {
            const isHd = item.key.includes('hd');
            const cleanUrl = item.url;
            const assetId = fbAssetIdFromUrl(cleanUrl);
            const quality = isHd ? 'HD' : 'SD';
            const rank = isHd ? 2 : 1;

            for (const id of nodeIds) {
              recordPostVideo(id, cleanUrl, { quality, rank });
            }
            if (assetId) {
              recordPostVideo(assetId, cleanUrl, { quality, rank });
            }

            const isMatchedPost = targetPostId && (
              nodeIds.includes(String(targetPostId)) ||
              (assetId && assetId === String(targetPostId))
            );

            if (isMatchedPost) {
              recordPostVideo(String(targetPostId), cleanUrl, { quality, rank });
              reportActive(cleanUrl, 'fb-response', { label: item.key, code: String(targetPostId) }, ctx);
            } else {
              const code = nodeIds[0] || assetId || null;
              ctx.report(cleanUrl, 'fb-response', { label: item.key, code });
            }
          }
        });
      }

      for (const key of FB_KEYS) {
        const re = new RegExp('"' + key + '"\\s*:\\s*"([^"]{20,4000})"', 'g');
        let m;
        while ((m = re.exec(text)) !== null) {
          const url = unescapeFbJson(m[1]);
          if (/^https?:\/\//i.test(url)) {
            const assetId = fbAssetIdFromUrl(url);
            if (assetId) {
              recordPostVideo(assetId, url, { quality: key.includes('hd') ? 'HD' : 'SD', rank: 1 });
            }
            const isMatch = (targetPostId && assetId && assetId === String(targetPostId))
              || (activeVideoContext && matchesActiveMedia(url));
            if (isMatch) {
              if (targetPostId) {
                recordPostVideo(String(targetPostId), url, { quality: key.includes('hd') ? 'HD' : 'SD', rank: 1 });
              }
              reportActive(url, 'fb-response', { label: key, code: targetPostId || assetId }, ctx);
            } else {
              ctx.report(url, 'fb-response', { label: key, code: assetId });
            }
          }
        }
      }

      // Quét thêm BaseURL trong DASH manifest
      const buRe = /<BaseURL>([^<]{20,4000})<\/BaseURL>/g;
      let bm;
      while ((bm = buRe.exec(text)) !== null) {
        const url = unescapeFbJson(bm[1]);
        if (/^https?:\/\//i.test(url) && /(^|\.)(scontent[^.]*|video[^.]*)\.fbcdn\.net$/i.test(new URL(url).hostname)) {
          if (activeVideoContext && matchesActiveMedia(url)) {
            reportActive(url, 'fb-response', { label: 'dash-base' }, ctx);
          } else {
            ctx.report(url, 'fb-response', { label: 'dash-base' });
          }
        }
      }

      if (targetPostId) {
        const entry = postMap.get(postKey(targetPostId));
        if (entry && entry.url) {
          reportActive(entry.url, 'fb-single-post', { label: 'Đang phát', code: targetPostId }, ctx);
        }
      }
    },

    extractFiberProps(p) {
      if (!p || typeof p !== 'object') return null;

      const directCode = p.video_id || p.videoId || p.id || p.asset_id || p.xpv_asset_id;
      const fbHd = p.browser_native_hd_url || p.playable_url_quality_hd || p.hd_src;
      if (typeof fbHd === 'string' && /^https?:\/\//i.test(fbHd)) {
        return { url: fbHd, quality: 'HD', code: directCode && String(directCode) };
      }
      const fbSd = p.browser_native_sd_url || p.playable_url || p.sd_src || p.progressive_url;
      if (typeof fbSd === 'string' && /^https?:\/\//i.test(fbSd)) {
        return { url: fbSd, quality: 'SD', code: directCode && String(directCode) };
      }

      const targets = [p.item, p.media, p.post, p.videoData, p.creation_story, p.story, p.playbackConfig, p.video, p.reel];
      for (const t of targets) {
        if (!t || typeof t !== 'object') continue;
        const code = t.video_id || t.videoId || t.id || t.asset_id || t.xpv_asset_id || directCode;
        const thd = t.browser_native_hd_url || t.playable_url_quality_hd || t.hd_src;
        if (typeof thd === 'string' && /^https?:\/\//i.test(thd)) {
          return { url: thd, quality: 'HD', code: code && String(code) };
        }
        const tsd = t.browser_native_sd_url || t.playable_url || t.sd_src || t.progressive_url;
        if (typeof tsd === 'string' && /^https?:\/\//i.test(tsd)) {
          return { url: tsd, quality: 'SD', code: code && String(code) };
        }
        if (code) {
          const entry = postMap.get(postKey(code));
          if (entry && entry.url) {
            return { url: entry.url, quality: entry.quality || 'HD', code: String(code) };
          }
        }
      }

      if (directCode) {
        const entry = postMap.get(postKey(directCode));
        if (entry && entry.url) {
          return { url: entry.url, quality: entry.quality || 'HD', code: String(directCode) };
        }
      }

      return null;
    },

    onVideoPlay(videoEl, ctx) {
      if (!videoEl) return false;
      const active = setActiveVideo(videoEl, ctx);
      const keys = Object.keys(videoEl);
      const fiberKey = keys.find((key) => key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$'));
      let fiber = fiberKey && videoEl[fiberKey];

      for (let depth = 0; fiber && depth < 40; depth++, fiber = fiber.return) {
        const props = fiber.memoizedProps;
        const state = fiber.memoizedState;
        let result = props && this.extractFiberProps(props);
        if (!result && state && typeof state === 'object') {
          result = this.extractFiberProps(state);
        }
        if (result && result.url) {
          if (result.code && !active.postId) active.postId = result.code;
          rememberActiveMedia(result.url);
          notifyActiveContext(result.url);
          ctx.report(result.url, 'react-fiber', {
            isCurrent: true,
            label: 'Đang phát',
            title: result.title || null,
            code: result.code || null,
            sessionId: active.sessionId,
          });
          return true;
        }
      }

      return this.handleActivePlay(active.pageUrl, ctx);
    },

    handleActivePlay(href, ctx) {
      const fbId = fbVideoIdFromUrl(href) || (activeVideoContext && activeVideoContext.postId);
      if (fbId) {
        const entry = postMap.get(postKey(fbId));
        if (entry && entry.url) {
          rememberActiveMedia(entry.url);
          notifyActiveContext(entry.url);
          ctx.log.info(`🎯 [ActivePlay] Khớp chính xác Facebook Video [${fbId}] từ postMap:`, mediaPath(entry.url));
          reportActive(entry.url, 'fb-id-match', { label: 'Đang phát', code: fbId }, ctx);
          return true;
        }
      }
      return false;
    },

    resolveVideo(code, pageUrl, title, ctx) {
      if (!code) return false;
      const entry = postMap.get(postKey(code));
      if (entry && entry.url) {
        rememberActiveMedia(entry.url);
        notifyActiveContext(entry.url);
        ctx.log.info(`🎯 [resolveVideo] Khớp postMap cho Facebook code [${code}]:`, mediaPath(entry.url));
        reportActive(entry.url, 'shortcode-resolved', {
          label: 'Đang phát',
          code,
          title: title || entry.title,
          pageUrl,
        }, ctx);
        return true;
      }
      return false;
    },

    fbVideoIdFromUrl,
    unescapeFbJson,
  };
})();
