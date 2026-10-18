# dsh-serial（面板 + AI 工具双通道）

把电脑的串口接进 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）——
**让 AI 能看见 Arduino / STM32 / ESP32 / 51 单片机的运行时输出。**

## 两条通道，如下所示

| 通道 | 主用户 | 入口 |  作用  |
|---|---|---|---|
| 悬浮球面板 | 人 | 右下角悬浮球（可拖动移位，点击开面板） | 选口连接、实时看日志、演示模式、手动发送、复制日志 |
| AI 工具 | AI | 对话框里直接说 | `serial_list_ports` 列串口 / `serial_read` 读串口并自动分析 |

两条通道**共用同一个串口服务实例**——面板开着的口，AI 工具直接从它的实时缓冲取数据，
不会出现"同一 COM 口被抢"的冲突（Windows 上同一串口不能被两个程序同时打开）。

## 原理

```
单片机跑程序 ──UART──▶ USB转串口芯片(CH340) ──USB──▶ 操作系统 COM 口 ──▶ 本插件 ──▶ 面板 / AI
└────────────── 硬件的世界，插件的代码从 COM 口右边才开始 ──────────────┘
```

- UART 协议、电平、时序——全部由硬件和 `serialport` 库封装，插件只管理"读已解好的字节流"
- 插件无构建：纯 JS 源码即运行产物（Host 半 `lib/`，Browser 半 `client/`）

## 文件结构

```
dsh-serial/
├── package.json          # 包配置：dsh.bundle.patch（装入声明）+ dsh.client（浏览器端声明）
├── cordis.patch.yml      # 安装补丁：把插件插入 profile 的插件层
├── lib/
│   ├── index.js          # 入口：注册串口服务 + 两个 AI 工具 + 挂载面板路由
│   ├── service.js        # 串口服务引擎（列口/开关/读/写/演示模式，环形缓冲）
│   └── routes.js         # 面板数据通道：HTTP 路由 /dsh-serial/api/*（官方 webServer 扩展点）
├── client/
│   └── client.js         # Browser 半：悬浮球面板（可拖拽 + 自适应定位，纯原生 DOM）
├── tools/
│   ├── serial-smoke.mjs       # 独立串口验证脚本（不依赖 dsh）
│   ├── mock-load-test.mjs     # Host 半模拟加载测试（工具注册/路由/安全）
│   └── client-load-test.mjs   # Browser 半行为测试（拖拽/定位/缩放，vm 模拟 DOM）
├── README.md
├── LICENSE                    # MIT
└── .gitignore
```

## 安装

```bash
# 1. 在本目录安装依赖（serialport）
npm install --registry=https://registry.npmmirror.com

# 2. 装进 dsh 的 desktop profile（二选一）
# 方式 A（推荐）：官方 CLI
dsh plugin --profile desktop add link:<本目录绝对路径>

# 方式 B：手动三件套
#   ① profiles/desktop/package.json 的 dependencies 加：
#        "dsh-serial": "link:<本目录绝对路径>"
#   ② profiles/desktop/cordis.patch.yml 追加：
#        - insert:
#            - id: dsh-serial
#              name: 'dsh-serial'
#   ③ 在 profiles/desktop 目录执行 pnpm install

# 3. 重启 dsh 桌面版
```

## 验证（三层实例，逐层加码）

**Level 0 · 不依赖 dsh（先验证最底层）**

```bash
node tools/serial-smoke.mjs                    # 应列出本机串口
node tools/serial-smoke.mjs COM3 9600 3000     # 插上板子后读取 3 秒
```

**Level 1 · 面板通道（无需硬件，使用插件演示模式）**

重启 dsh 后：界面右下角出现"串口"悬浮球 → 点开 → 点"演示模式" →
看到模拟数据（即模拟DHT11 温湿度 + HC-SR04 距离）每 0.8 秒滚动，证明面板链路通畅。

**Level 2 · AI 工具通道（无需硬件即可验证注册）**

在 dsh 新会话里对 AI 提出：

> 列一下我电脑上有哪些串口

预期：AI 调用 `serial_list_ports` 返回本机串口列表（蓝牙/虚拟口也算入）。

**Level 3 · 完整闭环（注意：需要板子完成验证）**

1. Arduino 烧一个每秒打印的程序（见下）
2. 对 AI 提出：`读一下 COM3 五秒，告诉我板子在打印什么`
3. 预期：AI 返回日志原样内容 + 自己的解读；如果此时面板正开着同一个口，工具会自动改用实时缓冲

```cpp
// Arduino 测试程序
void setup() {
  Serial.begin(9600);          // 波特率必须和读取时一致
}
void loop() {
  Serial.println("hello from board");
  delay(1000);
}
```

**Level 4 · 制造故障（体验"AI 诊断硬件"）**

把读取的波特率改成 115200（与程序的 9600 故意不一致），再让 AI 读取。
预期：AI 收到乱码，且主动提示"疑似波特率不匹配"——这属于 AI 看串口的实用价值之一。

## 降级设计（防御策略）

| 缺失的东西 | 后果 | 兜底 |
|---|---|---|
| `webServer` 服务（无 Web UI 的环境，如 headless） | 面板没有数据通道 | 工具通道照常工作，插件不崩 |
| `@deepseek-ai/dsh-tools`（defineTool 包装器） | 少一层参数校验 | 工具原样注册，功能不变 |
| `serialport` 库 | 真实串口不可用 | 演示模式可用，面板提示原因 |

## 已知边界

- 面板 UI 是原生 DOM 悬浮球（不碰 React/设置页 slot）——v0.2 再考虑升级进官方 slot
- 无构建流程：赢在改一行刷新即生效，输在没有类型检查（靠实测兜底）

## 更新记录

> 完整版本历史见 [CHANGELOG.md](CHANGELOG.md)。

- **v0.1.7**（2026-10-18）：**工程化升级**（纯工程层，运行逻辑与界面零改动）——GitHub Actions CI 自动跑测试、Issue / PR 模板、CONTRIBUTING、SECURITY、行为准则、CHANGELOG 独立成文；`npm test` 现在可用。
- **v0.1.6**（2026-10-10 夜）：**面板美化批次**（纯视觉层，功能逻辑零改动）——A 静奢玻璃（半透明磨砂 + 内高光 + 进场动画 + 连接成功描边闪绿）+ C 日志语义色（事件蓝/警告琥珀/错误红 + 新行淡入）+ **"信号喷鲸"品牌主题**（标题栏小鲸标记 + 日志空状态水印「监听中 · 等待设备输出…」+ 轻微浮动）；三态状态灯（灰/琥珀呼吸/绿光晕）；发送行 ❯ 提示符；小窗口防裁切（面板高度 78vh + 内容可滚动）；悬浮球维持经典波形款。
- **v0.1.5**（2026-10-10）：面板标题栏新增**关闭按钮**（面板遮挡悬浮球时也能关闭；点击球关闭保留，两种方式并存）；用法说明重写为**专业版**（使用说明 + 辅助功能两段，覆盖连接/异常自动提示/刷新/演示/发送/复制日志）。
- **v0.1.4**（2026-10-10）：功能健壮性批次——连接/重开/失败/停止**事件留痕**（面板与 AI 同一时间线）；**乱码双告警**（4KB 无换行 + 连续乱码行，限频）；`serial_read`"读 N 秒"改为**真实时间窗**；活动波特率只在打开成功后生效；start/stop **串行化**（防双击竞态）；关闭串口兜底超时；端口名大小写不敏感；日志游标越界自愈；面板重连失败状态复位、日志 DOM 上限、输入法回车修复、send 8KB 上限。
- **v0.1.3**（2026-10-10）：修复桌面版点「连接」报 403（`same-origin POST required`）——桌面版 Electron 代理会剥离 `origin/host` 等请求头，POST 同源校验改为「有则校验、无则放行」（与 dshmarket 同款实战验证规则）；反拒绝留痕便于诊断。
- **v0.1.2**（2026-10-10）：桌面版适配——悬浮球可拖拽（位置记忆）；面板改为贴球自适应定位（自动翻转 + 视口钳制 + 高度随窗口伸缩 + 宽度按视口比例），小窗口下不再溢出屏幕。
- **v0.1.1**（2026-10-08）：样式修复（白块按钮 → 品牌蓝）+ 整体放大；数据通道由 RPC 重构为 HTTP 路由（解决第三方插件 RPC 不可用的架构死路）。
- **v0.1.0**（2026-10-08）：初稿——面板 + AI 工具双通道打通，演示模式与真机（CH340/COM4）验证通过。

## 许可证

MIT
