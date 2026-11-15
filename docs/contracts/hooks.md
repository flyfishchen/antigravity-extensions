# 生命周期 Hook 接口契约 (`hooks.json` Specification)

本文档为 Antigravity 扩展 Monorepo 的按需契约之一，规范插件级 `hooks.json` 的配置结构、执行环境、跨入口状态共享与 JSON 通信协议。

---

## 1. 放置位置与执行环境

- **必须放在插件根目录**：原生插件（包含 `plugin.json`）只从 `<plugin-dir>/hooks.json` 加载 Hook，**禁止**放在 `hooks/hooks.json`。
- **执行环境**：Hook 以同步子进程（Unix 下 `sh -c`，Windows 下 `cmd /c`）阻塞运行，**进程工作目录固定为 `hooks.json` 所在插件根目录**，脚本内应通过相对路径（如 `node ./hooks/xxx.mjs`）引用插件文件。
- **环境变量与跨入口状态共享**：宿主仅向 `hooks.json` 与 MCP Server 进程注入 `PLUGIN_ROOT` 与 `PLUGIN_DATA`（**不会**注入 `settings.json` 的 `statusLine`、独立 `bin/*` CLI 或独立 Sidecar）。仅由 Hook 私有的状态（如告警去重）优先写入 `process.env.PLUGIN_DATA` 并回退 `os.tmpdir()`；需在 **Hook ↔ `statusLine` ↔ CLI ↔ Sidecar** 间共享的状态，必须使用确定性共享目录（如按 UID 隔离的 `path.join(os.tmpdir(), 'antigravity-<plugin>-<uid>')`）并提供环境变量覆盖以便测试隔离。

---

## 2. 顶层命名分组与事件结构

- **顶层命名分组包装**：`hooks.json` 顶层键名必须为带 `<plugin-dir>-` 前缀的具名 Hook 组（防止多插件合并冲突），组内含可选 `"enabled": true` 及事件键：
  ```json
  {
    "<plugin-dir>-main": {
      "enabled": true,
      "PreInvocation": [
        { "type": "command", "command": "node ./hooks/intercept-panel.mjs", "timeout": 5 }
      ]
    }
  }
  ```
- **扁平数组结构**（事件键下直接放置 handler 对象列表，无 `matcher`）：`SessionStart`、`PreInvocation`、`PostInvocation`、`Stop`。
- **分组匹配结构**（外层含 `matcher` 正则与 `hooks` 数组）：`PreToolUse`、`PostToolUse`。其中工具名由步骤类型去除 `CORTEX_STEP_TYPE_` 前缀并转小写得到（如 `run_command`、`edit_file`、`browser_.*`、`*`）。

---

## 3. Stdin / Stdout JSON 协议（严格 `camelCase` / ProtoJSON）

所有 Hook 均从 **stdin** 读取 JSON，并向 **stdout** 输出单行 JSON。

- **公共 stdin 字段**：
  `conversationId`、`workspacePaths`、`transcriptPath`、`artifactDirectoryPath`、`modelName`、`lastUserInput`、`hookEventName`、`cwd`（Agent 工作目录，注意与 Hook 自身进程 `cwd` 区分）。
- **`PreToolUse`**：
  - stdin 新增：`toolCall: { id, name, args }`、`stepIdx`。
  - stdout：`{ "decision": "allow" | "deny" | "ask" | "force_ask", "reason"?: "...", "permissionOverrides"?: ["..."], "overwrite"?: { ... } }`（`overwrite` 为顶层浅合并，用于重写工具参数）。
- **`PostToolUse`**：
  - stdin 新增：`toolCall`、`stepIdx`、`error?`。
  - stdout：`{}`。
- **`SessionStart` / `PreInvocation` / `PostInvocation`**：
  - `PreInvocation` / `PostInvocation` stdin 新增：`invocationNum`、`initialNumSteps`。
  - stdout：`{ "injectSteps"?: [...], "terminationBehavior"?: "" | "terminate" | "force_continue" }`（`force_continue` 仅适用于 `PostInvocation`）。
  - **零 Token 内联面板 / 预警模式**：
    ```json
    {
      "injectSteps": [
        {
          "systemMessage": {
            "systemMessage": "",
            "metadata": { "user_markdown": "..." }
          }
        }
      ],
      "terminationBehavior": "terminate"
    }
    ```
    设置 `metadata.user_markdown` 且保持 `systemMessage: ""` 可直接向用户内联渲染 Markdown 而不消耗任何大模型 Token；在 `PreInvocation` 中配合 `"terminationBehavior": "terminate"` 可实现零 Token 快捷指令拦截（如 `:ctx`）。
  - **快捷指令展开执行模式**：在 `PreInvocation` 中设置非空 `systemMessage.systemMessage`（向模型注入展开后的完整提示词）配合 `metadata.user_markdown`（向用户内联回显已采纳指令），且**省略** `terminationBehavior`（或设为空串 `""`），可在拦截如 `:s` 等短指令后继续进入本轮模型推理。
  - **错误阻断模式**：注入 `{"errorMessage": {"userMessage": "..."}}` 并配合 `"terminationBehavior": "terminate"`。
- **`Stop`**：
  - stdin 新增：`executionNum`、`terminationReason`（如 `NO_TOOL_CALL`、`MAX_INVOCATIONS`、`TERMINAL_CUSTOM_HOOK` 等）、`error`、`fullyIdle`、`continuationActive`。
  - stdout：`{ "decision": "continue" | "allow", "reason"?: "..." }`。要求继续执行时**必须检查 `continuationActive`**，避免死循环。

---

## 4. Hook 防御性编程要求

- 任何异常均须被捕获并向 stdout 输出 `{}\n` 且以退出码 `0` 结束，严禁因 Hook 脚本异常阻塞 Agent 主循环。
- `PreInvocation` 命令拦截器必须兼容以下两种盘面边界：
  1. **新会话首轮 (Turn #1)**：`transcriptPath` 甚至 `brain/<convId>` 尚未在磁盘创建时，需结合 `payload.lastUserInput`、`payload.modelName`、`payload.artifactDirectoryPath` 合成基础状态并正确执行拦截或放行。
  2. **Turn #2+ 写入延迟**：`transcript.jsonl` 末尾可能仍停留在上一轮 `PLANNER_RESPONSE`（新一轮 `USER_INPUT` 尚未落盘），需结合 `initialNumSteps` 与 `lastUserInput` 比对区分“新轮次起点”与“同一轮内的工具调用循环（mid-turn）”。
