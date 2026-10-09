/**
 * src/social/ig/popup.js — Logic hiển thị và định dạng Instagram trong Popup.
 */

export function isInstagramItem(item, facebookPage = false) {
  if (!item) return false;
  const host = item.host || '';
  const pageUrl = item.pageUrl || '';
  const url = item.url || '';
  const sources = Array.isArray(item.sources) ? item.sources.join(' ') : (item.source || '');
  const label = item.label || '';

  return (
    host.includes('instagram') ||
    pageUrl.includes('instagram.com') ||
    label.includes('Instagram') ||
    sources.includes('ig') ||
    (!facebookPage && (
      url.includes('/o1/v/t16/') ||
      url.includes('/v/t50.') ||
      url.includes('/v/t64.') ||
      url.includes('/o1/v/t24/') ||
      url.includes('/o1/v/t72/') ||
      url.includes('cdninstagram.com')
    ))
  );
}

export function matchVideoCode(url) {
  if (!url) return null;
  const match = url.match(/instagram\.com\/(?:reel|reels|p)\/([A-Za-z0-9_-]+)/i)
    || url.match(/\/(?:reel|reels|p)\/([A-Za-z0-9_-]+)/i);
  return match ? match[1] : null;
}

export function parseItemInfo(item, facebookPage = false) {
  if (!isInstagramItem(item, facebookPage)) return null;

  const pageUrl = item.pageUrl || '';
  let shortcode = item.code || '';
  if (!shortcode) {
    const match = matchVideoCode(pageUrl);
    if (match) shortcode = match;
  }

  let title = item.title || null;
  let author = item.author || null;

  if (item.pageTitle && !title) {
    const igTitleMatch = item.pageTitle.match(/^(.+?)\s+on Instagram:\s*["“](.+?)["”]?$/i);
    if (igTitleMatch) {
      if (!author) author = igTitleMatch[1];
      title = `${igTitleMatch[1]}: ${igTitleMatch[2]}`;
    } else {
      title = item.pageTitle.replace(/\s*•\s*Instagram.*$/i, '').trim();
    }
  }

  if (!title && shortcode) {
    title = `Instagram Reel [${shortcode}]`;
  }
  if (!title) {
    title = 'Instagram Video';
  }

  return {
    matched: true,
    platform: 'instagram',
    platformName: 'Instagram',
    title,
    quality: item.quality || null,
    shortcode,
    thumbnail: item.poster || item.thumbnail || null,
    author: author || 'Instagram',
  };
}
