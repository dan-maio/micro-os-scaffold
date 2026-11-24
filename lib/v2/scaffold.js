'use strict';

/*
 * Scaffolding from the restructured source (see discover.js and
 * docs/specs/2026-11-24-new-source-layout-analysis.md).
 *
 * The workspace mirrors the source:
 *
 *   <dest>/micro-os-plus-iii/            the kernel, complete; tests/ pruned
 *   <dest>/<arch>/micro-os-plus-iii-*    the port and device packages the
 *                                        selected platforms name
 *   <dest>/third_party/                  options (--micro-test-plus, --stdcpp)
 *   <dest>/run.sh, scripts/env.sh        the one entry point, the tool paths
 *   <dest>/scaffold.json, README.md
 *
 * Lean pruning: tests/platforms/ keeps the selected platforms; a platform
 * keeps its selected own tests, and its UOS_TESTS_* lists and
 * dependencies-folders.cmake keep the selected shared tests;
 * tests/sources/ keeps what the kept platforms still name.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { copyTree, ensureDir, isDirectory, isFile, run, writeFile, writeJson } = require('../util');
const { KERNEL_DIR } = require('./discover');
const local = require('./local');

const TEMPLATE_RUN = path.join(__dirname, '..', '..', 'templates', 'v2', 'run.sh');
const XPACKS_STORE = process.env.XPACKS_STORE ?? path.join(os.homedir(), '.local', 'xPacks');

/** The `set (NAME ...)` lists the builder reads. */
const TEST_LISTS = ['UOS_TESTS_SOURCES', 'UOS_TESTS_PORTABLE', 'UOS_TESTS_STORAGE', 'UOS_TESTS_SUITES'];

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function read(file) {
  return isFile(file) ? fs.readFileSync(file, 'utf8') : '';
}

/** A symbolic link whose target is missing (the source has some). */
function isDanglingLink(file) {
  try {
    if (!fs.lstatSync(file).isSymbolicLink()) return false;
    fs.statSync(file);
    return false;
  } catch {
    return true;
  }
}

// -----------------------------------------------------------------------------
// Selection

/**
 * `tokens`: platform ids or selection ids, optionally `.test` (by name or by
 * number): `cortexm-weactf411`, `cortexm-weactf411.spi-pipeline`, `13`,
 * `13.2`. Returns [{ platform, apps: [...] | null }] (null: every test).
 */
function resolveSelectionV2(discovery, tokens) {
  const byPlatform = new Map();
  for (const raw of tokens) {
    const token = raw.trim();
    if (!token) continue;
    const dot = token.indexOf('.');
    // A platform id may itself contain no dot; a numeric id is `p` or `p.t`.
    let platform;
    let test = null;
    if (/^\d+(\.\d+)?$/.test(token)) {
      const [p, t] = token.split('.');
      platform = discovery.platforms.find((item) => item.selectionId === p);
      if (t) test = platform?.tests.find((item) => item.selectionId === `${p}.${t}`)?.app ?? null;
      if (t && !test) throw new Error(`No test ${token}`);
    } else {
      const head = dot < 0 ? token : token.slice(0, dot);
      platform = discovery.platforms.find((item) => item.id === head);
      if (dot >= 0) {
        test = token.slice(dot + 1);
        if (!platform?.tests.some((item) => item.app === test)) {
          throw new Error(`Platform ${head} has no test ${test} (try: discover)`);
        }
      }
    }
    if (!platform) throw new Error(`No platform '${token}' (try: discover)`);
    if (!byPlatform.has(platform.id)) byPlatform.set(platform.id, { platform, apps: [] });
    const entry = byPlatform.get(platform.id);
    if (test === null) entry.apps = null;
    else if (entry.apps) entry.apps.push(test);
  }
  return [...byPlatform.values()].map((entry) => ({
    platform: entry.platform,
    apps: entry.apps ? [...new Set(entry.apps)] : null,
  }));
}

/** The configurations to generate: the given names, else each platform's debug ones. */
function chooseConfigurations(selection, wanted) {
  const result = [];
  for (const { platform } of selection) {
    const all = platform.configurations;
    let chosen = wanted?.length ? all.filter((c) => wanted.includes(c.name)) : [];
    if (!chosen.length) {
      const preferred = [`${platform.id}-cmake-gcc-debug`, `${platform.id}-cmake-sys-debug`];
      chosen = all.filter((c) => preferred.includes(c.name)).slice(0, 1);
      if (!chosen.length) chosen = all.filter((c) => c.buildType === 'Debug').slice(0, 1);
      if (!chosen.length) chosen = all.slice(0, 1);
    }
    for (const configuration of chosen) result.push({ ...configuration, platformRef: platform });
  }
  return result;
}

// -----------------------------------------------------------------------------
// Tools

/** The newest installed version folder of an xPack, or the pinned one. */
function storePackageDir(scopeName, version) {
  const base = path.join(XPACKS_STORE, scopeName);
  if (!isDirectory(base)) return null;
  const versions = fs.readdirSync(base).filter((v) => isDirectory(path.join(base, v)));
  const plain = version && /^\d/.test(version) ? version : null;
  const fromSpecifier = version && /#v(.+)$/.exec(version)?.[1];
  for (const candidate of [plain, fromSpecifier]) {
    if (candidate && versions.includes(candidate)) return path.join(base, candidate);
  }
  versions.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return versions.length ? path.join(base, versions[versions.length - 1]) : null;
}

/** The bin/ folders of the tools a configuration pins (compiler, QEMU, OpenOCD). */
function toolDirsFor(configuration, testsDevDependencies) {
  const dirs = [];
  const add = (name, version) => {
    if (!name.startsWith('@xpack-dev-tools/')) return;
    const dir = storePackageDir(name, version);
    const bin = dir ? path.join(dir, '.content', 'bin') : null;
    if (bin && isDirectory(bin)) dirs.push(bin);
  };
  for (const [name, version] of Object.entries(configuration.devDependencies ?? {})) add(name, version);
  for (const [name, spec] of Object.entries(testsDevDependencies ?? {})) {
    add(name, typeof spec === 'string' ? spec : spec?.specifier);
  }
  return [...new Set(dirs)];
}

/** Per-configuration libraries a platform takes from build/<C>/xpacks/@xpacks/. */
function buildXpackVars(platform, configuration) {
  return platform.buildXpacks.map((lib) => {
    const variable = `UOS_LIB_${lib.replace(/^@xpacks\//, '').toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
    const dir = storePackageDir(lib, configuration.devDependencies?.[lib] ?? null);
    return { lib, variable, dir };
  });
}

// -----------------------------------------------------------------------------
// Copy and prune

function neededSources(selection, discovery) {
  const needed = new Set();
  for (const { platform, apps } of selection) {
    const keepApps = apps ?? platform.tests.map((t) => t.app);
    for (const test of platform.tests) {
      if (test.kind !== 'board' && keepApps.includes(test.app)) needed.add(test.app);
    }
    // Shared folders the platform names that are not tests of it (helpers).
    const testNames = new Set(platform.tests.map((t) => t.app));
    for (const source of platform.sources) if (!testNames.has(source)) needed.add(source);
  }
  // Every other platform's shared folders go, unless still needed here.
  return needed;
}

/**
 * The folders git ignores in `dir` (tool caches like .kilo/, build trees,
 * __pycache__/, host build output), except tests/xpacks/, which holds the
 * links the harness needs. Ignored single files are kept: the Wi-Fi tests'
 * firmware blobs are ignored downloads the build needs.
 */
function ignoredFolders(dir) {
  const result = run('git', ['-C', dir, 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory'], {
    timeout: 60000,
  });
  if (result.status !== 0) return [];
  return result.stdout
    .split('\n')
    .filter((line) => line.endsWith('/'))
    .map((line) => line.slice(0, -1))
    .filter((line) => line !== 'tests/xpacks' && !line.startsWith('tests/xpacks/'));
}

function copyKernel(discovery, destination, selection) {
  const src = path.join(discovery.sourceRoot, KERNEL_DIR);
  const dest = path.join(destination, KERNEL_DIR);
  const platforms = new Set(selection.map((s) => s.platform.id));
  const sources = neededSources(selection, discovery);
  const ignored = ignoredFolders(src);
  copyTree(src, dest, {
    excludeRel: (rel) => {
      const abs = path.join(src, rel);
      if (ignored.some((folder) => rel === folder || rel.startsWith(`${folder}/`))) return true;
      if (isDanglingLink(abs)) return true;
      if (rel === '.git' || rel.startsWith('.git/')) return true;
      if (/(^|\/)node_modules(\/|$)/.test(rel)) return true;
      if (rel === 'tests/build' || rel.startsWith('tests/build/')) return true;
      if (rel === 'build' || rel.startsWith('build/')) return true;
      // The tools: run.sh links the pinned ones itself.
      if (/^(tests\/)?xpacks\/(@xpack-dev-tools|\.bin)(\/|$)/.test(rel)) return true;
      const platform = /^tests\/platforms\/([^/]+)/.exec(rel)?.[1];
      if (platform && !platforms.has(platform)) return true;
      const source = /^tests\/sources\/([^/]+)/.exec(rel)?.[1];
      if (source && !sources.has(source)) return true;
      return false;
    },
  });
  return dest;
}

/** Rewrite `set (NAME ...)` to keep only `keep`; drop the call when empty. */
function filterCmakeList(text, name, keep) {
  const pattern = new RegExp(`set\\s*\\(\\s*${name}\\b([^)]*)\\)`, 'm');
  const match = pattern.exec(text);
  if (!match) return text;
  const words = match[1].split(/\s+/).filter(Boolean);
  const kept = words.filter((word) => word.startsWith('$') || keep.has(word));
  const lines = [];
  let line = `set (${name}`;
  for (const word of kept) {
    if (`${line} ${word}`.length > 78) {
      lines.push(line);
      line = `     ${word}`;
    } else {
      line += ` ${word}`;
    }
  }
  lines.push(`${line})`);
  return text.slice(0, match.index) + (kept.length ? lines.join('\n') : `set (${name})`) + text.slice(match.index + match[0].length);
}

function prunePlatform(destination, platform, apps) {
  if (!apps) return [];
  const notes = [];
  const keep = new Set(apps);
  const dir = path.join(destination, KERNEL_DIR, platform.dir);
  // Own tests: the selected ones, plus include/, src/ and folders tests.cmake names.
  const testsDir = path.join(dir, 'tests');
  if (isDirectory(testsDir)) {
    const topLevel = read(path.join(testsDir, 'tests.cmake'))
      .replace(/#[^\n]*/g, '')
      .replace(/\bfunction\s*\([\s\S]*?\bendfunction\s*\(\s*\)/g, '');
    for (const entry of fs.readdirSync(testsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || ['include', 'src'].includes(entry.name) || keep.has(entry.name)) continue;
      if (topLevel.includes(`/${entry.name}/`) || topLevel.includes(`/${entry.name}"`)) continue;
      if (!platform.tests.some((t) => t.kind === 'board' && t.app === entry.name)) continue;
      fs.rmSync(path.join(testsDir, entry.name), { recursive: true, force: true });
      notes.push(`${platform.dir}/tests/${entry.name}`);
    }
  }
  // Shared tests: the builder's lists, and the dependency folders.
  const cmakeFile = path.join(dir, 'CMakeLists.txt');
  let text = read(cmakeFile);
  const original = text;
  for (const list of TEST_LISTS) text = filterCmakeList(text, list, keep);
  if (text !== original) writeFile(cmakeFile, text);
  const depsFile = path.join(dir, 'cmake', 'dependencies-folders.cmake');
  const deps = read(depsFile);
  const testNames = new Set(platform.tests.map((t) => t.app));
  const kept = deps
    .split('\n')
    .filter((line) => {
      const source = /\$\{CMAKE_SOURCE_DIR\}\/sources\/([A-Za-z0-9_.-]+)/.exec(line)?.[1];
      return !source || !testNames.has(source) || keep.has(source);
    })
    .join('\n');
  if (kept !== deps) writeFile(depsFile, kept);
  return notes;
}

/**
 * micro-os-plus-iii/tests/xpacks/<package> for the tests' declared packages
 * (build-helper, chan-fatfs, the CMSIS validator, ...). The source workspace
 * has them from `xpm install` (links into the xPack store, copied with the
 * kernel); a fresh git clone has none, as the folder is git-ignored. A
 * missing one is copied from the store, at the version tests/package.json
 * declares (the newest installed one for a range).
 */
function materializeTestXpacks(discovery, destination, log) {
  const testsDir = path.join(destination, KERNEL_DIR, 'tests');
  const missing = [];
  for (const [name, spec] of Object.entries(discovery.testsDevDependencies ?? {})) {
    if (name.startsWith('@xpack-dev-tools/')) continue; // tools: run.sh links them
    const target = path.join(testsDir, 'xpacks', name);
    if (isDirectory(target)) continue;
    const dir = storePackageDir(name, typeof spec === 'string' ? spec : spec?.specifier);
    if (!dir) {
      missing.push(name);
      continue;
    }
    copyTree(dir, target, { excludeRel: (rel) => rel === '.git' || rel.startsWith('.git/') });
    log(`  tests/xpacks/${name}: from ${dir}`);
  }
  if (missing.length) {
    log(
      `  warning: not in the xPack store (${XPACKS_STORE}): ${missing.join(', ')}; ` +
        'run `xpm install` in a checkout of micro-os-plus-iii/tests once'
    );
  }
}

/** build-helper's toolchains: keep the files the configurations use. */
function pruneBuildHelper(destination, configurations) {
  const dir = path.join(destination, KERNEL_DIR, 'tests', 'xpacks', '@micro-os-plus', 'build-helper', 'cmake', 'toolchains');
  if (!isDirectory(dir)) return;
  const keep = new Set(configurations.map((c) => c.toolchainFileName).filter(Boolean));
  if (!keep.size) return;
  // A toolchain file may include a common one: keep what the kept files name.
  for (const name of [...keep]) {
    for (const m of read(path.join(dir, name)).matchAll(/([A-Za-z0-9_.-]+\.cmake)/g)) keep.add(m[1]);
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && !keep.has(entry.name)) fs.rmSync(path.join(dir, entry.name), { force: true });
  }
}

/**
 * Remove what a previous scaffold generated, so a test or a package no
 * longer selected does not linger: the kernel copy (its build trees kept),
 * the package copies the previous scaffold.json lists, the option packages.
 * Local paths are already set aside.
 */
function cleanGenerated(destination, previous) {
  const kernel = path.join(destination, KERNEL_DIR);
  if (isDirectory(kernel)) {
    for (const entry of fs.readdirSync(kernel)) {
      if (entry === 'tests') continue;
      fs.rmSync(path.join(kernel, entry), { recursive: true, force: true });
    }
    const tests = path.join(kernel, 'tests');
    if (isDirectory(tests)) {
      for (const entry of fs.readdirSync(tests)) {
        if (entry === 'build') continue;
        fs.rmSync(path.join(tests, entry), { recursive: true, force: true });
      }
    }
  }
  if (previous?.layout === 'v2') {
    for (const pkg of previous.packages ?? []) {
      if (pkg.dir && !pkg.dir.includes('..')) fs.rmSync(path.join(destination, pkg.dir), { recursive: true, force: true });
    }
  }
  for (const dir of ['third_party/micro-test-plus', 'third_party/stateos-stdc++', 'build-logs']) {
    fs.rmSync(path.join(destination, dir), { recursive: true, force: true });
  }
}

/** The local tests found after the restore, for scaffold.json; a local test replaces a shared one. */
function localRecord(destination, stashed, selection) {
  const testsDir = path.join(destination, KERNEL_DIR, 'tests');
  const tests = [];
  for (const test of stashed.list.tests) {
    const paths = [];
    for (const { platform } of selection) {
      if (test.platform && test.platform !== platform.id) continue;
      const rel = `${KERNEL_DIR}/tests/platforms/${platform.id}/tests/${test.name}`;
      if (!isDirectory(path.join(destination, rel))) continue;
      paths.push(rel);
      local.preferLocal(testsDir, platform.id, [test.name], filterCmakeList);
    }
    tests.push({ name: test.name, platform: test.platform, paths });
  }
  return {
    file: local.LIST,
    tests,
    keep: stashed.list.keep,
    hookFiles: stashed.found.hookFiles,
  };
}

function copyPackages(discovery, destination, selection) {
  const names = new Set(selection.flatMap((s) => s.platform.packages));
  const copied = [];
  for (const pkg of discovery.packages) {
    if (!names.has(pkg.id)) continue;
    const src = path.join(discovery.sourceRoot, pkg.dir);
    const ignored = ignoredFolders(src);
    copyTree(src, path.join(destination, pkg.dir), {
      excludeRel: (rel) =>
        ignored.some((folder) => rel === folder || rel.startsWith(`${folder}/`)) ||
        rel === '.git' ||
        rel.startsWith('.git/') ||
        /(^|\/)(node_modules|build)(\/|$)/.test(rel) ||
        rel.startsWith('xpacks/') ||
        isDanglingLink(path.join(src, rel)),
    });
    copied.push(pkg);
  }
  return copied;
}

// -----------------------------------------------------------------------------
// Generated files

function envScript(configurations, discovery, destination) {
  const lines = [
    '# GENERATED by micro-os-scaffold: the tool and library paths found when the',
    '# workspace was scaffolded. Override any of them in the environment.',
    '',
  ];
  const vars = new Map();
  for (const configuration of configurations) {
    for (const { variable, dir } of buildXpackVars(configuration.platformRef, configuration)) {
      if (dir) vars.set(variable, dir);
    }
  }
  for (const [variable, dir] of vars) lines.push(`export ${variable}="\${${variable}:-${dir}}"`);
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function runScript(configurations, selection, discovery) {
  const template = fs.readFileSync(TEMPLATE_RUN, 'utf8');
  const cases = [];
  const selects = [];
  for (const configuration of configurations) {
    const platform = configuration.platformRef;
    const entry = selection.find((s) => s.platform.id === platform.id);
    const apps = [...(entry.apps ?? platform.tests.map((t) => t.app)), ...(entry.added ?? []).map((t) => t.app)];
    const packages = platform.packages
      .map((name) => discovery.packages.find((p) => p.id === name))
      .filter(Boolean)
      .map((pkg) => shellQuote(`${pkg.id}:${pkg.dir}`));
    const toolDirs = toolDirsFor(configuration, discovery.testsDevDependencies).map(shellQuote);
    const buildXpacks = buildXpackVars(platform, configuration).map(({ lib, variable }) =>
      shellQuote(`${lib}:${variable}`)
    );
    cases.push(
      [
        `  ${shellQuote(configuration.name)})`,
        `    PLATFORM=${shellQuote(platform.id)}`,
        `    BUILD_TYPE=${shellQuote(configuration.buildType)}`,
        `    TOOLCHAIN=${shellQuote(configuration.toolchainFileName ?? '')}`,
        `    PACKAGES=(${packages.join(' ')})`,
        `    TOOL_DIRS=(${toolDirs.join(' ')})`,
        `    BUILD_XPACKS=(${buildXpacks.join(' ')})`,
        `    SELECTED_APPS=(${apps.map(shellQuote).join(' ')})`,
        '    ;;',
      ].join('\n')
    );
    for (const test of platform.tests) {
      selects.push(`    ${shellQuote(`${configuration.name}:${test.selectionId}`)}) printf '%s\\n' ${shellQuote(test.app)} ;;`);
    }
  }
  return template
    .replaceAll('__DEFAULT_CONFIG__', shellQuote(configurations[0]?.name ?? ''))
    .replace('__CONFIG_LIST__', configurations.map((c) => shellQuote(c.name)).join(' '))
    .replace('__CONFIG_CASES__', cases.join('\n'))
    .replace('__SELECT_CASES__', selects.join('\n'));
}

/**
 * Scaffold the selection into `destination`. Returns the manifest written to
 * scaffold.json.
 */
function scaffoldV2({ discovery, destination, selection, configurationNames, options = {}, log = console.log }) {
  ensureDir(destination);
  const configurations = chooseConfigurations(selection, configurationNames);
  if (!configurations.length) throw new Error('No configuration for the selected platform(s).');

  // Local tests (scripts/local-tests.txt): set aside before anything is
  // copied, put back after the copy, the pruning and the options.
  const stashed = local.stash(destination, log);
  let records = {};
  let pruned = [];
  let packages = [];
  try {
    cleanGenerated(destination, options.previous);
    log(`Copying the kernel (${KERNEL_DIR}/) ...`);
    copyKernel(discovery, destination, selection);
    materializeTestXpacks(discovery, destination, log);
    for (const { platform, apps } of selection) pruned.push(...prunePlatform(destination, platform, apps));
    pruneBuildHelper(destination, configurations);
    log('Copying the packages ...');
    packages = copyPackages(discovery, destination, selection);
    // The options (µTest++, stdc++): they add tests (entry.added) and records.
    records = options.integrate ? options.integrate(selection) ?? {} : {};
    const testsDir = path.join(destination, KERNEL_DIR, 'tests');
    for (const { platform } of selection) {
      if (platform.usesBuilder) local.patchHooks(testsDir, platform.id);
    }
  } finally {
    local.restore(destination, log);
  }
  if (stashed) records.localTests = localRecord(destination, stashed, selection);

  ensureDir(path.join(destination, 'scripts'));
  writeFile(path.join(destination, 'scripts', 'env.sh'), envScript(configurations, discovery, destination));
  writeFile(path.join(destination, 'run.sh'), runScript(configurations, selection, discovery), 0o755);

  const manifest = {
    schemaVersion: 2,
    layout: 'v2',
    generatedAt: new Date().toISOString(),
    generator: options.generator ?? null,
    sourceRoot: discovery.sourceRoot,
    destination,
    kernel: { dir: KERNEL_DIR, version: discovery.kernel.version, commit: discovery.kernel.git?.commit ?? null },
    packages: packages.map((p) => ({ id: p.id, dir: p.dir, version: p.version, commit: p.git?.commit ?? null })),
    selection: selection.map(({ platform, apps, added }) => ({
      platform: platform.id,
      apps: apps ?? platform.tests.map((t) => t.app),
      all: apps === null,
      tests: [
        ...platform.tests
          .filter((t) => (apps ?? platform.tests.map((x) => x.app)).includes(t.app))
          .map((t) => ({ app: t.app, kind: t.kind, selectionId: t.selectionId })),
        ...(added ?? []).map((t) => ({ app: t.app, kind: t.kind, selectionId: null })),
      ],
    })),
    configurations: configurations.map((c) => ({
      name: c.name,
      platform: c.platform,
      buildType: c.buildType,
      toolchainFileName: c.toolchainFileName,
    })),
    pruned,
    ...records,
  };
  writeJson(path.join(destination, 'scaffold.json'), manifest);
  return { manifest, configurations, packages };
}

module.exports = {
  resolveSelectionV2,
  chooseConfigurations,
  scaffoldV2,
  filterCmakeList,
  storePackageDir,
  toolDirsFor,
};
