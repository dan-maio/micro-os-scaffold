'use strict';

/*
 * µTest++ (micro-test-plus) for the CMake test workspaces.
 *
 *   --micro-test-plus <git-url | folder>   [--micro-test-plus-ref <tag|branch>]
 *
 * 1. The framework is taken from a folder (an unpacked npm package or a
 *    checkout of micro-test-plus-xpack) or cloned from git, checked, and
 *    copied unchanged to <destination>/third_party/micro-test-plus.
 * 2. Every selected board is checked against the rule a board must meet to
 *    run µTest++ tests: its boot code runs the static constructors, its
 *    linker script defines .init_array and the heap (_Heap_Begin,
 *    _Heap_Limit), sbrk() uses that heap, and the heap is handed to the
 *    µOS++ free store (malloc) before the constructors run. The check reads
 *    the sources; the generated starter test checks the same on the target.
 * 3. For each board that meets it, the board's console model is detected
 *    and the integration is written: <port>/test/mtp/ (the board support,
 *    once per port), a block in <port>/test/<board>/tests.cmake that links
 *    µTest++ to every mtp-* test, and a starter test
 *    <port>/test/<board>/mtp-example/.
 *
 * Nothing here edits the source repositories: everything is written in the
 * destination, after the copy and the pruning.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run, copyTree, ensureDir, isDirectory, isFile, readJson, writeFile } = require('./util');

const TEMPLATES = path.join(__dirname, '..', 'templates', 'micro-test-plus');
const FRAMEWORK_DEST = path.join('third_party', 'micro-test-plus');
const LIBRARY = 'uos-micro-test-plus';
const EXAMPLE = 'mtp-example';
const SMP_TEST = 'mtp-smp';
const ETH_NET_TEST = 'mtp-eth-net';
const MARK = 'micro-os-scaffold --micro-test-plus';

// ---------------------------------------------------------------- framework

function isGitUrl(value) {
  return (
    /^(https?|git|ssh|file):\/\//.test(value) ||
    /^[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+:/.test(value)
  );
}

function cacheRoot() {
  return (
    process.env.SCAFFOLD_CACHE ??
    path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache'), 'micro-os-scaffold')
  );
}

/** Where the framework's sources are: the folder itself or a subfolder. */
function frameworkRoot(dir) {
  for (const candidate of [dir, path.join(dir, 'package')]) {
    if (
      isFile(path.join(candidate, 'include', 'micro-os-plus', 'micro-test-plus.h')) &&
      isDirectory(path.join(candidate, 'src'))
    ) {
      return candidate;
    }
  }
  return null;
}

function git(args, cwd) {
  return run('git', args, { cwd, timeout: 10 * 60 * 1000 });
}

/**
 * Resolve the --micro-test-plus value to a local folder with the framework.
 * Returns { spec, ref, kind, path, name, version, commit }.
 */
function resolveFramework(spec, ref, log = console.log) {
  let dir;
  let kind;
  let commit = null;
  if (isGitUrl(spec)) {
    kind = 'git';
    const key = crypto.createHash('sha1').update(`${spec}@${ref ?? ''}`).digest('hex').slice(0, 12);
    dir = path.join(cacheRoot(), 'micro-test-plus', key);
    if (isDirectory(path.join(dir, '.git'))) {
      const args = ['-C', dir, 'fetch', '--depth', '1', 'origin'];
      if (ref) args.push(ref);
      const fetched = git(args);
      if (fetched.status === 0) {
        git(['-C', dir, 'reset', '--hard', 'FETCH_HEAD']);
        log(`  micro-test-plus: updated ${spec}${ref ? ` (${ref})` : ''}`);
      } else {
        log(`  micro-test-plus: WARNING, cannot update ${spec}; using the cached clone`);
      }
    } else {
      fs.rmSync(dir, { recursive: true, force: true });
      ensureDir(path.dirname(dir));
      const args = ['clone', '--depth', '1'];
      if (ref) args.push('--branch', ref);
      args.push(spec, dir);
      const cloned = git(args);
      if (cloned.status !== 0) {
        throw new Error(
          `micro-test-plus: git clone of ${spec}${ref ? ` (${ref})` : ''} failed:\n${(cloned.stderr || cloned.stdout).trim()}`
        );
      }
      log(`  micro-test-plus: cloned ${spec}${ref ? ` (${ref})` : ''}`);
    }
    commit = git(['-C', dir, 'rev-parse', '--short', 'HEAD']).stdout.trim() || null;
  } else {
    kind = 'folder';
    dir = path.resolve(spec);
    if (!isDirectory(dir)) {
      throw new Error(`micro-test-plus: ${dir} is neither a folder nor a git URL`);
    }
  }
  const root = frameworkRoot(dir);
  if (!root) {
    throw new Error(
      `micro-test-plus: ${dir} does not hold the framework (no include/micro-os-plus/micro-test-plus.h and src/)`
    );
  }
  const pkg = readJson(path.join(root, 'package.json'), {});
  if (pkg.name && pkg.name !== '@micro-os-plus/micro-test-plus') {
    throw new Error(`micro-test-plus: ${root} is the package ${pkg.name}, not @micro-os-plus/micro-test-plus`);
  }
  const major = Number.parseInt(String(pkg.version ?? '').split('.')[0], 10);
  if (Number.isFinite(major) && major < 6) {
    log(
      `  micro-test-plus: WARNING, version ${pkg.version}; the generated code uses the 6.x API ` +
        '(tr.initialise, add_suite, run_suites, t.expect)'
    );
  }
  return {
    spec,
    ref: ref ?? null,
    kind,
    path: root,
    name: pkg.name ?? '@micro-os-plus/micro-test-plus',
    version: pkg.version ?? null,
    commit,
  };
}

/** Copy what a build needs: sources, headers, CMake, licences, docs. */
function copyFramework(framework, destination) {
  const dest = path.join(destination, FRAMEWORK_DEST);
  fs.rmSync(dest, { recursive: true, force: true });
  const keep = new Set([
    'include',
    'src',
    'CMakeLists.txt',
    'meson.build',
    'package.json',
    'xcdl-package.jsonc',
    'LICENSE',
    'LICENSE-Boost',
    'README.md',
    'CHANGELOG.md',
  ]);
  ensureDir(dest);
  for (const entry of fs.readdirSync(framework.path, { withFileTypes: true })) {
    if (!keep.has(entry.name)) continue;
    const src = path.join(framework.path, entry.name);
    if (entry.isDirectory()) copyTree(src, path.join(dest, entry.name));
    else fs.copyFileSync(src, path.join(dest, entry.name));
  }
  return dest;
}

// ---------------------------------------------------------------- the rule

function read(file) {
  return isFile(file) ? fs.readFileSync(file, 'utf8') : '';
}

function stripCmakeComments(text) {
  return text.replace(/#[^\n]*/g, '');
}

/** Files under `dir` (recursively), with the given extensions. */
function sources(dir, pattern = /\.(c|cc|cpp|S|s|asm|hpp|h)$/) {
  const out = [];
  if (!isDirectory(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (/^(build|qemu|usb|wifi|net|third_party)/.test(entry.name)) continue;
      out.push(...sources(full, pattern));
    } else if (pattern.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** The board's board.cmake variables we need, with the paths resolved. */
function boardFacts(portDir, board) {
  const boardDir = path.join(portDir, 'test', 'boards', board);
  const text = stripCmakeComments(read(path.join(boardDir, 'board.cmake')));
  const vars = { CMAKE_CURRENT_LIST_DIR: boardDir };
  const value = (name) => {
    const match = text.match(new RegExp(`set\\s*\\(\\s*${name}\\s+"?([^")\\s]+)"?`));
    if (!match) return null;
    return match[1].replace(/\$\{(\w+)\}/g, (all, v) => vars[v] ?? all);
  };
  const srcDir = value('UOS_BOARD_SRC_DIR');
  vars.UOS_BOARD_SRC_DIR = srcDir ? path.resolve(srcDir) : boardDir;
  const linkerHw = value('UOS_BOARD_LINKER_HW');
  const linkerQemu = value('UOS_BOARD_LINKER_QEMU');
  return {
    boardDir,
    srcDir: vars.UOS_BOARD_SRC_DIR,
    linkerHw: linkerHw ? path.resolve(linkerHw) : null,
    linkerQemu: linkerQemu ? path.resolve(linkerQemu) : null,
    hasQemu: Boolean(linkerQemu),
  };
}

function rel(destination, file) {
  return path.relative(destination, file).replaceAll(path.sep, '/');
}

/** Find the first file whose text matches; returns its relative path. */
function evidence(files, pattern, destination) {
  for (const file of files) {
    if (pattern.test(read(file))) return rel(destination, file);
  }
  return null;
}

/**
 * Check one board against the rule. Returns { ok, checks[] }, each check
 * { rule, ok, evidence | why }.
 */
function checkBoardRuntime(project, board, destination, kernelDir) {
  const portDir = path.join(destination, project.scaffoldName);
  const checks = [];
  const add = (rule, found, why) =>
    checks.push(found ? { rule, ok: true, evidence: found } : { rule, ok: false, why });

  if (project.architecture === 'posix') {
    // Hosted: the C library of the host runs the constructors and owns the
    // heap; nothing in the port's sources to check.
    add('hosted runtime', 'the host C library (glibc) provides constructors, malloc and sbrk', null);
    return { ok: true, checks, hosted: true };
  }

  const facts = boardFacts(portDir, board);
  const testDir = path.join(portDir, 'test', board);
  const bootFiles = [
    ...sources(path.join(facts.srcDir, 'src')),
    ...sources(path.join(facts.boardDir, 'src')),
    ...sources(path.join(facts.srcDir, 'glue')),
    ...sources(path.join(facts.boardDir, 'glue')),
    ...sources(path.join(portDir, 'src')),
    ...sources(path.join(kernelDir, 'src', 'startup')),
  ];
  const testMains = isDirectory(testDir)
    ? fs
        .readdirSync(testDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(testDir, entry.name, 'main.cpp'))
        .filter(isFile)
    : [];

  // 1. The linker script: .init_array kept and bracketed, a heap region.
  const linker = read(facts.linkerHw ?? '');
  add(
    'linker script: .init_array kept, with __init_array_start/__init_array_end',
    facts.linkerHw &&
      /__init_array_start/.test(linker) &&
      /__init_array_end/.test(linker) &&
      /KEEP\s*\(\s*\*\s*\(\s*(SORT[_A-Z]*\s*\()?\s*\.init_array/.test(linker)
      ? rel(destination, facts.linkerHw)
      : null,
    facts.linkerHw ? `${rel(destination, facts.linkerHw)} has no kept .init_array` : 'board.cmake names no UOS_BOARD_LINKER_HW'
  );
  add(
    'linker script: heap region _Heap_Begin .. _Heap_Limit',
    facts.linkerHw && /\b_Heap_Begin\b/.test(linker) && /\b_Heap_Limit\b/.test(linker)
      ? rel(destination, facts.linkerHw)
      : null,
    'the linker script defines no _Heap_Begin/_Heap_Limit (what sbrk and the tests use)'
  );

  // 2. The boot code runs the constructors.
  add(
    'boot code runs the static constructors',
    evidence(
      bootFiles,
      /\bbl\s+__libc_init_array\b|__libc_init_array\s*\(\s*\)\s*;|os_run_init_array\s*\(\s*\)\s*;|for\s*\([^)]*__init_array_start/,
      destination
    ),
    'no call to __libc_init_array/os_run_init_array in the board, port or kernel start-up'
  );

  // 3. The heap is handed to the µOS++ free store (malloc), in the board's
  //    start-up or in the start-up its tests carry.
  const carriesStartup = testMains.some((file) => /os_startup_initialize_hardware\s*\(/.test(read(file)));
  add(
    'the heap is given to the µOS++ free store (malloc) at start-up',
    evidence(bootFiles, /os_startup_initialize_free_store\s*\(/, destination) ??
      (carriesStartup
        ? `${rel(destination, testMains.find((f) => /os_startup_initialize_free_store\s*\(/.test(read(f))) ?? testMains[0])} (tests carry the start-up; mtp_startup.hpp does the same)`
        : null),
    'no os_startup_initialize_free_store () in the start-up'
  );

  // 4. sbrk over that heap: the kernel's _sbrk.c (or the board's own).
  add(
    'sbrk () over _Heap_Begin .. _Heap_Limit',
    evidence([path.join(kernelDir, 'src', 'libc', '_sbrk.c'), ...bootFiles], /_Heap_Limit/, destination),
    'no _sbrk () using _Heap_Limit'
  );

  return { ok: checks.every((check) => check.ok), checks, carriesStartup, facts };
}

// --------------------------------------------------------- console models

/**
 * How µTest++'s stdout reaches the console and the runner on this board:
 *   1 cookie stream -> uart::uart1.putc_uart + semihosting::write_str
 *   2 strong _write -> uart::write + hw_result::semi_write0
 *   3 hosted stdout
 */
function consoleModel(project, board, destination) {
  if (project.architecture === 'posix') return { model: 3, why: 'hosted: stdout is read by run-host.sh' };
  const portDir = path.join(destination, project.scaffoldName);
  const facts = boardFacts(portDir, board);
  const includeDirs = [path.join(facts.srcDir, 'include'), path.join(facts.boardDir, 'include')];
  const headers = includeDirs.flatMap((dir) => sources(dir, /\.hpp$/));
  const semihosting = read(path.join(portDir, 'include', 'semihosting.hpp'));
  if (/write_str/.test(semihosting) && headers.some((file) => /putc_uart/.test(read(file)))) {
    return {
      model: 1,
      why: 'uart.hpp has putc_uart and include/semihosting.hpp has write_str; _write mirrors only verdicts',
    };
  }
  const sharedResult = read(path.join(portDir, 'test', 'boards', 'shared', 'hw_result.hpp'));
  const uartWrite = headers.some((file) => /\bwrite\s*\(\s*const char\*\s*\w*\s*,\s*std::size_t/.test(read(file)));
  const weakWrite = /__attribute__\s*\(\s*\(\s*weak\s*\)\s*\)\s*\n?_write|weak[^\n]*\n_write/.test(
    read(path.join(portDir, 'test', 'boards', 'shared', 'syscalls.c'))
  );
  if (/semi_write0/.test(sharedResult) && uartWrite && weakWrite) {
    return {
      model: 2,
      why: 'uart::write (s, n), hw_result::semi_write0, and a weak _write in boards/shared/syscalls.c',
    };
  }
  return { model: 0, why: 'no known console model (UART call and semihosting write not found)' };
}

// ---------------------------------------------------------------- writing

function templateText(name) {
  return fs.readFileSync(path.join(TEMPLATES, name), 'utf8');
}

/** The name of the port's per-test library hook (board_test_libs, ...). */
function libsHookName(portDir) {
  const text = stripCmakeComments(read(path.join(portDir, 'test', 'CMakeLists.txt')));
  return text.match(/function\s*\(\s*(board_test_lib(?:s|raries))\b/)?.[1] ?? 'board_test_libs';
}

function hasBoardEthNet(portDir, board) {
  const netSrc = path.join(portDir, 'test', 'boards', board, 'net', 'src');
  return (
    isFile(path.join(netSrc, 'genet.hpp')) &&
    isFile(path.join(netSrc, 'eth_app.hpp')) &&
    isFile(path.join(netSrc, 'net.hpp'))
  );
}

function cmakeBlock(project, board, destination, model, hasSmpBoot, carriesStartup, hwdOnly = false, nanoPrintf = false, uartInit = false, ethTarget = null) {
  const portDir = path.join(destination, project.scaffoldName);
  const framework = path
    .relative(path.join(portDir, 'test', board), path.join(destination, FRAMEWORK_DEST))
    .replaceAll(path.sep, '/');
  const defines = [
    'MICRO_OS_PLUS_MICRO_TEST_PLUS_ENABLED',
    '_GNU_SOURCE',
    `MTP_CONSOLE=${model}`,
    `MTP_HAS_SMP_BOOT=${hasSmpBoot}`,
    `MTP_CARRY_STARTUP=${carriesStartup ? 1 : 0}`,
  ];
  if (model === 3) defines.push('MTP_HOSTED');
  if (nanoPrintf) defines.push('MTP_NANO_PRINTF=1');
  if (uartInit) defines.push('MTP_UART_INIT=1');
  return [
    '',
    `# ---- µTest++ (${MARK}) -------------------------------------`,
    '# Every test directory named mtp-* gets µTest++ (the framework in the',
    '# workspace\'s third_party/micro-test-plus) and the board support in',
    `# ../mtp/ through the ${LIBRARY} INTERFACE library, linked by the hook`,
    '# below. The tests are built and registered with CTest like any other.',
    `set (_mtp_framework "\${CMAKE_CURRENT_LIST_DIR}/${framework}")`,
    'set (_mtp_support "${CMAKE_CURRENT_LIST_DIR}/../mtp")',
    `if (NOT TARGET ${LIBRARY})`,
    '  file (GLOB _mtp_framework_sources CONFIGURE_DEPENDS "${_mtp_framework}/src/*.cpp")',
    `  add_library (${LIBRARY} INTERFACE)`,
    `  target_sources (${LIBRARY} INTERFACE`,
    '                  ${_mtp_framework_sources} "${_mtp_support}/mtp_board.cpp")',
    `  target_include_directories (${LIBRARY} INTERFACE`,
    '                              "${_mtp_framework}/include" "${_mtp_support}")',
    '  # MTP_CONSOLE: how stdout reaches the console and the runner (mtp_board.hpp).',
    '  # _GNU_SOURCE: the build is strict C++20, which hides fopencookie () and sbrk ().',
    `  target_compile_definitions (${LIBRARY} INTERFACE`,
    ...defines.map((define, i) => `                              ${define}${i === defines.length - 1 ? ')' : ''}`),
    ...(nanoPrintf
      ? [
          '  # newlib-nano: µTest++ prints size_t with "%zu", which nano does not know;',
          '  # the wrappers in mtp_board.cpp drop the \'z\' (MTP_NANO_PRINTF), and',
          '  # _printf_float keeps "%g" for the approx () messages.',
          `  target_link_options (${LIBRARY} INTERFACE`,
          '                       "-Wl,--wrap=printf,--wrap=vprintf,--wrap=fprintf"',
          '                       "-Wl,--wrap=vfprintf,--wrap=snprintf,--wrap=vsnprintf"',
          '                       "-Wl,-u,_printf_float")',
        ]
      : []),
    'endif ()',
    ...(ethTarget
      ? [
          `if (TARGET ${ethTarget})`,
          `  list (APPEND BOARD_TEST_NEED_DEVICES ${ETH_NET_TEST})`,
          'endif ()',
        ]
      : []),
    ...(hwdOnly
      ? [
          '# This board\'s QEMU image replaces the board (board_test_qemu_libs), so',
          '# the µTest++ tests, checked against the board, run on the board only.',
          'file (GLOB _mtp_apps LIST_DIRECTORIES true CONFIGURE_DEPENDS RELATIVE "${CMAKE_CURRENT_LIST_DIR}"',
          '      "${CMAKE_CURRENT_LIST_DIR}/mtp-*")',
          'list (APPEND BOARD_TEST_HWD_ONLY ${_mtp_apps})',
        ]
      : []),
    '',
  ].join('\n');
}

/** Insert the mtp-* branch at the top of the hook, or add the hook. */
function patchLibsHook(text, hook, ethTarget = null) {
  const branch = [
    `  # µTest++ (${MARK}): every mtp-* test.`,
    '  if ("${_app}" MATCHES "^mtp-")',
    ...(ethTarget
      ? [
          `    if ("\${_app}" MATCHES "^mtp-eth-" AND TARGET ${ethTarget})`,
          `      set (\${_out} ${LIBRARY} ${ethTarget} PARENT_SCOPE)`,
          '      return ()',
          '    endif ()',
        ]
      : []),
    `    set (\${_out} ${LIBRARY} PARENT_SCOPE)`,
    '    return ()',
    '  endif ()',
  ].join('\n');
  const pattern = new RegExp(`(^function\\s*\\(\\s*${hook}\\s+_app\\s+_out\\s*\\)[^\\n]*\\n)`, 'm');
  if (pattern.test(text)) {
    return text.replace(pattern, `$1${branch}\n`);
  }
  return `${text}\nfunction (${hook} _app _out)\n${branch}\n  set (\${_out} "" PARENT_SCOPE)\nendfunction ()\n`;
}

function ctestVariants(project, facts, qemuReplacesBoard = false) {
  if (project.architecture === 'posix') return ['host'];
  return facts?.hasQemu && !qemuReplacesBoard ? ['qemu', 'hwd'] : ['hwd'];
}

/*
 * A board whose QEMU image does not link the board at all (pico2: the kernel
 * plus a generic single-core device, board_test_qemu_libs in tests.cmake)
 * runs its µTest++ tests on the board only: the runtime rule was checked on
 * the board, and the replacement is a different machine.
 */
/*
 * How the board support can release the other cores (MTP_HAS_SMP_BOOT):
 *   1  the port's test-smp-boot helpers (AArch32/AArch64, posix);
 *   2  RP2040/RP2350: core 1 launched through the bootrom FIFO
 *      (bsp/multicore.hpp launch_core1 + the port's port_smp_secondary_start);
 *   0  none: the tests run on core 0 only.
 */
function smpBootKind(portDir, board, testDir) {
  if (isFile(path.join(testDir, 'src', 'test-smp-boot.cpp'))) return 1;
  const boardDir = path.join(portDir, 'test', 'boards', board);
  const multicore = path.join(boardDir, 'include', 'bsp', 'multicore.hpp');
  const boardCmake = path.join(boardDir, 'board.cmake');
  const ncpu = Number((isFile(boardCmake) && /UOS_BOARD_NCPU\s+(\d+)/.exec(read(boardCmake))?.[1]) || 1);
  const srcDir = path.join(portDir, 'src', 'rtos');
  const hasSecondaryStart =
    fs.existsSync(srcDir) &&
    fs.readdirSync(srcDir).some((name) => /port_smp_secondary_start/.test(read(path.join(srcDir, name))));
  if (ncpu > 1 && isFile(multicore) && /launch_core1/.test(read(multicore)) && hasSecondaryStart) return 2;
  return 0;
}

/*
 * Boards whose start-up leaves the UART off and whose tests switch it on
 * themselves with uart::init (board::UART_BAUD) (the STM32 boards); the
 * RP2040/RP2350 glue does it at start-up. Without it the first uart::write
 * waits for TXE on a disabled USART for ever.
 */
function testsInitUart(portDir, board) {
  const include = path.join(portDir, 'test', 'boards', board, 'include');
  const boardHpp = path.join(include, 'board.hpp');
  const uartHpp = path.join(include, 'uart.hpp');
  return (
    isFile(boardHpp) &&
    /\bUART_BAUD\b/.test(read(boardHpp)) &&
    isFile(uartHpp) &&
    /\binit\s*\(\s*std::uint32_t/.test(read(uartHpp))
  );
}

/* The port links newlib-nano (--specs=nano.specs), whose printf lacks C99 length modifiers. */
function usesNewlibNano(portDir) {
  const files = [path.join(portDir, 'CMakeLists.txt'), path.join(portDir, 'test', 'CMakeLists.txt')];
  return files.some((file) => isFile(file) && /--specs=nano\.specs/.test(read(file)));
}

function qemuReplacesBoard(testsCmakeText) {
  return /^\s*function\s*\(\s*board_test_qemu_libs\b/m.test(testsCmakeText);
}

function writeSupport(project, destination, framework) {
  const dir = path.join(destination, project.scaffoldName, 'test', 'mtp');
  ensureDir(dir);
  for (const name of ['mtp_board.hpp', 'mtp_board.cpp', 'mtp_startup.hpp']) {
    writeFile(path.join(dir, name), templateText(name));
  }
  writeFile(path.join(dir, 'README.md'), supportReadme(project, framework));
  return dir;
}

function supportReadme(project, framework) {
  return [
    `# µTest++ board support for ${project.scaffoldName}`,
    '',
    `Generated by \`micro-os-scaffold --micro-test-plus\` from ${framework.spec}` +
      `${framework.ref ? ` (${framework.ref})` : ''}, µTest++ ${framework.version ?? '?'}.`,
    '',
    '| File | What it does |',
    '|---|---|',
    '| `mtp_board.hpp`, `mtp_board.cpp` | the console for µTest++\'s report, the RESULT line, the cores, the cross-core helpers |',
    '| `mtp_startup.hpp` | the µOS++ start-up, for the boards whose tests carry their own (`MTP_CARRY_STARTUP=1`) |',
    '',
    'Each board that uses it has a µTest++ block in `../<board>/tests.cmake`, which sets:',
    '',
    '| Define | Meaning |',
    '|---|---|',
    '| `MTP_CONSOLE=1` | stdout replaced by a stream to the UART (`putc_uart`) and to semihosting (`SYS_WRITE0`, batched) |',
    '| `MTP_CONSOLE=2` | a strong `_write ()` to the UART (`uart::write`) and to semihosting (`hw_result::semi_write0`, batched) |',
    '| `MTP_CONSOLE=3` | hosted: stdout is the host\'s |',
    '| `MTP_HAS_SMP_BOOT=1` | `release_cores ()` through the port\'s test-smp-boot helpers (AArch32/AArch64) |',
    '| `MTP_HAS_SMP_BOOT=2` | `release_cores ()` through `multicore::launch_core1` (RP2040/RP2350) |',
    '| `MTP_UART_INIT=1` | the board\'s start-up leaves the UART off: `start ()` calls `uart::init (board::UART_BAUD)`, as its tests do |',
    '| `MTP_NANO_PRINTF=1` | newlib-nano: the printf family is wrapped to drop the `z` of `%zu`, and `_printf_float` is linked |',
    '| `MTP_CARRY_STARTUP=1` | `mtp_startup.hpp` provides `main ()` and the start-up hooks |',
    '| `MTP_HOSTED` | no linker heap to check (the host C library owns it) |',
    '',
    'The helpers for SMP tests (`mtp_board.hpp`):',
    '',
    '| Helper | What it does |',
    '|---|---|',
    '| `release_cores ()`, `suite_cores` | start the other cores, pin the runner to core 0, check they joined |',
    '| `cpu_id ()` | the core running the caller |',
    '| `irqs_masked ()` | this core\'s interrupt mask (DAIF.I, CPSR.I, PRIMASK/BASEPRI) |',
    '| `sync_method ()` | the board\'s cross-core read-modify-write: the exclusive monitor (LDAXR/STLXR, LDREX/STREX) or the RP2 SIO hardware spinlocks |',
    '| `spinlock`, `atomic_add ()` | a lock and an atomic add between cores, through `sync_method ()` |',
    '',
    'On the RP2040/RP2350, `std::atomic` read-modify-write does not exclude the other core',
    '(their exclusive monitor is per core); use `spinlock`, `atomic_add ()` or the kernel there.',
    '',
    'A new µTest++ test is a directory `../<board>/mtp-<name>/`: copy `../<board>/mtp-example/`',
    '(or `../<board>/mtp-smp/` for a multi-core test).',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------- driver

/**
 * Integrate µTest++ into the scaffolded workspace. Called after the copy
 * and the pruning. Updates config.microTestPlus and adds the starter test to
 * the build configurations it applies to.
 */
function integrate(config, destination, framework, options = {}) {
  const log = options.log ?? console.log;
  const record = {
    spec: framework.spec,
    ref: framework.ref,
    kind: framework.kind,
    name: framework.name,
    version: framework.version,
    commit: framework.commit,
    destination: FRAMEWORK_DEST.replaceAll(path.sep, '/'),
    force: Boolean(options.force),
    boards: [],
  };
  config.microTestPlus = record;

  const cmakeProjects = (config.projects ?? []).filter(
    (project) =>
      project.role !== 'kernel' &&
      project.buildSystem === 'cmake' &&
      (config.selectedProjects ?? []).includes(project.id)
  );
  if (!cmakeProjects.length) {
    log('  micro-test-plus: no CMake port selected; nothing to integrate');
    return record;
  }
  copyFramework(framework, destination);
  const kernelDir = config.kernel?.destinationPath ?? path.join(destination, 'micro-os-plus-iii-smp');

  for (const project of cmakeProjects) {
    let supportWritten = false;
    const portDir = path.join(destination, project.scaffoldName);
    const hook = libsHookName(portDir);
    const platforms = (project.platforms ?? []).filter((platform) =>
      (config.selectedPlatforms ?? []).includes(platform.id)
    );
    for (const platform of platforms) {
      const board = platform.board;
      const entry = { project: project.id, platform: platform.id, board, status: 'skipped' };
      record.boards.push(entry);
      const tests = platform.tests ?? [];
      if (!board || !tests.some((test) => test.kind === 'board-test')) {
        entry.why = 'not a board-test platform (its tests are harness suites)';
        continue;
      }
      const runtime = checkBoardRuntime(project, board, destination, kernelDir);
      entry.runtime = runtime.checks;
      const console_ = consoleModel(project, board, destination);
      entry.console = console_;
      if (!runtime.ok && !options.force) {
        entry.status = 'rule-not-met';
        entry.why = runtime.checks.filter((check) => !check.ok).map((check) => check.why).join('; ');
        continue;
      }
      if (console_.model === 0) {
        entry.status = 'no-console-model';
        entry.why = console_.why;
        continue;
      }

      if (!supportWritten) {
        writeSupport(project, destination, framework);
        supportWritten = true;
      }
      const testDir = path.join(portDir, 'test', board);
      ensureDir(testDir);
      const smpBoot = smpBootKind(portDir, board, testDir);
      const testsCmake = path.join(testDir, 'tests.cmake');
      let text = read(testsCmake);
      const hwdOnly = qemuReplacesBoard(text);
      const nanoPrintf = usesNewlibNano(portDir);
      const uartInit = testsInitUart(portDir, board);
      const hasEthNet = hasBoardEthNet(portDir, board);
      const ethTarget = hasEthNet ? `${platform.id}-eth` : null;
      if (!text.includes(MARK)) {
        text = patchLibsHook(text, hook, ethTarget);
        text += cmakeBlock(project, board, destination, console_.model, smpBoot, runtime.carriesStartup ?? project.architecture === 'posix', hwdOnly, nanoPrintf, uartInit, ethTarget);
        writeFile(testsCmake, text);
      }

      // The starter tests: mtp-example everywhere, mtp-smp where the board
      // support can release the other cores (not on the host, whose
      // "interrupts" are signal masks), and mtp-eth-net where the board
      // carries the GENET + lwIP Ethernet stack.
      const starters = [EXAMPLE];
      if (smpBoot && console_.model !== 3) starters.push(SMP_TEST);
      if (hasEthNet) starters.push(ETH_NET_TEST);
      for (const app of starters) {
        const dir = path.join(testDir, app);
        ensureDir(dir);
        for (const name of fs.readdirSync(path.join(TEMPLATES, app))) {
          writeFile(path.join(dir, name), templateText(path.join(app, name)));
        }
      }
      const exampleDir = path.join(testDir, EXAMPLE);

      // The starter tests are among the configuration's tests, so the build
      // verification builds them and test.sh runs them by default.
      const variants = ctestVariants(project, runtime.facts, hwdOnly);
      const variantPattern = variants.length === 1 ? variants[0] : `(${variants.join('|')})`;
      for (const app of starters) {
        const pattern = `^${platform.id}-${app}-${variantPattern}$`;
        for (const configuration of config.build?.configurations ?? []) {
          if (configuration.platform !== platform.id) continue;
          configuration.tests = (configuration.tests ?? []).filter((test) => test.app !== app);
          configuration.tests.push({ app, selectionId: null, ctestPattern: pattern, kind: 'micro-test-plus' });
        }
        config.selectedTests = (config.selectedTests ?? []).filter(
          (test) => !(test.platform === platform.id && test.app === app)
        );
        config.selectedTests.push({
          selectionId: null,
          project: project.id,
          platform: platform.id,
          board,
          app,
          ctestPattern: pattern,
          kind: 'micro-test-plus',
        });
      }

      entry.status = runtime.ok ? 'integrated' : 'integrated-forced';
      entry.example = rel(destination, exampleDir);
      entry.support = rel(destination, path.join(portDir, 'test', 'mtp'));
      entry.starters = starters;
      entry.ctest = starters.flatMap((app) => variants.map((variant) => `${platform.id}-${app}-${variant}`));
      entry.smpBoot = smpBoot;
    }
  }
  return record;
}

function printSummary(record, log = console.log) {
  if (!record) return;
  log(
    `  micro-test-plus: ${record.name} ${record.version ?? '?'} from ${record.spec}` +
      `${record.ref ? ` (${record.ref})` : ''} -> ${record.destination}`
  );
  for (const entry of record.boards) {
    const label = `${entry.platform}`.padEnd(30);
    if (entry.status.startsWith('integrated')) {
      log(`    ${label} ${entry.status}, console model ${entry.console.model}, ${entry.example}`);
    } else {
      log(`    ${label} ${entry.status}: ${entry.why}`);
    }
  }
}

module.exports = {
  resolveFramework,
  integrate,
  printSummary,
  checkBoardRuntime,
  consoleModel,
  isGitUrl,
  FRAMEWORK_DEST,
  EXAMPLE,
};
