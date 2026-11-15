#!/usr/bin/env node
import { basename } from 'node:path';
import {
  analyzeTranscriptFile,
  estimatePayloadCost,
  formatCost,
  formatPct,
  formatTokens,
  resolveContextWindowSize,
} from '../sidecars/context_monitor/analyzer.mjs';

const USE_COLOR = !process.env.NO_COLOR && process.env.TERM !== 'dumb';
const COMPACT = process.env.AGY_CTX_COMPACT === '1';
const DETAIL_ENV = process.env.AGY_CTX_DETAIL === '1' || process.argv.includes('--detail');

const ANSI = USE_COLOR
  ? {
      reset: '\x1b[0m',
      bold: '\x1b[1m',
      dim: '\x1b[2m',
      cyan: '\x1b[36m',
      emerald: '\x1b[38;5;42m',
      yellow: '\x1b[33m',
      orange: '\x1b[38;5;208m',
      red: '\x1b[31m',
      magenta: '\x1b[35m',
      gray: '\x1b[90m',
    }
  : {
      reset: '',
      bold: '',
      dim: '',
      cyan: '',
      emerald: '',
      yellow: '',
      orange: '',
      red: '',
      magenta: '',
      gray: '',
    };

function colorForPct(pct) {
  if (pct >= 90) return ANSI.red;
  if (pct >= 80) return ANSI.orange;
  if (pct >= 60) return ANSI.yellow;
  return ANSI.emerald;
}

function makeBar(pct, width = 10) {
  const clamped = Math.max(0, Math.min(100, Number(pct) || 0));
  let filled = Math.round((clamped / 100) * width);
  if (clamped > 0 && filled === 0) filled = 1;
  if (filled > width) filled = width;
  const color = colorForPct(clamped);
  const full = '▰'.repeat(filled);
  const empty = '▱'.repeat(width - filled);
  return `${color}${full}${ANSI.gray}${empty}${ANSI.reset}`;
}

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

function formatState(state) {
  const raw = String(state || '').trim();
  if (!raw) return '';
  const map = {
    idle: `${ANSI.gray}idle${ANSI.reset}`,
    thinking: `${ANSI.cyan}thinking${ANSI.reset}`,
    working: `${ANSI.emerald}working${ANSI.reset}`,
    tool_use: `${ANSI.magenta}tool_use${ANSI.reset}`,
  };
  return map[raw] || `${ANSI.dim}${raw}${ANSI.reset}`;
}

function hasEffortInModelName(displayModel, effort) {
  if (!displayModel || !effort) return false;
  const escaped = effort.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[\\s(\\[,·/-])${escaped}(?:$|[\\s)\\],])`, 'i').test(displayModel);
}

export function renderStatusline(payload = {}, opts = {}) {
  const data = payload && typeof payload === 'object' ? payload : {};
  const ctx = data.context_window && typeof data.context_window === 'object' ? data.context_window : {};
  const modelObj = data.model && typeof data.model === 'object' ? data.model : {};
  const transcriptPath = typeof data.transcript_path === 'string' ? data.transcript_path : '';
  const detail = typeof opts.detail === 'boolean' ? opts.detail : DETAIL_ENV;

  const modelName = modelObj.display_name || modelObj.id || '';
  const effort = modelObj.effort ? String(modelObj.effort).trim() : '';
  const noCost =
    typeof opts.showCost === 'boolean' ? !opts.showCost : process.env.AGY_CTX_NO_COST === '1';

  const rawHostCost = data.cost?.total_cost_usd ?? data.cost?.session_total ?? data.cost_usd;
  const hostCostUsd =
    rawHostCost != null && Number.isFinite(Number(rawHostCost)) && Number(rawHostCost) >= 0
      ? Number(rawHostCost)
      : null;

  let transcriptData = null;
  const needTranscriptForWindow = ctx.used_percentage == null;
  const curUsage = ctx.current_usage && typeof ctx.current_usage === 'object' ? ctx.current_usage : null;
  const hasCurCacheInfo = curUsage && typeof curUsage.cache_read_input_tokens === 'number';
  const needTranscriptForPhase =
    /orchestrator/i.test(modelName) &&
    !/orchestrator|planner|worker|executor/i.test(String(modelObj.id || ''));
  const needTranscriptForCost = !noCost && hostCostUsd === null;

  if (
    transcriptPath &&
    (detail ||
      needTranscriptForWindow ||
      !hasCurCacheInfo ||
      !modelName ||
      needTranscriptForPhase ||
      needTranscriptForCost)
  ) {
    transcriptData = analyzeTranscriptFile(transcriptPath, { disableRemoteRefresh: true });
  }

  let windowSize = Number(ctx.context_window_size) || 0;
  if (windowSize <= 0) {
    windowSize = transcriptData?.contextWindowSize || resolveContextWindowSize(modelObj.id, modelName);
  }

  let activeTokens = 0;
  let usedPct = 0;

  if (ctx.used_percentage != null && Number.isFinite(Number(ctx.used_percentage))) {
    usedPct = Math.max(0, Math.min(100, Number(ctx.used_percentage)));
    if (curUsage) {
      activeTokens =
        (Number(curUsage.input_tokens) || 0) +
        (Number(curUsage.cache_read_input_tokens) || 0) +
        (Number(curUsage.cache_creation_input_tokens) || 0) +
        (Number(curUsage.output_tokens) || 0);
    }
    if (activeTokens <= 0 && windowSize > 0) {
      activeTokens = Math.round((usedPct / 100) * windowSize);
    }
  } else if (transcriptData) {
    activeTokens = transcriptData.activeContextTokens;
    usedPct = windowSize > 0 ? Math.min(100, (activeTokens / windowSize) * 100) : transcriptData.usedPercentage;
  }

  let cachePct = null;
  if (hasCurCacheInfo) {
    const curTotalIn =
      (Number(curUsage.input_tokens) || 0) +
      (Number(curUsage.cache_read_input_tokens) || 0) +
      (Number(curUsage.cache_creation_input_tokens) || 0);
    if (curTotalIn > 0) {
      cachePct = ((Number(curUsage.cache_read_input_tokens) || 0) / curTotalIn) * 100;
    }
  } else if (transcriptData && transcriptData.sessionTotals.totalInputTokens > 0) {
    cachePct = transcriptData.sessionTotals.latestTurnCacheHitRate ?? transcriptData.sessionTotals.cacheHitRate;
  }

  const totalIn =
    Number(ctx.total_input_tokens) || transcriptData?.sessionTotals?.totalInputTokens || 0;
  const totalOut =
    Number(ctx.total_output_tokens) || transcriptData?.sessionTotals?.outputTokens || 0;

  const exceeds200k =
    typeof data.exceeds_200k_tokens === 'boolean'
      ? data.exceeds_200k_tokens
      : activeTokens > 200_000;

  let costUsd = null;
  if (!noCost) {
    if (hostCostUsd !== null) {
      costUsd = hostCostUsd;
    } else if (transcriptData) {
      costUsd = transcriptData.cost?.totalCostUsd ?? 0;
    } else if (totalIn > 0 || totalOut > 0 || activeTokens > 0) {
      costUsd = estimatePayloadCost({
        totalInputTokens: totalIn || activeTokens,
        totalOutputTokens: totalOut,
        currentUsage: curUsage,
        exceeds200k,
        modelId: modelObj.id,
        modelLabel: modelName,
        disableRemoteRefresh: true,
      });
    }
  }

  const displayModel = modelName || transcriptData?.modelLabel || 'Antigravity';
  let phaseTag = '';
  if (/orchestrator/i.test(displayModel)) {
    const rawId = String(modelObj.id || '');
    if (/worker|executor/i.test(rawId)) phaseTag = ' [EXEC]';
    else if (/orchestrator|planner/i.test(rawId)) phaseTag = ' [PLAN]';
    else if (transcriptData?.modelBreakdown?.activeTag) {
      phaseTag = ` [${transcriptData.modelBreakdown.activeTag}]`;
    }
  }
  const effortSuffix = effort && !hasEffortInModelName(displayModel, effort) ? `·${effort}` : '';
  const modelPart = `${ANSI.cyan}${ANSI.bold}◆ ${displayModel}${phaseTag}${effortSuffix}${ANSI.reset}`;

  const bar = makeBar(usedPct, COMPACT ? 6 : 10);
  const pctColor = colorForPct(usedPct);
  let ctxPart = `${bar} ${ANSI.bold}${formatTokens(activeTokens)}${ANSI.reset}${ANSI.dim}/${formatTokens(windowSize)}${ANSI.reset} (${pctColor}${formatPct(usedPct)}${ANSI.reset})`;
  if (exceeds200k) {
    ctxPart += ` ${ANSI.yellow}⚠>200k${ANSI.reset}`;
  }
  if (usedPct >= 80) {
    ctxPart += ` ${usedPct >= 90 ? ANSI.red : ANSI.orange}⚠/compact${ANSI.reset}`;
  }

  const parts = [modelPart, ctxPart];

  if (!COMPACT && cachePct !== null) {
    parts.push(`${ANSI.emerald}⚡${Math.round(cachePct)}% cache${ANSI.reset}`);
  }

  if (!COMPACT && (totalIn > 0 || totalOut > 0)) {
    parts.push(`${ANSI.dim}Σ ↑${formatTokens(totalIn)} ↓${formatTokens(totalOut)}${ANSI.reset}`);
  }

  if (!COMPACT && !noCost && costUsd !== null && (costUsd > 0 || totalIn > 0 || totalOut > 0)) {
    parts.push(`${ANSI.yellow}${formatCost(costUsd, { compact: true })}${ANSI.reset}`);
  }

  const statePart = formatState(data.agent_state);
  if (!COMPACT && statePart) {
    parts.push(statePart);
  }

  const dirPath = data.workspace?.current_dir || data.cwd || '';
  if (dirPath) {
    parts.push(`${ANSI.dim}${basename(dirPath) || dirPath}${ANSI.reset}`);
  }

  const sep = ` ${ANSI.gray}│${ANSI.reset} `;
  const line1 = parts.join(sep);
  if (!detail || !transcriptData) {
    return line1;
  }

  const cats = transcriptData.categories || {};
  let line2 =
    `${ANSI.gray}└─${ANSI.reset} ` +
    `${ANSI.cyan}Sys ${formatTokens(cats.systemAndTools?.tokens)}${ANSI.reset} ${ANSI.gray}·${ANSI.reset} ` +
    `${ANSI.emerald}Usr ${formatTokens(cats.userInputs?.tokens)}${ANSI.reset} ${ANSI.gray}·${ANSI.reset} ` +
    `${ANSI.magenta}Mod ${formatTokens(cats.modelOutputs?.tokens)}${ANSI.reset} ${ANSI.gray}·${ANSI.reset} ` +
    `${ANSI.yellow}Tool ${formatTokens(cats.toolResults?.tokens)}${ANSI.reset}`;

  const mb = transcriptData.modelBreakdown;
  if (mb?.isOrchestrator) {
    const planner = mb.models?.find((m) => m.role === 'planner');
    const worker = mb.models?.find((m) => m.role === 'worker');
    const sw = mb.switchCount > 0 ? ` ${ANSI.cyan}⇄${mb.switchCount}${ANSI.reset}` : '';
    const planCost = noCost ? '' : ` · ${formatCost(planner?.costUsd, { compact: true })}`;
    const execCost = noCost ? '' : ` · ${formatCost(worker?.costUsd, { compact: true })}`;
    line2 +=
      ` ${ANSI.gray}│${ANSI.reset} ` +
      `${ANSI.magenta}◆Plan ${planner?.invocations || 0}t (${formatTokens(planner?.totalInputTokens)}${planCost})${ANSI.reset} ${ANSI.gray}·${ANSI.reset} ` +
      `${ANSI.yellow}▸Exec ${worker?.invocations || 0}t (${formatTokens(worker?.totalInputTokens)}${execCost})${ANSI.reset}${sw}`;
  }

  if (!noCost) {
    const saved = transcriptData.cost?.cacheSavingsUsd || 0;
    const savedPart =
      saved > 0 ? ` ${ANSI.emerald}(saved ${formatCost(saved)})${ANSI.reset}` : '';
    line2 += ` ${ANSI.gray}│${ANSI.reset} ${ANSI.yellow}Cost ${formatCost(transcriptData.cost?.totalCostUsd)}${ANSI.reset}${savedPart}`;
  }

  return `${line1}\n${line2}`;
}

export async function main() {
  try {
    const raw = await readStdin();
    const parsed = raw.trim() ? JSON.parse(raw) : {};
    process.stdout.write(`${renderStatusline(parsed)}\n`);
  } catch {
    process.stdout.write(`${ANSI.cyan}◆ Antigravity${ANSI.reset} ${ANSI.gray}│${ANSI.reset} ${ANSI.dim}Ctx --${ANSI.reset}\n`);
  }
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));
if (isMain || process.argv[1]?.endsWith('statusline.mjs')) {
  main();
}
