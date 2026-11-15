# Context Usage Monitor Plugin (`context-usage`)

一个同时支持 **Antigravity CLI (`agy`)** 与 **Antigravity App / IDE** 的实时上下文用量与成本监控插件，提供零外部依赖的精准 Token 统计、分类占比、Prompt 缓存命中率、API 等效成本与缓存节省分析、历史趋势图、高水位预警以及 CLI 底部状态栏。

## 功能特性 (Features)

1. **Antigravity CLI (`agy`) 零 Skill / 零 Token 面板套件**
   - **对话内即时渲染面板（`PreInvocation` Hook：`hooks/intercept-panel.mjs`）**：在 `agy` 输入 `:ctx`、`:ctx all`（或 `:ctx all cost` 按成本降序）、**日/周/月/自定义时间统计**（`:ctx day`、`:ctx week`、`:ctx month`、`:ctx stats 2026-11-01..2026-11-15` 或 `:ctx stats --from ... --to ...`）或不带问题的 `/context-usage`，Hook 会在调用大模型前拦截（`terminationBehavior: "terminate"`），零 Token 消耗直接渲染完整仪表板（分类明细、Cache 命中与已省费用、Orchestrator 双模型分角色成本、Top Consumers 及时间窗口成本趋势）。附带自然语言提问时则自动放行，不阻断正常对话。
   - **Shell 边框面板（`bin/ctx` / `!ctx`）**：在 `agy` 中直接输入 `!ctx`、`!ctx --all`、`!ctx --stats week` 或 `!ctx --from 2026-11-01 --to 2026-11-15`，输出圆角边框（`╭─── ... ───╮`）与对齐的中文表格面板，不污染对话历史。
   - **独立全屏实时交互 TUI（`ctx` / `agy-ctx` / `context-usage --tui`）**：在分屏终端 / tmux 中运行 `ctx` 或 `agy-ctx`，进入 altscreen 实时刷新视图（1.5s），支持 `Session` / `All Sessions` / `Stats` 三标签页（`Tab`/`1`/`2`/`3`）、`↑/↓` 逐轮检查成本与细节、`p` 切换统计周期（Day/Week/Month/All）、`s` 切换排序、`f` 表面过滤与 `w` 窗口容量切换。
   - **底部实时状态栏（`bin/statusline.mjs` & 双行详情版 `bin/statusline-detail`）**：
     - 默认单行：`bin/statusline.mjs` 显示模型（Orchestrator 会带 `[PLAN]`/`[EXEC]`）、彩色进度条、占比、`⚠>200k`、`⚡ cache`、累计输入/输出与实时估算成本（可通过 `AGY_CTX_NO_COST=1` 隐藏）。
     - 双行详情：`bin/statusline-detail`（或 `AGY_CTX_DETAIL=1`）在第二行常驻展示 `Sys / Usr / Mod / Tool` 分类用量、`◆Plan / ▸Exec` 轮数与分角色成本，以及 `Cost` 与缓存节省总额。

2. **终端详情分析器 (`bin/context-usage.mjs`)**
   - 支持 `--current`、`--conv <id>`、`--file <transcript.jsonl>`、`--all`、`--stats [day|week|month|all]`、`--day`、`--week`、`--month`、`--from <date>`、`--to <date>`、`--surface <all|app|cli|ide>`、`--sort <recent|cost|context>`、`--window <tokens>`、`--panel`、`--box`、`--tui`、`--json`。
   - 展示 4 类上下文占比堆叠条、精确到每轮与每模型的 USD 成本及 Prompt Cache 节省金额、日/周/月/自定义时间维度的费用趋势与模型/会话排行、Orchestrator 双模型切换与成本对比，以及 Subagents / Swarm 子代理汇总。

3. **Antigravity App / IDE 侧边栏与全局面板 (`sidecars/context_monitor/`)**
   - 基于 Antigravity 内置 `sidecar_sdk` 构建的 Web UI Sidecar，内置 `Session` / `All Sessions` / `Stats` 三个视图，注册两个原生入口：
     - **`SIDECAR_UI_ENTRYPOINT_AUX_PANE` (`/`)**：当前会话实时监控面板（SVG 环形仪表盘、窗口容量切换 `Auto / 1M / 200K / 128K / 2M`、分类详情、Cache 命中 KPI、**Cost & Cache Savings**、交互式 Turn-by-Turn 堆叠柱状图、Top Consumers、Subagents 合并成本与跳转及 `/compact` 快捷按钮）与 **`Stats` 日/周/月/全部/自定义时间段统计面板**（含按小时/天/周/月柱状图、模型成本分解与点击跳转到会话）。
     - **`SIDECAR_UI_ENTRYPOINT_SIDEBAR` (`/global`)**：跨 `App / CLI / IDE` 全部最近会话总览，支持搜索、按表面过滤、按最近 / 成本 / 上下文排序及多会话累计成本与缓存节省总览，点击即可一键切换对话。
   - 自动响应宿主 Dark / Light 主题切换，使用 ETag 增量轮询（1.5s）降低开销。

4. **阈值预警 Hook (`hooks.json` + `hooks/check-context.mjs`)**
   - 在 `PostInvocation` 阶段检查活跃上下文占用率：低于 80% 完全静默；首次突破 **80%** 或 **90%** 时通过 `metadata.user_markdown` 向用户展示含当前会话预估成本的零模型 Token 提醒卡片，引导执行 `/compact` 或打开 `[Context Usage](sidecar://context-usage/context_monitor/)`；当 `/compact` 后用量降至 70% 以下时自动重置触发状态。

---

## 成本计算与自定义费率 (Cost & Custom Pricing)

- **自动按周缓存 + `Last-Modified` 更新校验 (`basellm` NewAPI `ratio_config`)**：
  - Sidecar、CLI 与 Hook 会自动从 [`ratio_config-v1-base.json`](https://basellm.github.io/llm-metadata/api/newapi/ratio_config-v1-base.json) 拉取 NewAPI 费率配置，按 `model_ratio * $2 / 1M`、`completion_ratio`、`cache_ratio` 与 `create_cache_ratio` 换算为美元单价，并按 **7 天周期（weekly TTL）** 原子缓存到共享目录 `/tmp/antigravity-context-usage-<uid>/ratio-config-cache.json`。
  - **轻量 `HEAD` / `If-Modified-Since` 校验**：缓存过期或手动执行刷新时，优先发送 `HEAD` + `If-Modified-Since` 对比响应头 `Last-Modified`；若远端时间未变化（`304` 或 `Last-Modified` 未更新），直接续期本地缓存而不重复下载完整 JSON 体积；仅当 `Last-Modified` 更新时触发 `GET` 拉取。
  - **零阻塞与离线容错**：`bin/statusline.mjs` 严守 `< 50ms` 与零网络原则，仅同步读取本地周缓存；CLI/Hook 遇到缓存缺失或过期时在后台异步刷新不阻塞主循环，网络异常时自动沿用旧缓存或内置费率。
  - **手动立即更新**：`node bin/context-usage.mjs --refresh-pricing`（可加 `--force-download` 跳过 `Last-Modified` 强制全量下载）或 Sidecar `POST /api/pricing/refresh`。
  - **优先级顺序**：用户显式覆盖（`AGY_CTX_PRICING_JSON` / `AGY_CTX_PRICING_FILE`） > 本地周缓存远端费率 > 内置 `DEFAULT_PRICING_PROFILES`（含 `Hydrogen / Argon / Carbon / 3.8 Flash` 与长上下文 `>200k` 阶梯定价）。
- **内置逐轮归因 (`sidecars/context_monitor/pricing.mjs`)**：
  - 严格按单轮维度拆分 **Fresh Input**、**Cache Write (`cache_creation_input_tokens`)**、**Cache Read (`cache_read_tokens`)** 与 **Output（含 Thinking）**，识别 Orchestrator 双模型分角色费率，并同步计算 **Cache Savings**（Prompt Caching 节省金额与比例）。
- **自定义费率与缓存环境变量**：
  - 内联 JSON 覆盖：`AGY_CTX_PRICING_JSON='{"my-model":{"in":1.5,"out":6.0,"cacheRead":0.15}}'`
  - 外部费率 JSON 文件：`AGY_CTX_PRICING_FILE=/path/to/pricing.json` 或 `$PLUGIN_DATA/pricing.json`
  - 远端源与缓存控制：`AGY_CTX_PRICING_URL`（自定义 NewAPI `ratio_config` URL）、`AGY_CTX_CACHE_DIR`（自定义缓存目录）、`AGY_CTX_PRICING_TTL_MS`（缓存有效期毫秒数，默认 7 天）、`AGY_CTX_NO_REMOTE_PRICING=1`（完全禁用远端费率同步）
  - 状态栏隐藏费用：设置 `AGY_CTX_NO_COST=1` 可在单/双行状态栏中关闭成本显示。

---

## 快速安装 (Installation)

### 方式一：使用安装脚本（推荐）

在仓库根目录执行：
```bash
./install.sh context-usage
```
或进入本插件目录执行：
```bash
cd plugins/context-usage && chmod +x ./install.sh && ./install.sh
```

脚本会执行两件事：
1. 将本插件软链接到 `~/.gemini/config/plugins/context-usage`（如需复制文件而非软链接，请加 `--copy`）。
2. 安全合并 `statusLine` 配置到 `~/.gemini/antigravity-cli/settings.json`（自动备份原配置为 `settings.json.bak`）。

卸载：
```bash
./install.sh context-usage --uninstall
# 或在插件目录内：./install.sh --uninstall
```

### 方式二：手动配置 CLI `/statusline` 或使用 `agy plugin`

- 通过 `agy` 校验插件结构：
  ```bash
  agy plugin validate plugins/context-usage --strict
  # 或在仓库根目录运行：npm run validate
  ```
- 在 `agy` 交互式终端内直接启用状态栏：
  ```text
  /statusline ~/.gemini/config/plugins/context-usage/bin/statusline.mjs
  ```
  或恢复默认状态栏：
  ```text
  /statusline reset
  ```

---

## 本地预览与命令行使用 (Usage)

```bash
# 查看当前会话或最近一次会话的详细上下文分析
node bin/context-usage.mjs

# 列出 App / CLI / IDE 最近会话上下文占用排行
node bin/context-usage.mjs --all

# 按日 / 周 / 月 / 自定义时间区间统计用量与成本
node bin/context-usage.mjs --stats day
node bin/context-usage.mjs --stats week
node bin/context-usage.mjs --stats month --surface cli
node bin/context-usage.mjs --from 2026-11-01 --to 2026-11-15 --box

# 以 JSON 格式导出指定会话或 transcript 文件
node bin/context-usage.mjs --file /path/to/transcript.jsonl --json

# 独立启动 Sidecar Web UI 本地预览 (http://127.0.0.1:8787)
npm run preview
```

---

## 故障排查 (Troubleshooting)

- **Antigravity App 中未出现侧边栏入口**：请确认插件目录位于 `~/.gemini/config/plugins/context-usage/` 且 `plugin.json` 未被禁用；使用 `agy plugin list` 查看插件状态。
- **CLI 状态栏未更新**：确认 `~/.gemini/antigravity-cli/settings.json` 中键名为驼峰写法 `statusLine`（非小写 `statusline`），且 `bin/statusline.mjs` 具有可执行权限（`chmod +x`）。
- **模型上下文上限显示不符合预期**：可在侧边栏右上角下拉框手动切换 `200K / 128K / 1M / 2M`，或在 CLI 中使用 `--window 200000`。
