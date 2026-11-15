#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import {
  aggregateUsageStats,
  analyzeConversation,
  analyzeTranscriptFile,
  analyzeTranscriptText,
  formatCost,
  formatPct,
  formatTokens,
  listRecentConversations,
} from '../sidecars/context_monitor/analyzer.mjs';

const USER_REQUEST_RE = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i;
const METADATA_BLOCK_RE =
  /<(?:ADDITIONAL_METADATA|USER_SETTINGS_CHANGE|SYSTEM_MESSAGE)>[\s\S]*?<\/(?:ADDITIONAL_METADATA|USER_SETTINGS_CHANGE|SYSTEM_MESSAGE)>/gi;
const PANEL_CMD_RE = /^(?:\/context-usage(?::context-usage)?|:ctx|:context)(?:\s+([\s\S]*))?$/i;
const ID_RE = /^[0-9a-f-]{8,64}$/i;

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      buf += chunk;
    });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', () => resolve(buf));
  });
}

function extractRawPromptText(content) {
  if (typeof content !== 'string' || !content.trim()) return '';
  const m = USER_REQUEST_RE.exec(content);
  if (m) return m[1].trim();
  return content.replace(METADATA_BLOCK_RE, ' ').trim();
}

const DATE_ONLY_RE = /^20\d{2}[-/]\d{1,2}[-/]\d{1,2}$/;
const DATE_TOKEN_RE = /^20\d{2}[-/]\d{1,2}[-/]\d{1,2}(?:[T\s]\d{1,2}:\d{2}(?::\d{2})?)?$/;
const DATE_RANGE_TOKEN_RE =
  /^(20\d{2}[-/]\d{1,2}[-/]\d{1,2}(?:[T\s]\d{1,2}:\d{2}(?::\d{2})?)?)(?:\.\.|~)(20\d{2}[-/]\d{1,2}[-/]\d{1,2}(?:[T\s]\d{1,2}:\d{2}(?::\d{2})?)?)$/;

function parsePanelCommand(rawText) {
  const trimmed = String(rawText || '').trim();
  if (!trimmed) return null;
  const m = PANEL_CMD_RE.exec(trimmed);
  if (!m) return null;

  const rest = (m[1] || '').trim();
  const parsed = {
    all: false,
    stats: false,
    period: 'week',
    from: '',
    to: '',
    surface: 'all',
    sort: 'recent',
    windowSize: 0,
    conv: '',
  };
  if (!rest) return parsed;

  const positionalDates = [];
  const tokens = rest.split(/\s+/);
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const lower = tok.toLowerCase();
    if (lower === 'stats' || lower === '--stats') {
      parsed.stats = true;
    } else if (/^--stats=.+$/i.test(tok)) {
      const val = tok.slice('--stats='.length);
      if (/^(day|today|1d|week|7d|month|30d|all|custom)$/i.test(val)) {
        parsed.stats = true;
        parsed.period = val.toLowerCase();
      } else if (DATE_RANGE_TOKEN_RE.test(val)) {
        const rm = DATE_RANGE_TOKEN_RE.exec(val);
        parsed.stats = true;
        parsed.period = 'custom';
        parsed.from = rm[1];
        parsed.to = rm[2];
      } else if (DATE_TOKEN_RE.test(val)) {
        if (positionalDates.length >= 2) return null;
        parsed.stats = true;
        parsed.period = 'custom';
        positionalDates.push(val);
      } else {
        return null;
      }
    } else if (lower === 'day' || lower === '--day' || lower === 'today' || lower === '--today' || lower === '1d') {
      parsed.stats = true;
      parsed.period = 'day';
    } else if (lower === 'week' || lower === '--week' || lower === '7d') {
      parsed.stats = true;
      parsed.period = 'week';
    } else if (lower === 'month' || lower === '--month' || lower === '30d') {
      parsed.stats = true;
      parsed.period = 'month';
    } else if (parsed.stats && lower === 'all') {
      parsed.period = 'all';
    } else if (DATE_RANGE_TOKEN_RE.test(tok)) {
      const rm = DATE_RANGE_TOKEN_RE.exec(tok);
      parsed.stats = true;
      parsed.period = 'custom';
      parsed.from = rm[1];
      parsed.to = rm[2];
    } else if (lower === '--from' && tokens[i + 1]) {
      parsed.stats = true;
      parsed.period = 'custom';
      parsed.from = tokens[++i];
    } else if (/^--from=.+$/i.test(tok)) {
      parsed.stats = true;
      parsed.period = 'custom';
      parsed.from = tok.slice('--from='.length);
    } else if (lower === '--to' && tokens[i + 1]) {
      parsed.stats = true;
      parsed.period = 'custom';
      parsed.to = tokens[++i];
    } else if (/^--to=.+$/i.test(tok)) {
      parsed.stats = true;
      parsed.period = 'custom';
      parsed.to = tok.slice('--to='.length);
    } else if (DATE_TOKEN_RE.test(tok)) {
      if (positionalDates.length >= 2) return null;
      parsed.stats = true;
      parsed.period = 'custom';
      positionalDates.push(tok);
    } else if (lower === '--surface' && tokens[i + 1] && /^(all|app|cli|ide)$/i.test(tokens[i + 1])) {
      parsed.surface = tokens[++i].toLowerCase();
    } else if (/^--surface=(all|app|cli|ide)$/i.test(tok)) {
      parsed.surface = tok.slice('--surface='.length).toLowerCase();
    } else if (lower === 'all' || lower === '--all' || lower === '-a' || lower === 'list' || lower === '--list') {
      parsed.all = true;
    } else if (lower === 'cost' || lower === '--cost') {
      parsed.sort = 'cost';
    } else if (lower === '--sort' && tokens[i + 1] && /^(recent|cost|context)$/i.test(tokens[i + 1])) {
      parsed.sort = tokens[++i].toLowerCase();
    } else if (/^--sort=(recent|cost|context)$/i.test(tok)) {
      parsed.sort = tok.slice('--sort='.length).toLowerCase();
    } else if (lower === '--window' && tokens[i + 1] && /^\d+$/.test(tokens[i + 1])) {
      parsed.windowSize = Number(tokens[++i]);
    } else if (/^--window=\d+$/i.test(tok)) {
      parsed.windowSize = Number(tok.slice('--window='.length));
    } else if (lower === '--conv' && tokens[i + 1] && ID_RE.test(tokens[i + 1])) {
      parsed.conv = tokens[++i];
    } else if (/^--conv=[0-9a-f-]{8,64}$/i.test(tok)) {
      parsed.conv = tok.slice('--conv='.length);
    } else {
      // Natural language question or unrecognized argument -> pass through to the model
      return null;
    }
  }

  if (positionalDates.length === 1) {
    const d = positionalDates[0];
    if (!parsed.from && !parsed.to) {
      parsed.from = d;
      if (DATE_ONLY_RE.test(d)) parsed.to = d;
    } else if (!parsed.from) {
      parsed.from = d;
    } else if (!parsed.to) {
      parsed.to = d;
    } else {
      return null;
    }
  } else if (positionalDates.length === 2) {
    if (parsed.from || parsed.to) return null;
    parsed.from = positionalDates[0];
    parsed.to = positionalDates[1];
  }

  return parsed;
}

function makeGaugeBar(pct, width = 14) {
  const clamped = Math.max(0, Math.min(100, Number(pct) || 0));
  let filled = Math.round((clamped / 100) * width);
  if (clamped > 0 && filled === 0) filled = 1;
  if (filled > width) filled = width;
  return `${'▰'.repeat(filled)}${'▱'.repeat(width - filled)}`;
}

function extractPayloadRawString(payload = {}) {
  const candidates = [
    payload?.lastUserInput,
    payload?.last_user_input,
    payload?.userInput,
    payload?.user_input,
    payload?.prompt,
  ];
  for (const val of candidates) {
    if (typeof val === 'string' && val.trim()) {
      return val;
    }
    if (val && typeof val === 'object' && typeof val.content === 'string' && val.content.trim()) {
      return val.content;
    }
  }
  return '';
}

function inspectTranscriptState(transcriptPath, payload = {}) {
  const rawInvNum = payload?.invocationNum ?? payload?.invocation_num;
  if (rawInvNum !== undefined && rawInvNum !== null && rawInvNum !== '') {
    const parsedInvNum = Number(rawInvNum);
    if (Number.isFinite(parsedInvNum) && parsedInvNum > 0) {
      return { midTurn: true, promptText: '' };
    }
  }

  const rawInput = extractPayloadRawString(payload);
  const fallbackText = extractRawPromptText(rawInput);
  const rawInitialSteps = payload?.initialNumSteps ?? payload?.initial_num_steps;
  const parsedInitSteps =
    rawInitialSteps !== undefined && rawInitialSteps !== null && rawInitialSteps !== ''
      ? Number(rawInitialSteps)
      : NaN;
  const hasValidInitSteps = Number.isFinite(parsedInitSteps) && parsedInitSteps > 0;

  if (transcriptPath && existsSync(transcriptPath)) {
    try {
      const text = readFileSync(transcriptPath, 'utf8');
      const steps = [];
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const obj = JSON.parse(trimmed);
          if (obj && typeof obj === 'object') steps.push(obj);
        } catch {
          // Ignore partial trailing line
        }
      }

      let lastUserIdx = -1;
      for (let i = steps.length - 1; i >= 0; i--) {
        if (steps[i].type === 'USER_INPUT') {
          lastUserIdx = i;
          break;
        }
      }

      if (lastUserIdx >= 0) {
        const lastTranscriptPrompt = extractRawPromptText(steps[lastUserIdx].content);
        const tailSteps = steps.slice(lastUserIdx + 1);
        let lastPlannerOffset = -1;
        for (let i = tailSteps.length - 1; i >= 0; i--) {
          if (tailSteps[i].type === 'PLANNER_RESPONSE' || tailSteps[i].type === 'MODEL_RESPONSE') {
            lastPlannerOffset = i;
            break;
          }
        }
        // Mid-turn guard: if PLANNER_RESPONSE already ran after the latest USER_INPUT, check whether a new turn started before transcript flush.
        if (lastPlannerOffset >= 0) {
          const afterLastPlanner = tailSteps.slice(lastPlannerOffset + 1);
          const hasPlanReviewAfter = afterLastPlanner.some(
            (s) =>
              s.type === 'SYSTEM_MESSAGE' &&
              typeof s.content === 'string' &&
              s.content.includes('[plan review]')
          );
          if (hasPlanReviewAfter && (!fallbackText || fallbackText === lastTranscriptPrompt)) {
            return { midTurn: true, promptText: '' };
          }
          if (fallbackText && fallbackText !== lastTranscriptPrompt) {
            return { midTurn: false, promptText: fallbackText };
          }
          const lastStep = steps[steps.length - 1];
          const lastStepIdx =
            typeof lastStep.step_index === 'number' ? lastStep.step_index : steps.length - 1;
          const lastToolCalls = Array.isArray(lastStep.tool_calls) ? lastStep.tool_calls : [];
          const onlyAskQuestion =
            lastToolCalls.length > 0 && lastToolCalls.every((tc) => tc?.name === 'ask_question');
          const completedAtTail =
            (lastStep.type === 'PLANNER_RESPONSE' || lastStep.type === 'MODEL_RESPONSE') &&
            (lastToolCalls.length === 0 || onlyAskQuestion);
          if (completedAtTail && hasValidInitSteps && parsedInitSteps > lastStepIdx && fallbackText) {
            return { midTurn: false, promptText: fallbackText };
          }
          return { midTurn: true, promptText: '' };
        }
        const hasPlanReview = tailSteps.some(
          (s) =>
            s.type === 'SYSTEM_MESSAGE' &&
            typeof s.content === 'string' &&
            s.content.includes('[plan review]')
        );
        if (hasPlanReview && (!fallbackText || fallbackText === lastTranscriptPrompt)) {
          return { midTurn: true, promptText: '' };
        }
        if (fallbackText) {
          return { midTurn: false, promptText: fallbackText };
        }
        if (tailSteps.length === 0) {
          return { midTurn: false, promptText: lastTranscriptPrompt };
        }
        return { midTurn: true, promptText: '' };
      }
    } catch {
      // Fall back to payload user input below
    }
  }

  return {
    midTurn: false,
    promptText: fallbackText,
  };
}

function formatMarkdownSessionsList(items, { isCliSurface }) {
  const totalCost = items.reduce((sum, item) => sum + (Number(item.costUsd) || 0), 0);
  const lines = [
    `### ◆ Antigravity 会话上下文总览 (${items.length}) · 累计成本 ${formatCost(totalCost)}`,
    '',
    '| Surface | Conv ID | Usage | Active | Cost | Model | Title |',
    '| :--- | :--- | :--- | ---: | ---: | :--- | :--- |',
  ];

  for (const item of items) {
    const idShort = String(item.conversationId || '').slice(0, 8);
    const bar = `${makeGaugeBar(item.usedPercentage, 8)} ${formatPct(item.usedPercentage)}`;
    const active = `${formatTokens(item.activeContextTokens)} / ${formatTokens(item.contextWindowSize)}`;
    const modelBase = item.modelLabel || item.model || 'Unknown';
    const modelCell =
      item.isOrchestrator && item.activeTag ? `${modelBase} \`[${item.activeTag}]\`` : modelBase;
    const titleSafe = String(item.title || '').replace(/\|/g, '\\|');
    lines.push(
      `| ${String(item.product || '').toUpperCase()} | \`${idShort}\` | \`${bar}\` | ${active} | ${formatCost(item.costUsd, { compact: true })} | ${modelCell} | ${titleSafe} |`
    );
  }

  lines.push('');
  if (isCliSurface) {
    lines.push(
      '> 零 Token 快捷面板：`:ctx` · `:ctx all` · `!ctx`（边框面板）· 独立终端运行 `ctx` 打开全屏实时交互面板'
    );
  } else {
    lines.push('[Context Usage](sidecar://context-usage/context_monitor/)');
  }
  return lines.join('\n');
}

function formatMarkdownPanel(data, { isCliSurface }) {
  const idShort = data.conversationId ? data.conversationId.slice(0, 8) : 'local';
  const surface = String(data.product || (isCliSurface ? 'cli' : 'app')).toUpperCase();
  const mb = data.modelBreakdown;
  const bar = makeGaugeBar(data.usedPercentage, 14);
  const health = String(data.health || 'healthy').toUpperCase();
  const warn200k = data.exceeds200k ? ' · ⚠️ `>200k`' : '';

  let modelSummary = `**${data.modelLabel || data.model || 'Unknown'}**`;
  if (mb?.isMultiModel) {
    const phaseText = mb.activeTag
      ? `\`[${mb.activeTag}${mb.activeModel ? ` · ${mb.activeModel}` : ''}]\``
      : mb.activeModel
        ? `(\`${mb.activeModel}\`)`
        : '';
    const swText =
      mb.switchCount > 0 ? ` · ⇄ **${mb.switchCount}** 次切换` : ' · 暂无切换';
    modelSummary += `${phaseText ? ` ${phaseText}` : ''}${swText}`;
  } else if (data.model && data.model !== data.modelLabel) {
    modelSummary += ` (\`${data.model}\`)`;
  }

  const cost = data.cost || {};
  const subCostNote =
    data.subagents?.length && (cost.totalWithSubagentsUsd || 0) > (cost.totalCostUsd || 0)
      ? ` · 含子代理合计 **${formatCost(cost.totalWithSubagentsUsd)}**`
      : '';

  const lines = [
    `### ◆ Context Usage Panel · \`${idShort}\` [${surface}]`,
    '',
    `- **标题**: ${data.title || 'Untitled conversation'}`,
    `- **模型**: ${modelSummary}`,
    `- **活跃窗口**: \`${bar}\` **${formatTokens(data.activeContextTokens)} / ${formatTokens(data.contextWindowSize)} (${formatPct(data.usedPercentage)})** · \`${health}\` · 剩余 **${formatTokens(data.remainingTokens)}** (${formatPct(data.remainingPercentage)})${warn200k}`,
    `- **预估成本**: **${formatCost(cost.totalCostUsd)}**（输入 ${formatCost(cost.inputCostUsd)} · 缓存读取 ${formatCost(cost.cacheReadCostUsd)} · 输出 ${formatCost(cost.outputCostUsd)} · 缓存已省 **${formatCost(cost.cacheSavingsUsd)}** / ${formatPct(cost.cacheSavingsPercentage)}）${subCostNote}`,
    '',
    '| Category | Tokens | Share |',
    '| :--- | ---: | ---: |',
    `| System & Tools | ${formatTokens(data.categories?.systemAndTools?.tokens)} | ${formatPct(data.categories?.systemAndTools?.percentage)} |`,
    `| User Inputs | ${formatTokens(data.categories?.userInputs?.tokens)} | ${formatPct(data.categories?.userInputs?.percentage)} |`,
    `| Model Thinking & Output | ${formatTokens(data.categories?.modelOutputs?.tokens)} | ${formatPct(data.categories?.modelOutputs?.percentage)} |`,
    `| Tool Results & File Reads | ${formatTokens(data.categories?.toolResults?.tokens)} | ${formatPct(data.categories?.toolResults?.percentage)} |`,
  ];

  const tot = data.sessionTotals || {};
  lines.push('');
  lines.push(
    `**Session Totals**: ${tot.invocations || 0} turns (${tot.totalSteps || 0} steps) · Cache Hit **${formatPct(tot.cacheHitRate)}** (Latest ${formatPct(tot.latestTurnCacheHitRate)}) · Input **${formatTokens(tot.totalInputTokens)}** (Fresh ${formatTokens(tot.uncachedInputTokens)} + Cached ${formatTokens(tot.cacheReadTokens)}) · Output **${formatTokens(tot.outputTokens)}**`
  );
  if ((tot.invocations || 0) === 0) {
    lines.push('');
    lines.push('> ℹ️ 当前为新会话首轮（尚未产生模型调用，System & Tools 基础开销将在首次模型响应后计入）。');
  }

  if (mb?.isMultiModel && mb.models?.length) {
    lines.push('');
    lines.push(
      `#### ${mb.isOrchestrator ? 'Orchestrator Dual-Model Breakdown' : 'Model Breakdown'} (⇄ ${mb.switchCount} switch${mb.switchCount === 1 ? '' : 'es'})`
    );
    lines.push('');
    lines.push('| Role / Model | Turns | Share | Input (Fresh + Cached) | Cache Hit | Output | Cost |');
    lines.push('| :--- | ---: | ---: | :--- | ---: | ---: | ---: |');
    for (const m of mb.models) {
      const roleIcon = m.role === 'planner' ? '◆' : m.role === 'worker' ? '▸' : '•';
      const rawId = m.model && m.model !== m.label ? ` (\`${m.model}\`)` : '';
      const inputCol =
        m.invocations === 0
          ? '—'
          : `${formatTokens(m.totalInputTokens)} (${formatTokens(m.uncachedInputTokens)} + ${formatTokens(m.cacheReadTokens)})`;
      const hitCol = m.invocations === 0 ? '—' : formatPct(m.cacheHitRate);
      const outCol = m.invocations === 0 ? '—' : formatTokens(m.outputTokens);
      const costCol = m.invocations === 0 ? '—' : formatCost(m.costUsd);
      lines.push(
        `| ${roleIcon} ${m.label}${rawId} | ${m.invocations} | ${formatPct(m.sharePercentage)} | ${inputCol} | ${hitCol} | ${outCol} | ${costCol} |`
      );
    }
  }

  if (data.turns?.length) {
    lines.push('');
    lines.push('**Recent Turns**:');
    for (const t of data.turns.slice(-8)) {
      const deltaStr =
        t.deltaTokens >= 0 ? `+${formatTokens(t.deltaTokens)}` : `-${formatTokens(-t.deltaTokens)}`;
      const tag = mb?.isMultiModel
        ? ` \`[${t.modelTag || (t.rawModel || 'MOD').slice(0, 4).toUpperCase()}]${t.modelSwitched ? '⇄' : ''}\``
        : '';
      const comp = t.compacted ? ' `[COMPACTED]`' : '';
      const tools = t.tools?.length ? ` · ${t.tools.slice(0, 3).join(', ')}` : '';
      lines.push(
        `- \`#${t.turnNumber}\`${tag} **${formatTokens(t.promptTokens)}** (${deltaStr}) · ⚡${formatPct(t.cacheHitRate)} · ${formatCost(t.costUsd)}${comp}${tools}`
      );
    }
  }

  if (data.topConsumers?.length) {
    lines.push('');
    lines.push('**Top Context Consumers**:');
    for (const c of data.topConsumers.slice(0, 5)) {
      lines.push(`- \`+${formatTokens(c.deltaTokens)}\` Turn #${c.turnNumber}: ${c.label}`);
    }
  }

  lines.push('');
  if (isCliSurface) {
    lines.push(
      '> 零 Token 快捷面板：`:ctx` · `:ctx all` · `!ctx`（边框面板）· 独立终端运行 `ctx` 打开全屏实时交互面板'
    );
  } else {
    lines.push('[Context Usage](sidecar://context-usage/context_monitor/)');
  }

  return lines.join('\n');
}

function formatMarkdownStatsPanel(stats, { isCliSurface }) {
  const t = stats?.totals || {};
  const surfTag =
    stats?.surfaceFilter && stats.surfaceFilter !== 'all'
      ? ` · [${stats.surfaceFilter.toUpperCase()}]`
      : '';
  const lines = [
    `### ◆ Usage & Cost Statistics · ${stats?.periodLabel || stats?.period || 'Stats'}${surfTag}`,
    '',
    `- **时间范围**: \`${stats?.range?.fromLabel || ''}\` → \`${stats?.range?.toLabel || ''}\`（${stats?.range?.spanDays || 1} 天 · 按 \`${stats?.granularity || 'day'}\` 统计）`,
    `- **费用总计**: **${formatCost(t.costUsd)}**（日均 **${formatCost(t.avgDailyCostUsd)}/d** · 缓存已省 **${formatCost(t.cacheSavingsUsd)}** / ${formatPct(t.cacheSavingsPercentage)}）`,
    `- **用量总计**: **${t.sessionsCount || 0}** 个会话 · **${t.turnsCount || 0}** 轮调用 · 输入 **${formatTokens(t.totalInputTokens)}**（Fresh ${formatTokens(t.uncachedInputTokens)} + Cache ${formatTokens(t.cacheReadTokens)} · ⚡${formatPct(t.cacheHitRate)}）· 输出 **${formatTokens(t.outputTokens)}**`,
  ];

  const rawBuckets = Array.isArray(stats?.buckets) ? stats.buckets : [];
  const activeBuckets =
    stats?.granularity === 'hour' && rawBuckets.some((b) => b.turnsCount > 0)
      ? rawBuckets.filter((b) => b.turnsCount > 0)
      : rawBuckets.slice(-16);

  if (activeBuckets.length > 0) {
    lines.push('');
    lines.push('| Period | Sessions | Turns | Input | Cache Hit | Output | Cost |');
    lines.push('| :--- | ---: | ---: | ---: | ---: | ---: | ---: |');
    for (const b of activeBuckets) {
      const bHit =
        b.totalInputTokens > 0 ? formatPct((b.cacheReadTokens / b.totalInputTokens) * 100) : '0%';
      lines.push(
        `| \`${b.label}\` | ${b.sessionsCount} | ${b.turnsCount} | ${formatTokens(b.totalInputTokens)} | ${bHit} | ${formatTokens(b.outputTokens)} | ${formatCost(b.costUsd, { compact: true })} |`
      );
    }
  } else {
    lines.push('');
    lines.push('> ℹ️ 所选时间范围内暂无模型调用记录。');
  }

  if (stats?.byModel?.length) {
    lines.push('');
    lines.push('**Cost by Model**:');
    lines.push('');
    lines.push('| Model | Turns | Tokens | Cache Hit | Cost | Share |');
    lines.push('| :--- | ---: | ---: | ---: | ---: | ---: |');
    for (const m of stats.byModel.slice(0, 8)) {
      lines.push(
        `| \`${m.model}\` | ${m.invocations} | ${formatTokens(m.totalTokens)} | ${formatPct(m.cacheHitRate)} | ${formatCost(m.costUsd)} | ${formatPct(m.costSharePercentage)} |`
      );
    }
  }

  if (stats?.topSessions?.length) {
    lines.push('');
    lines.push('**Top Sessions in Range**:');
    lines.push('');
    lines.push('| Surface | Conv ID | Turns | Tokens | Cost | Title |');
    lines.push('| :--- | :--- | ---: | ---: | ---: | :--- |');
    for (const s of stats.topSessions.slice(0, 6)) {
      const titleSafe = String(s.title || '').replace(/\|/g, '\\|');
      lines.push(
        `| ${String(s.product || '').toUpperCase()} | \`${String(s.conversationId || '').slice(0, 8)}\` | ${s.turnsCount} | ${formatTokens(s.totalTokens)} | ${formatCost(s.costUsd, { compact: true })} | ${titleSafe} |`
      );
    }
  }

  lines.push('');
  if (isCliSurface) {
    lines.push(
      '> 零 Token 统计面板：`:ctx day` · `:ctx week` · `:ctx 2026-11-16` · `:ctx 2026-11-01..2026-11-15` · `!ctx --day`'
    );
  } else {
    lines.push('[Context Usage](sidecar://context-usage/context_monitor/?tab=stats)');
  }
  return lines.join('\n');
}

/**
 * Evaluate a PreInvocation hook payload and return a zero-token inline panel if invoked cleanly.
 */
export function evaluatePanelIntercept(payload = {}, opts = {}) {
  const convId =
    typeof payload.conversationId === 'string'
      ? payload.conversationId
      : typeof payload.conversation_id === 'string'
        ? payload.conversation_id
        : '';
  const transcriptPath =
    typeof payload.transcriptPath === 'string'
      ? payload.transcriptPath
      : typeof payload.transcript_path === 'string'
        ? payload.transcript_path
        : '';
  const modelName =
    typeof payload.modelName === 'string'
      ? payload.modelName
      : typeof payload.model_name === 'string'
        ? payload.model_name
        : '';
  const artifactDir =
    typeof payload.artifactDirectoryPath === 'string'
      ? payload.artifactDirectoryPath
      : typeof payload.artifact_directory_path === 'string'
        ? payload.artifact_directory_path
        : '';
  const rawLastUserInput = extractPayloadRawString(payload);
  const surfaceHint = String(transcriptPath || artifactDir || '');
  const isCliSurface = surfaceHint.includes('antigravity-cli');

  const { midTurn, promptText } = inspectTranscriptState(transcriptPath, payload);
  if (midTurn) return {};

  const cmd = parsePanelCommand(promptText);
  if (!cmd) return {};

  let markdown = '';
  if (cmd.stats) {
    const stats = aggregateUsageStats({
      period: cmd.period,
      from: cmd.from,
      to: cmd.to,
      surface: cmd.surface,
      windowSize: cmd.windowSize,
      nowMs: opts.nowMs,
      dirs: opts.dirs,
      env: opts.env,
      cacheDir: opts.cacheDir,
      disableRemoteRefresh: opts.disableRemoteRefresh,
    });
    markdown = formatMarkdownStatsPanel(stats, { isCliSurface });
  } else if (cmd.all) {
    const items = listRecentConversations({
      limit: 15,
      windowSize: cmd.windowSize,
      dirs: opts.dirs,
    });
    if (cmd.sort === 'cost') {
      items.sort((a, b) => (b.costUsd || 0) - (a.costUsd || 0) || (b.mtimeMs || 0) - (a.mtimeMs || 0));
    } else if (cmd.sort === 'context') {
      items.sort(
        (a, b) =>
          (b.activeContextTokens || 0) - (a.activeContextTokens || 0) ||
          (b.mtimeMs || 0) - (a.mtimeMs || 0)
      );
    }
    markdown = formatMarkdownSessionsList(items, { isCliSurface });
  } else {
    let data = null;
    if (cmd.conv) {
      data = analyzeConversation(cmd.conv, {
        modelId: modelName,
        windowSize: cmd.windowSize,
        dirs: opts.dirs,
      });
      if (!data) {
        markdown = `> ⚠️ 未找到会话 \`${cmd.conv}\`，可输入 \`:ctx all\` 查看最近会话列表。`;
      } else {
        markdown = formatMarkdownPanel(data, { isCliSurface });
      }
    } else {
      if (transcriptPath && existsSync(transcriptPath)) {
        data = analyzeTranscriptFile(transcriptPath, {
          modelId: modelName,
          windowSize: cmd.windowSize,
        });
        if (data) {
          data = {
            conversationId: convId,
            product: isCliSurface
              ? 'cli'
              : transcriptPath.includes('antigravity-ide')
                ? 'ide'
                : 'app',
            ...data,
          };
        }
      } else if (convId) {
        data = analyzeConversation(convId, {
          modelId: modelName,
          windowSize: cmd.windowSize,
          dirs: opts.dirs,
        });
      }

      if (!data || (data.sessionTotals?.totalSteps ?? 0) === 0) {
        const rawInput = rawLastUserInput;
        const syntheticJsonl = rawInput.trim()
          ? `${JSON.stringify({ step_index: 0, type: 'USER_INPUT', content: rawInput })}\n`
          : '';
        const base = analyzeTranscriptText(syntheticJsonl, {
          modelId: modelName,
          windowSize: cmd.windowSize,
        });
        const inferredProduct =
          data?.product ||
          (isCliSurface ? 'cli' : surfaceHint.includes('antigravity-ide') ? 'ide' : 'app');
        data = {
          conversationId: convId,
          product: inferredProduct,
          transcriptPath,
          ...base,
          subagents: data?.subagents || [],
          subagentsTotals: data?.subagentsTotals || {
            count: 0,
            activeContextTokens: 0,
            totalInputTokens: 0,
            outputTokens: 0,
            costUsd: 0,
            cacheSavingsUsd: 0,
          },
        };
      }
      markdown = formatMarkdownPanel(data, { isCliSurface });
    }
  }

  if (isCliSurface) {
    // Current agy CLI hookcaller panics on systemMessage.metadata string values; use errorMessage.userMessage for reliable zero-token CLI output.
    return {
      injectSteps: [
        {
          errorMessage: {
            userMessage: markdown,
          },
        },
      ],
      terminationBehavior: 'terminate',
    };
  }

  return {
    injectSteps: [
      {
        systemMessage: {
          systemMessage: '',
          metadata: {
            user_markdown: markdown,
          },
        },
      },
    ],
    terminationBehavior: 'terminate',
  };
}

async function main() {
  try {
    const raw = await readStdin();
    const payload = raw.trim() ? JSON.parse(raw) : {};
    const out = evaluatePanelIntercept(payload);
    process.stdout.write(`${JSON.stringify(out)}\n`);
  } catch {
    process.stdout.write('{}\n');
  }
}

const isMain = process.argv[1] && process.argv[1].endsWith('intercept-panel.mjs');
if (isMain) {
  await main();
}
