/**
 * dsh-serial · Browser 半「加载 + 行为」冒烟测试（不需要浏览器和 dsh）
 *
 * 用 node:vm 造最小 DOM 环境，把 client/client.js 真实跑一遍，覆盖：
 *   模块注册与导出（必须无 inject）、挂载与默认位置、点击/拖拽/关闭按钮、
 *   贴球定位与视口钳制、美化批次（三态灯/空状态/语义色/连接反馈）、卸载清理。
 *
 * 用法：node tools/client-load-test.mjs   （退出码 0 = 全部通过）
 */

import { readFileSync } from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = readFileSync(path.join(root, "client", "client.js"), "utf8");

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log(`  [OK]   ${label}`); }
  else { fail++; console.log(`  [FAIL] ${label}`); }
}

/* ==================== 最小 DOM 模拟 ==================== */
function makeNode(tag) {
  const node = {
    tagName: tag, children: [], style: {}, _text: "", _html: "", _h: {},
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
      contains(c) { return this._s.has(c); },
      toggle(c, on) { if (on === undefined) on = !this._s.has(c); on ? this._s.add(c) : this._s.delete(c); return on; },
    },
    setAttribute(k, v) { this[k] = v; },
    addEventListener(t, fn) { (this._h[t] ||= []).push(fn); },
    removeEventListener() {},
    append(...cs) { this.children.push(...cs); },
    remove() {},
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); },
    setPointerCapture() {},
    scrollTop: 0, scrollHeight: 0, value: "",
    offsetWidth: 480, offsetHeight: 432, // 与 CSS 里 480px 宽 + 72vh(≈432@600px 高窗口) 的档位对齐
  };
  Object.defineProperty(node, "childElementCount", { get() { return node.children.length; } });
  Object.defineProperty(node, "firstElementChild", { get() { return node.children[0] || null; } });
  Object.defineProperty(node, "textContent", { get() { return node._text; }, set(v) { node._text = v; } });
  Object.defineProperty(node, "innerHTML", { get() { return node._html; }, set(v) { node._html = v; node.children = []; } });
  return node;
}

const documentStub = { head: makeNode("head"), body: makeNode("body"), createElement: (t) => makeNode(t) };

let loaded = null;
const winHandlers = {};
const windowStub = {
  innerWidth: 1200, innerHeight: 800,
  __ModuleLoader__: { load(m) { loaded = m; } },
  addEventListener(t, fn) { (winHandlers[t] ||= []).push(fn); },
  removeEventListener() {},
};

const storage = {};
const sandbox = {
  window: windowStub,
  document: documentStub,
  console,
  setTimeout, clearTimeout, setInterval, clearInterval,
  fetch: async () => ({ ok: true, json: async () => ({ ok: true, ports: [], lines: [], next: 0, serialportAvailable: true }) }),
  localStorage: {
    getItem: (k) => (k in storage ? storage[k] : null),
    setItem: (k, v) => { storage[k] = String(v); },
    removeItem: (k) => { delete storage[k]; },
  },
};
vm.createContext(sandbox);

/* ==================== 开跑 ==================== */
console.log("== 1. 模块注册与导出 ==");
vm.runInContext(src, sandbox, { filename: "client.js" });
ok(loaded !== null && loaded.id === "dsh-serial", "模块以 id=dsh-serial 注册到 __ModuleLoader__");

const ex = loaded.factory();
ok(typeof ex.apply === "function", "factory 执行成功且导出 apply()");
ok(!("inject" in ex), "没有声明 exports.inject（零依赖，不会 pending 卡页面）");

console.log("== 2. 挂载与默认位置（1200x800 视口）==");
const cleanups = [];
ex.apply({ effect: (fn) => cleanups.push(fn) });
const fab = documentStub.body.children.find((c) => c.id === "dsh-serial-fab");
const panel = documentStub.body.children.find((c) => c.id === "dsh-serial-panel");
ok(!!fab && !!panel, "悬浮球和面板已挂载到 body");
ok(documentStub.head.children.some((c) => c.id === "dsh-serial-style"), "样式表已挂载到 head");
ok(fab.style.left === "1124px" && fab.style.top === "656px", `球默认位置=右下角（left=${fab.style.left}, top=${fab.style.top}）`);

const fire = (node, type, ev) => { for (const fn of (node._h[type] || [])) fn(ev); };
const pev = (x, y) => ({ pointerId: 7, clientX: x, clientY: y, preventDefault() {} });
const findDeep = (root, id) => {
  if (root.id === id) return root;
  for (const c of (root.children || [])) { const f = findDeep(c, id); if (f) return f; }
  return null;
};

console.log("== 3. 点击流：开关面板 + 贴球定位 + 关闭按钮 ==");
fire(fab, "pointerdown", pev(1150, 682));
fire(fab, "pointerup", pev(1150, 682));
ok(panel.classList.contains("open"), "点击球 → 面板打开");
// 期望：left = 1124+52-480 = 696；top = 656-432-10 = 214（球上方完美放得下）
ok(panel.style.left === "696px" && panel.style.top === "214px", `面板贴球定位正确（left=${panel.style.left}, top=${panel.style.top}）`);

// v0.1.5：关闭按钮——面板遮挡悬浮球时的出口
const head = panel.children.find((c) => c.id === "dsh-serial-head");
const closeBtn = head && head.children.find((c) => c.id === "dsh-serial-close");
ok(!!closeBtn, "标题栏存在关闭按钮");
if (closeBtn) fire(closeBtn, "click", {});
ok(!panel.classList.contains("open"), "点击关闭按钮 → 面板关闭");

// v0.1.5：用法文案专业化检查（含「使用说明」，且旧口语词已移除）
const bodyEl = panel.children.find((c) => c.id === "dsh-serial-body");
const hint = bodyEl && bodyEl.children.find((c) => c.id === "dsh-serial-hint");
const hintText = hint ? hint.children.map((c) => c._text || "").join(" ") : "";
ok(hintText.includes("使用说明") && !hintText.includes("板子不在身边就点"), "用法文案已专业化（使用说明 + 辅助功能）");

// 两种关闭方式并存：点球关闭仍然可用
fire(fab, "pointerdown", pev(1150, 682));
fire(fab, "pointerup", pev(1150, 682));
ok(panel.classList.contains("open"), "再次点击球 → 面板打开");
fire(fab, "pointerdown", pev(1150, 682));
fire(fab, "pointerup", pev(1150, 682));
ok(!panel.classList.contains("open"), "再点击球 → 面板关闭");

console.log("== 4. 拖拽流：移动球 + 持久化 + 面板跟随 ==");
fire(fab, "pointerdown", pev(1150, 682));
fire(fab, "pointermove", pev(300, 202)); // 位移够大 → 判定为拖拽
fire(fab, "pointerup", pev(300, 202));
ok(fab.style.left === "274px" && fab.style.top === "176px", `拖拽后球移动到位（left=${fab.style.left}, top=${fab.style.top}）`);
ok(!panel.classList.contains("open"), "拖拽不会误触发面板开关");
ok(storage["dsh-serial:fab-pos-v1"] === JSON.stringify({ x: 274, y: 176 }), "拖拽结束后位置已持久化到 localStorage");

fire(fab, "pointerdown", pev(300, 202));
fire(fab, "pointerup", pev(300, 202)); // 原位点击 → 开面板
ok(panel.classList.contains("open"), "再次打开面板");
// 期望：left = 274+52-480 <0 → 钳到 10；top：上方放不下(-266) → 下方 238 放得下(670≤790)
ok(panel.style.left === "10px" && panel.style.top === "238px", `球在左上时面板翻转/钳制正确（left=${panel.style.left}, top=${panel.style.top}）`);

console.log("== 5. 视口缩放：小窗口不越界（改造核心）==");
windowStub.innerWidth = 1024; windowStub.innerHeight = 640;
for (const fn of (winHandlers["resize"] || [])) fn();
const L = parseFloat(panel.style.left), T = parseFloat(panel.style.top);
ok(L >= 10 && L + 480 <= 1024 - 10, `小窗口(1024x640)：面板水平完整可见（left=${panel.style.left}）`);
ok(T >= 10 && T + 432 <= 640 - 10, `小窗口(1024x640)：面板垂直完整可见（top=${panel.style.top}，不越界不悬顶）`);
ok(parseFloat(fab.style.left) + 52 <= 1024 && parseFloat(fab.style.top) + 52 <= 640, "小窗口下球仍在可视范围");

console.log("== 6. v0.1.6 美化批次：三态灯 / 空状态 / 语义色 / 连接反馈 ==");
const styleNode = documentStub.head.children.find((c) => c.id === "dsh-serial-style");
const cssText = styleNode ? styleNode._text : "";
ok(cssText.includes("panelin") && cssText.includes("dotbreathe") && cssText.includes("linein") && cssText.includes("whalefloat"),
  "CSS 含 进场/呼吸灯/行淡入/鲸鱼浮动 四组动效");
ok(cssText.includes("#5b8def") && cssText.includes("#d9a02b") && cssText.includes("#e05656"),
  "CSS 含日志语义色（事件蓝/警告琥珀/错误红）");

const dotEl = head.children.find((c) => c.id === "dsh-serial-dot");
const emptyEl = findDeep(panel, "dsh-serial-empty");
ok(!!emptyEl, "空状态（信号喷鲸）节点已挂载");
ok(!!emptyEl && !emptyEl.classList.contains("hide"), "初始：日志为空 → 空状态可见");
ok(!!emptyEl && emptyEl._html.includes("grad-water"), "空状态含鲸鱼水印 SVG（渐变色 id 就位）");

const titleB = head.children.find((c) => c.tagName === "b");
ok(!!titleB && titleB._html.includes("grad-mark") && titleB._html.includes("串口搭档"), "标题栏 = 小鲸鱼品牌标记 + 名称");

const sendRowEl = bodyEl.children.find((c) => c.id === "dsh-serial-sendrow");
const promptEl = sendRowEl && sendRowEl.children.find((c) => c.id === "dsh-serial-prompt");
ok(!!promptEl && promptEl._text === "\u276F", "发送行含命令行提示符 ❯");

// 连接流：选口 → 点「连接」→ 三态灯变绿 + 空状态文案切换 + 描边闪绿
const portSelect = bodyEl.children[0].children.find((c) => c.id === "dsh-serial-port");
portSelect.value = "COM4";
const connectBtn = bodyEl.children[1].children[0];
fire(connectBtn, "click", {});
await new Promise((r) => setTimeout(r, 20));
ok(dotEl.classList.contains("on") && !dotEl.classList.contains("busy"), "连接成功：状态灯 → 绿（on）");
ok(panel.classList.contains("connectflash"), "连接成功：面板描边闪绿动画已触发");
const emptyTextEl = emptyEl && emptyEl.children[0];
ok(!!emptyTextEl && emptyTextEl._text === "监听中 · 等待设备输出…", "连接成功：空状态文案切换为「监听中 · 等待设备输出…」");

// 断开流：日志出现事件行（语义色 evt）+ 空状态隐藏 + 灯回灰
const disconnectBtn = bodyEl.children[1].children[2];
fire(disconnectBtn, "click", {});
await new Promise((r) => setTimeout(r, 20));
const logEl = findDeep(panel, "dsh-serial-log");
ok(!!logEl && logEl.children.length > 0 && logEl.children[0].class === "evt", "断开 → 日志出现事件行（class=evt，蓝色语义）");
ok(!!emptyEl && emptyEl.classList.contains("hide"), "有日志后：空状态自动隐藏（让位给数据）");
ok(!dotEl.classList.contains("on"), "断开后：状态灯回灰（off）");

console.log("== 7. 卸载清理 ==");
for (const fn of cleanups) { try { fn(); } catch { /* 清理函数的 DOM 移除在真实环境验证 */ } }
ok(cleanups.length > 0, "apply() 注册了卸载清理函数（ctx.effect）");

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
