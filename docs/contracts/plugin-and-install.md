# 插件包结构、清单、MCP/Rules/Skills 与安装卸载契约

本文档为 Antigravity 扩展 Monorepo 的按需契约之一，涵盖标准插件目录布局、`plugin.json` 清单白名单、配置安全与工作区发现、`mcp_config.json` / `rules/` / `skills/` 规范，以及新增插件清单与 `install.sh` 规范。

---

## 1. 标准插件目录布局 (`plugins/<plugin-dir>/`)

仅创建插件实际使用的子目录与文件：

```text
plugins/<plugin-dir>/
├── plugin.json               # 必填：插件清单（JSONC）
├── README.md                 # 面向用户的说明文档（不会被 Agent 自动注入）
├── package.json              # 插件级脚本（test / preview）
├── install.sh                # 插件级安装/卸载脚本（symlink / --copy / --uninstall）
├── hooks.json                # 可选：生命周期 Hook（必须置于插件根目录）
├── mcp_config.json           # 可选：MCP 服务器配置
├── assets/
│   └── logo.svg              # 可选：>=128x128 正方形透明背景图标，预留约 10% 留白
├── bin/                      # 可选：CLI 可执行入口（statusline、面板、TUI 等）
├── hooks/                    # 可选：Hook 执行脚本
├── sidecars/
│   └── <sidecar-folder>/
│       ├── sidecar.json      # Sidecar 清单
│       └── main.mjs          # Sidecar 服务入口
├── rules/
│   └── AGENTS.md             # 可选：插件启用的常驻规则（无 frontmatter）
├── skills/
│   └── <skill-name>/
│       └── SKILL.md          # 可选：仅在确实需要自然语言工作流时提供
├── agents/
│   └── <agent-name>.md       # 可选：自定义子代理定义
└── test/
    └── *.test.mjs            # 必填：node:test 单元测试与集成测试
```

---

## 2. `plugin.json` 字段白名单（JSONC）

Antigravity 加载器会**静默丢弃**未知顶级字段；禁止在 `plugin.json` 中添加规范外字段：

| 字段 | 类型 | 说明 |
| :--- | :--- | :--- |
| `name` | `string` | 唯一全局标识（小写 kebab-case）；若与已加载插件重名，低优先级插件会被**静默丢弃**。缺省时回退为目录名。 |
| `displayName` | `string` | 可选，UI 卡片与菜单中展示的可读标题。 |
| `version` | `string` | 可选，语义化版本号（如 `"1.0.0"`）。 |
| `description` | `string` | 一到两句话概述插件用途与适用场景，用于 Marketplace 搜索与展示。 |
| `logo` | `string` | 可选，插件内相对路径（支持 `.svg` / `.png` / `.jpg` / `.jpeg` / `.webp`）；URL 与绝对路径会被静默忽略。 |
| `suggestedPrompts` | `string[]` | 可选，最多 3 条推荐起始提示词（超出 3 条将被忽略，空串跳过）。 |
| `author` | `string \| { name, url? }` | 可选，作者或团队名称（`url` 须为 `https://`）。 |
| `homepage` | `string` | 可选，项目文档网址（`https://`）。 |
| `repository` | `string \| { type, url }` | 可选，源码仓库地址（`https://`）。 |
| `disabled` | `boolean` | 可选，默认是否关闭；用户本地 `config.json` 选择优先级高于此字段。 |

---

## 3. 目录标识 `<dir>`、配置安全与工作区发现

- **目录 ID 与深链**：App/IDE 中跳转插件详情页必须使用 `[<label>](customization://<dir>)`（`<dir>` 为 `~/.gemini/config/plugins/<dir>` 的安装目录名，而非 `plugin.json` 的 `name`）；禁止使用 `plugin://` 或 `plugins://`。**CLI 表面严禁输出 `customization://` 协议链接**。
- **禁止手改 `config.json`**：`~/.gemini/config/config.json` 由 Language Server 以 `0600` 权限原子维护，包含 `userSettings` 与权限授权等并发状态，严禁在插件脚本中直接读写或调用受限的状态变更 RPC。
- **工作区显式发现 (`.agents/plugins.json` / `.agents/skills.json`)**：支持以下结构（`entries` 中的每个目录仅扫描**一层深度**）：

```json
{
  "inherits": [
    { "path": "/path/to/shared/plugins.json", "include_only": ["..."], "exclude": ["..."] }
  ],
  "entries": [
    { "path": "plugins", "include_only": ["context-usage"], "exclude": ["experimental-.*"] }
  ]
}
```

---

## 4. MCP Server、Rules 与 Skills 规范 (`mcp_config.json` / `rules` / `skills`)

- **MCP Server (`mcp_config.json`)**：
  - 仅支持 **Stdio**（`{ "command", "args", "env" }`）与 **Streamable HTTP**（`{ "url": "https://.../mcp" }`，兼容旧键 `serverUrl`）；**不支持**旧版 HTTP+SSE (`/sse`) 传输。
  - MCP Server 名称属于全局命名空间，插件内定义的 server 键名**必须**以 `<plugin-dir>-` 为前缀，禁止使用 `search`、`db` 等通用名。
- **Rules (`AGENTS.md` / `GEMINI.md` / `rules/AGENTS.md`)**：
  - 必须为纯 Markdown，**禁止包含 YAML frontmatter**。
  - **单文件上限 24,000 字节**（含 `@[label](path)` 展开后；超出部分会被截断），所有常驻规则共享 20,000 tokens 聚合预算；规则文本必须精炼聚焦架构约束与接口契约。
  - 若需要按需加载参考手册，应使用普通 Markdown 链接 `[label](path)` 而非 `@[label](path)`，避免启动时被强制内联展开。
- **Skills (`skills/<skill-name>/SKILL.md`)**：
  - 仅在必须依赖大模型执行多步流程或提示词引导时才创建；须含合法 YAML frontmatter（`name`、`description`），主体保持精简并通过 `references/` 与 `scripts/` 实现渐进披露。

---

## 5. 新增插件 Checklist 与 `install.sh` 规范

1. 在 `plugins/<new-plugin>/` 创建自包含目录及合法的 `plugin.json`。
2. 编写完整测试 `plugins/<new-plugin>/test/*.test.mjs`（覆盖 Hook 边界、CLI 输出、Sidecar API、安装脚本与独立运行模式），并在插件 `package.json` 中配置 `"test"` 脚本；**测试环境隔离红线**：所有涉及 `install.sh`、状态读写或配置变更的测试必须通过 `mkdtempSync` 注入临时 `HOME` 与状态目录环境变量，严禁在 `npm test` 期间触碰宿主机真实 `~/.gemini/`。
3. 提供可独立运行且幂等的 `plugins/<new-plugin>/install.sh`，支持：
   - 默认软链接至 `~/.gemini/config/plugins/<new-plugin>`（及可选 `--no-statusline`）
   - `--copy` 复制模式安装
   - `--uninstall` 完整卸载（如修改了 `~/.gemini/antigravity-cli/settings.json`，须自动生成 `settings.json.bak`，卸载时仅清理本插件自身配置并在存在上游 `statusLine` 备份时恢复上游）。
