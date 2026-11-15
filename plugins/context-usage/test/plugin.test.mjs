import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

import {
  DEFAULT_REMOTE_PRICING_URL,
  WEEKLY_PRICING_CACHE_TTL_MS,
  aggregateUsageStats,
  analyzeConversation,
  analyzeTranscriptFile,
  analyzeTranscriptText,
  calculateTurnCost,
  estimatePayloadCost,
  estimateTextTokens,
  formatCost,
  formatPct,
  formatTokens,
  getPricingCacheFilePath,
  getPricingSignature,
  loadRemotePricingCache,
  parseNewApiRatioConfig,
  parseTimeBound,
  resolveContextWindowSize,
  resolveModelPricing,
  resolveStatsTimeRange,
  syncRemotePricingCache,
} from '../sidecars/context_monitor/analyzer.mjs';
import { createMonitorApp } from '../sidecars/context_monitor/main.mjs';
import { displayWidth, renderBoxStatsPanel } from '../bin/context-panel.mjs';
import { evaluatePanelIntercept } from '../hooks/intercept-panel.mjs';
import { renderStatusline } from '../bin/statusline.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(__dirname, '..');

function writeJsonl(filePath, steps) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(
    filePath,
    steps.map((s) => JSON.stringify(s)).join('\n') + '\n',
    'utf8'
  );
}

test('analyzer: exact multi-turn token accounting, categories, and top consumers', () => {
  const steps = [
    {
      step_index: 0,
      type: 'USER_INPUT',
      created_at: '2026-11-15T10:00:00Z',
      content: '<USER_REQUEST>\nAnalyze the project architecture\n</USER_REQUEST>\n<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from None to Orchestrator (Carbon).\n</USER_SETTINGS_CHANGE>',
    },
    {
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-15T10:00:02Z',
      model: 'gemini-pro-orchestrator',
      input_tokens: 12000,
      cache_read_tokens: 0,
      output_tokens: 300,
      tool_calls: [
        { name: 'read_file', args: { Path: '"/workspace/README.md"' } },
      ],
    },
    {
      step_index: 2,
      type: 'GENERIC',
      created_at: '2026-11-15T10:00:03Z',
      content: 'Read file README.md: ' + 'hello world '.repeat(200),
    },
    {
      step_index: 3,
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-15T10:00:05Z',
      model: 'gemini-pro-orchestrator',
      input_tokens: 2500,
      cache_read_tokens: 12000,
      output_tokens: 500,
      tool_calls: [
        { name: 'run_command', args: { CommandLine: '"npm test"', toolSummary: '"Run tests"' } },
      ],
    },
    {
      step_index: 4,
      type: 'GENERIC',
      created_at: '2026-11-15T10:00:06Z',
      content: 'All 12 tests passed cleanly.',
    },
    {
      step_index: 5,
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-15T10:00:08Z',
      model: 'gemini-pro-orchestrator',
      input_tokens: 1000,
      cache_read_tokens: 14500,
      output_tokens: 200,
    },
  ];

  const jsonl = steps.map((s) => JSON.stringify(s)).join('\n') + '\n';
  const res = analyzeTranscriptText(jsonl);

  assert.equal(res.title, 'Analyze the project architecture');
  assert.equal(res.model, 'gemini-pro-orchestrator');
  assert.equal(res.modelLabel, 'Orchestrator (Carbon)');
  assert.equal(res.contextWindowSize, 1_048_576);

  // Last turn prompt = 15,500; output = 200; no trailing steps => active = 15,700
  assert.equal(res.activeContextTokens, 15700);
  const sumCats =
    res.categories.systemAndTools.tokens +
    res.categories.userInputs.tokens +
    res.categories.modelOutputs.tokens +
    res.categories.toolResults.tokens;
  assert.equal(sumCats, res.activeContextTokens);
  assert.ok(res.categories.systemAndTools.tokens > 11000);
  assert.ok(res.categories.toolResults.tokens >= 2000);
  assert.equal(res.categories.modelOutputs.tokens, 1000);

  assert.equal(res.sessionTotals.invocations, 3);
  assert.equal(res.sessionTotals.totalInputTokens, 12000 + 14500 + 15500);
  assert.equal(res.sessionTotals.cacheReadTokens, 12000 + 14500);
  assert.equal(res.sessionTotals.outputTokens, 1000);
  assert.ok(res.sessionTotals.cacheHitRate > 60);

  assert.equal(res.turns.length, 3);
  assert.equal(res.turns[1].deltaTokens, 14500 - (12000 + 300)); // 2200
  assert.equal(res.topConsumers[0].turnNumber, 2);
  assert.equal(res.topConsumers[0].deltaTokens, 2200);
  assert.match(res.topConsumers[0].label, /read_file README\.md/);
});

test('analyzer: handles compaction (<70% prompt drop) and window overrides', () => {
  assert.equal(resolveContextWindowSize('claude-sonnet-4', '', 0), 200_000);
  assert.equal(resolveContextWindowSize('gpt-4o', '', 0), 128_000);
  assert.equal(resolveContextWindowSize('gemini-pro', '', 500_000), 500_000);
  assert.ok(estimateTextTokens('你好世界test') > 0);
  assert.equal(formatTokens(26400), '26.4k');
  assert.equal(formatTokens(1048576), '1.05M');
  assert.equal(formatPct(2.5), '2.5%');

  const steps = [
    { step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>\nInitial task\n</USER_REQUEST>' },
    { step_index: 1, type: 'PLANNER_RESPONSE', model: 'claude-3-7', input_tokens: 150000, cache_read_tokens: 0, output_tokens: 2000 },
    { step_index: 2, type: 'USER_INPUT', content: '<USER_REQUEST>\n/compact\n</USER_REQUEST>' },
    { step_index: 3, type: 'PLANNER_RESPONSE', model: 'claude-3-7', input_tokens: 10000, cache_read_tokens: 15000, output_tokens: 500 },
  ];

  const res = analyzeTranscriptText(steps.map((s) => JSON.stringify(s)).join('\n'));
  assert.equal(res.contextWindowSize, 200_000);
  assert.equal(res.turns[1].compacted, true);
  assert.equal(res.activeContextTokens, 25500);
  const sumCats =
    res.categories.systemAndTools.tokens +
    res.categories.userInputs.tokens +
    res.categories.modelOutputs.tokens +
    res.categories.toolResults.tokens;
  assert.equal(sumCats, res.activeContextTokens);
});

test('analyzer: discovers swarm members and referenced subagents', () => {
  const root = mkdtempSync(join(tmpdir(), 'ctx-subagent-'));
  try {
    const appData = join(root, '.gemini', 'antigravity');
    const parentId = '11111111-1111-4111-8111-111111111111';
    const workerId = '22222222-2222-4222-8222-222222222222';
    const subId = '33333333-3333-4333-8333-333333333333';

    writeJsonl(join(appData, 'brain', parentId, '.system_generated', 'logs', 'transcript.jsonl'), [
      { step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>\nParent task\n</USER_REQUEST>' },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        model: 'gemini-pro-orchestrator',
        input_tokens: 10000,
        cache_read_tokens: 0,
        output_tokens: 100,
        content: `Spawned [research](conversation://${subId})`,
      },
    ]);

    mkdirSync(join(appData, 'brain', parentId, '.system_generated', 'swarm'), { recursive: true });
    writeFileSync(
      join(appData, 'brain', parentId, '.system_generated', 'swarm', 'members.json'),
      JSON.stringify({
        members: {
          auditor: { role: 'worker', conversation_id: workerId, killed: false },
        },
      }),
      'utf8'
    );

    writeJsonl(join(appData, 'brain', workerId, '.system_generated', 'logs', 'transcript.jsonl'), [
      { step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>\nAudit files\n</USER_REQUEST>' },
      { step_index: 1, type: 'PLANNER_RESPONSE', model: 'gemini-flash', input_tokens: 4000, cache_read_tokens: 0, output_tokens: 80 },
    ]);

    writeJsonl(join(appData, 'brain', subId, '.system_generated', 'logs', 'transcript.jsonl'), [
      { step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>\nResearch docs\n</USER_REQUEST>' },
      { step_index: 1, type: 'PLANNER_RESPONSE', model: 'gemini-flash', input_tokens: 3000, cache_read_tokens: 0, output_tokens: 50 },
    ]);

    const res = analyzeConversation(parentId, { dirs: [appData] });
    assert.equal(res.subagents.length, 2);
    assert.equal(res.subagentsTotals.count, 2);
    assert.equal(res.subagentsTotals.activeContextTokens, 4080 + 3050);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('bin/statusline.mjs: renders JSON payloads, >200k & critical warnings, and transcript fallback', () => {
  const root = mkdtempSync(join(tmpdir(), 'ctx-status-'));
  try {
    const tPath = join(root, 'transcript.jsonl');
    writeJsonl(tPath, [
      { step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>\nResumed session\n</USER_REQUEST>' },
      { step_index: 1, type: 'PLANNER_RESPONSE', model: 'gemini-pro', input_tokens: 20000, cache_read_tokens: 30000, output_tokens: 1000 },
    ]);

    const runStatus = (payload) =>
      spawnSync(process.execPath, [join(PLUGIN_ROOT, 'bin', 'statusline.mjs')], {
        input: typeof payload === 'string' ? payload : JSON.stringify(payload),
        encoding: 'utf8',
        env: { ...process.env, NO_COLOR: '1' },
      });

    // 1. Healthy payload with current_usage + cache
    const r1 = runStatus({
      cwd: '/workspace/my-repo',
      agent_state: 'working',
      model: { id: 'gemini-3.8-flash', display_name: 'Gemini 3.8 Flash', effort: 'high' },
      context_window: {
        context_window_size: 1_048_576,
        used_percentage: 4.5,
        total_input_tokens: 53100,
        total_output_tokens: 1400,
        current_usage: { input_tokens: 10000, cache_read_input_tokens: 36000, output_tokens: 1200 },
      },
      exceeds_200k_tokens: false,
    });
    assert.equal(r1.status, 0);
    assert.match(r1.stdout, /Gemini 3\.8 Flash·high/);
    assert.match(r1.stdout, /47\.2k\/1\.05M \(4\.5%\)/);
    assert.match(r1.stdout, /⚡78% cache/);
    assert.match(r1.stdout, /my-repo/);

    // 2. >200k and critical >=90% warning
    const r2 = runStatus({
      cwd: '/workspace/big',
      model: { display_name: 'Claude Sonnet' },
      context_window: {
        context_window_size: 200_000,
        used_percentage: 92,
        current_usage: { input_tokens: 184000, cache_read_input_tokens: 0, output_tokens: 0 },
      },
      exceeds_200k_tokens: true,
    });
    assert.equal(r2.status, 0);
    assert.match(r2.stdout, /⚠>200k/);
    assert.match(r2.stdout, /⚠\/compact/);

    // 3. Pre-turn null used_percentage fallback to transcript_path
    const r3 = runStatus({
      cwd: '/workspace/resumed',
      transcript_path: tPath,
      model: { display_name: 'Gemini Pro' },
      context_window: { context_window_size: 1_048_576, used_percentage: null },
    });
    assert.equal(r3.status, 0);
    assert.match(r3.stdout, /51k\/1\.05M/);
    assert.match(r3.stdout, /⚡60% cache/);

    // 4. Malformed stdin never fails
    const r4 = runStatus('{broken json');
    assert.equal(r4.status, 0);
    assert.match(r4.stdout, /Antigravity/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('bin/context-usage.mjs: supports --file --json, ANSI report, and --all', () => {
  const root = mkdtempSync(join(tmpdir(), 'ctx-cli-'));
  try {
    const appData = join(root, '.gemini', 'antigravity-cli');
    const convId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const tPath = join(appData, 'brain', convId, '.system_generated', 'logs', 'transcript.jsonl');
    writeJsonl(tPath, [
      { step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>\nInspect CLI output\n</USER_REQUEST>' },
      { step_index: 1, type: 'PLANNER_RESPONSE', model: 'gemini-pro', input_tokens: 15000, cache_read_tokens: 5000, output_tokens: 400 },
    ]);

    const rJson = spawnSync(
      process.execPath,
      [join(PLUGIN_ROOT, 'bin', 'context-usage.mjs'), '--file', tPath, '--json'],
      { encoding: 'utf8', env: { ...process.env, HOME: root, NO_COLOR: '1' } }
    );
    assert.equal(rJson.status, 0);
    const parsed = JSON.parse(rJson.stdout);
    assert.equal(parsed.activeContextTokens, 20400);
    assert.equal(parsed.title, 'Inspect CLI output');

    const rText = spawnSync(
      process.execPath,
      [join(PLUGIN_ROOT, 'bin', 'context-usage.mjs'), '--file', tPath],
      { encoding: 'utf8', env: { ...process.env, HOME: root, NO_COLOR: '1' } }
    );
    assert.equal(rText.status, 0);
    assert.match(rText.stdout, /Antigravity Context Usage Report/);
    assert.match(rText.stdout, /System & Tools/);

    const rAll = spawnSync(
      process.execPath,
      [join(PLUGIN_ROOT, 'bin', 'context-usage.mjs'), '--all'],
      { encoding: 'utf8', env: { ...process.env, HOME: root, NO_COLOR: '1' } }
    );
    assert.equal(rAll.status, 0);
    assert.match(rAll.stdout, /Recent Antigravity Conversations/);
    assert.match(rAll.stdout, /Inspect CLI output/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('hooks/check-context.mjs: silent <80%, alerts at 80% & 90% once, resets <70%', () => {
  const root = mkdtempSync(join(tmpdir(), 'ctx-hook-'));
  try {
    const pluginData = join(root, 'plugin_data');
    const tPath = join(root, 'transcript.jsonl');
    const convId = '44444444-4444-4444-8444-444444444444';

    const runHook = () => {
      const res = spawnSync(process.execPath, [join(PLUGIN_ROOT, 'hooks', 'check-context.mjs')], {
        input: JSON.stringify({
          conversationId: convId,
          transcriptPath: tPath,
          modelName: 'claude-sonnet-4',
          hookEventName: 'PostInvocation',
        }),
        encoding: 'utf8',
        env: { ...process.env, PLUGIN_DATA: pluginData },
      });
      assert.equal(res.status, 0);
      return JSON.parse(res.stdout);
    };

    // 1. 50% (<80%) => silent {}
    writeJsonl(tPath, [
      { step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>\nTest\n</USER_REQUEST>' },
      { step_index: 1, type: 'PLANNER_RESPONSE', model: 'claude-sonnet-4', input_tokens: 100000, output_tokens: 0 },
    ]);
    assert.deepEqual(runHook(), {});

    // 2. 82% => emits 80% warning with systemMessage: "" and user_markdown
    writeJsonl(tPath, [
      { step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>\nTest\n</USER_REQUEST>' },
      { step_index: 1, type: 'PLANNER_RESPONSE', model: 'claude-sonnet-4', input_tokens: 164000, output_tokens: 0 },
    ]);
    const alert80 = runHook();
    assert.equal(alert80.injectSteps[0].systemMessage.systemMessage, '');
    assert.match(alert80.injectSteps[0].systemMessage.metadata.user_markdown, /82%/);
    assert.match(alert80.injectSteps[0].systemMessage.metadata.user_markdown, /Est\. session cost:/);
    assert.match(alert80.injectSteps[0].systemMessage.metadata.user_markdown, /sidecar:\/\/context-usage\/context_monitor\//);

    // 3. Repeated turn at 85% => deduplicated {}
    writeJsonl(tPath, [
      { step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>\nTest\n</USER_REQUEST>' },
      { step_index: 1, type: 'PLANNER_RESPONSE', model: 'claude-sonnet-4', input_tokens: 170000, output_tokens: 0 },
    ]);
    assert.deepEqual(runHook(), {});

    // 4. Crosses 92% => emits 90% critical alert
    writeJsonl(tPath, [
      { step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>\nTest\n</USER_REQUEST>' },
      { step_index: 1, type: 'PLANNER_RESPONSE', model: 'claude-sonnet-4', input_tokens: 184000, output_tokens: 0 },
    ]);
    const alert90 = runHook();
    assert.match(alert90.injectSteps[0].systemMessage.metadata.user_markdown, /Critical Context Alert/);
    assert.match(alert90.injectSteps[0].systemMessage.metadata.user_markdown, /92%/);

    // 5. Compacted down to 30% (<70%) => resets tier silently {}
    writeJsonl(tPath, [
      { step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>\nTest\n</USER_REQUEST>' },
      { step_index: 1, type: 'PLANNER_RESPONSE', model: 'claude-sonnet-4', input_tokens: 184000, output_tokens: 0 },
      { step_index: 2, type: 'PLANNER_RESPONSE', model: 'claude-sonnet-4', input_tokens: 60000, output_tokens: 0 },
    ]);
    assert.deepEqual(runHook(), {});

    // 6. Grows back to 83% => alerts again because reset occurred
    writeJsonl(tPath, [
      { step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>\nTest\n</USER_REQUEST>' },
      { step_index: 1, type: 'PLANNER_RESPONSE', model: 'claude-sonnet-4', input_tokens: 166000, output_tokens: 0 },
    ]);
    const alertAgain = runHook();
    assert.match(alertAgain.injectSteps[0].systemMessage.metadata.user_markdown, /83%/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('sidecar HTTP server: serves UI assets and /api/context + /api/conversations with ETag', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ctx-sidecar-'));
  let app = null;
  try {
    const appData = join(root, '.gemini', 'antigravity');
    const convId = '55555555-5555-4555-8555-555555555555';
    writeJsonl(join(appData, 'brain', convId, '.system_generated', 'logs', 'transcript.jsonl'), [
      { step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>\nSidecar dashboard test\n</USER_REQUEST>' },
      { step_index: 1, type: 'PLANNER_RESPONSE', model: 'gemini-pro', input_tokens: 8000, cache_read_tokens: 4000, output_tokens: 250 },
    ]);

    app = await createMonitorApp({ standalone: true, port: 0, dirs: [appData] });
    const server = await app.run();
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;

    const htmlRes = await fetch(`${base}/`);
    assert.equal(htmlRes.status, 200);
    assert.match(await htmlRes.text(), /Context Usage/);

    const globalRes = await fetch(`${base}/global`);
    assert.equal(globalRes.status, 200);

    const preloadRes = await fetch(`${base}/preload.js`);
    assert.equal(preloadRes.status, 200);
    assert.match(await preloadRes.text(), /window\.sidecar/);

    const cssRes = await fetch(`${base}/styles.css`);
    assert.equal(cssRes.status, 200);

    const jsRes = await fetch(`${base}/app.js`);
    assert.equal(jsRes.status, 200);

    const ctx1 = await (await fetch(`${base}/api/context?conversationId=${convId}`)).json();
    assert.equal(ctx1.found, true);
    assert.equal(ctx1.activeContextTokens, 12250);
    assert.ok(ctx1.etag);

    const ctx2 = await (
      await fetch(`${base}/api/context?conversationId=${convId}&etag=${encodeURIComponent(ctx1.etag)}`)
    ).json();
    assert.equal(ctx2.unchanged, true);

    const list1 = await (await fetch(`${base}/api/conversations`)).json();
    assert.equal(list1.conversations.length, 1);
    assert.equal(list1.conversations[0].conversationId, convId);

    const list2 = await (
      await fetch(`${base}/api/conversations?etag=${encodeURIComponent(list1.etag)}`)
    ).json();
    assert.equal(list2.unchanged, true);
  } finally {
    if (app) await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('install.sh: installs symlink & copy cleanly and uninstalls in isolated HOME', () => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'ctx-install-'));
  try {
    const cliDir = join(fakeHome, '.gemini', 'antigravity-cli');
    mkdirSync(cliDir, { recursive: true });
    writeFileSync(
      join(cliDir, 'settings.json'),
      JSON.stringify({ theme: 'dark', autoApprove: false }, null, 2),
      'utf8'
    );

    // 1. Default symlink install
    const r1 = spawnSync('bash', [join(PLUGIN_ROOT, 'install.sh')], {
      encoding: 'utf8',
      env: { ...process.env, HOME: fakeHome },
    });
    assert.equal(r1.status, 0, r1.stderr);

    const installedPlugin = join(fakeHome, '.gemini', 'config', 'plugins', 'context-usage');
    assert.equal(lstatSync(installedPlugin).isSymbolicLink(), true);

    const settings1 = JSON.parse(readFileSync(join(cliDir, 'settings.json'), 'utf8'));
    assert.equal(settings1.theme, 'dark');
    assert.equal(settings1.statusLine.command, '~/.gemini/config/plugins/context-usage/bin/statusline.mjs');
    assert.equal(settings1.statusLine.enabled, true);
    assert.equal(existsSync(join(cliDir, 'settings.json.bak')), true);

    // 2. Copy install
    const r2 = spawnSync('bash', [join(PLUGIN_ROOT, 'install.sh'), '--copy'], {
      encoding: 'utf8',
      env: { ...process.env, HOME: fakeHome },
    });
    assert.equal(r2.status, 0, r2.stderr);
    assert.equal(lstatSync(installedPlugin).isSymbolicLink(), false);
    assert.equal(existsSync(join(installedPlugin, 'plugin.json')), true);

    // 3. Uninstall
    const r3 = spawnSync('bash', [join(PLUGIN_ROOT, 'install.sh'), '--uninstall'], {
      encoding: 'utf8',
      env: { ...process.env, HOME: fakeHome },
    });
    assert.equal(r3.status, 0, r3.stderr);
    assert.equal(existsSync(installedPlugin), false);

    const settingsAfter = JSON.parse(readFileSync(join(cliDir, 'settings.json'), 'utf8'));
    assert.equal(settingsAfter.theme, 'dark');
    assert.equal(settingsAfter.statusLine, undefined);
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('sidecars/context_monitor: dark mode tokens avoid host --muted collision and support color-scheme', () => {
  const css = readFileSync(join(PLUGIN_ROOT, 'sidecars', 'context_monitor', 'styles.css'), 'utf8');
  const appJs = readFileSync(join(PLUGIN_ROOT, 'sidecars', 'context_monitor', 'app.js'), 'utf8');

  assert.doesNotMatch(css, /--muted\s*:/);
  assert.doesNotMatch(css, /var\(--muted\s*[,)]/);
  assert.doesNotMatch(appJs, /var\(--muted\s*[,)]/);

  assert.match(css, /color-scheme:\s*dark;/);
  assert.match(css, /--ctx-fg-muted\s*:/);
  assert.match(appJs, /mutedContrast/);
  assert.match(appJs, /var\(--ctx-fg-muted\)/);
});

test('analyzer & cli: tracks Orchestrator dual-model switches and per-model token consumption', () => {
  const cliSteps = [
    {
      step_index: 0,
      type: 'USER_INPUT',
      content:
        '<USER_REQUEST>\nImplement feature\n</USER_REQUEST>\n<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from None to Orchestrator (Carbon).\n</USER_SETTINGS_CHANGE>',
    },
    {
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      model: 'gemini-pro-orchestrator',
      input_tokens: 10000,
      cache_read_tokens: 0,
      output_tokens: 400,
      tool_calls: [{ name: 'read_file', args: { Path: '"/workspace/a.js"' } }],
    },
    { step_index: 2, type: 'GENERIC', content: 'File content of a.js' },
    {
      step_index: 3,
      type: 'PLANNER_RESPONSE',
      model: 'gemini-pro-orchestrator',
      input_tokens: 2000,
      cache_read_tokens: 10000,
      output_tokens: 600,
      tool_calls: [{ name: 'exit_plan_mode', args: { plan: 'Plan ready' } }],
    },
    {
      step_index: 4,
      type: 'PLANNER_RESPONSE',
      model: 'gemini-flash-worker-agy',
      input_tokens: 13000,
      cache_read_tokens: 0,
      output_tokens: 500,
      tool_calls: [{ name: 'edit_file', args: { Path: '"/workspace/a.js"' } }],
    },
    { step_index: 5, type: 'USER_INPUT', content: '<USER_REQUEST>\nReview changes\n</USER_REQUEST>' },
    {
      step_index: 6,
      type: 'PLANNER_RESPONSE',
      model: 'gemini-pro-orchestrator',
      input_tokens: 14000,
      cache_read_tokens: 0,
      output_tokens: 300,
    },
  ];

  const jsonl = cliSteps.map((s) => JSON.stringify(s)).join('\n') + '\n';
  const res = analyzeTranscriptText(jsonl);

  assert.equal(res.modelBreakdown.isOrchestrator, true);
  assert.equal(res.modelBreakdown.isMultiModel, true);
  assert.equal(res.modelBreakdown.switchCount, 2);
  assert.equal(res.modelBreakdown.activeRole, 'planner');
  assert.equal(res.modelBreakdown.activeTag, 'PLAN');

  assert.equal(res.turns[0].modelRole, 'planner');
  assert.equal(res.turns[1].modelRole, 'planner');
  assert.equal(res.turns[2].modelRole, 'worker');
  assert.equal(res.turns[2].modelTag, 'EXEC');
  assert.equal(res.turns[2].modelSwitched, true);
  assert.equal(res.turns[3].modelRole, 'planner');
  assert.equal(res.turns[3].modelTag, 'PLAN');
  assert.equal(res.turns[3].modelSwitched, true);

  const planner = res.modelBreakdown.models.find((m) => m.role === 'planner');
  const worker = res.modelBreakdown.models.find((m) => m.role === 'worker');
  assert.ok(planner && worker);
  assert.equal(planner.invocations, 3);
  assert.equal(planner.totalInputTokens, 10000 + 12000 + 14000);
  assert.equal(planner.cacheReadTokens, 10000);
  assert.equal(planner.outputTokens, 1300);

  assert.equal(worker.invocations, 1);
  assert.equal(worker.totalInputTokens, 13000);
  assert.equal(worker.cacheReadTokens, 0);
  assert.equal(worker.outputTokens, 500);

  assert.equal(
    planner.totalInputTokens + worker.totalInputTokens,
    res.sessionTotals.totalInputTokens
  );
  assert.equal(planner.outputTokens + worker.outputTokens, res.sessionTotals.outputTokens);

  // App-style transcript without PLANNER_RESPONSE.model and with literal "[plan review]" inside GENERIC tool output
  const appSteps = [
    {
      step_index: 0,
      type: 'USER_INPUT',
      content:
        '<USER_REQUEST>\nApp orchestrator test\n</USER_REQUEST>\n<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from None to Orchestrator (Carbon).\n</USER_SETTINGS_CHANGE>',
    },
    {
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      input_tokens: 9000,
      cache_read_tokens: 0,
      output_tokens: 300,
      tool_calls: [{ name: 'exit_plan_mode', args: { plan: 'Execute' } }],
    },
    {
      step_index: 2,
      type: 'GENERIC',
      source: 'MODEL',
      content: 'Read file content containing literal "[plan review]" marker text in source code.',
    },
    {
      step_index: 3,
      type: 'PLANNER_RESPONSE',
      input_tokens: 11000,
      cache_read_tokens: 0,
      output_tokens: 400,
      tool_calls: [{ name: 'edit_file', args: { Path: '"/workspace/app.js"' } }],
    },
    {
      step_index: 4,
      type: 'SYSTEM_MESSAGE',
      source: 'SYSTEM',
      content: '[plan review] Checkpoint reached; handing back to planner.',
    },
    {
      step_index: 5,
      type: 'PLANNER_RESPONSE',
      input_tokens: 12500,
      cache_read_tokens: 0,
      output_tokens: 250,
    },
  ];

  const appRes = analyzeTranscriptText(appSteps.map((s) => JSON.stringify(s)).join('\n') + '\n');
  assert.deepEqual(
    appRes.turns.map((t) => t.modelRole),
    ['planner', 'worker', 'planner']
  );
  assert.equal(appRes.modelBreakdown.switchCount, 2);

  // CLI report rendering on Orchestrator session
  const root = mkdtempSync(join(tmpdir(), 'ctx-orch-cli-'));
  try {
    const tPath = join(root, 'transcript.jsonl');
    writeJsonl(tPath, cliSteps);
    const cliRun = spawnSync(
      process.execPath,
      [join(PLUGIN_ROOT, 'bin', 'context-usage.mjs'), '--file', tPath],
      { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } }
    );
    assert.equal(cliRun.status, 0, cliRun.stderr);
    assert.match(cliRun.stdout, /Orchestrator Dual-Model Breakdown/);
    assert.match(cliRun.stdout, /2 phase switches/);
    assert.match(cliRun.stdout, /Planner \(gemini-pro-orchestrator\)/);
    assert.match(cliRun.stdout, /Worker\s*\(gemini-flash-worker-agy\)/);
    assert.match(cliRun.stdout, /\[PLAN\]/);
    assert.match(cliRun.stdout, /\[EXEC\]⇄/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('bin/ctx: renders CJK-aligned Unicode boxed panel and multi-session table in non-TTY mode', () => {
  const root = mkdtempSync(join(tmpdir(), 'ctx-box-'));
  try {
    const appData = join(root, '.gemini', 'antigravity-cli');
    const convId = '44444444-5555-4666-8777-888888888888';
    const tPath = join(appData, 'brain', convId, '.system_generated', 'logs', 'transcript.jsonl');
    writeJsonl(tPath, [
      {
        step_index: 0,
        type: 'USER_INPUT',
        content:
          '<USER_REQUEST>\n中文标题：测试 Orchestrator 上下文面板对齐\n</USER_REQUEST>\n<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from None to Orchestrator (Carbon).\n</USER_SETTINGS_CHANGE>',
      },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        model: 'gemini-pro-orchestrator',
        input_tokens: 15000,
        cache_read_tokens: 0,
        output_tokens: 300,
        tool_calls: [{ name: 'exit_plan_mode', args: { plan: 'Go' } }],
      },
      {
        step_index: 2,
        type: 'PLANNER_RESPONSE',
        model: 'gemini-flash-worker-agy',
        input_tokens: 16000,
        cache_read_tokens: 0,
        output_tokens: 450,
        tool_calls: [{ name: 'edit_file', args: { Path: '"/tmp/中文文件.js"' } }],
      },
    ]);

    const boxRun = spawnSync(process.execPath, [join(PLUGIN_ROOT, 'bin', 'ctx'), '--file', tPath], {
      encoding: 'utf8',
      env: { ...process.env, HOME: root, NO_COLOR: '1' },
    });
    assert.equal(boxRun.status, 0, boxRun.stderr);
    assert.match(boxRun.stdout, /╭/);
    assert.match(boxRun.stdout, /╮/);
    assert.match(boxRun.stdout, /╰/);
    assert.match(boxRun.stdout, /╯/);
    assert.match(boxRun.stdout, /Orchestrator/);
    assert.match(boxRun.stdout, /Planner/);
    assert.match(boxRun.stdout, /Worker/);
    assert.match(boxRun.stdout, /\[PLAN\]/);
    assert.match(boxRun.stdout, /\[EXEC\]⇄/);

    const boxLines = boxRun.stdout
      .trimEnd()
      .split('\n')
      .filter((l) => /^[╭├│╰]/.test(l));
    assert.ok(boxLines.length >= 10);
    const expectedWidth = displayWidth(boxLines[0]);
    for (const line of boxLines) {
      assert.equal(displayWidth(line), expectedWidth, `Width mismatch on line: ${line}`);
    }

    const listRun = spawnSync(process.execPath, [join(PLUGIN_ROOT, 'bin', 'ctx'), '--all'], {
      encoding: 'utf8',
      env: { ...process.env, HOME: root, ANTIGRAVITY_APP_DATA_DIR: '', NO_COLOR: '1' },
    });
    assert.equal(listRun.status, 0, listRun.stderr);
    assert.match(listRun.stdout, /44444444/);
    assert.match(listRun.stdout, /中文标题/);
    const listBoxLines = listRun.stdout
      .trimEnd()
      .split('\n')
      .filter((l) => /^[╭├│╰]/.test(l));
    const expectedListWidth = displayWidth(listBoxLines[0]);
    for (const line of listBoxLines) {
      assert.equal(displayWidth(line), expectedListWidth, `List width mismatch on line: ${line}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('hooks/intercept-panel.mjs: intercepts bare panel commands with zero tokens and passes through questions', () => {
  const root = mkdtempSync(join(tmpdir(), 'ctx-hook-panel-'));
  try {
    const cliAppData = join(root, '.gemini', 'antigravity-cli');
    const appAppData = join(root, '.gemini', 'antigravity');
    const convCli = '55555555-6666-4777-8888-999999999999';
    const convApp = '66666666-7777-4888-9999-aaaaaaaaaaaa';

    const baseSteps = [
      {
        step_index: 0,
        type: 'USER_INPUT',
        content:
          '<USER_REQUEST>\nInitial request\n</USER_REQUEST>\n<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from None to Orchestrator (Carbon).\n</USER_SETTINGS_CHANGE>',
      },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        model: 'gemini-pro-orchestrator',
        input_tokens: 18000,
        cache_read_tokens: 0,
        output_tokens: 400,
        tool_calls: [{ name: 'exit_plan_mode', args: { plan: 'Execute' } }],
      },
      {
        step_index: 2,
        type: 'PLANNER_RESPONSE',
        model: 'gemini-flash-worker-agy',
        input_tokens: 2000,
        cache_read_tokens: 18000,
        output_tokens: 500,
      },
    ];

    const cliTranscript = join(cliAppData, 'brain', convCli, '.system_generated', 'logs', 'transcript.jsonl');
    writeJsonl(cliTranscript, [
      ...baseSteps,
      { step_index: 3, type: 'USER_INPUT', content: '<USER_REQUEST>\n/context-usage:context-usage\n</USER_REQUEST>' },
    ]);

    const resSlashCli = evaluatePanelIntercept(
      { conversationId: convCli, transcriptPath: cliTranscript, lastUserInput: '/context-usage:context-usage' },
      { dirs: [cliAppData, appAppData] }
    );
    assert.equal(resSlashCli.terminationBehavior, 'terminate');
    assert.equal(resSlashCli.injectSteps[0].systemMessage.systemMessage, '');
    const mdCli = resSlashCli.injectSteps[0].systemMessage.metadata.user_markdown;
    assert.match(mdCli, /Category/);
    assert.match(mdCli, /Orchestrator Dual-Model Breakdown/);
    assert.doesNotMatch(mdCli, /sidecar:\/\//);

    // :ctx on App transcript keeps clickable sidecar:// pill
    const appTranscript = join(appAppData, 'brain', convApp, '.system_generated', 'logs', 'transcript.jsonl');
    writeJsonl(appTranscript, [
      ...baseSteps,
      { step_index: 3, type: 'USER_INPUT', content: '<USER_REQUEST>\n:ctx\n</USER_REQUEST>' },
    ]);
    const resCtxApp = evaluatePanelIntercept(
      { conversationId: convApp, transcriptPath: appTranscript, lastUserInput: ':ctx' },
      { dirs: [cliAppData, appAppData] }
    );
    assert.equal(resCtxApp.terminationBehavior, 'terminate');
    assert.match(
      resCtxApp.injectSteps[0].systemMessage.metadata.user_markdown,
      /sidecar:\/\/context-usage\/context_monitor\//
    );

    // :ctx all lists sessions via hook stdin
    writeJsonl(cliTranscript, [
      ...baseSteps,
      { step_index: 3, type: 'USER_INPUT', content: '<USER_REQUEST>\n:ctx all\n</USER_REQUEST>' },
    ]);
    const hookRun = spawnSync(process.execPath, [join(PLUGIN_ROOT, 'hooks', 'intercept-panel.mjs')], {
      input: JSON.stringify({ conversationId: convCli, transcriptPath: cliTranscript, lastUserInput: ':ctx all' }),
      encoding: 'utf8',
      env: { ...process.env, HOME: root },
    });
    assert.equal(hookRun.status, 0, hookRun.stderr);
    const parsedHookOut = JSON.parse(hookRun.stdout);
    assert.equal(parsedHookOut.terminationBehavior, 'terminate');
    assert.match(parsedHookOut.injectSteps[0].systemMessage.metadata.user_markdown, /会话上下文总览/);

    // Pass-through guards:
    // 1. Normal user prompt
    writeJsonl(cliTranscript, [
      ...baseSteps,
      { step_index: 3, type: 'USER_INPUT', content: '<USER_REQUEST>\n编写单元测试\n</USER_REQUEST>' },
    ]);
    assert.deepEqual(
      evaluatePanelIntercept({ conversationId: convCli, transcriptPath: cliTranscript, lastUserInput: '编写单元测试' }),
      {}
    );

    // 2. Slash command with natural-language question
    writeJsonl(cliTranscript, [
      ...baseSteps,
      {
        step_index: 3,
        type: 'USER_INPUT',
        content: '<USER_REQUEST>\n/context-usage:context-usage 为什么第2轮增长最多\n</USER_REQUEST>',
      },
    ]);
    assert.deepEqual(
      evaluatePanelIntercept({
        conversationId: convCli,
        transcriptPath: cliTranscript,
        lastUserInput: '/context-usage:context-usage 为什么第2轮增长最多',
      }),
      {}
    );

    // 3. Mid-turn PreInvocation after PLANNER_RESPONSE already followed :ctx
    writeJsonl(cliTranscript, [
      ...baseSteps,
      { step_index: 3, type: 'USER_INPUT', content: '<USER_REQUEST>\n:ctx\n</USER_REQUEST>' },
      { step_index: 4, type: 'PLANNER_RESPONSE', model: 'gemini-pro-orchestrator', input_tokens: 21000, output_tokens: 50 },
    ]);
    assert.deepEqual(
      evaluatePanelIntercept({ conversationId: convCli, transcriptPath: cliTranscript, lastUserInput: ':ctx' }),
      {}
    );
    assert.deepEqual(
      evaluatePanelIntercept({
        conversationId: convCli,
        transcriptPath: cliTranscript,
        lastUserInput: ':ctx',
        initialNumSteps: 4,
      }),
      {}
    );

    // 4. Fresh turn starting at initialNumSteps=5 before transcript flushes the new :ctx USER_INPUT
    const resFreshAfterCtx = evaluatePanelIntercept(
      {
        conversationId: convCli,
        transcriptPath: cliTranscript,
        lastUserInput: '<USER_REQUEST>\n:ctx\n</USER_REQUEST>',
        initialNumSteps: 5,
      },
      { dirs: [cliAppData, appAppData] }
    );
    assert.equal(resFreshAfterCtx.terminationBehavior, 'terminate');
    assert.match(resFreshAfterCtx.injectSteps[0].systemMessage.metadata.user_markdown, /Category/);

    // 5. Brand-new Turn #1 before transcript.jsonl or brain/<convId> exists on disk
    const freshConvId = '77777777-8888-4999-aaaa-bbbbbbbbbbbb';
    const freshTranscript = join(cliAppData, 'brain', freshConvId, '.system_generated', 'logs', 'transcript.jsonl');
    const resBrandNewTurn1 = evaluatePanelIntercept(
      {
        conversationId: freshConvId,
        transcriptPath: freshTranscript,
        modelName: 'gemini-pro-orchestrator',
        lastUserInput:
          '<USER_REQUEST>\n:ctx\n</USER_REQUEST>\n<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from None to Orchestrator (Carbon).\n</USER_SETTINGS_CHANGE>',
      },
      { dirs: [cliAppData, appAppData] }
    );
    assert.equal(resBrandNewTurn1.terminationBehavior, 'terminate');
    const mdTurn1 = resBrandNewTurn1.injectSteps[0].systemMessage.metadata.user_markdown;
    assert.match(mdTurn1, /Orchestrator \(Carbon\)/);
    assert.match(mdTurn1, /新会话首轮/);
    assert.doesNotMatch(mdTurn1, /sidecar:\/\//);

    // 6. Unflushed Turn #2+ USER_INPUT when transcript.jsonl still ends with previous turn's PLANNER_RESPONSE
    writeJsonl(cliTranscript, baseSteps);
    const resUnflushedTurn2 = evaluatePanelIntercept(
      {
        conversationId: convCli,
        transcriptPath: cliTranscript,
        lastUserInput: '<USER_REQUEST>\n:ctx\n</USER_REQUEST>',
      },
      { dirs: [cliAppData, appAppData] }
    );
    assert.equal(resUnflushedTurn2.terminationBehavior, 'terminate');
    const mdUnflushed = resUnflushedTurn2.injectSteps[0].systemMessage.metadata.user_markdown;
    assert.match(mdUnflushed, /20k/);
    assert.match(mdUnflushed, /Orchestrator Dual-Model Breakdown/);

    // 7. Missing --conv target still terminates with an inline warning rather than leaking to LLM
    const resMissingConv = evaluatePanelIntercept(
      {
        conversationId: convCli,
        transcriptPath: cliTranscript,
        lastUserInput: ':ctx --conv deadbeef-0000-4000-8000-000000000000',
      },
      { dirs: [cliAppData, appAppData] }
    );
    assert.equal(resMissingConv.terminationBehavior, 'terminate');
    assert.match(resMissingConv.injectSteps[0].systemMessage.metadata.user_markdown, /未找到会话/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('bin/statusline-detail: renders 2-line detailed breakdown with Orchestrator stats', () => {
  const root = mkdtempSync(join(tmpdir(), 'ctx-detail-sl-'));
  try {
    const tPath = join(root, 'transcript.jsonl');
    writeJsonl(tPath, [
      {
        step_index: 0,
        type: 'USER_INPUT',
        content:
          '<USER_REQUEST>\nDetail statusline\n</USER_REQUEST>\n<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from None to Orchestrator (Carbon).\n</USER_SETTINGS_CHANGE>',
      },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        model: 'gemini-pro-orchestrator',
        input_tokens: 12000,
        cache_read_tokens: 0,
        output_tokens: 300,
        tool_calls: [{ name: 'exit_plan_mode', args: { plan: 'Go' } }],
      },
      {
        step_index: 2,
        type: 'PLANNER_RESPONSE',
        model: 'gemini-flash-worker-agy',
        input_tokens: 3000,
        cache_read_tokens: 12000,
        output_tokens: 400,
      },
    ]);

    const payload = {
      cwd: '/workspace/demo',
      transcript_path: tPath,
      model: { id: 'gemini-flash-worker-agy', display_name: 'Orchestrator (Carbon)' },
      context_window: {
        context_window_size: 1_048_576,
        used_percentage: 1.5,
        current_usage: { input_tokens: 3000, cache_read_input_tokens: 12000, output_tokens: 400 },
      },
    };

    const inlineOut = renderStatusline(payload, { detail: true });
    const inlineLines = inlineOut.split('\n');
    assert.equal(inlineLines.length, 2);
    assert.match(inlineLines[0], /Orchestrator \(Carbon\) \[EXEC\]/);
    assert.match(inlineLines[1], /Sys .*Usr .*Mod .*Tool/);
    assert.match(inlineLines[1], /◆Plan 1t .*▸Exec 1t .*⇄1/);

    const binRun = spawnSync(process.execPath, [join(PLUGIN_ROOT, 'bin', 'statusline-detail')], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1' },
    });
    assert.equal(binRun.status, 0, binRun.stderr);
    const outLines = binRun.stdout.trimEnd().split('\n');
    assert.equal(outLines.length, 2);
    assert.match(outLines[1], /Sys .*Usr .*Mod .*Tool/);
    assert.match(outLines[1], /◆Plan 1t .*▸Exec 1t/);
    assert.match(outLines[1], /Cost \$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('pricing & analyzer: exact per-turn USD cost, >200k tier doubling, cache savings, Orchestrator, subagents & overrides', () => {
  // formatCost formatting boundaries
  assert.equal(formatCost(0), '$0.00');
  assert.equal(formatCost(-1), '$0.00');
  assert.equal(formatCost(NaN), '$0.00');
  assert.equal(formatCost(0.00005), '<$0.0001');
  assert.equal(formatCost(0.0042), '$0.0042');
  assert.equal(formatCost(0.042), '$0.042');
  assert.equal(formatCost(1.236), '$1.24');
  assert.equal(formatCost(0.0004, { compact: true }), '<$0.001');
  assert.equal(formatCost(0.042, { compact: true }), '$0.042');
  assert.equal(formatCost(12.345, { compact: true }), '$12.35');
  assert.equal(formatCost(123.45, { compact: true }), '$123.5');

  // >200k long-context tier doubling on Gemini 3/4 Carbon Pro
  const proPricing = resolveModelPricing({ rawModel: 'gemini-pro-orchestrator' });
  assert.equal(proPricing.pricingId, 'gemini-4-carbon');
  const normalTurn = calculateTurnCost(
    { freshInputTokens: 100_000, cacheReadTokens: 50_000, outputTokens: 10_000, promptTokens: 150_000 },
    proPricing
  );
  assert.equal(normalTurn.longContextTier, false);
  // 0.1M * 2 + 0.05M * 0.2 + 0.01M * 12 = 0.2 + 0.01 + 0.12 = 0.33
  assert.equal(normalTurn.totalCostUsd, 0.33);
  // Uncached equiv: 0.15M * 2 + 0.12 = 0.42 => saved 0.09
  assert.equal(normalTurn.cacheSavingsUsd, 0.09);

  const longTurn = calculateTurnCost(
    { freshInputTokens: 100_000, cacheReadTokens: 150_000, outputTokens: 10_000, promptTokens: 250_000 },
    proPricing
  );
  assert.equal(longTurn.longContextTier, true);
  // >200k rates: 4.0 / 18.0 / 0.4 => 0.1*4 + 0.15*0.4 + 0.01*18 = 0.4 + 0.06 + 0.18 = 0.64
  assert.equal(longTurn.totalCostUsd, 0.64);
  // Uncached equiv: 0.25*4 + 0.18 = 1.18 => saved 0.54
  assert.equal(longTurn.cacheSavingsUsd, 0.54);

  // Claude Sonnet 4 cache_creation_input_tokens + cache_read_tokens
  const claudeSteps = [
    { step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>\nClaude cache write test\n</USER_REQUEST>' },
    {
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      model: 'claude-sonnet-4',
      input_tokens: 10_000,
      cache_creation_input_tokens: 100_000,
      cache_read_tokens: 100_000,
      output_tokens: 2_000,
    },
  ];
  // prompt = 210_000 (>200k tier for claude-sonnet-4: in=6, write=7.5, read=0.6, out=22.5)
  // 0.01*6 + 0.1*7.5 + 0.1*0.6 + 0.002*22.5 = 0.06 + 0.75 + 0.06 + 0.045 = 0.915
  const claudeRes = analyzeTranscriptText(claudeSteps.map((s) => JSON.stringify(s)).join('\n'));
  assert.equal(claudeRes.turns[0].pricingModel, 'claude-sonnet-4');
  assert.equal(claudeRes.turns[0].longContextTier, true);
  assert.equal(claudeRes.cost.totalCostUsd, 0.915);
  assert.equal(claudeRes.cost.longContextTurns, 1);

  // Orchestrator CLI (explicit worker rawModel) vs App-mode (omitted worker rawModel)
  const orchCliRes = analyzeTranscriptText(
    [
      {
        step_index: 0,
        type: 'USER_INPUT',
        content:
          '<USER_REQUEST>\nDual cost\n</USER_REQUEST>\n<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from None to Orchestrator (Carbon).\n</USER_SETTINGS_CHANGE>',
      },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        model: 'gemini-pro-orchestrator',
        input_tokens: 100_000,
        cache_read_tokens: 0,
        output_tokens: 10_000,
        tool_calls: [{ name: 'exit_plan_mode', args: { plan: 'Go' } }],
      },
      {
        step_index: 2,
        type: 'PLANNER_RESPONSE',
        model: 'gemini-flash-worker-agy',
        input_tokens: 100_000,
        cache_read_tokens: 100_000,
        output_tokens: 10_000,
      },
    ]
      .map((s) => JSON.stringify(s))
      .join('\n')
  );
  // Planner: 0.1*2 + 0.01*12 = 0.32
  // Worker (gemini-3.8-flash): 0.1*0.75 + 0.1*0.075 + 0.01*3.75 = 0.075 + 0.0075 + 0.0375 = 0.12
  assert.equal(orchCliRes.turns[0].pricingModel, 'gemini-4-carbon');
  assert.equal(orchCliRes.turns[1].pricingModel, 'gemini-3.8-flash');
  assert.equal(orchCliRes.cost.totalCostUsd, 0.44);
  const pStats = orchCliRes.modelBreakdown.models.find((m) => m.role === 'planner');
  const wStats = orchCliRes.modelBreakdown.models.find((m) => m.role === 'worker');
  assert.equal(pStats.costUsd, 0.32);
  assert.equal(wStats.costUsd, 0.12);

  const orchAppRes = analyzeTranscriptText(
    [
      {
        step_index: 0,
        type: 'USER_INPUT',
        content:
          '<USER_REQUEST>\nApp dual cost\n</USER_REQUEST>\n<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from None to Orchestrator (Carbon).\n</USER_SETTINGS_CHANGE>',
      },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        input_tokens: 100_000,
        cache_read_tokens: 0,
        output_tokens: 10_000,
        tool_calls: [{ name: 'exit_plan_mode', args: { plan: 'Go' } }],
      },
      {
        step_index: 2,
        type: 'PLANNER_RESPONSE',
        input_tokens: 100_000,
        cache_read_tokens: 100_000,
        output_tokens: 10_000,
      },
    ]
      .map((s) => JSON.stringify(s))
      .join('\n')
  );
  assert.equal(orchAppRes.turns[0].pricingModel, 'gemini-4-carbon');
  assert.equal(orchAppRes.turns[1].pricingModel, 'gemini-3.8-flash');
  assert.equal(orchAppRes.cost.totalCostUsd, 0.44);

  // Subagent combined cost + custom pricing overrides (opts.pricing, AGY_CTX_PRICING_JSON, AGY_CTX_PRICING_FILE)
  const root = mkdtempSync(join(tmpdir(), 'ctx-cost-'));
  try {
    const appData = join(root, '.gemini', 'antigravity');
    const parentId = '88888888-1111-4111-8111-111111111111';
    const childId = '99999999-2222-4222-8222-222222222222';
    const parentTranscript = join(appData, 'brain', parentId, '.system_generated', 'logs', 'transcript.jsonl');
    writeJsonl(parentTranscript, [
      { step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>\nParent cost\n</USER_REQUEST>' },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        model: 'gemini-4-carbon',
        input_tokens: 500_000,
        cache_read_tokens: 0,
        output_tokens: 10_000,
        content: `Child [worker](conversation://${childId})`,
      },
    ]);
    writeJsonl(join(appData, 'brain', childId, '.system_generated', 'logs', 'transcript.jsonl'), [
      { step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>\nChild cost\n</USER_REQUEST>' },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        model: 'gemini-3.8-flash',
        input_tokens: 1_000_000,
        cache_read_tokens: 0,
        output_tokens: 100_000,
      },
    ]);

    const convRes = analyzeConversation(parentId, { dirs: [appData] });
    // Parent (>200k carbon): 0.5*4 + 0.01*18 = 2.18; Child (3.8-flash): 1*0.75 + 0.1*3.75 = 1.125
    assert.equal(convRes.cost.totalCostUsd, 2.18);
    assert.equal(convRes.cost.subagentsCostUsd, 1.125);
    assert.equal(convRes.cost.totalWithSubagentsUsd, 3.305);

    const customEnv = {
      AGY_CTX_PRICING_JSON: JSON.stringify({
        'gemini-4-carbon': { in: 10.0, out: 20.0, cacheRead: 1.0 },
      }),
    };
    assert.notEqual(getPricingSignature({ env: customEnv }), 'default');
    const customFileRes = analyzeTranscriptFile(parentTranscript, { env: customEnv });
    // Custom flat rate: 0.5*10 + 0.01*20 = 5.20
    assert.equal(customFileRes.cost.totalCostUsd, 5.2);

    const pricingFile = join(root, 'pricing.json');
    writeFileSync(
      pricingFile,
      JSON.stringify({ 'gemini-4-carbon': { in: 1.0, out: 2.0, cacheRead: 0.1 } }),
      'utf8'
    );
    const fileOverrideRes = analyzeTranscriptFile(parentTranscript, {
      env: { AGY_CTX_PRICING_FILE: pricingFile },
    });
    // File override flat rate: 0.5*1 + 0.01*2 = 0.52
    assert.equal(fileOverrideRes.cost.totalCostUsd, 0.52);

    // Direct opts.pricing overrides env
    const directRes = analyzeTranscriptFile(parentTranscript, {
      env: customEnv,
      pricing: { 'gemini-4-carbon': { in: 2.0, out: 4.0 } },
    });
    assert.equal(directRes.cost.totalCostUsd, 1.04);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('bin/statusline.mjs & detail: renders host cost, transcript cost, payload estimation, and AGY_CTX_NO_COST=1', () => {
  const root = mkdtempSync(join(tmpdir(), 'ctx-sl-cost-'));
  try {
    const tPath = join(root, 'transcript.jsonl');
    writeJsonl(tPath, [
      { step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>\nStatusline cost\n</USER_REQUEST>' },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        model: 'gemini-4-carbon',
        input_tokens: 100_000,
        cache_read_tokens: 100_000,
        output_tokens: 5_000,
      },
    ]);
    // Cost: 0.1*2 + 0.1*0.2 + 0.005*12 = 0.28; uncached: 0.2*2 + 0.06 = 0.46 => saved 0.18
    const runSl = (payload, extraEnv = {}, script = 'statusline.mjs') =>
      spawnSync(process.execPath, [join(PLUGIN_ROOT, 'bin', script)], {
        input: JSON.stringify(payload),
        encoding: 'utf8',
        env: { ...process.env, NO_COLOR: '1', ...extraEnv },
      });

    // 1. Host-provided cost
    const rHost = runSl({
      cwd: '/workspace/host-cost',
      model: { id: 'gemini-4-carbon', display_name: 'Gemini 4 Carbon' },
      context_window: {
        context_window_size: 1_048_576,
        used_percentage: 5,
        total_input_tokens: 50_000,
        total_output_tokens: 2_000,
      },
      cost: { total_cost_usd: 1.234 },
    });
    assert.equal(rHost.status, 0);
    assert.match(rHost.stdout, /\$1\.23/);

    // 2. Transcript-derived cost + detail line 2 saved amount
    const rTranscript = runSl(
      {
        cwd: '/workspace/tr-cost',
        transcript_path: tPath,
        model: { id: 'gemini-4-carbon', display_name: 'Gemini 4 Carbon' },
        context_window: { context_window_size: 1_048_576, used_percentage: 19 },
      },
      {},
      'statusline-detail'
    );
    assert.equal(rTranscript.status, 0);
    assert.match(rTranscript.stdout.split('\n')[0], /\$0\.28/);
    assert.match(rTranscript.stdout.split('\n')[1], /Cost \$0\.28 \(saved \$0\.18\)/);

    // 3. Payload fallback estimation (no transcript_path, no host cost)
    const estCost = estimatePayloadCost({
      totalInputTokens: 100_000,
      totalOutputTokens: 10_000,
      currentUsage: { input_tokens: 50_000, cache_read_input_tokens: 50_000 },
      modelId: 'gemini-4-carbon',
    });
    assert.ok(estCost > 0);
    const rEst = runSl({
      cwd: '/workspace/est-cost',
      model: { id: 'gemini-4-carbon', display_name: 'Gemini 4 Carbon' },
      context_window: {
        context_window_size: 1_048_576,
        used_percentage: 10,
        total_input_tokens: 100_000,
        total_output_tokens: 10_000,
        current_usage: { input_tokens: 50_000, cache_read_input_tokens: 50_000, output_tokens: 1_000 },
      },
    });
    assert.equal(rEst.status, 0);
    assert.match(rEst.stdout, /\$0\.23/);

    // 4. AGY_CTX_NO_COST=1 suppresses cost on both lines
    const rNoCost = runSl(
      {
        cwd: '/workspace/no-cost',
        transcript_path: tPath,
        model: { id: 'gemini-4-carbon', display_name: 'Gemini 4 Carbon' },
        context_window: { context_window_size: 1_048_576, used_percentage: 19 },
      },
      { AGY_CTX_NO_COST: '1' },
      'statusline-detail'
    );
    assert.equal(rNoCost.status, 0);
    assert.doesNotMatch(rNoCost.stdout, /\$/);
    assert.doesNotMatch(rNoCost.stdout, /Cost/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cli & hooks & sidecar: cost reporting, --sort cost, :ctx all cost, and UI/API coverage', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ctx-cost-e2e-'));
  let app = null;
  try {
    const cliAppData = join(root, '.gemini', 'antigravity-cli');
    const cheapId = 'aaaa1111-1111-4111-8111-111111111111';
    const priceyId = 'bbbb2222-2222-4222-8222-222222222222';
    const cheapPath = join(cliAppData, 'brain', cheapId, '.system_generated', 'logs', 'transcript.jsonl');
    const priceyPath = join(cliAppData, 'brain', priceyId, '.system_generated', 'logs', 'transcript.jsonl');

    writeJsonl(cheapPath, [
      { step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>\nCheap Flash task\n</USER_REQUEST>' },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        model: 'gemini-3.8-flash',
        input_tokens: 10_000,
        cache_read_tokens: 0,
        output_tokens: 1_000,
      },
    ]);
    writeJsonl(priceyPath, [
      { step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>\nExpensive Opus task\n</USER_REQUEST>' },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        model: 'claude-opus-4',
        input_tokens: 100_000,
        cache_read_tokens: 50_000,
        output_tokens: 10_000,
      },
    ]);

    // 1. context-usage.mjs --all --sort cost & --json totals
    const cliAllJson = spawnSync(
      process.execPath,
      [join(PLUGIN_ROOT, 'bin', 'context-usage.mjs'), '--all', '--sort', 'cost', '--json'],
      { encoding: 'utf8', env: { ...process.env, HOME: root, ANTIGRAVITY_APP_DATA_DIR: '' } }
    );
    assert.equal(cliAllJson.status, 0, cliAllJson.stderr);
    const parsedAll = JSON.parse(cliAllJson.stdout);
    assert.equal(parsedAll.conversations[0].conversationId, priceyId);
    assert.ok(parsedAll.totals.totalCostUsd > 2);

    const cliAllText = spawnSync(
      process.execPath,
      [join(PLUGIN_ROOT, 'bin', 'context-usage.mjs'), '--all', '--sort=cost'],
      { encoding: 'utf8', env: { ...process.env, HOME: root, ANTIGRAVITY_APP_DATA_DIR: '', NO_COLOR: '1' } }
    );
    assert.equal(cliAllText.status, 0, cliAllText.stderr);
    assert.match(cliAllText.stdout, /COST/);
    assert.match(cliAllText.stdout, /Est\. Cost:/);

    const cliDetail = spawnSync(
      process.execPath,
      [join(PLUGIN_ROOT, 'bin', 'context-usage.mjs'), '--file', priceyPath],
      { encoding: 'utf8', env: { ...process.env, HOME: root, NO_COLOR: '1' } }
    );
    assert.equal(cliDetail.status, 0);
    assert.match(cliDetail.stdout, /Est\. Cost:/);
    assert.match(cliDetail.stdout, /Cache Saved:/);

    // 2. ctx --file and --all --sort=cost with exact box alignment
    const boxSingle = spawnSync(process.execPath, [join(PLUGIN_ROOT, 'bin', 'ctx'), '--file', priceyPath], {
      encoding: 'utf8',
      env: { ...process.env, HOME: root, NO_COLOR: '1' },
    });
    assert.equal(boxSingle.status, 0);
    assert.match(boxSingle.stdout, /Cost:/);
    assert.match(boxSingle.stdout, /Saved:/);
    const singleLines = boxSingle.stdout.trimEnd().split('\n').filter((l) => /^[╭├│╰]/.test(l));
    const singleW = displayWidth(singleLines[0]);
    for (const l of singleLines) assert.equal(displayWidth(l), singleW);

    const boxAll = spawnSync(
      process.execPath,
      [join(PLUGIN_ROOT, 'bin', 'ctx'), '--all', '--sort=cost'],
      { encoding: 'utf8', env: { ...process.env, HOME: root, ANTIGRAVITY_APP_DATA_DIR: '', NO_COLOR: '1' } }
    );
    assert.equal(boxAll.status, 0);
    assert.match(boxAll.stdout, /Σ \$/);
    const allLines = boxAll.stdout.trimEnd().split('\n').filter((l) => /^[╭├│╰]/.test(l));
    const allW = displayWidth(allLines[0]);
    for (const l of allLines) assert.equal(displayWidth(l), allW);

    // 3. PreInvocation :ctx & :ctx all cost on CLI surface (no sidecar:// links)
    const hookSingle = evaluatePanelIntercept(
      { conversationId: priceyId, transcriptPath: priceyPath, lastUserInput: ':ctx' },
      { dirs: [cliAppData] }
    );
    const mdSingle = hookSingle.injectSteps[0].systemMessage.metadata.user_markdown;
    assert.match(mdSingle, /预估成本/);
    assert.match(mdSingle, /缓存已省/);
    assert.doesNotMatch(mdSingle, /sidecar:\/\//);

    // Brand-new Turn #1 still displays $0.00 cost safely
    const turn1Hook = evaluatePanelIntercept(
      {
        conversationId: 'cccc3333-3333-4333-8333-333333333333',
        transcriptPath: join(cliAppData, 'brain', 'cccc3333-3333-4333-8333-333333333333', '.system_generated', 'logs', 'transcript.jsonl'),
        modelName: 'gemini-pro-orchestrator',
        lastUserInput: '<USER_REQUEST>\n:ctx\n</USER_REQUEST>',
      },
      { dirs: [cliAppData] }
    );
    assert.match(turn1Hook.injectSteps[0].systemMessage.metadata.user_markdown, /\$0\.00/);

    const hookAllCost = evaluatePanelIntercept(
      { conversationId: cheapId, transcriptPath: cheapPath, lastUserInput: ':ctx all cost' },
      { dirs: [cliAppData] }
    );
    const mdAllCost = hookAllCost.injectSteps[0].systemMessage.metadata.user_markdown;
    assert.match(mdAllCost, /累计成本/);
    assert.match(mdAllCost, /\| Cost \|/);
    assert.ok(mdAllCost.indexOf('Expensive Opus task') < mdAllCost.indexOf('Cheap Flash task'));
    assert.doesNotMatch(mdAllCost, /sidecar:\/\//);

    // 4. Sidecar API & UI static check
    app = await createMonitorApp({ standalone: true, port: 0, dirs: [cliAppData] });
    const server = await app.run();
    const base = `http://127.0.0.1:${server.address().port}`;
    const ctxData = await (await fetch(`${base}/api/context?conversationId=${priceyId}`)).json();
    assert.ok(ctxData.cost.totalCostUsd > 2);
    assert.ok(ctxData.cost.cacheSavingsUsd > 0);
    const convData = await (await fetch(`${base}/api/conversations`)).json();
    assert.ok(convData.totals.totalCostUsd > 2);
    assert.equal(convData.totals.count, 2);

    const html = await (await fetch(`${base}/`)).text();
    const js = await (await fetch(`${base}/app.js`)).text();
    const css = await (await fetch(`${base}/styles.css`)).text();
    assert.match(html, /kpi-total-cost/);
    assert.match(html, /kpi-cache-savings/);
    assert.match(html, /sessions-sort/);
    assert.match(js, /formatCost/);
    assert.match(js, /totalWithSubagentsUsd/);
    assert.doesNotMatch(css, /--muted\s*:/);
    assert.doesNotMatch(css, /var\(--muted\s*[,)]/);
  } finally {
    if (app) await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('remote pricing: parseNewApiRatioConfig math, normalized matching, and non-collision safety', () => {
  assert.equal(WEEKLY_PRICING_CACHE_TTL_MS, 7 * 24 * 60 * 60 * 1000);
  assert.equal(
    DEFAULT_REMOTE_PRICING_URL,
    'https://basellm.github.io/llm-metadata/api/newapi/ratio_config-v1-base.json'
  );

  // Wrapped NewAPI /api/ratio_config payload + model_price-only entries ignored
  const wrapped = parseNewApiRatioConfig({
    success: true,
    data: {
      model_ratio: {
        'claude-opus-4-5': 2.5,
        'claude-sonnet-4-5': 1.5,
        'gpt-oss-120b': 0.075,
        'gemini-pro': 0.25,
        'gemini-2.5-flash': 0.15,
      },
      completion_ratio: {
        'claude-opus-4-5': 5,
        'claude-sonnet-4-5': 5,
        'gpt-oss-120b': 4,
        'gemini-pro': 3,
        'gemini-2.5-flash': 8.33333333,
      },
      cache_ratio: {
        'claude-opus-4-5': 0.1,
        'gpt-oss-120b': 0.5,
      },
      create_cache_ratio: {
        'claude-opus-4-5': 1.25,
      },
      model_price: {
        'midjourney-v6': 0.05,
      },
    },
  });

  assert.equal(wrapped.modelCount, 5);
  assert.equal(wrapped.models['midjourney-v6'], undefined);
  assert.deepEqual(wrapped.models['claude-opus-4-5'], {
    in: 5,
    out: 25,
    cacheRead: 0.5,
    cacheWrite: 6.25,
  });
  assert.deepEqual(wrapped.models['claude-sonnet-4-5'], {
    in: 3,
    out: 15,
    cacheRead: 0.3,
    cacheWrite: 3,
  });
  assert.equal(wrapped.models['gpt-oss-120b'].in, 0.15);
  assert.equal(wrapped.models['gpt-oss-120b'].out, 0.6);
  assert.equal(wrapped.models['gpt-oss-120b'].cacheRead, 0.075);

  // Unwrapped direct ratio_config payload (preserves built-in 0.25x cache ratio for o3-mini; 0.1x default for unknown models)
  const unwrapped = parseNewApiRatioConfig({
    model_ratio: { 'o3-mini': 0.55, 'custom-llm-x': 0.5 },
    completion_ratio: { 'o3-mini': 4, 'custom-llm-x': 3 },
  });
  assert.equal(unwrapped.modelCount, 2);
  assert.deepEqual(unwrapped.models['o3-mini'], {
    in: 1.1,
    out: 4.4,
    cacheRead: 0.275,
    cacheWrite: 1.1,
  });
  assert.deepEqual(unwrapped.models['custom-llm-x'], {
    in: 1,
    out: 3,
    cacheRead: 0.1,
    cacheWrite: 1,
  });

  // Normalized Antigravity effort/vendor matching without false substring collisions
  const mOpus = resolveModelPricing({
    rawModel: 'claude-opus-4-5-high',
    remoteModels: wrapped.models,
  });
  assert.equal(mOpus.pricingId, 'claude-opus-4-5');
  assert.equal(mOpus.pricingSource, 'remote-cache');
  assert.equal(mOpus.in, 5);

  const mOss = resolveModelPricing({
    rawModel: 'gpt-oss-120b-medium',
    remoteModels: wrapped.models,
  });
  assert.equal(mOss.pricingId, 'gpt-oss-120b');
  assert.equal(mOss.pricingSource, 'remote-cache');

  const mSonnet = resolveModelPricing({
    rawModel: 'anthropic/claude-sonnet-4.5',
    remoteModels: wrapped.models,
  });
  assert.equal(mSonnet.pricingId, 'claude-sonnet-4-5');
  assert.equal(mSonnet.pricingSource, 'remote-cache');

  const mOrch = resolveModelPricing({
    rawModel: 'gemini-pro-orchestrator',
    remoteModels: wrapped.models,
  });
  assert.equal(mOrch.pricingId, 'gemini-4-carbon');
  assert.equal(mOrch.pricingSource, 'builtin');

  const mFlashLite = resolveModelPricing({
    rawModel: 'gemini-2.5-flash-lite',
    remoteModels: wrapped.models,
  });
  assert.equal(mFlashLite.pricingId, 'gemini-2.5-flash-lite');
  assert.equal(mFlashLite.pricingSource, 'builtin');
});

test('remote pricing: weekly (7-day TTL) cache lifecycle, 304 ETag, stale fallback, and override precedence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ctx-weekly-cache-'));
  let mockServer = null;
  let app = null;

  let requestCount = 0;
  let mode = 'ok';
  let currentEtag = '"v1"';
  let sonnetRatio = 1.5; // in = $3/1M, out = $15/1M, cacheRead = $0.3/1M

  try {
    mockServer = createServer((req, res) => {
      requestCount += 1;
      if (mode === '500') {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Upstream error');
        return;
      }
      if (req.headers['if-none-match'] === currentEtag) {
        res.writeHead(304, { ETag: currentEtag });
        res.end();
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/json',
        ETag: currentEtag,
      });
      res.end(
        JSON.stringify({
          success: true,
          data: {
            model_ratio: {
              'claude-sonnet-4-5': sonnetRatio,
              'gpt-oss-120b': 0.075,
            },
            completion_ratio: {
              'claude-sonnet-4-5': 5,
              'gpt-oss-120b': 4,
            },
            cache_ratio: {
              'claude-sonnet-4-5': 0.1,
              'gpt-oss-120b': 0.5,
            },
          },
        })
      );
    });

    await new Promise((r) => mockServer.listen(0, '127.0.0.1', r));
    const mockUrl = `http://127.0.0.1:${mockServer.address().port}/ratio_config-v1-base.json`;
    const cacheDir = join(root, 'cache');
    const appData = join(root, '.gemini', 'antigravity-cli');
    const convId = '11223344-5566-4777-8888-999900001111';
    const tPath = join(appData, 'brain', convId, '.system_generated', 'logs', 'transcript.jsonl');

    writeJsonl(tPath, [
      { step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>\nRemote cache check\n</USER_REQUEST>' },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        model: 'claude-sonnet-4-5-high',
        input_tokens: 100_000,
        cache_read_tokens: 50_000,
        output_tokens: 10_000,
      },
    ]);

    const env = {
      ...process.env,
      AGY_CTX_CACHE_DIR: cacheDir,
      AGY_CTX_PRICING_URL: mockUrl,
      NO_COLOR: '1',
    };

    // 1. Initial sync populates cache file
    const s1 = await syncRemotePricingCache({ env });
    assert.equal(s1.ok, true);
    assert.equal(s1.updated, true);
    assert.equal(requestCount, 1);
    const cacheFile = getPricingCacheFilePath(env);
    assert.equal(existsSync(cacheFile), true);

    const a1 = analyzeTranscriptFile(tPath, { env });
    assert.equal(a1.cost.pricingSource, 'remote-cache');
    assert.equal(a1.cost.pricingCache.stale, false);
    // 0.1M * 3 + 0.05M * 0.3 + 0.01M * 15 = 0.3 + 0.015 + 0.15 = 0.465
    assert.equal(a1.cost.totalCostUsd, 0.465);

    // statusline reads cached disk rates with zero network overhead
    const slRun = spawnSync(process.execPath, [join(PLUGIN_ROOT, 'bin', 'statusline.mjs')], {
      input: JSON.stringify({
        cwd: '/workspace/demo',
        transcript_path: tPath,
        model: { id: 'claude-sonnet-4-5-high', display_name: 'Claude Sonnet 4.5' },
        context_window: { context_window_size: 200_000, used_percentage: 75 },
      }),
      encoding: 'utf8',
      env: { ...process.env, AGY_CTX_CACHE_DIR: cacheDir, NO_COLOR: '1' },
    });
    assert.equal(slRun.status, 0, slRun.stderr);
    assert.match(slRun.stdout, /\$0\.47|\$0\.465/);

    // 2. Second sync within 7-day TTL skips network fetch
    const s2 = await syncRemotePricingCache({ env });
    assert.equal(s2.ok, true);
    assert.equal(s2.skipped, true);
    assert.equal(s2.fromCache, true);
    assert.equal(requestCount, 1);

    // 3. Expired cache (> 7 days) + matching ETag -> 304 Not Modified renewal
    const backdate = (days) => {
      const data = JSON.parse(readFileSync(cacheFile, 'utf8'));
      data.fetchedAt = Date.now() - days * 24 * 60 * 60 * 1000;
      writeFileSync(cacheFile, JSON.stringify(data), 'utf8');
    };
    backdate(8);
    assert.equal(loadRemotePricingCache({ env, disableRemoteRefresh: true }).stale, true);

    const s3 = await syncRemotePricingCache({ env });
    assert.equal(s3.ok, true);
    assert.equal(s3.notModified, true);
    assert.equal(requestCount, 2);
    assert.equal(loadRemotePricingCache({ env, disableRemoteRefresh: true }).stale, false);

    // 4. Expired cache + updated remote pricing & ETag -> updates cost, signature & Sidecar ETag
    app = await createMonitorApp({ standalone: true, port: 0, dirs: [appData], env, disableRemoteRefresh: true });
    const sidecarSrv = await app.run();
    const sidecarBase = `http://127.0.0.1:${sidecarSrv.address().port}`;
    const ctx1 = await (await fetch(`${sidecarBase}/api/context?conversationId=${convId}`)).json();
    const sigBefore = getPricingSignature({ env });

    await new Promise((r) => setTimeout(r, 5));
    backdate(8);
    currentEtag = '"v2"';
    sonnetRatio = 3.0; // doubled: in=6, out=30, cacheRead=0.6 => cost doubled = 0.93

    const s4 = await syncRemotePricingCache({ env });
    assert.equal(s4.ok, true);
    assert.equal(s4.updated, true);
    assert.equal(requestCount, 3);
    assert.notEqual(getPricingSignature({ env }), sigBefore);

    const a2 = analyzeTranscriptFile(tPath, { env });
    assert.equal(a2.cost.totalCostUsd, 0.93);

    const ctx2 = await (
      await fetch(`${sidecarBase}/api/context?conversationId=${convId}&etag=${encodeURIComponent(ctx1.etag)}`)
    ).json();
    assert.notEqual(ctx2.unchanged, true);
    assert.notEqual(ctx2.etag, ctx1.etag);
    assert.equal(ctx2.cost.totalCostUsd, 0.93);

    // 5. Expired cache + server 500 error -> falls back cleanly to stale cached rates
    backdate(8);
    mode = '500';
    const s5 = await syncRemotePricingCache({ env });
    assert.equal(s5.ok, false);
    assert.equal(s5.staleFallback, true);
    assert.equal(analyzeTranscriptFile(tPath, { env }).cost.totalCostUsd, 0.93);

    // 6. Precedence: custom override > remote cache > builtin (with AGY_CTX_NO_REMOTE_PRICING=1)
    const customEnv = {
      ...env,
      AGY_CTX_PRICING_JSON: JSON.stringify({
        'claude-sonnet-4-5': { in: 1.0, out: 2.0, cacheRead: 0.1 },
      }),
    };
    const customRes = analyzeTranscriptFile(tPath, { env: customEnv });
    assert.equal(customRes.cost.pricingSource, 'custom');
    // 0.1*1 + 0.05*0.1 + 0.01*2 = 0.125
    assert.equal(customRes.cost.totalCostUsd, 0.125);

    const disabledEnv = { ...env, AGY_CTX_NO_REMOTE_PRICING: '1' };
    const builtinRes = analyzeTranscriptFile(tPath, { env: disabledEnv });
    assert.equal(builtinRes.cost.pricingSource, 'builtin');
    // built-in claude-sonnet-4: in=3, read=0.3, out=15 => 0.465
    assert.equal(builtinRes.cost.totalCostUsd, 0.465);
  } finally {
    if (app) await app.close();
    if (mockServer) {
      mockServer.closeAllConnections?.();
      await new Promise((r) => mockServer.close(r));
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test('cli & sidecar: --refresh-pricing and /api/pricing endpoints work offline with local mock server', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ctx-pricing-endpoints-'));
  let mockServer = null;
  let app = null;

  try {
    mockServer = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json', ETag: '"mock-cli-v1"' });
      res.end(
        JSON.stringify({
          model_ratio: { 'claude-opus-4-5': 2.5, 'gemini-2.5-flash': 0.15 },
          completion_ratio: { 'claude-opus-4-5': 5, 'gemini-2.5-flash': 8 },
          cache_ratio: { 'claude-opus-4-5': 0.1 },
        })
      );
    });
    await new Promise((r) => mockServer.listen(0, '127.0.0.1', r));
    const mockUrl = `http://127.0.0.1:${mockServer.address().port}/ratio_config-v1-base.json`;

    const cacheDir1 = join(root, 'cache1');
    const cliJson = await execFileAsync(
      process.execPath,
      [join(PLUGIN_ROOT, 'bin', 'context-usage.mjs'), '--refresh-pricing', '--json'],
      {
        encoding: 'utf8',
        env: { ...process.env, HOME: root, AGY_CTX_CACHE_DIR: cacheDir1, AGY_CTX_PRICING_URL: mockUrl },
      }
    );
    const parsed = JSON.parse(cliJson.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.updated, true);
    assert.equal(parsed.modelCount, 2);
    assert.equal(existsSync(getPricingCacheFilePath({}, cacheDir1)), true);

    const cacheDir2 = join(root, 'cache2');
    const cliText = await execFileAsync(
      process.execPath,
      [join(PLUGIN_ROOT, 'bin', 'context-usage.mjs'), '--refresh-pricing'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: root,
          AGY_CTX_CACHE_DIR: cacheDir2,
          AGY_CTX_PRICING_URL: mockUrl,
          NO_COLOR: '1',
        },
      }
    );
    assert.match(cliText.stdout, /Synced 2 models/);
    assert.match(cliText.stdout, /valid for 7 days/);

    // Sidecar /api/pricing & /api/pricing/refresh
    const cliAppData = join(root, '.gemini', 'antigravity-cli');
    mkdirSync(join(cliAppData, 'brain'), { recursive: true });
    const cacheDir3 = join(root, 'cache3');
    app = await createMonitorApp({
      standalone: true,
      port: 0,
      dirs: [cliAppData],
      env: { ...process.env, AGY_CTX_CACHE_DIR: cacheDir3, AGY_CTX_PRICING_URL: mockUrl },
      disableRemoteRefresh: true,
    });
    const srv = await app.run();
    const base = `http://127.0.0.1:${srv.address().port}`;

    const before = await (await fetch(`${base}/api/pricing`)).json();
    assert.equal(before.defaultUrl, DEFAULT_REMOTE_PRICING_URL);
    assert.equal(before.cache, null);

    const refreshed = await (await fetch(`${base}/api/pricing/refresh`, { method: 'POST' })).json();
    assert.equal(refreshed.ok, true);
    assert.equal(refreshed.updated, true);
    assert.equal(refreshed.modelCount, 2);

    const after = await (await fetch(`${base}/api/pricing`)).json();
    assert.equal(after.cache.modelCount, 2);
    assert.equal(after.cache.stale, false);
    assert.equal(after.cache.sourceUrl, mockUrl);
  } finally {
    if (app) await app.close();
    if (mockServer) {
      mockServer.closeAllConnections?.();
      await new Promise((r) => mockServer.close(r));
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test('pricing: Last-Modified HEAD check avoids redundant GETs and refreshes only when modified', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ctx-last-modified-'));
  let mockServer = null;
  let app = null;

  let headCount = 0;
  let getCount = 0;
  let disallowHead = false;
  let sawIfModifiedSince = '';
  let currentLastModified = 'Mon, 01 Nov 2026 00:00:00 GMT';
  let sonnetRatio = 1.5; // in=3, read=0.3, out=15

  try {
    mockServer = createServer((req, res) => {
      if (req.headers['if-modified-since']) {
        sawIfModifiedSince = String(req.headers['if-modified-since']);
      }
      if (req.method === 'HEAD') {
        headCount += 1;
        if (disallowHead) {
          res.writeHead(405, { 'Content-Type': 'text/plain' });
          res.end();
          return;
        }
        // Intentionally return 200 OK with Last-Modified (never 304) to verify timestamp comparison works
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Last-Modified': currentLastModified,
        });
        res.end();
        return;
      }

      getCount += 1;
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Last-Modified': currentLastModified,
      });
      res.end(
        JSON.stringify({
          model_ratio: { 'claude-sonnet-4-5': sonnetRatio },
          completion_ratio: { 'claude-sonnet-4-5': 5 },
          cache_ratio: { 'claude-sonnet-4-5': 0.1 },
        })
      );
    });

    await new Promise((r) => mockServer.listen(0, '127.0.0.1', r));
    const mockUrl = `http://127.0.0.1:${mockServer.address().port}/ratio_config-v1-base.json`;
    const cacheDir = join(root, 'cache');
    const env = {
      ...process.env,
      ANTIGRAVITY_APP_DATA_DIR: '',
      ANTIGRAVITY_EXECUTABLE_DATA_DIR: '',
      ANTIGRAVITY_CONVERSATION_ID: '',
      AGY_CTX_CACHE_DIR: cacheDir,
      AGY_CTX_PRICING_URL: mockUrl,
      NO_COLOR: '1',
    };

    // 1. Initial sync performs GET directly and persists Last-Modified
    const s1 = await syncRemotePricingCache({ env });
    assert.equal(s1.ok, true);
    assert.equal(s1.updated, true);
    assert.equal(s1.lastModified, currentLastModified);
    assert.equal(headCount, 0);
    assert.equal(getCount, 1);

    const sig1 = getPricingSignature({ env });

    // 2. Manual force refresh with unchanged Last-Modified -> uses HEAD only (0 extra GETs)
    const s2 = await syncRemotePricingCache({ env, force: true });
    assert.equal(s2.ok, true);
    assert.equal(s2.notModified, true);
    assert.equal(s2.checkedBy, 'last-modified');
    assert.equal(s2.lastModified, currentLastModified);
    assert.equal(sawIfModifiedSince, currentLastModified);
    assert.equal(headCount, 1);
    assert.equal(getCount, 1);
    assert.equal(getPricingSignature({ env }), sig1);

    // 3. CLI --refresh-pricing with unchanged Last-Modified -> HEAD only, prints up-to-date message
    const cliUpToDate = await execFileAsync(
      process.execPath,
      [join(PLUGIN_ROOT, 'bin', 'context-usage.mjs'), '--refresh-pricing'],
      { encoding: 'utf8', env: { ...env, HOME: root } }
    );
    assert.match(cliUpToDate.stdout, /already up to date/i);
    assert.match(cliUpToDate.stdout, /Last-Modified:/);
    assert.equal(headCount, 2);
    assert.equal(getCount, 1);

    // 4. Advance Last-Modified & rates -> HEAD detects newer timestamp and triggers GET
    currentLastModified = 'Mon, 15 Nov 2026 12:00:00 GMT';
    sonnetRatio = 3.0;
    const s3 = await syncRemotePricingCache({ env, force: true });
    assert.equal(s3.ok, true);
    assert.equal(s3.updated, true);
    assert.equal(s3.lastModified, currentLastModified);
    assert.equal(headCount, 3);
    assert.equal(getCount, 2);
    assert.notEqual(getPricingSignature({ env }), sig1);

    // 5. HEAD 405 Method Not Allowed -> gracefully falls back to GET
    disallowHead = true;
    const s4 = await syncRemotePricingCache({ env, force: true });
    assert.equal(s4.ok, true);
    assert.equal(s4.updated, true);
    assert.equal(headCount, 4);
    assert.equal(getCount, 3);

    // 6. Sidecar /api/pricing exposes lastModified
    const cliAppData = join(root, '.gemini', 'antigravity-cli');
    mkdirSync(join(cliAppData, 'brain'), { recursive: true });
    app = await createMonitorApp({
      standalone: true,
      port: 0,
      dirs: [cliAppData],
      env,
      disableRemoteRefresh: true,
    });
    const srv = await app.run();
    const base = `http://127.0.0.1:${srv.address().port}`;
    const pricingInfo = await (await fetch(`${base}/api/pricing`)).json();
    assert.equal(pricingInfo.cache.lastModified, currentLastModified);
  } finally {
    if (app) await app.close();
    if (mockServer) {
      mockServer.closeAllConnections?.();
      await new Promise((r) => mockServer.close(r));
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test('stats: day/week/month/custom range aggregation across CLI, Box Panel, Hook, and Sidecar UI', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ctx-stats-'));
  let app = null;

  const isoForLocalOffset = (nowDate, daysAgo, hour = 10, min = 0) =>
    new Date(
      nowDate.getFullYear(),
      nowDate.getMonth(),
      nowDate.getDate() - daysAgo,
      hour,
      min,
      0,
      0
    ).toISOString();

  const ymdForOffset = (nowDate, daysAgo) => {
    const d = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate() - daysAgo, 12, 0, 0, 0);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };

  try {
    const cliData = join(root, '.gemini', 'antigravity-cli');
    const appData = join(root, '.gemini', 'antigravity');
    const cacheDir = join(root, 'cache');
    const env = {
      ...process.env,
      HOME: root,
      ANTIGRAVITY_APP_DATA_DIR: '',
      ANTIGRAVITY_EXECUTABLE_DATA_DIR: '',
      ANTIGRAVITY_CONVERSATION_ID: '',
      AGY_CTX_CACHE_DIR: cacheDir,
      AGY_CTX_NO_REMOTE_PRICING: '1',
      NO_COLOR: '1',
    };

    const now = new Date();
    const nowMs = now.getTime();
    const cToday = 'aaaa1111-1111-4111-8111-111111111111';
    const cWeek = 'bbbb2222-2222-4222-8222-222222222222';
    const cMonth = 'cccc3333-3333-4333-8333-333333333333';
    const cOld = 'dddd4444-4444-4444-8444-444444444444';

    // Today turn (CLI, Claude Sonnet 4.5: 100k in * 3 + 10k out * 15 = $0.45)
    writeJsonl(join(cliData, 'brain', cToday, '.system_generated', 'logs', 'transcript.jsonl'), [
      {
        step_index: 0,
        type: 'USER_INPUT',
        created_at: isoForLocalOffset(now, 0, 9, 15),
        content: '<USER_REQUEST>\n今日任务修复与测试\n</USER_REQUEST>',
      },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        created_at: isoForLocalOffset(now, 0, 9, 16),
        model: 'claude-sonnet-4-5',
        input_tokens: 100_000,
        cache_read_tokens: 0,
        output_tokens: 10_000,
      },
    ]);

    // 3 days ago turn (App, Claude Sonnet 4.5: $0.45)
    writeJsonl(join(appData, 'brain', cWeek, '.system_generated', 'logs', 'transcript.jsonl'), [
      {
        step_index: 0,
        type: 'USER_INPUT',
        created_at: isoForLocalOffset(now, 3, 14, 0),
        content: '<USER_REQUEST>\nThree days ago App task\n</USER_REQUEST>',
      },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        created_at: isoForLocalOffset(now, 3, 14, 2),
        model: 'claude-sonnet-4-5',
        input_tokens: 100_000,
        cache_read_tokens: 0,
        output_tokens: 10_000,
      },
    ]);

    // 15 days ago turn (CLI, Claude Sonnet 4.5: $0.45)
    writeJsonl(join(cliData, 'brain', cMonth, '.system_generated', 'logs', 'transcript.jsonl'), [
      {
        step_index: 0,
        type: 'USER_INPUT',
        created_at: isoForLocalOffset(now, 15, 11, 30),
        content: '<USER_REQUEST>\nHalf-month refactor\n</USER_REQUEST>',
      },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        created_at: isoForLocalOffset(now, 15, 11, 32),
        model: 'claude-sonnet-4-5',
        input_tokens: 100_000,
        cache_read_tokens: 0,
        output_tokens: 10_000,
      },
    ]);

    // 45 days ago turn (App, Claude Sonnet 4.5: $0.45)
    writeJsonl(join(appData, 'brain', cOld, '.system_generated', 'logs', 'transcript.jsonl'), [
      {
        step_index: 0,
        type: 'USER_INPUT',
        created_at: isoForLocalOffset(now, 45, 16, 0),
        content: '<USER_REQUEST>\nOlder historical task\n</USER_REQUEST>',
      },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        created_at: isoForLocalOffset(now, 45, 16, 5),
        model: 'claude-sonnet-4-5',
        input_tokens: 100_000,
        cache_read_tokens: 0,
        output_tokens: 10_000,
      },
    ]);

    // 1. Direct analyzer presets: day (1), week (2), month (3), all (4)
    const dirs = [cliData, appData];
    const dayStats = aggregateUsageStats({ period: 'day', nowMs, dirs, env });
    assert.equal(dayStats.period, 'day');
    assert.equal(dayStats.granularity, 'hour');
    assert.equal(dayStats.buckets.length, 24);
    assert.equal(dayStats.totals.turnsCount, 1);
    assert.equal(dayStats.totals.sessionsCount, 1);
    assert.equal(dayStats.totals.costUsd, 0.45);

    const weekStats = aggregateUsageStats({ period: 'week', nowMs, dirs, env });
    assert.equal(weekStats.period, 'week');
    assert.equal(weekStats.granularity, 'day');
    assert.equal(weekStats.buckets.length, 7);
    assert.equal(weekStats.totals.turnsCount, 2);
    assert.equal(weekStats.totals.sessionsCount, 2);
    assert.equal(weekStats.totals.costUsd, 0.9);
    assert.equal(weekStats.bySurface.length, 2);

    const weekCliOnly = aggregateUsageStats({ period: 'week', surface: 'cli', nowMs, dirs, env });
    assert.equal(weekCliOnly.totals.sessionsCount, 1);
    assert.equal(weekCliOnly.totals.costUsd, 0.45);

    const monthStats = aggregateUsageStats({ period: 'month', nowMs, dirs, env });
    assert.equal(monthStats.period, 'month');
    assert.equal(monthStats.buckets.length, 30);
    assert.equal(monthStats.totals.turnsCount, 3);
    assert.equal(monthStats.totals.costUsd, 1.35);

    const allStats = aggregateUsageStats({ period: 'all', nowMs, dirs, env });
    assert.equal(allStats.period, 'all');
    assert.equal(allStats.totals.turnsCount, 4);
    assert.equal(allStats.totals.sessionsCount, 4);
    assert.equal(allStats.totals.costUsd, 1.8);

    // 2. Custom range parsing & filtering (16 days ago .. 2 days ago -> cWeek + cMonth = 2 turns)
    const fromYmd = ymdForOffset(now, 16);
    const toYmd = ymdForOffset(now, 2);
    assert.ok(parseTimeBound(fromYmd, { isEnd: false }) < parseTimeBound(toYmd, { isEnd: true }));
    const resolvedCustom = resolveStatsTimeRange({ from: fromYmd, to: toYmd, nowMs });
    assert.equal(resolvedCustom.period, 'custom');

    const customStats = aggregateUsageStats({ from: fromYmd, to: toYmd, nowMs, dirs, env });
    assert.equal(customStats.period, 'custom');
    assert.equal(customStats.totals.turnsCount, 2);
    assert.equal(customStats.totals.sessionsCount, 2);
    assert.equal(customStats.totals.costUsd, 0.9);

    // 3. Boxed Unicode stats panel exact displayWidth alignment (including CJK titles)
    const boxOut = renderBoxStatsPanel(dayStats, { columns: 82 });
    const boxLines = boxOut.split('\n');
    const topW = displayWidth(boxLines[0]);
    assert.ok(topW >= 66);
    for (const ln of boxLines) {
      assert.equal(displayWidth(ln), topW, `Mismatched box width on line: ${ln}`);
    }
    assert.match(boxOut, /今日任务修复与测试/);

    // 4. CLI context-usage --stats week --json & --from/--to --json
    const cliStatsRes = await execFileAsync(
      process.execPath,
      [join(PLUGIN_ROOT, 'bin', 'context-usage.mjs'), '--stats', 'week', '--json'],
      { encoding: 'utf8', env }
    );
    const cliParsed = JSON.parse(cliStatsRes.stdout);
    assert.equal(cliParsed.period, 'week');
    assert.equal(cliParsed.totals.turnsCount, 2);
    assert.equal(cliParsed.totals.costUsd, 0.9);

    const cliCustomRes = await execFileAsync(
      process.execPath,
      [join(PLUGIN_ROOT, 'bin', 'context-usage.mjs'), '--from', fromYmd, '--to', toYmd, '--box'],
      { encoding: 'utf8', env }
    );
    assert.match(cliCustomRes.stdout, /Custom Range/);
    assert.match(cliCustomRes.stdout, /\$0\.90/);

    // 5. Zero-token PreInvocation hook (:ctx week & :ctx stats YYYY-MM-DD..YYYY-MM-DD)
    const cliIntercept = evaluatePanelIntercept(
      {
        conversationId: cToday,
        transcriptPath: join(cliData, 'brain', cToday, '.system_generated', 'logs', 'transcript.jsonl'),
        lastUserInput: `<USER_REQUEST>\n:ctx stats ${fromYmd}..${toYmd}\n</USER_REQUEST>`,
      },
      { dirs, env, nowMs, disableRemoteRefresh: true }
    );
    assert.equal(cliIntercept.terminationBehavior, 'terminate');
    const cliMd = cliIntercept.injectSteps[0].systemMessage.metadata.user_markdown;
    assert.match(cliMd, /Custom Range/);
    assert.match(cliMd, /\$0\.90/);
    assert.equal(cliMd.includes('sidecar://'), false, 'CLI surface must not emit sidecar:// links');

    const appIntercept = evaluatePanelIntercept(
      {
        conversationId: cWeek,
        transcriptPath: join(appData, 'brain', cWeek, '.system_generated', 'logs', 'transcript.jsonl'),
        lastUserInput: '<USER_REQUEST>\n:ctx day\n</USER_REQUEST>',
      },
      { dirs, env, nowMs, disableRemoteRefresh: true }
    );
    assert.equal(appIntercept.terminationBehavior, 'terminate');
    const appMd = appIntercept.injectSteps[0].systemMessage.metadata.user_markdown;
    assert.match(appMd, /sidecar:\/\/context-usage\/context_monitor\/\?tab=stats/);

    const passThrough = evaluatePanelIntercept(
      {
        conversationId: cToday,
        transcriptPath: join(cliData, 'brain', cToday, '.system_generated', 'logs', 'transcript.jsonl'),
        lastUserInput: '<USER_REQUEST>\n:ctx what happened last week?\n</USER_REQUEST>',
      },
      { dirs, env, nowMs, disableRemoteRefresh: true }
    );
    assert.deepEqual(passThrough, {});

    // 6. Sidecar /api/stats endpoint & Web UI contract checks
    app = await createMonitorApp({
      standalone: true,
      port: 0,
      dirs,
      env,
      disableRemoteRefresh: true,
    });
    const srv = await app.run();
    const base = `http://127.0.0.1:${srv.address().port}`;

    const monthApi = await (await fetch(`${base}/api/stats?period=month`)).json();
    assert.equal(monthApi.period, 'month');
    assert.equal(monthApi.totals.turnsCount, 3);
    assert.equal(monthApi.totals.costUsd, 1.35);

    const monthCached = await (
      await fetch(`${base}/api/stats?period=month&etag=${encodeURIComponent(monthApi.etag)}`)
    ).json();
    assert.equal(monthCached.unchanged, true);

    const customApi = await (
      await fetch(`${base}/api/stats?period=custom&from=${encodeURIComponent(fromYmd)}&to=${encodeURIComponent(toYmd)}`)
    ).json();
    assert.equal(customApi.period, 'custom');
    assert.equal(customApi.totals.turnsCount, 2);

    const html = await (await fetch(`${base}/`)).text();
    const css = await (await fetch(`${base}/styles.css`)).text();
    const js = await (await fetch(`${base}/app.js`)).text();
    assert.match(html, /id="tab-btn-stats"/);
    assert.match(html, /id="panel-stats"/);
    assert.match(html, /id="stats-from"/);
    assert.match(html, /id="stats-to"/);
    assert.match(js, /\/api\/stats/);
    assert.equal(/--muted(?![\w-])/.test(css), false, 'styles.css must never define or reference --muted');
  } finally {
    if (app) await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
