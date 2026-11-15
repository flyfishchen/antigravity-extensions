#!/usr/bin/env node
import { existsSync } from 'node:fs';
import {
  displayWidth,
  getPreferences,
  listRecentConversations,
  locateConversation,
  sessionKeyFor,
  stripAnsi,
  suggestForTranscriptFile,
  truncateDisplay,
  updatePreferences,
} from '../sidecars/suggestion_panel/engine.mjs';

const USE_COLOR = !process.env.NO_COLOR && process.env.TERM !== 'dumb';

const C = USE_COLOR
  ? {
      reset: '\x1b[0m',
      bold: '\x1b[1m',
      dim: '\x1b[2m',
      cyan: '\x1b[36m',
      emerald: '\x1b[38;5;42m',
      yellow: '\x1b[33m',
      gray: '\x1b[90m',
    }
  : {
      reset: '',
      bold: '',
      dim: '',
      cyan: '',
      emerald: '',
      yellow: '',
      gray: '',
    };

export { displayWidth };

function padDisplayEnd(str, width) {
  const diff = Math.max(0, width - displayWidth(str));
  return str + ' '.repeat(diff);
}

function drawBox(title, bodyLines, { width = 78 } = {}) {
  const innerWidth = Math.max(40, width - 4);
  const titleText = ` ${title} `;
  const titleCols = displayWidth(titleText);
  const topDashes = Math.max(2, width - 3 - titleCols);
  const out = [`${C.gray}╭─${C.reset}${C.cyan}${C.bold}${titleText}${C.reset}${C.gray}${'─'.repeat(topDashes)}╮${C.reset}`];

  for (const line of bodyLines) {
    const lineCols = displayWidth(line);
    const content =
      lineCols > innerWidth
        ? truncateDisplay(stripAnsi(line), innerWidth)
        : line;
    const padded = padDisplayEnd(content, innerWidth);
    out.push(`${C.gray}│${C.reset} ${padded} ${C.gray}│${C.reset}`);
  }

  out.push(`${C.gray}╰${'─'.repeat(width - 2)}╯${C.reset}`);
  return out.join('\n');
}

export function renderBoxedPanel(analysis, prefs = {}, opts = {}) {
  const width = Math.max(52, Math.min(104, Number(opts.width) || 78));
  const idShort = analysis?.conversationId ? analysis.conversationId.slice(0, 8) : 'local';
  const statusLabel = prefs.enabled === false ? `${C.yellow}OFF${C.reset}` : `${C.emerald}ON${C.reset}`;
  const isDismissed =
    prefs.dismissedStepIndex >= 0 && prefs.dismissedStepIndex === analysis?.lastStepIndex;

  const lines = [
    `${C.bold}Session:${C.reset} ${analysis?.title || 'Untitled conversation'} ${C.gray}(${idShort})${C.reset}`,
    `${C.bold}Status:${C.reset}  ${statusLabel}  ${C.gray}│${C.reset}  ${C.bold}Turn:${C.reset} ${analysis?.turnCompleted ? 'idle / ready' : 'in progress'}${isDismissed ? `  ${C.gray}· dismissed${C.reset}` : ''}`,
    `${C.gray}${'─'.repeat(Math.max(20, width - 4))}${C.reset}`,
  ];

  const candidates = Array.isArray(analysis?.candidates) ? analysis.candidates : [];
  if (!candidates.length) {
    lines.push(`${C.dim}暂无高置信度追问建议（当前轮次无需追问或尚未完成）。${C.reset}`);
  } else {
    candidates.forEach((c, idx) => {
      const num = `${C.cyan}${C.bold}[${idx + 1}]${C.reset}`;
      const reason = `${C.gray}(${c.reason}, ${Math.round((c.confidence || 0) * 100)}%)${C.reset}`;
      lines.push(`${num} ${c.text} ${reason}`);
    });
  }

  lines.push(`${C.gray}${'─'.repeat(Math.max(20, width - 4))}${C.reset}`);
  lines.push(`${C.dim}CLI shortcuts: :s · :s 2 · :s + <补充> · :s clear · :s off / :s on${C.reset}`);

  return drawBox('Prompt Suggestion', lines, { width });
}

export function renderBoxedList(items = [], opts = {}) {
  const width = Math.max(56, Math.min(104, Number(opts.width) || 82));
  const lines = [];
  if (!items.length) {
    lines.push(`${C.dim}未找到本地 Antigravity 会话记录。${C.reset}`);
  } else {
    for (const item of items.slice(0, 12)) {
      const idShort = String(item.conversationId || '').slice(0, 8);
      const surface = String(item.product || 'app').toUpperCase().padEnd(3);
      const preview = item.topSuggestion
        ? `${C.emerald}⇢${C.reset} ${item.topSuggestion}`
        : `${C.dim}— (silent)${C.reset}`;
      lines.push(`${C.cyan}${surface}${C.reset} ${C.gray}${idShort}${C.reset} ${preview}`);
    }
  }
  return drawBox(`Recent Prompt Suggestions (${items.length})`, lines, { width });
}

function parseCliArgs(argv) {
  const args = {
    mode: 'current',
    conv: '',
    file: '',
    json: false,
    box: true,
    acceptIdx: null,
    action: '',
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') args.help = true;
    else if (a === '--current') args.mode = 'current';
    else if (a === '--all' || a === '-a') args.mode = 'all';
    else if (a === '--panel' || a === '--box') args.box = true;
    else if (a === '--json') args.json = true;
    else if (a === '--off') args.action = 'off';
    else if (a === '--on') args.action = 'on';
    else if (a === '--clear') args.action = 'clear';
    else if (a === '--conv' && argv[i + 1]) args.conv = argv[++i];
    else if (a.startsWith('--conv=')) args.conv = a.slice('--conv='.length);
    else if (a === '--file' && argv[i + 1]) args.file = argv[++i];
    else if (a.startsWith('--file=')) args.file = a.slice('--file='.length);
    else if (a === '--accept') {
      const next = argv[i + 1];
      if (next && /^[1-3]$/.test(next)) {
        args.acceptIdx = Number(argv[++i]) - 1;
      } else {
        args.acceptIdx = 0;
      }
    } else if (/^--accept=[1-3]$/.test(a)) {
      args.acceptIdx = Number(a.slice('--accept='.length)) - 1;
    }
  }
  return args;
}

function printHelp() {
  process.stdout.write(`Usage: agy-suggest [options]

Inspect and manage zero-token follow-up prompt suggestions across Antigravity surfaces.

Options:
  --current        Inspect most recent conversation (default)
  --conv <id>      Inspect a specific conversation by ID
  --file <path>    Analyze a specific transcript.jsonl file
  --all            List recent conversations and top suggestions
  --panel, --box   Render rounded Unicode box output (default)
  --json           Output JSON payload
  --accept [1..3]  Print and consume suggestion #N (default 1)
  --off            Disable suggestion display for target session
  --on             Enable suggestion display for target session
  --clear          Dismiss current turn's suggestion
  -h, --help       Show this help
`);
}

export async function runPromptSuggestionCli(argv = process.argv.slice(2), opts = {}) {
  const args = parseCliArgs(argv);
  if (args.help) {
    printHelp();
    return 0;
  }

  const env = opts.env || process.env;
  const stateDir = opts.stateDir || env.AGY_PROMPT_SUGGESTION_STATE_DIR || '';
  const width = Number(process.stdout.columns) || 78;

  if (args.mode === 'all') {
    const items = listRecentConversations({ limit: 20, dirs: opts.dirs, env });
    if (args.json) {
      process.stdout.write(`${JSON.stringify({ conversations: items }, null, 2)}\n`);
    } else {
      process.stdout.write(`${renderBoxedList(items, { width })}\n`);
    }
    return 0;
  }

  let analysis = null;
  if (args.file) {
    if (existsSync(args.file)) {
      analysis = suggestForTranscriptFile(args.file, { cwd: process.cwd(), stateDir });
    }
  } else if (args.conv) {
    const loc = locateConversation(args.conv, { dirs: opts.dirs, env });
    if (loc?.transcriptPath && existsSync(loc.transcriptPath)) {
      analysis = suggestForTranscriptFile(loc.transcriptPath, {
        conversationId: args.conv,
        cwd: process.cwd(),
        stateDir,
      });
    }
  } else {
    const recent = listRecentConversations({ limit: 1, dirs: opts.dirs, env });
    if (recent[0]?.transcriptPath && existsSync(recent[0].transcriptPath)) {
      analysis = suggestForTranscriptFile(recent[0].transcriptPath, {
        conversationId: recent[0].conversationId,
        cwd: process.cwd(),
        stateDir,
      });
    }
  }

  const key = sessionKeyFor({
    conversationId: analysis?.conversationId || args.conv || '',
    transcriptPath: analysis?.transcriptPath || args.file || '',
  });

  if (args.action === 'off') {
    const prefs = updatePreferences(key, { enabled: false }, { stateDir });
    if (args.json) process.stdout.write(`${JSON.stringify({ ok: true, prefs })}\n`);
    else process.stdout.write('Prompt suggestions disabled.\n');
    return 0;
  }
  if (args.action === 'on') {
    const prefs = updatePreferences(key, { enabled: true, dismissedStepIndex: -1 }, { stateDir });
    if (args.json) process.stdout.write(`${JSON.stringify({ ok: true, prefs })}\n`);
    else process.stdout.write('Prompt suggestions enabled.\n');
    return 0;
  }
  if (args.action === 'clear') {
    const lastStepIndex = typeof analysis?.lastStepIndex === 'number' ? analysis.lastStepIndex : -1;
    const prefs = updatePreferences(key, { dismissedStepIndex: lastStepIndex }, { stateDir });
    if (args.json) process.stdout.write(`${JSON.stringify({ ok: true, prefs })}\n`);
    else process.stdout.write('Current turn suggestion dismissed.\n');
    return 0;
  }

  if (args.acceptIdx !== null) {
    const chosen = analysis?.candidates?.[args.acceptIdx] || null;
    if (!chosen) {
      if (args.json) {
        process.stdout.write(`${JSON.stringify({ ok: false, error: 'No suggestion available' })}\n`);
      } else {
        process.stdout.write('No suggestion available.\n');
      }
      return 0;
    }
    updatePreferences(key, { dismissedStepIndex: analysis.lastStepIndex }, { stateDir });
    if (args.json) {
      process.stdout.write(`${JSON.stringify({ ok: true, accepted: chosen })}\n`);
    } else {
      process.stdout.write(`${chosen.text}\n`);
    }
    return 0;
  }

  const prefs = getPreferences(key, { stateDir });
  if (args.json) {
    process.stdout.write(`${JSON.stringify({ analysis, prefs }, null, 2)}\n`);
    return 0;
  }

  process.stdout.write(`${renderBoxedPanel(analysis, prefs, { width })}\n`);
  return 0;
}

const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith('prompt-suggestion.mjs') || process.argv[1].endsWith('suggest'));
if (isMain) {
  const code = await runPromptSuggestionCli(process.argv.slice(2));
  process.exit(code);
}
