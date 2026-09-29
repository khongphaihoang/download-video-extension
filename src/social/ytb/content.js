/**
 * src/social/ytb/content.js — Logic YouTube content script (chạy trong ISOLATED world).
 */

(() => {
  'use strict';

  window.__VG_CONTENT_MODULES__ = window.__VG_CONTENT_MODULES__ || {};

  const base = window.__VG_SOCIAL_BASE__;
  if (!base) {
    console.warn('[VG:ytb] Thiếu src/social/base.js — kiểm tra manifest.json');
    return;
  }

  const YOUTUBE_HOST_RE = /(^|\.)googlevideo\.com$/i;

  function isYouTubePage() {
    try {
      return /^(www\.|m\.)?youtube\.com$/i.test(location.hostname);
    } catch {
      return false;
    }
  }

  window.__VG_CONTENT_MODULES__.ytb = base.defineContentModule({
    name: 'ytb',
    order: 10,

    matchPage: isYouTubePage,

    /**
     * Quy tắc của YouTube (trước đây nằm rải trong core):
     *   - googlevideo.com: chỉ nhận khi đến từ YT parser (via `yt-*`), nếu không thì veto.
     *   - via `yt-progressive` → file hoàn chỉnh; các via `yt-*` khác → adaptive.
     */
    matchUrl(url, { host, source }) {
      const isYtParser = typeof source === 'string' && source.startsWith('inject:yt-');

      if (YOUTUBE_HOST_RE.test(host) && !isYtParser) {
        return { reject: 'googlevideo.com bỏ qua (chỉ nhận qua YT parser)' };
      }
      if (!isYtParser) return null;

      return {
        allow: true,
        platform: 'youtube',
        kind: source === 'inject:yt-progressive' ? 'file' : 'yt-adaptive',
      };
    },

    /**
     * Bọc metadata phẳng từ inject thành extra.ytMeta — đây là thứ
     * background.filenameFor() và popup.parseItemInfo() đọc.
     */
    decorateCandidate(via, extra) {
      if (extra && !extra.ytMeta && typeof via === 'string' && via.startsWith('yt-')) {
        extra.ytMeta = { ...extra };
      }
      return extra;
    },

    YOUTUBE_HOST_RE,
  });
})();
