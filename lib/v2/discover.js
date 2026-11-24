'use strict';

/*
 * Discovery for the restructured source workspace (2026-11, branch
 * align/smp-upstream): one kernel repository holding the whole test harness,
 * the ports and device packages one folder deeper, by architecture.
 *
 *   <source>/micro-os-plus-iii/                 kernel + tests/ (the harness)
 *   <source>/<arch>/micro-os-plus-iii-<arch>/   ports
 *   <source>/<dir>/micro-os-plus-iii-devices-* (folders): device packages
 *
 * A platform is micro-os-plus-iii/tests/platforms/<platform>/. Its tests are
 * its own tests/<test>/ folders plus the shared tests/sources/<test>/ named
 * in UOS_TESTS_SOURCES and UOS_TESTS_SUITES of its CMakeLists.txt. Its
 * configurations are the non-hidden entries of tests/package.json whose
 * platformName is the platform. See docs/specs/2026-11-24-new-source-layout-analysis.md.
 */

const fs = require('node:fs');
const path = require('node:path');

const { gitInfo, isDirectory, isFile, readJson } = require('../util');

const KERNEL_DIR = 'micro-os-plus-iii';
const PORT_ARCHS = ['aarch32', 'aarch64', 'cortexm', 'posix-arch', 'riscv'];

/** True when `source` has the new layout. */
function isV2Source(source) {
  return (
    isDirectory(path.join(source, KERNEL_DIR, 'tests', 'platforms')) &&
    isDirectory(path.join(source, KERNEL_DIR, 'tests', 'board-tests')) &&
    isFile(path.join(source, KERNEL_DIR, 'tests', 'package.json'))
  );
}

function read(file) {
  return isFile(file) ? fs.readFileSync(file, 'utf8') : '';
}

function stripComments(text) {
  return text.replace(/#[^\n]*/g, '');
}

/** The words of `set (NAME ...)` in a CMake file, or [] when it is absent. */
function cmakeList(text, name) {
  const match = new RegExp(`\\bset\\s*\\(\\s*${name}\\b([^)]*)\\)`, 'm').exec(stripComments(text));
  if (!match) return [];
  return match[1].split(/\s+/).filter((word) => word && !word.startsWith('$'));
}

/**
 * Every package folder with a package.json: <source>/<dir>/micro-os-plus-iii-*\/
 * (the source workspace's layout, by architecture), or
 * <source>/micro-os-plus-iii-*\/ beside the kernel (git URLs are cloned as
 * siblings). A package found both ways is taken once, from the deeper folder.
 */
function discoverPackages(source) {
  const packages = [];
  const add = (dir, relative, name) => {
    const json = readJson(path.join(dir, 'package.json'), null);
    if (!json?.name || packages.some((p) => p.id === name)) return;
    const suffix = name.slice('micro-os-plus-iii-'.length);
    packages.push({
      id: name,
      npmName: json.name,
      version: json.version ?? null,
      dir: relative,
      kind: suffix.startsWith('devices-') ? 'devices' : PORT_ARCHS.includes(suffix) ? 'port' : 'other',
      arch: PORT_ARCHS.includes(suffix) ? suffix : null,
      git: gitInfo(dir),
    });
  };
  const top = fs.readdirSync(source, { withFileTypes: true }).filter(
    (e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== KERNEL_DIR
  );
  for (const group of top) {
    const groupDir = path.join(source, group.name);
    for (const entry of fs.readdirSync(groupDir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith('micro-os-plus-iii-')) {
        add(path.join(groupDir, entry.name), `${group.name}/${entry.name}`, entry.name);
      }
    }
  }
  for (const entry of top) {
    if (entry.name.startsWith('micro-os-plus-iii-')) add(path.join(source, entry.name), entry.name, entry.name);
  }
  return packages.sort((a, b) => a.dir.localeCompare(b.dir));
}

/** What a platform's dependencies-folders.cmake names. */
function platformDependencies(platformDir) {
  const text = stripComments(read(path.join(platformDir, 'cmake', 'dependencies-folders.cmake')));
  const packages = [...text.matchAll(/xpacks\/@micro-os-plus\/(micro-os-plus-iii-[a-z0-9-]+)/g)].map((m) => m[1]);
  const sources = [...text.matchAll(/\$\{CMAKE_SOURCE_DIR\}\/sources\/([A-Za-z0-9_.-]+)/g)].map((m) => m[1]);
  const testXpacks = [...text.matchAll(/\$\{CMAKE_SOURCE_DIR\}\/xpacks\/(@[a-z0-9-]+\/[A-Za-z0-9_.-]+)/g)].map((m) => m[1]);
  const buildXpacks = [...text.matchAll(/\$\{CMAKE_BINARY_DIR\}\/xpacks\/(@xpacks\/[A-Za-z0-9_.-]+)/g)].map((m) => m[1]);
  return {
    packages: [...new Set(packages)],
    sources: [...new Set(sources)],
    testXpacks: [...new Set(testXpacks)],
    buildXpacks: [...new Set(buildXpacks)],
  };
}

/** Resolve one configuration of tests/package.json, following `inherit`. */
function resolveConfiguration(all, name, seen = new Set()) {
  const entry = all[name];
  if (!entry || seen.has(name)) return { properties: {}, devDependencies: {}, actions: {} };
  seen.add(name);
  const merged = { properties: {}, devDependencies: {}, actions: {} };
  for (const parent of entry.inherit ?? []) {
    const base = resolveConfiguration(all, parent, seen);
    Object.assign(merged.properties, base.properties);
    Object.assign(merged.devDependencies, base.devDependencies);
    Object.assign(merged.actions, base.actions);
  }
  Object.assign(merged.properties, entry.properties ?? {});
  Object.assign(merged.devDependencies, entry.devDependencies ?? {});
  Object.assign(merged.actions, entry.actions ?? {});
  return merged;
}

function discoverConfigurations(testsDir) {
  const json = readJson(path.join(testsDir, 'package.json'), {});
  const all = json.xpack?.buildConfigurations ?? {};
  const byPlatform = new Map();
  for (const [name, entry] of Object.entries(all)) {
    if (entry.hidden) continue;
    const resolved = resolveConfiguration(all, name);
    const platform = resolved.properties.platformName;
    if (!platform) continue;
    const configuration = {
      name,
      platform,
      buildType: resolved.properties.buildType ?? 'Debug',
      toolchainFileName: resolved.properties.toolchainFileName ?? null,
      inherit: entry.inherit ?? [],
      // Tools the configuration pins (compiler, QEMU, OpenOCD) and packages.
      devDependencies: Object.fromEntries(
        Object.entries(resolved.devDependencies).map(([key, value]) => [
          key,
          typeof value === 'string' ? value : value?.specifier ?? null,
        ])
      ),
      testAction: resolved.actions.test ?? null,
    };
    if (!byPlatform.has(platform)) byPlatform.set(platform, []);
    byPlatform.get(platform).push(configuration);
  }
  for (const list of byPlatform.values()) list.sort((a, b) => a.name.localeCompare(b.name));
  return { byPlatform, rootDevDependencies: json.xpack?.devDependencies ?? {} };
}

function discoverPlatform(testsDir, id) {
  const dir = path.join(testsDir, 'platforms', id);
  const cmakeText = read(path.join(dir, 'CMakeLists.txt'));
  const usesBuilder = /add_subdirectory\s*\([^)]*board-tests/.test(stripComments(cmakeText));
  const ownDir = path.join(dir, 'tests');
  const own = isDirectory(ownDir)
    ? fs
        .readdirSync(ownDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !['include', 'src'].includes(entry.name))
        .filter((entry) => fs.readdirSync(path.join(ownDir, entry.name)).some((f) => /\.(c|cc|cpp)$/.test(f)))
        .map((entry) => entry.name)
        .sort()
    : [];
  const portable = cmakeList(cmakeText, 'UOS_TESTS_SOURCES');
  const suites = cmakeList(cmakeText, 'UOS_TESTS_SUITES');
  const dependencies = platformDependencies(dir);
  const tests = [
    ...own.map((app) => ({ app, kind: 'board', path: `tests/platforms/${id}/tests/${app}` })),
    ...portable.filter((app) => !own.includes(app)).map((app) => ({ app, kind: 'portable', path: `tests/sources/${app}` })),
    ...suites.filter((app) => !own.includes(app) && !portable.includes(app)).map((app) => ({ app, kind: 'suite', path: `tests/sources/${app}` })),
  ];
  const port = dependencies.packages.find((name) => PORT_ARCHS.includes(name.slice('micro-os-plus-iii-'.length)));
  return {
    id,
    dir: `tests/platforms/${id}`,
    usesBuilder,
    // AArch: uos_tests_add_qemu/_hwd; Cortex-M: an inline add_test on
    // qemu-system-arm, and uos_tests_add_openocd for the board.
    hasQemu: /uos_tests_add_qemu\s*\(|\$\{PLATFORM_NAME\}-\$\{_app\}-qemu/.test(stripComments(cmakeText)),
    hasHwd: /uos_tests_add_(hwd|openocd)\s*\(/.test(stripComments(cmakeText)),
    port: port ?? null,
    arch: port ? port.slice('micro-os-plus-iii-'.length) : null,
    packages: dependencies.packages,
    sources: dependencies.sources,
    testXpacks: dependencies.testXpacks,
    buildXpacks: dependencies.buildXpacks,
    tests,
  };
}

/**
 * The model of a new-layout source workspace. Selection ids: `<p>` for a
 * platform (1-based, sorted) and `<p>.<t>` for a test of it.
 */
function discoverV2(source) {
  const sourceRoot = path.resolve(source);
  const kernelDir = path.join(sourceRoot, KERNEL_DIR);
  const testsDir = path.join(kernelDir, 'tests');
  const kernelJson = readJson(path.join(kernelDir, 'package.json'), {});
  const { byPlatform, rootDevDependencies } = discoverConfigurations(testsDir);
  const platforms = fs
    .readdirSync(path.join(testsDir, 'platforms'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => discoverPlatform(testsDir, entry.name))
    .sort((a, b) => a.id.localeCompare(b.id));
  platforms.forEach((platform, index) => {
    platform.selectionId = String(index + 1);
    platform.configurations = byPlatform.get(platform.id) ?? [];
    platform.tests.forEach((test, t) => {
      test.selectionId = `${platform.selectionId}.${t + 1}`;
    });
  });
  return {
    layout: 'v2',
    sourceRoot,
    kernel: {
      id: KERNEL_DIR,
      dir: KERNEL_DIR,
      npmName: kernelJson.name ?? null,
      version: kernelJson.version ?? null,
      git: gitInfo(kernelDir),
    },
    packages: discoverPackages(sourceRoot),
    platforms,
    testsDevDependencies: rootDevDependencies,
  };
}

function printDiscoveryV2(discovery, log = console.log) {
  const k = discovery.kernel;
  log(`Source workspace (new layout): ${discovery.sourceRoot}`);
  log(`  kernel  ${k.dir}  ${k.npmName ?? ''} ${k.version ?? ''}${k.git?.commit ? ` @${k.git.commit}` : ''}`);
  for (const pkg of discovery.packages) {
    log(`  ${pkg.kind.padEnd(7)} ${pkg.dir}  ${pkg.version ?? ''}${pkg.git?.commit ? ` @${pkg.git.commit}` : ''}`);
  }
  log('');
  log('Platforms (micro-os-plus-iii/tests/platforms/):');
  for (const platform of discovery.platforms) {
    const flags = [platform.hasQemu ? 'qemu' : null, platform.hasHwd ? 'hwd' : null].filter(Boolean).join('+') || 'host/upstream';
    log(
      `  ${platform.selectionId.padStart(3)}  ${platform.id.padEnd(30)} ${(platform.arch ?? '-').padEnd(10)} ${flags.padEnd(9)} ` +
        `${platform.tests.length} tests, ${platform.configurations.length} configurations`
    );
    for (const test of platform.tests) {
      log(`         ${test.selectionId.padEnd(7)} ${test.app}  (${test.kind})`);
    }
  }
}

module.exports = { isV2Source, discoverV2, printDiscoveryV2, cmakeList, resolveConfiguration, KERNEL_DIR };
