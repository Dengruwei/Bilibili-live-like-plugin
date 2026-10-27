/**
 * 后台服务：记录每个标签页的点击任务进度，供弹窗关闭后再次打开时恢复显示。
 * 计时器本身跑在页面里（见 popup.js 的 pageClicker），所以关掉弹窗任务不会中断。
 */

const STATES_KEY = 'clickerStates';
const PERSIST_INTERVAL_MS = 400;

/** @type {Record<string, object>} 以标签页 id 为键的最新任务状态 */
let states = {};
let lastPersistAt = 0;

/** 从存储读取一次历史状态，避免 Service Worker 被回收后丢失导航/关页的清理能力。 */
chrome.storage.local.get(STATES_KEY).then((data) => {
  const stored = data[STATES_KEY];
  if (stored && typeof stored === 'object') states = stored;
}).catch(() => {});

chrome.action.setBadgeBackgroundColor({ color: '#5B57E0' }).catch(() => {});

/**
 * 在工具栏图标上显示实时次数，完成后清空。
 * @param {number} tabId 标签页 id
 * @param {{running: boolean, count: number}} entry 任务状态
 */
function updateBadge(tabId, entry) {
  const text = entry.running ? (entry.count > 999 ? '999+' : String(entry.count)) : '';
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
}

/**
 * 把内存状态写入存储；运行中的任务按固定间隔节流，结束时立即落盘。
 * @param {boolean} force 是否跳过节流
 */
function persist(force) {
  const now = Date.now();
  if (!force && now - lastPersistAt < PERSIST_INTERVAL_MS) return;
  lastPersistAt = now;
  chrome.storage.local.set({ [STATES_KEY]: states }).catch(() => {});
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (!message || message.type !== 'clicker:progress') return;

  const tabId = sender.tab && typeof sender.tab.id === 'number' ? sender.tab.id : message.tabId;
  if (typeof tabId !== 'number') return;

  states[String(tabId)] = {
    tabId,
    selector: message.selector,
    total: message.total,
    interval: message.interval,
    count: message.count,
    misses: message.misses,
    running: Boolean(message.running),
    reason: message.reason || null,
    updatedAt: Date.now(),
  };

  updateBadge(tabId, states[String(tabId)]);
  persist(!states[String(tabId)].running);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (!states[String(tabId)]) return;
  delete states[String(tabId)];
  persist(true);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  const entry = states[String(tabId)];
  if (!entry || !entry.running || changeInfo.status !== 'loading') return;

  entry.running = false;
  entry.reason = 'navigation';
  entry.updatedAt = Date.now();
  updateBadge(tabId, entry);
  persist(true);
});
