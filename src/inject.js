/**
 * inject.js — chạy trong MAIN world của trang (cùng ngữ cảnh với JS của trang).
 *
 * VÌ SAO CẦN FILE NÀY:
 * Facebook (và hầu hết site lớn) phát video qua MSE. Player dùng chính fetch()/XHR
 * của nó để tải từng segment, nên `initiatorType` trong Resource Timing là
 * 'fetch'/'xmlhttprequest' — KHÔNG BAO GIỜ là 'video'. Chỉ hook được fetch/XHR
 * mới bắt được luồng thật.
 *
 * MAIN world KHÔNG có API chrome.* → chỉ gửi kết quả qua window.postMessage.
 */

(() => {
  'use strict';

  if (window.__videoGrabberInjected) return;
  window.__videoGrabberInjected = true;

  const log = {
    info: (msg, ...args) =>
      console.log(
        `%c[VG:Inject]%c ${msg}`,
        'background:#9333ea;color:#fff;padding:2px 6px;border-radius:3px;font-weight:600;',
        'color:inherit;',
        ...args
      ),
    warn: (msg, ...args) =>
      console.warn(
        `%c[VG:Inject]%c ${msg}`,
        'background:#d97706;color:#fff;padding:2px 6px;border-radius:3px;font-weight:600;',
        'color:inherit;',
        ...args
      ),
  };

  log.info('Đã nạp vào MAIN world thành công trên trang:', location.hostname);

  // Expose global debug object in MAIN world (DevTools console)
  window.__VG_INJECT__ = {
    loadedAt: new Date().toISOString(),
    host: location.hostname,
    active: true,
  };

  // Thông báo cho content.js (ISOLATED world) biết inject.js đã chạy.
  // content.js không thể đọc window.__videoGrabberInjected vì khác world.
  window.postMessage({ __videoGrabber: true, url: '', via: '__ping' }, '*');

  const MEDIA_EXT_RE = /\.(mp4|m4v|m4s|webm|mkv|mov|avi|flv|m3u8|mpd|ts|f4v)(\?|#|$)/i;

  // CDN phát video phổ biến — nhận cả URL không có đuôi file.
  const MEDIA_HOST_RE =
    /(^|\.)(video[^.]*\.fbcdn\.net|fbcdn\.net|cdninstagram\.com|googlevideo\.com|video\.twimg\.com|vimeocdn\.com|tiktokcdn\.com|tiktokcdn-us\.com|akamaized\.net|cloudfront\.net|mux\.com|bunnycdn\.com|streamable\.com|dailymotion\.com|viddler\.com|jwplayer\.com|brightcove\.net|kaltura\.com)$/i;

  const BAD_EXT_RE = /\.(jpe?g|png|gif|webp|svg|css|js|mjs|woff2?|ttf|ico|map)(\?|#|$)/i;

  function isCandidate(url, via) {
    if (typeof url !== 'string' || url.length < 12) return false;
    if (!/^https?:\/\//i.test(url)) return false; // blob:/data: không dùng được
    if (BAD_EXT_RE.test(url)) return false;
    try {
      const host = new URL(url).hostname;
      // Instagram cũng dùng scontent cho video không có đuôi file.
      const instagramVideo = /(^|\.)instagram\.com$/i.test(location.hostname)
        && /(^|\.)(fbcdn\.net|cdninstagram\.com)$/i.test(host)
        && (['ig-response', 'ig-single-post', 'shortcode-match', 'shortcode-resolved',
          'react-fiber', 'media-src', 'video-src'].includes(via)
          || /\/(?:o1\/v\/t16|v\/t50\.)/i.test(url));
      const facebookVideo = /(^|\.)(facebook\.com|fb\.com)$/i.test(location.hostname)
        && /(^|\.)fbcdn\.net$/i.test(host)
        && ['fb-response', 'fb-single-post', 'fb-id-match', 'shortcode-resolved',
          'react-fiber'].includes(via);
      const facebookStreamSegment = /(^|\.)(facebook\.com|fb\.com)$/i.test(location.hostname)
        && /(^|\.)fbcdn\.net$/i.test(host)
        && (via === 'fetch' || via === 'xhr')
        && (new URL(url).searchParams.has('bytestart') || new URL(url).searchParams.has('byteend'));
      if (/^scontent/i.test(host) && !MEDIA_EXT_RE.test(url)
        && !instagramVideo && !facebookVideo && !facebookStreamSegment) return false;
      // googlevideo.com chỉ được phép khi đến từ YouTube parser
      // (hàm report bình thường sẽ bị chặn, chỉ reportYt mới gửi via yt-*)
      if (/(^|\.)googlevideo\.com$/i.test(host)) return false;
      if (MEDIA_EXT_RE.test(url)) return true;
      return MEDIA_HOST_RE.test(host);
    } catch {
      return false;
    }
  }

  let lastActiveVideoTime = 0;
  let lastActiveVideoEl = null;

  function report(url, via, meta) {
    try {
      // Link videoplayback mà chính player gọi có `n` đã hợp lệ → ghi lại để dùng.
      captureLiveMediaUrl(url);
      if (!isCandidate(url, via)) return;
      if ((via === 'fetch' || via === 'xhr') && Date.now() - lastActiveVideoTime < 3500
        && (!/(^|\.)(facebook\.com|fb\.com)$/i.test(location.hostname)
          || /[?&](?:bytestart|byteend)=/i.test(url))) {
        meta = meta || {};
        meta.isCurrent = true;
        meta.label = 'Đang phát';
      }
      log.info(`🎯 [${via}] Bắt được candidate URL:`, url.slice(0, 90));
      window.postMessage({ __videoGrabber: true, url: String(url), via, meta }, '*');
    } catch {
      /* ignore */
    }
  }

  // ---- YouTube: trích xuất format từ ytInitialPlayerResponse ----------------

  const YT_HOST_RE = /^(www\.|m\.)?youtube\.com$/i;

  function isYouTubePage() {
    try { return YT_HOST_RE.test(location.hostname); } catch { return false; }
  }

  /** Gửi URL YouTube kèm metadata — bypass bộ lọc googlevideo.com thông thường. */
  function reportYt(url, via, meta) {
    try {
      if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return;
      window.postMessage({ __videoGrabber: true, url: String(url), via, meta }, '*');
    } catch { /* ignore */ }
  }

  /** itag -> nhãn chất lượng, dùng cho link bắt từ request của player (không có
   *  `qualityLabel` như trong player response). */
  const YT_ITAG = {
    18: { q: '360p', h: 360 }, 22: { q: '720p', h: 720 }, 37: { q: '1080p', h: 1080 },
    59: { q: '480p', h: 480 },
    160: { q: '144p', h: 144 }, 133: { q: '240p', h: 240 }, 134: { q: '360p', h: 360 },
    135: { q: '480p', h: 480 }, 136: { q: '720p', h: 720 }, 137: { q: '1080p', h: 1080 },
    278: { q: '144p', h: 144 }, 242: { q: '240p', h: 240 }, 243: { q: '360p', h: 360 },
    244: { q: '480p', h: 480 }, 247: { q: '720p', h: 720 }, 248: { q: '1080p', h: 1080 },
    394: { q: '144p', h: 144 }, 395: { q: '240p', h: 240 }, 396: { q: '360p', h: 360 },
    397: { q: '480p', h: 480 }, 398: { q: '720p', h: 720 }, 399: { q: '1080p', h: 1080 },
    140: { q: 'audio', audio: true }, 141: { q: 'audio', audio: true },
    249: { q: 'audio', audio: true }, 250: { q: 'audio', audio: true }, 251: { q: 'audio', audio: true },
  };

  /** Tiêu để + link "live" tốt nhất đã bắt được của video đang mở. */
  let currentYtTitle = '';
  let liveYtEntry = null;
  const liveYtSeen = new Set();

  /**
   * Bắt URL media từ CHÍNH request của player.
   *
   * URL trong `ytInitialPlayerResponse` có tham số `n` ở dạng "thô" — player phải
   * giải mã rồi mới gọi. Dùng URL thô sẽ bị googlevideo trả **403** (Content-Type
   * text/plain), và Chrome lưu thành file `.txt` rác. Ngược lại, URL mà player
   * thật sự gọi đã hợp lệ nên dùng lại được.
   *
   * Bỏ `range`/`rn`/... để có link của cả file. Bỏ qua luồng SABR/UMP vì nội dung
   * trả về không phải file media thường.
   */
  function captureLiveMediaUrl(raw) {
    if (typeof raw !== 'string' || raw.length < 20) return;
    if (raw.indexOf('googlevideo.com/videoplayback') === -1) return;
    let u;
    try {
      u = new URL(raw, location.href);
    } catch {
      return;
    }
    if (!/(^|\.)googlevideo\.com$/i.test(u.hostname)) return;
    if (!/\/videoplayback$/i.test(u.pathname)) return;
    if (u.searchParams.has('sabr')) return; // SABR/UMP: không phải file media thường
    for (const p of ['range', 'rn', 'rbuf', 'sq', 'alr']) u.searchParams.delete(p);
    const url = u.toString();
    if (liveYtSeen.has(url)) return;
    liveYtSeen.add(url);

    const mime = (u.searchParams.get('mime') || '').toLowerCase();
    const isAudio = mime.startsWith('audio/');
    const isVideoOnly = u.searchParams.has('aitags');
    const itag = u.searchParams.get('itag') || '';
    const info = YT_ITAG[itag] || {};
    const via = isAudio || isVideoOnly ? 'yt-adaptive' : 'yt-progressive';
    const meta = {
      label: 'YT ' + (info.q || (itag ? 'itag ' + itag : 'live')) + ' (live)',
      quality: info.q || '',
      mimeType: mime || '',
      width: 0,
      height: info.h || 0,
      title: currentYtTitle,
      videoId: currentYtVideoId() || '',
      isAdaptive: via !== 'yt-progressive',
      isAudio,
      isLive: true,
    };
    log.info('🎯 [yt-live] Bắt được link player đang dùng:', url.slice(0, 90));
    reportYt(url, via, meta);

    // Ưu tiên bản progressive (có cả hình + tiếng) vì tải về là xem được ngay.
    const rank = via === 'yt-progressive' ? 100000 + (info.h || 0) : isAudio ? -1 : info.h || 0;
    const oldRank = liveYtEntry
      ? liveYtEntry.via === 'yt-progressive' ? 100000 + (liveYtEntry.meta.height || 0) : liveYtEntry.meta.isAudio ? -1 : liveYtEntry.meta.height || 0
      : -2;
    if (rank > oldRank) {
      liveYtEntry = { url, via, meta, pageId: ytVideoIdFromUrl(location.href) };
    }
  }

  // ---- YouTube: xác định "video đang phát" ----------------------------------

  /** Rút videoId từ URL YouTube (/watch?v=, /shorts/, /live/, /embed/, youtu.be). */
  function ytVideoIdFromUrl(raw) {
    try {
      const u = new URL(raw, location.href);
      const host = u.hostname;
      if (/^(www\.|m\.)?youtu\.be$/i.test(host)) {
        const id = u.pathname.split('/').filter(Boolean)[0] || '';
        return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
      }
      if (!/^(www\.|m\.|music\.)?youtube\.com$/i.test(host)) return null;
      const v = u.searchParams.get('v');
      if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return v;
      const match = u.pathname.match(/^\/(?:shorts|live|embed|v)\/([A-Za-z0-9_-]{11})(?:\/|$)/i);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  /** videoId của video đang mở: ưu tiên URL, fallback `ytInitialPlayerResponse`. */
  function currentYtVideoId() {
    const fromUrl = ytVideoIdFromUrl(location.href);
    if (fromUrl) return fromUrl;
    try {
      const details = window.ytInitialPlayerResponse && window.ytInitialPlayerResponse.videoDetails;
      return (details && details.videoId) || null;
    } catch {
      return null;
    }
  }

  /**
   * videoId -> format progressive tốt nhất (có cả hình + tiếng, tải trực tiếp được).
   *
   * YouTube phát qua MSE nên `video.src` luôn là `blob:` — không thể đọc URL thật
   * từ thẻ <video> như Instagram/Facebook. Bảng này là cầu nối giữa "video đang
   * phát" (xác định bằng videoId) và link thật lấy từ player response.
   * @type {Map<string, {url: string, meta: object}>}
   */
  const ytMap = new Map();

  /** Format tốt nhất ghi nhận gần nhất — dùng làm phương án dự phòng. */
  let lastYtEntry = null;

  /** Link googlevideo đã hết hạn chưa? (`expire` tính bằng giây, có thể thiếu/sai.) */
  function isExpiredYtUrl(url) {
    try {
      const raw = new URL(url).searchParams.get('expire');
      if (!raw) return false;
      const sec = Number(raw);
      if (!Number.isFinite(sec) || sec <= 0) return false;
      return sec * 1000 < Date.now();
    } catch {
      return false;
    }
  }

  /** Chọn format chất lượng cao nhất trong một danh sách (bỏ qua audio-only). */
  function pickBestFormat(list) {
    let best = null;
    for (const fmt of list || []) {
      if (!fmt || typeof fmt.url !== 'string') continue;
      if (fmt.mimeType && fmt.mimeType.startsWith('audio/')) continue;
      // Link đã hết hạn thì không xem/tải được → đừng chọn làm "Đang xem".
      if (isExpiredYtUrl(fmt.url)) continue;
      if (!best || (Number(fmt.height) || 0) > (Number(best.height) || 0)) best = fmt;
    }
    return best;
  }

  /**
   * Lưu format tốt nhất của một video để phục vụ nhãn "Đang xem".
   *
   * Ưu tiên progressive (có cả hình + tiếng, tải trực tiếp được). Nếu video chỉ
   * có adaptive thì vẫn lấy bản hình nét nhất — thà hiện được link cho người dùng
   * còn hơn để tab "Đang xem" trống. `via` được ghi lại để content.js phân loại
   * đúng: chỉ 'yt-progressive' mới cho kind 'file'.
   */
  function recordYtVideo(videoId, title, formats, adaptiveFormats) {
    let best = pickBestFormat(formats);
    let via = 'yt-progressive';
    if (!best) {
      best = pickBestFormat(adaptiveFormats);
      via = 'yt-adaptive';
    }
    if (!best) return;

    const entry = {
      url: best.url,
      via,
      meta: {
        label: 'YT ' + (best.qualityLabel || '?'),
        quality: best.qualityLabel || '',
        mimeType: best.mimeType || '',
        width: best.width || 0,
        height: best.height || 0,
        title: title || '',
        videoId: videoId || '',
        isAdaptive: via !== 'yt-progressive',
        isAudio: false,
      },
    };

    // Ghi theo videoId của player response. Chỉ khi response KHÔNG có videoId mới
    // mượn id trên URL — tránh việc YouTube prefetch sẵn player response của bài
    // kế tiếp (playlist/autoplay) rồi map nhầm nó cho video đang mở.
    const ids = new Set();
    if (videoId) ids.add(videoId);
    else if (currentYtVideoId()) ids.add(currentYtVideoId());
    if (!ids.size) ids.add('__current'); // không suy được id → vẫn giữ entry dự phòng
    for (const id of ids) ytMap.set(id, entry);
    lastYtEntry = entry;
  }

  let ytCurrentRetryTimer = null;

  /**
   * Báo item "Đang xem" cho video YouTube hiện tại.
   *
   * `via` bắt buộc là 'yt-progressive': content.js nhận URL googlevideo.com dựa
   * trên tiền tố `inject:yt-`, và chỉ 'yt-progressive' mới được gán kind 'file'
   * (link tải trực tiếp được). Dùng via khác sẽ khiến link bị xếp nhầm là adaptive.
   * @returns {boolean} true nếu đã báo được (ytMap đã có format của video này).
   */
  function reportYtCurrent() {
    const pageId = ytVideoIdFromUrl(location.href);
    // 1. Link bắt từ chính request của player: đây là link CÒN HIỆU LỰC thật sự,
    //    trong khi link trong player response thường bị 403 (n-sig chưa giải).
    if (liveYtEntry && liveYtEntry.pageId === pageId) {
      reportYt(liveYtEntry.url, liveYtEntry.via, { ...liveYtEntry.meta, isCurrent: true });
      return true;
    }
    // 2. Link từ player response: đúng nhưng có thể bị YouTube từ chối khi tải.
    const id = currentYtVideoId();
    let entry = id ? ytMap.get(id) : null;
    if (!entry && pageId) entry = lastYtEntry;
    if (!entry) return false;
    reportYt(entry.url, entry.via || 'yt-progressive', { ...entry.meta, isCurrent: true });
    return true;
  }

  /**
   * Báo "Đang xem" ngay; nếu player response tới muộn (video đã phát trước khi
   * có format) thì thử lại trong vài giây.
   */
  function ensureYtCurrentReport() {
    if (reportYtCurrent()) return;
    clearInterval(ytCurrentRetryTimer);
    let tries = 0;
    ytCurrentRetryTimer = setInterval(() => {
      if (reportYtCurrent() || ++tries > 20) clearInterval(ytCurrentRetryTimer);
    }, 250);
  }

  /** Trích xuất progressive + adaptive formats từ player response. */
  function extractYouTubeFormats(playerResponse) {
    if (!playerResponse || !playerResponse.streamingData) return;
    const sd = playerResponse.streamingData;
    const title = (playerResponse.videoDetails && playerResponse.videoDetails.title) || '';
    const videoId = (playerResponse.videoDetails && playerResponse.videoDetails.videoId) || '';
    currentYtTitle = title;

    // Progressive formats — video+audio kết hợp, TẢI TRỰC TIẾP ĐƯỢC
    const formats = sd.formats || [];
    log.info(`YouTube: phát hiện ${formats.length} progressive format (tải trực tiếp) & ${(sd.adaptiveFormats || []).length} adaptive format`);
    for (const fmt of formats) {
      if (!fmt.url) continue; // bỏ qua signatureCipher
      reportYt(fmt.url, 'yt-progressive', {
        label: 'YT ' + (fmt.qualityLabel || '?'),
        quality: fmt.qualityLabel || '',
        mimeType: fmt.mimeType || '',
        width: fmt.width || 0,
        height: fmt.height || 0,
        title: title,
        videoId: videoId,
      });
    }

    // Adaptive formats — video-only hoặc audio-only
    const adaptive = sd.adaptiveFormats || [];
    for (const fmt of adaptive) {
      if (!fmt.url) continue;
      const isAudio = fmt.mimeType && fmt.mimeType.startsWith('audio/');
      const lbl = isAudio
        ? 'YT Audio ' + (fmt.audioQuality || '').replace('AUDIO_QUALITY_', '').toLowerCase()
        : 'YT ' + (fmt.qualityLabel || '?') + ' (chỉ hình)';
      reportYt(fmt.url, 'yt-adaptive', {
        label: lbl,
        quality: fmt.qualityLabel || (isAudio ? 'audio' : ''),
        mimeType: fmt.mimeType || '',
        width: fmt.width || 0,
        height: fmt.height || 0,
        contentLength: fmt.contentLength || '',
        title: title,
        videoId: videoId,
        isAdaptive: true,
        isAudio: !!isAudio,
      });
    }

    // Ghi nhớ format tốt nhất của video này để gắn nhãn "Đang xem".
    recordYtVideo(videoId, title, formats, adaptive);

    // Player response này là của video đang mở trong tab → gắn nhãn "Đang xem"
    // ngay, không cần chờ sự kiện play (video có thể đang tạm dừng vì autoplay
    // bị chặn, nhưng đây vẫn là video người dùng đang xem).
    reportYtCurrent();
  }

  // Poll chờ ytInitialPlayerResponse được set (page load)
  if (isYouTubePage()) {
    let _ytAttempts = 0;
    const _ytPoll = setInterval(() => {
      if (window.ytInitialPlayerResponse) {
        clearInterval(_ytPoll);
        extractYouTubeFormats(window.ytInitialPlayerResponse);
      }
      if (++_ytAttempts > 60) clearInterval(_ytPoll); // tối đa 6 giây
    }, 100);

    // YouTube SPA đôi khi replaceState để thêm/bớt query → background coi như
    // điều hướng mới và xoá danh sách của tab. Tự khẳng định lại nhãn "Đang xem"
    // để item hiện tại luôn có mặt trong popup.
    setInterval(() => {
      try {
        reportYtCurrent();
      } catch {
        /* ignore */
      }
    }, 3000);
  }

  // ---- Facebook video URL keys — dùng để quét JSON response ---------------
  const FB_KEYS = [
    'browser_native_hd_url',
    'browser_native_sd_url',
    'playable_url_quality_hd',
    'playable_url',
    'hd_src',
    'sd_src',
    'progressive_url',
  ];

  /** Giải mã chuỗi escape trong JSON nhúng của Facebook (\u0025 -> %, \/ -> /). */
  function unescapeFbJson(s) {
    return s
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\\//g, '/')
      .replace(/\\\\/g, '\\');
  }

  // Ánh xạ theo nền tảng + ID để tránh trùng shortcode với video ID.
  const postMap = new Map();

  const postKey = (platform, codeOrId) => `${platform}:${codeOrId}`;

  function recordPostVideo(platform, codeOrId, url, extra) {
    if (!codeOrId || typeof url !== 'string') return;
    const cleanUrl = unescapeFbJson(url);
    if (!/^https?:\/\//i.test(cleanUrl)) return;
    const key = postKey(platform, codeOrId);
    const rank = (extra && extra.rank) || 0;
    const previous = postMap.get(key);
    if (previous && previous.rank > rank) return;
    postMap.set(key, {
      code: String(codeOrId),
      url: cleanUrl,
      rank,
      quality: (extra && extra.quality) || 'HD',
      title: (extra && extra.title) || null,
    });
    log.info(`🎯 [postMap] Đã lưu ánh xạ [${key}] ->`, cleanUrl.slice(0, 80));
  }

  function fbVideoIdFromUrl(raw) {
    try {
      const u = new URL(raw, location.href);
      if (!/(^|\.)(facebook\.com|fb\.com)$/i.test(u.hostname)) return null;
      const match = u.pathname.match(/\/(?:videos|reel)\/([0-9]+)(?:\/|$)/i);
      if (match) return match[1];
      if (/^\/watch\/?$/i.test(u.pathname)) {
        const id = u.searchParams.get('v');
        return id && /^[0-9]+$/.test(id) ? id : null;
      }
    } catch { /* ignore */ }
    return null;
  }

  function igCodeFromUrl(raw) {
    try {
      const u = new URL(raw, location.href);
      if (!/(^|\.)instagram\.com$/i.test(u.hostname)) return null;
      const match = u.pathname.match(/^\/(?:p|reel|reels)\/([A-Za-z0-9_-]+)(?:\/|$)/i);
      return match ? match[1] : null;
    } catch { return null; }
  }

  // Chỉ xét ID và URL thuộc cùng object JSON. Response Relay có thể gồm nhiều dòng JSON.
  function eachResponseObject(text, visit) {
    const payload = text.trim().replace(/^for\s*\(;;\);?\s*/, '');
    let roots;
    try {
      roots = [JSON.parse(payload)];
    } catch {
      roots = [];
      for (const line of payload.split(/\r?\n/)) {
        try { roots.push(JSON.parse(line.replace(/^for\s*\(;;\);?\s*/, ''))); }
        catch { /* response không phải JSON */ }
      }
    }
    const seen = new WeakSet();
    const stack = roots;
    while (stack.length) {
      const node = stack.pop();
      if (!node || typeof node !== 'object' || seen.has(node)) continue;
      seen.add(node);
      if (Array.isArray(node)) {
        for (const value of node) stack.push(value);
      } else {
        visit(node);
        for (const value of Object.values(node)) {
          if (value && typeof value === 'object') stack.push(value);
        }
      }
    }
  }

  /** Trích xuất video URL trực tiếp từ React Fiber của thẻ <video> (Player memory) */
  function extractVideoFromElement(videoEl) {
    if (!videoEl) return null;

    // 1. Direct src nếu có và không phải blob:
    const directSrc = videoEl.currentSrc || videoEl.src;
    if (directSrc && /^https?:\/\//i.test(directSrc) && !directSrc.startsWith('blob:')) {
      return { url: directSrc };
    }

    try {
      const keys = Object.keys(videoEl);
      const fiberKey = keys.find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
      if (!fiberKey || !videoEl[fiberKey]) return null;

      let fiber = videoEl[fiberKey];
      let depth = 0;
      while (fiber && depth < 35) {
        depth++;
        const p = fiber.memoizedProps;
        if (p) {
          // Instagram video_versions
          const vv = p.video_versions || p.videoVersions;
          if (Array.isArray(vv) && vv.length > 0) {
            const sorted = vv
              .slice()
              .sort((a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0));
            if (sorted[0] && sorted[0].url) {
              return { url: sorted[0].url, quality: sorted[0].width ? `${sorted[0].width}p` : 'HD' };
            }
          }

          // Facebook playable URLs
          const fbHd = p.browser_native_hd_url || p.playable_url_quality_hd || p.hd_src;
          if (typeof fbHd === 'string' && /^https?:\/\//i.test(fbHd)) return { url: fbHd, quality: 'HD' };
          const fbSd = p.browser_native_sd_url || p.playable_url || p.sd_src;
          if (typeof fbSd === 'string' && /^https?:\/\//i.test(fbSd)) return { url: fbSd, quality: 'SD' };

          // Props item / media / post / videoData
          const item = p.item || p.media || p.post || p.videoData;
          if (item) {
            const ivv = item.video_versions || item.videoVersions;
            if (Array.isArray(ivv) && ivv.length > 0) {
              const sorted = ivv
                .slice()
                .sort((a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0));
              if (sorted[0] && sorted[0].url) {
                return {
                  url: sorted[0].url,
                  code: item.code || item.shortcode || null,
                  title: item.caption?.text || item.title || null,
                };
              }
            }
            const ihd = item.browser_native_hd_url || item.playable_url_quality_hd || item.hd_src;
            if (typeof ihd === 'string' && /^https?:\/\//i.test(ihd)) return { url: ihd, quality: 'HD' };
            const isd = item.browser_native_sd_url || item.playable_url || item.sd_src;
            if (typeof isd === 'string' && /^https?:\/\//i.test(isd)) return { url: isd, quality: 'SD' };
          }
        }
        fiber = fiber.return;
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  function handleActiveVideoPlay(videoEl) {
    if (!videoEl) return;
    lastActiveVideoTime = Date.now();
    lastActiveVideoEl = videoEl;

    // YouTube: src là `blob:` nên React Fiber không giúp được — xác định video
    // đang phát theo videoId trên URL rồi lấy link từ ytMap.
    if (isYouTubePage()) {
      ensureYtCurrentReport();
      return;
    }

    // 1. Thử trích xuất từ React Fiber của thẻ <video>
    const fromFiber = extractVideoFromElement(videoEl);
    if (fromFiber && fromFiber.url) {
      log.info('🎯 [ActivePlay] Trích xuất thành công từ React Fiber:', fromFiber.url.slice(0, 80));
      report(fromFiber.url, 'react-fiber', {
        isCurrent: true,
        label: 'Đang phát',
        title: fromFiber.title || null,
        code: fromFiber.code || null,
      });
      return;
    }

    // 2. Tìm shortcode (Instagram) hoặc Video ID (Facebook) từ DOM container hoặc URL
    const container =
      videoEl.closest('article, [role="dialog"], [data-pagelet], div[role="feed"] > div') ||
      videoEl.parentElement;
    const link = container
      ? container.querySelector('a[href*="/reel/"], a[href*="/reels/"], a[href*="/p/"], a[href*="/videos/"]')
      : null;
    const href = (link && link.href) || location.href;

    const igCode = igCodeFromUrl(href);
    if (igCode) {
      const code = igCode;
      const entry = postMap.get(postKey('ig', code));
      if (entry && entry.url) {
        log.info(`🎯 [ActivePlay] Khớp chính xác Instagram Reel [${code}] từ postMap:`, entry.url.slice(0, 80));
        report(entry.url, 'shortcode-match', { isCurrent: true, label: 'Đang phát', code });
        return;
      }
    }

    const fbId = fbVideoIdFromUrl(href);
    if (fbId) {
      const vid = fbId;
      const entry = postMap.get(postKey('fb', vid));
      if (entry && entry.url) {
        log.info(`🎯 [ActivePlay] Khớp chính xác Facebook Video [${vid}] từ postMap:`, entry.url.slice(0, 80));
        report(entry.url, 'fb-id-match', { isCurrent: true, label: 'Đang phát' });
        return;
      }
    }
  }

  /** Quét text tìm Facebook video URL dựa trên các key đã biết. */
  function scanFbResponse(text) {
    if (!text || text.length < 80) return;
    if (
      !text.includes('browser_native') &&
      !text.includes('playable_url') &&
      !text.includes('hd_src') &&
      !text.includes('sd_src') &&
      !text.includes('progressive_url')
    ) {
      return;
    }

    eachResponseObject(text, (record) => {
      const id = record.video_id || record.id;
      if (typeof id !== 'string' || !/^[0-9]{10,25}$/.test(id)) return;
      for (const key of FB_KEYS) {
        if (typeof record[key] !== 'string') continue;
        const isHd = key.includes('hd');
        recordPostVideo('fb', id, record[key], {
          quality: isHd ? 'HD' : 'SD',
          rank: isHd ? 2 : 1,
        });
      }
    });

    // Giữ ứng viên từ response kể cả khi bài trong group không có video ID để ghép.
    for (const key of FB_KEYS) {
      const re = new RegExp('"' + key + '"\\s*:\\s*"([^"]{20,4000})"', 'g');
      let m;
      while ((m = re.exec(text)) !== null) {
        const url = unescapeFbJson(m[1]);
        if (/^https?:\/\//i.test(url)) report(url, 'fb-response');
      }
    }

    // Nếu ở trang xem video đơn lẻ (/watch, /reel/ID, /videos/ID)
    const fbId = fbVideoIdFromUrl(location.href);
    if (fbId) {
      const entry = postMap.get(postKey('fb', fbId));
      if (entry) {
        report(entry.url, 'fb-single-post', { isCurrent: true, label: 'Đang phát' });
      }
    }
  }

  /**
   * Kiểm tra URL có phải là request tới Facebook API không.
   * Chỉ quét response body cho các request này để tránh gây lag.
   */
  function isFbApiRequest(url) {
    if (typeof url !== 'string') return false;
    try {
      const u = new URL(url, location.href);
      const host = u.hostname;
      // Request tới Facebook domain
      if (
        host === 'www.facebook.com' ||
        host === 'web.facebook.com' ||
        host === 'm.facebook.com' ||
        host.endsWith('.facebook.com') ||
        host.endsWith('.fb.com')
      ) {
        return true;
      }
    } catch {
      /* ignore */
    }
    return false;
  }

  /**
   * Kiểm tra URL có phải là request tới Instagram API/GraphQL không.
   * Hỗ trợ cả relative URL (/graphql/query, /api/v1/...) nhờ location.href.
   */
  function isIgApiRequest(url) {
    if (typeof url !== 'string') return false;
    try {
      const u = new URL(url, location.href);
      const host = u.hostname;
      if (
        host === 'www.instagram.com' ||
        host === 'instagram.com' ||
        host.endsWith('.instagram.com')
      ) {
        return true;
      }
    } catch {
      /* ignore */
    }
    return false;
  }

  /**
   * Quét text response JSON của Instagram (GraphQL / REST API).
   */
  function scanIgResponse(text) {
    if (!text || text.length < 80) return;
    if (
      !text.includes('video_versions') &&
      !text.includes('video_url') &&
      !text.includes('playback_url') &&
      !text.includes('video_resources') &&
      !text.includes('/t16/') &&
      !text.includes('/t50.') &&
      !text.includes('BaseURL')
    ) {
      return;
    }

    // Chỉ ghép shortcode với URL nằm trong chính object media đó.
    eachResponseObject(text, (record) => {
      const code = record.code || record.shortcode;
      if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{5,35}$/.test(code)) return;
      const versions = record.video_versions || record.videoVersions;
      if (Array.isArray(versions)) {
        for (const version of versions) {
          if (!version || typeof version.url !== 'string') continue;
          const area = (Number(version.width) || 0) * (Number(version.height) || 0);
          recordPostVideo('ig', code, version.url, { rank: area + 1 });
        }
      }
      for (const key of ['video_url', 'playback_url']) {
        if (typeof record[key] === 'string') recordPostVideo('ig', code, record[key], { rank: 1 });
      }
    });

    // 2. Nếu ở trang bài viết đơn lẻ (/p/XYZ hoặc /reel/XYZ), report trực tiếp
    const code = igCodeFromUrl(location.href);
    if (code) {
      const entry = postMap.get(postKey('ig', code));
      if (entry) {
        report(entry.url, 'ig-single-post', { isCurrent: true, label: 'Đang phát' });
      }
    }
  }

  // ------------------------------------------------------------ hook fetch

  const nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = function (input, init) {
      try {
        let url = null;
        if (typeof input === 'string') url = input;
        else if (input && typeof input.url === 'string') url = input.url;
        if (url) report(url, 'fetch');
      } catch {
        /* ignore */
      }

      const promise = nativeFetch.apply(this, arguments);

      // Quét response body cho Facebook / Instagram API requests hoặc YouTube player API
      try {
        let reqUrl = null;
        if (typeof input === 'string') reqUrl = input;
        else if (input && typeof input.url === 'string') reqUrl = input.url;

        const isFb = reqUrl && isFbApiRequest(reqUrl);
        const isIg = reqUrl && isIgApiRequest(reqUrl);
        // YouTube SPA navigation gọi endpoint này khi mở video mới
        const isYtPlayer = reqUrl && /\/youtubei\/v1\/player/i.test(reqUrl);

        if (isFb || isIg || isYtPlayer) {
          promise.then((response) => {
            try {
              const cloned = response.clone();
              cloned.text().then((body) => {
                try {
                  if (isFb) scanFbResponse(body);
                  if (isIg) scanIgResponse(body);
                  if (isYtPlayer) {
                    try {
                      const json = JSON.parse(body);
                      extractYouTubeFormats(json);
                    } catch { /* JSON parse fail — bỏ qua */ }
                  }
                } catch { /* ignore */ }
              }).catch(() => { });
            } catch { /* ignore */ }
          }).catch(() => { });
        }
      } catch {
        /* ignore */
      }

      return promise;
    };
  }

  // -------------------------------------------------------------- hook XHR

  const nativeOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      if (url) report(String(url), 'xhr');
      const urlStr = String(url);
      // Đánh dấu XHR request tới Facebook / Instagram API để quét response body sau
      if (isFbApiRequest(urlStr)) {
        this.__vgFbApi = true;
      } else if (isIgApiRequest(urlStr)) {
        this.__vgIgApi = true;
      }
    } catch {
      /* ignore */
    }
    return nativeOpen.apply(this, arguments);
  };

  // Quét response body của XHR tới Facebook / Instagram API
  const nativeSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function () {
    if (this.__vgFbApi || this.__vgIgApi) {
      const isIg = this.__vgIgApi;
      this.addEventListener('load', function () {
        try {
          if (this.responseType === '' || this.responseType === 'text') {
            if (isIg) {
              scanIgResponse(this.responseText);
            } else {
              scanFbResponse(this.responseText);
            }
          }
        } catch {
          /* ignore */
        }
      });
    }
    return nativeSend.apply(this, arguments);
  };

  // ------------------------------------------- hook gán src cho <video>

  const videoSrcDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
  if (videoSrcDesc && videoSrcDesc.set) {
    Object.defineProperty(HTMLMediaElement.prototype, 'src', {
      configurable: true,
      enumerable: videoSrcDesc.enumerable,
      get: videoSrcDesc.get,
      set(value) {
        report(String(value), 'media-src');
        return videoSrcDesc.set.call(this, value);
      },
    });
  }

  const nativeSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    try {
      if (typeof name === 'string' && name.toLowerCase() === 'src' && this.tagName === 'VIDEO') {
        report(String(value), 'video-src');
      }
    } catch {
      /* ignore */
    }
    return nativeSetAttribute.apply(this, arguments);
  };

  // ------------------------------------------- hook play() của thẻ media
  const nativePlay = HTMLMediaElement.prototype.play;
  if (typeof nativePlay === 'function') {
    HTMLMediaElement.prototype.play = function () {
      try {
        if (this.tagName === 'VIDEO') {
          handleActiveVideoPlay(this);
        }
      } catch {
        /* ignore */
      }
      return nativePlay.apply(this, arguments);
    };
  }

  // Lắng nghe yêu cầu giải mã video từ content.js
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.__videoGrabberAction !== 'resolveVideo') return;
    const { code, title, pageUrl } = e.data;
    const platform = pageUrl && fbVideoIdFromUrl(pageUrl) === code ? 'fb'
      : pageUrl && igCodeFromUrl(pageUrl) === code ? 'ig' : null;
    const entry = platform && code ? postMap.get(postKey(platform, code)) : null;
    if (entry) {
      log.info(`🎯 [resolveVideo] Khớp postMap cho code [${code}]:`, entry.url.slice(0, 80));
      report(entry.url, 'shortcode-resolved', {
        isCurrent: true,
        label: 'Đang phát',
        code,
        title: title || entry.title,
        pageUrl,
      });
      return;
    }
    const activeVideo =
      lastActiveVideoEl ||
      document.querySelector('video:not([paused])') ||
      document.querySelector('video');
    if (activeVideo) {
      handleActiveVideoPlay(activeVideo);
    }
  });
})();
