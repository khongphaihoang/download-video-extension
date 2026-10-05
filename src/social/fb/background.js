/**
 * src/social/fb/background.js — Xử lý dữ liệu Facebook trong Background Service Worker.
 */

export function fbAssetIdFromUrl(url) {
  if (typeof url !== 'string') return null;
  try {
    const u = new URL(url);
    const efg = u.searchParams.get('efg');
    if (efg) {
      const decoded = atob(efg.replace(/_/g, '/').replace(/-/g, '+'));
      const parsed = JSON.parse(decoded);
      if (parsed.xpv_asset_id) return String(parsed.xpv_asset_id);
      if (parsed.video_id) return String(parsed.video_id);
    }
  } catch { /* ignore */ }
  return null;
}

export function getFacebookQualityScore(item) {
  if (!item) return 0;
  let score = 0;
  const url = item.url || '';
  const label = (item.label || '').toLowerCase();

  try {
    const u = new URL(url);
    const bitrate = Number(u.searchParams.get('bitrate'));
    if (bitrate > 0) score += bitrate;

    const tag = (u.searchParams.get('tag') || '').toLowerCase();
    const tagMatch = tag.match(/([0-9]{3,4})p/);
    if (tagMatch) {
      score += Number(tagMatch[1]) * 10000;
    } else if (tag.includes('hd')) {
      score += 720 * 10000;
    } else if (tag.includes('sd')) {
      score += 360 * 10000;
    }

    const efg = u.searchParams.get('efg');
    if (efg) {
      const decoded = atob(efg.replace(/_/g, '/').replace(/-/g, '+'));
      const parsed = JSON.parse(decoded);
      const vtag = String(parsed.vencode_tag || '').toLowerCase();
      const vMatch = vtag.match(/(?:c[0-9]+\.)?([0-9]{3,4})/i) || vtag.match(/([0-9]{3,4})p/i);
      if (vMatch) {
        score += Number(vMatch[1]) * 10000;
      }
      if (vtag.includes('1080')) score += 1080 * 10000;
      else if (vtag.includes('720') || vtag.includes('hd')) score += 720 * 10000;
      else if (vtag.includes('sd') || vtag.includes('360')) score += 360 * 10000;
    }
  } catch { /* ignore */ }

  if (label.includes('hd')) score += 720 * 10000;
  if (label.includes('sd')) score += 360 * 10000;

  if (item.height) score += item.height * 10000;
  if (item.bitrate) score += item.bitrate;

  return score;
}

export function facebookMediaKey(item) {
  try {
    const media = new URL(item.url);
    if (!/(^|\.)fbcdn\.net$/i.test(media.hostname)) return item.url;

    const assetId = fbAssetIdFromUrl(item.url);
    if (assetId) return 'fbcdn:asset:' + assetId;
    if (item.code) return 'fbcdn:code:' + item.code;
    return 'fbcdn:path:' + media.pathname;
  } catch {
    return item.url;
  }
}

export const mediaKey = facebookMediaKey;

export function isIgnored(item) {
  try {
    const media = new URL(item.url);
    if (/(^|\.)fbcdn\.net$/i.test(media.hostname)
      && (media.searchParams.has('bytestart') || media.searchParams.has('byteend'))) {
      return true;
    }
  } catch { /* ignore */ }
  return false;
}

export const ignoreItem = isIgnored;

export function updateExisting(existing, item, key) {
  if (!key.startsWith('fbcdn:')) return false;

  // Đảm bảo mảng variants tồn tại
  if (!Array.isArray(existing.variants)) {
    existing.variants = [{
      url: existing.url,
      label: existing.label,
      bitrate: existing.bitrate || 0,
      height: existing.height || 0,
      score: getFacebookQualityScore(existing),
    }];
  }

  // Thêm item mới vào danh sách biến thể nếu chưa có URL
  const itemScore = getFacebookQualityScore(item);
  if (!existing.variants.some((v) => v.url === item.url)) {
    existing.variants.push({
      url: item.url,
      label: item.label,
      bitrate: item.bitrate || 0,
      height: item.height || 0,
      score: itemScore,
    });
  }

  // Sắp xếp các biến thể chất lượng từ cao xuống thấp
  existing.variants.sort((a, b) => b.score - a.score);

  // Bản nét nhất luôn làm URL mặc định
  const best = existing.variants[0];
  if (best && best.url !== existing.url) {
    existing.url = best.url;
    existing.host = item.host;
    existing.label = best.label || existing.label;
    existing.kind = item.kind || existing.kind;
    existing.type = item.type || existing.type;
    if (best.bitrate) existing.bitrate = best.bitrate;
    if (best.height) existing.height = best.height;
    if (item.width) existing.width = item.width;
    if (item.fps) existing.fps = item.fps;
    if (item.mimeType) existing.mimeType = item.mimeType;
  }

  // Kế thừa định danh và ngữ cảnh xem
  if (!existing.code && item.code) existing.code = item.code;
  if (!existing.title && item.title) existing.title = item.title;
  if (!existing.pageUrl && item.pageUrl) existing.pageUrl = item.pageUrl;
  if (!existing.sessionId && item.sessionId) existing.sessionId = item.sessionId;
  existing.foundAt = Math.max(existing.foundAt || 0, item.foundAt || 0);

  if (item.isCurrent) {
    existing.isCurrent = true;
  }

  if (Array.isArray(item.sources)) {
    existing.sources = [...new Set([...(existing.sources || []), ...item.sources])];
  }

  return true;
}

export const updateItem = updateExisting;

export function formatFilename(url, index, meta) {
  const assetId = fbAssetIdFromUrl(url);
  const code = (meta && meta.code) || assetId;
  if (code) {
    return `facebook_${code}.mp4`;
  }
  return null;
}

