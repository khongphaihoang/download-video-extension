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
