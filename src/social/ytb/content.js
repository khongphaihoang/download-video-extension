/**
 * src/social/ytb/content.js — Logic YouTube content script (chạy trong ISOLATED world).
 */

(() => {
  'use strict';

  window.__VG_CONTENT_MODULES__ = window.__VG_CONTENT_MODULES__ || {};

  const YOUTUBE_HOST_RE = /(^|\.)googlevideo\.com$/i;

  function isYouTubePage() {
    try {
      return /^(www\.|m\.)?youtube\.com$/i.test(location.hostname);
    } catch {
      return false;
    }
  }

  window.__VG_CONTENT_MODULES__.ytb = {
    name: 'ytb',

    isPage: isYouTubePage,

    isCandidate(url, host, source) {
      const isFromYtParser = typeof source === 'string' && source.startsWith('inject:yt-');
      if (YOUTUBE_HOST_RE.test(host)) {
        if (!isFromYtParser) {
          return { allow: false, reason: 'googlevideo.com bỏ qua (chỉ nhận qua YT parser)' };
        }
        return { allow: true };
      }
      return null;
    },

    classify(url, source) {
      const isFromYtParser = typeof source === 'string' && source.startsWith('inject:yt-');
      if (isFromYtParser) {
        return source === 'inject:yt-progressive' ? 'file' : 'yt-adaptive';
      }
      return null;
    },

    wrapMeta(via, extra) {
      if (extra && !extra.ytMeta && typeof via === 'string' && via.startsWith('yt-')) {
        extra.ytMeta = { ...extra };
      }
      return extra;
    },

    YOUTUBE_HOST_RE,
  };
})();
