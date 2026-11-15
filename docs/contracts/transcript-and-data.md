# 会话轨迹与数据面接口 (`transcript.jsonl` & AppData)

本文档为 Antigravity 扩展 Monorepo 的按需契约之一，规范跨宿主 AppData 路径发现、紧凑/完整轨迹读取、JSONL Schema 容错解析与 Orchestrator 双模型状态机。

---

## 1. AppData 与数据文件路径发现

- **目录发现优先级**：
  1. `ANTIGRAVITY_EXECUTABLE_DATA_DIR`（向上查找父级包含 `sidecar_data` 的目录并取其上级）
  2. `ANTIGRAVITY_APP_DATA_DIR`
  3. `~/.gemini/antigravity`（`app`）、`~/.gemini/antigravity-cli`（`cli`）、`~/.gemini/antigravity-ide`（`ide`），及其余 `~/.gemini/*` 含 `brain/` 的目录。
- **核心文件**：
  - 紧凑轨迹：`<appData>/brain/<convId>/.system_generated/logs/transcript.jsonl`
  - 完整轨迹：`transcript_full.jsonl`（仅当步记录含 `truncated_fields` 且确需完整正文时按行号按需读取，避免全量载入撑爆内存）
  - Swarm 成员表：`<appData>/brain/<convId>/.system_generated/swarm/members.json`

---

## 2. Step JSONL Schema 与解析规则

- 常用字段：`step_index`、`source`（`USER_EXPLICIT` | `MODEL` | `SYSTEM`）、`type`（`USER_INPUT` | `PLANNER_RESPONSE` | `SYSTEM_MESSAGE` | `GENERIC`）、`status`、`created_at`、`model`、`input_tokens`、`cache_read_tokens`、`cache_creation_input_tokens`、`output_tokens`、`content`、`thinking`、`tool_calls`、`truncated_fields`。
- **容错与缓存**：实时写入期间必须忽略文件末尾尚未落盘完整的残缺 JSON 行；读取与解析应按 `mtimeMs:size` 做内存缓存（LRU 上限控制）。
- **参数双重编码与零 Token 尾部轮次**：`tool_calls[].args` 中的字符串字段可能为双重 JSON 编码（如 `"\"npm test\""`），提取命令或路径前须安全反序列化去引号；被 `PreInvocation` 零 Token 终止的快捷指令（如 `:ctx`、`:s ?`）会在轨迹末尾留下无 `PLANNER_RESPONSE` 的孤立 `USER_INPUT`，分析“最近一轮有效对话”时须剥离此类尾部步骤。
- **Orchestrator 双模型状态机**：
  - 通过 `model` ID 关键字（`*orchestrator*`/`*planner*` vs `*worker*`/`*executor*`）或切换事件识别 Planner (`PLAN`) 与 Worker (`EXEC`) 角色。
  - 当 `PLANNER_RESPONSE.tool_calls` 出现 `exit_plan_mode` 时切入 `worker` 阶段；当遇到 `USER_INPUT` 或 `SYSTEM_MESSAGE` 内容含 `[plan review]`（注意排除工具返回体 `GENERIC` 中的字面量文本）时切回 `planner` 阶段。
