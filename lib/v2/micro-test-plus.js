'use strict';

/*
 * µTest++ for a workspace scaffolded from the restructured source.
 *
 * Same rule and the same board support as lib/micro-test-plus.js (the old
 * layout); what moves is where things live:
 *
 *   framework      <dest>/third_party/micro-test-plus/
 *   board support  micro-os-plus-iii/tests/mtp/            (one copy)
 *   tests          micro-os-plus-iii/tests/platforms/<p>/tests/mtp-*\/
 *   CMake block    micro-os-plus-iii/tests/platforms/<p>/tests/tests.cmake
 *   command line   micro-os-plus-iii/tests/cmake/uos-tests-run.cmake: every
 *                  registration helper gives a mtp-* test its name as argv[0]
 *                  and --output-file <build>/mtp-reports/<ctest name>.tap
 *
 * The board checks read the SOURCE platform (before the lean pruning), so a
 * selection without the board's own tests is judged the same way.
 */

const fs = require('node:fs');
const path = require('node:path');

const { ensureDir, isDirectory, isFile, writeFile } = require('../util');
const mtp = require('../micro-test-plus');
const { KERNEL_DIR } = require('./discover');

const MARK = mtp.MARK;
const LIBRARY = mtp.LIBRARY;

function read(file) {
  return isFile(file) ? fs.readFileSync(file, 'utf8') : '';
}

function stripCmakeComments(text) {
  return text.replace(/#[^\n]*/g, '');
}

function filesUnder(dir, pattern = /\.(c|cc|cpp|S|s|hpp|h)$/) {
  const out = [];
  if (!isDirectory(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (/^(build|qemu|usb|wifi|net|third_party|tinyusb)/.test(entry.name)) continue;
      out.push(...filesUnder(full, pattern));
    } else if (pattern.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function rel(root, file) {
  return path.relative(root, file).replaceAll(path.sep, '/');
}

/** cmake/board.cmake, with ${CMAKE_SOURCE_DIR} = micro-os-plus-iii/tests. */
function boardFacts(testsDir, platform) {
  const platformDir = path.join(testsDir, 'platforms', platform.id);
  const text = stripCmakeComments(read(path.join(platformDir, 'cmake', 'board.cmake')));
  const value = (name) => {
    const match = text.match(new RegExp(`set\\s*\\(\\s*${name}\\s+"?([^")\\s]+)"?`));
    return match ? match[1].replaceAll('${CMAKE_SOURCE_DIR}', testsDir) : null;
  };
  return {
    platformDir,
    linkerHw: value('UOS_BOARD_LINKER_HW'),
    linkerQemu: value('UOS_BOARD_LINKER_QEMU'),
    ncpu: Number(value('UOS_BOARD_NCPU') ?? 1),
  };
}

/** The rule: constructors run, a heap for malloc, sbrk over it. */
function checkRuntime(discovery, platform) {
  const sourceRoot = discovery.sourceRoot;
  const kernelDir = path.join(sourceRoot, KERNEL_DIR);
  const testsDir = path.join(kernelDir, 'tests');
  const checks = [];
  const add = (rule, found, why) => checks.push(found ? { rule, ok: true, evidence: found } : { rule, ok: false, why });
  if (platform.arch === 'posix-arch') {
    add('hosted runtime', 'the host C library provides constructors, malloc and sbrk', null);
    return { ok: true, checks, carriesStartup: true, hosted: true, facts: boardFacts(testsDir, platform) };
  }
  const facts = boardFacts(testsDir, platform);
  const port = discovery.packages.find((p) => p.id === platform.port);
  const portDir = port ? path.join(sourceRoot, port.dir) : null;
  const bootFiles = [
    ...filesUnder(path.join(facts.platformDir, 'src')),
    ...filesUnder(path.join(facts.platformDir, 'glue')),
    ...filesUnder(path.join(facts.platformDir, 'tests', 'src')),
    ...(portDir ? filesUnder(path.join(portDir, 'src')) : []),
    ...filesUnder(path.join(kernelDir, 'src', 'startup')),
  ];
  const evidence = (files, pattern) => {
    const file = files.find((f) => pattern.test(read(f)));
    return file ? rel(sourceRoot, file) : null;
  };
  const ownTests = path.join(facts.platformDir, 'tests');
  const testMains = isDirectory(ownTests)
    ? fs
        .readdirSync(ownTests, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => path.join(ownTests, e.name, 'main.cpp'))
        .filter(isFile)
    : [];

  const linker = read(facts.linkerHw ?? '');
  add(
    'linker script: .init_array kept, with __init_array_start/__init_array_end',
    facts.linkerHw &&
      /__init_array_start/.test(linker) &&
      /__init_array_end/.test(linker) &&
      /KEEP\s*\(\s*\*\s*\(\s*(SORT[_A-Z]*\s*\()?\s*\.init_array/.test(linker)
      ? rel(sourceRoot, facts.linkerHw)
      : null,
    facts.linkerHw ? `${rel(sourceRoot, facts.linkerHw)} has no kept .init_array` : 'cmake/board.cmake names no UOS_BOARD_LINKER_HW'
  );
  add(
    'linker script: heap region _Heap_Begin .. _Heap_Limit',
    facts.linkerHw && /\b_Heap_Begin\b/.test(linker) && /\b_Heap_Limit\b/.test(linker) ? rel(sourceRoot, facts.linkerHw) : null,
    'the linker script defines no _Heap_Begin/_Heap_Limit'
  );
  add(
    'boot code runs the static constructors',
    evidence(bootFiles, /\bbl\s+__libc_init_array\b|__libc_init_array\s*\(\s*\)\s*;|os_run_init_array\s*\(\s*\)\s*;|for\s*\([^)]*__init_array_start/),
    'no call to __libc_init_array/os_run_init_array in the platform, port or kernel start-up'
  );
  const carriesStartup = testMains.some((f) => /os_startup_initialize_hardware\s*\(/.test(read(f)));
  add(
    'the heap is given to the µOS++ free store (malloc) at start-up',
    evidence(bootFiles, /os_startup_initialize_free_store\s*\(/) ??
      (carriesStartup ? 'the board tests carry the start-up (mtp_startup.hpp does the same)' : null),
    'no os_startup_initialize_free_store () in the start-up'
  );
  add(
    'sbrk () over _Heap_Begin .. _Heap_Limit',
    evidence([path.join(kernelDir, 'src', 'libc', '_sbrk.c'), ...bootFiles], /_Heap_Limit/),
    'no _sbrk () using _Heap_Limit'
  );
  return { ok: checks.every((c) => c.ok), checks, carriesStartup, facts };
}

/** How µTest++'s stdout reaches the console (see lib/micro-test-plus.js). */
function consoleModel(discovery, platform) {
  if (platform.arch === 'posix-arch') return { model: 3, why: 'hosted: stdout is the host process output' };
  const testsDir = path.join(discovery.sourceRoot, KERNEL_DIR, 'tests');
  const platformDir = path.join(testsDir, 'platforms', platform.id);
  const headers = filesUnder(path.join(platformDir, 'include'), /\.hpp$/);
  const port = discovery.packages.find((p) => p.id === platform.port);
  const semihosting = port ? read(path.join(discovery.sourceRoot, port.dir, 'include', 'semihosting.hpp')) : '';
  if (/write_str/.test(semihosting) && headers.some((f) => /putc_uart/.test(read(f)))) {
    return { model: 1, why: 'uart.hpp has putc_uart and the port\'s semihosting.hpp has write_str' };
  }
  const shared = path.join(testsDir, 'board-tests', 'cortexm');
  const uartWrite = headers.some((f) => /\bwrite\s*\(\s*const char\*\s*\w*\s*,\s*std::size_t/.test(read(f)));
  const weakWrite = /weak[^\n]*\)\s*\)?\s*\n?\s*_write\s*\(/.test(read(path.join(shared, 'syscalls.c')));
  if (/semi_write0/.test(read(path.join(shared, 'hw_result.hpp'))) && uartWrite && weakWrite) {
    return { model: 2, why: 'uart::write (s, n), hw_result::semi_write0, a weak _write in board-tests/cortexm/syscalls.c' };
  }
  return { model: 0, why: 'no known console model (UART call and semihosting write not found)' };
}

function smpBootKind(discovery, platform, facts) {
  const platformDir = facts.platformDir;
  if (isFile(path.join(platformDir, 'tests', 'src', 'test-smp-boot.cpp'))) return 1;
  const multicore = path.join(platformDir, 'include', 'bsp', 'multicore.hpp');
  const port = discovery.packages.find((p) => p.id === platform.port);
  const rtosDir = port ? path.join(discovery.sourceRoot, port.dir, 'src', 'rtos') : null;
  const secondary =
    rtosDir && isDirectory(rtosDir) && filesUnder(rtosDir).some((f) => /port_smp_secondary_start/.test(read(f)));
  if (facts.ncpu > 1 && /launch_core1/.test(read(multicore)) && secondary) return 2;
  return 0;
}

function testsInitUart(facts) {
  const include = path.join(facts.platformDir, 'include');
  return /\bUART_BAUD\b/.test(read(path.join(include, 'board.hpp'))) && /\binit\s*\(\s*std::uint32_t/.test(read(path.join(include, 'uart.hpp')));
}

function usesNewlibNano(discovery, platform) {
  const testsDir = path.join(discovery.sourceRoot, KERNEL_DIR, 'tests');
  const platformDir = path.join(testsDir, 'platforms', platform.id);
  const files = [
    path.join(platformDir, 'CMakeLists.txt'),
    ...filesUnder(path.join(platformDir, 'cmake'), /\.cmake$/),
  ];
  const own = files.some((f) => /--specs=nano\.specs/.test(read(f)));
  // The Cortex-M boards built with the shared helper get its nano.specs.
  const shared =
    files.some((f) => /uos-cortexm-board\.cmake|uos_cortexm_board/.test(read(f))) &&
    /--specs=nano\.specs/.test(read(path.join(testsDir, 'cmake', 'uos-cortexm-board.cmake')));
  return own || shared;
}

function hasEthNet(facts) {
  const net = path.join(facts.platformDir, 'net', 'src');
  return ['genet.hpp', 'eth_app.hpp', 'net.hpp'].every((name) => isFile(path.join(net, name)));
}

// -----------------------------------------------------------------------------
// Writing

function cmakeBlock({ framework, model, smpBoot, carriesStartup, hwdOnly, nanoPrintf, uartInit, ethTarget, arch }) {
  const semihostArgs = arch === 'cortexm' ? 1 : arch === 'posix-arch' ? 0 : 2;
  const defines = [
    'MICRO_OS_PLUS_MICRO_TEST_PLUS_ENABLED',
    '_GNU_SOURCE',
    `MTP_CONSOLE=${model}`,
    `MTP_HAS_SMP_BOOT=${smpBoot}`,
    `MTP_CARRY_STARTUP=${carriesStartup ? 1 : 0}`,
    `MTP_SEMIHOST_ARGS=${semihostArgs}`,
  ];
  if (model === 3) defines.push('MTP_HOSTED');
  if (nanoPrintf) defines.push('MTP_NANO_PRINTF=1');
  if (uartInit) defines.push('MTP_UART_INIT=1');
  return [
    '',
    `# ---- µTest++ (${MARK}) -------------------------------------`,
    '# Every test folder named mtp-* gets µTest++ (the framework in the',
    "# workspace's third_party/micro-test-plus) and the board support in",
    `# tests/mtp/, through the ${LIBRARY} INTERFACE library linked by the`,
    '# hook above. The command line (argv[0] and --output-file) comes from',
    '# cmake/uos-tests-run.cmake.',
    `set (_mtp_framework "\${CMAKE_CURRENT_LIST_DIR}/${framework}")`,
    'set (_mtp_support "${CMAKE_SOURCE_DIR}/mtp")',
    `if (NOT TARGET ${LIBRARY})`,
    '  file (GLOB _mtp_framework_sources CONFIGURE_DEPENDS "${_mtp_framework}/src/*.cpp")',
    `  add_library (${LIBRARY} INTERFACE)`,
    `  target_sources (${LIBRARY} INTERFACE`,
    '                  ${_mtp_framework_sources} "${_mtp_support}/mtp_board.cpp")',
    `  target_include_directories (${LIBRARY} INTERFACE`,
    '                              "${_mtp_framework}/include" "${_mtp_support}")',
    ...(arch === 'cortexm'
      ? []
      : [
          '  # hw_result.hpp (the verdict through semihosting) for the AArch boards.',
          '  if (IS_DIRECTORY "${CMAKE_SOURCE_DIR}/smp-support/include")',
          `    target_include_directories (${LIBRARY} INTERFACE "\${CMAKE_SOURCE_DIR}/smp-support/include")`,
          '  endif ()',
        ]),
    '  # MTP_CONSOLE: how stdout reaches the console and the runner (mtp_board.hpp).',
    '  # _GNU_SOURCE: the build is strict C++20, which hides fopencookie () and sbrk ().',
    `  target_compile_definitions (${LIBRARY} INTERFACE`,
    ...defines.map((d, i) => `                              ${d}${i === defines.length - 1 ? ')' : ''}`),
    ...(model !== 3
      ? [
          '  # The report file: µTest++ opens --output-file with fopen (); the wrapper',
          '  # in mtp_board.cpp turns it into a semihosting stream.',
          `  target_link_options (${LIBRARY} INTERFACE "-Wl,--wrap=fopen")`,
        ]
      : []),
    ...(arch === 'cortexm'
      ? [
          '  # A board whose reset code calls main (0, NULL) itself (RP2350 boot.S):',
          '  # __wrap_main in mtp_board.cpp reads the command line from the debugger.',
          `  target_link_options (${LIBRARY} INTERFACE "-Wl,--wrap=main")`,
        ]
      : []),
    ...(nanoPrintf
      ? [
          '  # newlib-nano: no "%zu"; the wrappers drop the \'z\', _printf_float keeps "%g".',
          `  target_link_options (${LIBRARY} INTERFACE`,
          '                       "-Wl,--wrap=printf,--wrap=vprintf,--wrap=fprintf"',
          '                       "-Wl,--wrap=vfprintf,--wrap=snprintf,--wrap=vsnprintf"',
          '                       "-Wl,-u,_printf_float")',
        ]
      : []),
    'endif ()',
    ...(ethTarget
      ? [
          '# mtp-eth-net: the Ethernet stack, and the SD card for its log suite.',
          `list (APPEND UOS_TESTS_STORAGE ${mtp.ETH_NET_TEST})`,
        ]
      : []),
    ...(hwdOnly
      ? [
          "# This board's QEMU image replaces the board (board_test_qemu_libs): the",
          '# µTest++ tests, checked against the board, run on the board only.',
          'file (GLOB _mtp_apps LIST_DIRECTORIES true CONFIGURE_DEPENDS RELATIVE "${CMAKE_CURRENT_LIST_DIR}"',
          '      "${CMAKE_CURRENT_LIST_DIR}/mtp-*")',
          'list (APPEND BOARD_TEST_HWD_ONLY ${_mtp_apps})',
        ]
      : []),
    '',
  ].join('\n');
}

const RUN_MARK = 'SCAFFOLD µTest++';

/** The helpers, and their use in every registration function. */
function patchRegistration(testsDir) {
  const file = path.join(testsDir, 'cmake', 'uos-tests-run.cmake');
  let text = read(file);
  if (!text || text.includes(RUN_MARK)) return null;
  const helpers = [
    '',
    `# ---- ${RUN_MARK} (${MARK}) ----------------------------------`,
    '# A mtp-* test gets its name as argv[0] and asks for its complete TAP',
    '# report in a file, through semihosting (or, hosted, as plain arguments):',
    '# <build>/mtp-reports/<ctest name>.tap. Other tests are unchanged.',
    'function (uos_mtp_report _app _name _out)',
    '  if (_app MATCHES "^mtp-")',
    '    file (MAKE_DIRECTORY "${CMAKE_BINARY_DIR}/mtp-reports")',
    '    set (${_out} "${CMAKE_BINARY_DIR}/mtp-reports/${_name}.tap" PARENT_SCOPE)',
    '  else ()',
    '    set (${_out} "" PARENT_SCOPE)',
    '  endif ()',
    'endfunction ()',
    '# QEMU: the -semihosting-config value.',
    'function (uos_mtp_qemu_semihosting _app _name _out)',
    '  uos_mtp_report ("${_app}" "${_name}" _report)',
    '  if (_report)',
    '    set (${_out} "enable=on,target=native,arg=${_app},arg=--output-file,arg=${_report}" PARENT_SCOPE)',
    '  else ()',
    '    set (${_out} "enable=on,target=native" PARENT_SCOPE)',
    '  endif ()',
    'endfunction ()',
    '',
  ].join('\n');
  const guard = 'include_guard (GLOBAL)\n';
  if (!text.includes(guard)) return null;
  text = text.replace(guard, `${guard}${helpers}`);

  const edits = [];
  // uos_tests_add_qemu
  const qemuCall = '-semihosting-config enable=on,target=native ${_drive} ${_boot}';
  if (text.includes(qemuCall)) {
    text = text.replace(qemuCall, '-semihosting-config "${_semi}" ${_drive} ${_boot}');
    text = text.replace(
      /(function \(uos_tests_add_qemu\)\n[\s\S]*?)(\n  add_test \(\n    NAME "\$\{_a_NAME\}")/,
      `$1\n  # ${RUN_MARK}\n  uos_mtp_qemu_semihosting ("\${_a_APP}" "\${_a_NAME}" _semi)$2`
    );
    edits.push('uos_tests_add_qemu');
  }
  // uos_tests_add_host
  const hostCall = 'add_test (NAME "${_a_NAME}" COMMAND "${_a_PROGRAM}")';
  if (text.includes(hostCall)) {
    text = text.replace(
      hostCall,
      [
        `# ${RUN_MARK}`,
        '  uos_mtp_report ("${_a_APP}" "${_a_NAME}" _report)',
        '  set (_args)',
        '  if (_report)',
        '    set (_args --output-file "${_report}")',
        '  endif ()',
        '  add_test (NAME "${_a_NAME}" COMMAND "${_a_PROGRAM}" ${_args})',
      ].join('\n')
    );
    edits.push('uos_tests_add_host');
  }
  // uos_tests_add_hwd: on the first core, before the load (uos_hwd_run's pre-load).
  const preload = '  list (JOIN _a_PRELOAD "\\n" _preload)\n';
  if (text.includes(preload)) {
    text = text.replace(
      preload,
      [
        preload.trimEnd(),
        `  # ${RUN_MARK}: the command line, on the core that boots.`,
        '  uos_mtp_report ("${_a_APP}" "${_a_NAME}" _report)',
        '  if (_report)',
        '    if (_preload)',
        '      string (APPEND _preload "\\n")',
        '    endif ()',
        '    string (APPEND _preload "arm semihosting_cmdline ${_a_APP} --output-file ${_report}")',
        '  endif ()',
        '',
      ].join('\n')
    );
    edits.push('uos_tests_add_hwd');
  }
  // uos_tests_add_openocd: after the last "arm semihosting enable" (the core
  // that runs the test is enabled last).
  const ocdLoop = [
    '  foreach (_c IN LISTS _a_COMMANDS)',
    '    string (REPLACE "@ELF@" "${_a_ELF}" _c "${_c}")',
    '    list (APPEND _ocd_args -c "${_c}")',
    '  endforeach ()',
  ].join('\n');
  if (text.includes(ocdLoop)) {
    text = text.replace(
      ocdLoop,
      [
        `  # ${RUN_MARK}: the command line, after the last "arm semihosting enable".`,
        '  uos_mtp_report ("${_a_APP}" "${_a_NAME}" _report)',
        '  set (_last -1)',
        '  set (_i 0)',
        '  foreach (_c IN LISTS _a_COMMANDS)',
        '    if (_c STREQUAL "arm semihosting enable")',
        '      set (_last ${_i})',
        '    endif ()',
        '    math (EXPR _i "${_i} + 1")',
        '  endforeach ()',
        '  set (_i 0)',
        '  foreach (_c IN LISTS _a_COMMANDS)',
        '    string (REPLACE "@ELF@" "${_a_ELF}" _c "${_c}")',
        '    list (APPEND _ocd_args -c "${_c}")',
        '    if (_report AND _i EQUAL _last)',
        '      list (APPEND _ocd_args -c "arm semihosting_cmdline ${_a_APP} --output-file ${_report}")',
        '    endif ()',
        '    math (EXPR _i "${_i} + 1")',
        '  endforeach ()',
      ].join('\n')
    );
    edits.push('uos_tests_add_openocd');
  }
  writeFile(file, text);
  return edits;
}

/** A Cortex-M platform's inline QEMU add_test. */
function patchPlatformQemu(platformDir) {
  const file = path.join(platformDir, 'CMakeLists.txt');
  let text = read(file);
  if (text.includes(RUN_MARK) || !/--semihosting-config enable=on,target=native/.test(text)) return false;
  const loop = /^(\s*)foreach \(_app IN LISTS UOS_TESTS_APPS\)\n/m;
  if (!loop.test(text)) return false;
  text = text.replace(loop, (all, indent) =>
    `${all}${indent}  # ${RUN_MARK}\n${indent}  uos_mtp_qemu_semihosting ("\${_app}" "\${PLATFORM_NAME}-\${_app}-qemu" _mtp_semi)\n`
  );
  text = text.replaceAll('--semihosting-config enable=on,target=native', '--semihosting-config "${_mtp_semi}"');
  writeFile(file, text);
  return true;
}

function writeSupport(testsDir, framework) {
  const dir = path.join(testsDir, 'mtp');
  ensureDir(dir);
  for (const name of ['mtp_board.hpp', 'mtp_board.cpp', 'mtp_startup.hpp', 'mtp_semihosting.hpp']) {
    writeFile(path.join(dir, name), mtp.templateText(name));
  }
  const readme = mtp
    .supportReadme({ scaffoldName: 'micro-os-plus-iii/tests' }, framework)
    .replaceAll('`../<board>/tests.cmake`', '`../platforms/<platform>/tests/tests.cmake`')
    .replaceAll('`../<board>/mtp-<name>/`', '`../platforms/<platform>/tests/mtp-<name>/`')
    .replaceAll('`../<board>/mtp-example/`', '`../platforms/<platform>/tests/mtp-example/`')
    .replaceAll('`../<board>/mtp-smp/`', '`../platforms/<platform>/tests/mtp-smp/`');
  writeFile(path.join(dir, 'README.md'), readme);
}

/**
 * Integrate µTest++ into a v2 workspace. `selection`: the scaffolded
 * platforms. Returns the record kept in scaffold.json; adds the starter
 * tests to each entry's apps.
 */
function integrateV2({ discovery, destination, selection, framework, force = false, log = console.log }) {
  const testsDir = path.join(destination, KERNEL_DIR, 'tests');
  const record = {
    spec: framework.spec,
    ref: framework.ref,
    kind: framework.kind,
    name: framework.name,
    version: framework.version,
    commit: framework.commit,
    destination: mtp.FRAMEWORK_DEST.replaceAll(path.sep, '/'),
    support: `${KERNEL_DIR}/tests/mtp`,
    force,
    platforms: [],
  };
  mtp.copyFramework(framework, destination);
  let supportWritten = false;
  for (const entry of selection) {
    const platform = entry.platform;
    const item = { platform: platform.id, status: 'skipped' };
    record.platforms.push(item);
    if (!platform.usesBuilder) {
      item.why = 'the platform does not use the board-test builder (upstream suites only)';
      continue;
    }
    const runtime = checkRuntime(discovery, platform);
    item.runtime = runtime.checks;
    const console_ = consoleModel(discovery, platform);
    item.console = console_;
    if (!runtime.ok && !force) {
      item.status = 'rule-not-met';
      item.why = runtime.checks.filter((c) => !c.ok).map((c) => c.why).join('; ');
      continue;
    }
    if (console_.model === 0) {
      item.status = 'no-console-model';
      item.why = console_.why;
      continue;
    }
    if (!supportWritten) {
      writeSupport(testsDir, framework);
      record.registration = patchRegistration(testsDir);
      supportWritten = true;
    }
    const platformDir = path.join(testsDir, 'platforms', platform.id);
    const testDir = path.join(platformDir, 'tests');
    ensureDir(testDir);
    if (patchPlatformQemu(platformDir)) item.qemuPatched = true;
    const smpBoot = smpBootKind(discovery, platform, runtime.facts);
    const testsCmake = path.join(testDir, 'tests.cmake');
    let text = read(testsCmake);
    const hwdOnly = /^\s*function\s*\(\s*board_test_qemu_libs\b/m.test(text);
    const arch = platform.arch === 'posix-arch' ? 'posix-arch' : platform.arch;
    const ethTarget = hasEthNet(runtime.facts) ? `${platform.id}-eth` : null;
    if (!text.includes(MARK)) {
      const hook = arch === 'posix-arch' ? 'board_test_libraries' : 'board_test_libs';
      text = mtp.patchLibsHook(text, hook, ethTarget);
      text += cmakeBlock({
        framework: path.relative(testDir, path.join(destination, mtp.FRAMEWORK_DEST)).replaceAll(path.sep, '/'),
        model: console_.model,
        smpBoot,
        carriesStartup: runtime.carriesStartup,
        hwdOnly,
        nanoPrintf: usesNewlibNano(discovery, platform),
        uartInit: testsInitUart(runtime.facts),
        ethTarget,
        arch,
      });
      writeFile(testsCmake, text);
    }
    const starters = [mtp.EXAMPLE, mtp.ARGS_TEST];
    if (smpBoot && console_.model !== 3) starters.push(mtp.SMP_TEST);
    if (ethTarget) starters.push(mtp.ETH_NET_TEST);
    for (const app of starters) {
      const dir = path.join(testDir, app);
      ensureDir(dir);
      for (const name of fs.readdirSync(path.join(mtp.TEMPLATES, app))) {
        writeFile(path.join(dir, name), mtp.templateText(path.join(app, name)));
      }
    }
    entry.added = [...(entry.added ?? []).filter((t) => !starters.includes(t.app)), ...starters.map((app) => ({ app, kind: 'micro-test-plus' }))];
    item.status = runtime.ok ? 'integrated' : 'integrated-forced';
    item.smpBoot = smpBoot;
    item.hwdOnly = hwdOnly;
    item.starters = starters;
    item.tests = rel(destination, testDir);
  }
  for (const item of record.platforms) {
    const label = item.platform.padEnd(30);
    if (item.status.startsWith('integrated')) {
      log(`  micro-test-plus: ${label} ${item.status}, console model ${item.console.model}, ${item.starters.join(' ')}`);
    } else {
      log(`  micro-test-plus: ${label} ${item.status}: ${item.why}`);
    }
  }
  return record;
}

module.exports = { integrateV2, checkRuntime, consoleModel, patchRegistration };
