import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

const ID_RE = /^[0-9a-f-]{8,64}$/i;
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;
const USER_REQUEST_RE = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i;
const METADATA_BLOCK_RE =
  /<(?:ADDITIONAL_METADATA|USER_SETTINGS_CHANGE|SYSTEM_MESSAGE)>[\s\S]*?<\/(?:ADDITIONAL_METADATA|USER_SETTINGS_CHANGE|SYSTEM_MESSAGE)>/gi;

export const SHORTCUT_CMD_RE =
  /^(?:\/prompt-suggestion(?::prompt-suggestion)?|:s|:suggest)(?:\s+([\s\S]*))?$/i;
const OTHER_ZERO_TOKEN_CMD_RE =
  /^(?:\/context-usage(?::context-usage)?|:ctx|:context)(?:\s+[\s\S]*)?$/i;

const EDIT_TOOL_RE = /^(?:edit_file|write_file|replace_file_content|multi_replace_file_content|write_to_file)$/i;
const TEST_CMD_RE =
  /\b(?:npm\s+(?:test|run\s+(?:test|check|validate|lint|build))|pnpm\s+(?:test|check)|yarn\s+test|node\s+--test|pytest|python3?\s+-m\s+pytest|cargo\s+test|go\s+test|vitest|jest|agy\s+plugin\s+validate)\b/i;
const CMD_EXIT_FAIL_RE = /Command exited with code ([1-9]\d*)/;
const CMD_EXIT_ZERO_RE = /Command exited with code 0\b/;
const CMD_ERROR_BODY_RE = /\b(?:FAIL|ERR!|AssertionError|SyntaxError|TypeError|ReferenceError)\b/;

const PLAN_OFFER_RE =
  /(?:如果(?:你|您)?(?:希望|需要|想|确认)|需要我(?:直接|现在|继续|为你)?|是否(?:需要|开始|继续|按)|我可以(?:立刻|立即|直接|马上|为你)|开始(?:实现|执行|修改)|would you like me to|shall i\s+|should i proceed|want me to (?:implement|build|apply|create|proceed)|ready to implement)/i;
const BUG_ASK_RE =
  /(?:报错|错误|失败|异常|为什么.*不|修复|bug|error|fail(?:ed|ing)?|broken|crash|fix\b)/i;

const POLITE_FILLER_RE =
  /^(?:looks?\s+good(?:\s+to\s+me)?|lgtm|thanks!?|thank\s+you!?|ok(?:ay)?|great|awesome|nice|cool|got\s+it|understood|yes|no|sure|好的|好|谢谢|多谢|没问题|可以|行|收到|明白|知道了|看起来不错|挺好的)[.!！。~]*$/i;
const ASSISTANT_VOICE_RE =
  /^(?:i\s+can\s+|i'll\s+|i\s+will\s+|let\s+me\s+|here(?:'s|\s+is|\s+are)\s+|sure[,!\s]|certainly[,!\s]|of\s+course|would\s+you\s+like\s+me\s+to|do\s+you\s+want\s+me\s+to|shall\s+i\s+|我可以|让我来?|好的[，,]?\s*我|需要我|要不要我|以下是|我已经|下面为您)/i;

const FULL_TRANSCRIPT_MAX_BYTES = 20 * 1024 * 1024;
const rawTextCache = new Map();
const pkgScriptCache = new Map();
const analysisCache = new Map();

function safeStat(filePath) {
  try {
    const s = statSync(filePath);
    return { exists: true, mtimeMs: s.mtimeMs, size: s.size, isDir: s.isDirectory() };
  } catch {
    return { exists: false, mtimeMs: 0, size: -1, isDir: false };
  }
}

function safeReaddir(dirPath) {
  try {
    return readdirSync(dirPath);
  } catch {
    return [];
  }
}

function setLru(map, key, val, limit = 200) {
  if (map.has(key)) map.delete(key);
  map.set(key, val);
  if (map.size > limit) {
    const oldest = map.keys().next().value;
    map.delete(oldest);
  }
}

function readCachedText(filePath) {
  const st = safeStat(filePath);
  if (!st.exists || st.size < 0) return { text: null, mtimeMs: 0, size: -1 };
  const key = `${st.mtimeMs}:${st.size}`;
  const hit = rawTextCache.get(filePath);
  if (hit && hit.key === key) {
    return { text: hit.text, mtimeMs: st.mtimeMs, size: st.size };
  }
  try {
    const text = readFileSync(filePath, 'utf8');
    setLru(rawTextCache, filePath, { key, text }, 200);
    return { text, mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return { text: null, mtimeMs: 0, size: -1 };
  }
}

export function stripAnsi(str) {
  return String(str ?? '').replace(ANSI_RE, '');
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
    (cp >= 0xff01 && cp <= 0xff60) ||
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
    const cp = ch.codePointAt(0);
    if (cp !== undefined) w += charWidth(cp);
  }
  return w;
}

export function truncateDisplay(str, maxCols) {
  const plain = String(str ?? '').replace(/[\r\n\t]+/g, ' ');
  const limit = Math.max(0, Number(maxCols) || 0);
  if (limit === 0) return '';
  if (displayWidth(plain) <= limit) return plain;

  const ellipsis = '…';
  const target = Math.max(0, limit - 1);
  let width = 0;
  let out = '';
  for (const ch of plain) {
    const cp = ch.codePointAt(0);
    const cw = cp !== undefined ? charWidth(cp) : 0;
    if (width + cw > target) break;
    out += ch;
    width += cw;
  }
  return out + ellipsis;
}

export function productOf(appDataPath) {
  const base = basename(String(appDataPath || ''));
  if (base === 'antigravity-cli') return 'cli';
  if (base === 'antigravity-ide') return 'ide';
  if (base === 'antigravity') return 'app';
  return base || 'unknown';
}

export function findAppDataDirs(env = process.env) {
  const seen = new Set();
  const out = [];

  const addCandidate = (dirPath) => {
    if (!dirPath) return;
    const resolved = resolve(dirPath);
    if (seen.has(resolved)) return;
    const brainStat = safeStat(join(resolved, 'brain'));
    if (brainStat.exists && brainStat.isDir) {
      seen.add(resolved);
      out.push(resolved);
    }
  };

  if (env?.ANTIGRAVITY_EXECUTABLE_DATA_DIR) {
    let cur = env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
    while (cur && cur !== dirname(cur)) {
      if (basename(cur) === 'sidecar_data') {
        addCandidate(dirname(cur));
        break;
      }
      cur = dirname(cur);
    }
  }

  if (env?.ANTIGRAVITY_APP_DATA_DIR) {
    addCandidate(env.ANTIGRAVITY_APP_DATA_DIR);
  }

  const home = env?.HOME || homedir();
  const geminiRoot = join(home, '.gemini');
  for (const name of ['antigravity', 'antigravity-cli', 'antigravity-ide']) {
    addCandidate(join(geminiRoot, name));
  }
  for (const name of safeReaddir(geminiRoot).sort()) {
    addCandidate(join(geminiRoot, name));
  }

  return out;
}

export function extractConvIdFromPath(transcriptPath) {
  if (!transcriptPath) return '';
  const m = String(transcriptPath).match(/[/\\]brain[/\\]([^/\\]+)[/\\]/);
  return m && ID_RE.test(m[1]) ? m[1] : '';
}

function transcriptPathFor(appData, convId) {
  return join(appData, 'brain', convId, '.system_generated', 'logs', 'transcript.jsonl');
}

export function locateConversation(convId, envOrOpts = process.env) {
  if (!convId || !ID_RE.test(String(convId))) return null;
  let dirs = null;
  let env = process.env;
  if (envOrOpts && typeof envOrOpts === 'object') {
    if (Array.isArray(envOrOpts.dirs) || envOrOpts.env) {
      dirs = envOrOpts.dirs || null;
      env = envOrOpts.env || process.env;
    } else {
      env = envOrOpts;
    }
  }

  const candidates = Array.isArray(dirs) && dirs.length ? dirs : findAppDataDirs(env);
  let fallback = null;

  for (const appData of candidates) {
    const tPath = transcriptPathFor(appData, convId);
    const tStat = safeStat(tPath);
    if (tStat.exists && tStat.size >= 0) {
      return {
        appData,
        product: productOf(appData),
        conversationId: convId,
        transcriptPath: tPath,
        mtimeMs: tStat.mtimeMs,
        size: tStat.size,
      };
    }
    if (!fallback) {
      const bStat = safeStat(join(appData, 'brain', convId));
      if (bStat.exists && bStat.isDir) {
        fallback = {
          appData,
          product: productOf(appData),
          conversationId: convId,
          transcriptPath: tPath,
          mtimeMs: bStat.mtimeMs,
          size: 0,
        };
      }
    }
  }

  return fallback;
}

export function resolveStateDir(env = process.env) {
  if (env?.AGY_PROMPT_SUGGESTION_STATE_DIR) {
    return resolve(env.AGY_PROMPT_SUGGESTION_STATE_DIR);
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'user';
  return join(tmpdir(), `antigravity-prompt-suggestion-${uid}`);
}

function stateFilePath(stateDir, env = process.env) {
  const dir = stateDir || resolveStateDir(env);
  return join(dir, 'state.json');
}

function emptyState() {
  return {
    globalEnabled: true,
    sessions: {},
  };
}

export function loadState(stateDir = '') {
  const paths = [stateFilePath(stateDir)];
  if (!stateDir && process.env.PLUGIN_DATA) {
    paths.push(join(process.env.PLUGIN_DATA, 'state.json'));
  }

  for (const file of paths) {
    try {
      if (!existsSync(file)) continue;
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        return {
          globalEnabled: parsed.globalEnabled !== false,
          sessions: parsed.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {},
        };
      }
    } catch {
      // Ignore corrupt or inaccessible state files.
    }
  }
  return emptyState();
}

export function saveState(stateDir = '', state = emptyState()) {
  const normalized = {
    globalEnabled: state?.globalEnabled !== false,
    sessions: state?.sessions && typeof state.sessions === 'object' ? { ...state.sessions } : {},
  };

  const entries = Object.entries(normalized.sessions);
  if (entries.length > 200) {
    entries.sort((a, b) => (Number(a[1]?.updatedAt) || 0) - (Number(b[1]?.updatedAt) || 0));
    normalized.sessions = Object.fromEntries(entries.slice(-200));
  }

  const candidates = [stateFilePath(stateDir)];
  if (!stateDir && process.env.PLUGIN_DATA) {
    candidates.push(join(process.env.PLUGIN_DATA, 'state.json'));
  }

  for (const file of candidates) {
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
      return true;
    } catch {
      // Fall back to PLUGIN_DATA if tmpdir write fails.
    }
  }
  return false;
}

export function sessionKeyFor({ conversationId = '', transcriptPath = '' } = {}) {
  if (conversationId && String(conversationId).trim()) {
    return String(conversationId).trim();
  }
  if (transcriptPath && String(transcriptPath).trim()) {
    const extracted = extractConvIdFromPath(transcriptPath);
    if (extracted) return extracted;
    return resolve(String(transcriptPath).trim());
  }
  return 'default';
}

export function getPreferences(key = 'default', opts = {}) {
  const state = loadState(opts.stateDir || '');
  const session = state.sessions[key] || {};
  const enabled =
    typeof session.enabled === 'boolean' ? session.enabled : state.globalEnabled !== false;
  return {
    globalEnabled: state.globalEnabled !== false,
    enabled,
    sessionEnabled: typeof session.enabled === 'boolean' ? session.enabled : null,
    dismissedStepIndex:
      typeof session.dismissedStepIndex === 'number' ? session.dismissedStepIndex : -1,
    cached: session.cached || null,
  };
}

export function updatePreferences(key = 'default', patch = {}, opts = {}) {
  const state = loadState(opts.stateDir || '');
  const cur = state.sessions[key] && typeof state.sessions[key] === 'object' ? state.sessions[key] : {};

  if (typeof patch.globalEnabled === 'boolean') {
    state.globalEnabled = patch.globalEnabled;
  }

  const next = { ...cur, updatedAt: Date.now() };
  if (patch.enabled === null) {
    delete next.enabled;
  } else if (typeof patch.enabled === 'boolean') {
    next.enabled = patch.enabled;
  }
  if (typeof patch.dismissedStepIndex === 'number') {
    next.dismissedStepIndex = patch.dismissedStepIndex;
  }
  if (patch.cached !== undefined) {
    next.cached = patch.cached;
  }

  state.sessions[key] = next;
  saveState(opts.stateDir || '', state);
  return getPreferences(key, opts);
}

export function cacheSuggestions(key = 'default', data = null, opts = {}) {
  if (!data || typeof data !== 'object') return false;
  updatePreferences(
    key,
    {
      cached: {
        lastStepIndex: typeof data.lastStepIndex === 'number' ? data.lastStepIndex : -1,
        updatedAt: Date.now(),
        candidates: Array.isArray(data.candidates) ? data.candidates : [],
        title: data.title || '',
        turnCompleted: Boolean(data.turnCompleted),
        signals: data.signals || {},
      },
    },
    opts
  );
  return true;
}

/**
 * Deterministic filter ("Silent rather than wrong"): cleans a suggestion or returns null.
 */
export function filterSuggestion(raw) {
  if (typeof raw !== 'string') return null;
  let text = raw.trim();
  if (!text) return null;

  // Reject multi-line text and code fences early.
  if (/[\r\n]/.test(text) || text.includes('```')) return null;

  // Strip optional leading bullet or quote markers.
  text = text
    .replace(/^>\s*/, '')
    .replace(/^[-*•]\s*/, '')
    .replace(/^\d+[.)]\s*/, '')
    .trim();

  // Reject inline backticks wrapping the entire suggestion.
  if (/^`[^`]*`$/.test(text)) return null;

  // Strip surrounding matching quotation marks.
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'")) ||
    (text.startsWith('“') && text.endsWith('”')) ||
    (text.startsWith('‘') && text.endsWith('’'))
  ) {
    text = text.slice(1, -1).trim();
  }

  if (!text) return null;
  if (/^`[^`]*`$/.test(text)) return null;

  // Reject HTML tags, Markdown headings, Markdown links, and protocol URLs.
  if (/<\/?[a-z][a-z0-9-]*(?:\s[^>]*)?>/i.test(text)) return null;
  if (/^\s*#+\s/.test(text)) return null;
  if (/\[[^\]]+\]\([^)]+\)/.test(text)) return null;
  if (/(?:sidecar|customization|plugin|https?):\/\//i.test(text)) return null;

  // Reject multi-sentence output (allow single trailing punctuation).
  if (/[。！？!?]\s*\S/.test(text) || /\.\s+[A-Z\u3400-\u9fff]/.test(text)) {
    return null;
  }

  // Reject evaluative / polite-only filler and assistant-voice phrases before & after trailing punctuation strip.
  if (POLITE_FILLER_RE.test(text) || ASSISTANT_VOICE_RE.test(text)) {
    return null;
  }

  // Strip a single trailing period / Chinese period for natural input-box style (preserve ? / ？).
  text = text.replace(/[。.]$/, '').trim();
  if (!text) return null;

  if (POLITE_FILLER_RE.test(text) || ASSISTANT_VOICE_RE.test(text)) {
    return null;
  }

  const hasCjk = CJK_RE.test(text);
  if (hasCjk ? text.length < 4 : text.length < 8) return null;
  if (displayWidth(text) > 76 || text.length > 110) return null;

  return text;
}

export function extractRawPromptText(content) {
  if (typeof content !== 'string' || !content.trim()) return '';
  const m = USER_REQUEST_RE.exec(content);
  if (m) return m[1].trim();
  return content.replace(METADATA_BLOCK_RE, ' ').trim();
}

function unquoteArg(val) {
  if (typeof val !== 'string') return val == null ? '' : String(val);
  const s = val.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    try {
      return String(JSON.parse(s));
    } catch {
      return s.slice(1, -1);
    }
  }
  return s;
}

function isZeroTokenCommandText(promptText) {
  const trimmed = String(promptText || '').trim();
  if (!trimmed) return false;
  return SHORTCUT_CMD_RE.test(trimmed) || OTHER_ZERO_TOKEN_CMD_RE.test(trimmed);
}

function parseJsonlSteps(text) {
  const steps = [];
  if (typeof text !== 'string' || !text) return steps;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === 'object') {
        steps.push({ step: obj, lineIndex: i });
      }
    } catch {
      // Ignore partial trailing line during active writes.
    }
  }
  return steps;
}

function recoverTruncatedContent(step, lineIndex, transcriptPath) {
  const content = typeof step?.content === 'string' ? step.content : '';
  if (
    !transcriptPath ||
    !Array.isArray(step?.truncated_fields) ||
    !step.truncated_fields.includes('content')
  ) {
    return content;
  }
  const fullPath = join(dirname(transcriptPath), 'transcript_full.jsonl');
  const st = safeStat(fullPath);
  if (!st.exists || st.size <= 0 || st.size > FULL_TRANSCRIPT_MAX_BYTES) {
    return content;
  }
  try {
    const lines = readFileSync(fullPath, 'utf8').split('\n');
    const candidateLine = lines[lineIndex];
    if (candidateLine && candidateLine.trim()) {
      const parsed = JSON.parse(candidateLine);
      if (
        parsed &&
        typeof parsed.content === 'string' &&
        (step.step_index == null || parsed.step_index === step.step_index)
      ) {
        return parsed.content;
      }
    }
    if (step.step_index != null) {
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed && parsed.step_index === step.step_index && typeof parsed.content === 'string') {
            return parsed.content;
          }
        } catch {
          // Skip malformed line.
        }
      }
    }
  } catch {
    // Keep compact content on error.
  }
  return content;
}

function detectWorkspaceTestCommand(cwd) {
  if (!cwd) return null;
  const pkgPath = join(String(cwd), 'package.json');
  const st = safeStat(pkgPath);
  if (!st.exists || st.size <= 0 || st.size > 1024 * 1024) return null;
  const cacheKey = `${pkgPath}|${st.mtimeMs}:${st.size}`;
  if (pkgScriptCache.has(cacheKey)) return pkgScriptCache.get(cacheKey);

  let result = null;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    const scripts = pkg?.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
    if (typeof scripts.check === 'string' && scripts.check.trim()) {
      result = 'npm run check';
    } else if (
      typeof scripts.test === 'string' &&
      scripts.test.trim() &&
      !scripts.test.includes('no test specified')
    ) {
      result = 'npm test';
    }
  } catch {
    result = null;
  }
  setLru(pkgScriptCache, cacheKey, result, 100);
  return result;
}

function isWorkspaceEditPath(filePath) {
  if (!filePath) return false;
  const norm = String(filePath).replace(/\\/g, '/');
  if (norm.includes('/brain/') || norm.includes('/.gemini/')) return false;
  return true;
}

function cleanSnippetTitle(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 72) || 'Untitled conversation';
}

export function analyzeSuggestionsFromTranscript(transcriptText, opts = {}) {
  const entries = parseJsonlSteps(transcriptText);
  if (entries.length === 0) {
    return {
      title: 'New conversation',
      turnCompleted: false,
      lastStepIndex: -1,
      lang: 'zh',
      candidates: [],
      signals: {},
    };
  }

  // Group into logical turns anchored at USER_INPUT so zero-token trailing shortcuts don't hide the previous turn.
  const turns = [];
  for (const item of entries) {
    if (item.step.type === 'USER_INPUT') {
      turns.push({ userItem: item, items: [item] });
    } else if (turns.length > 0) {
      turns[turns.length - 1].items.push(item);
    }
  }

  let title = 'Untitled conversation';
  for (const t of turns) {
    const prompt = extractRawPromptText(t.userItem.step.content);
    if (prompt && !isZeroTokenCommandText(prompt)) {
      title = cleanSnippetTitle(prompt);
      break;
    }
  }

  while (turns.length > 0) {
    const lastTurn = turns[turns.length - 1];
    const prompt = extractRawPromptText(lastTurn.userItem.step.content);
    const hasPlanner = lastTurn.items.some((e) => e.step.type === 'PLANNER_RESPONSE');
    if (!hasPlanner && isZeroTokenCommandText(prompt)) {
      turns.pop();
    } else {
      break;
    }
  }

  if (turns.length === 0) {
    return {
      title,
      turnCompleted: false,
      lastStepIndex: -1,
      lang: 'zh',
      candidates: [],
      signals: {},
    };
  }

  const activeTurn = turns[turns.length - 1];
  const turnItems = activeTurn.items;
  const lastUserPrompt = extractRawPromptText(activeTurn.userItem.step.content);
  const lastEntry = turnItems[turnItems.length - 1];
  const lastStepIndex =
    typeof lastEntry.step.step_index === 'number'
      ? lastEntry.step.step_index
      : lastEntry.lineIndex;

  let lastPlannerIdx = -1;
  for (let i = turnItems.length - 1; i >= 0; i--) {
    if (turnItems[i].step.type === 'PLANNER_RESPONSE') {
      lastPlannerIdx = i;
      break;
    }
  }

  const lastPlannerEntry = lastPlannerIdx >= 0 ? turnItems[lastPlannerIdx] : null;
  const lastToolCalls = Array.isArray(lastPlannerEntry?.step?.tool_calls)
    ? lastPlannerEntry.step.tool_calls
    : [];
  const onlyAskQuestion =
    lastToolCalls.length > 0 && lastToolCalls.every((tc) => tc?.name === 'ask_question');
  const turnCompleted =
    Boolean(lastPlannerEntry) && (lastToolCalls.length === 0 || onlyAskQuestion);

  if (!turnCompleted && !opts.allowIncomplete) {
    return {
      title,
      turnCompleted: false,
      lastStepIndex,
      lang: CJK_RE.test(lastUserPrompt) ? 'zh' : 'en',
      candidates: [],
      signals: {},
    };
  }

  const lastAssistantText = lastPlannerEntry
    ? recoverTruncatedContent(lastPlannerEntry.step, lastPlannerEntry.lineIndex, opts.transcriptPath)
    : '';
  const lang =
    lastUserPrompt.length >= 3
      ? CJK_RE.test(lastUserPrompt)
        ? 'zh'
        : 'en'
      : CJK_RE.test(`${lastUserPrompt} ${lastAssistantText}`)
        ? 'zh'
        : 'en';

  const editedFiles = [];
  let lastEditOrder = -1;
  let lastTestPassOrder = -1;
  let anyTestAfterEdit = false;
  let hasFailedCommand = false;
  let failedStepIdx = -1;
  let failedWasTest = false;
  let createdPlanOrArtifact = false;

  for (let i = 0; i < turnItems.length; i++) {
    const step = turnItems[i].step;
    if (step.type !== 'PLANNER_RESPONSE' || !Array.isArray(step.tool_calls)) continue;

    // Collect corresponding GENERIC outputs between this PLANNER_RESPONSE and the next PLANNER_RESPONSE.
    const genericSteps = [];
    for (let j = i + 1; j < turnItems.length; j++) {
      const nextStep = turnItems[j].step;
      if (nextStep.type === 'PLANNER_RESPONSE') break;
      if (nextStep.type === 'GENERIC') genericSteps.push(nextStep);
    }

    for (let k = 0; k < step.tool_calls.length; k++) {
      const tc = step.tool_calls[k] || {};
      const toolName = String(tc.name || '');
      const args = tc.args && typeof tc.args === 'object' ? tc.args : {};
      const outStep = genericSteps[k];
      const outText = typeof outStep?.content === 'string' ? outStep.content : '';

      if (EDIT_TOOL_RE.test(toolName)) {
        const rawPath =
          args.Path || args.TargetFile || args.AbsolutePath || args.path || args.file_path || '';
        const cleanPath = unquoteArg(rawPath);
        if (isWorkspaceEditPath(cleanPath)) {
          editedFiles.push(cleanPath);
          lastEditOrder = i * 100 + k;
        } else if (cleanPath) {
          createdPlanOrArtifact = true;
        }
      } else if (toolName === 'exit_plan_mode') {
        createdPlanOrArtifact = true;
      } else if (toolName === 'run_command') {
        const cmd = unquoteArg(args.CommandLine || args.command || '');
        const isTestCmd = TEST_CMD_RE.test(cmd);
        const order = i * 100 + k;
        const matchedText =
          outText ||
          genericSteps
            .map((g) => String(g.content || ''))
            .find((txt) => txt.includes('Command exited with code') || txt.includes('Command output:')) ||
          '';

        const exitedFail = CMD_EXIT_FAIL_RE.test(matchedText);
        const exitedZero = CMD_EXIT_ZERO_RE.test(matchedText);
        const hasErrorSignature =
          !exitedZero &&
          Boolean(matchedText) &&
          CMD_ERROR_BODY_RE.test(matchedText) &&
          matchedText.includes('Command ');

        if (exitedFail || hasErrorSignature) {
          hasFailedCommand = true;
          failedStepIdx = i;
          failedWasTest = isTestCmd;
        } else if (exitedZero) {
          if (hasFailedCommand && i > failedStepIdx && (!failedWasTest || isTestCmd)) {
            hasFailedCommand = false;
          }
          if (isTestCmd) {
            if (lastEditOrder >= 0 && order > lastEditOrder) {
              anyTestAfterEdit = true;
            }
            lastTestPassOrder = order;
          }
        }
      }
    }
  }

  const tailAssistant = lastAssistantText.slice(-800);
  const hasOffer = PLAN_OFFER_RE.test(tailAssistant) || createdPlanOrArtifact || onlyAskQuestion;
  const hasNumberedOptions = /(?:^|\n)\s*1\.\s+[\s\S]{3,160}\n\s*2\.\s+/m.test(tailAssistant);
  const hasEdits = editedFiles.length > 0;
  const hasUnverifiedEdits = hasEdits && !anyTestAfterEdit && lastTestPassOrder < lastEditOrder;
  const hasVerifiedEdits = hasEdits && !hasUnverifiedEdits;
  const hasBugDiagnosis =
    !hasEdits && BUG_ASK_RE.test(lastUserPrompt) && lastAssistantText.trim().length > 120;

  const detectedTestCmd = detectWorkspaceTestCommand(opts.cwd);
  const testLabelZh = detectedTestCmd || '测试与校验';
  const testLabelEn = detectedTestCmd || 'tests and validation';

  const rawCandidates = [];
  const pushCandidate = (text, reason, confidence) => {
    const clean = filterSuggestion(text);
    if (!clean) return;
    if (rawCandidates.some((c) => c.text === clean)) return;
    rawCandidates.push({ text: clean, reason, confidence });
  };

  if (hasFailedCommand) {
    if (lang === 'zh') {
      pushCandidate('定位并修复刚才命令的报错，重新运行验证直到通过', 'command_failed', 0.92);
      pushCandidate('分析上述失败原因并给出最小修复方案', 'command_failed', 0.84);
    } else {
      pushCandidate('Fix the failing command error above and re-run verification', 'command_failed', 0.92);
      pushCandidate('Explain the root cause of that failure before changing files', 'command_failed', 0.84);
    }
  }

  if (hasUnverifiedEdits) {
    if (lang === 'zh') {
      pushCandidate(`运行 ${testLabelZh} 验证刚才修改的代码是否全部通过`, 'unverified_edits', 0.9);
      pushCandidate('检查刚才修改的文件是否存在遗漏的边界情况', 'unverified_edits', 0.82);
    } else {
      pushCandidate(`Run ${testLabelEn} to verify the latest changes pass`, 'unverified_edits', 0.9);
      pushCandidate('Check the modified files for any missed edge cases', 'unverified_edits', 0.82);
    }
  }

  if (hasOffer) {
    if (hasNumberedOptions) {
      if (lang === 'zh') {
        pushCandidate('采用第一个推荐方案，直接开始实现并完成测试验证', 'plan_or_offer', 0.86);
        pushCandidate('先给出详细的改动文件清单与实施计划', 'plan_or_offer', 0.8);
      } else {
        pushCandidate('Use the first recommended option and start implementing with tests', 'plan_or_offer', 0.86);
        pushCandidate('Outline the exact file changes before implementing', 'plan_or_offer', 0.8);
      }
    } else if (lang === 'zh') {
      pushCandidate('按上述推荐方案直接开始实现并运行验证', 'plan_or_offer', 0.86);
      pushCandidate('在动手前先列出需要改动的文件与边界条件', 'plan_or_offer', 0.79);
    } else {
      pushCandidate('Proceed with the recommended implementation and run verification', 'plan_or_offer', 0.86);
      pushCandidate('List the exact files and edge cases before making edits', 'plan_or_offer', 0.79);
    }
  }

  if (hasVerifiedEdits) {
    const editedReadme = editedFiles.some((p) => /readme\.md$/i.test(p));
    const editedCode = editedFiles.some((p) =>
      /(?:^|\/)(?:plugins|src|bin|hooks|sidecars)\//i.test(p)
    );
    if (lang === 'zh') {
      pushCandidate('检查 git status 与 git diff，确认改动完整且无多余文件', 'verified_edits', 0.78);
      if (editedCode && !editedReadme) {
        pushCandidate('同步检查并更新相关的 README 文档说明', 'verified_edits', 0.74);
      }
    } else {
      pushCandidate('Check git status and git diff to review all changes cleanly', 'verified_edits', 0.78);
      if (editedCode && !editedReadme) {
        pushCandidate('Update README documentation to reflect the new changes', 'verified_edits', 0.74);
      }
    }
  }

  if (hasBugDiagnosis) {
    if (lang === 'zh') {
      pushCandidate('按上述分析直接修复该问题并补充回归测试', 'bug_diagnosis_no_edit', 0.76);
    } else {
      pushCandidate('Apply the fix based on this analysis and add a regression test', 'bug_diagnosis_no_edit', 0.76);
    }
  }

  rawCandidates.sort((a, b) => b.confidence - a.confidence);
  const candidates = rawCandidates.slice(0, 3);

  return {
    title,
    turnCompleted,
    lastStepIndex,
    lang,
    candidates,
    signals: {
      hasFailedCommand,
      hasUnverifiedEdits,
      hasVerifiedEdits,
      hasOffer,
      hasNumberedOptions,
      hasBugDiagnosis,
      editedFileCount: editedFiles.length,
      detectedTestCmd: detectedTestCmd || '',
    },
  };
}

export function suggestForTranscriptFile(transcriptPath, opts = {}) {
  if (!transcriptPath) return null;
  const { text, mtimeMs, size } = readCachedText(transcriptPath);
  if (text === null) return null;

  const cwd = opts.cwd || '';
  const allowIncomplete = Boolean(opts.allowIncomplete);
  const cacheKey = `${transcriptPath}|${cwd}|${allowIncomplete}`;
  const sig = `${mtimeMs}:${size}`;
  const hit = analysisCache.get(cacheKey);
  if (hit && hit.sig === sig) {
    return hit.result;
  }

  const analysis = analyzeSuggestionsFromTranscript(text, {
    cwd,
    allowIncomplete,
    transcriptPath,
  });
  const conversationId = opts.conversationId || extractConvIdFromPath(transcriptPath);
  const result = {
    conversationId,
    transcriptPath,
    mtimeMs,
    fileSize: size,
    ...analysis,
  };
  setLru(analysisCache, cacheKey, { sig, result }, 200);
  return result;
}

export function listRecentConversations({ limit = 30, dirs = null, env = process.env } = {}) {
  const appDirs = Array.isArray(dirs) && dirs.length ? dirs : findAppDataDirs(env);
  const items = [];
  const seenIds = new Set();

  for (const appData of appDirs) {
    const brainDir = join(appData, 'brain');
    for (const convId of safeReaddir(brainDir)) {
      if (!ID_RE.test(convId) || seenIds.has(`${appData}:${convId}`)) continue;
      const tPath = transcriptPathFor(appData, convId);
      const st = safeStat(tPath);
      if (!st.exists || st.size <= 0) continue;
      seenIds.add(`${appData}:${convId}`);

      const analysis = suggestForTranscriptFile(tPath, { conversationId: convId });
      if (!analysis) continue;

      const key = sessionKeyFor({ conversationId: convId, transcriptPath: tPath });
      const prefs = getPreferences(key, { stateDir: env?.AGY_PROMPT_SUGGESTION_STATE_DIR || '' });
      const dismissed =
        prefs.dismissedStepIndex >= 0 && prefs.dismissedStepIndex === analysis.lastStepIndex;

      items.push({
        conversationId: convId,
        product: productOf(appData),
        transcriptPath: tPath,
        title: analysis.title,
        turnCompleted: analysis.turnCompleted,
        lastStepIndex: analysis.lastStepIndex,
        candidateCount: analysis.candidates.length,
        topSuggestion: analysis.candidates[0]?.text || '',
        dismissed,
        enabled: prefs.enabled,
        mtimeMs: st.mtimeMs,
        size: st.size,
      });
    }
  }

  items.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return items.slice(0, Math.max(1, Math.min(200, Number(limit) || 30)));
}
