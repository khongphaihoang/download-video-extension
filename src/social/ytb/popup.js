/**
 * src/social/ytb/popup.js — Logic hiển thị và định dạng YouTube trong Popup.
 */

export function matchTab(tabUrl) {
  return !!(tabUrl && /^https?:\/\/(www\.|m\.)?youtube\.com\//i.test(tabUrl));
}

/** Popup có khối cảnh báo riêng cho platform này (xem #ytNotice trong popup.html). */
export const hasTabNotice = true;

export function isYouTubeItem(item) {
  const host = item.host || '';
  return !!(
    item.ytMeta ||
    item.kind === 'yt-adaptive' ||
    /(^|\.)googlevideo\.com$/i.test(host) ||
    /(^|\.)youtube\.com$/i.test(host)
  );
}

export function parseItemInfo(item) {
  if (!isYouTubeItem(item)) return null;

  const title = (item.ytMeta && item.ytMeta.title) || item.pageTitle || 'YouTube Video';
  let quality =
    (item.ytMeta && item.ytMeta.quality) ||
    (item.ytMeta && item.ytMeta.isAudio ? 'Audio' : item.kind === 'file' ? 'Progressive' : 'Adaptive');

  if (item.ytMeta && item.ytMeta.isLive) {
    quality += ' • live';
  }

  return {
    matched: true,
    platform: 'youtube',
    platformName: 'YouTube',
    title,
    quality,
  };
}

/** Tên file YouTube: tiêu đề + chất lượng + đuôi theo loại stream. */
export function formatFilename(item) {
  if (item.ytMeta && item.ytMeta.title) {
    const safe = item.ytMeta.title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim();
    const quality = item.ytMeta.quality || '';
    const ext = item.ytMeta.isAudio ? '.webm' : '.mp4';
    return safe + (quality ? ' [' + quality + ']' : '') + ext;
  }
  return null;
}
