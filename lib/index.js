/**
 * dsh-serial — 把电脑的串口接进 dsh：给 AI 装上"看硬件"的眼睛。
 *
 * 插件入口（Host 半），整合两条通道：
 *   面板（给人）—— HTTP 路由 /dsh-serial/api/*（lib/routes.js），浏览器端悬浮球通过它通信；
 *   AI 工具（给 AI）—— serial_list_ports 列出串口 / serial_read 读取运行输出。
 *
 * 两条通道共用同一个 SerialPortService 实例：Windows 上同一个 COM 口不能被两个程序
 * 同时打开，共用实例让"面板正开着的口"也能被工具直接读取——互不抢口。
 *
 * 最小插件结构：export name / inject（依赖的宿主服务）/ apply(ctx)（注册入口）。
 */

import { SerialPortService } from "./service.js";
import { mountSerialRoutes } from "./routes.js";

export const name = "dsh-serial";

// 告诉 loader：等 tools 服务就绪后再调用 apply
export const inject = ["tools"];

/* defineTool：官方的工具定义包装器；拿不到时退化为恒等函数，工具仍可用（少一层参数校验） */
let defineTool = (t) => t;
try {
  const mod = await import("@deepseek-ai/dsh-tools");
  if (typeof mod.defineTool === "function") defineTool = mod.defineTool;
} catch {
  /* 宿主未暴露 dsh-tools：保持 fallback */
}

export function apply(ctx) {
  // 1) 串口引擎（两条通道共用）
  let service = null;
  try {
    service = new SerialPortService();
    ctx.effect(() => () => service.disposeSync(), "dsh-serial: 关闭串口并清理缓冲");
  } catch (err) {
    console.error("[dsh-serial] 串口引擎初始化失败：", err);
  }

  // 2) 面板通道：等 webServer 服务就绪后挂载 HTTP 路由
  //    （无 webServer 的环境——如 headless——静默跳过，不影响工具通道）
  if (service) {
    ctx.inject(["webServer"], (webCtx) => {
      try {
        const dispose = mountSerialRoutes(webCtx.webServer, service);
        webCtx.effect(() => dispose, "dsh-serial: 卸载 HTTP 路由");
        console.log("[dsh-serial] 面板路由已挂载：/dsh-serial/api/*");
      } catch (err) {
        console.error("[dsh-serial] 面板路由挂载失败（AI 工具不受影响）：", err);
      }
    });
  }

  // 3) 工具通道：注册两个 AI 工具
  registerTools(ctx, service);
}

/** 把"服务不可用"整理成一句人话，供工具报错 */
function requireService(service) {
  if (service) return service;
  throw new Error("dsh-serial 的串口服务未初始化成功，无法操作串口（请查看 dsh 日志中的 [dsh-serial] 记录）。");
}

function registerTools(ctx, service) {
  /* ======== 工具 1：列出串口 ======== */
  ctx.tools.register(
    defineTool({
      name: "serial_list_ports",
      description:
        "List the serial ports (COM ports) available on this computer. " +
        "Use this when the user asks about their serial devices, microcontrollers, Arduino/STM32/ESP32 boards, " +
        "or before calling serial_read to find the right port name.",
      parameters: {},
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            ports: {
              type: "array",
              required: true,
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  path: { type: "string", required: true },
                  manufacturer: { type: "string" },
                  friendlyName: { type: "string" },
                },
              },
            },
          },
        },
        render: (_args, value) => {
          if (!value.ports.length) {
            return [
              {
                type: "text",
                text: "没有检测到任何串口设备（检查 USB 线是否插好，或串口驱动是否安装）。",
              },
            ];
          }
          const lines = value.ports.map(
            (p) =>
              `- ${p.path}` +
              (p.friendlyName ? `  ${p.friendlyName}` : "") +
              (p.manufacturer ? `  (${p.manufacturer})` : "")
          );
          return [
            { type: "text", text: `检测到 ${value.ports.length} 个串口：\n${lines.join("\n")}` },
          ];
        },
      },
      async execute() {
        const svc = requireService(service);
        const res = await svc.listPorts();
        if (!res.ok) throw new Error(res.error || "枚举串口失败");
        return {
          ports: res.ports.map((p) => ({
            path: String(p.path),
            ...(p.manufacturer ? { manufacturer: String(p.manufacturer) } : {}),
            ...(p.friendlyName ? { friendlyName: String(p.friendlyName) } : {}),
          })),
        };
      },
    })
  );

  /* ======== 工具 2：读串口 ======== */
  ctx.tools.register(
    defineTool({
      name: "serial_read",
      description:
        "Open a serial port, listen for a few seconds, and return the captured output. " +
        "This is how you read what a microcontroller (Arduino/STM32/ESP32/51) is printing while it runs — " +
        "use it to debug runtime problems: crashes, reboots, wrong values, garbled text. " +
        "This tool never writes to the port. " +
        "If the panel is already listening to the same port, this reads the most recent window " +
        "(durationMs) from its live buffer without reopening the port. " +
        "If nothing is captured, check that the baudRate matches the sketch's Serial.begin() value.",
      parameters: {
        port: {
          type: "string",
          required: true,
          description: 'Serial port path, e.g. "COM3" (run serial_list_ports first if unsure).',
        },
        baudRate: {
          type: "number",
          description:
            "Baud rate such as 9600 or 115200. Must match the sketch's Serial.begin(). Default 115200. " +
            "Ignored when the panel is already listening to that port — its active baud rate is used.",
        },
        durationMs: {
          type: "number",
          description:
            "How long to listen in milliseconds. Default 3000, max 10000. " +
            "When reading from the panel's live buffer, this is the size of the most-recent window.",
        },
        maxLines: {
          type: "number",
          description: "Maximum lines to return, keeping the newest ones. Default 200, max 500.",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            port: { type: "string", required: true },
            baudRate: { type: "integer", required: true },
            durationMs: { type: "integer", required: true },
            source: { type: "string", required: true },
            byteCount: { type: "integer", required: true },
            lineCount: { type: "integer", required: true },
            bufferedLines: { type: "integer" },
            newestAgeMs: { type: "integer" },
            truncated: { type: "boolean", required: true },
            text: { type: "string", required: true },
          },
        },
        render: (_args, value) => {
          const srcNote =
            value.source === "live-buffer"
              ? "（来自面板正在监听的实时缓冲）"
              : "（本次临时打开端口抓取）";
          const header =
            value.source === "live-buffer"
              ? `${value.port} @ ${value.baudRate} 最近 ${value.durationMs}ms 的实时缓冲${srcNote}：` +
                `收到 ${value.byteCount} 字节 / ${value.lineCount} 行` +
                (value.truncated ? "（已截断，仅保留最新部分）" : "")
              : `${value.port} @ ${value.baudRate} 读了 ${value.durationMs}ms${srcNote}：` +
                `收到 ${value.byteCount} 字节 / ${value.lineCount} 行` +
                (value.truncated ? "（已截断，仅保留最新部分）" : "");
          let body;
          if (value.text.length) {
            body = value.text;
          } else if (value.source === "live-buffer" && typeof value.newestAgeMs === "number") {
            body =
              `（最近 ${value.durationMs}ms 窗口内没有新数据；缓冲里最新一行在 ${Math.round(
                value.newestAgeMs / 1000
              )} 秒前。若持续无输出：板子可能在忙、挂了，或没在打印。）`;
          } else {
            body =
              "（这期间没有收到任何数据。如果板子确实在输出：检查波特率是否与程序里 Serial.begin() 一致，" +
              "或 TX/RX 是否接反。）";
          }
          return [{ type: "text", text: `${header}\n${body}` }];
        },
      },
      async execute(args, exec) {
        const svc = requireService(service);

        // 参数钳制（防模型给出离谱数值）
        const port = String(args.port);
        const baudRate =
          Number.isInteger(args.baudRate) && args.baudRate > 0 ? args.baudRate : 115200;

        // 走服务引擎（自动处理"面板已占用同一口"的联动）
        const result = await svc.capture({
          port,
          baudRate,
          durationMs: args.durationMs,
          maxLines: args.maxLines,
          signal: exec ? exec.signal : undefined,
        });

        return {
          port: result.port,
          baudRate: result.baudRate,
          durationMs: result.durationMs,
          source: result.source,
          byteCount: result.byteCount,
          lineCount: result.lineCount,
          truncated: result.truncated,
          ...(typeof result.bufferedLines === "number" ? { bufferedLines: result.bufferedLines } : {}),
          ...(typeof result.newestAgeMs === "number" ? { newestAgeMs: result.newestAgeMs } : {}),
          text: result.lines.join("\n"),
        };
      },
    })
  );
}
