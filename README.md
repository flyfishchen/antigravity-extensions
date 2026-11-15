# Antigravity Extensions Monorepo

Google Antigravity（CLI `agy` / App 2.0 / IDE）扩展插件集合仓库，统一维护插件开发规范、接口契约与多插件自动化校验。

## 仓库结构

```text
.
├── AGENTS.md                 # 常驻全局红线与按需契约路由
├── docs/
│   └── contracts/            # 按需加载的接口契约文档（Hooks / Sidecar / statusLine / Transcript / 插件）
├── install.sh                # 统一安装/卸载入口（支持单插件或全量操作）
├── package.json              # Monorepo 全局脚本（check / validate / test / list）
├── scripts/
│   └── run-all.mjs           # 多插件 strict 校验、规则预算检查与测试执行器
└── plugins/
    └── context-usage/        # 实时上下文用量监控与状态栏插件
```

## 插件列表

| 插件目录 | 说明 | 文档 |
| :--- | :--- | :--- |
| `context-usage` | 实时上下文窗口仪表板、零 Token `:ctx` Hook、终端 TUI、`agy` 状态栏与 App/IDE Sidecar 面板 | [plugins/context-usage/README.md](./plugins/context-usage/README.md) |

## 快速安装

```bash
# 安装全部插件（默认软链接至 ~/.gemini/config/plugins/）
./install.sh

# 仅安装指定插件
./install.sh context-usage

# 复制模式安装或卸载
./install.sh context-usage --copy
./install.sh context-usage --uninstall
```

## 校验与测试

```bash
# 运行全部门禁（AGENTS.md 字节/格式检查 + agy plugin validate --strict + 所有插件单测）
npm run check

# 仅校验插件清单与规则文件
npm run validate

# 仅运行所有插件测试
npm test

# 列出所有插件
npm run list
```

开发新插件或调整宿主对接接口前，请先阅读 [AGENTS.md](./AGENTS.md) 中的常驻全局红线，并按需查阅 [docs/contracts/](./docs/contracts/) 下的模块契约。
