/**
 * src/social/ytb/popup.js — Logic hiển thị và định dạng YouTube trong Popup.
 */

export function isYouTubeTab(tabUrl) {
  return !!(tabUrl && /^https?:\/\/(www\.|m\.)?youtube\.com\//i.test(tabUrl));
}

export const matchTab = isYouTubeTab;

export function isYouTubeItem(item) {
  const host = item.host || '';
  return !!(
    item.ytMeta ||
    item.kind === 'yt-adaptive' ||
    /(^|\.)googlevideo\.com$/i.test(host) ||
    /(^|\.)youtube\.com$/i.test(host)
  );
}

function getYtScore(item) {
  if (!item) return 0;
  let score = 0;
  const meta = item.ytMeta || {};
  const url = item.url || '';
  if (meta.isAudio) return 100;
  // Link Android/Resolved đã được giải mã signature và không bị lỗi 403 được ưu tiên cao nhất
  if (meta.resolved || url.includes('c=ANDROID')) score += 20000000;
  if (item.kind === 'file') score += 5000000;
  const h = Number(meta.height) || Number(item.height) || 0;
  if (h > 0) score += h * 10000;
  const qMatch = String(meta.quality || '').match(/([0-9]{3,4})p/);
  if (qMatch) score += Number(qMatch[1]) * 10000;
  return score;
}

export function filterAndDedupe(items, isYtTab) {
  const byVideoId = new Map();
  const result = [];

  for (const item of items) {
    if (!isYouTubeItem(item)) {
      result.push(item);
      continue;
    }

    const videoId = (item.ytMeta && item.ytMeta.videoId) || item.code || null;
    if (!videoId) {
      result.push(item);
      continue;
    }

    const key = `ytb:${videoId}`;
    const existing = byVideoId.get(key);

    if (existing) {
      if (!Array.isArray(existing.variants)) {
        existing.variants = [{
          url: existing.url,
          label: existing.label,
          ytMeta: existing.ytMeta,
          score: getYtScore(existing),
        }];
      }

      if (!existing.variants.some((v) => v.url === item.url)) {
        if (item.url && !item.url.includes('sabr=1')) {
          existing.variants.push({
            url: item.url,
            label: item.label,
            ytMeta: item.ytMeta,
            score: getYtScore(item),
          });
        }
      }

      existing.variants = existing.variants.filter((v) => v && v.url && !v.url.includes('sabr=1'));
      existing.variants.sort((a, b) => b.score - a.score);

      const best = existing.variants[0];
      if (best) {
        existing.url = best.url;
        existing.label = best.label || existing.label;
        if (best.ytMeta) existing.ytMeta = best.ytMeta;
      }

      if (item.isCurrent) existing.isCurrent = true;
      if (!existing.title && item.title) existing.title = item.title;
      existing.foundAt = Math.max(existing.foundAt || 0, item.foundAt || 0);
    } else {
      if (!Array.isArray(item.variants)) {
        item.variants = [{
          url: item.url,
          label: item.label,
          ytMeta: item.ytMeta,
          score: getYtScore(item),
        }];
      }
      item.variants = item.variants.filter((v) => v && v.url && !v.url.includes('sabr=1'));
      byVideoId.set(key, item);
      result.push(item);
    }
  }

  return result;
}

export function parseItemInfo(item) {
  if (!isYouTubeItem(item)) return null;

  const title = (item.ytMeta && item.ytMeta.title) || item.pageTitle || 'YouTube Video';

  const rawVariants = Array.isArray(item.variants) && item.variants.length > 0
    ? item.variants
    : [{ url: item.url, label: item.label, ytMeta: item.ytMeta }];

  const variants = [];
  const seenUrls = new Set();
  for (const v of rawVariants) {
    if (!v || !v.url || seenUrls.has(v.url) || v.url.includes('sabr=1')) continue;
    seenUrls.add(v.url);
    const m = v.ytMeta || item.ytMeta || {};
    let q = m.quality;
    if (!q) {
      if (m.isAudio) q = 'Audio';
      else if (m.height > 0) q = `${m.height}p`;
      else if (item.kind === 'file') q = 'MP4';
      else q = 'Adaptive';
    } else if (/^[0-9]+$/.test(q)) {
      q += 'p';
    }
    if (m.isLive && !q.includes('Live')) q += ' • Live';

    variants.push({
      url: v.url,
      quality: q,
      score: v.score || getYtScore(v),
    });
  }

  variants.sort((a, b) => b.score - a.score);

  const quality = variants[0] ? variants[0].quality : 'HD';

  return {
    matched: true,
    platform: 'youtube',
    platformName: 'YouTube',
    title,
    quality,
    variants,
  };
}
