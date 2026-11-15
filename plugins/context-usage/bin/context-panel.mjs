#!/usr/bin/env node
import { statSync } from 'node:fs';
import { basename } from 'node:path';
import readline from 'node:readline';
import {
  aggregateUsageStats,
  analyzeConversation,
  analyzeTranscriptFile,
  formatCost,
  formatPct,
  formatTokens,
  listRecentConversations,
} from '../sidecars/context_monitor/analyzer.mjs';

const USE_COLOR = !process.env.NO_COLOR && process.env.TERM !== 'dumb';

const C = USE_COLOR
  ? {
      reset: '\x1b[0m',
      bold: '\x1b[1m',
      dim: '\x1b[2m',
      inverse: '\x1b[7m',
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
      inverse: '',
      cyan: '',
      blue: '',
      emerald: '',
      yellow: '',
      orange: '',
      red: '',
      magenta: '',
      gray: '',
    };

const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function stripAnsi(str) {
  return String(str ?? '').replace(ANSI_RE, '');
}

function sanitizeText(str) {
  return String(str ?? '').replace(/[\r\n\t]+/g, ' ');
}

export function charWidth(cp) {
  if (cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f)) return 0;
  if (
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    cp === 0x200d ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    (cp >= 0xfe20 && cp <= 0xfe2f)
  ) {
    return 0;
  }
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    cp === 0x2329 ||
    cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

export function displayWidth(str) {
  const plain = stripAnsi(str);
  let w = 0;
  for (const ch of plain) {
    w += charWidth(ch.codePointAt(0));
  }
  return w;
}

/**
 * Truncate an ANSI-colored string by terminal cell width without breaking escape sequences.
 */
export function truncateAnsi(str, maxWidth) {
  const s = String(str ?? '');
  const limit = Math.max(0, Number(maxWidth) || 0);
  if (limit === 0) return '';
  if (displayWidth(s) <= limit) return s;

  const ellipsis = limit >= 1 ? '…' : '';
  const target = Math.max(0, limit - (ellipsis ? 1 : 0));

  let out = '';
  let w = 0;
  let hasAnsi = false;
  let i = 0;

  while (i < s.length) {
    if (s[i] === '\x1b' && s[i + 1] === '[') {
      const end = s.indexOf('m', i);
      if (end !== -1) {
        out += s.slice(i, end + 1);
        hasAnsi = true;
        i = end + 1;
        continue;
      }
    }
    const cp = s.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    const cw = charWidth(cp);
    if (w + cw > target) break;
    out += ch;
    w += cw;
    i += ch.length;
  }

  return `${out}${ellipsis}${hasAnsi ? C.reset : ''}`;
}

export function padAnsiRight(str, width) {
  const s = truncateAnsi(str, width);
  const pad = Math.max(0, width - displayWidth(s));
  return `${s}${' '.repeat(pad)}`;
}

export function padAnsiLeft(str, width) {
  const s = truncateAnsi(str, width);
  const pad = Math.max(0, width - displayWidth(s));
  return `${' '.repeat(pad)}${s}`;
}

function boxTop(title, innerW) {
  if (!title) {
    return `${C.gray}╭${'─'.repeat(innerW)}╮${C.reset}`;
  }
  const cleanTitle = truncateAnsi(sanitizeText(title), Math.max(4, innerW - 6));
  const titleW = displayWidth(cleanTitle);
  const rightFill = Math.max(1, innerW - 4 - titleW - 1);
  return `${C.gray}╭─── ${C.cyan}${C.bold}${cleanTitle}${C.reset} ${C.gray}${'─'.repeat(rightFill)}╮${C.reset}`;
}

function boxSep(innerW, label = '') {
  if (!label) {
    return `${C.gray}├${'─'.repeat(innerW)}┤${C.reset}`;
  }
  const cleanLabel = truncateAnsi(sanitizeText(label), Math.max(4, innerW - 6));
  const labelW = displayWidth(cleanLabel);
  const rightFill = Math.max(1, innerW - 2 - labelW - 1);
  return `${C.gray}├─ ${C.bold}${cleanLabel}${C.reset} ${C.gray}${'─'.repeat(rightFill)}┤${C.reset}`;
}

function boxBottom(innerW) {
  return `${C.gray}╰${'─'.repeat(innerW)}╯${C.reset}`;
}

function boxRow(content, innerW) {
  const contentW = Math.max(1, innerW - 2);
  const fitted = padAnsiRight(content, contentW);
  return `${C.gray}│${C.reset} ${fitted}${C.reset} ${C.gray}│${C.reset}`;
}

function healthColor(health) {
  if (health === 'critical') return C.red;
  if (health === 'warning') return C.orange;
  if (health === 'moderate') return C.yellow;
  return C.emerald;
}

function renderProgressBar(pct, width = 20, health = 'healthy') {
  const clamped = Math.max(0, Math.min(100, Number(pct) || 0));
  let filled = Math.round((clamped / 100) * width);
  if (clamped > 0 && filled === 0) filled = 1;
  if (filled > width) filled = width;
  const col = healthColor(health);
  return `${col}${'█'.repeat(filled)}${C.gray}${'░'.repeat(width - filled)}${C.reset}`;
}

function renderProportionalBar(segments, width = 36) {
  const total = segments.reduce((s, item) => s + Math.max(0, Number(item.value) || 0), 0);
  if (total <= 0) {
    return `${C.gray}${'░'.repeat(width)}${C.reset}`;
  }
  let used = 0;
  const counts = segments.map((item) => {
    const val = Math.max(0, Number(item.value) || 0);
    let count = Math.round((val / total) * width);
    if (val > 0 && count === 0) count = 1;
    used += count;
    return { color: item.color, count };
  });
  while (used > width) {
    const largest = counts.reduce((a, b) => (b.count > a.count ? b : a), counts[0]);
    if (largest.count <= 0) break;
    largest.count -= 1;
    used -= 1;
  }
  if (used < width) {
    const largest = counts.reduce((a, b) => (b.count >= a.count ? b : a), counts[0]);
    largest.count += width - used;
  }
  return counts.map((s) => `${s.color}${'█'.repeat(s.count)}${C.reset}`).join('');
}

/**
 * Render a rounded Unicode box-drawing context usage panel with exact CJK alignment.
 */
export function renderBoxPanel(data, opts = {}) {
  const cols = Number(opts.columns) || process.stdout.columns || 78;
  const innerW = Math.max(62, Math.min(96, cols - 4));
  const contentW = innerW - 2;
  const lines = [];

  const titleHead = opts.headerLabel || '◆ Context Usage Panel';
  lines.push(boxTop(titleHead, innerW));

  if (!data) {
    lines.push(boxRow(`${C.yellow}No active conversation found.${C.reset}`, innerW));
    lines.push(boxBottom(innerW));
    return lines.join('\n');
  }

  // Header & Window Gauge
  const idShort = data.conversationId ? data.conversationId.slice(0, 8) : 'local';
  const surfTag = data.product ? `[${String(data.product).toUpperCase()}]` : '';
  const cleanTitle = sanitizeText(data.title || 'Untitled');
  lines.push(boxRow(`${C.blue}${surfTag}${C.reset} ${C.dim}${idShort}${C.reset}  ${C.bold}${cleanTitle}${C.reset}`, innerW));

  const mb = data.modelBreakdown;
  let modelDesc = `${C.bold}${sanitizeText(data.modelLabel || data.model || 'Unknown')}${C.reset}`;
  if (mb?.isMultiModel) {
    const phaseColor = mb.activeRole === 'worker' ? C.yellow : mb.activeRole === 'planner' ? C.magenta : C.cyan;
    const badge = mb.activeTag
      ? `[${mb.activeTag}${mb.activeModel ? ` · ${mb.activeModel}` : ''}]`
      : mb.activeModel
        ? `(${mb.activeModel})`
        : '';
    const swText = mb.switchCount > 0 ? `  ${C.cyan}⇄ ${mb.switchCount} switch${mb.switchCount === 1 ? '' : 'es'}${C.reset}` : '';
    modelDesc += `${badge ? ` ${phaseColor}${badge}${C.reset}` : ''}${swText}`;
  } else if (data.model && data.model !== data.modelLabel) {
    modelDesc += ` ${C.dim}(${sanitizeText(data.model)})${C.reset}`;
  }
  lines.push(boxRow(`${C.dim}Model:${C.reset}  ${modelDesc}`, innerW));

  const hColor = healthColor(data.health);
  const barW = contentW >= 74 ? 22 : 16;
  const warn200k = data.exceeds200k ? `  ${C.orange}[>200k]${C.reset}` : '';
  lines.push(
    boxRow(
      `${renderProgressBar(data.usedPercentage, barW, data.health)} ${hColor}${C.bold}${formatTokens(data.activeContextTokens)}${C.reset}${C.dim}/${formatTokens(data.contextWindowSize)}${C.reset} (${hColor}${formatPct(data.usedPercentage)}${C.reset}) ${hColor}${String(data.health || 'healthy').toUpperCase()}${C.reset} ${C.dim}· ${formatTokens(data.remainingTokens)} free${C.reset}${warn200k}`,
      innerW
    )
  );

  // Category Breakdown & Cache Telemetry
  lines.push(boxSep(innerW, 'Categories & Session Totals'));
  const cats = [
    { key: 'systemAndTools', label: 'System & Tools', color: C.cyan },
    { key: 'userInputs', label: 'User Inputs', color: C.emerald },
    { key: 'modelOutputs', label: 'Model Thinking & Output', color: C.magenta },
    { key: 'toolResults', label: 'Tool Results & File Reads', color: C.yellow },
  ];
  const catSegs = cats.map((c) => ({ color: c.color, value: data.categories?.[c.key]?.tokens || 0 }));
  lines.push(
    boxRow(
      `[${renderProportionalBar(catSegs, Math.min(44, Math.max(24, contentW - 14)))}]  ${C.dim}active ${formatTokens(data.activeContextTokens)}${C.reset}`,
      innerW
    )
  );
  for (const c of cats) {
    const stat = data.categories?.[c.key] || { tokens: 0, percentage: 0 };
    const nameCol = padAnsiRight(`${c.color}■${C.reset} ${c.label}`, 30);
    const valCol = padAnsiLeft(formatTokens(stat.tokens), 8);
    const pctCol = padAnsiLeft(formatPct(stat.percentage), 6);
    lines.push(boxRow(`  ${nameCol} ${C.bold}${valCol}${C.reset}  ${C.dim}${pctCol}${C.reset}`, innerW));
  }

  const tot = data.sessionTotals || {};
  lines.push(
    boxRow(
      `${C.dim}Turns:${C.reset} ${C.bold}${tot.invocations || 0}${C.reset}  ${C.dim}Cache:${C.reset} ${C.emerald}${C.bold}${formatPct(tot.cacheHitRate)}${C.reset} ${C.dim}(latest ${formatPct(tot.latestTurnCacheHitRate)})${C.reset}  ${C.dim}Σ In:${C.reset} ${formatTokens(tot.totalInputTokens)} ${C.dim}(Fresh ${formatTokens(tot.uncachedInputTokens)} + Cache ${formatTokens(tot.cacheReadTokens)})${C.reset}  ${C.dim}Out:${C.reset} ${formatTokens(tot.outputTokens)}`,
      innerW
    )
  );
  const cost = data.cost || {};
  const combinedSuffix =
    data.subagents?.length && (cost.totalWithSubagentsUsd || 0) > (cost.totalCostUsd || 0)
      ? `  ${C.dim}w/Sub:${C.reset} ${formatCost(cost.totalWithSubagentsUsd)}`
      : '';
  lines.push(
    boxRow(
      `${C.dim}Cost:${C.reset} ${C.yellow}${C.bold}${formatCost(cost.totalCostUsd)}${C.reset} ${C.dim}(In ${formatCost(cost.inputCostUsd)} + Cache ${formatCost(cost.cacheReadCostUsd)} + Out ${formatCost(cost.outputCostUsd)})${C.reset}  ${C.dim}Saved:${C.reset} ${C.emerald}${formatCost(cost.cacheSavingsUsd)}${C.reset} ${C.dim}(${formatPct(cost.cacheSavingsPercentage)})  Avg:${C.reset} ${formatCost(cost.avgTurnCostUsd)}/t${combinedSuffix}`,
      innerW
    )
  );

  // Orchestrator / Multi-Model Breakdown
  if (mb?.isMultiModel && mb.models?.length) {
    const secTitle = mb.isOrchestrator
      ? `Orchestrator Dual-Model (⇄ ${mb.switchCount} switch${mb.switchCount === 1 ? '' : 'es'})`
      : `Model Breakdown (⇄ ${mb.switchCount} switch${mb.switchCount === 1 ? '' : 'es'})`;
    lines.push(boxSep(innerW, secTitle));
    const modelSegs = mb.models.map((m, i) => ({
      color: m.role === 'planner' ? C.magenta : m.role === 'worker' ? C.yellow : i % 2 === 0 ? C.cyan : C.blue,
      value: m.totalTokens || 0,
    }));
    lines.push(
      boxRow(
        `[${renderProportionalBar(modelSegs, Math.min(44, Math.max(24, contentW - 18)))}]  ${C.dim}total ${formatTokens(tot.totalInputTokens + tot.outputTokens)}${C.reset}`,
        innerW
      )
    );
    for (let idx = 0; idx < mb.models.length; idx++) {
      const m = mb.models[idx];
      const icon =
        m.role === 'planner'
          ? `${C.magenta}◆${C.reset}`
          : m.role === 'worker'
            ? `${C.yellow}▸${C.reset}`
            : `${idx % 2 === 0 ? C.cyan : C.blue}•${C.reset}`;
      const rawId = m.model && m.model !== m.label ? ` (${m.model})` : '';
      const leftCol = padAnsiRight(`${icon} ${C.bold}${sanitizeText(m.label)}${C.reset}${C.dim}${sanitizeText(rawId)}${C.reset}`, Math.max(24, contentW - 26));
      const rightCol = padAnsiLeft(`${m.invocations}t · ${formatCost(m.costUsd, { compact: true })} · ${formatPct(m.sharePercentage)}`, 24);
      lines.push(boxRow(`${leftCol}  ${rightCol}`, innerW));
      if (m.invocations === 0) {
        lines.push(boxRow(`    ${C.dim}(No invocations in this phase yet)${C.reset}`, innerW));
      } else {
        lines.push(
          boxRow(
            `    ${C.dim}In:${C.reset} ${formatTokens(m.totalInputTokens)} ${C.dim}(Fresh ${formatTokens(m.uncachedInputTokens)} + Cache ${formatTokens(m.cacheReadTokens)}, hit ${formatPct(m.cacheHitRate)})${C.reset}  ${C.dim}Out:${C.reset} ${formatTokens(m.outputTokens)}  ${C.dim}Cost:${C.reset} ${C.yellow}${formatCost(m.costUsd)}${C.reset}`,
            innerW
          )
        );
      }
    }
  }

  // Recent Turns + Turn Inspector
  if (data.turns?.length) {
    lines.push(boxSep(innerW, `Turns (${data.turns.length})`));
    const allTurns = data.turns;
    const windowCount = Math.max(4, Math.min(allTurns.length, Number(opts.turnWindow) || 8));
    let startIdx = Math.max(0, allTurns.length - windowCount);
    let selectedIdx = typeof opts.turnCursor === 'number' ? opts.turnCursor : allTurns.length - 1;
    selectedIdx = Math.max(0, Math.min(allTurns.length - 1, selectedIdx));

    if (opts.interactive) {
      if (selectedIdx < startIdx) startIdx = selectedIdx;
      if (selectedIdx >= startIdx + windowCount) startIdx = selectedIdx - windowCount + 1;
    }
    const visible = allTurns.slice(startIdx, startIdx + windowCount);

    for (const t of visible) {
      const isSelected = opts.interactive && t.turnNumber === allTurns[selectedIdx].turnNumber;
      const prefix = opts.interactive ? (isSelected ? `${C.cyan}>${C.reset}` : ' ') : ' ';
      const turnPct = data.contextWindowSize > 0 ? (t.promptTokens / data.contextWindowSize) * 100 : 0;
      const plainDelta =
        t.deltaTokens >= 0 ? `+${formatTokens(t.deltaTokens)}` : `-${formatTokens(-t.deltaTokens)}`;
      const dCol = t.deltaTokens >= 0 ? C.yellow : C.emerald;
      const deltaPart = `${dCol}${padAnsiRight(plainDelta, 7)}${C.reset}`;
      let rolePart = '';
      if (mb?.isMultiModel) {
        const tag = t.modelTag || padAnsiRight((t.rawModel || 'MOD').slice(0, 4).toUpperCase(), 4);
        const rCol = t.modelRole === 'planner' ? C.magenta : t.modelRole === 'worker' ? C.yellow : C.cyan;
        const sw = t.modelSwitched ? `${C.cyan}⇄${C.reset}` : ' ';
        rolePart = ` ${rCol}[${tag}]${C.reset}${sw}`;
      }
      const comp = t.compacted ? ` ${C.magenta}[CMP]${C.reset}` : '';
      const turnNum = padAnsiLeft(`#${t.turnNumber}`, 4);
      const hitStr = padAnsiLeft(`${formatPct(t.cacheHitRate)}`, 4);
      const barStr = renderProgressBar(turnPct, 10, turnPct >= 90 ? 'critical' : turnPct >= 80 ? 'warning' : turnPct >= 60 ? 'moderate' : 'healthy');
      const leftHead = `${prefix}${turnNum}${rolePart} ${barStr} ${padAnsiLeft(formatTokens(t.promptTokens), 6)} (${deltaPart}) hit ${hitStr}${comp}`;
      const toolsStr = t.tools?.length ? sanitizeText(t.tools.slice(0, 2).join(', ')) : '';
      const rowText = toolsStr ? `${leftHead} ${C.dim}${toolsStr}${C.reset}` : leftHead;
      lines.push(boxRow(rowText, innerW));
    }

    const sel = allTurns[selectedIdx];
    if (sel) {
      const roleTag = sel.modelTag
        ? `[${sel.modelTag}${sel.rawModel ? ` · ${sel.rawModel}` : ''}${sel.modelSwitched ? ' · ⇄ Switched' : ''}]`
        : sel.rawModel
          ? `[${sel.rawModel}]`
          : '';
      const dStr = sel.deltaTokens >= 0 ? `+${formatTokens(sel.deltaTokens)}` : `-${formatTokens(-sel.deltaTokens)}`;
      const toolDetail = sel.tools?.length ? ` · ${sel.tools.slice(0, 3).join(', ')}` : '';
      lines.push(
        boxRow(
          `${C.cyan}Detail #${sel.turnNumber}${C.reset} ${roleTag}: ${C.yellow}Cost ${formatCost(sel.costUsd)}${C.reset} ${C.dim}· Fresh ${formatTokens(sel.inputTokens)} + Cache ${formatTokens(sel.cacheReadTokens)} = ${formatTokens(sel.promptTokens)} (${dStr}), Out ${formatTokens(sel.outputTokens)}${sanitizeText(toolDetail)}${C.reset}`,
          innerW
        )
      );
    }
  }

  // Top Consumers & Subagents
  if (data.topConsumers?.length) {
    lines.push(boxSep(innerW, 'Top Context Consumers'));
    for (const c of data.topConsumers.slice(0, 4)) {
      const turnRef = padAnsiLeft(`T#${c.turnNumber}`, 4);
      const deltaBadge = padAnsiLeft(`+${formatTokens(c.deltaTokens)}`, 7);
      lines.push(
        boxRow(
          `  ${C.yellow}${deltaBadge}${C.reset}  ${C.dim}${turnRef}:${C.reset} ${sanitizeText(c.label)}`,
          innerW
        )
      );
    }
  }

  if (data.subagents?.length) {
    const st = data.subagentsTotals || {};
    lines.push(boxSep(innerW, `Subagents & Swarm (${data.subagents.length})`));
    lines.push(
      boxRow(
        `  ${C.dim}Active:${C.reset} ${formatTokens(st.activeContextTokens)}   ${C.dim}Σ ↑${formatTokens(st.totalInputTokens)} ↓${formatTokens(st.outputTokens)}${C.reset}   ${C.dim}Cost:${C.reset} ${C.yellow}${formatCost(st.costUsd)}${C.reset} ${C.dim}(Σ ${formatCost(cost.totalWithSubagentsUsd)})${C.reset}`,
        innerW
      )
    );
  }

  if (opts.footerHint) {
    lines.push(boxSep(innerW));
    lines.push(boxRow(`${C.dim}${opts.footerHint}${C.reset}`, innerW));
  }

  lines.push(boxBottom(innerW));
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

/**
 * Render a rounded Unicode box list of recent conversations across App/CLI/IDE.
 */
export function renderBoxSessionsList(items, opts = {}) {
  const cols = Number(opts.columns) || process.stdout.columns || 84;
  const innerW = Math.max(66, Math.min(100, cols - 4));
  const lines = [];
  const filterNote = opts.surfaceFilter && opts.surfaceFilter !== 'all' ? ` [${opts.surfaceFilter.toUpperCase()}]` : '';
  const totalListCost = items.reduce((s, x) => s + (Number(x.costUsd) || 0), 0);
  lines.push(
    boxTop(
      `◆ Recent Antigravity Conversations (${items.length}) · Σ ${formatCost(totalListCost)}${filterNote}`,
      innerW
    )
  );

  if (!items.length) {
    lines.push(boxRow(`${C.dim}No matching conversations found.${C.reset}`, innerW));
  } else {
    const maxRows = Math.max(5, Number(opts.maxRows) || items.length);
    let start = 0;
    let cursor = typeof opts.sessionCursor === 'number' ? opts.sessionCursor : 0;
    cursor = Math.max(0, Math.min(items.length - 1, cursor));
    if (opts.interactive) {
      if (cursor >= maxRows) start = cursor - maxRows + 1;
    }
    const visible = items.slice(start, start + maxRows);

    for (let i = 0; i < visible.length; i++) {
      const item = visible[i];
      const realIdx = start + i;
      const isSel = opts.interactive && realIdx === cursor;
      const prefix = opts.interactive ? (isSel ? `${C.cyan}>${C.reset}` : ' ') : ' ';
      const hColor = healthColor(item.health);
      const bar = renderProgressBar(item.usedPercentage, 10, item.health);
      const baseModel = item.modelLabel || item.model || 'Unknown';
      const modelCell =
        item.isOrchestrator && item.activeTag
          ? `${baseModel.slice(0, 9).replace(/[\s(]+$/, '')} [${item.activeTag}]`
          : baseModel.slice(0, 16);
      const costCell = `${C.yellow}${padAnsiLeft(formatCost(item.costUsd, { compact: true }), 7)}${C.reset}`;
      const row = `${prefix}${C.blue}${padAnsiRight(String(item.product || '').toUpperCase(), 4)}${C.reset} ${C.dim}${String(item.conversationId || '').slice(0, 8)}${C.reset} ${bar} ${hColor}${padAnsiLeft(formatPct(item.usedPercentage), 4)}${C.reset} ${padAnsiLeft(formatTokens(item.activeContextTokens), 6)} ${costCell} ${padAnsiRight(sanitizeText(modelCell), 16)} ${sanitizeText(item.title || '')}`;
      lines.push(boxRow(isSel ? `${C.bold}${row}${C.reset}` : row, innerW));
    }
  }

  if (opts.footerHint) {
    lines.push(boxSep(innerW));
    lines.push(boxRow(`${C.dim}${opts.footerHint}${C.reset}`, innerW));
  }
  lines.push(boxBottom(innerW));
  return lines.join('\n');
}

/**
 * Render a rounded Unicode box statistics panel for day / week / month / custom ranges with exact CJK alignment.
 */
export function renderBoxStatsPanel(stats, opts = {}) {
  const cols = Number(opts.columns) || process.stdout.columns || 84;
  const innerW = Math.max(66, Math.min(100, cols - 4));
  const lines = [];
  const t = stats?.totals || {};
  const surfTag =
    stats?.surfaceFilter && stats.surfaceFilter !== 'all'
      ? ` [${stats.surfaceFilter.toUpperCase()}]`
      : '';

  lines.push(
    boxTop(`◆ Usage & Cost Statistics (${stats?.periodLabel || stats?.period || 'Stats'})${surfTag}`, innerW)
  );
  lines.push(
    boxRow(
      `${C.dim}Range:${C.reset} ${C.bold}${stats?.range?.fromLabel || ''}${C.reset} -> ${C.bold}${stats?.range?.toLabel || ''}${C.reset} ${C.dim}(${stats?.range?.spanDays || 1}d · by ${stats?.granularity || 'day'})${C.reset}`,
      innerW
    )
  );
  lines.push(
    boxRow(
      `${C.dim}Cost:${C.reset} ${C.yellow}${C.bold}${formatCost(t.costUsd)}${C.reset} ${C.dim}(Avg ${formatCost(t.avgDailyCostUsd)}/d)  Saved:${C.reset} ${C.emerald}${formatCost(t.cacheSavingsUsd)}${C.reset} ${C.dim}(${formatPct(t.cacheSavingsPercentage)})  Sessions:${C.reset} ${C.bold}${t.sessionsCount || 0}${C.reset}  ${C.dim}Turns:${C.reset} ${C.bold}${t.turnsCount || 0}${C.reset}`,
      innerW
    )
  );
  lines.push(
    boxRow(
      `${C.dim}Tokens:${C.reset} In ${C.bold}${formatTokens(t.totalInputTokens)}${C.reset} ${C.dim}(Fresh ${formatTokens(t.uncachedInputTokens)} + Cache ${formatTokens(t.cacheReadTokens)}, hit ${formatPct(t.cacheHitRate)})  Out:${C.reset} ${C.bold}${formatTokens(t.outputTokens)}${C.reset}`,
      innerW
    )
  );

  const rawBuckets = Array.isArray(stats?.buckets) ? stats.buckets : [];
  const filteredBuckets =
    stats?.granularity === 'hour' && rawBuckets.some((b) => b.turnsCount > 0)
      ? rawBuckets.filter((b) => b.turnsCount > 0)
      : rawBuckets;
  const maxBuckets = Math.max(6, Number(opts.maxBuckets) || 14);
  const showBuckets = filteredBuckets.slice(-maxBuckets);

  lines.push(boxSep(innerW, `Timeline (${showBuckets.length}/${rawBuckets.length})`));
  if (!showBuckets.length) {
    lines.push(boxRow(`${C.dim}No model invocations recorded in this time range.${C.reset}`, innerW));
  } else {
    const maxCost = Math.max(0, ...showBuckets.map((b) => Number(b.costUsd) || 0));
    const maxTok = Math.max(1, ...showBuckets.map((b) => Number(b.totalTokens) || 0));
    const barW = innerW >= 80 ? 22 : 14;
    for (const b of showBuckets) {
      const ratio =
        maxCost > 0 ? (Number(b.costUsd) || 0) / maxCost : (Number(b.totalTokens) || 0) / maxTok;
      const pct = Math.max(0, Math.min(100, ratio * 100));
      const bar = renderProgressBar(pct, barW, 'healthy');
      lines.push(
        boxRow(
          ` ${padAnsiRight(b.label, 8)} ${bar} ${padAnsiLeft(`${b.turnsCount}t`, 5)} ${padAnsiLeft(formatTokens(b.totalTokens), 7)} ${C.yellow}${padAnsiLeft(formatCost(b.costUsd, { compact: true }), 8)}${C.reset}`,
          innerW
        )
      );
    }
  }

  if (stats?.byModel?.length) {
    lines.push(boxSep(innerW, `Cost by Model (${stats.byModel.length})`));
    for (const m of stats.byModel.slice(0, 6)) {
      lines.push(
        boxRow(
          ` ${C.cyan}•${C.reset} ${padAnsiRight(sanitizeText(m.model), 28)} ${padAnsiLeft(`${m.invocations}t`, 5)} ${padAnsiLeft(formatTokens(m.totalTokens), 7)} ${C.yellow}${padAnsiLeft(formatCost(m.costUsd), 8)}${C.reset} ${C.dim}(${formatPct(m.costSharePercentage)})${C.reset}`,
          innerW
        )
      );
    }
  }

  if (stats?.topSessions?.length) {
    lines.push(boxSep(innerW, `Top Sessions (${stats.topSessions.length})`));
    for (const s of stats.topSessions.slice(0, 6)) {
      lines.push(
        boxRow(
          ` ${C.blue}${padAnsiRight(String(s.product || '').toUpperCase(), 4)}${C.reset} ${C.dim}${String(s.conversationId || '').slice(0, 8)}${C.reset} ${padAnsiLeft(`${s.turnsCount}t`, 5)} ${C.yellow}${padAnsiLeft(formatCost(s.costUsd, { compact: true }), 7)}${C.reset} ${padAnsiRight(sanitizeText(s.model), 16)} ${sanitizeText(s.title)}`,
          innerW
        )
      );
    }
  }

  if (opts.footerHint) {
    lines.push(boxSep(innerW));
    lines.push(boxRow(`${C.dim}${opts.footerHint}${C.reset}`, innerW));
  }
  lines.push(boxBottom(innerW));
  return lines.join('\n');
}

function parsePanelArgs(argv) {
  const opts = {
    conv: '',
    file: '',
    all: false,
    stats: false,
    period: 'week',
    from: '',
    to: '',
    surface: 'all',
    limit: 20,
    windowSize: 0,
    sort: 'recent',
    once: false,
    tui: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--all' || a === '-a') opts.all = true;
    else if (a === '--day' || a === '--today') {
      opts.stats = true;
      opts.period = 'day';
    } else if (a === '--week') {
      opts.stats = true;
      opts.period = 'week';
    } else if (a === '--month') {
      opts.stats = true;
      opts.period = 'month';
    } else if (a === '--stats') {
      opts.stats = true;
      if (argv[i + 1] && !argv[i + 1].startsWith('-')) opts.period = argv[++i];
    } else if (a.startsWith('--stats=')) {
      opts.stats = true;
      opts.period = a.slice('--stats='.length) || 'week';
    } else if (a === '--period' && argv[i + 1]) {
      opts.stats = true;
      opts.period = argv[++i];
    } else if (a.startsWith('--period=')) {
      opts.stats = true;
      opts.period = a.slice('--period='.length) || 'week';
    } else if (a === '--from' && argv[i + 1]) {
      opts.from = argv[++i];
      opts.stats = true;
      opts.period = 'custom';
    } else if (a.startsWith('--from=')) {
      opts.from = a.slice('--from='.length);
      opts.stats = true;
      opts.period = 'custom';
    } else if (a === '--to' && argv[i + 1]) {
      opts.to = argv[++i];
      opts.stats = true;
      opts.period = 'custom';
    } else if (a.startsWith('--to=')) {
      opts.to = a.slice('--to='.length);
      opts.stats = true;
      opts.period = 'custom';
    } else if (a === '--surface' && argv[i + 1]) {
      opts.surface = argv[++i];
    } else if (a.startsWith('--surface=')) {
      opts.surface = a.slice('--surface='.length) || 'all';
    } else if (a === '--once' || a === '--box') opts.once = true;
    else if (a === '--tui' || a === '--watch') opts.tui = true;
    else if (a === '--panel') continue;
    else if (a === '--conv' && argv[i + 1]) opts.conv = argv[++i];
    else if (a.startsWith('--conv=')) opts.conv = a.slice('--conv='.length);
    else if (a === '--file' && argv[i + 1]) opts.file = argv[++i];
    else if (a.startsWith('--file=')) opts.file = a.slice('--file='.length);
    else if (a === '--limit' && argv[i + 1]) opts.limit = Number(argv[++i]) || 20;
    else if (a.startsWith('--limit=')) opts.limit = Number(a.slice('--limit='.length)) || 20;
    else if (a === '--window' && argv[i + 1]) opts.windowSize = Number(argv[++i]) || 0;
    else if (a.startsWith('--window=')) opts.windowSize = Number(a.slice('--window='.length)) || 0;
    else if (a === '--sort' && argv[i + 1]) opts.sort = argv[++i];
    else if (a.startsWith('--sort=')) opts.sort = a.slice('--sort='.length);
  }
  return opts;
}

function usage() {
  return [
    'Antigravity Context Usage CLI Panel',
    '',
    'Usage: ctx [options]   (or: context-usage --panel [options])',
    '',
    'Options:',
    '  --conv <id>        Inspect a specific conversation ID',
    '  --file <path>      Inspect a specific transcript.jsonl file',
    '  --all              Show recent conversations across CLI/App/IDE',
    '  --stats [period]   Show usage & cost stats (day|week|month|all|custom)',
    '  --day, --week, --month  Shorthand stats window presets',
    '  --from <date>      Custom stats start boundary (YYYY-MM-DD or ISO)',
    '  --to <date>        Custom stats end boundary (YYYY-MM-DD or ISO)',
    '  --surface <name>   Filter stats by surface (all|app|cli|ide)',
    '  --sort <mode>      Sort --all list by recent | cost | context',
    '  --window <tokens>  Override context window capacity (e.g. 200000)',
    '  --once, --box      Print rounded box panel once and exit',
    '  --tui, --watch     Run full-screen live interactive TUI (requires TTY)',
    '  -h, --help         Show help',
  ].join('\n');
}

function resolveDefaultConvId() {
  if (process.env.ANTIGRAVITY_CONVERSATION_ID) {
    return process.env.ANTIGRAVITY_CONVERSATION_ID;
  }
  const appDataDir = String(process.env.ANTIGRAVITY_APP_DATA_DIR || '');
  const recent = listRecentConversations({ limit: 15 });
  if (appDataDir.endsWith('antigravity-cli')) {
    const cliHit = recent.find((c) => c.product === 'cli');
    if (cliHit) return cliHit.conversationId;
  }
  return recent[0]?.conversationId || '';
}

function getFileStamp(filePath) {
  if (!filePath) return '';
  try {
    const st = statSync(filePath);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return 'missing';
  }
}

async function startInteractiveTui(opts) {
  const WINDOW_CHOICES = [0, 1_048_576, 200_000, 128_000, 2_097_152];
  const SURFACE_FILTERS = ['all', 'cli', 'app', 'ide'];
  const SORT_MODES = ['recent', 'cost', 'context'];
  const PERIOD_MODES = opts.from || opts.to ? ['day', 'week', 'month', 'all', 'custom'] : ['day', 'week', 'month', 'all'];
  const initSurfaceIdx = Math.max(0, SURFACE_FILTERS.indexOf(String(opts.surface || 'all').toLowerCase()));
  const initPeriodNorm =
    opts.from || opts.to
      ? 'custom'
      : PERIOD_MODES.includes(String(opts.period || 'week').toLowerCase())
        ? String(opts.period || 'week').toLowerCase()
        : 'week';

  const state = {
    tab: opts.stats ? 'stats' : opts.all ? 'sessions' : 'session',
    convId: opts.conv || (opts.file ? '' : resolveDefaultConvId()),
    filePath: opts.file || '',
    windowIdx: Math.max(0, WINDOW_CHOICES.indexOf(Number(opts.windowSize) || 0)),
    customWindow: Number(opts.windowSize) || 0,
    turnCursor: -1,
    followTail: true,
    sessionCursor: 0,
    surfaceIdx: initSurfaceIdx,
    sortIdx: Math.max(0, SORT_MODES.indexOf(opts.sort || 'recent')),
    periodIdx: Math.max(0, PERIOD_MODES.indexOf(initPeriodNorm)),
    customFrom: opts.from || '',
    customTo: opts.to || '',
    lastRenderKey: '',
    exited: false,
  };

  const currentWindow = () =>
    state.windowIdx === 0 && state.customWindow > 0 ? state.customWindow : WINDOW_CHOICES[state.windowIdx];

  const loadSnapshot = () => {
    const win = currentWindow();
    const filter = SURFACE_FILTERS[state.surfaceIdx];
    const sortMode = SORT_MODES[state.sortIdx];
    if (state.tab === 'stats') {
      const p = PERIOD_MODES[state.periodIdx];
      const stats = aggregateUsageStats({
        period: p,
        from: p === 'custom' ? state.customFrom : '',
        to: p === 'custom' ? state.customTo : '',
        surface: filter,
        windowSize: win,
      });
      const stamp = `${p}|${filter}|${stats.range.fromMs}:${stats.range.toMs}|${stats.totals.turnsCount}:${stats.totals.costUsd}`;
      return { kind: 'stats', stats, stamp };
    }
    if (state.tab === 'sessions') {
      const all = listRecentConversations({ limit: opts.limit, windowSize: win });
      const filtered = sortConversations(
        filter === 'all' ? all : all.filter((c) => c.product === filter),
        sortMode
      );
      return { kind: 'sessions', filtered, stamp: filtered.map((c) => `${c.conversationId}:${c.mtimeMs}`).join('|') };
    }
    const data = state.filePath
      ? analyzeTranscriptFile(state.filePath, { windowSize: win })
      : state.convId
        ? analyzeConversation(state.convId, { windowSize: win })
        : null;
    if (data && !data.conversationId && state.convId) {
      data.conversationId = state.convId;
    }
    const stamp = data ? `${data.conversationId || state.filePath}:${getFileStamp(data.transcriptPath || state.filePath)}:${data.turns?.length || 0}` : 'none';
    return { kind: 'session', data, stamp };
  };

  let enteredAltScreen = false;
  const cleanup = () => {
    if (state.exited) return;
    state.exited = true;
    clearInterval(timer);
    process.stdout.off('resize', forceRender);
    if (process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(false);
      } catch {
        // ignore
      }
      process.stdin.pause();
    }
    if (enteredAltScreen) {
      process.stdout.write('\x1b[?25h\x1b[?1049l');
      enteredAltScreen = false;
    }
  };

  const render = (force = false) => {
    if (state.exited) return;
    const snap = loadSnapshot();
    const cols = process.stdout.columns || 80;
    const rows = process.stdout.rows || 28;
    const winLabel = currentWindow() > 0 ? formatTokens(currentWindow()) : 'Auto';
    const renderKey = `${state.tab}|${state.convId}|${state.windowIdx}|${state.surfaceIdx}|${state.sortIdx}|${state.periodIdx}|${state.turnCursor}|${state.sessionCursor}|${cols}x${rows}|${snap.stamp}`;
    if (!force && renderKey === state.lastRenderKey) return;
    state.lastRenderKey = renderKey;

    let output = '';
    if (snap.kind === 'stats') {
      const pMode = PERIOD_MODES[state.periodIdx];
      const hint = `[Tab/1/2/3] Views  [p] Period:${pMode}  [f] Surface:${SURFACE_FILTERS[state.surfaceIdx]}  [w] Win:${winLabel}  [r] Refresh  [q] Quit`;
      output = renderBoxStatsPanel(snap.stats, {
        columns: cols,
        maxBuckets: Math.max(6, Math.min(16, rows - 16)),
        footerHint: hint,
      });
    } else if (snap.kind === 'sessions') {
      const hint = `[Tab/1/2/3] Views  [↑/↓] Select  [Enter] Open  [s] Sort:${SORT_MODES[state.sortIdx]}  [f] Filter:${SURFACE_FILTERS[state.surfaceIdx]}  [w] Win:${winLabel}  [r] Refresh  [q] Quit`;
      state.sessionCursor = Math.max(0, Math.min(Math.max(0, snap.filtered.length - 1), state.sessionCursor));
      output = renderBoxSessionsList(snap.filtered, {
        columns: cols,
        interactive: true,
        sessionCursor: state.sessionCursor,
        surfaceFilter: SURFACE_FILTERS[state.surfaceIdx],
        maxRows: Math.max(6, rows - 8),
        footerHint: hint,
      });
    } else {
      const turnCount = snap.data?.turns?.length || 0;
      if (turnCount > 0) {
        if (state.followTail || state.turnCursor < 0 || state.turnCursor >= turnCount) {
          state.turnCursor = turnCount - 1;
          state.followTail = true;
        }
      } else {
        state.turnCursor = 0;
      }
      const turnWindow = Math.max(4, Math.min(12, rows - 25));
      const hint = `[Tab] Sessions/Stats  [↑/↓] Turn  [w] Win:${winLabel}  [r] Refresh  [q] Quit`;
      output = renderBoxPanel(snap.data, {
        columns: cols,
        interactive: true,
        turnCursor: state.turnCursor,
        turnWindow,
        headerLabel: `◆ Context Usage TUI [Win: ${winLabel}]`,
        footerHint: hint,
      });
    }
    process.stdout.write(`\x1b[H${output}\x1b[J`);
  };

  const forceRender = () => render(true);

  process.stdout.write('\x1b[?1049h\x1b[?25l');
  enteredAltScreen = true;
  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
  }

  const onKeypress = (_str, key) => {
    if (!key) return;
    const name = key.name;
    if ((key.ctrl && name === 'c') || name === 'q' || name === 'escape') {
      cleanup();
      process.exit(0);
    }
    if (name === 'tab') {
      state.tab =
        state.tab === 'session' ? 'sessions' : state.tab === 'sessions' ? 'stats' : 'session';
      forceRender();
      return;
    }
    if (key.sequence === '1') {
      state.tab = 'session';
      forceRender();
      return;
    }
    if (key.sequence === '2') {
      state.tab = 'sessions';
      forceRender();
      return;
    }
    if (key.sequence === '3') {
      state.tab = 'stats';
      forceRender();
      return;
    }
    if (name === 'r') {
      forceRender();
      return;
    }
    if (name === 'w') {
      state.customWindow = 0;
      state.windowIdx = (state.windowIdx + 1) % WINDOW_CHOICES.length;
      forceRender();
      return;
    }
    if (name === 'p' && state.tab === 'stats') {
      state.periodIdx = (state.periodIdx + 1) % PERIOD_MODES.length;
      forceRender();
      return;
    }
    if (name === 'f' && (state.tab === 'sessions' || state.tab === 'stats')) {
      state.surfaceIdx = (state.surfaceIdx + 1) % SURFACE_FILTERS.length;
      state.sessionCursor = 0;
      forceRender();
      return;
    }
    if (name === 's' && state.tab === 'sessions') {
      state.sortIdx = (state.sortIdx + 1) % SORT_MODES.length;
      state.sessionCursor = 0;
      forceRender();
      return;
    }
    if (name === 'up' || name === 'k') {
      if (state.tab === 'sessions') {
        state.sessionCursor = Math.max(0, state.sessionCursor - 1);
      } else if (state.tab === 'session') {
        const snap = loadSnapshot();
        const maxIdx = Math.max(0, (snap.data?.turns?.length || 1) - 1);
        const cur = state.turnCursor < 0 ? maxIdx : state.turnCursor;
        state.turnCursor = Math.max(0, cur - 1);
        state.followTail = state.turnCursor >= maxIdx;
      }
      forceRender();
      return;
    }
    if (name === 'down' || name === 'j') {
      if (state.tab === 'sessions') {
        const snap = loadSnapshot();
        state.sessionCursor = Math.min(Math.max(0, snap.filtered.length - 1), state.sessionCursor + 1);
      } else if (state.tab === 'session') {
        const snap = loadSnapshot();
        const maxIdx = Math.max(0, (snap.data?.turns?.length || 1) - 1);
        const cur = state.turnCursor < 0 ? maxIdx : state.turnCursor;
        state.turnCursor = Math.min(maxIdx, cur + 1);
        state.followTail = state.turnCursor >= maxIdx;
      }
      forceRender();
      return;
    }
    if (name === 'return' && state.tab === 'sessions') {
      const snap = loadSnapshot();
      const chosen = snap.filtered[state.sessionCursor];
      if (chosen?.conversationId) {
        state.convId = chosen.conversationId;
        state.filePath = '';
        state.followTail = true;
        state.tab = 'session';
        forceRender();
      }
    }
  };

  process.stdin.on('keypress', onKeypress);
  process.stdout.on('resize', forceRender);
  process.once('SIGINT', () => { cleanup(); process.exit(0); });
  process.once('SIGTERM', () => { cleanup(); process.exit(0); });
  process.once('exit', cleanup);

  const timer = setInterval(() => render(false), 1500);
  render(true);
}

/**
 * Run the CLI panel in static boxed mode (pipe/non-TTY or --once) or live interactive TUI mode (TTY).
 */
export async function runContextPanel(argv = process.argv.slice(2)) {
  const opts = parsePanelArgs(argv);
  if (opts.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const hasTty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (opts.tui && !hasTty) {
    // Graceful fallback if --tui is invoked inside non-TTY capture (e.g. !cmd)
    opts.once = true;
  }

  if (!opts.once && hasTty) {
    await startInteractiveTui(opts);
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
    process.stdout.write(`${renderBoxStatsPanel(stats)}\n`);
    return;
  }

  if (opts.all) {
    const list = sortConversations(
      listRecentConversations({ limit: opts.limit, windowSize: opts.windowSize }),
      opts.sort
    );
    process.stdout.write(`${renderBoxSessionsList(list)}\n`);
    return;
  }

  let data = null;
  if (opts.file) {
    data = analyzeTranscriptFile(opts.file, { windowSize: opts.windowSize });
    if (!data) {
      process.stderr.write(`Error: Could not read transcript file: ${opts.file}\n`);
      process.exitCode = 1;
      return;
    }
  } else {
    const targetConv = opts.conv || resolveDefaultConvId();
    if (!targetConv) {
      process.stderr.write('No Antigravity conversations found.\n');
      process.exitCode = 1;
      return;
    }
    data = analyzeConversation(targetConv, { windowSize: opts.windowSize });
    if (!data) {
      process.stderr.write(`Error: Conversation ${targetConv} not found.\n`);
      process.exitCode = 1;
      return;
    }
  }

  process.stdout.write(`${renderBoxPanel(data)}\n`);
}

const isMain =
  process.argv[1] &&
  (import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/')) ||
    basename(process.argv[1]) === 'context-panel.mjs');
if (isMain) {
  await runContextPanel(process.argv.slice(2));
}
