/**
 * src/social/ytb/popup.js — Logic hiển thị và định dạng YouTube trong Popup.
 */

export function isYouTubeTab(tabUrl) {
  return !!(tabUrl && /^https?:\/\/(www\.|m\.)?youtube\.com\//i.test(tabUrl));
}

export const matchTab = isYouTubeTab;

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
