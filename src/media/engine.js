/**
 * src/media/engine.js — Media Engine (bước chuẩn bị).
 *
 * Chạy trong ISOLATED world, nạp giữa base.js và content.js.
 *
 * Trách nhiệm (giai đoạn này):
 *   - Phân loại một candidate URL thành 1 "kind": file | hls | dash | segment
 *     (hoặc 'yt-adaptive' nếu social module tự gán trước).
 *   - Quyết định kind nào được phép tải bằng chrome.downloads ở giai đoạn hiện tại.
 *
 * Chưa triển khai downloader cho HLS/DASH. Khi cần, chỉ việc thêm engine vào
 * ENGINES bên dưới (direct/hls/dash/adaptive) mà KHÔNG phải sửa social module.
 */

(() => {
  'use strict';

  if (window.__VG_MEDIA_ENGINE__) return;

  /** Danh sách engine + khả năng tải tương ứng. */
  const ENGINES = {
    // MP4/WebM progressive: chrome.downloads tải trực tiếp được.
    file: { id: 'direct', downloadable: true, label: 'Direct file' },

    // YouTube adaptive (video-only / audio-only): cần mux trước khi có file hoàn chỉnh.
    // Hiện tại vẫn cho tải thô để giữ hành vi cũ; sẽ chuyển sang mux về sau.
    'yt-adaptive': { id: 'adaptive', downloadable: true, label: 'Adaptive stream' },

    // Chưa hỗ trợ: cần ghép segment (media engine tương lai).
    hls: { id: 'hls', downloadable: false, label: 'HLS (chưa hỗ trợ)' },
    dash: { id: 'dash', downloadable: false, label: 'DASH (chưa hỗ trợ)' },
    segment: { id: 'segment', downloadable: false, label: 'Stream segment' },
  };

  /** Đoán kind từ URL khi social module không gán. */
  function classify(url) {
    if (/\.m3u8(\?|#|$)/i.test(url)) return 'hls';
    if (/\.mpd(\?|#|$)/i.test(url)) return 'dash';
    try {
      const u = new URL(url);
      if (u.searchParams.has('bytestart') || u.searchParams.has('byteend')) return 'segment';
      if (/\.m4s(\?|#|$)/i.test(url)) return 'segment';
      if (/\.ts(\?|#|$)/i.test(url)) return 'segment';
    } catch { /* ignore */ }
    return 'file';
  }

  function engineFor(kind) {
    return ENGINES[kind] || null;
  }

  /** Kind này có tải được ngay bằng chrome.downloads không? */
  function isDownloadable(kind) {
    const engine = engineFor(kind);
    return !!(engine && engine.downloadable);
  }

  window.__VG_MEDIA_ENGINE__ = {
    ENGINES,
    classify,
    engineFor,
    isDownloadable,
  };
})();
