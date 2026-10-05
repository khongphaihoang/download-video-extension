/**
 * src/popup.js — UI.
 *
 * Đọc danh sách trực tiếp từ chrome.storage.session,
 * sử dụng các module social (fb, ig, ytb) để định dạng và hiển thị.
 */

import * as fb from './social/fb/popup.js';
import * as ig from './social/ig/popup.js';
import * as ytb from './social/ytb/popup.js';
import * as tiktok from './social/tiktok/popup.js';

const socialModules = [ytb, ig, fb, tiktok];

const $ = (sel) => document.querySelector(sel);

const el = {
  list: $('#list'),
  empty: $('#empty'),
  count: $('#count'),
  filters: $('#filters'),
  status: $('#status'),
  rescan: $('#rescan'),
  copyAll: $('#copyAll'),
  clear: $('#clear'),
  downloadAll: $('#downloadAll'),
  diag: $('#diag'),
  ytNotice: $('#ytNotice'),
  connStatus: $('#connStatus'),
  statContentVal: $('#statContentVal'),
  statInjectVal: $('#statInjectVal'),
  btnReloadExt: $('#btnReloadExt'),
  btnCopyDiag: $('#btnCopyDiag'),
  diagLogs: $('#diagLogs'),
};

let tabId = null;
let currentTabUrl = '';
let allItems = [];
let kindFilter = 'current';

const KIND_ORDER = { file: 0, 'yt-adaptive': 1 };

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

/**
 * Chẩn đoán — trả lời câu hỏi: content script đã chạy chưa và bắt được những gì?
 */
async function runDiag() {
  const lines = [];

  let tab = null;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch { /* ignore */ }

  lines.push(`Manifest   : v${chrome.runtime.getManifest().version}`);
  lines.push(`Tab        : ${tab && tab.url ? tab.url.slice(0, 90) : '(không đọc được)'}`);
  lines.push(`Đã lưu     : ${allItems.length} URL`);

  let res = null;
  try {
    res = await chrome.tabs.sendMessage(tabId, { type: 'content:ping' }, { frameId: 0 });
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
      el.diagLogs.innerHTML = '<div style="color:var(--muted);padding:4px;">Chưa nhận được log từ trang.</div>';
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
      lines.push('  Kiểm tra Console (F12) xem log [VG:Content] hoặc gõ __VG__.status()');
    }

    // Hiển thị Live Logs
    if (el.diagLogs) {
      const logs = res.logs || [];
      if (!logs.length) {
        el.diagLogs.innerHTML = '<div style="color:var(--muted);padding:4px;">Chưa có sự kiện nào. Hãy bấm Play video!</div>';
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

  el.diag.textContent = lines.join('\n');
}

function setStatus(text, tone) {
  el.status.textContent = text || '';
  el.status.className = 'status' + (tone ? ' ' + tone : '');
}

let activePreviewUrl = null;
let hasPendingReload = false;

function haveItemsChanged(prev, next) {
  if (!prev || !next || prev.length !== next.length) return true;
  for (let i = 0; i < prev.length; i++) {
    if (
      prev[i].url !== next[i].url ||
      prev[i].code !== next[i].code ||
      prev[i].isCurrent !== next[i].isCurrent ||
      prev[i].title !== next[i].title
    ) {
      return true;
    }
  }
  return false;
}

async function fetchPreviewFromTab(targetTabId, mediaUrl) {
  // 1. Thử gửi message tới top frame của tab (frameId: 0)
  try {
    const res = await chrome.tabs.sendMessage(
      targetTabId,
      {
        type: 'content:preview-media',
        url: mediaUrl,
      },
      { frameId: 0 }
    );
    if (res && res.ok && res.dataUrl) return res;
  } catch (err) {
    console.warn('[Popup] sendMessage preview-media không phản hồi, thử executeScript...', err);
  }

  // 2. Fallback dùng chrome.scripting.executeScript (hoạt động ngay cả khi tab chưa F5 lại content script mới)
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: targetTabId },
      func: async (url) => {
        try {
          let res = await fetch(url, { credentials: 'include' });
          if (!res.ok && res.status === 403) res = await fetch(url);
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

let lastRenderedTabUrl = '';

async function load() {
  const tab = await getActiveTab();
  if (!tab) return;
  tabId = tab.id;
  currentTabUrl = tab.url || '';

  const urlChanged = currentTabUrl !== lastRenderedTabUrl;
  if (urlChanged) {
    // Nếu chuyển sang URL video khác trong tab, xóa preview cũ để nạp video mới
    activePreviewUrl = null;
  } else if (activePreviewUrl != null) {
    // Nếu vẫn ở cùng một video và đang xem thử, hoãn reload để không đá văng người dùng khỏi player
    hasPendingReload = true;
    return;
  }
  lastRenderedTabUrl = currentTabUrl;

  // Phát hiện YouTube để hiển thị cảnh báo
  const isYouTube = socialModules.some((module) =>
    typeof module.matchTab === 'function'
      ? module.matchTab(currentTabUrl)
      : typeof module.isYouTubeTab === 'function' && module.isYouTubeTab(currentTabUrl)
  );
  if (el.ytNotice) {
    el.ytNotice.classList.toggle('hidden', !isYouTube);
  }

  const key = 'tab:' + tabId;
  const store = await chrome.storage.session.get(key);
  const isFbTab = fb.isFacebookTab(currentTabUrl);
  const isTtTab = tiktok.isTikTokTab(currentTabUrl);
  const currentTabCode = (fb.matchVideoCode && fb.matchVideoCode(currentTabUrl))
    || (tiktok.matchVideoCode && tiktok.matchVideoCode(currentTabUrl))
    || null;

  const rawList = (store[key] || []).sort((a, b) => {
    // 0. Khớp chính xác video ID của trang đang mở
    if (currentTabCode) {
      const aMatch = (a.code && a.code === currentTabCode)
        || (a.pageUrl && a.pageUrl.includes(currentTabCode))
        || (a.url && a.url.includes(currentTabCode));
      const bMatch = (b.code && b.code === currentTabCode)
        || (b.pageUrl && b.pageUrl.includes(currentTabCode))
        || (b.url && b.url.includes(currentTabCode));
      if (aMatch && !bMatch) return -1;
      if (!aMatch && bMatch) return 1;
    }
    // 1. Video đang phát / vừa lướt tới LUÔN xếp đầu tiên
    if (a.isCurrent && !b.isCurrent) return -1;
    if (!a.isCurrent && b.isCurrent) return 1;
    // 2. Mới phát / mới lướt tới nhất lên trên cùng
    const timeDiff = (b.foundAt || 0) - (a.foundAt || 0);
    if (timeDiff !== 0) return timeDiff;
    // 3. Kind order
    return (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9);
  });

  // Lọc và khử trùng theo nền tảng
  let filtered = fb.filterAndDedupe(rawList, isFbTab);
  filtered = tiktok.filterAndDedupe(filtered, isTtTab);

  const changed = urlChanged || haveItemsChanged(allItems, filtered);
  allItems = filtered;

  if (changed) {
    render();
  }
  await runDiag();
}

function isSingleVideoPage(url) {
  if (!url) return false;
  return /\/(?:reel|reels|watch|videos|p)\//i.test(url)
    || /[?&]v=[0-9]+/i.test(url)
    || /youtube\.com\/watch/i.test(url)
    || /instagram\.com\/(?:p|reel|reels)\//i.test(url)
    || /tiktok\.com\/.*\/video\//i.test(url)
    || /tiktok\.com\/.*\/v\//i.test(url)
    || /tiktok\.com\/.*\/photo\//i.test(url);
}

function visibleItems() {
  if (kindFilter === 'current') {
    const currentTabCode = (fb.matchVideoCode && fb.matchVideoCode(currentTabUrl))
      || (tiktok.matchVideoCode && tiktok.matchVideoCode(currentTabUrl))
      || null;
    if (currentTabCode) {
      const matchedByCode = allItems.filter((i) =>
        (i.code && i.code === currentTabCode) ||
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

function render() {
  const items = visibleItems();

  el.count.textContent = String(allItems.length);

  const allChip = el.filters.querySelector('[data-kind="all"]');
  if (allChip) {
    allChip.textContent = allItems.length > 0 ? `Tất cả (${allItems.length})` : 'Tất cả';
  }

  el.list.textContent = '';
  el.empty.classList.toggle('hidden', items.length > 0);
  const emptyText = el.empty.querySelector('p');
  if (emptyText) {
    emptyText.textContent = kindFilter === 'current' && allItems.length
      ? 'Chưa xác định được video đang xem. Xem mục Tất cả để thấy các link đã bắt.'
      : 'Chưa bắt được video nào.';
  }
  el.list.classList.toggle('hidden', items.length === 0);
  el.downloadAll.disabled = items.length === 0;

  const frag = document.createDocumentFragment();
  for (const item of items) frag.appendChild(renderItem(item));
  el.list.appendChild(frag);
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
    if (info.platform === 'tiktok') return 'tiktok_video.mp4';
  } catch { /* ignore */ }
  return 'video.mp4';
}

function parseItemInfo(item) {
  const isFbTab = fb.isFacebookTab(currentTabUrl);

  for (const module of socialModules) {
    if (typeof module.parseItemInfo !== 'function') continue;
    const info = module.parseItemInfo(item, isFbTab);
    if (info) return { ...info, filename: getFilename(item, info) };
  }

  // 4. Mặc định
  const defaultInfo = {
    platform: 'generic',
    platformName: 'Video File',
    title: item.pageTitle || 'Video',
    quality: 'MP4',
  };
  return { ...defaultInfo, filename: getFilename(item, defaultInfo) };
}

function renderItem(item) {
  const info = parseItemInfo(item);
  const li = document.createElement('li');
  li.className = 'item';

  // Header: Icon + Title + Tags
  const header = document.createElement('div');
  header.className = 'item-header';

  const icon = document.createElement('div');
  icon.className = `platform-badge-icon ${info.platform}`;
  icon.textContent =
    info.platform === 'instagram'
      ? '📸'
      : info.platform === 'facebook'
      ? '🔵'
      : info.platform === 'youtube'
      ? '▶️'
      : '🎬';

  const main = document.createElement('div');
  main.className = 'item-main';

  const titleEl = document.createElement('div');
  titleEl.className = 'item-title';
  titleEl.textContent = info.title;
  titleEl.title = info.title;

  const tags = document.createElement('div');
  tags.className = 'item-tags';

  const tagPlat = document.createElement('span');
  tagPlat.className = `tag-badge platform ${info.platform}`;
  tagPlat.textContent = info.platformName;

  const tagQual = document.createElement('span');
  tagQual.className = 'tag-badge quality';
  tagQual.textContent = info.quality;

  const tagHost = document.createElement('span');
  tagHost.className = 'tag-badge subtle';
  tagHost.textContent = item.host;
  tagHost.title = item.url;

  tags.append(tagPlat, tagQual, tagHost);

  const isHot = !!item.isCurrent;
  if (isHot) {
    li.classList.add('active-now');
    const tagHot = document.createElement('span');
    tagHot.className = 'tag-badge hot-now';
    tagHot.textContent = '🔥 ĐANG XEM';
    tags.prepend(tagHot);
  }

  main.append(titleEl, tags);
  header.append(icon, main);

  // Dòng hiển thị tên file sẽ lưu
  const fileNameRow = document.createElement('div');
  fileNameRow.className = 'file-preview-name';
  fileNameRow.textContent = `💾 ${info.filename}`;
  fileNameRow.title = item.url;

  // Hộp Preview video (ẩn mặc định)
  const playerWrap = document.createElement('div');
  playerWrap.className = 'item-preview-player';

  // Hàng nút hành động
  const row = document.createElement('div');
  row.className = 'row';

  const btnPreview = document.createElement('button');
  btnPreview.className = 'btn preview-btn';
  btnPreview.textContent = '👁️ Xem thử';

  let isPreviewing = false;
  let previewTimer = null;
  let previewBlobUrl = null;

  btnPreview.addEventListener('click', async () => {
    isPreviewing = !isPreviewing;
    if (isPreviewing) {
      activePreviewUrl = item.url;
      playerWrap.innerHTML = '';
      btnPreview.textContent = '✖ Đóng xem';
      btnPreview.classList.add('active');

      const isTikTok = info.platform === 'tiktok' || (tiktok.isTikTokItem && tiktok.isTikTokItem(item));
      if (isTikTok && tabId != null) {
        playerWrap.innerHTML = '<div class="preview-loading"><span class="spinner-small"></span> Đang nạp video xem thử từ TikTok…</div>';
        playerWrap.classList.add('show');
        
        const res = await fetchPreviewFromTab(tabId, item.url);
        if (!isPreviewing) return; // Người dùng đã ấn đóng xem trong lúc đang nạp
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
          video.muted = false;
          video.playsInline = true;
          playerWrap.appendChild(video);
          return;
        }
      }

      if (!isPreviewing) return;
      playerWrap.innerHTML = '';
      const video = document.createElement('video');
      video.src = item.url;
      video.controls = true;
      video.autoplay = true;
      video.muted = true;
      video.playsInline = true;
      if (info.platform === 'facebook' || isTikTok) {
        const showPreviewError = () => {
          if (!isPreviewing || !video.isConnected) return;
          playerWrap.innerHTML = `<div class="preview-error">
            ${isTikTok 
              ? 'Không thể tải toàn bộ luồng xem thử (TikTok chặn truy cập trực tiếp ngoài trang). Bạn hãy bấm nút <b>⬇️ Tải</b> để lưu video.' 
              : 'Không phát được bản xem thử. Link có thể đã hết hạn hoặc chỉ chứa luồng hình.'}
          </div>`;
        };
        video.addEventListener('loadeddata', () => clearTimeout(previewTimer), { once: true });
        video.addEventListener('error', showPreviewError, { once: true });
        previewTimer = setTimeout(() => {
          if (video.readyState === 0) showPreviewError();
        }, 10000);
      }
      playerWrap.appendChild(video);
      playerWrap.classList.add('show');
    } else {
      activePreviewUrl = null;
      clearTimeout(previewTimer);
      if (previewBlobUrl) {
        URL.revokeObjectURL(previewBlobUrl);
        previewBlobUrl = null;
      }
      playerWrap.innerHTML = '';
      playerWrap.classList.remove('show');
      btnPreview.textContent = '👁️ Xem thử';
      btnPreview.classList.remove('active');
      if (hasPendingReload) {
        hasPendingReload = false;
        load();
      }
    }
  });

  const dl = document.createElement('button');
  dl.className = 'btn primary dl-btn';
  dl.textContent = '⬇️ Tải';
  dl.addEventListener('click', () => runDownload([item], dl));

  const cp = document.createElement('button');
  cp.className = 'btn copy-btn';
  cp.textContent = 'Copy';
  cp.addEventListener('click', async () => {
    await navigator.clipboard.writeText(item.url);
    cp.textContent = 'Đã copy';
    setTimeout(() => (cp.textContent = 'Copy'), 1200);
  });

  row.append(btnPreview, dl, cp);

  li.append(header, fileNameRow, playerWrap, row);
  return li;
}

/** Gửi lệnh tải, rồi kiểm tra lại xem Chrome có tải được thật không. */
async function runDownload(items, button) {
  const label = button ? button.textContent : null;
  if (button) {
    button.disabled = true;
    button.textContent = 'Đang tải…';
  }
  setStatus(`Đang gửi ${items.length} file…`);

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
    button.textContent = label;
  }

  if (!ids.length) {
    setStatus(failed[0] ? 'Lỗi: ' + failed[0].error : 'Không gửi được lệnh tải', 'err');
    return;
  }

  if (ids.every((id) => id === 'tab-blob')) {
    setStatus('Đã tải video thành công vào thư mục Downloads!', 'ok');
    return;
  }

  setStatus(`Đang xử lý ${ids.length} file…`);

  setTimeout(async () => {
    try {
      const numericIds = ids.filter((id) => typeof id === 'number');
      if (numericIds.length > 0) {
        const found = await chrome.downloads.search({ id: numericIds });
        const bad = found.filter((f) => {
          if (f.state === 'interrupted') return true;
          // Phát hiện file tải về thực chất là HTML báo lỗi (403 Forbidden / Access Denied)
          if (f.state === 'complete' && f.mime && f.mime.includes('text/html')) return true;
          if (f.state === 'complete' && f.fileSize > 0 && f.fileSize < 3000 && f.filename && !f.filename.endsWith('.html')) return true;
          return false;
        });
        if (bad.length) {
          // Xóa file rác HTML do máy chủ trả về nếu có
          for (const b of bad) {
            if (b.state === 'complete') {
              chrome.downloads.removeFile(b.id).catch(() => {});
              chrome.downloads.erase({ id: b.id }).catch(() => {});
            }
          }
          setStatus(`Tải trực tiếp bị chặn (${bad[0].error || 'máy chủ trả về file HTML'}). Đang thử tải qua trang web…`);
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
            setStatus(
              `${bad.length}/${ids.length} thất bại: máy chủ từ chối tải trực tiếp. ` +
                'URL có thể đã hết hạn — thử Quét sâu lại.',
              'err'
            );
          }
          return;
        }
      }
      setStatus(`Đang tải ${ids.length} file vào thư mục Downloads`, 'ok');
    } catch {
      setStatus(`Đã gửi ${ids.length} file`, 'ok');
    }
  }, 2500);
}

// ------------------------------------------------------------------ events

el.rescan.addEventListener('click', async () => {
  if (tabId == null) return;
  setStatus('Đang quét…');
  try {
    const r = await chrome.runtime.sendMessage({ type: 'popup:rescan', tabId });
    if (r && r.ok === false) setStatus('Trang này không cho phép quét', 'err');
    else setStatus('Đã quét lại', 'ok');
  } catch {
    setStatus('Không liên lạc được với trang', 'err');
  }
  setTimeout(() => {
    load();
    setStatus('');
  }, 700);
});

el.clear.addEventListener('click', async () => {
  if (tabId == null) return;
  await chrome.runtime.sendMessage({ type: 'popup:clear', tabId });
  allItems = [];
  render();
  setStatus('Đã xoá danh sách', 'ok');
});

el.copyAll.addEventListener('click', async () => {
  const items = visibleItems();
  if (!items.length) return;
  await navigator.clipboard.writeText(items.map((i) => i.url).join('\n'));
  setStatus(`Đã copy ${items.length} URL`, 'ok');
});

el.downloadAll.addEventListener('click', () => runDownload(visibleItems(), el.downloadAll));

el.filters.addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  kindFilter = chip.dataset.kind;
  el.filters.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c === chip));
  render();
});

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
      el.diag.textContent,
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

// Tự động reload danh sách video khi dữ liệu tab thay đổi (lướt video mới hoặc bắt thêm link)
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'session' && tabId != null && changes['tab:' + tabId]) {
    load();
  }
});

// Tự động reload popup khi tab chuyển video (SPA pushState từ content.js)
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'tab:url-changed' && msg.url) {
    currentTabUrl = msg.url;
    load();
  }
});

// Tự động reload popup khi tab chuyển video (SPA pushState từ trình duyệt)
chrome.tabs.onUpdated.addListener((updatedTabId, changeInfo) => {
  if (updatedTabId === tabId && changeInfo.url) {
    currentTabUrl = changeInfo.url;
    load();
  }
});

// Kiểm tra định kỳ URL tab active phòng trường hợp SPA không bắn sự kiện
setInterval(async () => {
  try {
    const tab = await getActiveTab();
    if (tab && tab.id === tabId && tab.url && tab.url !== currentTabUrl) {
      currentTabUrl = tab.url;
      load();
    }
  } catch { /* ignore */ }
}, 800);

load();
