import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  analyzeSuggestionsFromTranscript,
  displayWidth,
  filterSuggestion,
  getPreferences,
  sessionKeyFor,
  suggestForTranscriptFile,
} from '../sidecars/suggestion_panel/engine.mjs';
import { createSuggestionApp } from '../sidecars/suggestion_panel/main.mjs';
import { evaluateStopHook } from '../hooks/generate-suggestion.mjs';
import { evaluateShortcutIntercept } from '../hooks/intercept-shortcut.mjs';
import { renderStatusline } from '../bin/statusline.mjs';
import { renderBoxedList, renderBoxedPanel } from '../bin/prompt-suggestion.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(__dirname, '..');
const CONTEXT_USAGE_STATUSLINE = resolve(PLUGIN_ROOT, '..', 'context-usage', 'bin', 'statusline.mjs');

function writeJsonl(filePath, steps) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(
    filePath,
    steps.map((s) => (typeof s === 'string' ? s : JSON.stringify(s))).join('\n') + '\n',
    'utf8'
  );
}

test('filterSuggestion: enforces silent-rather-than-wrong deterministic rules', () => {
  // Reject evaluative / polite filler
  for (const bad of [
    'looks good',
    'Looks good to me!',
    'LGTM',
    'thanks!',
    'Thank you.',
    'ok',
    '好的',
    '谢谢！',
    '看起来不错。',
  ]) {
    assert.equal(filterSuggestion(bad), null, `Expected rejection for polite/evaluative: ${bad}`);
  }

  // Reject assistant-voice responses
  for (const bad of [
    'Let me check that for you',
    "I'll run the test suite now",
    'Would you like me to implement this?',
    '我可以帮你运行测试并修复错误',
    '以下是修复方案的详细说明',
  ]) {
    assert.equal(filterSuggestion(bad), null, `Expected rejection for assistant-voice: ${bad}`);
  }

  // Reject markdown, code, URLs, protocols, multi-line, multi-sentence, too short/long
  for (const bad of [
    'line 1\nline 2',
    '```js\nconsole.log(1)\n```',
    '`npm test`',
    '# Heading suggestion',
    'Open [Context Usage](sidecar://context-usage/context_monitor/)',
    'Check https://example.com/docs for more info',
    '<div>click here</div>',
    'ok test',
    '短',
    'First sentence here. Second sentence here.',
    '第一句已完成。第二句要做什么？',
    'a'.repeat(80),
    '中文'.repeat(40),
  ]) {
    assert.equal(filterSuggestion(bad), null, `Expected rejection for formatting/length: ${bad}`);
  }

  // Accept clean user-voice prompts and strip wrapping bullets/quotes/trailing period
  assert.equal(
    filterSuggestion('- "Run npm run check to verify the latest changes pass."'),
    'Run npm run check to verify the latest changes pass'
  );
  assert.equal(
    filterSuggestion('> 运行 npm test 验证刚才修改的代码是否全部通过？'),
    '运行 npm test 验证刚才修改的代码是否全部通过？'
  );
});

test('heuristic engine: unverified edits detect workspace check script and match language', () => {
  const work = mkdtempSync(join(tmpdir(), 'ps-unverified-'));
  try {
    writeFileSync(
      join(work, 'package.json'),
      JSON.stringify({ name: 'demo', scripts: { test: 'node --test', check: 'node check.mjs' } }),
      'utf8'
    );

    const zhJsonl = [
      { step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>\n帮我修改插件配置\n</USER_REQUEST>' },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        tool_calls: [{ name: 'edit_file', args: { Path: JSON.stringify(join(work, 'src/app.js')) } }],
      },
      { step_index: 2, type: 'GENERIC', content: 'Made 1 replacement in src/app.js.' },
      { step_index: 3, type: 'PLANNER_RESPONSE', content: '已完成 `src/app.js` 的逻辑更新。' },
    ]
      .map((s) => JSON.stringify(s))
      .join('\n');

    const zhRes = analyzeSuggestionsFromTranscript(zhJsonl, { cwd: work });
    assert.equal(zhRes.turnCompleted, true);
    assert.equal(zhRes.lang, 'zh');
    assert.ok(zhRes.candidates.length >= 1);
    assert.equal(zhRes.candidates[0].reason, 'unverified_edits');
    assert.match(zhRes.candidates[0].text, /npm run check/);

    const enJsonl = [
      { step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>\nUpdate the parser logic\n</USER_REQUEST>' },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        tool_calls: [{ name: 'write_file', args: { Path: JSON.stringify(join(work, 'src/parser.js')) } }],
      },
      { step_index: 2, type: 'GENERIC', content: 'Created file.' },
      { step_index: 3, type: 'PLANNER_RESPONSE', content: 'Updated parser.js.' },
    ]
      .map((s) => JSON.stringify(s))
      .join('\n');

    const enRes = analyzeSuggestionsFromTranscript(enJsonl, { cwd: work });
    assert.equal(enRes.lang, 'en');
    assert.equal(enRes.candidates[0].reason, 'unverified_edits');
    assert.match(enRes.candidates[0].text, /npm run check/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('heuristic engine: failed command, verified edits, offers, silence, and truncated recovery', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ps-heuristics-'));
  try {
    // 1. Failed command (even when paired with another successful command in same step)
    const failedSteps = [
      { step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>\nRun tests\n</USER_REQUEST>' },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        tool_calls: [
          { name: 'run_command', args: { CommandLine: '"npm test"' } },
          { name: 'run_command', args: { CommandLine: '"ls -la"' } },
        ],
      },
      { step_index: 2, type: 'GENERIC', content: 'Command exited with code 1.\nAssertionError: boom' },
      { step_index: 3, type: 'GENERIC', content: 'Command exited with code 0.\ntotal 4' },
      { step_index: 4, type: 'PLANNER_RESPONSE', content: 'One test failed with AssertionError.' },
    ];
    const failRes = analyzeSuggestionsFromTranscript(failedSteps.map((s) => JSON.stringify(s)).join('\n'));
    assert.equal(failRes.candidates[0].reason, 'command_failed');

    // 2. Verified edits (test passed after edit)
    const verifiedSteps = [
      { step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>\n修复状态栏对齐问题\n</USER_REQUEST>' },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        tool_calls: [{ name: 'edit_file', args: { Path: '"plugins/demo/bin/cli.mjs"' } }],
      },
      { step_index: 2, type: 'GENERIC', content: 'Edited file.' },
      {
        step_index: 3,
        type: 'PLANNER_RESPONSE',
        tool_calls: [{ name: 'run_command', args: { CommandLine: '"npm test"' } }],
      },
      { step_index: 4, type: 'GENERIC', content: 'Command exited with code 0.\nAll tests passed.' },
      { step_index: 5, type: 'PLANNER_RESPONSE', content: '已修复并通过测试。' },
    ];
    const verRes = analyzeSuggestionsFromTranscript(verifiedSteps.map((s) => JSON.stringify(s)).join('\n'));
    assert.equal(verRes.candidates[0].reason, 'verified_edits');
    assert.ok(verRes.candidates.some((c) => c.text.includes('README')));

    // 3. Plan / numbered choices offer recovered from transcript_full.jsonl + trailing malformed line
    const compactPath = join(dir, 'transcript.jsonl');
    const fullPath = join(dir, 'transcript_full.jsonl');
    writeFileSync(
      compactPath,
      [
        JSON.stringify({ step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>\n能否实现这个插件？\n</USER_REQUEST>' }),
        JSON.stringify({
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          content: '可以...<truncated>',
          truncated_fields: ['content'],
        }),
        '{"step_index": 2, "type": "GENERIC", "broken',
      ].join('\n'),
      'utf8'
    );
    writeJsonl(fullPath, [
      { step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>\n能否实现这个插件？\n</USER_REQUEST>' },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        content: '可以采用如下方案。\n\n如果你希望继续，请选择：\n1. 纯本地启发式引擎\n2. 异步轻量模型引擎',
      },
    ]);
    const fullRes = suggestForTranscriptFile(compactPath);
    assert.equal(fullRes.candidates[0].reason, 'plan_or_offer');
    assert.match(fullRes.candidates[0].text, /第一个推荐方案/);

    // 4. Incomplete turn returns empty candidates
    const midTurnRes = analyzeSuggestionsFromTranscript(
      [
        JSON.stringify({ step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>\nFix bug\n</USER_REQUEST>' }),
        JSON.stringify({
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          tool_calls: [{ name: 'read_file', args: { Path: '"a.js"' } }],
        }),
      ].join('\n')
    );
    assert.equal(midTurnRes.turnCompleted, false);
    assert.deepEqual(midTurnRes.candidates, []);

    // 5. Closed factual Q&A stays silent ("silent rather than wrong")
    const qaRes = analyzeSuggestionsFromTranscript(
      [
        JSON.stringify({ step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>\nNode 版本要求是多少？\n</USER_REQUEST>' }),
        JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', content: '需要 Node.js >= 20.0.0。' }),
      ].join('\n')
    );
    assert.equal(qaRes.turnCompleted, true);
    assert.deepEqual(qaRes.candidates, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hooks: Stop caches on NO_TOOL_CALL and PreInvocation handles Turn #1, :s variants, mid-turn, and surface rules', () => {
  const root = mkdtempSync(join(tmpdir(), 'ps-hooks-'));
  try {
    const stateDir = join(root, 'state');
    const convId = '11111111-1111-4111-8111-111111111111';
    const cliTranscript = join(root, '.gemini', 'antigravity-cli', 'brain', convId, '.system_generated', 'logs', 'transcript.jsonl');
    const appTranscript = join(root, '.gemini', 'antigravity', 'brain', convId, '.system_generated', 'logs', 'transcript.jsonl');

    // Turn #1 missing transcript: :s returns zero-token terminate notice
    const turn1 = evaluateShortcutIntercept(
      {
        conversationId: convId,
        transcriptPath: cliTranscript,
        lastUserInput: '<USER_REQUEST>\n:s\n</USER_REQUEST>',
      },
      { stateDir }
    );
    assert.equal(turn1.terminationBehavior, 'terminate');
    assert.equal(turn1.injectSteps[0].systemMessage.systemMessage, '');
    assert.ok(!turn1.injectSteps[0].systemMessage.metadata.user_markdown.includes('sidecar://'));

    // Write completed turn with 2 candidates
    writeJsonl(cliTranscript, [
      { step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>\n修复解析错误\n</USER_REQUEST>' },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        tool_calls: [{ name: 'edit_file', args: { Path: '"src/parser.mjs"' } }],
      },
      { step_index: 2, type: 'GENERIC', content: 'Edited src/parser.mjs' },
      { step_index: 3, type: 'PLANNER_RESPONSE', content: '已完成修复。' },
    ]);

    // Stop hook: non-NO_TOOL_CALL does not cache
    assert.deepEqual(
      evaluateStopHook(
        { conversationId: convId, transcriptPath: cliTranscript, terminationReason: 'USER_CANCELED' },
        { stateDir }
      ),
      {}
    );
    assert.equal(getPreferences(convId, { stateDir }).cached, null);

    // Stop hook: NO_TOOL_CALL caches candidates
    assert.deepEqual(
      evaluateStopHook(
        { conversationId: convId, transcriptPath: cliTranscript, terminationReason: 'NO_TOOL_CALL' },
        { stateDir }
      ),
      {}
    );
    assert.ok(getPreferences(convId, { stateDir }).cached.candidates.length >= 2);

    // Subprocess robustness on malformed stdin
    const badStop = spawnSync('node', [join(PLUGIN_ROOT, 'hooks', 'generate-suggestion.mjs')], {
      input: '{invalid json',
      encoding: 'utf8',
    });
    assert.equal(badStop.status, 0);
    assert.equal(badStop.stdout.trim(), '{}');

    // :s ? on CLI must NOT emit sidecar://
    const cliList = evaluateShortcutIntercept(
      {
        conversationId: convId,
        transcriptPath: cliTranscript,
        artifactDirectoryPath: join(root, '.gemini', 'antigravity-cli', 'brain', convId),
        lastUserInput: '<USER_REQUEST>\n:s ?\n</USER_REQUEST>',
      },
      { stateDir }
    );
    assert.equal(cliList.terminationBehavior, 'terminate');
    assert.ok(!cliList.injectSteps[0].systemMessage.metadata.user_markdown.includes('sidecar://'));

    // Bare /prompt-suggestion on App DOES emit sidecar://
    writeJsonl(appTranscript, [
      { step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>\nFix parser\n</USER_REQUEST>' },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        tool_calls: [{ name: 'edit_file', args: { Path: '"src/parser.mjs"' } }],
      },
      { step_index: 2, type: 'GENERIC', content: 'Edited src/parser.mjs' },
      { step_index: 3, type: 'PLANNER_RESPONSE', content: 'Done.' },
    ]);
    const appList = evaluateShortcutIntercept(
      {
        conversationId: convId,
        transcriptPath: appTranscript,
        artifactDirectoryPath: join(root, '.gemini', 'antigravity', 'brain', convId),
        lastUserInput: '<USER_REQUEST>\n/prompt-suggestion\n</USER_REQUEST>',
      },
      { stateDir }
    );
    assert.equal(appList.terminationBehavior, 'terminate');
    assert.match(
      appList.injectSteps[0].systemMessage.metadata.user_markdown,
      /sidecar:\/\/prompt-suggestion\/suggestion_panel\//
    );

    // Natural language after /prompt-suggestion passes through
    const passThrough = evaluateShortcutIntercept(
      {
        conversationId: convId,
        transcriptPath: cliTranscript,
        lastUserInput: '<USER_REQUEST>\n/prompt-suggestion how does filtering work?\n</USER_REQUEST>',
      },
      { stateDir }
    );
    assert.deepEqual(passThrough, {});

    // :s 2 + extra expands prompt and does NOT terminate
    const accept2 = evaluateShortcutIntercept(
      {
        conversationId: convId,
        transcriptPath: cliTranscript,
        lastUserInput: '<USER_REQUEST>\n:s 2 + 重点看空值处理\n</USER_REQUEST>',
      },
      { stateDir }
    );
    assert.equal(accept2.terminationBehavior, undefined);
    assert.match(accept2.injectSteps[0].systemMessage.systemMessage, /重点看空值处理/);
    assert.match(accept2.injectSteps[0].systemMessage.metadata.user_markdown, /已采纳建议追问/);
    assert.equal(getPreferences(convId, { stateDir }).dismissedStepIndex, 3);

    // :s on / :s off / :s clear
    evaluateShortcutIntercept(
      { conversationId: convId, transcriptPath: cliTranscript, lastUserInput: ':s off' },
      { stateDir }
    );
    assert.equal(getPreferences(convId, { stateDir }).enabled, false);
    evaluateShortcutIntercept(
      { conversationId: convId, transcriptPath: cliTranscript, lastUserInput: ':s on' },
      { stateDir }
    );
    assert.equal(getPreferences(convId, { stateDir }).enabled, true);
    assert.equal(getPreferences(convId, { stateDir }).dismissedStepIndex, -1);

    // Mid-turn guard: PLANNER_RESPONSE already occurred after latest USER_INPUT and steps > initialNumSteps
    const midTranscript = join(root, 'mid-transcript.jsonl');
    writeJsonl(midTranscript, [
      { step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>\n:s\n</USER_REQUEST>' },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        tool_calls: [{ name: 'read_file', args: { Path: '"a.js"' } }],
      },
      { step_index: 2, type: 'GENERIC', content: 'file content' },
    ]);
    const midOut = evaluateShortcutIntercept(
      {
        conversationId: '22222222-2222-4222-8222-222222222222',
        transcriptPath: midTranscript,
        initialNumSteps: 1,
        lastUserInput: '<USER_REQUEST>\n:s\n</USER_REQUEST>',
      },
      { stateDir }
    );
    assert.deepEqual(midOut, {});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI statusLine: dimmed idle row, working suppression, NO_COLOR/TERM=dumb, upstream chaining (<50ms), and CJK box alignment', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ps-cli-'));
  try {
    const stateDir = join(root, 'state');
    const convId = '33333333-3333-4333-8333-333333333333';
    const transcriptPath = join(
      root,
      '.gemini',
      'antigravity-cli',
      'brain',
      convId,
      '.system_generated',
      'logs',
      'transcript.jsonl'
    );
    writeJsonl(transcriptPath, [
      { step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>\n更新逻辑\n</USER_REQUEST>' },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        model: 'gemini-pro-orchestrator',
        input_tokens: 12000,
        cache_read_tokens: 0,
        output_tokens: 200,
        tool_calls: [{ name: 'edit_file', args: { Path: '"src/index.mjs"' } }],
      },
      { step_index: 2, type: 'GENERIC', content: 'Edited src/index.mjs' },
      {
        step_index: 3,
        type: 'PLANNER_RESPONSE',
        model: 'gemini-pro-orchestrator',
        input_tokens: 2000,
        cache_read_tokens: 12000,
        output_tokens: 150,
        content: '已完成 `src/index.mjs` 修改。',
      },
    ]);

    const basePayload = {
      cwd: root,
      transcript_path: transcriptPath,
      state: 'idle',
      model: { id: 'gemini-pro-orchestrator', display_name: 'Orchestrator (Carbon)' },
      context_window: {
        context_window_size: 1048576,
        used_percentage: 1.4,
        total_input_tokens: 26000,
        total_output_tokens: 350,
      },
    };

    // Idle dimmed row with upstream context-usage chaining and latency < 50ms
    const t0 = performance.now();
    const chainedIdle = await renderStatusline(basePayload, {
      stateDir,
      upstreamCommand: CONTEXT_USAGE_STATUSLINE,
      useColor: true,
    });
    const elapsedMs = performance.now() - t0;
    assert.ok(elapsedMs < 50, `Expected < 50ms statusline render, got ${elapsedMs.toFixed(1)}ms`);

    const lines = chainedIdle.split('\n');
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^\x1b\[2m⇢ /);
    assert.match(lines[0], /\[:s 发送 · :s 2 · :s clear\]/);
    assert.match(lines[1], /Orchestrator \(Carbon\)/);

    // Working state hides suggestion row, keeps context-usage row
    const chainedWorking = await renderStatusline(
      { ...basePayload, state: 'working' },
      { stateDir, upstreamCommand: CONTEXT_USAGE_STATUSLINE, useColor: true }
    );
    assert.equal(chainedWorking.split('\n').length, 1);
    assert.ok(!chainedWorking.includes('⇢'));
    assert.match(chainedWorking, /Orchestrator \(Carbon\)/);

    // Dismissed or disabled hides suggestion row
    evaluateShortcutIntercept(
      { conversationId: convId, transcriptPath, lastUserInput: ':s clear' },
      { stateDir }
    );
    const afterDismiss = await renderStatusline(basePayload, {
      stateDir,
      upstreamCommand: 'none',
      useColor: true,
    });
    assert.equal(afterDismiss, '');

    evaluateShortcutIntercept(
      { conversationId: convId, transcriptPath, lastUserInput: ':s on' },
      { stateDir }
    );

    // Subprocess checks for NO_COLOR and TERM=dumb
    for (const extraEnv of [{ NO_COLOR: '1' }, { TERM: 'dumb' }]) {
      const sub = spawnSync('node', [join(PLUGIN_ROOT, 'bin', 'statusline.mjs')], {
        input: JSON.stringify(basePayload),
        encoding: 'utf8',
        env: {
          ...process.env,
          AGY_PROMPT_SUGGESTION_STATE_DIR: stateDir,
          AGY_PROMPT_SUGGESTION_UPSTREAM: 'none',
          ...extraEnv,
        },
      });
      assert.equal(sub.status, 0);
      assert.ok(!sub.stdout.includes('\x1b['), 'NO_COLOR/TERM=dumb must emit zero ANSI codes');
      assert.match(sub.stdout, /^⇢ /);
    }

    // Boxed panel CJK displayWidth alignment
    const analysis = suggestForTranscriptFile(transcriptPath, { conversationId: convId, cwd: root });
    const boxed = renderBoxedPanel(analysis, getPreferences(sessionKeyFor({ conversationId: convId }), { stateDir }), {
      width: 76,
    });
    const boxLines = boxed.split('\n');
    const widths = boxLines.map((l) => displayWidth(l));
    assert.ok(boxLines.length >= 6);
    assert.ok(widths.every((w) => w === widths[0]), `Mismatched box widths: ${widths.join(',')}`);

    const boxedList = renderBoxedList(
      [{ conversationId: convId, product: 'cli', topSuggestion: analysis.candidates[0].text }],
      { width: 76 }
    );
    const listWidths = boxedList.split('\n').map((l) => displayWidth(l));
    assert.ok(
      listWidths.every((w) => w === listWidths[0]),
      `Mismatched list box widths: ${listWidths.join(',')}`
    );

    // Subprocess CLI bin/suggest --file --json and --accept
    const suggestJson = spawnSync(
      'node',
      [join(PLUGIN_ROOT, 'bin', 'suggest'), '--file', transcriptPath, '--json'],
      {
        encoding: 'utf8',
        env: { ...process.env, AGY_PROMPT_SUGGESTION_STATE_DIR: stateDir },
      }
    );
    assert.equal(suggestJson.status, 0);
    const parsedCli = JSON.parse(suggestJson.stdout);
    assert.ok(parsedCli.analysis.candidates.length >= 1);

    const suggestAccept = spawnSync(
      'node',
      [join(PLUGIN_ROOT, 'bin', 'suggest'), '--file', transcriptPath, '--accept', '1'],
      {
        encoding: 'utf8',
        env: { ...process.env, AGY_PROMPT_SUGGESTION_STATE_DIR: stateDir },
      }
    );
    assert.equal(suggestAccept.status, 0);
    assert.equal(suggestAccept.stdout.trim(), parsedCli.analysis.candidates[0].text);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('sidecar: standalone HTTP endpoints, ETag caching, preferences POST, and CSS token isolation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ps-sidecar-'));
  const appData = join(root, '.gemini', 'antigravity');
  const stateDir = join(root, 'state');
  const convId = '44444444-4444-4444-8444-444444444444';
  const tPath = join(appData, 'brain', convId, '.system_generated', 'logs', 'transcript.jsonl');

  writeJsonl(tPath, [
    { step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>\n实现新模块\n</USER_REQUEST>' },
    {
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'write_file', args: { Path: '"src/new-mod.mjs"' } }],
    },
    { step_index: 2, type: 'GENERIC', content: 'Created src/new-mod.mjs' },
    { step_index: 3, type: 'PLANNER_RESPONSE', content: '已创建 `src/new-mod.mjs`。' },
  ]);

  process.env.AGY_QUIET_SIDECAR = '1';
  const app = await createSuggestionApp({
    port: 0,
    forceStandalone: true,
    dirs: [appData],
    stateDir,
    env: { ...process.env, HOME: root, AGY_PROMPT_SUGGESTION_STATE_DIR: stateDir },
  });

  try {
    await app.run();
    const base = `http://127.0.0.1:${app.getPort()}`;

    for (const path of ['/', '/global', '/preload.js']) {
      const res = await fetch(`${base}${path}`);
      assert.equal(res.status, 200);
      const body = await res.text();
      assert.ok(body.length > 0);
    }

    const cssRes = await fetch(`${base}/styles.css`);
    assert.equal(cssRes.status, 200);
    const css = await cssRes.text();
    assert.match(css, /color-scheme:/);
    assert.match(css, /--ps-/);
    assert.ok(!/--muted\s*:/.test(css), 'CSS must never define --muted');
    assert.ok(!/var\(--muted\)/.test(css), 'CSS must never read var(--muted)');

    const jsRes = await fetch(`${base}/app.js`);
    assert.equal(jsRes.status, 200);
    const js = await jsRes.text();
    assert.ok(!/['"]--muted['"]/.test(js), 'app.js must never reference bare --muted');

    const health = await (await fetch(`${base}/api/health`)).json();
    assert.equal(health.ok, true);
    assert.equal(health.mode, 'standalone');

    const first = await (await fetch(`${base}/api/suggestions?conversationId=${convId}`)).json();
    assert.equal(first.found, true);
    assert.ok(first.candidates.length >= 1);
    assert.ok(first.etag);

    const second = await (
      await fetch(`${base}/api/suggestions?conversationId=${convId}&etag=${encodeURIComponent(first.etag)}`)
    ).json();
    assert.equal(second.unchanged, true);
    assert.equal(second.etag, first.etag);

    const convs = await (await fetch(`${base}/api/conversations?limit=10`)).json();
    assert.equal(convs.conversations.length, 1);
    assert.equal(convs.conversations[0].conversationId, convId);

    const prefDisable = await (
      await fetch(`${base}/api/preferences`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: convId, action: 'disable' }),
      })
    ).json();
    assert.equal(prefDisable.ok, true);
    assert.equal(prefDisable.preferences.enabled, false);

    const prefEnable = await (
      await fetch(`${base}/api/preferences`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: convId, action: 'enable' }),
      })
    ).json();
    assert.equal(prefEnable.preferences.enabled, true);

    const prefDismiss = await (
      await fetch(`${base}/api/preferences`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: convId, action: 'dismiss' }),
      })
    ).json();
    assert.equal(prefDismiss.preferences.dismissedStepIndex, 3);

    const prefRestore = await (
      await fetch(`${base}/api/preferences`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: convId, action: 'restore' }),
      })
    ).json();
    assert.equal(prefRestore.preferences.dismissedStepIndex, -1);
  } finally {
    await app.close();
    delete process.env.AGY_QUIET_SIDECAR;
    rmSync(root, { recursive: true, force: true });
  }
});

test('install.sh: symlink, copy, upstream context-usage chaining/backup, and clean uninstall', () => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'ps-install-'));
  try {
    const env = { ...process.env, HOME: fakeHome };
    const cliDir = join(fakeHome, '.gemini', 'antigravity-cli');
    const pluginsDir = join(fakeHome, '.gemini', 'config', 'plugins');
    const settingsPath = join(cliDir, 'settings.json');
    const upstreamPath = join(cliDir, 'prompt-suggestion-upstream.json');
    const ctxPluginTarget = join(pluginsDir, 'context-usage');

    // Simulate pre-installed context-usage plugin and statusLine in settings.json
    mkdirSync(join(ctxPluginTarget, 'bin'), { recursive: true });
    writeFileSync(join(ctxPluginTarget, 'bin', 'statusline.mjs'), '#!/usr/bin/env node\n', 'utf8');
    mkdirSync(cliDir, { recursive: true });
    writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          theme: 'dark',
          statusLine: {
            type: 'command',
            command: '~/.gemini/config/plugins/context-usage/bin/statusline.mjs',
            enabled: true,
            padding: 0,
            stack_with_default: true,
          },
        },
        null,
        2
      ),
      'utf8'
    );

    // 1. Default symlink install
    const res1 = spawnSync('bash', [join(PLUGIN_ROOT, 'install.sh')], { env, encoding: 'utf8' });
    assert.equal(res1.status, 0, res1.stderr);

    const installedDir = join(pluginsDir, 'prompt-suggestion');
    assert.equal(lstatSync(installedDir).isSymbolicLink(), true);
    assert.equal(readlinkSync(installedDir), PLUGIN_ROOT);
    assert.equal(lstatSync(join(fakeHome, '.local', 'bin', 'agy-suggest')).isSymbolicLink(), true);
    assert.equal(existsSync(`${settingsPath}.bak`), true);
    assert.equal(existsSync(upstreamPath), true);

    const updatedSettings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    assert.equal(updatedSettings.theme, 'dark');
    assert.match(updatedSettings.statusLine.command, /prompt-suggestion\/bin\/statusline\.mjs$/);

    const upstreamCfg = JSON.parse(readFileSync(upstreamPath, 'utf8'));
    assert.match(upstreamCfg.command, /context-usage\/bin\/statusline\.mjs$/);

    // 2. Uninstall restores context-usage statusLine and removes upstream file
    const resUninstall = spawnSync('bash', [join(PLUGIN_ROOT, 'install.sh'), '--uninstall'], {
      env,
      encoding: 'utf8',
    });
    assert.equal(resUninstall.status, 0, resUninstall.stderr);
    assert.equal(existsSync(installedDir), false);
    assert.equal(existsSync(join(fakeHome, '.local', 'bin', 'agy-suggest')), false);
    assert.equal(existsSync(upstreamPath), false);

    const restoredSettings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    assert.equal(restoredSettings.theme, 'dark');
    assert.match(restoredSettings.statusLine.command, /context-usage\/bin\/statusline\.mjs$/);

    // 3. Copy mode install and clean uninstall without upstream
    rmSync(ctxPluginTarget, { recursive: true, force: true });
    writeFileSync(settingsPath, JSON.stringify({ theme: 'light' }), 'utf8');

    const resCopy = spawnSync('bash', [join(PLUGIN_ROOT, 'install.sh'), '--copy'], {
      env,
      encoding: 'utf8',
    });
    assert.equal(resCopy.status, 0, resCopy.stderr);
    assert.equal(lstatSync(installedDir).isSymbolicLink(), false);
    assert.equal(existsSync(join(installedDir, 'plugin.json')), true);
    assert.equal(existsSync(upstreamPath), false);

    const resCleanUninstall = spawnSync('bash', [join(PLUGIN_ROOT, 'install.sh'), '--uninstall'], {
      env,
      encoding: 'utf8',
    });
    assert.equal(resCleanUninstall.status, 0, resCleanUninstall.stderr);
    assert.equal(existsSync(installedDir), false);
    const cleanedSettings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    assert.equal(cleanedSettings.theme, 'light');
    assert.equal(cleanedSettings.statusLine, undefined);
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});
