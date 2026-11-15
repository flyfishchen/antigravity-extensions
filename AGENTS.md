# Antigravity Extensions Monorepo 开发规范与契约路由

本仓库为 **Google Antigravity**（**Antigravity CLI (`agy`)**、**Antigravity App 2.0** 与 **Antigravity IDE**）扩展插件集合的 Monorepo。本文件仅保留常驻全局红线与按需文档路由；各模块详细接口契约拆置于 [docs/contracts/](docs/contracts/)，按需读取。

---

## 1. 仓库目录结构

```text
.
├── AGENTS.md                 # 常驻全局红线与按需契约路由（严格 < 6,000 字节）
├── docs/contracts/           # 按需加载的接口与工程契约文档
├── README.md                 # 仓库总览与安装说明
├── package.json              # Monorepo workspaces 与 check / validate / test 脚本
├── install.sh                # 统一安装/卸载分发器（支持指定插件或 --all）
├── scripts/run-all.mjs       # 规则/契约检查、strict 校验与测试执行器
└── plugins/<plugin-dir>/     # 独立自包含的 Antigravity 插件包
```

---

## 2. 全局核心工程红线（常驻生效）

1. **零常驻上下文开销优先 (Zero-Token First)**
   - 凡不需要大模型推理的交互、查询或状态展示，优先使用确定性 `PreInvocation` / `PostInvocation` Hook、Sidecar Web UI 或 CLI 命令完成，避免通过 `skills/` 或 `rules/` 注入常驻 System Prompt Token。
   - 根 `AGENTS.md` 保持纯 Markdown（无 YAML frontmatter）且严格 `< 6,000` 字节；**严禁使用 `@[...]` 内联展开语法**引用子文档，必须使用普通 Markdown 链接以防启动时内联展开。
2. **跨宿主表面感知 (Multi-Surface Compatibility)**
   - 显式区分 **CLI (`agy`，`antigravity-cli/`)**、**App 2.0 (`antigravity/`)** 与 **IDE (`antigravity-ide/`)** 三类运行表面。
   - **CLI 表面严禁输出 `sidecar://` 或 `customization://` 协议链接**（终端内不可点击且污染输出），应改为 CLI 命令提示。
   - 终端渲染须兼容 `NO_COLOR` 与 `TERM=dumb`，Unicode 边框须按东亚宽字符（CJK 占 2 列）计算对齐。
3. **零外部运行时依赖与离线可测**
   - 统一面向 Node.js `>=20` 原生 ESM（`node:*`），不引入第三方 `node_modules` 运行时依赖。
   - 每个 Sidecar 须实现 `--standalone --port <port>` 本地 HTTP 回退驱动，支持脱离宿主进行无头集成测试。
4. **配置安全与测试环境隔离红线**
   - 严禁在插件脚本中直接读写 `~/.gemini/config/config.json` 或调用受限状态变更 RPC。
   - 所有涉及 `install.sh`、状态读写或配置变更的 `node:test` 测试**必须**通过 `mkdtempSync` 注入临时 `HOME` 与状态目录环境变量，严禁在 `npm test` 期间触碰宿主机真实 `~/.gemini/`。

---

## 3. 按需加载接口契约路由表（修改前必读）

新建插件或修改对应模块前，**必须先使用 `read_file` 读取表中对应的按需契约**；无需读取与当前任务无关的文档：

| 涉及范围 / 改动路径 | 按需读取契约文档 | 核心覆盖内容 |
| :--- | :--- | :--- |
| 新增插件、`plugin.json`、`mcp_config.json`、`rules/`、`skills/`、`install.sh` | [docs/contracts/plugin-and-install.md](docs/contracts/plugin-and-install.md) | 目录布局、`plugin.json` 白名单、`customization://<dir>`、MCP/Rules/Skills 约束、安装与卸载脚本 |
| `hooks.json`、`hooks/*`、跨入口状态共享 | [docs/contracts/hooks.md](docs/contracts/hooks.md) | 根目录 `hooks.json`、`<plugin-dir>-` 分组、UID 共享目录、JSON 协议、零 Token 拦截与展开模式、Turn #1/延迟边界 |
| `sidecars/**`、Web UI、`styles.css` | [docs/contracts/sidecar.md](docs/contracts/sidecar.md) | `sidecar.json`、`sidecar_sdk` 与 `--standalone`、`window.sidecar`、禁 `--muted` 与明暗主题对比度隔离 |
| `bin/*`、CLI `statusLine`、终端 TUI | [docs/contracts/cli-and-statusline.md](docs/contracts/cli-and-statusline.md) | `settings.json` 注册与全局单例串联、Payload 契约、`< 50ms` 无网络预算、静默输出、`NO_COLOR`/CJK/altscreen |
| `transcript.jsonl`、AppData、Swarm、双模型状态 | [docs/contracts/transcript-and-data.md](docs/contracts/transcript-and-data.md) | AppData 发现优先级、`transcript_full.jsonl` 按需读取、JSONL 容错、`args` 双编码去引号、Orchestrator 状态机 |

---

## 4. 强制验证门禁

每次提交或完成任务前，必须在仓库根目录运行并通过：

```bash
npm run check
```

门禁依次检查：根 `AGENTS.md`（无 frontmatter、无 `@[...]` 内联引用、`< 6,000` 字节及契约链接有效）与插件 `rules/*.md`（`< 24,000` 字节）、全量 `agy plugin validate --strict`，以及全量 `npm test`（`fail 0` 且 `skipped 0`）。
