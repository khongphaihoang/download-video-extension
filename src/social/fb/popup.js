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

export function getQualityLabel(url, label, height) {
  let quality = 'HD MP4';
  try {
    const u = new URL(url);
    const tag = (u.searchParams.get('tag') || '').toLowerCase();
    const tagMatch = tag.match(/([0-9]{3,4})p/);

    let efgTag = '';
    const efg = u.searchParams.get('efg');
    if (efg) {
      const decoded = atob(efg.replace(/_/g, '/').replace(/-/g, '+'));
      const parsed = JSON.parse(decoded);
      efgTag = String(parsed.vencode_tag || '').toLowerCase();
    }

    const efgMatch = efgTag.match(/(?:c[0-9]+\.)?([0-9]{3,4})/i) || efgTag.match(/([0-9]{3,4})p/i);

    if (tagMatch) {
      const p = tagMatch[1];
      quality = Number(p) >= 720 ? `HD ${p}p` : `SD ${p}p`;
    } else if (efgMatch) {
      const p = efgMatch[1];
      quality = Number(p) >= 720 ? `HD ${p}p` : `SD ${p}p`;
    } else if (tag.includes('hd') || efgTag.includes('hd') || (label && label.toLowerCase().includes('hd'))) {
      quality = 'HD';
    } else if (tag.includes('sd') || efgTag.includes('sd') || (label && label.toLowerCase().includes('sd'))) {
      quality = 'SD';
    } else if (height >= 720) {
      quality = `HD ${height}p`;
    } else if (height > 0) {
      quality = `SD ${height}p`;
    }
  } catch { /* ignore */ }
  return quality;
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

  // Gom theo định danh video (asset ID từ efg, code bài viết hoặc pathname)
  if (isFbTab) {
    const byKey = new Map();
    const result = [];

    for (const item of list) {
      if (!isFacebookItem(item)) {
        result.push(item);
        continue;
      }

      let media;
      try {
        media = new URL(item.url);
      } catch {
        result.push(item);
        continue;
      }

      if (!/(^|\.)fbcdn\.net$/i.test(media.hostname)) {
        result.push(item);
        continue;
      }

      const assetId = fbAssetIdFromUrl(item.url);
      const code = item.code || null;
      const pathKey = `path:${media.pathname}`;
      const assetKey = assetId ? `asset:${assetId}` : null;
      const codeKey = code ? `code:${code}` : null;

      // Tìm video đã tồn tại bằng bất kỳ key nào
      const existing = (assetKey && byKey.get(assetKey))
        || (codeKey && byKey.get(codeKey))
        || byKey.get(pathKey);

      if (existing) {
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
        if (best) {
          existing.url = best.url;
          existing.host = item.host;
          existing.label = best.label || existing.label;
          existing.kind = item.kind || existing.kind;
          existing.type = item.type || existing.type;
          if (best.bitrate) existing.bitrate = best.bitrate;
          if (best.height) existing.height = best.height;
        }

        if (item.isCurrent) existing.isCurrent = true;
        if (!existing.code && code) existing.code = code;
        if (!existing.title && item.title) existing.title = item.title;
        if (!existing.pageUrl && item.pageUrl) existing.pageUrl = item.pageUrl;
        existing.foundAt = Math.max(existing.foundAt || 0, item.foundAt || 0);

        if (Array.isArray(item.sources)) {
          existing.sources = [...new Set([...(existing.sources || []), ...item.sources])];
        }

        // Liên kết các key với existing để các luồng sau cùng khớp
        if (assetKey) byKey.set(assetKey, existing);
        if (existing.code) byKey.set(`code:${existing.code}`, existing);
        byKey.set(pathKey, existing);
      } else {
        if (!Array.isArray(item.variants)) {
          item.variants = [{
            url: item.url,
            label: item.label,
            bitrate: item.bitrate || 0,
            height: item.height || 0,
            score: getFacebookQualityScore(item),
          }];
        }
        if (assetKey) byKey.set(assetKey, item);
        if (codeKey) byKey.set(codeKey, item);
        byKey.set(pathKey, item);
        result.push(item);
      }
    }

    list = result;
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

    const assetId = fbAssetIdFromUrl(item.url);
    const videoCode = item.code || assetId || null;

    // Chuẩn bị danh sách các biến thể chất lượng
    const rawVariants = Array.isArray(item.variants) && item.variants.length > 0
      ? item.variants
      : [{ url: item.url, label: item.label, height: item.height, bitrate: item.bitrate }];

    const variants = [];
    const seenUrls = new Set();
    for (const v of rawVariants) {
      if (!v || !v.url || seenUrls.has(v.url)) continue;
      seenUrls.add(v.url);
      const q = getQualityLabel(v.url, v.label, v.height);
      variants.push({
        url: v.url,
        quality: q,
        score: v.score || getFacebookQualityScore(v),
      });
    }

    variants.sort((a, b) => b.score - a.score);

    const primaryQuality = variants[0] ? variants[0].quality : getQualityLabel(item.url, item.label, item.height);

    let title = 'Facebook Video';
    if (item.pageTitle && !/^facebook$/i.test(item.pageTitle.trim())) {
      title = item.pageTitle.replace(/\s*\|\s*Facebook.*$/i, '').trim();
    } else if (videoCode) {
      const isReel = (pageUrl && /\/reel\//i.test(pageUrl)) || (item.url && item.url.includes('xpv'));
      title = isReel ? `Facebook Reel [${videoCode}]` : `Facebook Video [${videoCode}]`;
    }

    return {
      matched: true,
      platform: 'facebook',
      platformName: 'Facebook',
      title: title || 'Facebook Video',
      quality: primaryQuality,
      videoCode,
      variants,
      thumbnail: item.poster || null,
      author: 'Facebook',
    };
  }

  return null;
}

