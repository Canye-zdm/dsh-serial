/**
 * dsh-serial · 独立验证脚本（不依赖 dsh）
 *
 * 在把插件装进 dsh 之前，先单独验证"电脑 → serialport → 串口"这条核心链路。
 *
 * 用法：
 *   node tools/serial-smoke.mjs                  列出所有串口
 *   node tools/serial-smoke.mjs COM3 9600 3000   读某端口 3 秒（波特率与板子程序一致）
 */

import { SerialPort } from "serialport";

const [, , port, baud, ms] = process.argv;

// ===== 第一步：列出所有串口 =====
const ports = await SerialPort.list();
console.log(`共检测到 ${ports.length} 个串口：`);
for (const p of ports) {
  console.log(
    `  - ${p.path}` +
      (p.friendlyName ? `  ${p.friendlyName}` : "") +
      (p.manufacturer ? `  (${p.manufacturer})` : "")
  );
}

if (!port) {
  console.log("\n（未指定串口。想读某个口：node tools/serial-smoke.mjs COM3 9600 3000）");
  process.exit(0);
}

// ===== 第二步：真读一段 =====
const baudRate = Number(baud) || 115200;
const duration = Number(ms) || 3000;
console.log(`\n正在读 ${port} @ ${baudRate}，持续 ${duration}ms ...\n`);

const sp = new SerialPort({ path: port, baudRate });

// 收到数据即打印（与 Arduino IDE 的串口监视器行为一致）
sp.on("data", (chunk) => process.stdout.write(chunk.toString("utf8")));

sp.on("error", (err) => {
  console.error(`\n[串口错误] ${err.message}`);
  console.error("常见原因：端口号不对 / 被其他程序占用（关掉 Arduino IDE 的串口监视器）/ 驱动没装");
  process.exit(1);
});

// 到点关闭
setTimeout(() => {
  sp.close(() => {
    console.log(`\n\n[读完 ${duration}ms，串口已关闭]`);
    process.exit(0);
  });
}, duration);
