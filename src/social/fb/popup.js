/**
 * src/social/fb/popup.js — Logic hiển thị và lọc dữ liệu Facebook trong Popup.
 */

export function isFacebookTab(tabUrl) {
  try {
    return /(^|\.)(facebook\.com|fb\.com)$/i.test(new URL(tabUrl).hostname);
  } catch {
    return false;
  }
}

export function isFacebookItem(item) {
  try {
    const pageHost = new URL(item.pageUrl || '').hostname;
    const mediaHost = item.host || (item.url ? new URL(item.url).hostname : '');
    return /(^|\.)(facebook\.com|fb\.com)$/i.test(pageHost) ||
      mediaHost.includes('fbcdn') ||
      mediaHost.includes('facebook');
  } catch {
    return false;
  }
}

export function matchVideoCode(href) {
  if (!href) return null;
  const match = href.match(/\/(?:videos|reel|reels)\/([0-9]+)/i)
    || href.match(/[?&]v=([0-9]+)/i)
    || href.match(/\/posts\/([0-9]+)/i)
    || href.match(/[?&]story_fbid=([0-9]+)/i)
    || href.match(/[?&]fbid=([0-9]+)/i);
  return match ? match[1] : null;
}

export function filterAndDedupe(items, isFbTab) {
  // Lọc bỏ static assets, manifests và segment stream byte range trên Facebook
  let list = items.filter((item) => {
    if (!item || !item.url) return false;
    if (/static[^.]*\.fbcdn\.net/i.test(item.url) || /\/btmanifest\//i.test(item.url) || /\/rsrc\.php\//i.test(item.url)) {
      return false;
    }
    if (!isFbTab || !isFacebookItem(item)) return true;
    try {
      const media = new URL(item.url);
      if (/(^|\.)fbcdn\.net$/i.test(media.hostname)) {
        if (media.searchParams.has('bytestart') || media.searchParams.has('byteend')) return false;
        const isVideo = /\.(mp4|m4v|webm|mkv|mov)(\?|#|$)/i.test(item.url) || /\/(?:o1\/v\/|v\/t[0-9])/i.test(media.pathname);
        if (!isVideo) return false;
      }
      return true;
    } catch {
      return true;
    }
  });

  // Gom theo CDN pathname để không bị trùng
  if (isFbTab) {
    const byPath = new Map();
    list = list.filter((item) => {
      if (!isFacebookItem(item)) return true;
      let media;
      try {
        media = new URL(item.url);
      } catch {
        return true;
      }
      if (!/(^|\.)fbcdn\.net$/i.test(media.hostname)) return true;
      const key = media.pathname;
      const existing = byPath.get(key);
      if (existing) {
        if ((item.foundAt || 0) > (existing.foundAt || 0)) {
          existing.url = item.url;
          existing.host = item.host;
          existing.foundAt = item.foundAt;
          if (item.pageUrl) existing.pageUrl = item.pageUrl;
          if (item.title) existing.title = item.title;
          if (item.label) existing.label = item.label;
          if (item.code) existing.code = item.code;
        }
        existing.isCurrent = !!(existing.isCurrent || item.isCurrent);
        return false;
      }
      byPath.set(key, item);
      return true;
    });
  }

  return list;
}

export function parseItemInfo(item) {
  const host = item.host || '';
  const pageUrl = item.pageUrl || '';

  if (host.includes('fbcdn') || host.includes('facebook') || pageUrl.includes('facebook.com')) {
    if (/static[^.]*\.fbcdn\.net/i.test(item.url) || /\/btmanifest\//i.test(item.url) || /\/rsrc\.php\//i.test(item.url)) {
      return null;
    }
    const isVideo = /\.(mp4|m4v|webm|mkv|mov)(\?|#|$)/i.test(item.url) || /\/(?:o1\/v\/|v\/t[0-9])/i.test(item.url);
    if (!isVideo && !item.label) return null;

    let quality = 'MP4';
    if (item.label === 'browser_native_hd_url') quality = 'HD';
    else if (item.label === 'browser_native_sd_url') quality = 'SD';
    else if (item.label && item.label.includes('hd')) quality = 'HD';
    else if (item.label && item.label.includes('sd')) quality = 'SD';
    else quality = item.label || 'MP4';

    let title = 'Facebook Video';
    if (item.pageTitle) {
      title = item.pageTitle.replace(/\s*\|\s*Facebook.*$/i, '').trim();
    }

    return {
      matched: true,
      platform: 'facebook',
      platformName: 'Facebook',
      title,
      quality,
    };
  }

  return null;
}
