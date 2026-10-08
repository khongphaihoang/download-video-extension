/**
 * src/social/ig/popup.js — Logic hiển thị và định dạng Instagram trong Popup.
 */

export function isInstagramItem(item, facebookPage = false) {
  const host = item.host || '';
  const pageUrl = item.pageUrl || '';
  const url = item.url || '';

  return (
    host.includes('instagram') ||
    pageUrl.includes('instagram.com') ||
    (item.label && item.label.includes('Instagram')) ||
    (!facebookPage && (url.includes('/o1/v/t16/') || url.includes('/v/t50.')))
  );
}

export function parseItemInfo(item, facebookPage = false) {
  if (!isInstagramItem(item, facebookPage)) return null;

  const pageUrl = item.pageUrl || '';
  let shortcode = '';
  const matchReel = pageUrl.match(/(?:reel|reels|p)\/([A-Za-z0-9_-]+)/i);
  if (matchReel) {
    shortcode = matchReel[1];
  }

  let title = 'Instagram Video';
  if (item.pageTitle) {
    const igTitleMatch = item.pageTitle.match(/^(.+?)\s+on Instagram:\s*["“](.+?)["”]?$/i);
    if (igTitleMatch) {
      title = `${igTitleMatch[1]}: ${igTitleMatch[2]}`;
    } else {
      title = item.pageTitle.replace(/\s*•\s*Instagram.*$/i, '').trim();
    }
  } else if (shortcode) {
    title = `Instagram Reel [${shortcode}]`;
  }

  return {
    matched: true,
    platform: 'instagram',
    platformName: 'Instagram',
    title,
    quality,
    shortcode,
    thumbnail: item.poster || null,
    author: 'Instagram',
  };
}
