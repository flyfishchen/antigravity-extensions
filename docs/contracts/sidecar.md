# Sidecar Web UI 与后台服务契约 (`sidecar.json` & `sidecar_sdk`)

本文档为 Antigravity 扩展 Monorepo 的按需契约之一，规范 Sidecar 清单、后端 `sidecar_sdk` 与独立回退服务，以及前端 `window.sidecar` 桥接与明暗主题样式隔离要求。

---

## 1. 位置与命名空间

Sidecar 置于 `plugins/<plugin-dir>/sidecars/<sidecar-folder>/`，其全局 Sidecar ID 为 **`<plugin-dir>/<sidecar-folder>`**。

---

## 2. `sidecar.json` 规范（严格 `snake_case`）

```json
{
  "command": "node",
  "args": ["main.mjs"],
  "restart_policy": "always",
  "display_name": "Example Monitor",
  "description": "What this panel shows and when to open it.",
  "has_web_ui": true,
  "agent_permissions": {
    "allows_user_interactions": false
  },
  "ui_config": {
    "display_name": "Example Monitor",
    "views": [
      { "path": "/", "entrypoint": "SIDECAR_UI_ENTRYPOINT_AUX_PANE", "title": "Example Monitor" },
      { "path": "/global", "entrypoint": "SIDECAR_UI_ENTRYPOINT_SIDEBAR", "title": "Example Monitor" }
    ]
  }
}
```

- 仅当 `has_web_ui: true` 且 `views` 包含 `SIDECAR_UI_ENTRYPOINT_AUX_PANE` 时，才可在 App/IDE 对话中输出打开侧边栏的药丸链接：`[Label](sidecar://<plugin-dir>/<sidecar-folder>/<view-path>)`（每个视图最多一条，**禁止在 CLI 表面输出**）。

---

## 3. 后端 `sidecar_sdk` 接口契约与独立运行模式

- **宿主检测**：当环境变量 `ANTIGRAVITY_LS_ADDRESS`、`ANTIGRAVITY_CSRF_TOKEN`、`ANTIGRAVITY_SIDECAR_WEB_PORT` 均存在且未传入 `--standalone` 时，动态 `import('sidecar_sdk')` 并实例化 `new sdk.SidecarApp()`；否则回退至本地 `127.0.0.1` `http.createServer`（`StandaloneSidecarApp`，支持 `--standalone --port <port>`）。其他可用环境变量包括 `ANTIGRAVITY_EXECUTABLE_DATA_DIR`、`ANTIGRAVITY_PROJECT_ID`、`ANTIGRAVITY_CONVERSATION_ID`。
- **核心 API**：
  - `app.config`：读取 `{ projectId, conversationId }`。
  - `app.page(path, handler)`：注册 HTML 页面路由（返回字符串或 `Response`）。
  - `app.api(path, handler, method)`：注册 API / 静态资源路由（支持 `'GET'` / `'POST'`，返回 JSON 对象或 `new sdk.Response(body, { contentType, status, headers })`）。
  - `await app.run()`：启动服务。
- **增量轮询**：高频轮询接口（如 1.5s 间隔）应支持 `etag` 参数比对；未变化时直接返回 `{ unchanged: true, etag }` 降低序列化开销。

---

## 4. 前端 `window.sidecar` 桥接与样式隔离

- **Bridge API**：`window.sidecar.conversationId`、`window.sidecar.fetch(url, options)`、`window.sidecar.agent.sendMessage(prompt, convId)`、`window.sidecar.getWorkspaceUris()`、`window.sidecar.onWorkspaceChange(cb)`。高风险写操作（如发送 `/compact`）在 UI 上应采用两步点击确认。
- **CSS 主题隔离红线**：
  - **严禁定义或读取 `--muted` 变量**（会与宿主 Dark Mode 中的同名 Token 冲突导致文字不可读）；所有自定义 CSS 变量必须带插件专属前缀（如 `--ctx-*`）。
  - CSS 须声明 `color-scheme: light dark`（或暗色下 `color-scheme: dark;`）。
  - 前端通过 `MutationObserver` 监听 `document.documentElement` 的 `style` 属性变更，读取 `var(--background)` 计算相对亮度以自动切换 `data-theme="dark" | "light"`，并校验宿主 `--muted-foreground` 与背景的对比度，不足时启用插件兜底前景色。
