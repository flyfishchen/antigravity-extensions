#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const PLUGINS_ROOT = join(REPO_ROOT, 'plugins');
const ROOT_AGENTS_BYTE_CAP = 6_000;
const RULE_BYTE_CAP = 24_000;
const MIN_CONTRACT_LINKS = 5;

function discoverPlugins() {
  if (!existsSync(PLUGINS_ROOT)) return [];
  return readdirSync(PLUGINS_ROOT)
    .sort()
    .map((name) => {
      const dir = join(PLUGINS_ROOT, name);
      try {
        if (!statSync(dir).isDirectory()) return null;
      } catch {
        return null;
      }
      const manifestPath = join(dir, 'plugin.json');
      if (!existsSync(manifestPath)) return null;
      let manifest = {};
      try {
        manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      } catch {
        // Defer JSON syntax failure reporting to `agy plugin validate --strict`
      }
      return {
        dirName: name,
        dir,
        name: manifest.name || name,
        version: manifest.version || '',
        hasPkgTest: hasPackageTest(dir),
      };
    })
    .filter(Boolean);
}

function hasPackageTest(pluginDir) {
  const pkgPath = join(pluginDir, 'package.json');
  if (!existsSync(pkgPath)) return false;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    return Boolean(pkg?.scripts?.test);
  } catch {
    return false;
  }
}

function checkRootContracts(content) {
  let ok = true;
  if (/@\[[^\]]*\]\([^)]+\)/.test(content)) {
    console.error(
      'FAIL AGENTS.md: must not use @[label](path) inline include syntax (use standard links to docs/contracts/*.md)'
    );
    ok = false;
  }

  const refs = [];
  const seen = new Set();
  for (const match of content.matchAll(/\]\(((?:\.\/)?docs\/contracts\/[a-zA-Z0-9_.-]+\.md)\)/g)) {
    const relPath = match[1].replace(/^\.\//, '');
    if (!seen.has(relPath)) {
      seen.add(relPath);
      refs.push(relPath);
    }
  }

  if (refs.length < MIN_CONTRACT_LINKS) {
    console.error(`FAIL AGENTS.md: expected at least ${MIN_CONTRACT_LINKS} docs/contracts/*.md links, found ${refs.length}`);
    ok = false;
  }

  for (const relPath of refs) {
    const absPath = join(REPO_ROOT, relPath);
    if (!existsSync(absPath)) {
      console.error(`FAIL AGENTS.md: missing referenced contract file ${relPath}`);
      ok = false;
      continue;
    }
    const contractText = readFileSync(absPath, 'utf8');
    if (contractText.trim().length === 0) {
      console.error(`FAIL AGENTS.md: referenced contract file ${relPath} is empty`);
      ok = false;
    }
  }

  if (ok) {
    console.log(`Contracts check OK: ${refs.length} on-demand contract files verified`);
  }
  return ok;
}

function checkRuleFiles(plugins) {
  const ruleFiles = [];
  const rootAgents = join(REPO_ROOT, 'AGENTS.md');
  if (existsSync(rootAgents)) {
    ruleFiles.push({ label: 'AGENTS.md', path: rootAgents, byteCap: ROOT_AGENTS_BYTE_CAP, isRootAgents: true });
  }

  for (const p of plugins) {
    const rulesDir = join(p.dir, 'rules');
    if (!existsSync(rulesDir)) continue;
    for (const file of readdirSync(rulesDir).sort()) {
      if (file.endsWith('.md')) {
        ruleFiles.push({
          label: `plugins/${p.dirName}/rules/${file}`,
          path: join(rulesDir, file),
          byteCap: RULE_BYTE_CAP,
          isRootAgents: false,
        });
      }
    }
  }

  let ok = true;
  for (const rf of ruleFiles) {
    const content = readFileSync(rf.path, 'utf8');
    const bytes = Buffer.byteLength(content, 'utf8');
    const hasFrontmatter = /^---\r?\n/.test(content);
    let rootOk = true;
    if (hasFrontmatter) {
      console.error(`FAIL ${rf.label}: standalone rule file must not contain YAML frontmatter`);
      ok = false;
    }
    if (rf.isRootAgents) {
      rootOk = checkRootContracts(content);
      if (!rootOk) ok = false;
    }
    if (bytes >= rf.byteCap) {
      console.error(`FAIL ${rf.label}: ${bytes} bytes exceeds ${rf.byteCap}-byte cap`);
      ok = false;
    } else if (!hasFrontmatter && rootOk) {
      if (rf.isRootAgents) {
        console.log(`Rule check OK: ${rf.label} (${bytes} / ${rf.byteCap} bytes, no frontmatter, no @-includes)`);
      } else {
        console.log(`Rule check OK: ${rf.label} (${bytes} / ${rf.byteCap} bytes, no frontmatter)`);
      }
    }
  }
  return ok;
}

function runValidate(plugins) {
  let ok = checkRuleFiles(plugins);
  for (const p of plugins) {
    console.log(`\n==> Validating plugins/${p.dirName}`);
    const res = spawnSync('agy', ['plugin', 'validate', p.dir, '--strict'], {
      cwd: REPO_ROOT,
      stdio: 'inherit',
    });
    if (res.status !== 0) {
      ok = false;
    }
  }
  return ok;
}

function runTests(plugins) {
  let ok = true;
  for (const p of plugins) {
    if (!p.hasPkgTest) {
      console.log(`==> Skipping tests for plugins/${p.dirName} (no scripts.test)`);
      continue;
    }
    console.log(`\n==> Testing plugins/${p.dirName}`);
    const res = spawnSync('npm', ['test'], {
      cwd: p.dir,
      stdio: 'inherit',
    });
    if (res.status !== 0) {
      ok = false;
    }
  }
  return ok;
}

const mode = process.argv[2] || 'check';
const plugins = discoverPlugins();

if (mode === 'list') {
  for (const p of plugins) {
    console.log(`${p.dirName}\t${p.name}${p.version ? `@${p.version}` : ''}\tplugins/${p.dirName}`);
  }
  process.exit(0);
}

if (plugins.length === 0) {
  console.error('No plugins found under plugins/');
  process.exit(1);
}

let success = true;
if (mode === 'validate') {
  success = runValidate(plugins);
} else if (mode === 'test') {
  success = runTests(plugins);
} else if (mode === 'check') {
  success = runValidate(plugins) && runTests(plugins);
} else {
  console.error(`Unknown mode: ${mode}. Expected one of: check, validate, test, list`);
  process.exit(1);
}

process.exit(success ? 0 : 1);
