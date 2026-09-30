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

async function load() {
  const tab = await getActiveTab();
  if (!tab) return;
  tabId = tab.id;
  currentTabUrl = tab.url || '';

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
  allItems = filtered;

  render();
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
        return currentInMatched.length > 0 ? currentInMatched : [matchedByCode[0]];
      }
    }

    const current = allItems.filter((i) => i.isCurrent);
    if (current.length > 0) return current;

    if (isSingleVideoPage(currentTabUrl) && allItems.length > 0) {
      const cleanTabUrl = currentTabUrl.split('?')[0];
      const matched = allItems.filter((i) => i.pageUrl && i.pageUrl.split('?')[0] === cleanTabUrl);
      if (matched.length > 0) return matched;
      return [allItems[0]];
    }

    if (allItems.length === 1) return allItems;
    return [];
  }
  return kindFilter === 'all' ? allItems : allItems.filter((i) => i.kind === kindFilter);
}

function render() {
  const items = visibleItems();

  el.count.textContent = String(allItems.length);
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
  btnPreview.addEventListener('click', () => {
    isPreviewing = !isPreviewing;
    if (isPreviewing) {
      playerWrap.innerHTML = '';
      const video = document.createElement('video');
      video.src = item.url;
      video.controls = true;
      video.autoplay = true;
      video.muted = true;
      video.playsInline = true;
      if (info.platform === 'facebook') {
        const showPreviewError = () => {
          if (!isPreviewing || !video.isConnected) return;
          playerWrap.textContent = 'Không phát được bản xem thử. Link có thể đã hết hạn hoặc chỉ chứa luồng hình.';
        };
        video.addEventListener('loadeddata', () => clearTimeout(previewTimer), { once: true });
        video.addEventListener('error', showPreviewError, { once: true });
        previewTimer = setTimeout(() => {
          if (video.readyState === 0) showPreviewError();
        }, 10000);
      }
      playerWrap.appendChild(video);
      playerWrap.classList.add('show');
      btnPreview.textContent = '✖ Đóng xem';
      btnPreview.classList.add('active');
    } else {
      clearTimeout(previewTimer);
      playerWrap.innerHTML = '';
      playerWrap.classList.remove('show');
      btnPreview.textContent = '👁️ Xem thử';
      btnPreview.classList.remove('active');
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

load();
