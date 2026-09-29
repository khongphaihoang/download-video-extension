/**
 * src/social/ig/popup.js — Logic hiển thị & định dạng Instagram + Threads trong Popup.
 *
 * Threads là app của Meta nên dùng chung module này; chỉ khác host và dạng URL bài viết.
 */

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function isThreadsUrl(url) {
  return /(^|\.)(threads\.com|threads\.net)$/i.test(hostOf(url));
}

export function matchTab(tabUrl) {
  return /(^|\.)(instagram\.com|threads\.com|threads\.net)$/i.test(hostOf(tabUrl));
}

/**
 * `metaPage` = tab hiện tại là một trang Meta khác (Facebook) → không dùng heuristic
 * "URL chứa /o1/v/t16/" vì Facebook cũng phục vụ media qua đúng đường dẫn đó.
 */
export function isInstagramItem(item, metaPage = false) {
  const host = item.host || '';
  const pageUrl = item.pageUrl || '';
  const url = item.url || '';

  return (
    host.includes('instagram') ||
    pageUrl.includes('instagram.com') ||
    isThreadsUrl(pageUrl) ||
    (item.label && item.label.includes('Instagram')) ||
    (!metaPage && (url.includes('/o1/v/t16/') || url.includes('/v/t50.')))
  );
}

export function parseItemInfo(item, ctx) {
  const tabUrl = (ctx && ctx.tabUrl) || '';
  if (!isInstagramItem(item, matchTab(tabUrl))) return null;

  const pageUrl = item.pageUrl || '';
  const onThreads = isThreadsUrl(pageUrl) || isThreadsUrl(tabUrl);

  let shortcode = '';
  const matchReel = pageUrl.match(/(?:reel|reels|p)\/([A-Za-z0-9_-]+)/i)
    || pageUrl.match(/\/@[^/]+\/post\/([A-Za-z0-9_-]+)/i)
    || pageUrl.match(/\/t\/([A-Za-z0-9_-]+)/i);
  if (matchReel) {
    shortcode = matchReel[1];
  }

  let title = onThreads ? 'Threads Video' : 'Instagram Video';
  if (item.pageTitle) {
    const igTitleMatch = item.pageTitle.match(/^(.+?)\s+on Instagram:\s*["“](.+?)["”]?$/i);
    if (igTitleMatch) {
      title = `${igTitleMatch[1]}: ${igTitleMatch[2]}`;
    } else {
      title = item.pageTitle.replace(/\s*•\s*Instagram.*$/i, '').trim();
    }
  } else if (shortcode) {
    title = onThreads ? `Threads post [${shortcode}]` : `Instagram Reel [${shortcode}]`;
  }

  return {
    matched: true,
    // Giữ 'instagram' để popup dùng đúng icon/màu CSS đã có; nhãn hiển thị mới là Threads
    platform: 'instagram',
    platformName: onThreads ? 'Threads' : 'Instagram',
    isThreads: onThreads,
    title,
    quality: 'HD MP4',
    shortcode,
  };
}

/** Tên file ưu tiên: theo code bài viết (Instagram Reel / Threads post). */
export function formatFilename(item, info) {
  if (info && info.shortcode) {
    return `${info.isThreads ? 'threads' : 'instagram'}_${info.shortcode}.mp4`;
  }
  return null;
}

/** Fallback cuối: item Instagram/Threads không đọc được tên từ URL. */
export function fallbackFilename(item, info) {
  if (info && info.platform === 'instagram') {
    return info.isThreads ? 'threads_video.mp4' : 'instagram_video.mp4';
  }
  return null;
}
