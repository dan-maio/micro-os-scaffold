'use strict';

/*
 * The StateOS stdc++ package (--stdcpp) for a workspace scaffolded from the
 * restructured source: the package in <dest>/third_party/stateos-stdc++/, a
 * CMake block in each platform's tests/tests.cmake, and, where µTest++ was
 * integrated, the starter test platforms/<p>/tests/mtp-stdcpp/.
 */

const fs = require('node:fs');
const path = require('node:path');

const { copyTree, ensureDir, isFile, writeFile } = require('../util');
const stdcpp = require('../stdcpp');
const mtp = require('../micro-test-plus');
const { KERNEL_DIR } = require('./discover');

const TEMPLATES = path.join(__dirname, '..', '..', 'templates', 'stdcpp');
const LIBRARY = 'stateos-stdc++';

function cmakeBlock(relative) {
  return [
    '',
    `# ---- stateos-stdc++ (${stdcpp.MARK}) ------------------------------------`,
    "# The StateOS stdc++ package adapted to µOS++ III (the workspace's",
    "# third_party/stateos-stdc++). Its include directory goes BEFORE the",
    "# toolchain's C++ headers: it provides <bits/gthr-default.h> and the",
    '# kernel-backed C++20 <barrier>/<latch>/<semaphore>. An INTERFACE library:',
    '# a test that links it (board_test_libs) compiles its sources too.',
    `set (_stateos_stdcpp "\${CMAKE_CURRENT_LIST_DIR}/${relative}")`,
    'if (NOT IS_DIRECTORY "${_stateos_stdcpp}")',
    '  message (FATAL_ERROR "stateos-stdc++ not found at ${_stateos_stdcpp}")',
    'endif ()',
    `if (NOT TARGET ${LIBRARY})`,
    '  add_subdirectory ("${_stateos_stdcpp}" "${CMAKE_BINARY_DIR}/stateos-stdc++-bin")',
    'endif ()',
    '',
  ].join('\n');
}

function patchLibsHook(text, hook, mtpLibrary) {
  const branch = [
    `  # ${stdcpp.STARTER} (${stdcpp.MARK}): the stdc++ package on top of µTest++.`,
    `  if (_app STREQUAL "${stdcpp.STARTER}")`,
    `    set (\${_out} ${LIBRARY} ${mtpLibrary} PARENT_SCOPE)`,
    '    return ()',
    '  endif ()',
  ].join('\n');
  const pattern = new RegExp(`(^function\\s*\\(\\s*${hook}\\s+_app\\s+_out\\s*\\)[^\\n]*\\n)`, 'm');
  if (pattern.test(text)) return text.replace(pattern, `$1${branch}\n`);
  return `${text}\nfunction (${hook} _app _out)\n${branch}\n  set (\${_out} "" PARENT_SCOPE)\nendfunction ()\n`;
}

function integrateStdcppV2({ destination, selection, pkg, mtpRecord, log = console.log }) {
  const record = {
    spec: pkg.spec,
    kind: pkg.kind,
    ref: pkg.ref,
    destination: stdcpp.PACKAGE_DEST.replaceAll(path.sep, '/'),
    platforms: [],
  };
  const dest = path.join(destination, stdcpp.PACKAGE_DEST);
  fs.rmSync(dest, { recursive: true, force: true });
  copyTree(pkg.root, dest, { excludeRel: (r) => r === '.git' || r.startsWith('.git/') });
  const integrated = new Set(
    (mtpRecord?.platforms ?? []).filter((p) => p.status?.startsWith('integrated')).map((p) => p.platform)
  );
  const testsDir = path.join(destination, KERNEL_DIR, 'tests');
  for (const entry of selection) {
    const platform = entry.platform;
    if (!platform.usesBuilder) continue;
    const item = { platform: platform.id, status: 'wired' };
    record.platforms.push(item);
    const testDir = path.join(testsDir, 'platforms', platform.id, 'tests');
    const testsCmake = path.join(testDir, 'tests.cmake');
    if (!isFile(testsCmake)) {
      item.status = 'skipped';
      item.why = 'the platform has no tests/tests.cmake';
      continue;
    }
    let text = fs.readFileSync(testsCmake, 'utf8');
    const withMtp = integrated.has(platform.id);
    if (!text.includes(stdcpp.MARK)) {
      const hook = platform.arch === 'posix-arch' ? 'board_test_libraries' : 'board_test_libs';
      if (withMtp) text = patchLibsHook(text, hook, mtp.LIBRARY);
      text += cmakeBlock(path.relative(testDir, dest).replaceAll(path.sep, '/'));
      writeFile(testsCmake, text);
    }
    if (!withMtp) {
      item.why = 'no µTest++ on this platform: the library is wired, no starter test';
      continue;
    }
    const dir = path.join(testDir, stdcpp.STARTER);
    ensureDir(dir);
    for (const name of fs.readdirSync(path.join(TEMPLATES, stdcpp.STARTER))) {
      writeFile(path.join(dir, name), fs.readFileSync(path.join(TEMPLATES, stdcpp.STARTER, name), 'utf8'));
    }
    entry.added = [...(entry.added ?? []).filter((t) => t.app !== stdcpp.STARTER), { app: stdcpp.STARTER, kind: 'stdcpp' }];
    item.status = 'integrated';
    item.starter = path.relative(destination, dir).replaceAll(path.sep, '/');
  }
  for (const item of record.platforms) {
    log(`  stdcpp: ${item.platform.padEnd(30)} ${item.status}${item.why ? ` (${item.why})` : ''}`);
  }
  return record;
}

module.exports = { integrateStdcppV2 };
