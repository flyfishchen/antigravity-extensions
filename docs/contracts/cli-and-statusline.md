# Antigravity CLI (`agy`) 状态栏与终端工具接口 (`statusLine` & TUI)

本文档为 Antigravity 扩展 Monorepo 的按需契约之一，规范 `settings.json` 中的 `statusLine` 注册、多插件链式串联、Stdin Payload 协议与终端渲染约束。

---

## 1. `settings.json` 注册格式与全局单例串联

CLI 状态栏配置位于 `~/.gemini/antigravity-cli/settings.json`，顶级键名必须为驼峰 **`statusLine`**（修改前须备份为 `settings.json.bak` 并保留用户其他已有字段）：

```json
{
  "statusLine": {
    "type": "command",
    "command": "~/.gemini/config/plugins/<plugin-dir>/bin/statusline.mjs",
    "enabled": true,
    "padding": 0,
    "stack_with_default": true
  }
}
```

- **全局单例链式串联契约**：`settings.json` 的 `statusLine` 为全局单例，且根 `./install.sh` 按插件名字母序依次执行安装。叠加型 `statusLine` 插件在写入 `settings.json` 前，若检测到已存在非自身的 `statusLine` 配置，必须将其持久化备份（如 `~/.gemini/antigravity-cli/<plugin>-upstream.json`），运行时优先通过同进程动态 `import()` 调用上游 `.mjs` 导出的渲染函数（回退 `spawnSync`）并将双行输出以 `\n` 拼接，支持 `--no-statusline` 跳过注册，且在 `--uninstall` 时若上游脚本仍存在则自动恢复上游配置。

---

## 2. Stdin Payload 契约（`snake_case`）

```json
{
  "cwd": "/path/to/workspace",
  "transcript_path": "/path/to/transcript.jsonl",
  "state": "idle | thinking | working | tool_use",
  "exceeds_200k_tokens": false,
  "model": {
    "id": "gemini-pro-orchestrator",
    "display_name": "Orchestrator (Carbon)",
    "effort": "high"
  },
  "context_window": {
    "context_window_size": 1048576,
    "used_percentage": 8.7,
    "total_input_tokens": 885925,
    "total_output_tokens": 14513,
    "current_usage": {
      "input_tokens": 3451,
      "cache_read_input_tokens": 86981,
      "cache_creation_input_tokens": 0,
      "output_tokens": 526
    }
  }
}
```

---

## 3. 终端实现约束

- 单次状态栏渲染须在 `< 50ms` 内完成且严禁发起任何网络请求。
- 读取运行状态须兼容 `payload.state ?? payload.agent_state`；当无内容可展示（且无上游输出）时应输出空串而非空白换行，避免撑高输入框下方留白。
- 当 `context_window.used_percentage`、缓存明细或 Orchestrator 阶段字段缺失时，应回退解析 `transcript_path` 补全精确信息。
- 所有终端输出须遵守 `NO_COLOR` 环境变量与 `TERM=dumb`；绘制 Unicode 边框面板时必须正确计算东亚宽字符（CJK 等全角字符占 2 列宽度）以保证表格对齐；全屏交互 TUI 应使用 altscreen 并正确处理退出恢复与键盘事件（如 `Tab`、`↑/↓`、`r`、`q`）。
