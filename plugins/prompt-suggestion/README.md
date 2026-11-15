# Prompt Suggestion Plugin (`prompt-suggestion`)

一个零外部依赖、零大模型 Token 消耗的 Antigravity 追问预测插件，在每轮回复结束后通过确定性启发式规则 + 严格静默过滤器生成高置信度追问建议，支持 **Antigravity CLI (`agy`)**、**Antigravity App 2.0** 与 **Antigravity IDE**。

## 核心特性 (Features)

1. **纯本地零 Token 启发式引擎 (`sidecars/suggestion_panel/engine.mjs`)**
   - **`command_failed`**：上轮命令执行报错（非零退出码 / 测试失败）时，优先建议定位修复并重新验证。
   - **`unverified_edits`**：工作区代码发生修改但未在改动后运行测试/校验时，结合项目 `package.json`（优先 `npm run check` / `npm test`）建议立即验证。
   - **`plan_or_offer`**：助手输出实施计划、选项列表或主动询问确认时，建议直接采用推荐方案开始实施或先确认改动清单。
   - **`verified_edits`**：修改与测试均已通过时，建议检查 `git status` / `git diff` 或同步更新 `README.md`。
   - **`bug_diagnosis_no_edit`**：用户询问报错原因且助手完成定位分析但未改代码时，建议按分析直接修复并补充回归测试。
   - **宁缺毋滥过滤器 (`filterSuggestion`)**：严格拦截客套话（`looks good` / `thanks` / `好的` / `谢谢`）、助手口吻（`Let me...` / `我可以...`）、多句长文、代码块、Markdown 链接与协议链接；封闭式简单问答保持静默。

2. **CLI (`agy`) 输入框下方暗色 `statusLine` 预览 (`bin/statusline.mjs`)**
   - 仅在空闲态（`state === "idle"`）渲染在输入框下方首行暗灰预览：`⇢ <建议追问> [:s 发送 · :s clear]`。
   - 当 Agent 处于 `working` / `thinking` / `tool_use`、用户手动隐藏（`:s clear`）或关闭（`:s off`）时自动隐藏。
   - **兼容串联既有状态栏**：安装时若检测到 `~/.gemini/antigravity-cli/settings.json` 中已配置其他 `statusLine`（如 `context-usage`），会自动备份至 `prompt-suggestion-upstream.json` 并在状态栏中串联展示（建议行位于上方，原有状态栏紧随其下）；卸载时自动恢复原配置。
   - 兼容 `NO_COLOR` 与 `TERM=dumb`。

3. **CLI 零 Token 快捷指令 (`PreInvocation` Hook：`hooks/intercept-shortcut.mjs`)**
   - `:s` / `:suggest`：采纳第 1 条建议，零额外检索直接作为本轮用户追问提交给模型执行。
   - `:s 2` / `:s 3`：采纳第 2 或第 3 条候选建议。
   - `:s + <补充说明>` / `:s -- <补充说明>`：采纳建议并附带补充约束。
   - `:s ?` / `:s list` / `/prompt-suggestion`：零 Token 内联列出全部候选建议与当前开关状态。
   - `:s clear` / `:s off` / `:s on`：隐藏当前轮次建议或全局/会话级开关控制。

4. **终端边框面板 (`bin/suggest` / `agy-suggest`)**
   - 支持 `--current`、`--conv <id>`、`--file <transcript.jsonl>`、`--all`、`--accept [1..3]`、`--clear`、`--off`、`--on`、`--json`。

5. **App 2.0 / IDE Sidecar 侧边栏 (`sidecars/suggestion_panel/`)**
   - 注册 `SIDECAR_UI_ENTRYPOINT_AUX_PANE` (`/`) 与 `SIDECAR_UI_ENTRYPOINT_SIDEBAR` (`/global`)，支持一键 **Send ↵**（通过 `window.sidecar.agent.sendMessage` 发送）、**Copy**、**Dismiss** 与启用/暂停切换，自动适配宿主的 Light/Dark 主题。

---

## 快速安装 (Installation)

```bash
# 在仓库根目录安装
./install.sh prompt-suggestion

# 或进入插件目录安装
cd plugins/prompt-suggestion && ./install.sh
```

常用安装参数：
- `--copy`：复制文件到 `~/.gemini/config/plugins/prompt-suggestion`（默认为软链接）。
- `--no-statusline`：仅安装插件与 Hooks，不修改 `~/.gemini/antigravity-cli/settings.json`。
- `--statusline-only`：仅更新 CLI `statusLine` 配置。
- `--uninstall`：卸载插件、`agy-suggest` 软链接，并自动恢复安装前的 `statusLine`（如 `context-usage`）。

---

## 本地预览与测试 (Preview & Tests)

```bash
# 运行全部单元测试与集成测试
npm test

# 启动独立 Sidecar 本地预览 (http://127.0.0.1:8788)
npm run preview

# 严格校验插件规范
agy plugin validate . --strict
```
