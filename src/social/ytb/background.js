/**
 * src/social/ytb/background.js — Xử lý YouTube trong Background Service Worker.
 */

export function formatFilename(url, index, meta) {
  const ytMeta = (meta && meta.ytMeta) || null;
  if (ytMeta && ytMeta.title) {
    const safe = ytMeta.title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim();
    const quality = ytMeta.quality || '';
    const isAudio = ytMeta.isAudio;
    const ext = isAudio ? '.webm' : '.mp4';
    return safe + (quality ? ' [' + quality + ']' : '') + ext;
  }
  return null;
}

export function youtubeMediaKey(item) {
  const vId = (item.ytMeta && item.ytMeta.videoId) || item.code;
  if (vId) {
    return 'ytb:' + vId;
  }
  return item.url;
}

export const mediaKey = youtubeMediaKey;

function getYtScore(item) {
  if (!item) return 0;
  let score = 0;
  const meta = item.ytMeta || {};
  if (meta.isAudio) return 100;
  if (item.kind === 'file') score += 5000000;
  const h = Number(meta.height) || Number(item.height) || 0;
  if (h > 0) score += h * 10000;
  const qMatch = String(meta.quality || '').match(/([0-9]{3,4})p/);
  if (qMatch) score += Number(qMatch[1]) * 10000;
  return score;
}

export function updateExisting(existing, item, key) {
  if (!key.startsWith('ytb:')) return false;

  if (!Array.isArray(existing.variants)) {
    existing.variants = [{
      url: existing.url,
      label: existing.label,
      ytMeta: existing.ytMeta,
      score: getYtScore(existing),
    }];
  }

  if (!existing.variants.some((v) => v.url === item.url)) {
    existing.variants.push({
      url: item.url,
      label: item.label,
      ytMeta: item.ytMeta,
      score: getYtScore(item),
    });
  }

  existing.variants.sort((a, b) => b.score - a.score);

  // Bản ưu tiên (progressive hoặc res cao nhất) làm mặc định
  const best = existing.variants[0];
  if (best && best.url !== existing.url) {
    existing.url = best.url;
    existing.label = best.label || existing.label;
    existing.kind = item.kind || existing.kind;
    existing.type = item.type || existing.type;
    if (best.ytMeta) existing.ytMeta = best.ytMeta;
  }

  if (item.isCurrent) existing.isCurrent = true;
  if (!existing.title && item.title) existing.title = item.title;
  existing.foundAt = Math.max(existing.foundAt || 0, item.foundAt || 0);

  if (Array.isArray(item.sources)) {
    existing.sources = [...new Set([...(existing.sources || []), ...item.sources])];
  }

  return true;
}

export const updateItem = updateExisting;

export function isYouTubeUrl(url) {
  try {
    return /(^|\.)googlevideo\.com$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

export async function probeYouTubeUrl(tabId, url, probeMediaUrlFn, log) {
  if (!isYouTubeUrl(url)) return { shouldDownload: true };

  const probe = await probeMediaUrlFn(tabId, url);
  if (probe && probe.ok === false) {
    const error =
      probe.status === 403
        ? 'HTTP 403 — YouTube từ chối link tải trực tiếp (n-sig/PO token). '
        + 'Bấm Play cho video chạy rồi Quét sâu lại để lấy link "live".'
        : `HTTP ${probe.status || '?'} — link bị từ chối.`;
    if (log) log.err(`Link YouTube bị từ chối (${error})`, url);
    return { shouldDownload: false, error };
  }

  return { shouldDownload: true };
}

export const probeDownload = probeYouTubeUrl;
