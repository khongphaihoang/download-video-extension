/**
 * popup.js — UI.
 *
 * Đọc danh sách trực tiếp từ chrome.storage.session (nhanh, không cần đánh thức
 * service worker), còn các hành động thì gửi message cho background.
 */

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
let allItems = [];
let kindFilter = 'current';

const KIND_LABEL = {
  file: 'file',
  'yt-adaptive': 'yt-adapt',
};

const KIND_ORDER = { file: 0, 'yt-adaptive': 1 };

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

/**
 * Chẩn đoán — trả lời câu hỏi quan trọng nhất khi danh sách trống:
 * content script KHÔNG CHẠY, hay chạy nhưng KHÔNG THẤY gì?
 */
async function runDiag() {
  const lines = [];

  let tab = null;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    /* ignore */
  }

  lines.push(`Manifest   : v${chrome.runtime.getManifest().version}`);
  lines.push(`Tab        : ${tab && tab.url ? tab.url.slice(0, 90) : '(không đọc được)'}`);
  lines.push(`Đã lưu     : ${allItems.length} URL`);

  let res = null;
  try {
    res = await chrome.tabs.sendMessage(tabId, { type: 'content:ping' });
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

    // Hiển thị danh sách Live Logs
    if (el.diagLogs) {
      const logs = res.logs || [];
      if (!logs.length) {
        el.diagLogs.innerHTML = '<div style="color:var(--muted);padding:4px;">Chưa có sự kiện nào. Hãy bấm Play video!</div>';
      } else {
        el.diagLogs.innerHTML = '';
        const frag = document.createDocumentFragment();
        // Hiển thị mới nhất ở trên
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

  // Phát hiện YouTube để hiển thị cảnh báo
  const isYouTube = tab.url && /^https?:\/\/(www\.|m\.)?youtube\.com\//i.test(tab.url);
  if (el.ytNotice) {
    el.ytNotice.classList.toggle('hidden', !isYouTube);
  }

  const key = 'tab:' + tabId;
  const store = await chrome.storage.session.get(key);
  const facebookTab = (() => {
    try { return /(^|\.)(facebook\.com|fb\.com)$/i.test(new URL(tab.url).hostname); }
    catch { return false; }
  })();
  const isFacebookItem = (item) => {
    try { return /(^|\.)(facebook\.com|fb\.com)$/i.test(new URL(item.pageUrl).hostname); }
    catch { return false; }
  };
  allItems = (store[key] || []).filter((item) => {
    if (!facebookTab || !isFacebookItem(item)) return true;
    try {
      const media = new URL(item.url);
      return !/(^|\.)fbcdn\.net$/i.test(media.hostname)
        || (!media.searchParams.has('bytestart') && !media.searchParams.has('byteend'));
    } catch { return true; }
  }).sort((a, b) => {
    // 1. Video đang phát / vừa lướt tới LUÔN xếp đầu tiên
    if (a.isCurrent && !b.isCurrent) return -1;
    if (!a.isCurrent && b.isCurrent) return 1;
    // 2. Mới phát / mới lướt tới nhất lên trên cùng
    const timeDiff = (b.foundAt || 0) - (a.foundAt || 0);
    if (timeDiff !== 0) return timeDiff;
    // 3. Kind order
    return (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9);
  });
  if (facebookTab) {
    const byPath = new Map();
    allItems = allItems.filter((item) => {
      if (!isFacebookItem(item)) return true;
      let media;
      try { media = new URL(item.url); } catch { return true; }
      if (!/(^|\.)fbcdn\.net$/i.test(media.hostname)) return true;
      const key = media.pathname;
      const existing = byPath.get(key);
      if (existing) {
        if ((item.foundAt || 0) > (existing.foundAt || 0)) {
          existing.url = item.url;
          existing.host = item.host;
          existing.foundAt = item.foundAt;
        }
        existing.isCurrent = !!(existing.isCurrent || item.isCurrent);
        return false;
      }
      byPath.set(key, item);
      return true;
    });
  }

  render();
  await runDiag();
}

function visibleItems() {
  if (kindFilter === 'current') {
    return allItems.filter((i) => i.isCurrent);
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

function parseItemInfo(item) {
  let platform = 'generic';
  let platformName = 'Video File';
  let title = item.pageTitle || 'Video';
  let quality = 'MP4';
  let shortcode = '';

  const host = item.host || '';
  const pageUrl = item.pageUrl || '';
  const url = item.url || '';
  const facebookPage = /(^|\.)(facebook\.com|fb\.com)$/i.test((() => {
    try { return new URL(pageUrl).hostname; } catch { return ''; }
  })());

  // 1. YouTube
  if (item.ytMeta) {
    platform = 'youtube';
    platformName = 'YouTube';
    title = item.ytMeta.title || item.pageTitle || 'YouTube Video';
    quality = item.ytMeta.quality || (item.ytMeta.isAudio ? 'Audio' : 'Video');
  }
  // 2. Instagram
  else if (
    host.includes('instagram') ||
    pageUrl.includes('instagram.com') ||
    (item.label && item.label.includes('Instagram')) ||
    (!facebookPage && (url.includes('/o1/v/t16/') || url.includes('/v/t50.')))
  ) {
    platform = 'instagram';
    platformName = 'Instagram';

    const matchReel = pageUrl.match(/(?:reel|reels|p)\/([A-Za-z0-9_-]+)/i);
    if (matchReel) {
      shortcode = matchReel[1];
    }

    if (item.pageTitle) {
      const igTitleMatch = item.pageTitle.match(/^(.+?)\s+on Instagram:\s*["“](.+?)["”]?$/i);
      if (igTitleMatch) {
        title = `${igTitleMatch[1]}: ${igTitleMatch[2]}`;
      } else {
        title = item.pageTitle.replace(/\s*•\s*Instagram.*$/i, '').trim();
      }
    } else if (shortcode) {
      title = `Instagram Reel [${shortcode}]`;
    } else {
      title = 'Instagram Video';
    }

    quality = 'HD MP4';
  }
  // 3. Facebook
  else if (host.includes('fbcdn') || host.includes('facebook') || pageUrl.includes('facebook.com')) {
    platform = 'facebook';
    platformName = 'Facebook';
    if (item.label === 'browser_native_hd_url') quality = 'HD';
    else if (item.label === 'browser_native_sd_url') quality = 'SD';
    else quality = item.label || 'MP4';

    if (item.pageTitle) {
      title = item.pageTitle.replace(/\s*\|\s*Facebook.*$/i, '').trim();
    } else {
      title = 'Facebook Video';
    }
  }

  // Tên file dự kiến
  let filename = 'video.mp4';
  if (shortcode) {
    filename = `instagram_${shortcode}.mp4`;
  } else {
    try {
      const u = new URL(url);
      const last = u.pathname.split('/').filter(Boolean).pop() || '';
      if (last && /\.[a-z0-9]{2,5}$/i.test(last)) filename = decodeURIComponent(last);
      else if (platform === 'instagram') filename = `instagram_video.mp4`;
      else filename = 'video.mp4';
    } catch {
      /* ignore */
    }
  }

  return { platform, platformName, title, quality, filename, shortcode };
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
    items: items.map((i) => ({
      url: i.url,
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

  setStatus(`Đã gửi ${ids.length} file, đang kiểm tra…`);

  // Server (đặc biệt là fbcdn) hay trả 403 sau khi đã nhận lệnh tải.
  setTimeout(async () => {
    try {
      const found = await chrome.downloads.search({ id: ids });
      const bad = found.filter((f) => f.state === 'interrupted');
      if (bad.length) {
        setStatus(
          `${bad.length}/${ids.length} thất bại: ${bad[0].error || 'bị chặn'}. ` +
            'URL có thể đã hết hạn — thử Quét sâu lại.',
          'err'
        );
      } else {
        setStatus(`Đang tải ${ids.length} file vào thư mục Downloads`, 'ok');
      }
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
    } catch {
      /* ignore */
    }
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
