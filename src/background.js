/**
 * src/background.js — Service Worker.
 *
 * Nhiệm vụ:
 *   - Gom item do content script gửi lên, lưu theo tabId trong storage.session.
 *   - Xoá dữ liệu khi tab điều hướng sang trang khác.
 *   - Thực hiện tải file qua chrome.downloads.
 *   - Sử dụng các module social (fb, ig, ytb) để xử lý logic đặc thù từng nền tảng.
 */

import * as fb from './social/fb/background.js';
import * as ig from './social/ig/background.js';
import * as ytb from './social/ytb/background.js';
import * as tiktok from './social/tiktok/background.js';

const socialModules = [ytb, ig, fb, tiktok];

// Logger tiện ích cho background script
const log = {
  info: (msg, ...args) =>
    console.log(
      `%c[VG:Background]%c ${msg}`,
      'background:#2563eb;color:#fff;padding:2px 6px;border-radius:3px;font-weight:600;',
      'color:inherit;',
      ...args
    ),
  warn: (msg, ...args) =>
    console.warn(
      `%c[VG:Background]%c ${msg}`,
      'background:#d97706;color:#fff;padding:2px 6px;border-radius:3px;font-weight:600;',
      'color:inherit;',
      ...args
    ),
  err: (msg, ...args) =>
    console.error(
      `%c[VG:Background]%c ${msg}`,
      'background:#dc2626;color:#fff;padding:2px 6px;border-radius:3px;font-weight:600;',
      'color:inherit;',
      ...args
    ),
};

log.info('Service Worker đã sẵn sàng');

const PREFIX = 'tab:';
const keyFor = (tabId) => PREFIX + tabId;

async function readItems(tabId) {
  const key = keyFor(tabId);
  const store = await chrome.storage.session.get(key);
  return store[key] || [];
}

async function writeItems(tabId, list) {
  await chrome.storage.session.set({ [keyFor(tabId)]: list });
  updateBadge(tabId, list.length);
}

function getItemKey(item) {
  for (const module of socialModules) {
    if (typeof module.mediaKey !== 'function') continue;
    const key = module.mediaKey(item);
    if (key && key !== item.url) return key;
  }
  return item.url;
}

async function addItems(tabId, incoming) {
  const current = await readItems(tabId);
  const byKey = new Map(current.map((i) => [getItemKey(i), i]));
  let changed = false;

  for (const item of incoming) {
    if (!item || !item.url) continue;

    if (socialModules.some((module) => typeof module.ignoreItem === 'function' && module.ignoreItem(item))) continue;

    const key = getItemKey(item);
    const existing = byKey.get(key);
    if (existing) {
      let updated = false;
      for (const module of socialModules) {
        if (typeof module.updateItem === 'function' && module.updateItem(existing, item, key)) updated = true;
      }
      if (updated) {
        changed = true;
      }
      if (Array.isArray(item.sources)) {
        existing.sources = [...new Set([...(existing.sources || []), ...item.sources])];
      }
      if (item.isCurrent) {
        for (const it of current) it.isCurrent = false;
        existing.isCurrent = true;
        existing.foundAt = item.foundAt || Date.now();
        if (item.title) existing.title = item.title;
        if (item.pageUrl) existing.pageUrl = item.pageUrl;
        changed = true;
      }
      continue;
    }

    if (item.isCurrent) {
      for (const it of current) it.isCurrent = false;
    }
    byKey.set(key, item);
    current.push(item);
    changed = true;
  }

  if (changed) {
    await writeItems(tabId, current);
    log.info(`[Tab ${tabId}] Đã lưu/cập nhật link. Tổng: ${current.length}`);
  }
  return current.length;
}

function updateBadge(tabId, count) {
  const text = count > 99 ? '99+' : count ? String(count) : '';
  chrome.action.setBadgeText({ tabId, text }).catch(() => { });
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#2f6feb' }).catch(() => { });
}

// --------------------------------------------------------------- tải file

/** Rút tên file an toàn từ URL. Sử dụng social modules tương ứng. */
function filenameFor(url, index, meta) {
  let base = null;
  for (const module of socialModules) {
    if (typeof module.formatFilename !== 'function') continue;
    base = module.formatFilename(url, index, meta);
    if (base) break;
  }

  // 3. Fallback URL thông thường
  if (!base) {
    base = 'video';
    try {
      const u = new URL(url);
      const last = u.pathname.split('/').filter(Boolean).pop() || '';
      if (last && /\.[a-z0-9]{2,5}$/i.test(last)) base = decodeURIComponent(last);
      else if (last) base = decodeURIComponent(last) + '.mp4';
    } catch { /* ignore */ }
  }

  base = base.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 180);
  if (!/\.[a-z0-9]{2,5}$/i.test(base)) base += '.mp4';
  return index != null ? `${String(index + 1).padStart(2, '0')}_${base}` : base;
}

/** Hỏi content script của tab xem URL có tải được thật không. */
async function probeMediaUrl(tabId, url) {
  if (tabId == null) return null;
  try {
    return await chrome.tabs.sendMessage(tabId, { type: 'content:probe', url });
  } catch {
    return null;
  }
}

async function downloadOne(item, index, total, tabId) {
  const url = typeof item === 'string' ? item : item.url;
  const meta = typeof item === 'object' ? item : null;
  const filename = filenameFor(url, total > 1 ? index : null, meta);

  // Cho phép module xử lý download đặc thù (VD: YouTube, TikTok) trước
  for (const module of socialModules) {
    if (typeof module.handleDownload !== 'function') continue;
    const handled = await module.handleDownload(item, filename, tabId, log);
    if (handled) return handled;
  }

  let probeCheck = { shouldDownload: true };
  for (const module of socialModules) {
    if (typeof module.probeDownload !== 'function') continue;
    probeCheck = await module.probeDownload(tabId, url, probeMediaUrl, log);
    if (probeCheck && probeCheck.shouldDownload === false) break;
  }
  if (!probeCheck.shouldDownload) {
    return { ok: false, url, error: probeCheck.error };
  }

  try {
    log.info(`Đang tải (${index + 1}/${total}): ${filename}`, url);
    const id = await chrome.downloads.download({
      url,
      filename,
      conflictAction: 'uniquify',
      saveAs: false,
    });
    log.info(`Bắt đầu download ID: ${id}`);
    return { ok: true, id, url };
  } catch (err) {
    const errorMsg = String((err && err.message) || err);
    log.warn(`chrome.downloads thất bại (${filename}): ${errorMsg}. Thử fallback tải qua tab...`, url);

    if (tabId != null) {
      try {
        const fallbackRes = await chrome.tabs.sendMessage(tabId, {
          type: 'content:download-blob',
          url,
          filename,
        });
        if (fallbackRes && fallbackRes.ok) {
          log.info(`Tải fallback thành công qua tab cho: ${filename}`);
          return { ok: true, id: 'tab-blob', url };
        }
      } catch (fbErr) {
        log.err(`Tải fallback qua tab cũng thất bại:`, fbErr);
      }
    }

    return { ok: false, url, error: errorMsg };
  }
}

// ------------------------------------------------- YouTube HQ qua yt-dlp (native)
const NATIVE_HOST = 'com.videograbber.ytdlp';

function nativeErrorMessage(err) {
  const m = String((err && err.message) || err || '');
  if (/not found|forbidden|Specified native messaging host/i.test(m)) {
    return 'Chưa cài native host. Chạy native-host\\install.ps1 -ExtensionId ' + chrome.runtime.id;
  }
  return m || 'Lỗi native host';
}

async function hqPing() {
  try {
    const res = await chrome.runtime.sendNativeMessage(NATIVE_HOST, { action: 'ping' });
    return { ok: true, ...res };
  } catch (err) {
    return { ok: false, error: nativeErrorMessage(err) };
  }
}

/** Tải YouTube chất lượng cao: yt-dlp tải hình+tiếng rồi ffmpeg ghép. Tiến độ gửi về popup. */
function hqDownload(url, height) {
  return new Promise((resolve) => {
    let port;
    try {
      port = chrome.runtime.connectNative(NATIVE_HOST);
    } catch (err) {
      resolve({ ok: false, error: nativeErrorMessage(err) });
      return;
    }
    let settled = false;
    port.onMessage.addListener((m) => {
      if (m && m.type === 'progress') {
        chrome.runtime.sendMessage({ type: 'hq:progress', url, ...m }).catch(() => { });
      } else if (m && m.type === 'done') {
        settled = true;
        resolve(m);
        port.disconnect();
      }
    });
    port.onDisconnect.addListener(() => {
      if (settled) return;
      const le = chrome.runtime.lastError;
      resolve({ ok: false, error: nativeErrorMessage(le && le.message) });
    });
    port.postMessage({ action: 'download', url, height: height || null });
  });
}

// ------------------------------------------------------------ message bus

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab && sender.tab.id;

  if (!msg || typeof msg.type !== 'string') return undefined;

  if (msg.type === 'media:add' && tabId != null) {
    addItems(tabId, msg.items || []).then(
      (count) => sendResponse({ ok: true, count }),
      (err) => sendResponse({ ok: false, error: String(err) })
    );
    return true;
  }

  if (msg.type === 'popup:hq-ping') {
    hqPing().then(sendResponse);
    return true;
  }

  if (msg.type === 'popup:hq-download') {
    log.info(`Tải YouTube HQ (${msg.height || 'best'}p):`, msg.url);
    hqDownload(msg.url, msg.height).then(sendResponse);
    return true;
  }

  if (msg.type === 'popup:list') {
    const id = msg.tabId;
    readItems(id).then((list) => sendResponse({ ok: true, items: list, count: list.length }));
    return true;
  }

  if (msg.type === 'popup:clear') {
    log.info(`Xoá danh sách tab ${msg.tabId}`);
    chrome.tabs.sendMessage(msg.tabId, { type: 'content:clear' }).catch(() => { });
    chrome.storage.session.remove(keyFor(msg.tabId)).then(() => {
      updateBadge(msg.tabId, 0);
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.type === 'popup:rescan') {
    log.info(`Quét sâu tab ${msg.tabId}`);
    chrome.tabs
      .sendMessage(msg.tabId, { type: 'content:rescan' })
      .then((r) => sendResponse({ ok: true, ...r }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (msg.type === 'popup:download') {
    const list = msg.items || [];
    const targetTab = msg.tabId != null ? msg.tabId : tabId;
    log.info(`Yêu cầu tải ${list.length} file`);
    Promise.all(list.map((it, i) => downloadOne(it, i, list.length, targetTab))).then((results) =>
      sendResponse({ ok: true, results })
    );
    return true;
  }

  // Debug: Nạp lại Extension và tải lại tab hiện tại
  if (msg.type === 'debug:reload') {
    log.info('🔄 Nhận lệnh nạp lại Extension & Tab:', msg.tabId);
    if (msg.tabId) {
      chrome.tabs.reload(msg.tabId).catch(() => { });
    }
    setTimeout(() => {
      chrome.runtime.reload();
    }, 150);
    sendResponse({ ok: true });
    return true;
  }

  return undefined;
});

// --------------------------------------------- dọn dữ liệu khi điều hướng
const tabOrigins = new Map();

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // Chỉ dọn dữ liệu nếu tab chuyển hẳn sang website / origin khác (ví dụ: từ tiktok.com sang google.com)
  if (changeInfo.url) {
    try {
      const newOrigin = new URL(changeInfo.url).origin;
      const oldOrigin = tabOrigins.get(tabId);
      if (oldOrigin && oldOrigin !== newOrigin) {
        log.info(`[Tab ${tabId}] Chuyển origin từ ${oldOrigin} sang ${newOrigin} -> dọn storage`);
        chrome.storage.session.remove(keyFor(tabId)).then(() => updateBadge(tabId, 0));
      }
      tabOrigins.set(tabId, newOrigin);
    } catch { /* ignore */ }
  } else if (changeInfo.status === 'loading' && tab && tab.url) {
    try {
      tabOrigins.set(tabId, new URL(tab.url).origin);
    } catch { /* ignore */ }
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabOrigins.delete(tabId);
  chrome.storage.session.remove(keyFor(tabId));
});
