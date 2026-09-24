/**
 * background.js — service worker.
 *
 * Nhiệm vụ:
 *   - Gom item do content script gửi lên, lưu theo tabId trong storage.session
 *     (service worker bị Chrome kill bất cứ lúc nào, nên không giữ trong RAM).
 *   - Xoá dữ liệu khi tab điều hướng sang trang khác.
 *   - Thực hiện tải file qua chrome.downloads (tự gắn cookie của domain).
 */

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

async function addItems(tabId, incoming) {
  const current = await readItems(tabId);
  const seen = new Set(current.map((i) => i.url));
  let changed = false;
  for (const item of incoming) {
    if (!item || !item.url || seen.has(item.url)) continue;
    seen.add(item.url);
    current.push(item);
    changed = true;
  }
  if (changed) await writeItems(tabId, current);
  return current.length;
}

function updateBadge(tabId, count) {
  const text = count > 99 ? '99+' : count ? String(count) : '';
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#2f6feb' }).catch(() => {});
}

// --------------------------------------------------------------- tải file

/** Rút tên file an toàn từ URL. Dùng ytMeta nếu có (YouTube). */
function filenameFor(url, index, ytMeta) {
  let base = 'video';

  // YouTube: dùng title video + quality label
  if (ytMeta && ytMeta.title) {
    const safe = ytMeta.title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim();
    const quality = ytMeta.quality || '';
    const isAudio = ytMeta.isAudio;
    const ext = isAudio ? '.webm' : '.mp4';
    base = safe + (quality ? ' [' + quality + ']' : '') + ext;
  } else {
    try {
      const u = new URL(url);
      const last = u.pathname.split('/').filter(Boolean).pop() || '';
      if (last && /\.[a-z0-9]{2,5}$/i.test(last)) base = decodeURIComponent(last);
      else if (last) base = decodeURIComponent(last) + '.mp4';
    } catch {
      /* ignore */
    }
  }

  base = base.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 180);
  if (!/\.[a-z0-9]{2,5}$/i.test(base)) base += '.mp4';
  return index != null ? `${String(index + 1).padStart(2, '0')}_${base}` : base;
}

async function downloadOne(item, index, total) {
  const url = typeof item === 'string' ? item : item.url;
  const ytMeta = (item && item.ytMeta) || null;
  try {
    const id = await chrome.downloads.download({
      url,
      filename: filenameFor(url, total > 1 ? index : null, ytMeta),
      conflictAction: 'uniquify',
      saveAs: false,
    });
    return { ok: true, id, url };
  } catch (err) {
    return { ok: false, url, error: String((err && err.message) || err) };
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
    chrome.storage.session.remove(keyFor(msg.tabId)).then(() => {
      updateBadge(msg.tabId, 0);
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.type === 'popup:rescan') {
    chrome.tabs
      .sendMessage(msg.tabId, { type: 'content:rescan' })
      .then((r) => sendResponse({ ok: true, ...r }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (msg.type === 'popup:download') {
    const list = msg.items || [];
    Promise.all(list.map((it, i) => downloadOne(it, i, list.length))).then((results) =>
      sendResponse({ ok: true, results })
    );
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
