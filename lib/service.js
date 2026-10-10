/**
 * dsh-serial · 串口服务引擎
 *
 * 封装串口操作（枚举 / 打开 / 读取 / 写入 / 关闭 / 演示模式），作为唯一实例被
 * 两条通道共用：HTTP 路由（面板，见 lib/routes.js）与 AI 工具（见 lib/index.js）。
 *
 * 共用一个实例的原因：Windows 上同一个 COM 口不能被两个程序同时打开。面板正开着的
 * 口，AI 工具直接从它的环形缓冲取数据——互不抢口，且两边看到同一份真实状态。
 */

/* ---------- 常量 ---------- */

const LOG_LIMIT = 500; // 环形缓冲区上限（行）
const CHUNK_GUARD = 4096; // 单行超过 4KB 强制切行（防无换行的裸数据撑爆缓冲）
const CLOSE_TIMEOUT = 2000; // 关闭串口的兜底超时（ms）——close 回调失联也不能卡死队列
const GUARD_WARN_INTERVAL = 30_000; // "4KB 无换行"告警限频（ms）
const GARBLED_WARN_INTERVAL = 30_000; // "连续乱码行"告警限频（ms）
const GARBLED_RUN_TRIGGER = 5; // 连续 N 行乱码字符 → 告警

/* ---------- 服务类 ---------- */

export class SerialPortService {
  constructor() {
    this.SerialPortClass = null; // serialport 库的构造器（懒加载）
    this.serialportError = null;
    this.port = null; // 打开着的串口实例
    this.pending = Buffer.alloc(0); // 尚未遇到换行符的"半行"字节
    this.lines = []; // 环形日志缓冲 [{ seq, ts, text }]
    this.seq = 0;
    this.demoTimer = null; // 演示模式的 setInterval 句柄
    this.portName = null;
    this.baud = 115200; // 活动波特率——只在端口成功打开后更新
    this._chain = Promise.resolve(); // 操作队列：start/stop 串行化
    this._lastGuardWarnAt = 0; // "4KB 无换行"告警限频时间戳
    this._lastGarbledWarnAt = 0; // "连续乱码行"告警限频时间戳
    this._garbledRun = 0; // 连续乱码行计数
    this.loadSerialport(); // 异步预加载，不阻塞插件启动
  }

  /** 串行化包装：上一个操作完成后再执行下一个（防双击"连接"等并发竞态） */
  _lock(fn) {
    const run = this._chain.then(fn, fn);
    this._chain = run.catch(() => {});
    return run;
  }

  /** 懒加载 serialport（失败只影响真实串口，演示模式不受影响） */
  async loadSerialport() {
    if (this.SerialPortClass) return this;
    try {
      const mod = await import("serialport");
      const cls = mod.SerialPort || (mod.default && mod.default.SerialPort) || null;
      if (!cls) throw new Error("未找到 SerialPort 导出");
      if (!this.SerialPortClass) this.SerialPortClass = cls; // 并发加载时保留先到的
    } catch (err) {
      this.SerialPortClass = null;
      this.serialportError = `serialport 库未安装或加载失败（演示模式不受影响）：${String(
        (err && err.message) || err
      )}`;
    }
    return this;
  }

  /* ============ 面板面：由 HTTP 路由（lib/routes.js）调用 ============ */

  /** 服务状态总览 */
  async status() {
    return {
      serialportAvailable: !!this.SerialPortClass,
      serialportError: this.SerialPortClass ? null : this.serialportError,
      active: !!(this.port || this.demoTimer),
      demoMode: !!this.demoTimer,
      port: this.portName,
      baud: this.baud,
      bufferedLines: this.lines.length,
    };
  }

  /** 枚举本机串口 */
  async listPorts() {
    await this.loadSerialport();
    if (!this.SerialPortClass) {
      return { ok: false, ports: [], error: this.serialportError };
    }
    try {
      const ports = await this.SerialPortClass.list();
      return {
        ok: true,
        error: null,
        ports: ports.map((p) => ({
          path: p.path,
          manufacturer: p.manufacturer || "",
          friendlyName: p.friendlyName || "",
        })),
      };
    } catch (err) {
      return { ok: false, ports: [], error: String((err && err.message) || err) };
    }
  }

  /**
   * 开始接收。demo=true 走演示数据源；否则打开真实串口。
   * 波特率必须与设备程序里 Serial.begin() 一致，否则满屏乱码。
   */
  async start(opts = {}) {
    return this._lock(() => this._startLocked(opts));
  }

  async _startLocked({ port, baud = 115200, demo = false } = {}) {
    const wasActive = !!(this.port || this.demoTimer); // 用于区分"打开"与"重开"的留痕
    await this._stopLocked();
    if (demo) return this.startDemo();
    await this.loadSerialport();
    if (!this.SerialPortClass) return { ok: false, error: this.serialportError };
    return new Promise((resolve) => {
      try {
        this.port = new this.SerialPortClass({ path: port, baudRate: baud, autoOpen: true }, (err) => {
          if (err) {
            this.port = null;
            // 失败的尝试也写进缓冲——面板与 AI 看到的是同一份事实
            this.pushLine(
              `[dsh-serial] 打开 ${port} @ ${baud} 失败：${err.message}（串口可能被其他程序占用）`
            );
            resolve({ ok: false, error: `打开 ${port} 失败：${err.message}（串口可能被其他程序占用）` });
            return;
          }
          this.portName = port;
          this.baud = baud; // 活动波特率只在打开成功后生效（失败不污染状态）
          this.pushLine(
            wasActive
              ? `[dsh-serial] 已重开 ${port} @ ${baud}（端口重开，板子可能复位）`
              : `[dsh-serial] 已打开 ${port} @ ${baud}`
          );
          this.port.on("data", (buf) => this.appendBuffer(buf));
          resolve({ ok: true, demo: false, port, baud });
        });
        this.port.on("error", (err) => this.pushLine(`[错误] 串口异常：${err.message}`));
      } catch (err) {
        this.port = null;
        resolve({ ok: false, error: String((err && err.message) || err) });
      }
    });
  }

  /** 演示数据源：模拟一块 Arduino 气象站（DHT11 温湿度 + HC-SR04 距离）每 0.8s 汇报一次 */
  startDemo() {
    this.pushLine("[演示] 已启动模拟数据源（板子不在身边时的全链路验证）");
    this.demoTimer = setInterval(() => {
      const t = (25 + Math.sin(Date.now() / 9000) * 3).toFixed(1);
      const h = (60 + Math.cos(Date.now() / 11000) * 5).toFixed(1);
      const d = (10 + Math.random() * 40).toFixed(1);
      this.pushLine(`[demo] DHT11 temp=${t}C hum=${h}% | HC-SR04 dist=${d}cm`);
    }, 800);
    return { ok: true, demo: true };
  }

  /** 停止（关串口 / 停演示） */
  async stop() {
    return this._lock(() => this._stopLocked());
  }

  async _stopLocked() {
    const stoppedName = this.portName;
    const stoppedDemo = !!this.demoTimer;
    if (this.demoTimer) {
      clearInterval(this.demoTimer);
      this.demoTimer = null;
    }
    if (this.port) {
      const p = this.port;
      this.port = null;
      this.portName = null;
      this.pending = Buffer.alloc(0);
      await new Promise((r) => {
        // 兜底超时：close 回调失联也不能卡死后续操作
        const t = setTimeout(r, CLOSE_TIMEOUT);
        try {
          p.close(() => {
            clearTimeout(t);
            r();
          });
        } catch {
          clearTimeout(t);
          r();
        }
      });
    }
    if (stoppedName || stoppedDemo) {
      this.pushLine(`[dsh-serial] 已停止监听${stoppedName ? " " + stoppedName : "（演示模式）"}`);
    }
    return { ok: true };
  }

  /** 增量读日志：只返回 seq 大于 since 的新行（面板轮询用，避免重复传输） */
  async readLogs({ since = 0 } = {}) {
    // 游标越界自愈：插件重载后服务重开、seq 归零，旧游标会导致客户端永远收不到数据
    if (since > this.seq) since = 0;
    const fresh = this.lines.filter((l) => l.seq > since);
    return { lines: fresh, next: fresh.length ? fresh[fresh.length - 1].seq : since };
  }

  /** 往串口写一行（演示模式下回显到日志） */
  async send({ text = "" } = {}) {
    if (this.demoTimer) {
      this.pushLine(`[demo→] ${text}`);
      return { ok: true };
    }
    if (!this.port) return { ok: false, error: "串口未打开" };
    return new Promise((resolve) => {
      this.port.write(text + "\n", (err) =>
        resolve(err ? { ok: false, error: err.message } : { ok: true })
      );
    });
  }

  /* ============ 引擎面：供 AI 工具直接调用（不经过浏览器） ============ */

  /**
   * 捕获一段串口输出（serial_read 工具用）。两种来源：
   *   1. live-buffer：本服务正开着的就是这个口 → 从环形缓冲取"最近 dur 毫秒"的行
   *      （零等待，且不会与面板抢口——这正是共存的关键）
   *   2. captured：口没开着 → 临时打开、读 dur 毫秒、平滑关闭
   */
  async capture({ port, baudRate = 115200, durationMs = 3000, maxLines = 200, signal } = {}) {
    const dur = Math.min(Math.max(Number(durationMs) || 3000, 100), 10000);
    const cap = Math.min(Math.max(Number(maxLines) || 200, 1), 500);

    // —— 情况 1：正开着的就是这个口 → 用缓冲 ——
    // 端口名大小写不敏感（"com4" 与 "COM4" 是同一个口，Windows 惯例）。
    // durationMs 在这里是"时间窗口"语义——只返回最近 dur 毫秒的行，与临时抓取一致。
    const samePort =
      this.port && this.portName && String(this.portName).toUpperCase() === String(port).toUpperCase();
    if (samePort) {
      const now = Date.now();
      const inWindow = this.lines.filter((l) => now - l.ts <= dur);
      const truncated = inWindow.length > cap;
      const lines = truncated ? inWindow.slice(-cap) : inWindow;
      const newest = this.lines.length ? this.lines[this.lines.length - 1] : null;
      return {
        source: "live-buffer",
        port: this.portName,
        baudRate: this.baud,
        durationMs: dur,
        bufferedLines: this.lines.length,
        newestAgeMs: newest ? now - newest.ts : null,
        byteCount: Buffer.byteLength(lines.join("\n"), "utf8"),
        lineCount: lines.length,
        truncated,
        lines,
      };
    }

    // —— 情况 2：临时打开读一段 ——
    await this.loadSerialport();
    if (!this.SerialPortClass) throw new Error(this.serialportError || "serialport 不可用");

    const raw = await new Promise((resolve, reject) => {
      const chunks = [];
      let sp = null;
      let settled = false;
      let timer = null;

      const finish = (err, text) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (sp && sp.isOpen) {
          try {
            sp.close(() => {});
          } catch {}
        }
        if (err) reject(err);
        else resolve(text);
      };

      const onAbort = () => finish(null, Buffer.concat(chunks).toString("utf8"));

      try {
        sp = new this.SerialPortClass({ path: port, baudRate, autoOpen: false });
      } catch (err) {
        reject(new Error(`无法创建串口对象 ${port}: ${(err && err.message) || err}`));
        return;
      }

      timer = setTimeout(() => finish(null, Buffer.concat(chunks).toString("utf8")), dur);

      if (signal) {
        if (signal.aborted) return onAbort();
        signal.addEventListener("abort", onAbort, { once: true });
      }

      sp.on("data", (buf) => chunks.push(Buffer.from(buf)));
      sp.on("error", (err) => finish(new Error(`串口错误 ${port}: ${(err && err.message) || err}`)));
      sp.open((err) => {
        if (err) {
          finish(
            new Error(
              `打不开 ${port}（${err.message}）。可能原因：端口不存在、被其他程序占用` +
                `（Arduino IDE 的串口监视器等要先关闭），或驱动未安装。`
            )
          );
        }
      });
    });

    // 切行，只保留最新的 maxLines 行
    let lines = raw.split(/\r?\n/);
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
    const truncated = lines.length > cap;
    if (truncated) lines = lines.slice(lines.length - cap);

    return {
      source: "captured",
      port,
      baudRate,
      durationMs: dur,
      byteCount: Buffer.byteLength(raw, "utf8"),
      lineCount: lines.length,
      truncated,
      lines,
    };
  }

  /* ============ 内部工具：字节流 → 行 ============ */

  /**
   * 串口数据是一截一截到达的：一行字可能分两截到，也可能两行并成一截。
   * 所以要先缓冲，再按换行符切分——串口处理最经典的细节。
   */
  appendBuffer(buf) {
    this.pending = Buffer.concat([this.pending, buf]);
    let idx;
    while ((idx = this.pending.indexOf(0x0a)) >= 0) {
      const line = this.pending.subarray(0, idx).toString("utf8").replace(/\r$/, "");
      this.pending = this.pending.subarray(idx + 1);
      this.pushDeviceLine(line);
    }
    if (this.pending.length > CHUNK_GUARD) {
      this.pushLine(this.pending.toString("utf8"));
      this.pending = Buffer.alloc(0);
      this.warnIfNoNewline();
    }
  }

  /** 设备数据行：入库前做乱码字符检测（连续多行 → 疑似波特率/编码问题） */
  pushDeviceLine(text) {
    let bad = 0;
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 0xfffd) bad += 1; // U+FFFD = UTF-8 解码失败的替换符
    }
    if (bad >= 2) {
      this._garbledRun += 1;
      if (this._garbledRun >= GARBLED_RUN_TRIGGER) this.warnIfGarbled();
    } else {
      this._garbledRun = 0;
    }
    this.pushLine(text);
  }

  /** "超过 4KB 无换行"告警——错配波特率最典型的特征（限频） */
  warnIfNoNewline() {
    const now = Date.now();
    if (now - this._lastGuardWarnAt < GUARD_WARN_INTERVAL) return;
    this._lastGuardWarnAt = now;
    this.pushLine(
      `[dsh-serial 警告] 已连续收到超过 4KB 无换行数据——若设备应按行输出，疑似波特率不匹配（当前活动波特率 ${this.baud}）`
    );
  }

  /** "连续乱码行"告警（限频） */
  warnIfGarbled() {
    const now = Date.now();
    if (now - this._lastGarbledWarnAt < GARBLED_WARN_INTERVAL) return;
    this._lastGarbledWarnAt = now;
    this.pushLine(
      "[dsh-serial 警告] 连续多行含大量乱码字符——可能原因：① 波特率不匹配 ② 设备输出用了非 UTF-8 编码（如 GBK）"
    );
  }

  pushLine(text) {
    this.seq += 1;
    this.lines.push({ seq: this.seq, ts: Date.now(), text });
    if (this.lines.length > LOG_LIMIT) this.lines.splice(0, this.lines.length - LOG_LIMIT);
  }

  /** 同步清理（插件卸载时调用） */
  disposeSync() {
    if (this.demoTimer) clearInterval(this.demoTimer);
    if (this.port) {
      try {
        this.port.close();
      } catch {}
    }
    this.port = null;
    this.demoTimer = null;
  }
}
