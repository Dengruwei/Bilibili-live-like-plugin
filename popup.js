/**
 * 弹窗逻辑：读取配置并注入页面内的计时器。
 * 计时器跑在页面里，弹窗关掉后任务继续；进度通过 runtime 消息回传。
 */

const DEFAULT_SETTINGS = { selector: '.like-btn', total: 40, interval: 500 };
const SETTINGS_KEY = 'clickerSettings';
const STATES_KEY = 'clickerStates';
const PICKED_KEY = 'pickedSelector';
const MIN_INTERVAL = 50;
const MAX_INTERVAL = 600000;
const MAX_TOTAL = 100000;

const $ = (id) => document.getElementById(id);

const ui = {
  site: $('site'),
  selector: $('selector'),
  probe: $('probe'),
  pick: $('pick'),
  help: $('help'),
  count: $('count'),
  interval: $('interval'),
  presets: Array.from(document.querySelectorAll('[data-count], [data-interval]')),
  toggle: $('toggle'),
  progress: $('progress'),
  progressText: $('progressText'),
  eta: $('eta'),
  barFill: $('barFill'),
  status: $('status'),
};

let tab = null;
let supported = false;
let state = { running: false, count: 0, total: 0, misses: 0, interval: DEFAULT_SETTINGS.interval, reason: null };
let saveTimer = 0;

/* ------------------------------------------------------------------ */
/* 注入到页面里执行的函数：必须完全自包含，不能引用本文件的其他变量。   */
/* ------------------------------------------------------------------ */

/**
 * 在页面中启动点击循环，同一页面重复启动会先停掉上一个循环。
 * @param {{selector: string, total: number, interval: number, tabId: number}} options 运行参数
 * @returns {{ok: true, tabId: number}} 启动结果
 */
function pageClicker(options) {
  const selector = options.selector;
  const total = options.total;
  const interval = options.interval;
  const tabId = options.tabId;

  const previous = window.__dshAutoClicker;
  if (previous && typeof previous.stop === 'function') previous.stop();

  let count = 0;
  let misses = 0;
  let timer = null;
  let running = true;

  const canMessage = typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.sendMessage === 'function';

  /** 深层查找：穿透 open Shadow DOM 与同源 iframe。 */
  function deepFind(selector) {
    const queue = [document];
    let guard = 0;

    while (queue.length > 0 && guard < 500) {
      guard += 1;
      const root = queue.shift();

      let hit = null;
      try {
        hit = root.querySelector(selector);
      } catch (error) {
        hit = null;
      }
      if (hit) return hit;

      let elements = [];
      try {
        elements = root.querySelectorAll('*');
      } catch (error) {
        elements = [];
      }
      for (let i = 0; i < elements.length; i += 1) {
        if (elements[i].shadowRoot) queue.push(elements[i].shadowRoot);
      }

      let frames = [];
      try {
        frames = root.querySelectorAll('iframe, frame');
      } catch (error) {
        frames = [];
      }
      for (let i = 0; i < frames.length; i += 1) {
        let doc = null;
        try {
          doc = frames[i].contentDocument;
        } catch (error) {
          doc = null;
        }
        if (doc) queue.push(doc);
      }
    }

    return null;
  }

  const deepCache = { at: 0, el: null };

  /** 先走 document.querySelector 快路径，落空时再限频做深度查找。 */
  function findTarget(selector) {
    let direct = null;
    try {
      direct = document.querySelector(selector);
    } catch (error) {
      direct = null;
    }
    if (direct) return direct;

    if (deepCache.el && deepCache.el.isConnected) return deepCache.el;

    const now = Date.now();
    if (now - deepCache.at < 1000) return null;

    deepCache.at = now;
    deepCache.el = deepFind(selector);
    return deepCache.el;
  }

  function report(reason) {
    if (!canMessage) return;
    try {
      const pending = chrome.runtime.sendMessage({
        type: 'clicker:progress',
        tabId: tabId,
        selector: selector,
        total: total,
        interval: interval,
        count: count,
        misses: misses,
        running: running,
        reason: reason || null,
      });
      if (pending && typeof pending.catch === 'function') pending.catch(() => {});
    } catch (error) {
      // 扩展被重新加载后页面里的上下文会失效，此时停止上报即可
    }
  }

  function stop(reason) {
    if (!running) return;
    running = false;
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    if (canMessage && chrome.runtime.onMessage) {
      chrome.runtime.onMessage.removeListener(onStopMessage);
    }
    report(reason || 'stopped');
  }

  function onStopMessage(message) {
    if (message && message.type === 'clicker:stop') stop('stopped');
  }

  window.__dshAutoClicker = {
    stop: function () {
      stop('stopped');
    },
    isRunning: function () {
      return running;
    },
    get count() {
      return count;
    },
    get total() {
      return total;
    },
  };

  if (canMessage && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener(onStopMessage);
  }

  report('started');

  timer = setInterval(function () {
    if (!running) return;

    const button = findTarget(selector);

    if (button) {
      try {
        button.click();
      } catch (error) {
        misses += 1;
      }
    } else {
      misses += 1;
    }

    count += 1;

    if (count >= total) {
      stop('completed');
      return;
    }

    report();
  }, interval);

  return { ok: true, tabId: tabId };
}

/**
 * 页面内元素拾取器：悬停高亮、点击后生成 CSS 选择器并写入 storage。
 * 与 DevTools 的选元素模式类似，额外支持 open Shadow DOM 与同源 iframe。
 * @param {number} tabId 标签页 id
 * @returns {{ok: true}} 启动结果
 */
function pagePicker(tabId) {
  const existing = window.__dshPicker;
  if (existing && typeof existing.stop === 'function') existing.stop();

  const Z = 2147483647;
  const nodes = [];

  function make(tag, name, style) {
    const node = document.createElement(tag);
    node.setAttribute('data-dsh-picker', name);
    node.style.cssText = style;
    nodes.push(node);
    document.documentElement.appendChild(node);
    return node;
  }

  const font = '-apple-system,"Segoe UI","Microsoft YaHei",system-ui,sans-serif';
  const overlay = make(
    'div',
    'overlay',
    `position:fixed;inset:0;z-index:${Z};cursor:crosshair;background:rgba(17,19,35,0.04);`,
  );
  const box = make(
    'div',
    'box',
    `position:fixed;display:none;z-index:${Z};pointer-events:none;border:2px solid #5B57E0;` +
      'background:rgba(91,87,224,0.12);border-radius:3px;box-sizing:border-box;',
  );
  const tip = make(
    'div',
    'tip',
    `position:fixed;display:none;z-index:${Z};pointer-events:none;max-width:340px;padding:5px 9px;` +
      `border-radius:7px;background:#111322;color:#fff;font:12px/1.4 ${font};` +
      'box-shadow:0 6px 18px rgba(0,0,0,0.35);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;',
  );
  const bar = make(
    'div',
    'bar',
    `position:fixed;left:50%;top:14px;transform:translateX(-50%);z-index:${Z};pointer-events:none;` +
      `padding:8px 16px;border-radius:999px;background:rgba(17,19,35,0.92);color:#fff;font:13px/1.4 ${font};` +
      'box-shadow:0 8px 24px rgba(0,0,0,0.3);white-space:nowrap;',
  );
  bar.textContent = '点击要自动点击的元素 · Esc 取消';

  const toast = make(
    'div',
    'toast',
    `position:fixed;display:none;left:50%;bottom:24px;transform:translateX(-50%);z-index:${Z};pointer-events:none;` +
      `padding:9px 16px;border-radius:10px;background:#15803d;color:#fff;font:13px/1.4 ${font};` +
      'box-shadow:0 10px 24px rgba(0,0,0,0.3);max-width:min(560px,90vw);',
  );

  let current = null;
  let currentSelector = '';

  function escapeIdent(value) {
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
    return String(value).replace(/([^a-zA-Z0-9_-])/g, '\\$1');
  }

  function quoteValue(value) {
    return "'" + String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
  }

  function uniqueIn(root, selector) {
    try {
      return root.querySelectorAll(selector).length === 1;
    } catch (error) {
      return false;
    }
  }

  function stableClasses(node) {
    const picked = [];
    const list = node.classList ? Array.from(node.classList) : [];
    for (let i = 0; i < list.length && picked.length < 2; i += 1) {
      const name = list[i];
      if (!name || name.length > 40) continue;
      if (/^[a-z]+-[a-z0-9]{6,}$/i.test(name)) continue;
      if (/^[a-z0-9_-]{20,}$/i.test(name)) continue;
      picked.push(name);
    }
    return picked;
  }

  /** 生成在当前根（document / shadow root）内唯一的选择器。 */
  function selectorFor(node) {
    const root = node.getRootNode ? node.getRootNode() : document;
    const tag = node.tagName.toLowerCase();

    if (node.id) {
      const idSelector = '#' + escapeIdent(node.id);
      if (uniqueIn(root, idSelector)) return idSelector;
    }

    const attributes = ['data-testid', 'data-test', 'data-qa', 'data-cy', 'aria-label', 'name', 'role'];
    for (let i = 0; i < attributes.length; i += 1) {
      const value = node.getAttribute(attributes[i]);
      if (!value || value.length > 40) continue;
      const attributeSelector = tag + '[' + attributes[i] + '=' + quoteValue(value) + ']';
      if (uniqueIn(root, attributeSelector)) return attributeSelector;
    }

    const parts = [];
    let cursor = node;
    let guard = 0;

    while (cursor && cursor.nodeType === 1 && cursor !== root && guard < 8) {
      guard += 1;
      if (cursor.id) {
        const idSelector = '#' + escapeIdent(cursor.id);
        if (uniqueIn(root, idSelector)) {
          parts.unshift(idSelector);
          break;
        }
      }

      let part = cursor.tagName.toLowerCase();
      const classes = stableClasses(cursor);
      if (classes.length > 0) part += '.' + classes.map(escapeIdent).join('.');

      const parent = cursor.parentElement;
      if (parent) {
        let index = 1;
        let total = 0;
        const children = parent.children;
        for (let i = 0; i < children.length; i += 1) {
          if (children[i].tagName === cursor.tagName) {
            total += 1;
            if (children[i] === cursor) index = total;
          }
        }
        if (total > 1) part += ':nth-of-type(' + index + ')';
      }

      parts.unshift(part);
      if (uniqueIn(root, parts.join(' > '))) break;
      cursor = cursor.parentElement;
    }

    return parts.join(' > ');
  }

  function rectInTop(node) {
    let rect = node.getBoundingClientRect();
    let view = node.ownerDocument.defaultView;
    let guard = 0;
    while (view && view.frameElement && guard < 8) {
      guard += 1;
      const frame = view.frameElement;
      const frameRect = frame.getBoundingClientRect();
      rect = {
        left: rect.left + frameRect.left + frame.clientLeft,
        top: rect.top + frameRect.top + frame.clientTop,
        width: rect.width,
        height: rect.height,
      };
      view = frame.ownerDocument.defaultView;
    }
    return rect;
  }

  /** 取坐标处最深的元素，跳过自己，并穿透 Shadow DOM 与同源 iframe。 */
  function findAt(x, y, scope, depth) {
    if (depth > 8) return null;

    let stack = [];
    try {
      stack = scope.elementsFromPoint ? scope.elementsFromPoint(x, y) : [scope.elementFromPoint(x, y)];
    } catch (error) {
      stack = [];
    }

    let node = null;
    for (let i = 0; i < stack.length; i += 1) {
      if (stack[i].hasAttribute && stack[i].hasAttribute('data-dsh-picker')) continue;
      node = stack[i];
      break;
    }
    if (!node) return null;

    if (node.shadowRoot) {
      const inner = findAt(x, y, node.shadowRoot, depth + 1);
      if (inner) return inner;
    }

    if (node.tagName === 'IFRAME' || node.tagName === 'FRAME') {
      let doc = null;
      try {
        doc = node.contentDocument;
      } catch (error) {
        doc = null;
      }
      if (doc) {
        const rect = node.getBoundingClientRect();
        const inner = findAt(x - rect.left - node.clientLeft, y - rect.top - node.clientTop, doc, depth + 1);
        if (inner) return inner;
      }
    }

    return node;
  }

  /** 悬停到按钮内部的图标/文字时，向上收敛到按钮本身。 */
  function resolveTarget(node) {
    if (!node || node.nodeType !== 1) return node;
    try {
      const clickable = node.closest('button, a, [role="button"], [role="link"]');
      if (clickable) return clickable;
    } catch (error) {
      // 跨根节点时 closest 可能抛错，保持原元素
    }
    return node;
  }

  function place() {
    if (!current || current === document.documentElement) return;
    const rect = rectInTop(current);

    box.style.left = rect.left + 'px';
    box.style.top = rect.top + 'px';
    box.style.width = rect.width + 'px';
    box.style.height = rect.height + 'px';

    const maxTip = Math.max(160, Math.min(340, window.innerWidth - 24));
    tip.style.maxWidth = maxTip + 'px';
    const tipRect = tip.getBoundingClientRect();
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - tipRect.width - 8));
    let top = rect.top - tipRect.height - 8;
    if (top < 8) top = rect.top + rect.height + 8;
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
  }

  function onMove(event) {
    const raw = findAt(event.clientX, event.clientY, document, 0);
    if (!raw) return;

    const target = resolveTarget(raw);
    if (target === current) return;

    current = target;
    const isRoot = target === document.documentElement || target === document.body;
    currentSelector = isRoot ? '' : selectorFor(target);
    tip.textContent = currentSelector || target.tagName.toLowerCase();
    box.style.display = isRoot ? 'none' : 'block';
    tip.style.display = 'block';
    place();
  }

  function onClick(event) {
    event.preventDefault();
    event.stopPropagation();
    if (event.stopImmediatePropagation) event.stopImmediatePropagation();

    if (!current || !currentSelector) {
      cleanup();
      return;
    }

    const selector = currentSelector;
    try {
      const pending = chrome.storage.local.set({
        pickedSelector: { tabId: tabId, selector: selector, at: Date.now() },
      });
      if (pending && typeof pending.catch === 'function') pending.catch(() => {});
    } catch (error) {
      // 扩展上下文失效时不写入，弹窗重新打开会读取旧值
    }

    toast.textContent = '已选中 ' + selector + '，打开扩展即可使用';
    toast.style.display = 'block';
    cleanup(true);

    setTimeout(function () {
      toast.remove();
    }, 4000);
  }

  function onKey(event) {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    cleanup();
  }

  function cleanup(keepToast) {
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', place, true);
    window.removeEventListener('resize', place);
    overlay.removeEventListener('mousemove', onMove);
    overlay.removeEventListener('click', onClick);

    for (let i = 0; i < nodes.length; i += 1) {
      if (keepToast && nodes[i] === toast) continue;
      nodes[i].remove();
    }

    if (window.__dshPicker) delete window.__dshPicker;
  }

  overlay.addEventListener('mousemove', onMove);
  overlay.addEventListener('click', onClick);
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('scroll', place, true);
  window.addEventListener('resize', place);

  window.__dshPicker = { stop: cleanup };

  return { ok: true };
}

/**
 * 统计选择器在页面各层级的匹配数量：主文档、Shadow DOM、同源 iframe。
 * @param {string} selector CSS 选择器
 * @returns {{doc: number, shadow: number, frame: number, shadowRoots: number, frames: number, crossOrigin: number}}
 */
function probeMatches(selector) {
  const stats = { doc: 0, shadow: 0, frame: 0, shadowRoots: 0, frames: 0, crossOrigin: 0 };
  const queue = [{ root: document, kind: 'doc' }];
  let guard = 0;

  while (queue.length > 0 && guard < 500) {
    guard += 1;
    const entry = queue.shift();

    let matches = [];
    try {
      matches = entry.root.querySelectorAll(selector);
    } catch (error) {
      matches = [];
    }
    stats[entry.kind] += matches.length;

    let elements = [];
    try {
      elements = entry.root.querySelectorAll('*');
    } catch (error) {
      elements = [];
    }
    for (let i = 0; i < elements.length; i += 1) {
      if (elements[i].shadowRoot) {
        stats.shadowRoots += 1;
        queue.push({ root: elements[i].shadowRoot, kind: entry.kind === 'frame' ? 'frame' : 'shadow' });
      }
    }

    let frames = [];
    try {
      frames = entry.root.querySelectorAll('iframe, frame');
    } catch (error) {
      frames = [];
    }
    for (let i = 0; i < frames.length; i += 1) {
      stats.frames += 1;
      let doc = null;
      try {
        doc = frames[i].contentDocument;
      } catch (error) {
        doc = null;
      }
      if (doc) queue.push({ root: doc, kind: 'frame' });
      else stats.crossOrigin += 1;
    }
  }

  return stats;
}

/* ------------------------------------------------------------------ */
/* 弹窗状态与渲染                                                      */
/* ------------------------------------------------------------------ */

async function probeHandle() {
  if (!tab) return null;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const handle = window.__dshAutoClicker;
        if (!handle) return { exists: false };
        return { exists: true, running: Boolean(handle.isRunning()), count: handle.count, total: handle.total };
      },
    });
    return results && results[0] ? results[0].result : null;
  } catch (error) {
    return null;
  }
}

function describeSite(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname || parsed.protocol.replace(':', '');
  } catch (error) {
    return '当前标签页';
  }
}

function isValidSelector(selector) {
  if (!selector) return false;
  try {
    document.createDocumentFragment().querySelector(selector);
    return true;
  } catch (error) {
    return false;
  }
}

function formatDuration(ms) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest > 0 ? `${minutes} 分 ${rest} 秒` : `${minutes} 分`;
}

function describeResult(current) {
  const misses = current.misses > 0 ? `（其中 ${current.misses} 次没找到目标）` : '';
  switch (current.reason) {
    case 'completed':
      return `✅ 已完成 ${current.total} 次点击${misses}`;
    case 'stopped':
      return `已停止，共点击 ${current.count} 次${misses}`;
    case 'navigation':
      return '页面发生了跳转，任务已中断。';
    case 'interrupted':
      return '任务已中断：页面刷新或扩展被重新加载。';
    default:
      return `已结束，共点击 ${current.count} 次${misses}`;
  }
}

function render() {
  const total = state.total || 0;
  const count = state.count || 0;
  const percent = total > 0 ? Math.min(100, (count / total) * 100) : 0;

  ui.progress.hidden = !state.running && count === 0;
  ui.progressText.textContent = `${count} / ${total}`;
  ui.barFill.style.width = `${percent}%`;
  ui.eta.textContent = state.running ? `约 ${formatDuration((total - count) * state.interval)}` : '';

  ui.toggle.textContent = state.running ? '停止点击' : '开始点击';
  ui.toggle.classList.toggle('is-stop', state.running);

  const locked = state.running;
  ui.selector.disabled = locked;
  ui.count.disabled = locked;
  ui.interval.disabled = locked;
  ui.probe.disabled = locked || !supported;
  ui.pick.disabled = locked || !supported;
  ui.presets.forEach((button) => {
    button.disabled = locked;
  });
}

function setStatus(text, kind) {
  ui.status.textContent = text;
  ui.status.dataset.kind = kind || 'idle';
}

/* ------------------------------------------------------------------ */
/* 启动 / 停止                                                         */
/* ------------------------------------------------------------------ */

function readConfig() {
  const selector = ui.selector.value.trim() || DEFAULT_SETTINGS.selector;
  if (!isValidSelector(selector)) {
    return { error: `选择器无效：${selector}` };
  }

  const total = Number.parseInt(ui.count.value, 10);
  if (!Number.isInteger(total) || total < 1 || total > MAX_TOTAL) {
    return { error: `点击次数需为 1–${MAX_TOTAL} 之间的整数` };
  }

  const interval = Number.parseInt(ui.interval.value, 10);
  if (!Number.isInteger(interval) || interval < MIN_INTERVAL || interval > MAX_INTERVAL) {
    return { error: `间隔需为 ${MIN_INTERVAL}–${MAX_INTERVAL} 毫秒` };
  }

  return { selector, total, interval };
}

async function start() {
  if (!tab || !supported) return;

  const config = readConfig();
  if (config.error) {
    setStatus(config.error, 'error');
    return;
  }

  saveSettings();
  ui.toggle.disabled = true;

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: pageClicker,
      args: [{ selector: config.selector, total: config.total, interval: config.interval, tabId: tab.id }],
    });
  } catch (error) {
    ui.toggle.disabled = false;
    setStatus(`启动失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    return;
  }

  ui.toggle.disabled = false;
  state = {
    running: true,
    count: 0,
    total: config.total,
    misses: 0,
    interval: config.interval,
    reason: null,
  };
  render();
  setStatus(`正在点击 ${config.selector}，共 ${config.total} 次，每 ${config.interval} 毫秒一次。`, 'running');
}

async function stop() {
  if (!tab) return;
  ui.toggle.disabled = true;

  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'clicker:stop' });
  } catch (error) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const handle = window.__dshAutoClicker;
          if (handle && handle.isRunning()) handle.stop();
        },
      });
    } catch (innerError) {
      // 页面已经不可访问（例如已关闭），无需额外处理
    }
  }

  ui.toggle.disabled = false;
  state = { ...state, running: false, reason: 'stopped' };
  render();
  setStatus(describeResult(state), 'idle');
}

/* ------------------------------------------------------------------ */
/* 事件绑定                                                            */
/* ------------------------------------------------------------------ */

function saveSettings() {
  const config = readConfig();
  if (config.error) return;
  chrome.storage.local.set({
    [SETTINGS_KEY]: { selector: config.selector, total: config.total, interval: config.interval },
  }).catch(() => {});
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveSettings, 300);
}

ui.toggle.addEventListener('click', () => {
  if (state.running) {
    stop();
  } else {
    start();
  }
});

async function probeSelection() {
  if (!tab || !supported) return;
  const selector = ui.selector.value.trim();
  if (!isValidSelector(selector)) {
    ui.help.textContent = '选择器语法无效';
    ui.help.classList.add('is-warn');
    return;
  }

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: probeMatches,
      args: [selector],
    });
    const stats = results && results[0] ? results[0].result : null;

    if (!stats) {
      ui.help.textContent = '检测失败，请刷新页面后重试';
      ui.help.classList.add('is-warn');
      return;
    }

    const total = stats.doc + stats.shadow + stats.frame;
    if (total > 0) {
      const parts = [];
      if (stats.doc > 0) parts.push(`主文档 ${stats.doc}`);
      if (stats.shadow > 0) parts.push(`Shadow DOM ${stats.shadow}`);
      if (stats.frame > 0) parts.push(`iframe ${stats.frame}`);
      ui.help.textContent = `匹配到 ${total} 个元素（${parts.join('，')}）`;
      ui.help.classList.remove('is-warn');
      return;
    }

    if (stats.crossOrigin > 0) {
      ui.help.textContent = `没有匹配元素；页面有 ${stats.crossOrigin} 个跨域 iframe，目标可能在其中（扩展读不到）`;
    } else if (stats.frames > 0) {
      ui.help.textContent = '没有匹配元素：可访问的 iframe 里也没有，请检查选择器';
    } else {
      ui.help.textContent = '没有匹配元素：请检查选择器，或等元素加载后再检测';
    }
    ui.help.classList.add('is-warn');
  } catch (error) {
    ui.help.textContent = '无法访问当前页面，请刷新后重试';
    ui.help.classList.add('is-warn');
  }
}

ui.probe.addEventListener('click', probeSelection);

ui.pick.addEventListener('click', async () => {
  if (!tab || !supported) return;
  ui.pick.disabled = true;

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: pagePicker,
      args: [tab.id],
    });
  } catch (error) {
    ui.pick.disabled = false;
    setStatus(`无法启动拾取：${error instanceof Error ? error.message : String(error)}`, 'error');
    return;
  }

  // 关掉弹窗，用户的下一次点击才会落到页面上
  window.close();
});

ui.presets.forEach((button) => {
  button.addEventListener('click', () => {
    const count = button.dataset.count;
    const interval = button.dataset.interval;
    if (count) ui.count.value = count;
    if (interval) ui.interval.value = interval;
    scheduleSave();
  });
});

[ui.selector, ui.count, ui.interval].forEach((input) => {
  input.addEventListener('input', scheduleSave);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !state.running) start();
  });
});

chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.type !== 'clicker:progress') return;
  if (!tab || message.tabId !== tab.id) return;

  state = {
    running: Boolean(message.running),
    count: message.count || 0,
    total: message.total || state.total,
    misses: message.misses || 0,
    interval: message.interval || state.interval,
    reason: message.reason || (message.running ? null : state.reason),
  };
  render();

  if (!state.running) {
    setStatus(describeResult(state), state.reason === 'completed' ? 'ok' : 'idle');
  }
});

/* ------------------------------------------------------------------ */
/* 初始化                                                              */
/* ------------------------------------------------------------------ */

async function init() {
  const stored = await chrome.storage.local.get([SETTINGS_KEY, STATES_KEY, PICKED_KEY]);
  const settings = { ...DEFAULT_SETTINGS, ...(stored[SETTINGS_KEY] || {}) };
  ui.selector.value = settings.selector;
  ui.count.value = settings.total;
  ui.interval.value = settings.interval;

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  tab = tabs[0] || null;
  supported = Boolean(tab && typeof tab.url === 'string' && /^https?:\/\//i.test(tab.url));
  ui.site.textContent = tab ? describeSite(tab.url) : '无标签页';

  if (!supported) {
    ui.toggle.disabled = true;
    ui.probe.disabled = true;
    ui.pick.disabled = true;
    setStatus('当前页面不允许扩展运行，请切换到普通网页（http / https）后重试。', 'error');
    return;
  }

  const remembered = (stored[STATES_KEY] || {})[String(tab.id)];
  if (remembered) state = { ...state, ...remembered };

  const live = await probeHandle();
  if (live && live.exists) {
    state = { ...state, running: Boolean(live.running), count: live.count, total: live.total || state.total };
    if (!state.running && remembered && remembered.running) state.reason = 'interrupted';
  } else if (state.running) {
    // 页面里没有任务句柄：多半是刷新过，或扩展被重新加载
    state = { ...state, running: false, reason: 'interrupted' };
  }

  // 拾取结果：只在同一标签页、且是最近十分钟内选中的才采用
  let pickedNote = null;
  const picked = stored[PICKED_KEY];
  if (picked && picked.tabId === tab.id) {
    chrome.storage.local.remove(PICKED_KEY);
    if (Date.now() - picked.at < 10 * 60 * 1000) {
      ui.selector.value = picked.selector;
      pickedNote = `已拾取 ${picked.selector}`;
    }
  }

  render();

  if (state.running) {
    setStatus(
      `正在点击 ${state.selector || ui.selector.value}…已执行 ${state.count} / ${state.total} 次。`,
      'running',
    );
    return;
  }

  if (pickedNote) {
    setStatus(pickedNote, 'ok');
    await probeSelection();
    return;
  }

  if (state.reason) {
    setStatus(describeResult(state), state.reason === 'completed' ? 'ok' : 'idle');
    return;
  }

  setStatus('就绪：设置次数与间隔后点击开始。', 'idle');
}

init().catch((error) => {
  setStatus(`弹窗初始化失败：${error instanceof Error ? error.message : String(error)}`, 'error');
});
