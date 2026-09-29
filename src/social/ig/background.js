/**
 * src/social/ig/background.js — Xử lý dữ liệu Instagram trong Background Service Worker.
 */

export function formatFilename(url, index, meta) {
  if (meta && meta.pageUrl && /instagram\.com\/(?:reel|reels|p)\/([A-Za-z0-9_-]+)/i.test(meta.pageUrl)) {
    const igMatch = meta.pageUrl.match(/instagram\.com\/(?:reel|reels|p)\/([A-Za-z0-9_-]+)/i);
    return `instagram_${igMatch[1]}.mp4`;
  }
  return null;
}
