# 参与贡献

感谢你愿意改进 dsh-serial。这个项目只解决一个具体问题：**让 AI 能"看见"单片机的串口输出**。任何让这件事更稳、更容易上手的改动都欢迎。

## 环境要求

| 项目 | 要求 |
|---|---|
| Node.js | >= 20 |
| dsh | 桌面版或 Web 版均可 |
| 开发板 | 可选。只有硬件冒烟测试需要（Arduino / STM32 / ESP32 / 51 均可） |

## 本地开发

```bash
git clone https://github.com/Canye-zdm/dsh-serial.git
cd dsh-serial
npm install --registry=https://registry.npmmirror.com
```

改完代码，**提交前必须让测试通过**：

```bash
npm test            # Host 半 + Browser 半，无需硬件
npm run test:smoke  # 需要真实串口，插上板子再跑
```

三个测试各自负责什么，见 README 的「验证」一节。CI 会自动跑前两个，**测试不过的 PR 不会被合并**。

## 提交信息规范

使用 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/)：

```
<类型>: <一句话说明>
```

| 类型 | 用途 |
|---|---|
| `feat` | 新增功能 |
| `fix` | 修复缺陷 |
| `docs` | 只改文档 |
| `refactor` | 重构，不改变外部行为 |
| `test` | 增删改测试 |
| `chore` | 构建、依赖、配置 |

规则只有三条，但要认真执行：

1. **一次提交只做一件事**。不要把格式化、重命名和功能改动混在一个 commit 里——审查时无法区分哪些行是真正的逻辑改动。
2. **说明用祈使句**，写"修复串口重开失败"，不写"修复了串口重开失败"或"update"。
3. 中文或英文都可以，但**同一个仓库保持一致**。本项目以中文为主。

示例：

```
fix: 修复桌面版点连接报 403
feat: 面板支持自定义波特率
docs: 补充 macOS 串口权限说明
```

## 分支与 PR

- 分支命名：`feat/xxx`、`fix/xxx`、`docs/xxx`
- 从 `main` 切出，改完提 PR 回 `main`
- **不要直接 push 到 main**（已启用分支保护，push 会被拒绝）
- PR 描述里写清：改了什么、为什么改、怎么验证的
- 涉及 UI 的改动附一张截图

## 发版流程（维护者）

1. 把 `CHANGELOG.md` 中 `[Unreleased]` 的内容移到新版本号下
2. 修改 `package.json` 的 `version`
3. 提交：`chore: release vX.Y.Z`
4. 打标签并推送：`git tag vX.Y.Z && git push origin vX.Y.Z`
5. 在 GitHub 上基于该标签创建 Release，正文从 `CHANGELOG.md` 复制

版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)：不兼容改动升 MAJOR，新增功能升 MINOR，修复升 PATCH。

## 一个请求

如果你在改某个东西时发现"这里为什么这么写"，先开 Issue 问一句再动手。这个插件里有些看起来奇怪的做法（比如同源校验"有则校验、无则放行"）是踩过坑之后才定下来的，直接改回去会让老问题复发。
