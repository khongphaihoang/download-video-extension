/**
 * src/social/fb/background.js — Xử lý dữ liệu Facebook trong Background Service Worker.
 */

/**
 * Khoá gộp trùng của Facebook: mọi URL trên cùng một media path (fbcdn) là
 * cùng một video, dù query/byte-range khác nhau.
 * Trả null nếu item không phải của Facebook → core tự dùng item.url.
 */
export function mediaKey(item) {
  try {
    const page = new URL(item.pageUrl);
    const media = new URL(item.url);
    if (!/(^|\.)(facebook\.com|fb\.com)$/i.test(page.hostname)
      || !/(^|\.)fbcdn\.net$/i.test(media.hostname)) return null;
    return 'fbcdn:' + media.pathname;
  } catch {
    return null;
  }
}

/** Segment byte-range của Facebook không phải file hoàn chỉnh → bỏ qua. */
export function ignoreItem(item) {
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

/** URL mới hơn (chưa hết hạn) của cùng media path thì thay thế URL cũ. */
export function updateItem(existing, item, key) {
  if (existing.url !== item.url && typeof key === 'string' && key.startsWith('fbcdn:')) {
    existing.url = item.url;
    existing.host = item.host;
    return true;
  }
  return false;
}
