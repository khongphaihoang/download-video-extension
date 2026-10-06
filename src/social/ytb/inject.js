/**
 * src/social/ytb/inject.js — Logic YouTube inject (chạy trong MAIN world).
 */

(() => {
  'use strict';

  window.__VG_INJECT_MODULES__ = window.__VG_INJECT_MODULES__ || {};

  const YT_HOST_RE = /^(www\.|m\.)?youtube\.com$/i;

  function isYouTubePage() {
    try {
      return YT_HOST_RE.test(location.hostname);
    } catch {
      return false;
    }
  }

  const YT_ITAG = {
    18: { q: '360p', h: 360 }, 22: { q: '720p', h: 720 }, 37: { q: '1080p', h: 1080 },
    59: { q: '480p', h: 480 },
    160: { q: '144p', h: 144 }, 133: { q: '240p', h: 240 }, 134: { q: '360p', h: 360 },
    135: { q: '480p', h: 480 }, 136: { q: '720p', h: 720 }, 137: { q: '1080p', h: 1080 },
    278: { q: '144p', h: 144 }, 242: { q: '240p', h: 240 }, 243: { q: '360p', h: 360 },
    244: { q: '480p', h: 480 }, 247: { q: '720p', h: 720 }, 248: { q: '1080p', h: 1080 },
    394: { q: '144p', h: 144 }, 395: { q: '240p', h: 240 }, 396: { q: '360p', h: 360 },
    397: { q: '480p', h: 480 }, 398: { q: '720p', h: 720 }, 399: { q: '1080p', h: 1080 },
    140: { q: 'audio', audio: true }, 141: { q: 'audio', audio: true },
    249: { q: 'audio', audio: true }, 250: { q: 'audio', audio: true }, 251: { q: 'audio', audio: true },
  };

  let currentYtTitle = '';
  let liveYtEntry = null;
  const liveYtSeen = new Set();
  const ytMap = new Map();
  let lastYtEntry = null;
  let ytCurrentRetryTimer = null;

  function reportYt(url, via, meta) {
    try {
      if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return;
      window.postMessage({ __videoGrabber: true, url: String(url), via, meta }, '*');
    } catch { /* ignore */ }
  }

  function ytVideoIdFromUrl(raw) {
    try {
      const u = new URL(raw, location.href);
      const host = u.hostname;
      if (/^(www\.|m\.)?youtu\.be$/i.test(host)) {
        const id = u.pathname.split('/').filter(Boolean)[0] || '';
        return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
      }
      if (!/^(www\.|m\.|music\.)?youtube\.com$/i.test(host)) return null;
      const v = u.searchParams.get('v');
      if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return v;
      const match = u.pathname.match(/^\/(?:shorts|live|embed|v)\/([A-Za-z0-9_-]{11})(?:\/|$)/i);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  function currentYtVideoId() {
    const fromUrl = ytVideoIdFromUrl(location.href);
    if (fromUrl) return fromUrl;
    try {
      const details = window.ytInitialPlayerResponse && window.ytInitialPlayerResponse.videoDetails;
      return (details && details.videoId) || null;
    } catch {
      return null;
    }
  }

  function isExpiredYtUrl(url) {
    try {
      const raw = new URL(url).searchParams.get('expire');
      if (!raw) return false;
      const sec = Number(raw);
      if (!Number.isFinite(sec) || sec <= 0) return false;
      return sec * 1000 < Date.now();
    } catch {
      return false;
    }
  }

  function pickBestFormat(list) {
    let best = null;
    for (const fmt of list || []) {
      if (!fmt || typeof fmt.url !== 'string') continue;
      if (fmt.mimeType && fmt.mimeType.startsWith('audio/')) continue;
      if (isExpiredYtUrl(fmt.url)) continue;
      if (!best || (Number(fmt.height) || 0) > (Number(best.height) || 0)) best = fmt;
    }
    return best;
  }

  function recordYtVideo(videoId, title, formats, adaptiveFormats) {
    let best = pickBestFormat(formats);
    let via = 'yt-progressive';
    if (!best) {
      best = pickBestFormat(adaptiveFormats);
      via = 'yt-adaptive';
    }
    if (!best) return;

    const entry = {
      url: best.url,
      via,
      meta: {
        label: 'YT ' + (best.qualityLabel || '?'),
        quality: best.qualityLabel || '',
        mimeType: best.mimeType || '',
        width: best.width || 0,
        height: best.height || 0,
        title: title || '',
        videoId: videoId || '',
        isAdaptive: via !== 'yt-progressive',
        isAudio: false,
      },
    };

    const ids = new Set();
    if (videoId) ids.add(videoId);
    else if (currentYtVideoId()) ids.add(currentYtVideoId());
    if (!ids.size) ids.add('__current');
    for (const id of ids) ytMap.set(id, entry);
    lastYtEntry = entry;
  }

  const resolvedIds = new Set();

  async function resolveYtStream(videoId, log) {
    if (!videoId || resolvedIds.has(videoId)) return;
    resolvedIds.add(videoId);

    try {
      const endpoint = 'https://www.youtube.com/youtubei/v1/player?app=android&prettyPrint=false';
      const clientVersion = '21.26.364';
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-YouTube-Client-Name': '3',
          'X-YouTube-Client-Version': clientVersion,
        },
        body: JSON.stringify({
          videoId,
          context: {
            client: {
              clientName: 'ANDROID',
              clientVersion,
              androidSdkVersion: 30,
              osName: 'Android',
              hl: 'en',
              gl: 'US',
            },
          },
        }),
      });

      if (!res.ok) return;
      const data = await res.json();
      if (data.playabilityStatus && data.playabilityStatus.status !== 'OK') return;

      const title = (data.videoDetails && data.videoDetails.title) || currentYtTitle || '';
      if (title && !currentYtTitle) currentYtTitle = title;

      const formats = (data.streamingData && data.streamingData.formats) || [];
      let best = null;
      for (const fmt of formats) {
        if (!fmt || !fmt.url) continue;
        if (fmt.mimeType && fmt.mimeType.startsWith('audio/')) continue;
        if (!best || (Number(fmt.height) || 0) > (Number(best.height) || 0)) {
          best = fmt;
        }
      }

      if (best) {
        const quality = best.qualityLabel || (best.height ? `${best.height}p` : '480p');
        const meta = {
          label: 'YT ' + quality,
          quality,
          mimeType: best.mimeType || 'video/mp4',
          width: best.width || 0,
          height: best.height || 0,
          contentLength: best.contentLength || '',
          title,
          videoId,
          isAdaptive: false,
          isAudio: false,
          isCurrent: true,
          resolved: true,
        };

        if (log) log.info(`🎯 [yt-android] Lấy thành công link tải trực tiếp (${quality}):`, best.url.slice(0, 90));
        reportYt(best.url, 'yt-progressive', meta);

        const entry = {
          url: best.url,
          via: 'yt-progressive',
          meta,
        };
        ytMap.set(videoId, entry);
        lastYtEntry = entry;
      }
    } catch (err) {
      if (log) log.warn('Lỗi khi lấy luồng từ Innertube:', err);
    }
  }

  function reportYtCurrent() {
    const pageId = ytVideoIdFromUrl(location.href);
    if (pageId) resolveYtStream(pageId, null);
    if (liveYtEntry && liveYtEntry.pageId === pageId) {
      reportYt(liveYtEntry.url, liveYtEntry.via, { ...liveYtEntry.meta, isCurrent: true });
      return true;
    }
    const id = currentYtVideoId();
    if (id) resolveYtStream(id, null);
    let entry = id ? ytMap.get(id) : null;
    if (!entry && pageId) entry = lastYtEntry;
    if (!entry) return false;
    reportYt(entry.url, entry.via || 'yt-progressive', { ...entry.meta, isCurrent: true });
    return true;
  }

  function ensureYtCurrentReport() {
    if (reportYtCurrent()) return;
    clearInterval(ytCurrentRetryTimer);
    let tries = 0;
    ytCurrentRetryTimer = setInterval(() => {
      if (reportYtCurrent() || ++tries > 20) clearInterval(ytCurrentRetryTimer);
    }, 250);
  }

  function captureLiveMediaUrl(raw, log) {
    if (typeof raw !== 'string' || raw.length < 20) return;
    if (raw.indexOf('googlevideo.com/videoplayback') === -1) return;
    let u;
    try {
      u = new URL(raw, location.href);
    } catch {
      return;
    }
    if (!/(^|\.)googlevideo\.com$/i.test(u.hostname)) return;
    if (!/\/videoplayback$/i.test(u.pathname)) return;
    // Bỏ qua các gói chunk stream SABR nội bộ (application/vnd.yt-ump) không thể tải
    if (u.searchParams.has('sabr')) return;

    const itag = u.searchParams.get('itag') || '';
    if (!itag) return;

    for (const p of ['range', 'rn', 'rbuf', 'sq', 'alr']) u.searchParams.delete(p);
    const url = u.toString();
    if (liveYtSeen.has(url)) return;
    liveYtSeen.add(url);

    const mime = (u.searchParams.get('mime') || '').toLowerCase();
    const isAudio = mime.startsWith('audio/');
    const isVideoOnly = u.searchParams.has('aitags');
    const info = YT_ITAG[itag] || {};
    const via = isAudio || isVideoOnly ? 'yt-adaptive' : 'yt-progressive';

    const isLiveBroadcast = u.searchParams.get('source') === 'yt_live_broadcast' ||
      location.pathname.startsWith('/live/') ||
      !!(window.ytInitialPlayerResponse && window.ytInitialPlayerResponse.videoDetails && window.ytInitialPlayerResponse.videoDetails.isLiveContent);

    const quality = info.q || (info.h ? `${info.h}p` : '');
    const meta = {
      label: 'YT ' + (quality || ('itag ' + itag)) + (isAudio ? ' (Audio)' : isVideoOnly ? ' (chỉ hình)' : ''),
      quality: quality || (isAudio ? 'Audio' : ''),
      mimeType: mime || '',
      width: 0,
      height: info.h || 0,
      title: currentYtTitle,
      videoId: currentYtVideoId() || '',
      isAdaptive: via !== 'yt-progressive',
      isAudio,
      isLive: isLiveBroadcast,
    };
    if (log) log.info('🎯 [yt-media] Bắt được link player đang dùng:', url.slice(0, 90));
    reportYt(url, via, meta);

    const rank = via === 'yt-progressive' ? 100000 + (info.h || 0) : isAudio ? -1 : info.h || 0;
    const oldRank = liveYtEntry
      ? liveYtEntry.via === 'yt-progressive' ? 100000 + (liveYtEntry.meta.height || 0) : liveYtEntry.meta.isAudio ? -1 : liveYtEntry.meta.height || 0
      : -2;
    if (rank > oldRank) {
      liveYtEntry = { url, via, meta, pageId: ytVideoIdFromUrl(location.href) };
    }
  }

  function extractYouTubeFormats(playerResponse, log) {
    if (!playerResponse || !playerResponse.streamingData) return;
    const sd = playerResponse.streamingData;
    const title = (playerResponse.videoDetails && playerResponse.videoDetails.title) || '';
    const videoId = (playerResponse.videoDetails && playerResponse.videoDetails.videoId) || '';
    currentYtTitle = title;

    if (videoId) {
      resolveYtStream(videoId, log);
    }

    const formats = sd.formats || [];
    if (log) {
      log.info(`YouTube: phát hiện ${formats.length} progressive format & ${(sd.adaptiveFormats || []).length} adaptive format`);
    }
    for (const fmt of formats) {
      if (!fmt.url) continue;
      reportYt(fmt.url, 'yt-progressive', {
        label: 'YT ' + (fmt.qualityLabel || '?'),
        quality: fmt.qualityLabel || '',
        mimeType: fmt.mimeType || '',
        width: fmt.width || 0,
        height: fmt.height || 0,
        title: title,
        videoId: videoId,
      });
    }

    const adaptive = sd.adaptiveFormats || [];
    for (const fmt of adaptive) {
      if (!fmt.url) continue;
      const isAudio = fmt.mimeType && fmt.mimeType.startsWith('audio/');
      const lbl = isAudio
        ? 'YT Audio ' + (fmt.audioQuality || '').replace('AUDIO_QUALITY_', '').toLowerCase()
        : 'YT ' + (fmt.qualityLabel || '?') + ' (chỉ hình)';
      reportYt(fmt.url, 'yt-adaptive', {
        label: lbl,
        quality: fmt.qualityLabel || (isAudio ? 'audio' : ''),
        mimeType: fmt.mimeType || '',
        width: fmt.width || 0,
        height: fmt.height || 0,
        contentLength: fmt.contentLength || '',
        title: title,
        videoId: videoId,
        isAdaptive: true,
        isAudio: !!isAudio,
      });
    }

    recordYtVideo(videoId, title, formats, adaptive);
    reportYtCurrent();
  }

  window.__VG_INJECT_MODULES__.ytb = {
    name: 'ytb',

    isPage: isYouTubePage,

    isCandidate(url, host, via) {
      if (!/(^|\.)googlevideo\.com$/i.test(host)) return null;
      return typeof via === 'string' && via.startsWith('yt-')
        ? { isVideo: true }
        : { allow: false, reason: 'googlevideo.com chỉ nhận qua YouTube parser' };
    },

    isApiRequest(url) {
      return url && /\/youtubei\/v1\/player/i.test(url);
    },

    onFetchRequest(raw, ctx) {
      captureLiveMediaUrl(raw, ctx.log);
    },

    scanResponse(text, ctx) {
      try {
        const json = JSON.parse(text);
        extractYouTubeFormats(json, ctx.log);
      } catch { /* ignore */ }
    },

    handleActivePlay(href, ctx) {
      if (isYouTubePage()) {
        ensureYtCurrentReport();
        return true;
      }
      return false;
    },

    init(ctx) {
      if (isYouTubePage()) {
        let attempts = 0;
        const poll = setInterval(() => {
          if (window.ytInitialPlayerResponse) {
            clearInterval(poll);
            extractYouTubeFormats(window.ytInitialPlayerResponse, ctx.log);
          }
          if (++attempts > 60) clearInterval(poll);
        }, 100);

        setInterval(() => {
          try {
            reportYtCurrent();
          } catch { /* ignore */ }
        }, 3000);
      }
    },

    captureLiveMediaUrl,
    extractYouTubeFormats,
    reportYt,
  };
})();
