#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import {
  extractRawPromptText,
  getPreferences,
  locateConversation,
  sessionKeyFor,
  SHORTCUT_CMD_RE,
  suggestForTranscriptFile,
  updatePreferences,
} from '../sidecars/suggestion_panel/engine.mjs';

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

function inspectTranscriptState(transcriptPath, fallbackInput, initialNumSteps) {
  const fallbackText = extractRawPromptText(fallbackInput);

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
          // Ignore partial trailing line.
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
        const hasPlannerAfter = steps
          .slice(lastUserIdx + 1)
          .some((s) => s.type === 'PLANNER_RESPONSE');
        if (hasPlannerAfter) {
          if (typeof initialNumSteps === 'number' && initialNumSteps > 0 && steps.length <= initialNumSteps) {
            return { midTurn: false, promptText: fallbackText || lastTranscriptPrompt };
          }
          if (fallbackText && fallbackText !== lastTranscriptPrompt) {
            return { midTurn: false, promptText: fallbackText };
          }
          return { midTurn: true, promptText: '' };
        }
        return {
          midTurn: false,
          promptText: lastTranscriptPrompt || fallbackText,
        };
      }
    } catch {
      // Fall back to payload.lastUserInput.
    }
  }

  return {
    midTurn: false,
    promptText: fallbackText,
  };
}

function parseShortcutCommand(rawText) {
  const trimmed = String(rawText || '').trim();
  if (!trimmed) return null;
  const m = SHORTCUT_CMD_RE.exec(trimmed);
  if (!m) return null;

  const isSlashCmd = trimmed.toLowerCase().startsWith('/prompt-suggestion');
  const rest = (m[1] || '').trim();

  if (!rest) {
    return isSlashCmd ? { action: 'list' } : { action: 'accept', index: 0, extra: '' };
  }

  const lower = rest.toLowerCase();
  if (lower === 'off' || lower === 'disable') return { action: 'off' };
  if (lower === 'on' || lower === 'enable') return { action: 'on' };
  if (lower === 'clear' || lower === 'dismiss' || lower === 'esc') return { action: 'clear' };
  if (lower === '?' || lower === 'list' || lower === 'help') return { action: 'list' };

  const acceptMatch = rest.match(/^(?:([1-3])(?:\s+|$))?(?:(?:\+|--)\s+([\s\S]+))?$/);
  if (acceptMatch && (acceptMatch[1] || acceptMatch[2])) {
    const index = acceptMatch[1] ? Number(acceptMatch[1]) - 1 : 0;
    const extra = (acceptMatch[2] || '').trim();
    return { action: 'accept', index, extra };
  }

  return null;
}

function makeZeroTokenMarkdown(markdown) {
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

function resolveSuggestionsForHook(payload, opts = {}) {
  const convId = typeof payload.conversationId === 'string' ? payload.conversationId : '';
  const transcriptPath = typeof payload.transcriptPath === 'string' ? payload.transcriptPath : '';
  const cwd =
    typeof payload.cwd === 'string' && payload.cwd
      ? payload.cwd
      : Array.isArray(payload.workspacePaths) && payload.workspacePaths[0]
        ? payload.workspacePaths[0]
        : '';

  const key = sessionKeyFor({ conversationId: convId, transcriptPath });
  const prefs = getPreferences(key, { stateDir: opts.stateDir });

  let analysis = null;
  if (transcriptPath && existsSync(transcriptPath)) {
    analysis = suggestForTranscriptFile(transcriptPath, {
      conversationId: convId,
      cwd,
      stateDir: opts.stateDir,
    });
  } else if (convId) {
    const loc = locateConversation(convId, { dirs: opts.dirs, env: opts.env || process.env });
    if (loc?.transcriptPath && existsSync(loc.transcriptPath)) {
      analysis = suggestForTranscriptFile(loc.transcriptPath, {
        conversationId: convId,
        cwd,
        stateDir: opts.stateDir,
      });
    }
  }

  if (!analysis && prefs.cached) {
    analysis = {
      conversationId: convId,
      transcriptPath,
      title: prefs.cached.title || '',
      turnCompleted: Boolean(prefs.cached.turnCompleted),
      lastStepIndex:
        typeof prefs.cached.lastStepIndex === 'number' ? prefs.cached.lastStepIndex : -1,
      candidates: Array.isArray(prefs.cached.candidates) ? prefs.cached.candidates : [],
      signals: prefs.cached.signals || {},
    };
  }

  return { key, prefs, analysis };
}

function formatSuggestionListMarkdown({ analysis, prefs, isCliSurface }) {
  const lines = ['### 💡 Prompt Suggestions'];
  const statusTag = prefs.enabled ? '已开启 (`on`)' : '已关闭 (`off`)';
  lines.push('');
  lines.push(`- **状态**: ${statusTag}`);

  const candidates = Array.isArray(analysis?.candidates) ? analysis.candidates : [];
  const isDismissed =
    prefs.dismissedStepIndex >= 0 && prefs.dismissedStepIndex === analysis?.lastStepIndex;

  if (!candidates.length) {
    lines.push('- **当前预测**: 暂无高置信度追问建议（当前处于首轮对话或上一轮为封闭问答）。');
  } else {
    lines.push(
      `- **当前候选**${isDismissed ? '（当前轮次已手动隐藏，仍可通过 `:s` 采纳）' : ''}：`
    );
    lines.push('');
    candidates.forEach((c, idx) => {
      lines.push(`${idx + 1}. **${c.text}** _(${c.reason})_`);
    });
  }

  lines.push('');
  if (isCliSurface) {
    lines.push(
      '> 快捷指令：`:s` 采纳第 1 条 · `:s 2` 采纳第 2 条 · `:s + 补充说明` 附带补充 · `:s clear` 隐藏当前 · `:s off` / `:s on` 开关'
    );
  } else {
    lines.push(
      '> 快捷指令：`:s` 采纳第 1 条 · `:s 2` 采纳第 2 条 · `:s + 补充说明` 附带补充 · `:s clear` 隐藏 · `:s off` / `:s on` 开关'
    );
    lines.push('');
    lines.push('[Prompt Suggestions](sidecar://prompt-suggestion/suggestion_panel/)');
  }

  return lines.join('\n');
}

export function evaluateShortcutIntercept(payload = {}, opts = {}) {
  const transcriptPath = typeof payload.transcriptPath === 'string' ? payload.transcriptPath : '';
  const artifactDir =
    typeof payload.artifactDirectoryPath === 'string' ? payload.artifactDirectoryPath : '';
  const surfaceHint = `${transcriptPath}\n${artifactDir}`;
  const isCliSurface = surfaceHint.includes('antigravity-cli');

  const { midTurn, promptText } = inspectTranscriptState(
    transcriptPath,
    payload.lastUserInput || '',
    payload.initialNumSteps
  );
  if (midTurn) return {};

  const cmd = parseShortcutCommand(promptText);
  if (!cmd) return {};

  const { key, prefs, analysis } = resolveSuggestionsForHook(payload, opts);
  const lastStepIndex = typeof analysis?.lastStepIndex === 'number' ? analysis.lastStepIndex : -1;

  if (cmd.action === 'off') {
    updatePreferences(key, { enabled: false }, { stateDir: opts.stateDir });
    return makeZeroTokenMarkdown(
      '> 💡 **Prompt Suggestion 已关闭** — 状态栏将暂停显示建议追问；输入 `:s on` 可随时重新开启。'
    );
  }

  if (cmd.action === 'on') {
    updatePreferences(key, { enabled: true, dismissedStepIndex: -1 }, { stateDir: opts.stateDir });
    return makeZeroTokenMarkdown(
      '> 💡 **Prompt Suggestion 已开启** — 每轮完成后将在状态栏显示高置信度追问建议。'
    );
  }

  if (cmd.action === 'clear') {
    updatePreferences(key, { dismissedStepIndex: lastStepIndex }, { stateDir: opts.stateDir });
    return makeZeroTokenMarkdown(
      '> 💡 已隐藏当前轮次的追问建议；下一轮回复完成后将自动恢复预测。'
    );
  }

  if (cmd.action === 'list') {
    return makeZeroTokenMarkdown(formatSuggestionListMarkdown({ analysis, prefs, isCliSurface }));
  }

  if (cmd.action === 'accept') {
    const candidates = Array.isArray(analysis?.candidates) ? analysis.candidates : [];
    const chosen = candidates[cmd.index];
    if (!chosen) {
      const hint = isCliSurface
        ? '当前暂无可用的追问建议（可能处于首轮对话或上一轮无需追问）。'
        : '当前暂无可用的追问建议，可点击 [Prompt Suggestions](sidecar://prompt-suggestion/suggestion_panel/) 查看历史会话。';
      return makeZeroTokenMarkdown(`> 💡 ${hint}`);
    }

    const expandedPrompt = cmd.extra ? `${chosen.text}（${cmd.extra}）` : chosen.text;
    updatePreferences(key, { dismissedStepIndex: lastStepIndex }, { stateDir: opts.stateDir });

    return {
      injectSteps: [
        {
          systemMessage: {
            systemMessage:
              "The user invoked the `:s` prompt-suggestion shortcut to submit the following follow-up request. Treat this text directly as the user's request for this turn:\n\n" +
              expandedPrompt,
            metadata: {
              user_markdown: `> 💡 **已采纳建议追问**：${expandedPrompt}`,
            },
          },
        },
      ],
    };
  }

  return {};
}

async function main() {
  try {
    const raw = await readStdin();
    const payload = raw.trim() ? JSON.parse(raw) : {};
    const out = evaluateShortcutIntercept(payload);
    process.stdout.write(`${JSON.stringify(out)}\n`);
  } catch {
    process.stdout.write('{}\n');
  }
}

const isMain = process.argv[1] && process.argv[1].endsWith('intercept-shortcut.mjs');
if (isMain) {
  await main();
}
