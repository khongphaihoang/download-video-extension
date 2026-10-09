/**
 * src/popup.js — UI Controller for Video Grabber Chrome Extension.
 *
 * Modern, clean, minimal, and professional user interface.
 * Coordinates social format extraction, quality selection, video preview,
 * download handlers, and live diagnostics.
 */

import * as fb from './social/fb/popup.js';
import * as ig from './social/ig/popup.js';
import * as ytb from './social/ytb/popup.js';
import * as tiktok from './social/tiktok/popup.js';

const socialModules = [ytb, ig, fb, tiktok];

const $ = (sel) => document.querySelector(sel);

const el = {
  // Navigation & Header
  count: $('#count'),
  rescan: $('#rescan'),
  clear: $('#clear'),
  btnToggleDiag: $('#btnToggleDiag'),
  btnToggleTheme: $('#btnToggleTheme'),
  themeIcon: $('#themeIcon'),
  themePicker: $('#themePicker'),
  filters: $('#filters'),

  // Views & Content
  mainContainer: $('#mainContainer'),
  detectingState: $('#detectingState'),
  empty: $('#empty'),
  btnEmptyRescan: $('#btnEmptyRescan'),
  resultsContainer: $('#resultsContainer'),
  heroCardWrap: $('#heroCardWrap'),
  otherSection: $('#otherSection'),
  otherCountBadge: $('#otherCountBadge'),
  list: $('#list'),

  // Footer & Bulk Actions
  footerBar: $('#footerBar'),
  downloadAll: $('#downloadAll'),
  copyAll: $('#copyAll'),

  // Diagnostics & Logs
  diagWrap: $('#diagWrap'),
  connStatus: $('#connStatus'),
  statContentVal: $('#statContentVal'),
  statInjectVal: $('#statInjectVal'),
  diag: $('#diag'),
  diagLogs: $('#diagLogs'),
  btnReloadExt: $('#btnReloadExt'),
  btnCopyDiag: $('#btnCopyDiag'),

  // Toast / Status
  status: $('#status'),
};

let tabId = null;
let currentTabUrl = '';
let allItems = [];
let kindFilter = 'current';
let isDetecting = true;
let statusTimeout = null;

const KIND_ORDER = { file: 0, 'yt-adaptive': 1 };
const hqProgressHandlers = new Map();
let activePreviewUrl = null;
let hasPendingReload = false;

// Lưu trữ lựa chọn quality của từng video (key -> { variantUrl, quality, isHq, hqHeight })
const selectedQualityMap = new Map();

const MOCK_ITEMS = [
  {
    url: 'https://rr1---sn-oxunx-hp5e.googlevideo.com/videoplayback?id=mock_yt',
    pageUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    pageTitle: 'Rick Astley - Never Gonna Give You Up (Official Music Video)',
    isCurrent: true,
    kind: 'file',
    ytMeta: {
      videoId: 'dQw4w9WgXcQ',
      title: 'Rick Astley - Never Gonna Give You Up (Official Music Video)',
      author: 'Rick Astley',
      lengthSeconds: 212,
      quality: '1080p',
      mimeType: 'video/mp4',
    },
    variants: [
      { quality: '1080p', url: 'https://rr1---sn-oxunx-hp5e.googlevideo.com/1080', contentLength: 89400000 },
      { quality: '720p', url: 'https://rr1---sn-oxunx-hp5e.googlevideo.com/720', contentLength: 48200000 },
      { quality: '480p', url: 'https://rr1---sn-oxunx-hp5e.googlevideo.com/480', contentLength: 25100000 },
      { quality: 'Audio (MP3)', url: 'https://rr1---sn-oxunx-hp5e.googlevideo.com/audio', contentLength: 4500000 },
    ],
  },
  {
    url: 'https://v16-webapp-prime.tiktok.com/video/tos/mock_tt.mp4',
    pageUrl: 'https://www.tiktok.com/@nature_explorer/video/732918239120391203',
    pageTitle: 'Amazing cinematic nature scenery | TikTok',
    title: 'Amazing cinematic nature scenery',
    author: '@nature_explorer',
    duration: 45,
    quality: 'HD MP4',
    code: '732918239120391203',
    kind: 'file',
  },
];

async function getActiveTab() {
  if (typeof chrome !== 'undefined' && chrome.tabs && typeof chrome.tabs.query === 'function') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab || null;
  }
  return { id: 1, url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' };
}

// ---------------------------------------------------------------- Status Toast

function setStatus(text, tone, duration = 3500) {
  if (!el.status) return;
  clearTimeout(statusTimeout);

  if (!text) {
    el.status.classList.add('hidden');
    el.status.textContent = '';
    el.status.className = 'status-toast hidden';
    return;
  }

  el.status.textContent = text;
  el.status.className = 'status-toast' + (tone ? ' ' + tone : '');
  el.status.classList.remove('hidden');

  if (duration > 0) {
    statusTimeout = setTimeout(() => {
      el.status.classList.add('hidden');
    }, duration);
  }
}

// ---------------------------------------------------------------- Formatters

function formatDuration(sec) {
  if (!sec || isNaN(sec)) return null;
  const s = Math.floor(Number(sec));
  if (s <= 0) return null;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const remSec = s % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(remSec).padStart(2, '0')}`;
  }
  return `${m}:${String(remSec).padStart(2, '0')}`;
}

function formatFileSize(bytes) {
  if (!bytes || isNaN(bytes)) return null;
  const num = Number(bytes);
  if (num <= 0) return null;
  if (num >= 1024 * 1024 * 1024) {
    return `~${(num / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }
  if (num >= 1024 * 1024) {
    return `~${(num / (1024 * 1024)).toFixed(0)} MB`;
  }
  if (num >= 1024) {
    return `~${(num / 1024).toFixed(0)} KB`;
  }
  return `~${num} B`;
}

function cleanUserError(errText) {
  if (!errText) return 'Đã có lỗi xảy ra. Vui lòng thử lại.';
  const str = String(errText);
  if (/yt-dlp exited with code/i.test(str)) {
    return 'Không thể tải video bằng yt-dlp. Vui lòng thử chất lượng khác hoặc kiểm tra lại link.';
  }
  if (/native host/i.test(str) || /com\.videograbber/i.test(str)) {
    return 'Chưa kết nối được Native Host. Hãy chạy native-host/install.ps1 để cài đặt.';
  }
  if (/403|Forbidden/i.test(str)) {
    return 'Máy chủ từ chối kết nối trực tiếp (HTTP 403). Tiện ích đang thử phương thức tải phụ...';
  }
  if (/không phản hồi|timeout/i.test(str)) {
    return 'Trang web phản hồi chậm. Hãy bấm Quét sâu để thử lại.';
  }
  return str;
}

// ----------------------------------------------------------- Quality Detection

export function detectQuality(item) {
  if (!item) return 'HD MP4';

  if (item.ytMeta) {
    if (item.ytMeta.isAudio) return 'Audio (MP3/M4A)';
    if (item.ytMeta.quality) {
      let q = item.ytMeta.quality;
      if (/^[0-9]+$/.test(q)) q += 'p';
      if (item.ytMeta.isLive) q += ' • Live';
      return q;
    }
    if (item.ytMeta.isLive) return 'Live Stream';
  }

  const url = item.url || '';
  const label = (item.label || '').toLowerCase();

  if (item.kind === 'hls' || /\.m3u8(?:\?|#|$)/i.test(url)) return 'HLS Stream';
  if (item.kind === 'dash' || /\.mpd(?:\?|#|$)/i.test(url)) return 'DASH Stream';

  try {
    const u = new URL(url);
    const tag = (u.searchParams.get('tag') || '').toLowerCase();
    const tagMatch = tag.match(/([0-9]{3,4})p/);
    if (tagMatch) {
      const p = Number(tagMatch[1]);
      return p >= 720 ? `HD ${p}p` : `SD ${p}p`;
    }

    const efg = u.searchParams.get('efg');
    if (efg) {
      const decoded = atob(efg.replace(/_/g, '/').replace(/-/g, '+'));
      const parsed = JSON.parse(decoded);
      const vtag = String(parsed.vencode_tag || '').toLowerCase();
      const vMatch = vtag.match(/(?:c[0-9]+\.)?([0-9]{3,4})/i) || vtag.match(/([0-9]{3,4})p/i);
      if (vMatch) {
        const p = Number(vMatch[1]);
        return p >= 720 ? `HD ${p}p` : `SD ${p}p`;
      }
      if (vtag.includes('1080')) return 'Full HD 1080p';
      if (vtag.includes('720') || vtag.includes('hd')) return 'HD 720p';
      if (vtag.includes('sd') || vtag.includes('360')) return 'SD 360p';
    }
  } catch { /* ignore */ }

  const pMatch = url.match(/(?:_|-|\/|\.)(1080|720|480|360|240|144)p?(?:_|-|\.|$)/i);
  if (pMatch) {
    const p = Number(pMatch[1]);
    return p >= 720 ? `HD ${p}p` : `SD ${p}p`;
  }

  const h = Number(item.height) || 0;
  if (h >= 1080) return `Full HD ${h}p`;
  if (h >= 720) return `HD ${h}p`;
  if (h >= 480) return `SD ${h}p`;
  if (h > 0) return `SD ${h}p`;

  if (label.includes('1080')) return 'Full HD 1080p';
  if (label.includes('720') || label.includes('hd')) return 'HD';
  if (label.includes('sd') || label.includes('360')) return 'SD';

  if (item.mimeType) {
    if (item.mimeType.includes('audio')) return 'Audio';
    if (item.mimeType.includes('webm')) return 'WebM Video';
    if (item.mimeType.includes('mp4')) return 'HD MP4';
  }

  if (/\.webm(?:\?|#|$)/i.test(url)) return 'WebM Video';
  if (/\.mkv(?:\?|#|$)/i.test(url)) return 'MKV Video';

  return 'HD MP4';
}

function getFilename(item, info) {
  if (item.ytMeta && item.ytMeta.title) {
    const safeTitle = item.ytMeta.title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim();
    const ytQuality = item.ytMeta.quality || '';
    const ytExt = item.ytMeta.isAudio ? '.webm' : '.mp4';
    return safeTitle + (ytQuality ? ' [' + ytQuality + ']' : '') + ytExt;
  }
  if (info.shortcode) {
    return `instagram_${info.shortcode}.mp4`;
  }
  if (info.platform === 'facebook' && (info.videoCode || info.code)) {
    const code = info.videoCode || info.code;
    return `facebook_${code}.mp4`;
  }
  if (info.platform === 'tiktok') {
    const code = info.code || (item.pageUrl && item.pageUrl.match(/\/(?:video|v|photo|share\/video)\/([0-9]{15,25})/i)?.[1]);
    let title = info.title || item.title || item.pageTitle || 'tiktok_video';
    title = title.replace(/\s*\|\s*TikTok.*$/i, '').trim();
    title = title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim().slice(0, 60);
    return code ? `tiktok_${title}_${code}.mp4` : `tiktok_${title}.mp4`;
  }
  try {
    const u = new URL(item.url);
    const last = u.pathname.split('/').filter(Boolean).pop() || '';
    if (last && /\.[a-z0-9]{2,5}$/i.test(last)) return decodeURIComponent(last);
    if (info.platform === 'instagram') return 'instagram_video.mp4';
    if (info.platform === 'facebook') return 'facebook_video.mp4';
    if (info.platform === 'tiktok') return 'tiktok_video.mp4';
  } catch { /* ignore */ }
  return 'video.mp4';
}

function parseItemInfo(item) {
  const isFbTab = fb.isFacebookTab(currentTabUrl);
  let info = null;

  for (const module of socialModules) {
    if (typeof module.parseItemInfo !== 'function') continue;
    try {
      info = module.parseItemInfo(item, isFbTab);
    } catch (err) {
      console.warn('[Popup] Error in social module parseItemInfo:', err);
    }
    if (info) break;
  }

  if (!info) {
    info = {
      platform: 'generic',
      platformName: 'Video Web',
      title: item.title || item.pageTitle || 'Video',
      quality: detectQuality(item),
      thumbnail: item.poster || null,
      author: null,
      duration: item.duration || null,
    };
  }

  if (!info.quality || info.quality === 'MP4' || info.quality === 'progressive_url') {
    info.quality = detectQuality(item);
  }

  // Chuẩn hoá variants
  let variants = [];
  if (Array.isArray(info.variants) && info.variants.length > 0) {
    variants = info.variants;
  } else if (Array.isArray(item.variants) && item.variants.length > 0) {
    variants = item.variants.map((v) => ({
      url: v.url,
      quality: v.quality || detectQuality(v),
      score: v.score || 0,
      contentLength: v.contentLength || (v.ytMeta && v.ytMeta.contentLength) || null,
    }));
  } else {
    variants = [{
      url: item.url,
      quality: info.quality || detectQuality(item),
      score: 1,
      contentLength: item.contentLength || (item.ytMeta && item.ytMeta.contentLength) || null,
    }];
  }

  // Khử trùng variants
  const uniqueVariants = [];
  const seenUrls = new Set();
  for (const v of variants) {
    if (!v || !v.url || seenUrls.has(v.url)) continue;
    seenUrls.add(v.url);
    uniqueVariants.push({
      url: v.url,
      quality: v.quality || detectQuality(v),
      score: v.score || 0,
      contentLength: v.contentLength || (v.ytMeta && v.ytMeta.contentLength) || null,
    });
  }

  info.variants = uniqueVariants;
  if (uniqueVariants[0] && (!info.quality || info.quality === 'MP4')) {
    info.quality = uniqueVariants[0].quality;
  }

  // Fallback metadata
  if (!info.thumbnail && item.poster) info.thumbnail = item.poster;
  if (!info.author) info.author = (item.ytMeta && item.ytMeta.author) || item.author || null;
  if (!info.duration) info.duration = (item.ytMeta && item.ytMeta.lengthSeconds) || item.duration || null;
  if (!info.videoId) info.videoId = (item.ytMeta && item.ytMeta.videoId) || item.code || null;

  return { ...info, filename: getFilename(item, info) };
}

function getItemKey(item) {
  if (item.ytMeta && item.ytMeta.videoId) return 'ytb:' + item.ytMeta.videoId;
  if (item.code) return 'code:' + item.code;
  return item.url;
}

// ------------------------------------------------------------- Video Filtering

function matchYtVideoCode(url) {
  if (!url) return null;
  const m = url.match(/(?:watch\?v=|shorts\/|live\/|embed\/|\.be\/)([A-Za-z0-9_-]{11})/i);
  return m ? m[1] : null;
}

function isSingleVideoPage(url) {
  if (!url) return false;
  return /\/(?:reel|reels|watch|videos|p)\//i.test(url)
    || /[?&]v=[0-9]+/i.test(url)
    || /youtube\.com\/watch/i.test(url)
    || /youtube\.com\/shorts/i.test(url)
    || /instagram\.com\/(?:p|reel|reels)\//i.test(url)
    || /tiktok\.com\/.*\/video\//i.test(url)
    || /tiktok\.com\/.*\/v\//i.test(url)
    || /tiktok\.com\/.*\/photo\//i.test(url);
}

function visibleItems() {
  if (kindFilter === 'current') {
    const currentTabCode = matchYtVideoCode(currentTabUrl)
      || (fb.matchVideoCode && fb.matchVideoCode(currentTabUrl))
      || (tiktok.matchVideoCode && tiktok.matchVideoCode(currentTabUrl))
      || (ig.matchVideoCode && ig.matchVideoCode(currentTabUrl))
      || null;

    if (currentTabCode) {
      const matchedByCode = allItems.filter((i) =>
        (i.code && i.code === currentTabCode) ||
        (i.ytMeta && i.ytMeta.videoId === currentTabCode) ||
        (i.pageUrl && i.pageUrl.includes(currentTabCode)) ||
        (i.url && i.url.includes(currentTabCode))
      );
      if (matchedByCode.length > 0) {
        const currentInMatched = matchedByCode.filter((i) => i.isCurrent);
        return currentInMatched.length > 0 ? [currentInMatched[0]] : [matchedByCode[0]];
      }
    }

    const current = allItems.filter((i) => i.isCurrent);
    if (current.length > 0) return [current[0]];

    if (isSingleVideoPage(currentTabUrl) && allItems.length > 0) {
      const cleanTabUrl = currentTabUrl.split('?')[0];
      const matched = allItems.filter((i) => i.pageUrl && i.pageUrl.split('?')[0] === cleanTabUrl);
      if (matched.length > 0) return [matched[0]];
      return [allItems[0]];
    }

    if (allItems.length > 0) return [allItems[0]];
    return [];
  }

  return kindFilter === 'all' ? allItems : allItems.filter((i) => i.kind === kindFilter);
}

// ------------------------------------------------------ Preview Stream Fetcher

async function fetchPreviewFromTab(targetTabId, mediaUrl) {
  try {
    const res = await chrome.tabs.sendMessage(
      targetTabId,
      { type: 'content:preview-media', url: mediaUrl },
      { frameId: 0 }
    );
    if (res && res.ok && res.dataUrl) return res;
  } catch (err) {
    console.warn('[Popup] sendMessage preview-media không phản hồi, thử executeScript...', err);
  }

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: targetTabId },
      func: async (url) => {
        try {
          const isYt = /googlevideo\.com|youtube\.com/i.test(url);
          let res;
          if (isYt) {
            res = await fetch(url);
          } else {
            try {
              res = await fetch(url, { credentials: 'include' });
              if (!res.ok && res.status === 403) res = await fetch(url);
            } catch {
              res = await fetch(url);
            }
          }
          if (!res.ok) return { ok: false, error: 'HTTP ' + res.status };
          const ct = (res.headers.get('content-type') || '').toLowerCase();
          if (ct.includes('text/html')) return { ok: false, error: '403 HTML' };
          const blob = await res.blob();
          return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onloadend = () =>
              resolve({ ok: true, dataUrl: reader.result, mimeType: blob.type || 'video/mp4' });
            reader.onerror = () => resolve({ ok: false, error: 'FileReader error' });
            reader.readAsDataURL(blob);
          });
        } catch (e) {
          return { ok: false, error: String(e) };
        }
      },
      args: [mediaUrl],
    });
    if (results && results[0] && results[0].result && results[0].result.ok) {
      return results[0].result;
    }
  } catch (scriptErr) {
    console.warn('[Popup] executeScript preview thất bại:', scriptErr);
  }
  return null;
}

// ------------------------------------------------------------- Main Render Flow

function render() {
  const isAllFilter = kindFilter === 'all';
  const displayItems = isAllFilter ? allItems : visibleItems();
  const totalCount = allItems.length;

  // Cập nhật badges
  el.count.textContent = String(totalCount);
  el.count.classList.toggle('has-items', totalCount > 0);

  const allChip = el.filters.querySelector('[data-kind="all"]');
  if (allChip) {
    allChip.textContent = totalCount > 0 ? `Tất cả (${totalCount})` : 'Tất cả';
  }

  // 1. Loading / Detecting State
  if (isDetecting && totalCount === 0) {
    el.detectingState.classList.remove('hidden');
    el.empty.classList.add('hidden');
    el.resultsContainer.classList.add('hidden');
    if (el.footerBar) el.footerBar.classList.add('hidden');
    return;
  }
  el.detectingState.classList.add('hidden');

  // 2. Empty State
  if (totalCount === 0 || displayItems.length === 0) {
    el.empty.classList.remove('hidden');
    el.resultsContainer.classList.add('hidden');
    if (el.footerBar) el.footerBar.classList.add('hidden');
    return;
  }

  // 3. Results State
  el.empty.classList.add('hidden');
  el.resultsContainer.classList.remove('hidden');

  // Tách Current / Hero Video và Các video khác
  const heroItem = displayItems[0];
  // Ở tab "⚡ Đang xem" CHỈ hiển thị đúng video đang xem, không lẫn các video khác được prefetch ngầm
  const otherItems = isAllFilter
    ? displayItems.slice(1)
    : (kindFilter === 'current' ? [] : allItems.filter((it) => it !== heroItem));

  // Render Hero Card
  el.heroCardWrap.innerHTML = '';
  if (heroItem) {
    el.heroCardWrap.appendChild(renderHeroCard(heroItem));
  }

  // Render Other Items
  el.list.innerHTML = '';
  if (otherItems.length > 0) {
    el.otherSection.classList.remove('hidden');
    el.otherCountBadge.textContent = String(otherItems.length);
    const frag = document.createDocumentFragment();
    for (const item of otherItems) {
      frag.appendChild(renderOtherItem(item));
    }
    el.list.appendChild(frag);
  } else {
    el.otherSection.classList.add('hidden');
  }

  // Footer Bulk Actions
  if (el.footerBar) {
    const showFooter = isAllFilter || totalCount > 1;
    el.footerBar.classList.toggle('hidden', !showFooter);
    el.downloadAll.disabled = totalCount === 0;
  }
}

// ------------------------------------------------------------ Render Hero Card

function renderHeroCard(item) {
  const info = parseItemInfo(item);
  const itemKey = getItemKey(item);

  const card = document.createElement('div');
  card.className = 'hero-card';

  // Lấy hoặc khởi tạo selection quality
  let currentSelection = selectedQualityMap.get(itemKey);
  if (!currentSelection) {
    const initialVariant = info.variants && info.variants[0];
    currentSelection = {
      variantUrl: initialVariant ? initialVariant.url : item.url,
      quality: initialVariant ? initialVariant.quality : info.quality,
      isHq: false,
      hqHeight: null,
    };
    selectedQualityMap.set(itemKey, currentSelection);
  }

  // 1. Media Row (Thumbnail + Meta)
  const mediaRow = document.createElement('div');
  mediaRow.className = 'hero-media-row';

  // Thumbnail Container
  const thumbBox = document.createElement('div');
  thumbBox.className = 'hero-thumbnail-box';

  if (info.thumbnail) {
    const img = document.createElement('img');
    img.className = 'hero-thumbnail-img';
    img.src = info.thumbnail;
    img.alt = info.title;
    img.loading = 'lazy';
    img.onerror = () => {
      img.remove();
      thumbBox.appendChild(createThumbnailFallback(info.platform));
    };
    thumbBox.appendChild(img);
  } else {
    thumbBox.appendChild(createThumbnailFallback(info.platform));
  }

  // Duration Badge
  const durationText = formatDuration(info.duration);
  if (durationText || info.isLive) {
    const durationBadge = document.createElement('span');
    durationBadge.className = 'hero-duration-badge' + (info.isLive ? ' live' : '');
    durationBadge.textContent = info.isLive ? 'LIVE' : durationText;
    thumbBox.appendChild(durationBadge);
  }

  // Play Overlay
  const playOverlay = document.createElement('div');
  playOverlay.className = 'hero-play-overlay';
  playOverlay.innerHTML = `
    <div class="play-circle">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
        <polygon points="5 3 19 12 5 21 5 3"></polygon>
      </svg>
    </div>
  `;
  thumbBox.appendChild(playOverlay);

  // Info Column
  const infoCol = document.createElement('div');
  infoCol.className = 'hero-info-col';

  const titleEl = document.createElement('h3');
  titleEl.className = 'hero-title';
  titleEl.textContent = info.title;
  titleEl.title = info.title;

  const metaRow = document.createElement('div');
  metaRow.className = 'hero-meta-row';

  const platTag = document.createElement('span');
  platTag.className = `platform-tag ${info.platform}`;
  platTag.textContent = info.platformName;

  metaRow.appendChild(platTag);

  if (info.author) {
    const authorSpan = document.createElement('span');
    authorSpan.className = 'author-text';
    authorSpan.textContent = `• ${info.author}`;
    authorSpan.title = info.author;
    metaRow.appendChild(authorSpan);
  }

  if (item.isCurrent) {
    const hotBadge = document.createElement('span');
    hotBadge.className = 'hot-badge';
    hotBadge.textContent = '🔥 ĐANG XEM';
    metaRow.appendChild(hotBadge);
  }

  infoCol.append(titleEl, metaRow);
  mediaRow.append(thumbBox, infoCol);

  // 2. Quality Selection Section
  const qualitySec = document.createElement('div');
  qualitySec.className = 'quality-section';

  const qualityHeader = document.createElement('div');
  qualityHeader.className = 'quality-section-header';
  qualityHeader.innerHTML = `
    <span class="quality-section-title">Chất lượng tải về</span>
    <span style="font-size:10.5px;color:var(--text-muted);">${(info.variants || []).length} tuỳ chọn</span>
  `;

  const qualityGrid = document.createElement('div');
  qualityGrid.className = 'quality-grid';

  // Render direct variant pills
  (info.variants || []).forEach((v) => {
    const isSelected = !currentSelection.isHq && currentSelection.variantUrl === v.url;
    const qBtn = document.createElement('button');
    qBtn.className = 'quality-card-btn' + (isSelected ? ' active' : '');

    const isAudio = /audio/i.test(v.quality);
    const sizeStr = formatFileSize(v.contentLength);

    qBtn.innerHTML = `
      <div class="quality-main-label">
        <svg class="quality-check-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
        ${v.quality.replace(/\s*✓\s*$/, '')}
      </div>
      <div class="quality-sub-meta">
        ${isAudio ? 'Audio' : 'MP4'}${sizeStr ? ' • ' + sizeStr : ''}
      </div>
    `;

    qBtn.addEventListener('click', () => {
      currentSelection.isHq = false;
      currentSelection.variantUrl = v.url;
      currentSelection.quality = v.quality;
      currentSelection.hqHeight = null;
      selectedQualityMap.set(itemKey, currentSelection);

      // Cập nhật UI selection & CTA button
      qualitySec.querySelectorAll('.quality-card-btn').forEach((b) => b.classList.remove('active'));
      qBtn.classList.add('active');
      updateCtaLabel();
    });

    qualityGrid.appendChild(qBtn);
  });

  qualitySec.append(qualityHeader, qualityGrid);

  // 3. YouTube HQ Native Host Options (nếu là YouTube)
  let hqSelect = null;
  if (info.platform === 'youtube' && info.videoId) {
    const hqBox = document.createElement('div');
    hqBox.className = 'hq-box';

    const hqLabel = document.createElement('span');
    hqLabel.className = 'hq-label';
    hqLabel.innerHTML = '⭐ Ghép HQ (yt-dlp):';

    hqSelect = document.createElement('select');
    hqSelect.className = 'hq-select';
    [
      ['', 'Chọn độ phân giải cao…'],
      ['2160', '4K Ultra HD (2160p)'],
      ['1440', '2K Quad HD (1440p)'],
      ['1080', 'Full HD 1080p'],
      ['720', 'HD 720p'],
    ].forEach(([val, txt]) => {
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = txt;
      hqSelect.appendChild(opt);
    });

    hqSelect.addEventListener('change', () => {
      if (hqSelect.value) {
        currentSelection.isHq = true;
        currentSelection.hqHeight = Number(hqSelect.value);
        currentSelection.quality = `${hqSelect.value}p (yt-dlp)`;
        selectedQualityMap.set(itemKey, currentSelection);
        qualitySec.querySelectorAll('.quality-card-btn').forEach((b) => b.classList.remove('active'));
      } else {
        currentSelection.isHq = false;
        currentSelection.hqHeight = null;
        if (info.variants && info.variants[0]) {
          currentSelection.variantUrl = info.variants[0].url;
          currentSelection.quality = info.variants[0].quality;
        }
      }
      updateCtaLabel();
    });

    hqBox.append(hqLabel, hqSelect);
    qualitySec.appendChild(hqBox);
  }

  // 4. File name indicator
  const fileNameRow = document.createElement('div');
  fileNameRow.className = 'file-name-preview';
  fileNameRow.innerHTML = `
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
      <polyline points="14 2 14 8 20 8"></polyline>
    </svg>
    <span>${info.filename}</span>
  `;

  // 5. Preview Player Container
  const playerWrap = document.createElement('div');
  playerWrap.className = 'preview-player-wrap';

  // 6. Action Row: Main CTA + Secondary buttons
  const ctaGroup = document.createElement('div');
  ctaGroup.className = 'cta-group';

  const btnCta = document.createElement('button');
  btnCta.className = 'btn-cta-main';

  function updateCtaLabel() {
    const qShort = currentSelection.quality.replace(/^(HD|SD)\s*/i, '').replace(/\s*✓\s*$/, '').trim();
    btnCta.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
        <polyline points="7 10 12 15 17 10"></polyline>
        <line x1="12" y1="15" x2="12" y2="3"></line>
      </svg>
      Tải xuống (${qShort || 'Video'})
    `;
  }
  updateCtaLabel();

  // Xử lý sự kiện click nút Tải
  btnCta.addEventListener('click', async () => {
    if (btnCta.disabled) return;

    if (currentSelection.isHq && info.videoId) {
      // Tải HQ qua yt-dlp Native Host
      const watchUrl = `https://www.youtube.com/watch?v=${info.videoId}`;
      await runHqDownload(watchUrl, currentSelection.hqHeight, btnCta);
    } else {
      // Tải trực tiếp
      const targetItem = {
        ...item,
        url: currentSelection.variantUrl || item.url,
        label: currentSelection.quality || item.label,
      };
      await runDownload([targetItem], btnCta);
    }
  });

  const secondaryRow = document.createElement('div');
  secondaryRow.className = 'secondary-actions-row';

  const btnPreview = document.createElement('button');
  btnPreview.className = 'btn-secondary-action';
  btnPreview.innerHTML = `
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
      <circle cx="12" cy="12" r="3"></circle>
    </svg>
    Xem thử
  `;

  let isPreviewing = false;
  let previewBlobUrl = null;

  async function togglePreview() {
    isPreviewing = !isPreviewing;
    if (isPreviewing) {
      activePreviewUrl = currentSelection.variantUrl || item.url;
      playerWrap.innerHTML = '';
      btnPreview.classList.add('active');
      btnPreview.innerHTML = '✖ Đóng xem';
      playerWrap.classList.add('show');

      const isTikTok = info.platform === 'tiktok' || (tiktok.isTikTokItem && tiktok.isTikTokItem(item));
      if (isTikTok && tabId != null) {
        playerWrap.innerHTML = '<div class="preview-loading"><span class="spinner"></span> Đang nạp video xem thử từ TikTok…</div>';
        const res = await fetchPreviewFromTab(tabId, activePreviewUrl);
        if (!isPreviewing) return;
        if (res && res.ok && res.dataUrl) {
          const [hdr, b64] = res.dataUrl.split(',');
          const mime = hdr.match(/:(.*?);/)?.[1] || res.mimeType || 'video/mp4';
          const bin = atob(b64);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          const blob = new Blob([bytes], { type: mime });
          previewBlobUrl = URL.createObjectURL(blob);

          playerWrap.innerHTML = '';
          const video = document.createElement('video');
          video.src = previewBlobUrl;
          video.controls = true;
          video.autoplay = true;
          video.playsInline = true;
          playerWrap.appendChild(video);
          return;
        }
      }

      if (!isPreviewing) return;
      playerWrap.innerHTML = '';
      const video = document.createElement('video');
      video.src = activePreviewUrl;
      video.controls = true;
      video.autoplay = true;
      video.muted = true;
      video.playsInline = true;
      video.onerror = () => {
        if (!isPreviewing) return;
        playerWrap.innerHTML = `<div class="preview-error">
          ${isTikTok
            ? 'Không thể xem thử trực tiếp do hạn chế phiên TikTok. Bạn hãy bấm nút <b>Tải xuống</b> để lưu video.'
            : 'Không phát được bản xem thử. Link có thể đã hết hạn hoặc chỉ có luồng hình.'}
        </div>`;
      };
      playerWrap.appendChild(video);
    } else {
      activePreviewUrl = null;
      if (previewBlobUrl) {
        URL.revokeObjectURL(previewBlobUrl);
        previewBlobUrl = null;
      }
      playerWrap.innerHTML = '';
      playerWrap.classList.remove('show');
      btnPreview.classList.remove('active');
      btnPreview.innerHTML = `
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
          <circle cx="12" cy="12" r="3"></circle>
        </svg>
        Xem thử
      `;
      if (hasPendingReload) {
        hasPendingReload = false;
        load();
      }
    }
  }

  btnPreview.addEventListener('click', togglePreview);
  thumbBox.addEventListener('click', togglePreview);

  const btnCopy = document.createElement('button');
  btnCopy.className = 'btn-secondary-action';
  btnCopy.innerHTML = `
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
    </svg>
    Copy link
  `;
  btnCopy.addEventListener('click', async () => {
    const urlToCopy = currentSelection.variantUrl || item.url;
    await navigator.clipboard.writeText(urlToCopy);
    btnCopy.textContent = '✓ Đã copy';
    setTimeout(() => {
      btnCopy.innerHTML = `
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
        </svg>
        Copy link
      `;
    }, 1500);
  });

  secondaryRow.append(btnPreview, btnCopy);
  ctaGroup.append(btnCta, secondaryRow);

  card.append(mediaRow, qualitySec, fileNameRow, playerWrap, ctaGroup);
  return card;
}

function createThumbnailFallback(platform) {
  const div = document.createElement('div');
  div.className = 'hero-thumbnail-fallback';
  div.textContent =
    platform === 'youtube' ? '▶️' :
    platform === 'facebook' ? '🔵' :
    platform === 'tiktok' ? '🎵' :
    platform === 'instagram' ? '📸' : '🎬';
  return div;
}

// ------------------------------------------------------------ Render Other Item

function renderOtherItem(item) {
  const info = parseItemInfo(item);
  const li = document.createElement('li');
  li.className = 'other-item';

  const icon = document.createElement('div');
  icon.className = 'other-item-icon';
  icon.textContent =
    info.platform === 'youtube' ? '▶️' :
    info.platform === 'facebook' ? '🔵' :
    info.platform === 'tiktok' ? '🎵' :
    info.platform === 'instagram' ? '📸' : '🎬';

  const main = document.createElement('div');
  main.className = 'other-item-main';

  const title = document.createElement('div');
  title.className = 'other-item-title';
  title.textContent = info.title;
  title.title = info.title;

  const sub = document.createElement('div');
  sub.className = 'other-item-sub';
  sub.textContent = `${info.platformName} • ${info.quality}`;

  main.append(title, sub);

  const actions = document.createElement('div');
  actions.className = 'other-item-actions';

  const dlBtn = document.createElement('button');
  dlBtn.className = 'btn-mini primary';
  dlBtn.textContent = '⬇️ Tải';
  dlBtn.addEventListener('click', () => runDownload([item], dlBtn));

  const cpBtn = document.createElement('button');
  cpBtn.className = 'btn-mini';
  cpBtn.textContent = 'Copy';
  cpBtn.addEventListener('click', async () => {
    await navigator.clipboard.writeText(item.url);
    cpBtn.textContent = '✓';
    setTimeout(() => (cpBtn.textContent = 'Copy'), 1200);
  });

  actions.append(dlBtn, cpBtn);
  li.append(icon, main, actions);
  return li;
}

// -------------------------------------------------------- Download Operations

async function runDownload(items, button) {
  if (button) {
    button.disabled = true;
    button.classList.add('is-downloading');
    button.innerHTML = '<span class="spinner"></span> Đang gửi lệnh tải…';
  }
  setStatus(`Đang xử lý ${items.length} file tải về…`, 'ok', 3000);

  const res = await chrome.runtime.sendMessage({
    type: 'popup:download',
    tabId,
    items: items.map((i) => ({
      url: i.url,
      code: i.code || null,
      title: i.title || null,
      ytMeta: i.ytMeta || null,
      pageUrl: i.pageUrl || null,
      pageTitle: i.pageTitle || null,
    })),
  });

  const ids = ((res && res.results) || []).map((r) => r.id).filter(Boolean);
  const failed = ((res && res.results) || []).filter((r) => !r.ok);

  if (button) {
    button.disabled = false;
    button.classList.remove('is-downloading');
  }

  if (!ids.length) {
    if (button) {
      button.classList.add('is-error');
      button.innerHTML = '⚠️ Lỗi tải — Thử lại';
    }
    const errMsg = failed[0] ? cleanUserError(failed[0].error) : 'Không gửi được lệnh tải';
    setStatus(errMsg, 'err', 5000);
    return;
  }

  if (button) {
    button.classList.add('is-success');
    button.innerHTML = '✓ Đã gửi tải xuống!';
    setTimeout(() => {
      button.classList.remove('is-success');
      render();
    }, 2500);
  }

  if (ids.every((id) => id === 'tab-blob')) {
    setStatus('Đã tải video thành công vào thư mục Downloads!', 'ok');
    return;
  }

  setStatus(`Đang tải ${ids.length} file vào thư mục Downloads…`, 'ok', 3000);

  setTimeout(async () => {
    try {
      const numericIds = ids.filter((id) => typeof id === 'number');
      if (numericIds.length > 0) {
        const found = await chrome.downloads.search({ id: numericIds });
        const bad = found.filter((f) => {
          if (f.state === 'interrupted') return true;
          if (f.state === 'complete' && f.mime && f.mime.includes('text/html')) return true;
          if (f.state === 'complete' && f.fileSize > 0 && f.fileSize < 3000 && f.filename && !f.filename.endsWith('.html')) return true;
          return false;
        });

        if (bad.length) {
          for (const b of bad) {
            if (b.state === 'complete') {
              chrome.downloads.removeFile(b.id).catch(() => {});
              chrome.downloads.erase({ id: b.id }).catch(() => {});
            }
          }
          setStatus('Máy chủ chặn tải trực tiếp. Tiện ích đang thử phương thức tải phụ qua tab…', 'warn', 4000);

          let anyFbOk = false;
          for (const item of items) {
            try {
              const fbRes = await chrome.tabs.sendMessage(tabId, {
                type: 'content:download-blob',
                url: item.url,
                filename: getFilename(item, parseItemInfo(item) || {}),
              });
              if (fbRes && fbRes.ok) anyFbOk = true;
            } catch { /* ignore */ }
          }
          if (anyFbOk) {
            setStatus('Đã tải video thành công vào thư mục Downloads!', 'ok');
          } else {
            setStatus('Tải trực tiếp thất bại. Link có thể đã hết hạn, hãy bấm Quét sâu lại.', 'err', 5000);
          }
          return;
        }
      }
      setStatus('Đang lưu video vào thư mục Downloads.', 'ok');
    } catch {
      setStatus('Đã gửi lệnh tải tới trình duyệt.', 'ok');
    }
  }, 2500);
}

async function runHqDownload(watchUrl, height, button) {
  if (button) {
    button.disabled = true;
    button.classList.add('is-downloading');
    button.innerHTML = '<span class="spinner"></span> Đang kiểm tra yt-dlp…';
  }
  setStatus('Đang kiểm tra Native Host…', 'ok', 2000);

  const ping = await chrome.runtime.sendMessage({ type: 'popup:hq-ping' });
  if (!ping || !ping.ok) {
    if (button) {
      button.disabled = false;
      button.classList.remove('is-downloading');
      button.classList.add('is-error');
      button.innerHTML = '⚠️ Lỗi kết nối';
    }
    setStatus(cleanUserError((ping && ping.error) || 'Không liên lạc được Native Host'), 'err', 5000);
    return;
  }

  if (!ping.ytdlp) {
    if (button) {
      button.disabled = false;
      button.classList.remove('is-downloading');
      button.classList.add('is-error');
      button.innerHTML = '⚠️ Thiếu yt-dlp';
    }
    setStatus('Chưa cài yt-dlp trên máy: winget install yt-dlp.yt-dlp', 'err', 6000);
    return;
  }

  if (!ping.ffmpeg) {
    if (button) {
      button.disabled = false;
      button.classList.remove('is-downloading');
      button.classList.add('is-error');
      button.innerHTML = '⚠️ Thiếu ffmpeg';
    }
    setStatus('Chưa cài ffmpeg trên máy: winget install Gyan.FFmpeg', 'err', 6000);
    return;
  }

  if (button) {
    button.innerHTML = '<span class="spinner"></span> Đang tải 0%…';
  }
  setStatus('Đang tải và ghép video bằng yt-dlp + ffmpeg…', 'ok', 0);

  hqProgressHandlers.set(watchUrl, (m) => {
    if (m.percent != null && button) {
      button.innerHTML = `<span class="spinner"></span> Đang tải ${Math.round(m.percent)}%`;
    }
    const percentStr = m.percent != null ? m.percent.toFixed(1) + '%' : '';
    const speedStr = m.speed || '';
    const etaStr = m.eta ? '· còn ' + m.eta : '';
    setStatus(`yt-dlp: ${percentStr} ${speedStr} ${etaStr}`, 'ok', 0);
  });

  const res = await chrome.runtime.sendMessage({ type: 'popup:hq-download', url: watchUrl, height });
  hqProgressHandlers.delete(watchUrl);

  if (button) {
    button.disabled = false;
    button.classList.remove('is-downloading');
  }

  if (res && res.ok) {
    if (button) {
      button.classList.add('is-success');
      button.innerHTML = '✓ Đã lưu video!';
      setTimeout(() => {
        button.classList.remove('is-success');
        render();
      }, 3000);
    }
    setStatus('Đã lưu file: ' + res.file, 'ok', 5000);
  } else {
    if (button) {
      button.classList.add('is-error');
      button.innerHTML = '⚠️ Lỗi tải — Thử lại';
    }
    setStatus(cleanUserError((res && res.error) || 'Quá trình tải thất bại'), 'err', 5000);
  }
}

// ------------------------------------------------------------- Load & Lifecycle

let lastRenderedTabUrl = '';

async function load() {
  const tab = await getActiveTab();
  if (!tab) return;
  tabId = tab.id;
  currentTabUrl = tab.url || '';

  const urlChanged = currentTabUrl !== lastRenderedTabUrl;
  if (urlChanged) {
    activePreviewUrl = null;
    selectedQualityMap.clear();
  } else if (activePreviewUrl != null) {
    hasPendingReload = true;
    return;
  }
  lastRenderedTabUrl = currentTabUrl;

  const key = 'tab:' + tabId;
  let store = {};
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.session) {
    store = await chrome.storage.session.get(key);
  } else {
    store = { [key]: MOCK_ITEMS };
  }
  const isFbTab = fb.isFacebookTab(currentTabUrl);
  const isTtTab = tiktok.isTikTokTab(currentTabUrl);
  const isYouTube = socialModules.some((module) =>
    typeof module.matchTab === 'function'
      ? module.matchTab(currentTabUrl)
      : typeof module.isYouTubeTab === 'function' && module.isYouTubeTab(currentTabUrl)
  );

  const currentTabCode = matchYtVideoCode(currentTabUrl)
    || (fb.matchVideoCode && fb.matchVideoCode(currentTabUrl))
    || (tiktok.matchVideoCode && tiktok.matchVideoCode(currentTabUrl))
    || null;

  const rawList = (store[key] || []).sort((a, b) => {
    if (currentTabCode) {
      const aMatch = (a.code && a.code === currentTabCode)
        || (a.ytMeta && a.ytMeta.videoId === currentTabCode)
        || (a.pageUrl && a.pageUrl.includes(currentTabCode))
        || (a.url && a.url.includes(currentTabCode));
      const bMatch = (b.code && b.code === currentTabCode)
        || (b.ytMeta && b.ytMeta.videoId === currentTabCode)
        || (b.pageUrl && b.pageUrl.includes(currentTabCode))
        || (b.url && b.url.includes(currentTabCode));
      if (aMatch && !bMatch) return -1;
      if (!aMatch && bMatch) return 1;
    }
    if (a.isCurrent && !b.isCurrent) return -1;
    if (!a.isCurrent && b.isCurrent) return 1;
    const timeDiff = (b.foundAt || 0) - (a.foundAt || 0);
    if (timeDiff !== 0) return timeDiff;
    return (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9);
  });

  let filtered = rawList;
  if (typeof ytb.filterAndDedupe === 'function') {
    filtered = ytb.filterAndDedupe(filtered, isYouTube);
  }
  if (typeof fb.filterAndDedupe === 'function') {
    filtered = fb.filterAndDedupe(filtered, isFbTab);
  }
  if (typeof tiktok.filterAndDedupe === 'function') {
    filtered = tiktok.filterAndDedupe(filtered, isTtTab);
  }

  allItems = filtered;
  isDetecting = false;
  render();
  await runDiag();
}

// ----------------------------------------------------------------- Diagnostics

async function runDiag() {
  const lines = [];

  let tab = null;
  try {
    if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.get) {
      tab = await chrome.tabs.get(tabId);
    }
  } catch { /* ignore */ }

  const manifestVer = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest)
    ? chrome.runtime.getManifest().version
    : '0.3.32';

  lines.push(`Manifest   : v${manifestVer}`);
  lines.push(`Tab        : ${tab && tab.url ? tab.url.slice(0, 90) : (currentTabUrl ? currentTabUrl.slice(0, 90) : '(không đọc được)')}`);
  lines.push(`Đã lưu     : ${allItems.length} URL`);

  let res = null;
  try {
    if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.sendMessage) {
      res = await chrome.tabs.sendMessage(tabId, { type: 'content:ping' }, { frameId: 0 });
    }
  } catch {
    res = null;
  }

  if (!res || !res.ok) {
    if (el.connStatus) {
      el.connStatus.textContent = 'Mất kết nối';
      el.connStatus.className = 'diag-badge-status err';
    }
    if (el.statContentVal) {
      el.statContentVal.textContent = '✗ Chưa chạy';
      el.statContentVal.className = 'err';
    }
    if (el.statInjectVal) {
      el.statInjectVal.textContent = '✗ Chưa rõ';
      el.statInjectVal.className = 'err';
    }

    lines.push('');
    lines.push('✗ CONTENT SCRIPT KHÔNG PHẢN HỒI');
    lines.push('  Nghĩa là script chưa được inject vào trang.');
    lines.push('  1. Bấm nút [🔄 Reload Ext & Tab] bên trên');
    lines.push('  2. F5 lại trang web');
    lines.push('  3. Trang chrome:// hoặc Web Store thì trình duyệt cấm tiện ích chạy.');

    if (el.diagLogs) {
      el.diagLogs.innerHTML = '<div style="color:var(--text-muted);padding:4px;">Chưa nhận được log từ trang.</div>';
    }
  } else {
    if (el.connStatus) {
      el.connStatus.textContent = 'Hoạt động';
      el.connStatus.className = 'diag-badge-status ok';
    }
    if (el.statContentVal) {
      el.statContentVal.textContent = '✓ OK';
      el.statContentVal.className = 'ok';
    }
    if (el.statInjectVal) {
      el.statInjectVal.textContent = res.hasInject ? '✓ OK' : '✗ Chưa chạy';
      el.statInjectVal.className = res.hasInject ? 'ok' : 'err';
    }

    const s = res.stats || {};
    lines.push('');
    lines.push(`✓ Content script sống (top frame: ${res.isTop})`);
    lines.push(`Observer   : ${res.hasObserver ? 'OK' : '✗ KHÔNG TẠO ĐƯỢC'}`);
    lines.push(`inject.js  : ${res.hasInject ? 'OK' : '✗ MAIN world chưa chạy'}`);
    lines.push(`Bắt ở frame: ${res.localCount} URL`);
    lines.push('');
    lines.push(`  inject   : ${s.fromInject || 0}`);
    lines.push(`  youtube  : ${s.fromYt || 0}`);
    lines.push(`  network  : ${s.fromNetwork || 0}`);
    lines.push(`  dom      : ${s.fromDom || 0}`);
    lines.push(`  fb-json  : ${s.fromFbJson || 0}`);
    lines.push(`  ig-json  : ${s.fromIgJson || 0}`);
    lines.push(`  bị loại  : ${s.rejected || 0}`);
    lines.push(`  lỗi gửi  : ${s.sendErrors || 0}`);

    if (res.localCount === 0) {
      lines.push('');
      lines.push('→ Content script chạy nhưng CHƯA thấy URL nào.');
      lines.push('  Phải bấm PLAY video, extension mới thấy luồng dữ liệu.');
    }

    if (el.diagLogs) {
      const logs = res.logs || [];
      if (!logs.length) {
        el.diagLogs.innerHTML = '<div style="color:var(--text-muted);padding:4px;">Chưa có sự kiện nào. Hãy bấm Play video!</div>';
      } else {
        el.diagLogs.innerHTML = '';
        const frag = document.createDocumentFragment();
        for (let i = logs.length - 1; i >= 0; i--) {
          const l = logs[i];
          const row = document.createElement('div');
          row.className = 'diag-log-row';

          const time = document.createElement('span');
          time.className = 'diag-log-time';
          time.textContent = l.time;

          const tag = document.createElement('span');
          tag.className = 'diag-log-tag ' + (l.type || '');
          tag.textContent = l.type === 'accept' ? 'BẮT' : l.type === 'reject' ? 'LOẠI' : 'HỆ THỐNG';

          const text = document.createElement('span');
          text.className = 'diag-log-text';
          const reasonText = l.detail && l.detail.reason ? ` [${l.detail.reason}]` : '';
          text.textContent = `[${l.source}] ${l.text}${reasonText}`;
          text.title = `${l.text}${reasonText}`;

          row.append(time, tag, text);
          frag.appendChild(row);
        }
        el.diagLogs.appendChild(frag);
      }
    }
  }

  if (el.diag) {
    el.diag.textContent = lines.join('\n');
  }
}

// ------------------------------------------------------------- Event Listeners

async function triggerRescan() {
  if (tabId == null) return;
  isDetecting = true;
  render();
  setStatus('Đang quét sâu lại trang…', 'ok', 2000);
  try {
    const r = await chrome.runtime.sendMessage({ type: 'popup:rescan', tabId });
    if (r && r.ok === false) setStatus('Trang này không cho phép quét sâu', 'err');
    else setStatus('Đã quét lại video trên trang', 'ok');
  } catch {
    setStatus('Không liên lạc được với trang', 'err');
  }
  setTimeout(() => {
    load();
  }, 700);
}

if (el.rescan) el.rescan.addEventListener('click', triggerRescan);
if (el.btnEmptyRescan) el.btnEmptyRescan.addEventListener('click', triggerRescan);

if (el.clear) {
  el.clear.addEventListener('click', async () => {
    if (tabId == null) return;
    await chrome.runtime.sendMessage({ type: 'popup:clear', tabId });
    allItems = [];
    selectedQualityMap.clear();
    render();
    setStatus('Đã xoá danh sách video', 'ok');
  });
}

if (el.btnToggleDiag) {
  el.btnToggleDiag.addEventListener('click', () => {
    if (!el.diagWrap) return;
    el.diagWrap.open = !el.diagWrap.open;
    if (el.diagWrap.open) {
      runDiag();
      el.diagWrap.scrollIntoView({ behavior: 'smooth' });
    }
  });
}

if (el.copyAll) {
  el.copyAll.addEventListener('click', async () => {
    const items = visibleItems();
    if (!items.length) return;
    await navigator.clipboard.writeText(items.map((i) => i.url).join('\n'));
    setStatus(`Đã copy ${items.length} link video`, 'ok');
  });
}

if (el.downloadAll) {
  el.downloadAll.addEventListener('click', () => {
    runDownload(visibleItems(), el.downloadAll);
  });
}

if (el.filters) {
  el.filters.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    kindFilter = chip.dataset.kind;
    el.filters.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c === chip));
    render();
  });
}

if (el.btnReloadExt) {
  el.btnReloadExt.addEventListener('click', async () => {
    el.btnReloadExt.disabled = true;
    el.btnReloadExt.textContent = 'Đang tải lại…';
    setStatus('Đang nạp lại Extension & Tab…', 'ok');
    try {
      await chrome.runtime.sendMessage({ type: 'debug:reload', tabId });
    } catch { /* ignore */ }
    setTimeout(() => window.close(), 300);
  });
}

if (el.btnCopyDiag) {
  el.btnCopyDiag.addEventListener('click', async () => {
    const text = [
      '=== VIDEO GRABBER DIAGNOSTIC REPORT ===',
      el.diag ? el.diag.textContent : '',
      '',
      `=== DANH SÁCH URL ĐÃ LƯU (${allItems.length}) ===`,
      JSON.stringify(allItems, null, 2),
    ].join('\n');
    await navigator.clipboard.writeText(text);
    const oldText = el.btnCopyDiag.textContent;
    el.btnCopyDiag.textContent = '✓ Đã copy!';
    setTimeout(() => (el.btnCopyDiag.textContent = oldText), 1500);
  });
}

// ------------------------------------------------------------- Theme Controller
function applyTheme(themeKey) {
  const isLight = themeKey !== 'dark';
  document.body.classList.toggle('light-theme', isLight);
  document.body.classList.remove('theme-apple', 'theme-linear', 'theme-frost', 'theme-warm');

  if (themeKey !== 'dark' && themeKey !== 'light') {
    document.body.classList.add(themeKey);
  } else if (themeKey === 'light') {
    document.body.classList.add('theme-apple');
  }

  try {
    localStorage.setItem('vg_theme', themeKey);
  } catch { /* ignore */ }

  if (el.themePicker) {
    el.themePicker.querySelectorAll('.theme-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.theme === themeKey);
    });
  }

  if (el.themeIcon) {
    if (isLight) {
      el.themeIcon.innerHTML = '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>';
      if (el.btnToggleTheme) el.btnToggleTheme.title = 'Đang dùng Giao diện Sáng (Click để đổi sang Tối)';
    } else {
      el.themeIcon.innerHTML = `
        <circle cx="12" cy="12" r="5"></circle>
        <line x1="12" y1="1" x2="12" y2="3"></line>
        <line x1="12" y1="21" x2="12" y2="23"></line>
        <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line>
        <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line>
        <line x1="1" y1="12" x2="3" y2="12"></line>
        <line x1="21" y1="12" x2="23" y2="12"></line>
        <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line>
        <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>
      `;
      if (el.btnToggleTheme) el.btnToggleTheme.title = 'Đang dùng Giao diện Tối (Click để đổi sang Sáng)';
    }
  }
}

function initTheme() {
  let savedTheme = 'dark';
  try {
    savedTheme = localStorage.getItem('vg_theme') || 'dark';
  } catch { /* ignore */ }
  applyTheme(savedTheme);
}

if (el.btnToggleTheme) {
  el.btnToggleTheme.addEventListener('click', () => {
    const isCurrentlyLight = document.body.classList.contains('light-theme');
    const nextTheme = isCurrentlyLight ? 'dark' : 'theme-apple';
    applyTheme(nextTheme);
    setStatus(isCurrentlyLight ? 'Đã đổi sang Giao diện Tối (Dark)' : 'Đã đổi sang Giao diện Sáng (Apple Light)', 'ok');
  });
}

if (el.themePicker) {
  el.themePicker.addEventListener('click', (e) => {
    const btn = e.target.closest('.theme-btn');
    if (!btn || !btn.dataset.theme) return;
    const themeKey = btn.dataset.theme;
    applyTheme(themeKey);
    setStatus(`Đã chọn giao diện: ${btn.textContent.trim()}`, 'ok');
  });
}

// Storage sync
if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'session' && tabId != null && changes['tab:' + tabId]) {
      load();
    }
  });
}

// Runtime messages
if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'hq:progress') {
      const h = hqProgressHandlers.get(msg.url);
      if (h) h(msg);
      return;
    }
    if (msg && msg.type === 'tab:url-changed' && msg.url) {
      currentTabUrl = msg.url;
      load();
    }
  });
}

// Tab updates
if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.onUpdated) {
  chrome.tabs.onUpdated.addListener((updatedTabId, changeInfo) => {
    if (updatedTabId === tabId && changeInfo.url) {
      currentTabUrl = changeInfo.url;
      load();
    }
  });
}

// Periodic check
setInterval(async () => {
  try {
    const tab = await getActiveTab();
    if (tab && tab.id === tabId && tab.url && tab.url !== currentTabUrl) {
      currentTabUrl = tab.url;
      load();
    }
  } catch { /* ignore */ }
}, 800);

// Khởi chạy
initTheme();
load();
