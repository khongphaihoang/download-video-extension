/**
 * src/social/tiktok/popup.js — Logic hiển thị và định dạng TikTok trong Popup.
 */

export function isTikTokTab(tabUrl) {
  try {
    return /(^|\.)tiktok\.com$/i.test(new URL(tabUrl).hostname);
  } catch {
    return false;
  }
}

export function isTikTokItem(item) {
  if (!item || !item.url) return false;
  try {
    const media = new URL(item.url);
    const host = media.hostname;
    // Bỏ qua ảnh đại diện hoặc thumbnail nhỏ, ảnh cover photomode
    if (/(\/tos-[^/]+-avt|~tplv-tiktok-shrink|\/avatar\/|~tplv-photomode|\.avif|\.webp|\.jpe?g|\.png)/i.test(item.url)) {
      return false;
    }
    // Bỏ qua API / telemetry
    if (/(^|\.)(mssdk|analytics|log|mon|webcast|snssdk)[^.]*\.tiktok\.com$/i.test(host)) {
      return false;
    }
    if (/\/(?:web\/(?:common|report|resource)|api\/|node-webapp\/|tiktok\/v1\/|community_notes\/|global-footer\/)/i.test(media.pathname)) {
      return false;
    }
    const isTtHost = /(^|\.)(tiktokcdn\.com|tiktokcdn-us\.com|byteoversea\.com|ibytedtos\.com|(v[0-9]+[^.]*|webapp[^.]*)\.tiktok\.com)$/i.test(host);
    const hasVideoSig = /\.(mp4|m4v|webm|mov)(\?|#|$)/i.test(item.url)
      || /\/(?:video\/tos|tos-[a-z0-9-]+|video\/mime|play|mp4|aweme\/v1\/play)/i.test(media.pathname)
      || /mime_type=video_mp4/i.test(item.url);
    return isTtHost && hasVideoSig;
  } catch {
    return false;
  }
}

export function matchVideoCode(href) {
  if (!href) return null;
  const match = href.match(/\/(?:video|v|photo|share\/video)\/([0-9]{15,25})/i);
  return match ? match[1] : null;
}

export function parseItemInfo(item) {
  if (!isTikTokItem(item)) return null;

  const code = item.code || matchVideoCode(item.pageUrl);
  let title = item.title || item.pageTitle || 'TikTok Video';
  title = title.replace(/\s*\|\s*TikTok.*$/i, '').trim();

  let quality = 'HD MP4';
  if (item.label && item.label !== 'TikTok Video' && item.label !== 'Đang phát') {
    quality = item.label.toUpperCase();
  }

  return {
    matched: true,
    platform: 'tiktok',
    platformName: 'TikTok',
    title,
    quality,
    code,
  };
}

export function filterAndDedupe(items, isTtTab) {
  // Lọc bỏ avatar/thumbnail nhỏ hoặc asset không phải video
  let list = items.filter((item) => {
    if (!item || !item.url) return false;
    if (/(\/tos-[^/]+-avt|~tplv-tiktok-shrink|\/avatar\/|~tplv-photomode|\.avif|\.webp|\.jpe?g|\.png)/i.test(item.url)) {
      return false;
    }
    if (/(^|\.)(mssdk|analytics|log|mon)[^.]*\.tiktok\.com/i.test(item.host || '')) {
      return false;
    }
    if (/\/(?:web\/(?:common|report|resource)|api\/|node-webapp\/|tiktok\/v1\/)/i.test(item.url)) {
      return false;
    }
    if (isTtTab && !isTikTokItem(item)) {
      return false;
    }
    return true;
  });

  if (isTtTab) {
    const HIGH_PRIO_SOURCES = ['inject:tt-single-post', 'inject:shortcode-resolved', 'inject:react-fiber', 'tt-json', 'inject:tt-response'];
    const byKey = new Map();
    list = list.filter((item) => {
      let key = item.code;
      if (!key) {
        try {
          key = new URL(item.url).pathname;
        } catch {
          key = item.url;
        }
      }
      const existing = byKey.get(key);
      if (existing) {
        const itemHasHighPrio = Array.isArray(item.sources) && item.sources.some((s) => HIGH_PRIO_SOURCES.includes(s));
        const existingHasHighPrio = Array.isArray(existing.sources) && existing.sources.some((s) => HIGH_PRIO_SOURCES.includes(s));

        if (item.isCurrent) existing.isCurrent = true;
        if (item.title && (!existing.title || itemHasHighPrio)) existing.title = item.title;
        if (item.code && !existing.code) existing.code = item.code;
        if (item.pageUrl && (!existing.pageUrl || itemHasHighPrio)) existing.pageUrl = item.pageUrl;

        // Ưu tiên URL từ nguồn xác thực post hoặc có isCurrent
        if ((itemHasHighPrio && !existingHasHighPrio) || (item.isCurrent && !existing.isCurrent) || ((item.foundAt || 0) > (existing.foundAt || 0))) {
          existing.url = item.url;
          existing.foundAt = item.foundAt;
        }
        return false;
      }
      byKey.set(key, item);
      return true;
    });
  }

  return list;
}

