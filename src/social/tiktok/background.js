/**
 * src/social/tiktok/background.js — Xử lý dữ liệu TikTok trong Background Service Worker.
 */

export function isTikTokUrl(url) {
  try {
    const host = new URL(url).hostname;
    return /(^|\.)(tiktokcdn\.com|tiktokcdn-us\.com|byteoversea\.com|ibytedtos\.com|(v[0-9]+[^.]*|webapp[^.]*)\.tiktok\.com)$/i.test(host);
  } catch {
    return false;
  }
}

export function tiktokMediaKey(item) {
  try {
    const media = new URL(item.url);
    if (/(^|\.)(tiktokcdn\.com|tiktokcdn-us\.com|byteoversea\.com|ibytedtos\.com|(v[0-9]+[^.]*|webapp[^.]*)\.tiktok\.com)$/i.test(media.hostname)) {
      if (item.code) return `tiktok:${item.code}:${media.pathname}`;
      return `tiktok:${media.pathname}`;
    }
  } catch { /* ignore */ }
  return item.code ? `tiktok:${item.code}` : item.url;
}

export const mediaKey = tiktokMediaKey;

export function isIgnored(item) {
  try {
    if (!item || !item.url) return true;
    const media = new URL(item.url);
    // Bỏ qua ảnh đại diện hoặc thumbnail nhỏ, ảnh cover photomode
    if (/(\/tos-[^/]+-avt|~tplv-tiktok-shrink|\/avatar\/|~tplv-photomode|\.avif|\.webp|\.jpe?g|\.png)/i.test(item.url)) {
      return true;
    }
    // Bỏ qua các API / telemetry của TikTok
    if (/(^|\.)(mssdk|analytics|log|mon|webcast|snssdk)[^.]*\.tiktok\.com/i.test(media.hostname)) {
      return true;
    }
    if (/\/(?:web\/(?:common|report|resource)|api\/|node-webapp\/|tiktok\/v1\/|community_notes\/|global-footer\/)/i.test(media.pathname)) {
      return true;
    }
    // Nếu là từ trang TikTok thì kiểm tra có phải video CDN hợp lệ không
    if (item.pageUrl && item.pageUrl.includes('tiktok.com')) {
      const isTtCdn = /(^|\.)(tiktokcdn\.com|tiktokcdn-us\.com|byteoversea\.com|ibytedtos\.com|(v[0-9]+[^.]*|webapp[^.]*)\.tiktok\.com)$/i.test(media.hostname);
      const hasVideoSig = /\.(mp4|m4v|webm|mov)(\?|#|$)/i.test(item.url)
        || /\/(?:video\/tos|tos-[a-z0-9-]+|video\/mime|play|mp4|aweme\/v1\/play)/i.test(media.pathname)
        || /mime_type=video_mp4/i.test(item.url);
      if (!isTtCdn || !hasVideoSig) return true;
    }
  } catch { /* ignore */ }
  return false;
}

export const ignoreItem = isIgnored;

export function updateExisting(existing, item, key) {
  let changed = false;

  const getRank = (it) => {
    const sources = it.sources || [];
    if (sources.some((s) => s.includes('download') || s === 'inject:tt-single-post' || s === 'tt-json')) return 3;
    if (sources.some((s) => s === 'inject:tt-response' || s === 'inject:shortcode-resolved' || s === 'inject:react-fiber' || s === 'inject:tt-id-match')) return 2;
    return 1;
  };

  const newRank = getRank(item);
  const oldRank = getRank(existing);

  if ((newRank > oldRank || (item.isCurrent && !existing.isCurrent)) && item.url !== existing.url) {
    existing.url = item.url;
    existing.host = item.host;
    existing.observedUrl = item.observedUrl || item.url;
    changed = true;
  }

  if (item.title && (!existing.title || (item.isCurrent && item.title !== existing.title))) {
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
  if (item.isCurrent && !existing.isCurrent) {
    existing.isCurrent = true;
    changed = true;
  }
  return changed;
}

export const updateItem = updateExisting;

export function formatFilename(url, index, meta) {
  if (meta) {
    const code = meta.code || (meta.pageUrl && meta.pageUrl.match(/\/(?:video|v|photo|share\/video)\/([0-9]{15,25})/i)?.[1]);
    let title = meta.title || meta.pageTitle || '';
    title = title.replace(/\s*\|\s*TikTok.*$/i, '').trim();
    title = title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim().slice(0, 80);
    if (title && code) return `tiktok_${title}_${code}.mp4`;
    if (title) return `tiktok_${title}.mp4`;
    if (code) return `tiktok_${code}.mp4`;
  }
  return null;
}

/**
 * TikTok Akamai CDN chặn tải trực tiếp ngoài trình duyệt (HTTP 403 Forbidden trả về file HTML).
 * Hàm này điều hướng tải trực tiếp qua session của Tab (content:download-blob) để lấy file video mp4 thật.
 */
export async function handleDownload(item, filename, tabId, log) {
  const url = typeof item === 'string' ? item : item.url;
  if (!isTikTokUrl(url)) return null;

  if (tabId != null) {
    if (log) log.info(`[TikTok] Bắt đầu tải video qua tab session (blob): ${filename}`);
    try {
      const res = await chrome.tabs.sendMessage(tabId, {
        type: 'content:download-blob',
        url,
        filename,
      });
      if (res && res.ok) {
        if (log) log.info(`[TikTok] Tải qua tab session thành công: ${filename}`);
        return { ok: true, id: 'tab-blob', url };
      }
      if (log) log.warn(`[TikTok] Tải qua tab session báo lỗi:`, res?.error);
    } catch (err) {
      if (log) log.err(`[TikTok] Gửi lệnh tải qua tab thất bại:`, err);
    }
  }
  return null;
}

