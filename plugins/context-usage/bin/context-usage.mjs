#!/usr/bin/env node
import {
  aggregateUsageStats,
  analyzeConversation,
  analyzeTranscriptFile,
  formatCost,
  formatPct,
  formatTokens,
  listRecentConversations,
  syncRemotePricingCache,
} from '../sidecars/context_monitor/analyzer.mjs';
import { runContextPanel } from './context-panel.mjs';

const USE_COLOR = !process.env.NO_COLOR && process.env.TERM !== 'dumb';

const C = USE_COLOR
  ? {
      reset: '\x1b[0m',
      bold: '\x1b[1m',
      dim: '\x1b[2m',
      cyan: '\x1b[36m',
      blue: '\x1b[34m',
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
      blue: '',
      emerald: '',
      yellow: '',
      orange: '',
      red: '',
      magenta: '',
      gray: '',
    };

function parseArgs(argv) {
  const opts = {
    conv: '',
    file: '',
    all: false,
    stats: false,
    period: 'week',
    from: '',
    to: '',
    surface: 'all',
    limit: 15,
    windowSize: 0,
    sort: 'recent',
    json: false,
    panel: false,
    refreshPricing: false,
    forceDownload: false,
    explicitTarget: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--refresh-pricing') opts.refreshPricing = true;
    else if (a === '--force-download') opts.forceDownload = true;
    else if (a === '--all' || a === '-a') {
      opts.all = true;
      opts.explicitTarget = true;
    } else if (a === '--day' || a === '--today') {
      opts.stats = true;
      opts.period = 'day';
      opts.explicitTarget = true;
    } else if (a === '--week') {
      opts.stats = true;
      opts.period = 'week';
      opts.explicitTarget = true;
    } else if (a === '--month') {
      opts.stats = true;
      opts.period = 'month';
      opts.explicitTarget = true;
    } else if (a === '--stats') {
      opts.stats = true;
      opts.explicitTarget = true;
      if (argv[i + 1] && !argv[i + 1].startsWith('-')) {
        opts.period = argv[++i];
      }
    } else if (a.startsWith('--stats=')) {
      opts.stats = true;
      opts.period = a.slice('--stats='.length) || 'week';
      opts.explicitTarget = true;
    } else if (a === '--period' && argv[i + 1]) {
      opts.stats = true;
      opts.period = argv[++i];
      opts.explicitTarget = true;
    } else if (a.startsWith('--period=')) {
      opts.stats = true;
      opts.period = a.slice('--period='.length) || 'week';
      opts.explicitTarget = true;
    } else if (a === '--from' && argv[i + 1]) {
      opts.from = argv[++i];
      opts.stats = true;
      opts.period = 'custom';
      opts.explicitTarget = true;
    } else if (a.startsWith('--from=')) {
      opts.from = a.slice('--from='.length);
      opts.stats = true;
      opts.period = 'custom';
      opts.explicitTarget = true;
    } else if (a === '--to' && argv[i + 1]) {
      opts.to = argv[++i];
      opts.stats = true;
      opts.period = 'custom';
      opts.explicitTarget = true;
    } else if (a.startsWith('--to=')) {
      opts.to = a.slice('--to='.length);
      opts.stats = true;
      opts.period = 'custom';
      opts.explicitTarget = true;
    } else if (a === '--surface' && argv[i + 1]) {
      opts.surface = argv[++i];
    } else if (a.startsWith('--surface=')) {
      opts.surface = a.slice('--surface='.length) || 'all';
    } else if (a === '--json') opts.json = true;
    else if (a === '--panel' || a === '--tui' || a === '--watch' || a === '--box' || a === '--once') {
      opts.panel = true;
      opts.explicitTarget = true;
    } else if (a === '--current') {
      opts.conv = process.env.ANTIGRAVITY_CONVERSATION_ID || '';
      opts.explicitTarget = true;
    } else if (a === '--conv' && argv[i + 1]) {
      opts.conv = argv[++i];
      opts.explicitTarget = true;
    } else if (a.startsWith('--conv=')) {
      opts.conv = a.slice('--conv='.length);
      opts.explicitTarget = true;
    } else if (a === '--file' && argv[i + 1]) {
      opts.file = argv[++i];
      opts.explicitTarget = true;
    } else if (a.startsWith('--file=')) {
      opts.file = a.slice('--file='.length);
      opts.explicitTarget = true;
    } else if (a === '--limit' && argv[i + 1]) opts.limit = Number(argv[++i]) || 15;
    else if (a.startsWith('--limit=')) opts.limit = Number(a.slice('--limit='.length)) || 15;
    else if (a === '--window' && argv[i + 1]) opts.windowSize = Number(argv[++i]) || 0;
    else if (a.startsWith('--window=')) opts.windowSize = Number(a.slice('--window='.length)) || 0;
    else if (a === '--sort' && argv[i + 1]) opts.sort = argv[++i];
    else if (a.startsWith('--sort=')) opts.sort = a.slice('--sort='.length);
  }
  return opts;
}

function usage() {
  return [
    `${C.bold}Antigravity Context Usage Inspector${C.reset}`,
    '',
    'Usage: agy-context-usage [options]',
    '',
    'Options:',
    '  --current          Inspect active conversation ($ANTIGRAVITY_CONVERSATION_ID)',
    '  --conv <id>        Inspect a specific conversation ID across App/CLI/IDE',
    '  --file <path>      Inspect a specific transcript.jsonl file',
    '  --all              List recent conversations across App/CLI/IDE',
    '  --stats [period]   Time-windowed cost & token statistics (day|week|month|all|custom)',
    '  --day, --week, --month  Shorthand time-window stats presets',
    '  --from <date>      Custom stats start boundary (YYYY-MM-DD, ISO, or local datetime)',
    '  --to <date>        Custom stats end boundary (YYYY-MM-DD, ISO, or local datetime)',
    '  --surface <name>   Filter stats by surface: all | app | cli | ide',
    '  --limit <n>        Number of sessions to list with --all (default: 15)',
    '  --sort <mode>      Sort --all list by recent | cost | context',
    '  --window <tokens>  Override context window capacity (e.g. 200000 or 1048576)',
    '  --panel, --tui     Open interactive TUI (or boxed panel when non-TTY)',
    '  --box, --once      Print bordered Unicode panel once',
    '  --refresh-pricing  Sync model pricing cache via Last-Modified check',
    '  --force-download   Bypass Last-Modified check and re-download full JSON',
    '  --json             Output structured JSON instead of ANSI terminal report',
    '  -h, --help         Show this help message',
  ].join('\n');
}

function healthColor(health) {
  if (health === 'critical') return C.red;
  if (health === 'warning') return C.orange;
  if (health === 'moderate') return C.yellow;
  return C.emerald;
}

function padRight(str, width) {
  const s = String(str ?? '');
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

function padLeft(str, width) {
  const s = String(str ?? '');
  return s.length >= width ? s : ' '.repeat(width - s.length) + s;
}

function renderCategoryBar(categories, activeTokens, width = 40) {
  const items = [
    { key: 'systemAndTools', color: C.cyan, char: '█' },
    { key: 'userInputs', color: C.emerald, char: '█' },
    { key: 'modelOutputs', color: C.magenta, char: '█' },
    { key: 'toolResults', color: C.yellow, char: '█' },
  ];
  if (!activeTokens) {
    return `${C.gray}${'░'.repeat(width)}${C.reset}`;
  }

  let usedChars = 0;
  const segments = items.map((item) => {
    const tokens = categories[item.key]?.tokens || 0;
    let count = Math.round((tokens / activeTokens) * width);
    if (tokens > 0 && count === 0) count = 1;
    usedChars += count;
    return { ...item, count };
  });

  while (usedChars > width) {
    const largest = segments.reduce((a, b) => (b.count > a.count ? b : a), segments[0]);
    if (largest.count <= 0) break;
    largest.count -= 1;
    usedChars -= 1;
  }
  if (usedChars < width) {
    const largest = segments.reduce((a, b) => (b.count >= a.count ? b : a), segments[0]);
    largest.count += width - usedChars;
  }

  return segments.map((s) => `${s.color}${s.char.repeat(s.count)}${C.reset}`).join('');
}

function renderSingleBar(pct, width = 16) {
  const clamped = Math.max(0, Math.min(100, Number(pct) || 0));
  let filled = Math.round((clamped / 100) * width);
  if (clamped > 0 && filled === 0) filled = 1;
  const color = clamped >= 90 ? C.red : clamped >= 80 ? C.orange : clamped >= 60 ? C.yellow : C.emerald;
  return `${color}${'█'.repeat(filled)}${C.gray}${'░'.repeat(Math.max(0, width - filled))}${C.reset}`;
}

export function renderDetailReport(data) {
  const lines = [];
  const hColor = healthColor(data.health);
  const badge = `${hColor}${C.bold}${String(data.health || 'healthy').toUpperCase()}${C.reset}`;

  lines.push(`${C.cyan}${C.bold}◆ Antigravity Context Usage Report${C.reset}`);
  lines.push(`${C.gray}${'─'.repeat(72)}${C.reset}`);
  if (data.conversationId) {
    lines.push(`  ${C.dim}Conversation:${C.reset} ${data.conversationId} ${data.product ? `${C.blue}[${data.product.toUpperCase()}]${C.reset}` : ''}`);
  }
  lines.push(`  ${C.dim}Title:${C.reset}        ${data.title || 'Untitled'}`);
  const mb = data.modelBreakdown;
  let modelLineExtra = '';
  if (mb?.isMultiModel) {
    const roleColor =
      mb.activeRole === 'worker' ? C.yellow : mb.activeRole === 'planner' ? C.magenta : C.cyan;
    const roleBadgeText = mb.activeTag
      ? `[${mb.activeTag}${mb.activeModel ? ` · ${mb.activeModel}` : ''}]`
      : mb.activeModel
        ? `(${mb.activeModel})`
        : '';
    const swText =
      mb.switchCount > 0
        ? ` ${C.dim}⇄ ${mb.switchCount} switch${mb.switchCount === 1 ? '' : 'es'}${C.reset}`
        : '';
    modelLineExtra = `${roleBadgeText ? ` ${roleColor}${roleBadgeText}${C.reset}` : ''}${swText}`;
  } else if (data.model && data.model !== data.modelLabel) {
    modelLineExtra = ` ${C.dim}(${data.model})${C.reset}`;
  }
  lines.push(
    `  ${C.dim}Model:${C.reset}        ${C.bold}${data.modelLabel || data.model || 'Unknown'}${C.reset}${modelLineExtra}`
  );
  lines.push(
    `  ${C.dim}Window:${C.reset}       ${hColor}${C.bold}${formatTokens(data.activeContextTokens)}${C.reset} / ${formatTokens(data.contextWindowSize)} (${hColor}${formatPct(data.usedPercentage)}${C.reset})  ${badge}${data.exceeds200k ? `  ${C.yellow}⚠ >200k${C.reset}` : ''}`
  );
  lines.push(`  ${C.dim}Headroom:${C.reset}     ${formatTokens(data.remainingTokens)} remaining (${formatPct(data.remainingPercentage)})`);
  lines.push('');

  lines.push(`  ${C.bold}Context Breakdown${C.reset}  [${renderCategoryBar(data.categories, data.activeContextTokens, 40)}]`);
  const catRows = [
    ['System & Tools', data.categories.systemAndTools, C.cyan],
    ['User Inputs', data.categories.userInputs, C.emerald],
    ['Model Thinking & Output', data.categories.modelOutputs, C.magenta],
    ['Tool Results & File Reads', data.categories.toolResults, C.yellow],
  ];
  for (const [label, stat, color] of catRows) {
    lines.push(
      `    ${color}■${C.reset} ${padRight(label, 27)} ${padLeft(formatTokens(stat.tokens), 8)}  ${padLeft(formatPct(stat.percentage), 6)}`
    );
  }
  lines.push('');

  const tot = data.sessionTotals;
  const cost = data.cost || {};
  lines.push(`  ${C.bold}Session & Cache Telemetry${C.reset}`);
  lines.push(
    `    Turns: ${C.bold}${tot.invocations}${C.reset} (${tot.totalSteps} steps)   Cache Hit: ${C.emerald}${C.bold}${formatPct(tot.cacheHitRate)}${C.reset}   Latest Turn Cache: ${C.emerald}${formatPct(tot.latestTurnCacheHitRate)}${C.reset}`
  );
  lines.push(
    `    Total Input: ${formatTokens(tot.totalInputTokens)} (Fresh ${formatTokens(tot.uncachedInputTokens)} + Cached ${formatTokens(tot.cacheReadTokens)})   Output: ${formatTokens(tot.outputTokens)}`
  );
  const subCostSuffix =
    data.subagents?.length && (cost.totalWithSubagentsUsd || 0) > (cost.totalCostUsd || 0)
      ? `   Combined w/ Subagents: ${C.yellow}${C.bold}${formatCost(cost.totalWithSubagentsUsd)}${C.reset}`
      : '';
  lines.push(
    `    Est. Cost: ${C.yellow}${C.bold}${formatCost(cost.totalCostUsd)}${C.reset} (Fresh+Write ${formatCost(cost.inputCostUsd)} / Cache Read ${formatCost(cost.cacheReadCostUsd)} / Output ${formatCost(cost.outputCostUsd)})   Cache Saved: ${C.emerald}${formatCost(cost.cacheSavingsUsd)}${C.reset} (${formatPct(cost.cacheSavingsPercentage)})   Avg/Turn: ${formatCost(cost.avgTurnCostUsd)}${subCostSuffix}`
  );

  if (mb?.isMultiModel && mb.models?.length) {
    const sectionTitle = mb.isOrchestrator ? 'Orchestrator Dual-Model Breakdown' : 'Model Breakdown';
    const swSummary =
      mb.switchCount > 0
        ? `⇄ ${mb.switchCount} phase switch${mb.switchCount === 1 ? '' : 'es'}`
        : 'no phase switches yet';
    lines.push('');
    lines.push(`  ${C.bold}${sectionTitle}${C.reset}  ${C.dim}(${swSummary})${C.reset}`);
    for (const m of mb.models) {
      const icon =
        m.role === 'planner'
          ? `${C.magenta}◆${C.reset}`
          : m.role === 'worker'
            ? `${C.yellow}▸${C.reset}`
            : `${C.cyan}•${C.reset}`;
      const rawTag = m.model && m.model !== m.label ? ` (${m.model})` : '';
      const headLeft = padRight(`${m.label}${rawTag}`, 44);
      const turnsText = padLeft(`${m.invocations} turn${m.invocations === 1 ? '' : 's'}`, 9);
      const shareText = padLeft(formatPct(m.sharePercentage), 5);
      lines.push(`    ${icon} ${C.bold}${headLeft}${C.reset} ${turnsText}  ${shareText}`);
      if (m.invocations === 0) {
        lines.push(`      ${C.dim}(No invocations in this phase yet)${C.reset}`);
      } else {
        lines.push(
          `      ${C.dim}Input:${C.reset} ${padLeft(formatTokens(m.totalInputTokens), 7)} ${C.dim}(Fresh ${padLeft(formatTokens(m.uncachedInputTokens), 7)} + Cached ${padLeft(formatTokens(m.cacheReadTokens), 7)}, ⚡${formatPct(m.cacheHitRate)})${C.reset}   ${C.dim}Output:${C.reset} ${formatTokens(m.outputTokens)}   ${C.dim}Cost:${C.reset} ${C.yellow}${formatCost(m.costUsd)}${C.reset} ${C.dim}(${formatPct(m.costSharePercentage)})${C.reset}`
        );
      }
    }
  }

  if (data.turns?.length) {
    lines.push('');
    lines.push(`  ${C.bold}Recent Turns${C.reset}`);
    const recent = data.turns.slice(-10);
    for (const t of recent) {
      const turnPct = data.contextWindowSize > 0 ? (t.promptTokens / data.contextWindowSize) * 100 : 0;
      const plainDelta =
        t.deltaTokens >= 0
          ? `+${formatTokens(t.deltaTokens)}`
          : `-${formatTokens(-t.deltaTokens)}`;
      const paddedDelta = padRight(plainDelta, 8);
      const deltaStr =
        t.deltaTokens >= 0
          ? `${C.yellow}${paddedDelta}${C.reset}`
          : `${C.emerald}${paddedDelta}${C.reset}`;
      let modelCol = '';
      if (mb?.isMultiModel) {
        const tagCode = t.modelTag || padRight((t.rawModel || 'MOD').slice(0, 4).toUpperCase(), 4);
        const tagColor =
          t.modelRole === 'planner' ? C.magenta : t.modelRole === 'worker' ? C.yellow : C.cyan;
        const swMark = t.modelSwitched ? `${C.cyan}⇄${C.reset}` : ' ';
        modelCol = ` ${tagColor}[${tagCode}]${C.reset}${swMark}`;
      }
      const compTag = t.compacted ? ` ${C.magenta}[COMPACTED]${C.reset}` : '';
      const toolTag = t.tools?.length ? ` ${C.dim}${t.tools.slice(0, 2).join(', ')}${C.reset}` : '';
      const costStr = `${C.yellow}${padLeft(formatCost(t.costUsd, { compact: true }), 7)}${C.reset}`;
      lines.push(
        `    ${padLeft(`#${t.turnNumber}`, 4)}${modelCol} ${renderSingleBar(turnPct, 14)} ${padLeft(formatTokens(t.promptTokens), 7)} (${deltaStr}) ⚡${padLeft(formatPct(t.cacheHitRate), 4)} ${costStr}${compTag}${toolTag}`
      );
    }
  }

  if (data.topConsumers?.length) {
    lines.push('');
    lines.push(`  ${C.bold}Top Context Consumers${C.reset}`);
    for (const c of data.topConsumers.slice(0, 5)) {
      lines.push(
        `    ${C.yellow}+${padLeft(formatTokens(c.deltaTokens), 7)}${C.reset}  ${C.dim}Turn #${c.turnNumber}:${C.reset} ${c.label}`
      );
    }
  }

  if (data.subagents?.length) {
    lines.push('');
    lines.push(
      `  ${C.bold}Subagents / Swarm${C.reset} (${data.subagentsTotals.count}, active ${formatTokens(data.subagentsTotals.activeContextTokens)}, total ↑${formatTokens(data.subagentsTotals.totalInputTokens)} ↓${formatTokens(data.subagentsTotals.outputTokens)}, cost ${C.yellow}${formatCost(data.subagentsTotals.costUsd)}${C.reset})`
    );
    for (const sub of data.subagents.slice(0, 8)) {
      lines.push(
        `    ${C.blue}•${C.reset} ${padRight(sub.name, 24)} ${padLeft(formatTokens(sub.activeContextTokens), 7)} (${padLeft(formatPct(sub.usedPercentage), 5)})  ${C.yellow}${padLeft(formatCost(sub.costUsd, { compact: true }), 7)}${C.reset}  ${C.dim}${sub.role}${C.reset}`
      );
    }
  }

  lines.push(`${C.gray}${'─'.repeat(72)}${C.reset}`);
  return lines.join('\n');
}

function sortConversations(items, sortBy = 'recent') {
  const copy = items.slice();
  if (sortBy === 'cost') {
    copy.sort((a, b) => (b.costUsd || 0) - (a.costUsd || 0) || (b.mtimeMs || 0) - (a.mtimeMs || 0));
  } else if (sortBy === 'context') {
    copy.sort(
      (a, b) =>
        (b.activeContextTokens || 0) - (a.activeContextTokens || 0) ||
        (b.mtimeMs || 0) - (a.mtimeMs || 0)
    );
  }
  return copy;
}

function summarizeConversations(items) {
  const roundUsd = (n) => Math.round((Number(n) || 0) * 1e8) / 1e8;
  return items.reduce(
    (acc, item) => {
      acc.count += 1;
      acc.totalCostUsd = roundUsd(acc.totalCostUsd + (Number(item.costUsd) || 0));
      acc.totalCacheSavingsUsd = roundUsd(
        acc.totalCacheSavingsUsd + (Number(item.cacheSavingsUsd) || 0)
      );
      return acc;
    },
    { count: 0, totalCostUsd: 0, totalCacheSavingsUsd: 0 }
  );
}

export function renderListReport(items) {
  const lines = [];
  const totals = summarizeConversations(items);
  lines.push(`${C.cyan}${C.bold}◆ Recent Antigravity Conversations (${items.length})${C.reset}`);
  lines.push(`${C.gray}${'─'.repeat(96)}${C.reset}`);
  lines.push(
    `  ${padRight('SURF', 5)} ${padRight('CONV ID', 10)} ${padRight('USAGE', 26)} ${padLeft('ACTIVE', 7)} ${padLeft('COST', 8)} ${padRight('MODEL', 22)} TITLE`
  );
  for (const item of items) {
    const hColor = healthColor(item.health);
    const bar = renderSingleBar(item.usedPercentage, 12);
    const baseModel = item.modelLabel || item.model || '';
    const modelCell =
      item.isOrchestrator && item.activeTag
        ? `${baseModel.slice(0, 14).replace(/[\s(]+$/, '')} [${item.activeTag}]`
        : baseModel.slice(0, 21);
    lines.push(
      `  ${C.blue}${padRight(item.product.toUpperCase(), 5)}${C.reset} ${C.dim}${padRight(item.conversationId.slice(0, 8), 10)}${C.reset} ${bar} ${hColor}${padLeft(formatPct(item.usedPercentage), 5)}${C.reset}   ${padLeft(formatTokens(item.activeContextTokens), 7)} ${C.yellow}${padLeft(formatCost(item.costUsd, { compact: true }), 8)}${C.reset} ${padRight(modelCell, 22)} ${item.title}`
    );
  }
  lines.push(`${C.gray}${'─'.repeat(96)}${C.reset}`);
  lines.push(
    `  ${C.dim}Totals:${C.reset} ${totals.count} sessions   ${C.dim}Est. Cost:${C.reset} ${C.yellow}${C.bold}${formatCost(totals.totalCostUsd)}${C.reset}   ${C.dim}Cache Saved:${C.reset} ${C.emerald}${formatCost(totals.totalCacheSavingsUsd)}${C.reset}`
  );
  return lines.join('\n');
}

export function renderStatsReport(stats) {
  const lines = [];
  const t = stats.totals || {};
  const surfTag = stats.surfaceFilter && stats.surfaceFilter !== 'all' ? ` · Surface: ${stats.surfaceFilter.toUpperCase()}` : '';
  lines.push(`${C.cyan}${C.bold}◆ Antigravity Usage & Cost Statistics (${stats.periodLabel || stats.period})${C.reset}`);
  lines.push(`${C.gray}${'─'.repeat(84)}${C.reset}`);
  lines.push(
    `  ${C.dim}Range:${C.reset} ${stats.range?.fromLabel || ''} -> ${stats.range?.toLabel || ''} (${stats.range?.spanDays || 1}d · by ${stats.granularity || 'day'}${surfTag})`
  );
  lines.push(
    `  ${C.dim}Totals:${C.reset} ${C.bold}${t.sessionsCount || 0}${C.reset} sessions · ${C.bold}${t.turnsCount || 0}${C.reset} turns · Est. Cost ${C.yellow}${C.bold}${formatCost(t.costUsd)}${C.reset} · Avg/Day ${C.yellow}${formatCost(t.avgDailyCostUsd)}${C.reset} · Saved ${C.emerald}${formatCost(t.cacheSavingsUsd)}${C.reset} (${formatPct(t.cacheSavingsPercentage)})`
  );
  lines.push(
    `  ${C.dim}Tokens:${C.reset} Input ${C.bold}${formatTokens(t.totalInputTokens)}${C.reset} (Fresh ${formatTokens(t.uncachedInputTokens)} + Cached ${formatTokens(t.cacheReadTokens)}, ⚡${formatPct(t.cacheHitRate)}) · Output ${C.bold}${formatTokens(t.outputTokens)}${C.reset}`
  );

  const rawBuckets = Array.isArray(stats.buckets) ? stats.buckets : [];
  const activeBuckets =
    stats.granularity === 'hour' && rawBuckets.some((b) => b.turnsCount > 0)
      ? rawBuckets.filter((b) => b.turnsCount > 0)
      : rawBuckets.slice(-31);
  if (activeBuckets.length > 0) {
    lines.push('');
    lines.push(`  ${C.bold}Timeline Breakdown${C.reset}`);
    const maxCost = Math.max(0, ...activeBuckets.map((b) => Number(b.costUsd) || 0));
    const maxTok = Math.max(1, ...activeBuckets.map((b) => Number(b.totalTokens) || 0));
    for (const b of activeBuckets) {
      const ratio = maxCost > 0 ? (Number(b.costUsd) || 0) / maxCost : (Number(b.totalTokens) || 0) / maxTok;
      const pct = Math.max(0, Math.min(100, ratio * 100));
      lines.push(
        `    ${padRight(b.label, 8)} ${renderSingleBar(pct, 18)} ${padLeft(`${b.turnsCount}t`, 5)} ${padLeft(formatTokens(b.totalTokens), 8)}  ${C.yellow}${padLeft(formatCost(b.costUsd, { compact: true }), 8)}${C.reset}`
      );
    }
  } else {
    lines.push('');
    lines.push(`  ${C.dim}No model invocations recorded in this time range.${C.reset}`);
  }

  if (stats.byModel?.length) {
    lines.push('');
    lines.push(`  ${C.bold}Cost by Model${C.reset}`);
    for (const m of stats.byModel.slice(0, 10)) {
      lines.push(
        `    ${C.cyan}•${C.reset} ${padRight(m.model.slice(0, 32), 32)} ${padLeft(`${m.invocations}t`, 5)}  ${padLeft(formatTokens(m.totalTokens), 8)}  ⚡${padLeft(formatPct(m.cacheHitRate), 5)}  ${C.yellow}${padLeft(formatCost(m.costUsd), 9)}${C.reset} (${formatPct(m.costSharePercentage)})`
      );
    }
  }

  if (stats.topSessions?.length) {
    lines.push('');
    lines.push(`  ${C.bold}Top Sessions in Range${C.reset}`);
    for (const s of stats.topSessions.slice(0, 10)) {
      lines.push(
        `    ${C.blue}${padRight(String(s.product || '').toUpperCase(), 4)}${C.reset} ${C.dim}${s.conversationId.slice(0, 8)}${C.reset}  ${padLeft(`${s.turnsCount}t`, 5)}  ${C.yellow}${padLeft(formatCost(s.costUsd, { compact: true }), 8)}${C.reset}  ${padRight(s.model.slice(0, 18), 18)}  ${s.title}`
      );
    }
  }

  lines.push(`${C.gray}${'─'.repeat(84)}${C.reset}`);
  return lines.join('\n');
}

async function main() {
  const rawArgv = process.argv.slice(2);
  const opts = parseArgs(rawArgv);
  if (opts.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  if (opts.refreshPricing) {
    const syncRes = await syncRemotePricingCache({ force: true, forceDownload: opts.forceDownload });
    if (!opts.explicitTarget) {
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(syncRes, null, 2)}\n`);
      } else if (syncRes.ok) {
        if (syncRes.notModified) {
          process.stdout.write(
            `Pricing cache already up to date (${syncRes.modelCount} models, Last-Modified: ${syncRes.lastModified || 'unchanged'})\n` +
              `Cache: ${syncRes.cacheFile} (valid for 7 days until ${new Date(syncRes.expiresAt).toISOString()})\n`
          );
        } else {
          const lmSuffix = syncRes.lastModified ? ` (Last-Modified: ${syncRes.lastModified})` : '';
          process.stdout.write(
            `Synced ${syncRes.modelCount} models from ${syncRes.sourceUrl}${lmSuffix}\n` +
              `Cache: ${syncRes.cacheFile} (valid for 7 days until ${new Date(syncRes.expiresAt).toISOString()})\n`
          );
        }
      } else {
        process.stderr.write(`Error syncing pricing cache: ${syncRes.error || 'unknown error'}\n`);
      }
      process.exitCode = syncRes.ok ? 0 : 1;
      return;
    }
    if (!syncRes.ok && !opts.json) {
      process.stderr.write(`Warning: pricing sync failed (${syncRes.error || 'unknown'}); using fallback.\n`);
    }
  }

  if (opts.panel && !opts.json) {
    await runContextPanel(rawArgv);
    return;
  }

  if (opts.stats) {
    const stats = aggregateUsageStats({
      period: opts.period,
      from: opts.from,
      to: opts.to,
      surface: opts.surface,
      windowSize: opts.windowSize,
    });
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(stats, null, 2)}\n`);
    } else {
      process.stdout.write(`${renderStatsReport(stats)}\n`);
    }
    return;
  }

  if (opts.all) {
    const list = sortConversations(
      listRecentConversations({ limit: opts.limit, windowSize: opts.windowSize }),
      opts.sort
    );
    if (opts.json) {
      const totals = summarizeConversations(list);
      process.stdout.write(`${JSON.stringify({ conversations: list, totals }, null, 2)}\n`);
    } else {
      process.stdout.write(`${renderListReport(list)}\n`);
    }
    return;
  }

  let result = null;
  if (opts.file) {
    result = analyzeTranscriptFile(opts.file, { windowSize: opts.windowSize });
    if (!result) {
      process.stderr.write(`Error: Could not read transcript file: ${opts.file}\n`);
      process.exitCode = 1;
      return;
    }
  } else {
    let targetConv = opts.conv || process.env.ANTIGRAVITY_CONVERSATION_ID || '';
    if (!targetConv) {
      const recent = listRecentConversations({ limit: 1, windowSize: opts.windowSize });
      targetConv = recent[0]?.conversationId || '';
    }
    if (!targetConv) {
      process.stderr.write('No Antigravity conversations found.\n');
      process.exitCode = 1;
      return;
    }
    result = analyzeConversation(targetConv, { windowSize: opts.windowSize });
    if (!result) {
      process.stderr.write(`Error: Conversation ${targetConv} not found.\n`);
      process.exitCode = 1;
      return;
    }
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderDetailReport(result)}\n`);
  }
}

const isMain = process.argv[1] && process.argv[1].endsWith('context-usage.mjs');
if (isMain) {
  await main();
}
