/**
 * src/social/ig/background.js — Xử lý dữ liệu Instagram trong Background Service Worker.
 */

export function isInstagramUrl(url) {
  try {
    const host = new URL(url).hostname;
    return /(^|\.)(cdninstagram\.com|fbcdn\.net)$/i.test(host);
  } catch {
    return false;
  }
}

export function igMediaKey(item) {
  try {
    if (item.code) return `ig:${item.code}`;
    if (item.pageUrl) {
      const m = item.pageUrl.match(/instagram\.com\/(?:reel|reels|p)\/([A-Za-z0-9_-]+)/i);
      if (m) return `ig:${m[1]}`;
    }
    const media = new URL(item.url);
    if (/(^|\.)(cdninstagram\.com|fbcdn\.net)$/i.test(media.hostname)) {
      return `ig:${media.pathname}`;
    }
  } catch { /* ignore */ }
  return item.url;
}

export const mediaKey = igMediaKey;

export function isIgnored(item) {
  try {
    if (!item || !item.url) return true;
    const media = new URL(item.url);

    // Chặn ảnh Instagram: t51, dst-jpg, dst-webp, avatar, static
    if (/(\/v\/t51\.|\/t51\.2885|dst-jpg|dst-webp|\.avif|\.webp|\.jpe?g|\.png)/i.test(item.url)) {
      return true;
    }
    // Chặn static fbcdn hoặc rsrc
    if (/static[^.]*\.fbcdn\.net/i.test(media.hostname) || /\/rsrc\.php/i.test(media.pathname)) {
      return true;
    }
    // Chặn các API telemetry / logging của IG
    if (/\/(?:graphql|api\/v1|ajax|logging_client_events)/i.test(media.pathname) && !/\.(mp4|m4v)/i.test(item.url)) {
      return true;
    }
  } catch { /* ignore */ }
  return false;
}

export const ignoreItem = isIgnored;

export function updateExisting(existing, item, key) {
  let changed = false;
  if (item.title && (!existing.title || item.isCurrent)) {
    existing.title = item.title;
    changed = true;
  }
  if (item.code && !existing.code) {
    existing.code = item.code;
    changed = true;
  }
  if (item.pageUrl && (!existing.pageUrl || item.isCurrent)) {
    existing.pageUrl = item.pageUrl;
    changed = true;
  }
  if (item.poster && !existing.poster) {
    existing.poster = item.poster;
    changed = true;
  }
  if (item.isCurrent && !existing.isCurrent) {
    existing.isCurrent = true;
    changed = true;
  }

  const HIGH_PRIO_SOURCES = [
    'inject:ig-single-post',
    'inject:shortcode-resolved',
    'inject:shortcode-match',
    'inject:react-fiber',
    'ig-json',
    'inject:ig-response',
    'inject:ig-active-stream',
  ];
  const hasHighPrio = Array.isArray(item.sources) && item.sources.some((s) => HIGH_PRIO_SOURCES.includes(s));
  const existingHighPrio = Array.isArray(existing.sources) && existing.sources.some((s) => HIGH_PRIO_SOURCES.includes(s));

  if ((hasHighPrio && !existingHighPrio) || (item.isCurrent && item.url && item.url !== existing.url)) {
    existing.url = item.url;
    existing.observedUrl = item.observedUrl || item.url;
    if (item.title) existing.title = item.title;
    if (item.pageUrl) existing.pageUrl = item.pageUrl;
    existing.foundAt = item.foundAt || Date.now();
    changed = true;
  }
  return changed;
}

export const updateItem = updateExisting;

export function formatFilename(url, index, meta) {
  if (meta) {
    const code = meta.code || (meta.pageUrl && meta.pageUrl.match(/instagram\.com\/(?:reel|reels|p)\/([A-Za-z0-9_-]+)/i)?.[1]);
    let title = meta.title || meta.pageTitle || '';
    title = title.replace(/\s*•\s*Instagram.*$/i, '').replace(/\s+on Instagram:\s*["“].+?["”]?$/i, '').trim();
    title = title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim().slice(0, 80);
    if (title && code) return `instagram_${title}_${code}.mp4`;
    if (code) return `instagram_${code}.mp4`;
    if (title) return `instagram_${title}.mp4`;
  }
  return null;
}
