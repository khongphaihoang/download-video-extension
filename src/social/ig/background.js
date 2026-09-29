/**
 * src/social/ig/background.js — Xử lý dữ liệu Instagram/Threads trong Background.
 *
 * Threads dùng chung hạ tầng với Instagram nên nằm cùng module; chỉ khác dạng URL
 * bài viết (`/@user/post/CODE` thay vì `/reel/CODE`).
 */

export function formatFilename(url, index, meta) {
  const pageUrl = (meta && meta.pageUrl) || '';

  const ig = pageUrl.match(/instagram\.com\/(?:reel|reels|p)\/([A-Za-z0-9_-]+)/i);
  if (ig) return `instagram_${ig[1]}.mp4`;

  const th = pageUrl.match(/threads\.(?:com|net)\/@[^/]+\/post\/([A-Za-z0-9_-]+)/i);
  if (th) return `threads_${th[1]}.mp4`;

  return null;
}
