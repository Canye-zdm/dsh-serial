/**
 * dsh-serial · 模拟加载测试（不需要启动 dsh）
 *
 * 用 mock ctx 驱动真实的 apply()，验证：
 *   1. 插件模块加载、apply 执行
 *   2. 两个 AI 工具注册且结构完整（execute 能摸到串口层）
 *   3. 六个 HTTP 路由注册
 *   4. 路由行为实测：安全检查（Host / 同源）、演示模式端到端、事件留痕
 *   5. 服务引擎直测：读取窗口、游标自愈、告警、失败路径、并发串行化
 *
 * 用法：node tools/mock-load-test.mjs   （退出码 0 = 全部通过）
 */

import { EventEmitter } from "node:events";
import { SerialPortService } from "../lib/service.js";

// ---------- 1. 加载插件模块 ----------
const url = new URL("../lib/index.js", import.meta.url).href;
const mod = await import(url);

console.log("[1] 模块导出:", Object.keys(mod).join(", "));
if (mod.name !== "dsh-serial") throw new Error("插件名不对: " + mod.name);
if (typeof mod.apply !== "function") throw new Error("缺少 apply 函数");
console.log("    ✓ name =", mod.name, " inject =", JSON.stringify(mod.inject));

// ---------- 2. 构造 mock ctx 并调用 apply ----------
const registeredTools = []; // 捕获 ctx.tools.register
const registeredRoutes = []; // 捕获 ctx.webServer.register

const mockServer = {
  register: (route) => {
    registeredRoutes.push(route);
    return () => {}; // disposer
  },
};

const mockCtx = {
  tools: { register: (tool) => registeredTools.push(tool) },
  effect: (fn, label) => console.log("    ✓ effect 注册:", label),
  // 模拟"webServer 服务存在"——立刻回调，把 mock 服务交给插件
  inject: (names, cb) => {
    console.log("    ✓ inject 等待:", JSON.stringify(names), "（模拟已就绪）");
    cb({ webServer: mockServer, effect: (fn, label) => console.log("    ✓ webEffect:", label) });
  },
};

mod.apply(mockCtx);

console.log("[2] 注册的工具数量:", registeredTools.length);
for (const t of registeredTools) {
  const ok = !!(t.name && t.description && t.parameters && t.output && typeof t.execute === "function");
  console.log(`    ${ok ? "✓" : "✗"} ${t.name}`);
  if (!ok) throw new Error(`工具 ${t.name} 结构不完整`);
}

console.log("[3] 注册的 HTTP 路由数量:", registeredRoutes.length);
for (const r of registeredRoutes) {
  console.log(`    ✓ [${r.kind}] ${r.path}`);
}
if (registeredRoutes.length !== 6) throw new Error("路由数量不是 6 个！");

// ---------- 3. 用假 req/res 实测路由 ----------
function fakeRequest({ method = "GET", url = "/", headers = {}, body = null }) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = headers;
  req.destroy = () => {};
  process.nextTick(() => {
    if (body !== null) req.emit("data", Buffer.from(body, "utf8"));
    req.emit("end");
  });
  return req;
}
function fakeResponse() {
  const res = { status: 0, headers: null, body: "" };
  res.writeHead = (s, h) => { res.status = s; res.headers = h; };
  res.end = (b) => { res.body = b; };
  return res;
}
const findRoute = (sub) => registeredRoutes.find((r) => r.path === `/dsh-serial/api/${sub}`);

async function callRoute(sub, opts) {
  const route = findRoute(sub);
  if (!route) throw new Error(`找不到路由 ${sub}`);
  const req = fakeRequest(opts);
  const res = fakeResponse();
  await route.handler(req, res);
  let json = null;
  try { json = JSON.parse(res.body); } catch {}
  return { status: res.status, json };
}

console.log("[4] 路由行为实测：");

// 4a. 正常 GET ports（模拟浏览器同源请求）
let r1 = await callRoute("ports", {
  url: "/dsh-serial/api/ports",
  headers: { host: "127.0.0.1:3080" },
});
console.log(`    4a GET ports → HTTP ${r1.status}，ports=${r1.json?.ports?.length} 个${r1.status === 200 && r1.json?.ok === true ? " ✓" : " ✗"}`);
if (r1.status !== 200 || r1.json?.ok !== true) throw new Error("正常 GET 失败");

// 4b. 恶意 Host（DNS rebinding 模拟）→ 403
let r2 = await callRoute("ports", {
  url: "/dsh-serial/api/ports",
  headers: { host: "evil.example.com" },
});
console.log(`    4b 恶意 Host → HTTP ${r2.status} ${r2.json?.error || ""}${r2.status === 403 ? " ✓" : " ✗"}`);
if (r2.status !== 403) throw new Error("Host 检查失效");

// 4c. 恶意跨站 Origin 的 POST → 403（CSRF 防护仍然有效）
let r3 = await callRoute("start", {
  method: "POST",
  url: "/dsh-serial/api/start",
  headers: { host: "127.0.0.1:3080", origin: "https://evil.example.com" },
  body: JSON.stringify({ demo: true }),
});
console.log(`    4c 恶意跨站 Origin 的 POST → HTTP ${r3.status} ${r3.json?.error || ""}${r3.status === 403 ? " ✓" : " ✗"}`);
if (r3.status !== 403) throw new Error("CSRF 检查失效（跨站 Origin 未被拦截）");

// 4c2. Origin: null（沙箱 iframe / data: 文档）→ 403
let r3b = await callRoute("start", {
  method: "POST",
  url: "/dsh-serial/api/start",
  headers: { host: "127.0.0.1:3080", origin: "null" },
  body: JSON.stringify({ demo: true }),
});
console.log(`    4c2 Origin:null 的 POST → HTTP ${r3b.status}${r3b.status === 403 ? " ✓" : " ✗"}`);
if (r3b.status !== 403) throw new Error("null Origin 未被拦截");

// 4d. 无 Origin 的 POST（桌面版代理场景）→ 200
let r4 = await callRoute("start", {
  method: "POST",
  url: "/dsh-serial/api/start",
  headers: { host: "127.0.0.1:3080" }, // 模拟桌面版代理转发：origin 头被剥离
  body: JSON.stringify({ demo: true }),
});
console.log(`    4d 无 Origin 的 POST（桌面版场景）→ HTTP ${r4.status} ${JSON.stringify(r4.json)}${r4.status === 200 && r4.json?.ok ? " ✓" : " ✗"}`);
if (r4.status !== 200 || !r4.json?.ok) throw new Error("桌面版场景（无 Origin）被误伤");

// 4e. 轮询日志（等待 1 秒让演示数据出来一点）
await new Promise((r) => setTimeout(r, 1100));
let r5 = await callRoute("logs", {
  url: "/dsh-serial/api/logs?since=0",
  headers: { host: "localhost:3080" },
});
console.log(`    4e GET logs → HTTP ${r5.status}，收到 ${r5.json?.lines?.length} 行${r5.json?.lines?.length > 0 ? " ✓" : " ✗"}`);
if (!(r5.json?.lines?.length > 0)) throw new Error("演示日志没出来");

// 4f. 停止演示
let r6 = await callRoute("stop", {
  method: "POST",
  url: "/dsh-serial/api/stop",
  headers: { host: "127.0.0.1:3080", origin: "http://127.0.0.1:3080" },
  body: "{}",
});
console.log(`    4f POST stop → HTTP ${r6.status}${r6.status === 200 ? " ✓" : " ✗"}`);
if (r6.status !== 200) throw new Error("停止失败");

// 4g. 事件留痕：缓冲里应含演示启动/停止标记（面板与 AI 共享同一时间线）
let r7 = await callRoute("logs", { url: "/dsh-serial/api/logs?since=0", headers: { host: "127.0.0.1:3080" } });
const allText = (r7.json?.lines || []).map((l) => l.text).join("\n");
const hasDemoMark = allText.includes("[演示]");
const hasStopMark = allText.includes("[dsh-serial] 已停止监听");
console.log(`    4g 事件留痕（启动=${hasDemoMark}，停止=${hasStopMark}）${hasDemoMark && hasStopMark ? " ✓" : " ✗"}`);
if (!hasDemoMark || !hasStopMark) throw new Error("事件留痕缺失");

// ---------- 5. 服务引擎直测 ----------
console.log("\n[5] 服务引擎直测：");

// 5a. "读 N 秒"= 最近 N 毫秒窗口 + 端口名大小写不敏感
const s1 = new SerialPortService();
s1.port = {}; // 模拟"端口正开着"
s1.portName = "COM4";
s1.pushLine("old line");
s1.lines[0].ts = Date.now() - 10_000; // 10 秒前的行 → 应被 3 秒窗口排除
s1.pushLine("fresh A");
s1.pushLine("fresh B");
const cap1 = await s1.capture({ port: "com4", durationMs: 3000 }); // 故意小写
const ok5a = cap1.source === "live-buffer" && cap1.lineCount === 2 && !cap1.lines.includes("old line");
console.log(`    5a 读取窗口(最近3s)+大小写不敏感 → ${cap1.source}, ${cap1.lineCount} 行${ok5a ? " ✓" : " ✗"}`);
if (!ok5a) throw new Error("读取窗口/大小写逻辑不对");
s1.port = null;

// 5b. readLogs 游标越界自愈（游标来自"上一代"缓冲 → 重发全量）
const rl1 = await s1.readLogs({ since: 99999 });
console.log(`    5b 游标越界自愈 → 重发 ${rl1.lines.length} 行（期望 3）${rl1.lines.length === 3 ? " ✓" : " ✗"}`);
if (rl1.lines.length !== 3) throw new Error("游标越界自愈失效");

// 5c. "超过 4KB 无换行" → 告警行
const s2 = new SerialPortService();
s2.appendBuffer(Buffer.from("x".repeat(5000)));
const ok5c = s2.lines.some((l) => l.text.includes("疑似波特率不匹配"));
console.log(`    5c 4KB 无换行告警${ok5c ? " ✓" : " ✗"}`);
if (!ok5c) throw new Error("无换行告警缺失");

// 5d. 连续乱码行 → 告警行
const s3 = new SerialPortService();
for (let i = 0; i < 5; i++) s3.appendBuffer(Buffer.from("\uFFFD\uFFFDabc\n"));
const ok5d = s3.lines.some((l) => l.text.includes("乱码字符"));
console.log(`    5d 连续乱码告警${ok5d ? " ✓" : " ✗"}`);
if (!ok5d) throw new Error("乱码告警缺失");

// 5e. 打开失败：保留旧波特率 + 失败留痕
const s4 = new SerialPortService();
await new Promise((r) => setTimeout(r, 80)); // 等首轮懒加载结束，再注入测试替身
const oldBaud = s4.baud;
s4.SerialPortClass = class { constructor(o, cb) { setTimeout(() => cb && cb(new Error("测试失败")), 10); } on() {} close(cb) { cb && cb(); } };
const failRes = await s4.start({ port: "COMX", baud: 57600 });
const ok5e = failRes.ok === false && s4.baud === oldBaud && s4.lines.some((l) => l.text.includes("打开 COMX @ 57600 失败"));
console.log(`    5e 失败不污染波特率+留痕 → ok=${failRes.ok}, baud=${s4.baud}${ok5e ? " ✓" : " ✗"}`);
if (!ok5e) throw new Error("失败路径不正确");

// 5f. 双击"连接"并发 → 串行化（open → close → open）+ 重开留痕
const events = [];
class FakeSerial {
  constructor(o, cb) { events.push(`open:${o.baudRate}`); setTimeout(() => cb && cb(null), 20); }
  on() {}
  close(cb) { events.push("close"); setTimeout(() => cb && cb(), 5); }
}
const s5 = new SerialPortService();
await new Promise((r) => setTimeout(r, 80));
s5.SerialPortClass = FakeSerial;
const [pa, pb] = await Promise.all([
  s5.start({ port: "COMT", baud: 9600 }),
  s5.start({ port: "COMT", baud: 19200 }),
]);
const order = events.join(",");
const ok5f =
  pa.ok && pb.ok &&
  order === "open:9600,close,open:19200" &&
  s5.baud === 19200 &&
  s5.lines.some((l) => l.text.includes("已重开 COMT @ 19200"));
console.log(`    5f 并发串行化 → ${order}，最终 ${s5.baud}${ok5f ? " ✓" : " ✗"}`);
if (!ok5f) throw new Error("并发串行化不正确");
s5.disposeSync();

console.log("\n[OK] 模拟加载测试全部通过 —— 工具可注册、路由可工作、安全检查有效、事件留痕/告警/窗口语义正确、演示模式端到端可跑。");
