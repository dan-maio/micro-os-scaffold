'use strict';

/*
 * --stdcpp: the StateOS stdc++ package adapted to µOS++ III.
 *
 * The libstdc++ parts a bare-metal target does not get from the toolchain:
 * the gthread layer (std::thread, std::mutex, std::condition_variable,
 * std::call_once), std::future/promise/async/packaged_task, the chrono
 * clocks, emulated thread_local storage, and C++20 <barrier>/<latch>/
 * <semaphore>, over the kernel's objects.
 *
 * The package is bundled (templates/stdcpp/stateos-stdc++, the copy used and
 * verified in micro-os-scaffold-ctest-examples on the Raspberry Pi 4 B, the
 * Pico 2 and the WeAct F411CE); --stdcpp-from takes another folder or a git
 * URL. It goes to <workspace>/third_party/stateos-stdc++, unchanged, and every
 * board that took µTest++ gets:
 *   - a stateos-stdc++ block in its tests.cmake (add_subdirectory of the
 *     package: an INTERFACE library, compiled into each test that links it);
 *   - one branch in its library hook: mtp-stdcpp links stateos-stdc++ and
 *     µTest++;
 *   - the starter test mtp-stdcpp (the six verified suites).
 * Without --micro-test-plus only the library is wired; a test links it from
 * the library hook by hand.
 */

const fs = require('node:fs');
const path = require('node:path');

const { copyTree, ensureDir, isDirectory, isFile, writeFile } = require('./util');
const microTestPlus = require('./micro-test-plus');

const TEMPLATES = path.join(__dirname, '..', 'templates', 'stdcpp');
const BUNDLED = path.join(TEMPLATES, 'stateos-stdc++');
const PACKAGE_DEST = path.join('third_party', 'stateos-stdc++');
const LIBRARY = 'stateos-stdc++';
const STARTER = 'mtp-stdcpp';
const MARK = 'micro-os-scaffold --stdcpp';

/** A package folder holds CMakeLists.txt, include/bits/gthr-default.h and src/gthread.cc. */
function packageRoot(dir) {
  const ok =
    isFile(path.join(dir, 'CMakeLists.txt')) &&
    isFile(path.join(dir, 'include', 'bits', 'gthr-default.h')) &&
    isFile(path.join(dir, 'src', 'gthread.cc'));
  return ok ? dir : null;
}

/**
 * Where the package comes from: the bundled copy, a folder, or a git
 * repository (cloned into the scaffold cache; a repository may hold the
 * package at its root or under third_party/stateos-stdc++).
 */
function resolvePackage(from, ref, log = console.log) {
  if (!from) {
    return { spec: 'bundled', kind: 'bundled', root: BUNDLED, ref: null };
  }
  if (microTestPlus.isGitUrl(from)) {
    const cache = path.join(
      process.env.SCAFFOLD_CACHE ?? path.join(require('node:os').homedir(), '.cache', 'micro-os-scaffold'),
      'stateos-stdc++',
      require('node:crypto').createHash('sha1').update(`${from}#${ref ?? ''}`).digest('hex').slice(0, 12)
    );
    const { execFileSync } = require('node:child_process');
    if (!isDirectory(path.join(cache, '.git'))) {
      fs.rmSync(cache, { recursive: true, force: true });
      ensureDir(path.dirname(cache));
      const args = ['clone', '--depth', '1'];
      if (ref) args.push('--branch', ref);
      execFileSync('git', [...args, from, cache], { stdio: 'inherit' });
      log(`  stdcpp: cloned ${from}${ref ? ` (${ref})` : ''}`);
    }
    const root = packageRoot(cache) ?? packageRoot(path.join(cache, 'third_party', 'stateos-stdc++'));
    if (!root) throw new Error(`--stdcpp-from ${from}: no stateos-stdc++ package in the repository`);
    return { spec: from, kind: 'git', root, ref: ref ?? null };
  }
  const dir = path.resolve(from);
  const root = packageRoot(dir) ?? packageRoot(path.join(dir, 'third_party', 'stateos-stdc++'));
  if (!root) {
    throw new Error(
      `--stdcpp-from ${from}: not a stateos-stdc++ package (CMakeLists.txt, include/bits/gthr-default.h, src/gthread.cc)`
    );
  }
  return { spec: dir, kind: 'folder', root, ref: null };
}

function cmakeBlock() {
  return [
    '',
    `# ---- stateos-stdc++ (${MARK}) ------------------------------------`,
    '# The StateOS stdc++ package adapted to µOS++ III (the workspace\'s',
    '# third_party/stateos-stdc++). Its include directory goes BEFORE the',
    '# toolchain\'s C++ headers: it provides <bits/gthr-default.h> and the',
    '# kernel-backed C++20 <barrier>/<latch>/<semaphore>. An INTERFACE library:',
    '# a test that links it (board_test_libs) compiles its sources too.',
    'set (_stateos_stdcpp "${CMAKE_CURRENT_LIST_DIR}/../../../third_party/stateos-stdc++")',
    'if (NOT IS_DIRECTORY "${_stateos_stdcpp}")',
    '  message (FATAL_ERROR "stateos-stdc++ not found at ${_stateos_stdcpp}")',
    'endif ()',
    `if (NOT TARGET ${LIBRARY})`,
    '  add_subdirectory ("${_stateos_stdcpp}" "${CMAKE_BINARY_DIR}/stateos-stdc++-bin")',
    'endif ()',
    '',
  ].join('\n');
}

/** Put the mtp-stdcpp branch at the top of the library hook (before µTest++'s mtp-* branch). */
function patchLibsHook(text, hook, mtpLibrary) {
  const branch = [
    `  # ${STARTER} (${MARK}): the stdc++ package on top of µTest++.`,
    `  if (_app STREQUAL "${STARTER}")`,
    `    set (\${_out} ${LIBRARY} ${mtpLibrary} PARENT_SCOPE)`,
    '    return ()',
    '  endif ()',
  ].join('\n');
  const pattern = new RegExp(`(^function\\s*\\(\\s*${hook}\\s+_app\\s+_out\\s*\\)[^\\n]*\\n)`, 'm');
  if (pattern.test(text)) return text.replace(pattern, `$1${branch}\n`);
  return `${text}\nfunction (${hook} _app _out)\n${branch}\n  set (\${_out} "" PARENT_SCOPE)\nendfunction ()\n`;
}

function libsHookName(portDir) {
  const file = path.join(portDir, 'test', 'CMakeLists.txt');
  const text = isFile(file) ? fs.readFileSync(file, 'utf8').replace(/#[^\n]*/g, '') : '';
  return text.match(/function\s*\(\s*(board_test_lib(?:s|raries))\b/)?.[1] ?? 'board_test_libs';
}

function rel(destination, file) {
  return path.relative(destination, file).replaceAll(path.sep, '/');
}

/**
 * Copy the package, wire it into the boards that took µTest++ (or, without
 * µTest++, into every selected board-test platform), add mtp-stdcpp.
 */
function integrate(config, destination, pkg, options = {}) {
  const log = options.log ?? console.log;
  const record = {
    spec: pkg.spec,
    kind: pkg.kind,
    ref: pkg.ref,
    destination: PACKAGE_DEST.replaceAll(path.sep, '/'),
    boards: [],
  };
  config.stdcpp = record;

  const dest = path.join(destination, PACKAGE_DEST);
  fs.rmSync(dest, { recursive: true, force: true });
  copyTree(pkg.root, dest, { excludeRel: (r) => r === '.git' || r.startsWith('.git/') });

  const mtp = config.microTestPlus;
  const mtpBoards = new Map(
    (mtp?.boards ?? [])
      .filter((entry) => entry.status?.startsWith('integrated'))
      .map((entry) => [entry.platform, entry])
  );

  const cmakeProjects = (config.projects ?? []).filter(
    (project) =>
      project.role !== 'kernel' &&
      project.buildSystem === 'cmake' &&
      (config.selectedProjects ?? []).includes(project.id)
  );
  for (const project of cmakeProjects) {
    const portDir = path.join(destination, project.scaffoldName);
    const hook = libsHookName(portDir);
    for (const platform of project.platforms ?? []) {
      if (!(config.selectedPlatforms ?? []).includes(platform.id)) continue;
      const board = platform.board;
      if (!board || !(platform.tests ?? []).some((test) => test.kind === 'board-test')) continue;
      const entry = { platform: platform.id, board, status: 'wired' };
      record.boards.push(entry);
      const testDir = path.join(portDir, 'test', board);
      const testsCmake = path.join(testDir, 'tests.cmake');
      if (!isFile(testsCmake)) {
        entry.status = 'skipped';
        entry.why = `no ${rel(destination, testsCmake)}`;
        continue;
      }
      let text = fs.readFileSync(testsCmake, 'utf8');
      const mtpEntry = mtpBoards.get(platform.id);
      if (!text.includes(MARK)) {
        if (mtpEntry) text = patchLibsHook(text, hook, 'uos-micro-test-plus');
        text += cmakeBlock();
        writeFile(testsCmake, text);
      }
      entry.tests = rel(destination, testsCmake);
      if (!mtpEntry) {
        entry.why = 'no µTest++ on this board: the library is wired, no starter test';
        continue;
      }

      // The starter test, with the variants µTest++ gave this board.
      const dir = path.join(testDir, STARTER);
      ensureDir(dir);
      for (const name of fs.readdirSync(path.join(TEMPLATES, STARTER))) {
        writeFile(path.join(dir, name), fs.readFileSync(path.join(TEMPLATES, STARTER, name), 'utf8'));
      }
      const variants = [
        ...new Set(
          (mtpEntry.ctest ?? [])
            .filter((name) => name.startsWith(`${platform.id}-${microTestPlus.EXAMPLE}-`))
            .map((name) => name.slice(`${platform.id}-${microTestPlus.EXAMPLE}-`.length))
        ),
      ];
      const variantPattern = variants.length === 1 ? variants[0] : `(${variants.join('|')})`;
      const pattern = `^${platform.id}-${STARTER}-${variantPattern}$`;
      for (const configuration of config.build?.configurations ?? []) {
        if (configuration.platform !== platform.id) continue;
        configuration.tests = (configuration.tests ?? []).filter((test) => test.app !== STARTER);
        configuration.tests.push({ app: STARTER, selectionId: null, ctestPattern: pattern, kind: 'stdcpp' });
      }
      config.selectedTests = (config.selectedTests ?? []).filter(
        (test) => !(test.platform === platform.id && test.app === STARTER)
      );
      config.selectedTests.push({
        selectionId: null,
        project: project.id,
        platform: platform.id,
        board,
        app: STARTER,
        ctestPattern: pattern,
        kind: 'stdcpp',
      });
      entry.status = 'integrated';
      entry.starter = rel(destination, dir);
      entry.ctest = variants.map((variant) => `${platform.id}-${STARTER}-${variant}`);
    }
  }
  if (!record.boards.length) log('  stdcpp: no CMake board-test platform selected; only the package was copied');
  return record;
}

function printSummary(record, log = console.log) {
  if (!record) return;
  log(`  stdcpp: StateOS stdc++ from ${record.spec}${record.ref ? ` (${record.ref})` : ''} -> ${record.destination}`);
  for (const entry of record.boards) {
    const label = `${entry.platform}`.padEnd(30);
    log(`    ${label} ${entry.status}${entry.starter ? `, ${entry.starter}` : ''}${entry.why ? ` (${entry.why})` : ''}`);
  }
}

/** The "StateOS stdc++" section of a workspace README. */
function readmeSection(config) {
  const record = config.stdcpp;
  if (!record) return '';
  const code = (value) => `\`${value}\``;
  const lines = ['## StateOS stdc++ (`--stdcpp`)', ''];
  lines.push(
    `This workspace was scaffolded with ${code('--stdcpp')}: the StateOS stdc++ package adapted to`,
    `µOS++ III is in ${code(`${record.destination}/`)} (from ${record.spec === 'bundled' ? 'the copy bundled with micro-os-scaffold' : code(record.spec)}).`,
    'It provides what the toolchain leaves out on bare metal: the GCC gthread layer',
    '(`std::thread`, `std::mutex`, `std::condition_variable`, `std::call_once`),',
    '`std::future`/`promise`/`async`/`packaged_task`, the `system_clock`/`steady_clock`',
    'over the kernel clock, emulated `thread_local`, and C++20 `<barrier>`, `<latch>`,',
    '`<semaphore>`, all over the kernel\'s objects. Its `README.md` describes the design.',
    '',
    '| Platform | Board | stdc++ | Starter test (CTest) |',
    '| --- | --- | --- | --- |'
  );
  for (const entry of record.boards) {
    lines.push(
      `| ${code(entry.platform)} | ${code(entry.board)} | ${entry.status}${entry.why ? ` (${entry.why})` : ''} | ` +
        `${entry.ctest?.length ? entry.ctest.map(code).join(', ') : '—'} |`
    );
  }
  lines.push(
    '',
    '`mtp-stdcpp` is a µTest++ test of six suites: `std::thread` and TLS, promise/future,',
    'packaged_task/async, mutexes and `call_once`, the synchronisation primitives',
    '(condition variable, semaphores, latch, barrier), and chrono. The same suites were',
    'verified on the Raspberry Pi 4 B (4 cores), the Pico 2 (2 cores) and the WeAct F411CE',
    '(1 core). On a board whose other cores the µTest++ support can start, they join the',
    'scheduler first.',
    '',
    'To use the package from another test, return it from the board\'s library hook in',
    '`tests.cmake`, as the `mtp-stdcpp` branch does:',
    '',
    '```cmake',
    'if (_app STREQUAL "my-test")',
    `  set (\${_out} ${LIBRARY} PARENT_SCOPE)   # add uos-micro-test-plus for a µTest++ test`,
    '  return ()',
    'endif ()',
    '```',
    '',
    'On the RP2040/RP2350 a `std::atomic` read-modify-write (`fetch_add`, `exchange`)',
    'does not exclude the other core; use the package\'s mutexes, or the µTest++ support\'s',
    '`mtp_board::atomic_add ()`, for data two cores update.',
    ''
  );
  return `${lines.join('\n')}\n`;
}

module.exports = {
  resolvePackage,
  integrate,
  printSummary,
  readmeSection,
  PACKAGE_DEST,
  STARTER,
  MARK,
};
