/**
 * dsh-serial · 串口搭档 —— Browser 半（注入 dsh Web 界面）
 *
 * 协议：dsh 的浏览器端入口格式为 __ModuleLoader__.load({id, factory})。
 * 导出 apply(ctx) 供宿主调用（ctx 为浏览器侧 cordis 上下文）。不声明 exports.inject
 * ——面板零宿主服务依赖（数据走 HTTP 路由），加载即激活，不会 pending 卡住页面。
 *
 * UI 策略：不碰 React、不进设置页 slot，直接向 document.body 挂"悬浮球 + 面板"。
 * 纯原生 DOM，无构建、无依赖。
 *
 * 数据通道：HTTP 路由 /dsh-serial/api/*（lib/routes.js）→ 宿主串口引擎
 * （lib/service.js）。面板正开着的口，AI 工具复用同一个引擎的实时缓冲——互不抢口。
 */

window.__ModuleLoader__.load({
  id: "dsh-serial",
  factory: () => {
    var module = { exports: {} };
    var exports = module.exports;

    const BAUDS = [9600, 19200, 38400, 57600, 115200, 230400, 460800];

    /* 小鲸鱼素材（"信号喷鲸"）：原创实心渐变造型，与官方单线 logo 区隔。
     * 圆吻身体 + 双瓣尾叶 + 信号喷泉；同一套路径用于标题栏标记与空状态水印。 */
    const W_BODY = "M 10 46 Q 8 37 18 30 Q 32 23 50 21.5 Q 70 24 82 30 Q 88 33 90 39 Q 91 45.5 89 52 Q 74 60 54 61.5 Q 32 63.5 16 56 Q 10.5 51 10 46 Z";
    const W_TOP = "M 105.4 24.6 L 105.6 25.0 L 105.5 25.6 L 105.2 26.3 L 104.7 27.3 L 104.1 28.6 L 103.4 30.0 L 102.5 31.6 L 101.6 33.3 L 100.5 35.0 L 99.3 36.6 L 97.9 38.1 L 96.6 39.6 L 95.2 40.9 L 94.0 42.1 L 92.8 43.1 L 91.6 43.9 L 90.6 44.4 L 89.6 44.6 L 88.8 44.4 L 88.0 44.0 L 87.4 43.2 L 86.9 42.1 L 86.5 40.7 L 86.4 39.2 L 86.5 37.5 L 86.8 35.6 L 87.3 33.8 L 88.1 32.0 L 89.1 30.2 L 90.4 28.6 L 92.0 27.3 L 93.8 26.3 L 95.8 25.6 L 97.8 25.0 L 99.8 24.7 L 101.5 24.5 L 103.0 24.4 L 104.1 24.3 L 104.9 24.4 Z";
    const W_BOT = "M 111.7 53.7 L 111.4 54.1 L 110.9 54.5 L 110.0 55.0 L 108.8 55.5 L 107.4 56.1 L 105.8 56.7 L 104.0 57.2 L 102.1 57.5 L 100.2 57.6 L 98.3 57.4 L 96.5 56.8 L 94.8 56.0 L 93.3 55.1 L 91.9 54.0 L 90.7 52.9 L 89.8 51.7 L 89.0 50.5 L 88.6 49.4 L 88.4 48.4 L 88.5 47.5 L 88.9 46.7 L 89.5 46.1 L 90.3 45.7 L 91.4 45.5 L 92.7 45.4 L 94.2 45.4 L 95.8 45.6 L 97.5 45.9 L 99.3 46.3 L 101.1 46.7 L 102.9 47.4 L 104.6 48.2 L 106.1 49.2 L 107.5 50.1 L 108.8 51.0 L 109.9 51.7 L 110.7 52.4 L 111.3 52.9 L 111.6 53.3 Z";

    /** 标题栏品牌标记：小鲸（16px 高度档，不含喷泉——小尺寸下更清晰） */
    function whaleMarkHTML() {
      return (
        '<svg class="whale" width="28" height="15" viewBox="9 20 104 56" aria-hidden="true">' +
        '<defs><linearGradient id="dsh-serial-grad-mark" x1="0" y1="20" x2="0" y2="78" gradientUnits="userSpaceOnUse">' +
        '<stop offset="0" stop-color="#7C96FF"/><stop offset="1" stop-color="#3B57D8"/></linearGradient></defs>' +
        '<path fill="url(#dsh-serial-grad-mark)" d="' + W_BODY + '"/>' +
        '<path fill="url(#dsh-serial-grad-mark)" d="' + W_TOP + '"/>' +
        '<path fill="url(#dsh-serial-grad-mark)" d="' + W_BOT + '"/>' +
        '<circle cx="24" cy="37" r="4" fill="#fff"/>' +
        "</svg>"
      );
    }

    /** 空状态水印：完整"信号喷鲸"（含喷泉、腹纹、高光细节） */
    function whaleWaterHTML() {
      const G = "dsh-serial-grad-water";
      return (
        '<svg width="74" height="51" viewBox="0 0 128 88" aria-hidden="true">' +
        '<defs><linearGradient id="' + G + '" x1="0" y1="20" x2="0" y2="78" gradientUnits="userSpaceOnUse">' +
        '<stop offset="0" stop-color="#7C96FF"/><stop offset="1" stop-color="#3B57D8"/></linearGradient></defs>' +
        '<path fill="url(#' + G + ')" d="' + W_BODY + '"/>' +
        '<path fill="url(#' + G + ')" d="' + W_TOP + '"/>' +
        '<path fill="url(#' + G + ')" d="' + W_BOT + '"/>' +
        '<path fill="none" stroke="#96ACFF" stroke-width="3" stroke-linecap="round" opacity="0.9" d="M 40 24 Q 37 16 41 9"/>' +
        '<path fill="none" stroke="#96ACFF" stroke-width="2" stroke-linecap="round" opacity="0.67" d="M 41 9 Q 45 5.5 49 4"/>' +
        '<circle cx="34" cy="6" r="1.8" fill="#96ACFF"/>' +
        '<circle cx="52" cy="7" r="2.2" fill="#96ACFF"/>' +
        '<circle cx="42" cy="1.5" r="2.6" fill="#96ACFF"/>' +
        '<path fill="none" stroke="rgba(255,255,255,0.25)" stroke-width="4.5" stroke-linecap="round" d="M 24 29 Q 44 21.5 66 24"/>' +
        '<path fill="none" stroke="rgba(255,255,255,0.33)" stroke-width="2.4" stroke-linecap="round" d="M 42 57 Q 54 61 66 59"/>' +
        '<path fill="none" stroke="rgba(255,255,255,0.22)" stroke-width="2.2" stroke-linecap="round" d="M 50 51 Q 60 54.5 70 53"/>' +
        '<path fill="#2E48BE" d="M 41 55 Q 43 60 49.5 62 Q 50 58 48 54 Z"/>' +
        '<circle cx="24" cy="37" r="3.4" fill="#fff"/>' +
        "</svg>"
      );
    }

    /* 样式：跟随 dsh 主题令牌（--dsw-*），关键色用品牌静态色兜底。
     * 支持 color-mix 的内核下面板底色半透明化 + backdrop blur = 磨砂玻璃。 */
    const CSS = `
/* 悬浮球：玻璃质感 + 状态灯（监听中=绿环脉冲；数据到达=柔光一闪） */
#dsh-serial-fab{position:fixed;right:24px;bottom:92px;width:52px;height:52px;border-radius:50%;
  background:linear-gradient(150deg,rgba(255,255,255,.22),rgba(255,255,255,.04)),rgba(65,118,230,.62);
  -webkit-backdrop-filter:blur(12px) saturate(1.5);backdrop-filter:blur(12px) saturate(1.5);
  border:1px solid rgba(255,255,255,.42);color:#fff;cursor:grab;z-index:9990;
  touch-action:none;user-select:none;-webkit-user-select:none;
  box-shadow:0 4px 16px rgba(0,0,0,.32),inset 0 1px 0 rgba(255,255,255,.45);
  display:flex;align-items:center;justify-content:center;overflow:visible;
  transition:transform .15s ease,box-shadow .2s ease}
#dsh-serial-fab:hover{transform:scale(1.07);box-shadow:0 6px 20px rgba(0,0,0,.38),inset 0 1px 0 rgba(255,255,255,.5)}
#dsh-serial-fab.dragging{cursor:grabbing;transition:none;transform:scale(1.08)}
/* 数据闪亮层（白层在图标下——灯体发光、丝印透光的观感） */
#dsh-serial-fab::before{content:"";position:absolute;inset:0;border-radius:50%;background:#fff;
  opacity:0;transition:opacity .22s ease;pointer-events:none}
#dsh-serial-fab.flash::before{opacity:.3;transition:opacity .05s ease}
#dsh-serial-fab::after{content:"";position:absolute;inset:-3px;border-radius:50%;
  border:2px solid #34d399;opacity:0;pointer-events:none}
#dsh-serial-fab.listening::after{animation:fabpulse 2.2s ease-out infinite}
@keyframes fabpulse{0%{transform:scale(1);opacity:.85}70%{opacity:.35}100%{transform:scale(1.5);opacity:0}}
@media (prefers-reduced-motion:reduce){
  #dsh-serial-fab.listening::after{animation:none;opacity:.5}
  #dsh-serial-fab.flash::before{opacity:.12;transition:none}
}
/* 面板：玻璃拟态（半透明 + 背景模糊 + 内高光）；位置由 JS 贴球计算 */
#dsh-serial-panel{position:fixed;left:0;top:0;width:clamp(360px,44vw,480px);max-width:calc(100vw - 28px);
  max-height:min(78vh,680px);
  background:linear-gradient(168deg,rgba(255,255,255,.10),rgba(255,255,255,0) 42%),var(--dsw-alias-bg-layer-1);
  -webkit-backdrop-filter:blur(20px) saturate(1.35);backdrop-filter:blur(20px) saturate(1.35);
  border:1px solid var(--dsw-alias-border-l2);border-radius:14px;
  z-index:9991;
  box-shadow:0 24px 60px rgba(0,0,0,.5),0 4px 14px rgba(0,0,0,.28),inset 0 1px 0 rgba(255,255,255,.09);
  display:none;flex-direction:column;overflow:hidden;
  font-size:14px;font-family:var(--dsw-font-family,inherit);color:var(--dsw-alias-label-primary)}
#dsh-serial-panel.open{display:flex;animation:panelin .16s ease-out}
@keyframes panelin{from{opacity:0;transform:scale(.97)}to{opacity:1;transform:scale(1)}}
/* 连接成功：描边闪绿一次 */
#dsh-serial-panel.connectflash{animation:panelflash .9s ease-out}
@keyframes panelflash{
  0%{box-shadow:0 24px 60px rgba(0,0,0,.5),0 0 0 0 rgba(52,211,153,0)}
  35%{box-shadow:0 24px 60px rgba(0,0,0,.5),0 0 0 2px rgba(52,211,153,.7)}
  100%{box-shadow:0 24px 60px rgba(0,0,0,.5),0 0 0 0 rgba(52,211,153,0)}}
#dsh-serial-head{display:flex;align-items:center;gap:8px;padding:12px 16px;
  background:linear-gradient(180deg,rgba(255,255,255,.07),rgba(255,255,255,0) 78%),var(--dsw-alias-bg-layer-2);
  border-bottom:1px solid var(--dsw-alias-border-l1)}
#dsh-serial-head b{font-size:14px;font-weight:500;display:flex;align-items:center;gap:7px}
#dsh-serial-head .whale{display:block;flex:0 0 auto}
/* 三态状态灯：灰=未连接 / 琥珀呼吸=连接中 / 绿光晕=已连接 */
#dsh-serial-dot{width:9px;height:9px;border-radius:50%;background:#8b919e;flex:0 0 auto;
  transition:background .2s ease,box-shadow .2s ease}
#dsh-serial-dot.on{background:#34d399;box-shadow:0 0 8px rgba(52,211,153,.75)}
#dsh-serial-dot.busy{background:#e0a54c;animation:dotbreathe 1.1s ease-in-out infinite}
@keyframes dotbreathe{0%,100%{opacity:.4}50%{opacity:1}}
#dsh-serial-state{font-size:13px;color:var(--dsw-alias-label-secondary);margin-left:auto}
#dsh-serial-head #dsh-serial-close{width:26px;height:26px;padding:0;display:flex;align-items:center;justify-content:center;
  border-radius:8px;font-size:13px;line-height:1;color:var(--dsw-alias-label-secondary)}
#dsh-serial-head #dsh-serial-close:hover{color:var(--dsw-alias-label-primary)}
#dsh-serial-body{padding:14px 16px;display:flex;flex-direction:column;gap:10px;flex:1 1 auto;min-height:0;
  overflow-y:auto;overflow-x:hidden}
#dsh-serial-row1{display:flex;gap:8px}
#dsh-serial-row1 select{flex:1;min-width:0}
/* 日志区：内阴影"显示屏" + 语义色 + 新行淡入 */
#dsh-serial-logwrap{position:relative;flex:1 1 auto;min-height:110px;display:flex}
#dsh-serial-log{flex:1;min-width:0;overflow-y:auto;scrollbar-width:thin;
  background:linear-gradient(180deg,rgba(0,0,0,.26),rgba(0,0,0,.10)),var(--dsw-alias-markdown-code-block);
  border:1px solid var(--dsw-alias-border-l1);border-radius:10px;
  box-shadow:inset 0 2px 10px rgba(0,0,0,.25);
  padding:10px 12px;font-family:var(--dsw-font-mono,ui-monospace,Consolas,monospace);font-size:13px;line-height:1.6;
  color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-all}
#dsh-serial-log .t{color:var(--dsw-alias-label-tertiary)}
#dsh-serial-log div.evt{color:#5b8def}
#dsh-serial-log div.warn{color:#d9a02b}
#dsh-serial-log div.err{color:#e05656}
#dsh-serial-log>div{animation:linein .2s ease-out}
@keyframes linein{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}
/* 空状态：鲸鱼水印（有数据时自动让位） */
#dsh-serial-empty{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:9px;
  pointer-events:none}
#dsh-serial-empty.hide{display:none}
#dsh-serial-empty svg{opacity:.55;animation:whalefloat 3.4s ease-in-out infinite}
@keyframes whalefloat{0%,100%{transform:translateY(0)}50%{transform:translateY(-4px)}}
#dsh-serial-empty .es{font-size:12px;color:var(--dsw-alias-label-tertiary);letter-spacing:.2px}
#dsh-serial-row2{display:flex;gap:8px;flex-wrap:wrap}
/* 发送行：命令行提示符 */
#dsh-serial-sendrow{display:flex;gap:8px;align-items:center}
#dsh-serial-prompt{font-family:var(--dsw-font-mono,ui-monospace,Consolas,monospace);color:#34d399;
  font-size:15px;line-height:1;padding-left:2px;user-select:none}
#dsh-serial-sendrow input{flex:1;min-width:0}
#dsh-serial-hint{font-size:12px;color:var(--dsw-alias-label-tertiary);line-height:1.6;display:flex;flex-direction:column;gap:3px}
/* 控件统一风格；主按钮用品牌蓝 + 玻璃内高光 */
#dsh-serial-panel button,#dsh-serial-panel select,#dsh-serial-panel input{
  background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);
  border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:7px 14px;font-size:13px;cursor:pointer;
  font-family:inherit;transition:border-color .12s ease,background .12s ease,transform .12s ease,box-shadow .12s ease}
#dsh-serial-panel button:hover{border-color:var(--dsw-static-deepseek-450,#5686fe);transform:translateY(-1px)}
#dsh-serial-panel button:active{transform:translateY(0) scale(.98)}
#dsh-serial-panel button.pri{
  background:linear-gradient(160deg,rgba(255,255,255,.26),rgba(255,255,255,.04) 55%),var(--dsw-static-deepseek-500,#4176e6);
  color:#fff;border-color:transparent;
  box-shadow:0 2px 10px rgba(65,118,230,.32),inset 0 1px 0 rgba(255,255,255,.45)}
#dsh-serial-panel button.pri:hover{
  background:linear-gradient(160deg,rgba(255,255,255,.30),rgba(255,255,255,.06) 55%),var(--dsw-static-deepseek-450,#5686fe);
  box-shadow:0 4px 14px rgba(65,118,230,.42),inset 0 1px 0 rgba(255,255,255,.45)}
@media (prefers-reduced-motion:reduce){
  #dsh-serial-panel.open{animation:none}
  #dsh-serial-panel.connectflash{animation:none}
  #dsh-serial-dot.busy{animation:none;opacity:.8}
  #dsh-serial-log>div{animation:none}
  #dsh-serial-empty svg{animation:none}
}
@supports (background: color-mix(in srgb, red 50%, transparent)){
  #dsh-serial-panel{
    background:linear-gradient(168deg,rgba(255,255,255,.12),rgba(255,255,255,0) 46%),
      color-mix(in srgb, var(--dsw-alias-bg-layer-1) 80%, transparent)}
}
`;

    const state = {
      panelOpen: false,
      connected: false,
      demo: false,
      dotMode: "off", // 状态灯模式："off" | "busy" | "on"
      next: 0, // 已读到的日志序号（增量拉取游标）
      pollTimer: null,
      lastLogs: [], // 最近日志副本（复制给 AI 用）
      fabPos: null, // 悬浮球位置 {x,y}（启动时从 localStorage 恢复）
    };

    let dom = {};

    /* HTTP 通道：每个动作 = 一次 fetch；错误统一折叠成 { ok:false, error } */
    async function api(path, body) {
      try {
        const res = await fetch(
          `/dsh-serial/api/${path}`,
          body === undefined
            ? undefined
            : {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
              }
        );
        return await res.json();
      } catch (err) {
        return { ok: false, error: `请求失败：${String(err?.message || err)}` };
      }
    }

    /* ==================== DOM 构建 ==================== */
    function el(tag, attrs = {}, ...children) {
      const node = document.createElement(tag);
      for (const [k, v] of Object.entries(attrs)) {
        if (k === "text") node.textContent = v;
        else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
        else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v);
      }
      for (const c of children) if (c) node.append(c);
      return node;
    }

    /* ==================== 悬浮球拖拽 & 面板贴球定位 ====================
     * 桌面版窗口常比整屏小，面板不能钉死角落（会顶出屏幕）。策略：
     *   1) 球可拖拽（pointer events；位移 <6px 视为点击），位置持久化；
     *   2) 面板贴球展开：优先上方，放不下翻到下方，最后整体钳制进视口；
     *   3) 窗口缩放时自动回收。 */
    const FAB_SIZE = 52;
    const FAB_POS_KEY = "dsh-serial:fab-pos-v1";
    const PANEL_MARGIN = 10; // 面板/球与视口边缘的最小留白

    function clampNum(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

    /** 把坐标钳回"球必须完整可见"的范围 */
    function clampFabPos(p) {
      return {
        x: clampNum(p.x, 6, Math.max(6, window.innerWidth - FAB_SIZE - 6)),
        y: clampNum(p.y, 6, Math.max(6, window.innerHeight - FAB_SIZE - 6)),
      };
    }

    function loadFabPos() {
      try {
        const raw = localStorage.getItem(FAB_POS_KEY);
        if (raw) {
          const p = JSON.parse(raw);
          if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) return clampFabPos(p);
        }
      } catch { /* 存储不可用时退回默认位置 */ }
      return clampFabPos({ x: window.innerWidth - 24 - FAB_SIZE, y: window.innerHeight - 92 - FAB_SIZE });
    }

    function saveFabPos() {
      try { localStorage.setItem(FAB_POS_KEY, JSON.stringify(state.fabPos)); } catch { /* 忽略 */ }
    }

    function applyFabPos() {
      if (!dom.fab || !state.fabPos) return;
      dom.fab.style.left = state.fabPos.x + "px";
      dom.fab.style.top = state.fabPos.y + "px";
      dom.fab.style.right = "auto";
      dom.fab.style.bottom = "auto";
    }

    /** 面板定位：贴球 + 自动翻转 + 视口钳制 */
    function positionPanel() {
      if (!dom.panel || !state.panelOpen || !state.fabPos) return;
      const pw = dom.panel.offsetWidth;
      const ph = dom.panel.offsetHeight;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const fx = state.fabPos.x;
      const fy = state.fabPos.y;

      // 水平：面板右缘对齐球右缘，再钳制
      const left = clampNum(fx + FAB_SIZE - pw, PANEL_MARGIN, Math.max(PANEL_MARGIN, vw - pw - PANEL_MARGIN));

      // 垂直：优先球上方；放不下翻到下方；两侧都放不下时选空间大的一侧再钳制
      const aboveTop = fy - ph - PANEL_MARGIN;
      const belowTop = fy + FAB_SIZE + PANEL_MARGIN;
      let top;
      if (aboveTop >= PANEL_MARGIN) top = aboveTop;
      else if (belowTop + ph <= vh - PANEL_MARGIN) top = belowTop;
      else top = (fy - PANEL_MARGIN) >= (vh - (fy + FAB_SIZE) - PANEL_MARGIN) ? PANEL_MARGIN : vh - ph - PANEL_MARGIN;
      top = clampNum(top, PANEL_MARGIN, Math.max(PANEL_MARGIN, vh - ph - PANEL_MARGIN));

      dom.panel.style.left = left + "px";
      dom.panel.style.top = top + "px";
    }

    /* 拖拽：pointer events 兼容鼠标/触屏。
     * 位移 <6px 松手 = 点击（开关面板）；≥6px = 拖拽（移动球，面板跟随）。 */
    function attachFabDrag() {
      const fab = dom.fab;
      let drag = null;

      fab.addEventListener("pointerdown", (e) => {
        drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: state.fabPos.x, oy: state.fabPos.y, moved: false };
        try { fab.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
        e.preventDefault(); // 阻止文本选择/原生拖拽，拖起来才跟手
      });

      fab.addEventListener("pointermove", (e) => {
        if (!drag || e.pointerId !== drag.id) return;
        const dx = e.clientX - drag.sx;
        const dy = e.clientY - drag.sy;
        if (!drag.moved) {
          if (Math.hypot(dx, dy) < 6) return; // 未达拖拽阈值，仍按点击处理
          drag.moved = true;
          fab.classList.add("dragging");
        }
        state.fabPos = clampFabPos({ x: drag.ox + dx, y: drag.oy + dy });
        applyFabPos();
        if (state.panelOpen) positionPanel();
      });

      const endDrag = (e) => {
        if (!drag || e.pointerId !== drag.id) return;
        const wasDrag = drag.moved;
        drag = null;
        fab.classList.remove("dragging");
        if (wasDrag) saveFabPos();
        else togglePanel(); // 原位点击：开关面板
      };
      fab.addEventListener("pointerup", endDrag);
      fab.addEventListener("pointercancel", endDrag);
    }

    function onViewportResize() {
      state.fabPos = clampFabPos(state.fabPos);
      applyFabPos();
      positionPanel();
    }

    function buildUI() {
      const style = el("style", { id: "dsh-serial-style", text: CSS });

      // 悬浮球：波形图标；点击开关面板、拖动移位（行为见 attachFabDrag）
      const fab = el("button", { id: "dsh-serial-fab", title: "串口搭档 · 拖动可移动，点击开关面板" });
      fab.innerHTML =
        '<svg width="26" height="26" viewBox="0 0 26 26" fill="none" aria-hidden="true">' +
        '<polyline points="2,13 7,13 9.5,6.5 13,19.5 16.5,9 19,13 24,13" ' +
        'stroke="rgba(255,255,255,0.96)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

      const dot = el("span", { id: "dsh-serial-dot" });
      const stateText = el("span", { id: "dsh-serial-state", text: "未连接" });

      const portSel = el("select", { id: "dsh-serial-port" });
      const baudSel = el("select", {}, ...BAUDS.map((b) => el("option", { value: String(b), text: String(b), selected: b === 115200 ? "" : null })));

      // 日志区 + 空状态水印
      const logBox = el("div", { id: "dsh-serial-log" });
      const emptyText = el("div", { class: "es", text: "未连接 · 选择端口后点「连接」" });
      const emptyBox = el("div", { id: "dsh-serial-empty" });
      emptyBox.innerHTML = whaleWaterHTML();
      emptyBox.append(emptyText);
      const logWrap = el("div", { id: "dsh-serial-logwrap" }, logBox, emptyBox);

      const sendInput = el("input", { id: "dsh-serial-send", placeholder: "发送一行到串口…", onkeydown: (e) => { if (e.key === "Enter" && !e.isComposing) doSend(); } });

      const titleEl = el("b", {});
      titleEl.innerHTML = whaleMarkHTML() + "串口搭档";

      const closeBtn = el("button", { id: "dsh-serial-close", title: "关闭面板", "aria-label": "关闭面板", text: "✕", onclick: closePanel });

      const panel = el("div", { id: "dsh-serial-panel" },
        el("div", { id: "dsh-serial-head" }, dot, titleEl, stateText, closeBtn),
        el("div", { id: "dsh-serial-body" },
          el("div", { id: "dsh-serial-row1" }, portSel, el("button", { text: "刷新", title: "重新枚举串口", onclick: refreshPorts }), baudSel),
          el("div", { id: "dsh-serial-row2" },
            el("button", { text: "连接", class: "pri", onclick: doConnect }),
            el("button", { text: "演示模式", title: "无硬件时验证全链路", onclick: doDemo }),
            el("button", { text: "断开", onclick: doDisconnect })),
          logWrap,
          el("div", { id: "dsh-serial-sendrow" },
            el("span", { id: "dsh-serial-prompt", text: "\u276F" }),
            sendInput,
            el("button", { text: "发送", onclick: doSend })),
          el("div", { id: "dsh-serial-row2" },
            el("button", { text: "复制最近日志", title: "复制后粘贴到对话输入框，让 AI 分析", onclick: copyLogs }),
            el("button", { text: "清屏", onclick: clearLog })),
          el("div", { id: "dsh-serial-hint" },
            el("div", { text: "使用说明：选择端口与波特率（须与设备程序 Serial.begin() 一致）后点击「连接」开始监听；数据异常时面板会自动提示；插拔设备后点击「刷新」重新检测。" }),
            el("div", { text: "辅助功能：无硬件时可启用「演示模式」；「发送」用于向设备下发指令；「复制最近日志」可将输出交由 AI 分析。" })),
        ),
      );

      dom = { fab, panel, dot, stateText, portSel, baudSel, logBox, emptyBox, emptyText, sendInput };
      return { style, fab, panel };
    }

    /* ==================== 交互逻辑 ==================== */

    /** 关闭面板：只收起界面，不停止监听（连接与轮询继续，数据不会丢） */
    function closePanel() {
      state.panelOpen = false;
      dom.panel.classList.remove("open");
    }

    function togglePanel() {
      state.panelOpen = !state.panelOpen;
      dom.panel.classList.toggle("open", state.panelOpen);
      if (state.panelOpen) {
        positionPanel(); // 先按球的位置摆好面板，再拉数据
        refreshPorts(); refreshStatus();
      }
    }

    /** 状态灯三态："on" 绿·已连接 | "busy" 琥珀呼吸·连接中 | "off" 灰·未连接 */
    function setDot(mode, text) {
      const m = mode === true ? "on" : mode === false ? "off" : mode;
      state.dotMode = m;
      dom.dot.classList.toggle("on", m === "on");
      dom.dot.classList.toggle("busy", m === "busy");
      dom.stateText.textContent = text;
      if (dom.fab) dom.fab.classList.toggle("listening", m === "on"); // 球体=常驻状态灯
      updateEmpty();
    }

    /** 空状态：日志区无内容时显示鲸鱼水印；文字跟随连接状态 */
    function updateEmpty() {
      if (!dom.emptyBox) return;
      const hasLines = dom.logBox.childElementCount > 0;
      dom.emptyBox.classList.toggle("hide", hasLines);
      if (dom.emptyText) {
        dom.emptyText.textContent =
          state.dotMode === "busy" ? "正在打开端口…"
          : state.connected ? "监听中 · 等待设备输出…"
          : "未连接 · 选择端口后点「连接」";
      }
    }

    /** 连接成功：面板描边闪绿一次 */
    function flashPanel() {
      if (!dom.panel) return;
      dom.panel.classList.remove("connectflash");
      void dom.panel.offsetWidth; // 强制回流，让动画可连续触发
      dom.panel.classList.add("connectflash");
      setTimeout(() => dom.panel.classList.remove("connectflash"), 950);
    }

    /** 数据到达：球体柔光一闪（节流 500ms，模拟 RX 指示灯的渐变） */
    let lastFabFlash = 0;
    function flashFab() {
      const now = Date.now();
      if (now - lastFabFlash < 500) return;
      lastFabFlash = now;
      if (!dom.fab) return;
      dom.fab.classList.add("flash");
      setTimeout(() => dom.fab.classList.remove("flash"), 260);
    }

    const MAX_DOM_LINES = 1200; // 日志区 DOM 节点上限（防长期挂机膨胀）

    /** 日志语义色分类：事件→蓝 / 警告→琥珀 / 错误→红 / 数据→默认 */
    function logClass(text) {
      if (text.startsWith("[错误]")) return "err";
      if (text.startsWith("[警告]") || text.startsWith("[dsh-serial 警告]")) return "warn";
      if (text.startsWith("[dsh-serial]") || text.startsWith("[演示]") || text.startsWith("[已断开]")) return "evt";
      return "";
    }

    function appendLog(lines) {
      for (const l of lines) {
        const time = new Date(l.ts).toLocaleTimeString("zh-CN", { hour12: false });
        dom.logBox.append(el("div", { class: logClass(l.text) }, el("span", { class: "t", text: `${time} ` }), l.text));
      }
      if (lines.length) {
        while (dom.logBox.childElementCount > MAX_DOM_LINES) {
          dom.logBox.removeChild(dom.logBox.firstElementChild);
        }
        state.lastLogs.push(...lines);
        if (state.lastLogs.length > 300) state.lastLogs.splice(0, state.lastLogs.length - 300);
        dom.logBox.scrollTop = dom.logBox.scrollHeight;
        flashFab();
      }
      updateEmpty(); // 有行出现 → 空状态让位；清空后自动恢复
    }

    async function refreshPorts() {
      try {
        const res = await api("ports");
        dom.portSel.innerHTML = "";
        if (!res.ok) {
          dom.portSel.append(el("option", { text: "（串口库不可用）" }));
          appendLog([{ seq: 0, ts: Date.now(), text: `[提示] ${res.error}` }]);
          return;
        }
        if (!res.ports.length) {
          dom.portSel.append(el("option", { text: "（未检测到串口设备）" }));
          return;
        }
        for (const p of res.ports) {
          dom.portSel.append(el("option", { value: p.path, text: p.manufacturer ? `${p.path} · ${p.manufacturer}` : p.path }));
        }
      } catch (err) {
        appendLog([{ seq: 0, ts: Date.now(), text: `[错误] 列举串口失败：${String(err?.message || err)}` }]);
      }
    }

    async function refreshStatus() {
      try {
        const s = await api("status");
        if (s.serialportAvailable === false && s.serialportError) {
          appendLog([{ seq: 0, ts: Date.now(), text: `[提示] ${s.serialportError}` }]);
        }
      } catch { /* 服务未就绪时静默 */ }
    }

    function startPolling() {
      stopPolling();
      state.pollTimer = setInterval(async () => {
        try {
          const { lines, next } = await api(`logs?since=${state.next}`);
          state.next = next;
          appendLog(lines);
        } catch { /* 连接中断时下一轮自愈 */ }
      }, 400);
    }
    function stopPolling() { if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; } }

    async function doConnect() {
      const port = dom.portSel.value;
      if (!port || port.startsWith("（")) { setDot(false, "请先选择串口"); return; }
      setDot("busy", "连接中…");
      const res = await api("start", { port, baud: Number(dom.baudSel.value) });
      if (res.ok) {
        // 不重置游标：重连后只补增量，不重复贴历史
        state.connected = true; state.demo = false;
        setDot(true, `${port} @ ${dom.baudSel.value}`);
        startPolling();
        flashPanel();
      } else {
        // 失败 = 服务已停（start 内部"先停后开"）——面板状态必须同步复位
        state.connected = false; state.demo = false;
        stopPolling();
        setDot(false, "未连接");
        appendLog([{ seq: 0, ts: Date.now(), text: `[错误] ${res.error}` }]);
      }
    }

    async function doDemo() {
      setDot("busy", "正在启动演示…");
      const res = await api("start", { demo: true });
      if (res.ok) { state.connected = true; state.demo = true; setDot(true, "演示模式运行中"); startPolling(); flashPanel(); }
      else {
        state.connected = false; state.demo = false;
        stopPolling();
        setDot(false, "未连接");
        appendLog([{ seq: 0, ts: Date.now(), text: `[错误] ${res.error}` }]);
      }
    }

    async function doDisconnect() {
      await api("stop", {});
      state.connected = false; state.demo = false;
      stopPolling();
      setDot(false, "未连接");
      appendLog([{ seq: 0, ts: Date.now(), text: "[已断开]" }]);
    }

    async function doSend() {
      const text = dom.sendInput.value.trim();
      if (!text) return;
      const res = await api("send", { text });
      if (res.ok) dom.sendInput.value = "";
      else appendLog([{ seq: 0, ts: Date.now(), text: `[错误] ${res.error}` }]);
    }

    async function copyLogs() {
      const text = state.lastLogs.map((l) => l.text).join("\n");
      if (!text) { appendLog([{ seq: 0, ts: Date.now(), text: "[提示] 还没有日志可复制" }]); return; }
      try {
        await navigator.clipboard.writeText(text);
        appendLog([{ seq: 0, ts: Date.now(), text: `[已复制 ${state.lastLogs.length} 行日志——去对话框粘贴发给 AI 分析吧]` }]);
      } catch {
        appendLog([{ seq: 0, ts: Date.now(), text: "[错误] 剪贴板被浏览器拒绝，请手动选择日志复制" }]);
      }
    }

    function clearLog() { dom.logBox.innerHTML = ""; state.lastLogs = []; updateEmpty(); }

    /* ==================== 入口 ==================== */
    function apply(ctx) {
      const { style, fab, panel } = buildUI();
      document.head.append(style);
      document.body.append(fab, panel);
      state.fabPos = loadFabPos();
      applyFabPos();
      attachFabDrag();
      setDot("off", "未连接"); // 初始化三态灯（灰）+ 空状态文字
      window.addEventListener("resize", onViewportResize);
      // cordis 卸载插件时执行——界面完全还原
      ctx.effect(() => () => {
        stopPolling();
        window.removeEventListener("resize", onViewportResize);
        fab.remove(); panel.remove(); style.remove();
      }, "dsh-serial: 面板清理");
    }

    exports.apply = apply;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    return module.exports;
  }
});
