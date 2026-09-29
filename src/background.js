/**
 * src/background.js — Service Worker.
 *
 * Nhiệm vụ:
 *   - Gom item do content script gửi lên, lưu theo tabId trong storage.session.
 *   - Xoá dữ liệu khi tab điều hướng sang trang khác.
 *   - Thực hiện tải file qua chrome.downloads.
 *
 * Background không biết chi tiết từng platform: mọi khác biệt nằm trong
 * src/social/<platform>/background.js và được gọi qua registry bên dưới.
 */

import * as fb from './social/fb/background.js';
import * as ig from './social/ig/background.js';
import * as ytb from './social/ytb/background.js';

/**
 * Registry social module phía background.
 * Thêm platform mới (vd TikTok) = tạo src/social/tiktok/background.js,
 * thêm 1 import + 1 dòng ở đây, khai báo file trong manifest.json.
 *
 * Interface (không bắt buộc đủ):
 *   mediaKey(item) | null, ignoreItem(item) -> bool,
 *   updateItem(existing, item, key) -> bool,
 *   formatFilename(url, index, meta) | null,
 *   probeDownload(tabId, url, ctx) | null.
 */
const SOCIAL_MODULES = [ytb, ig, fb];

// Thứ tự file phải khớp manifest.json — dùng để inject lại khi tab cũ còn giữ
// script đã chết (extension vừa được reload).
const MAIN_WORLD_FILES = [
  'src/social/base.js',
  'src/social/fb/inject.js',
  'src/social/ig/inject.js',
  'src/social/ytb/inject.js',
  'src/inject.js',
];

const ISOLATED_WORLD_FILES = [
  'src/social/base.js',
  'src/media/engine.js',
  'src/social/fb/content.js',
  'src/social/ig/content.js',
  'src/social/ytb/content.js',
  'src/content.js',
];

/**
 * Inject lại content script vào tab đang mở.
 *
 * Cần thiết khi extension vừa được reload: tab đang mở vẫn giữ instance script cũ
 * (chrome.runtime đã chết) nên popup thấy "content script không phản hồi" và trước
 * đây bắt người dùng phải F5. Guard trong từng file (__videoGrabberContentLoaded /
 * __videoGrabberInjected) đảm bảo frame đã có script thì không cài hook trùng.
 */
async function ensureContentScripts(tabId) {
  const result = { main: 'ok', isolated: 'ok' };

  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: MAIN_WORLD_FILES,
      world: 'MAIN',
    });
  } catch (err) {
    result.main = String((err && err.message) || err);
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ISOLATED_WORLD_FILES,
    });
  } catch (err) {
    result.isolated = String((err && err.message) || err);
  }

  log.info(`[Tab ${tabId}] Inject lại script:`, result);
  return result;
}

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
  for (const m of SOCIAL_MODULES) {
    if (typeof m.mediaKey !== 'function') continue;
    const key = m.mediaKey(item);
    if (key) return key;
  }
  return item.url;
}

async function addItems(tabId, incoming) {
  const current = await readItems(tabId);
  const byKey = new Map(current.map((i) => [getItemKey(i), i]));
  let changed = false;

  for (const item of incoming) {
    if (!item || !item.url) continue;

    // Platform tự loại item không phải file hoàn chỉnh (vd byte-range segment của Facebook)
    if (SOCIAL_MODULES.some((m) => typeof m.ignoreItem === 'function' && m.ignoreItem(item))) continue;

    const key = getItemKey(item);
    const existing = byKey.get(key);
    if (existing) {
      for (const m of SOCIAL_MODULES) {
        if (typeof m.updateItem === 'function' && m.updateItem(existing, item, key)) {
          changed = true;
        }
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

/** Rút tên file an toàn từ URL. Platform tự đề xuất trước, sau đó mới fallback. */
function filenameFor(url, index, meta) {
  let base = null;

  // 1. Tên file do platform quyết định (YouTube theo tiêu đề, Instagram theo shortcode...)
  for (const m of SOCIAL_MODULES) {
    if (typeof m.formatFilename !== 'function') continue;
    base = m.formatFilename(url, index, meta);
    if (base) break;
  }

  // 2. Fallback URL thông thường
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

  // Platform có thể probe trước khi tải (YouTube trả 403 → tránh lưu file .txt rác)
  for (const m of SOCIAL_MODULES) {
    if (typeof m.probeDownload !== 'function') continue;
    const probeCheck = await m.probeDownload(tabId, url, { probeMediaUrl, log });
    if (probeCheck && !probeCheck.shouldDownload) {
      return { ok: false, url, error: probeCheck.error };
    }
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
    log.err(`Tải thất bại (${filename}): ${errorMsg}`, url);
    return { ok: false, url, error: errorMsg };
  }
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

  if (msg.type === 'popup:list') {
    const id = msg.tabId;
    readItems(id).then((list) => sendResponse({ ok: true, items: list, count: list.length }));
    return true;
  }

  if (msg.type === 'popup:clear') {
    log.info(`Xoá danh sách tab ${msg.tabId}`);
    chrome.storage.session.remove(keyFor(msg.tabId)).then(() => {
      updateBadge(msg.tabId, 0);
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.type === 'popup:reinject') {
    const id = msg.tabId != null ? msg.tabId : tabId;
    if (id == null) {
      sendResponse({ ok: false, error: 'Không xác định được tab' });
      return true;
    }
    ensureContentScripts(id).then(
      (result) => sendResponse({ ok: true, ...result }),
      (err) => sendResponse({ ok: false, error: String(err) })
    );
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

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url || changeInfo.status === 'loading') {
    chrome.storage.session.remove(keyFor(tabId)).then(() => updateBadge(tabId, 0));
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(keyFor(tabId));
});
