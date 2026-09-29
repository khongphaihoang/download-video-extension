/**
 * src/social/fb/background.js — Xử lý dữ liệu Facebook trong Background Service Worker.
 */

export function facebookMediaKey(item) {
  try {
    const page = new URL(item.pageUrl);
    const media = new URL(item.url);
    if (!/(^|\.)(facebook\.com|fb\.com)$/i.test(page.hostname)
      || !/(^|\.)fbcdn\.net$/i.test(media.hostname)) return item.url;
    return 'fbcdn:' + media.pathname;
  } catch {
    return item.url;
  }
}

export const mediaKey = facebookMediaKey;

export function isIgnored(item) {
  try {
    const page = new URL(item.pageUrl);
    const media = new URL(item.url);
    if (/(^|\.)(facebook\.com|fb\.com)$/i.test(page.hostname)
      && /(^|\.)fbcdn\.net$/i.test(media.hostname)
      && (media.searchParams.has('bytestart') || media.searchParams.has('byteend'))) {
      return true;
    }
  } catch { /* ignore */ }
  return false;
}

export const ignoreItem = isIgnored;

export function updateExisting(existing, item, key) {
  if (existing.url !== item.url && key.startsWith('fbcdn:')) {
    existing.url = item.url;
    existing.host = item.host;
    return true;
  }
  return false;
}

export const updateItem = updateExisting;
