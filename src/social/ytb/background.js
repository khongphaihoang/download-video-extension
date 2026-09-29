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

export async function probeDownload(tabId, url, ctx) {
  if (!isYouTubeUrl(url)) return null;   // không phải việc của YouTube → để module khác xử lý

  const probe = await ctx.probeMediaUrl(tabId, url);
  if (probe && probe.ok === false) {
    const error =
      probe.status === 403
        ? 'HTTP 403 — YouTube từ chối link tải trực tiếp (n-sig/PO token). '
        + 'Bấm Play cho video chạy rồi Quét sâu lại để lấy link "live".'
        : `HTTP ${probe.status || '?'} — link bị từ chối.`;
    if (ctx.log) ctx.log.err(`Link YouTube bị từ chối (${error})`, url);
    return { shouldDownload: false, error };
  }

  return { shouldDownload: true };
}
