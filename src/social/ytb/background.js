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
    const host = new URL(url).hostname;
    return /(^|\.)(googlevideo\.com|youtube\.com|youtu\.be)$/i.test(host);
  } catch {
    return false;
  }
}

export function extractVideoId(item) {
  if (!item) return null;
  if (item.ytMeta && item.ytMeta.videoId) return item.ytMeta.videoId;
  if (item.code && /^[A-Za-z0-9_-]{11}$/.test(item.code)) return item.code;
  const matchId = (str) => {
    if (!str || typeof str !== 'string') return null;
    const m = str.match(/(?:watch\?v=|shorts\/|live\/|embed\/|\.be\/)([A-Za-z0-9_-]{11})/i);
    return m ? m[1] : null;
  };
  return matchId(item.pageUrl) || matchId(item.url) || null;
}

export function youtubeMediaKey(item) {
  const vId = extractVideoId(item);
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

/**
 * Lấy luồng video trực tiếp từ Innertube Android API (không bị chặn n-sig, tải thẳng HTTP 200).
 */
export async function fetchYouTubeAndroidStream(videoId) {
  if (!videoId || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) return null;

  const endpoint = 'https://www.youtube.com/youtubei/v1/player?app=android&prettyPrint=false';
  const clientVersion = '21.26.364';
  const ua = `com.google.android.youtube/${clientVersion} (Linux; U; Android 11) gzip`;

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': ua,
      'X-YouTube-Client-Name': '3',
      'X-YouTube-Client-Version': clientVersion,
      'Origin': 'https://www.youtube.com',
    },
    body: JSON.stringify({
      videoId,
      context: {
        client: {
          clientName: 'ANDROID',
          clientVersion,
          androidSdkVersion: 30,
          osName: 'Android',
          hl: 'en',
          gl: 'US',
        },
      },
    }),
  });

  if (!res.ok) {
    throw new Error(`Innertube HTTP ${res.status}`);
  }

  const data = await res.json();
  if (data.playabilityStatus && data.playabilityStatus.status !== 'OK') {
    const reason = data.playabilityStatus.reason || data.playabilityStatus.status;
    throw new Error(`Video không phát được (${reason})`);
  }

  const sd = data.streamingData || {};
  const formats = sd.formats || [];
  let best = null;
  for (const fmt of formats) {
    if (!fmt || !fmt.url) continue;
    if (fmt.mimeType && fmt.mimeType.startsWith('audio/')) continue;
    if (!best || (Number(fmt.height) || 0) > (Number(best.height) || 0)) {
      best = fmt;
    }
  }

  if (!best) {
    for (const fmt of sd.adaptiveFormats || []) {
      if (!fmt || !fmt.url) continue;
      if (fmt.mimeType && fmt.mimeType.startsWith('audio/')) continue;
      if (!best || (Number(fmt.height) || 0) > (Number(best.height) || 0)) {
        best = fmt;
      }
    }
  }

  if (!best) return null;

  const title = (data.videoDetails && data.videoDetails.title) || '';
  const author = (data.videoDetails && data.videoDetails.author) || '';

  return {
    url: best.url,
    itag: best.itag,
    quality: best.qualityLabel || `${best.height || 360}p`,
    width: best.width || 0,
    height: best.height || 0,
    mimeType: best.mimeType || 'video/mp4',
    contentLength: best.contentLength || '',
    title,
    author,
    videoId,
    isAdaptive: !formats.includes(best),
  };
}

export function updateExisting(existing, item, key) {
  if (!key.startsWith('ytb:')) return false;

  const videoId = key.replace('ytb:', '');

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

  // Tự động giải mã luồng Android trực tiếp nếu chưa giải mã
  if (videoId && !existing._androidResolving && (!existing.url || existing.url.includes('c=WEB'))) {
    existing._androidResolving = true;
    fetchYouTubeAndroidStream(videoId).then((stream) => {
      if (stream && stream.url) {
        existing.url = stream.url;
        existing.label = 'YT ' + stream.quality;
        existing.kind = 'file';
        existing.type = 'file';
        if (!existing.title && stream.title) existing.title = stream.title;

        const ytMeta = {
          height: stream.height,
          width: stream.width,
          label: 'YT ' + stream.quality,
          mimeType: stream.mimeType,
          quality: stream.quality,
          title: stream.title || existing.title,
          videoId: stream.videoId,
          contentLength: stream.contentLength,
          resolved: true,
        };
        existing.ytMeta = ytMeta;

        const variant = {
          url: stream.url,
          label: 'YT ' + stream.quality,
          ytMeta,
          score: 25000000,
        };

        if (!Array.isArray(existing.variants)) existing.variants = [];
        existing.variants = [variant, ...existing.variants.filter((v) => v.url !== stream.url)];
        existing.variants.sort((a, b) => b.score - a.score);
      }
    }).catch(() => {
      existing._androidResolving = false;
    });
  }

  return true;
}

export const updateItem = updateExisting;

export async function probeYouTubeUrl(tabId, url, probeMediaUrlFn, log) {
  // YouTube được xử lý chuyên sâu qua handleDownload, không chặn ở probe
  return { shouldDownload: true };
}

export const probeDownload = probeYouTubeUrl;

/**
 * Xử lý tải video YouTube trực tiếp: tự động giải mã link c=ANDROID nếu link web bị 403.
 */
export async function handleDownload(item, filename, tabId, log) {
  const rawUrl = typeof item === 'string' ? item : (item && item.url) || '';
  const isYt = isYouTubeUrl(rawUrl) || (item && (item.ytMeta || (item.sources && item.sources.some((s) => s.includes('yt')))));
  if (!isYt) return null;

  const videoId = extractVideoId(item);
  let downloadUrl = rawUrl;

  // Link c=WEB hoặc link chưa giải mã sẽ bị YouTube trả về 403 -> cần lấy link Android
  let needsResolve = !downloadUrl || downloadUrl.includes('c=WEB') || !downloadUrl.includes('c=ANDROID');

  if (!needsResolve && downloadUrl) {
    try {
      const probeRes = await fetch(downloadUrl, { method: 'HEAD' });
      if (!probeRes.ok && probeRes.status === 403) {
        needsResolve = true;
      }
    } catch {
      // Bỏ qua lỗi mạng
    }
  }

  if (needsResolve && videoId) {
    if (log) log.info(`[YouTube] Đang lấy luồng video trực tiếp từ Innertube cho videoId: ${videoId}`);
    try {
      const stream = await fetchYouTubeAndroidStream(videoId);
      if (stream && stream.url) {
        downloadUrl = stream.url;
        if (typeof item === 'object') {
          item.url = downloadUrl;
          if (stream.quality) item.label = `YT ${stream.quality}`;
          if (item.ytMeta) {
            item.ytMeta.resolved = true;
            item.ytMeta.quality = stream.quality;
          }
        }
        if (log) log.info(`[YouTube] Lấy luồng video thành công (${stream.quality}):`, downloadUrl.slice(0, 90));
      }
    } catch (err) {
      if (log) log.warn(`[YouTube] Lấy luồng từ Innertube thất bại:`, err.message);
    }
  }

  // Tải file trực tiếp qua chrome.downloads
  try {
    if (log) log.info(`[YouTube] Bắt đầu tải file: ${filename}`, downloadUrl.slice(0, 90));
    const id = await chrome.downloads.download({
      url: downloadUrl,
      filename,
      conflictAction: 'uniquify',
      saveAs: false,
    });
    if (log) log.info(`[YouTube] Bắt đầu tải download ID: ${id}`);
    return { ok: true, id, url: downloadUrl };
  } catch (err) {
    const errorMsg = String((err && err.message) || err);
    if (log) log.warn(`[YouTube] chrome.downloads thất bại (${errorMsg}), thử fallback tải qua tab blob...`);

    if (tabId != null) {
      try {
        const res = await chrome.tabs.sendMessage(tabId, {
          type: 'content:download-blob',
          url: downloadUrl,
          filename,
        });
        if (res && res.ok) {
          if (log) log.info(`[YouTube] Tải fallback qua tab blob thành công: ${filename}`);
          return { ok: true, id: 'tab-blob', url: downloadUrl };
        }
      } catch (fbErr) {
        if (log) log.err(`[YouTube] Tải fallback qua tab blob thất bại:`, fbErr);
      }
    }

    return { ok: false, url: downloadUrl, error: errorMsg };
  }
}
