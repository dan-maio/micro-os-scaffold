'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isDirectory, isFile } = require('./util');

/*
 * The "how to extend this workspace" part of the lean README. Every name in
 * it (port, board, platform, configuration, test, hooks already present) is
 * read from the scaffolded workspace, so the text can be followed literally.
 */

const TEMPLATE = path.join(__dirname, '..', 'templates', 'README-LEAN-CMAKE.md');

const HOOK_PURPOSE = {
  board_test_sources: 'extra source files (`.c`, `.S`, board glue, files outside the test directory)',
  board_test_includes: 'extra include directories',
  board_test_defines: 'extra compile definitions',
  board_test_options: "extra compile options for the test's own sources",
  board_test_linker: 'another linker script for the hardware image',
  board_test_ncpu: "`OS_NCPU` for the test (default: the board's `UOS_BOARD_NCPU`)",
  board_test_libs: 'libraries to link',
  board_test_libraries: 'libraries to link',
  board_test_qemu_libs: 'libraries of the QEMU image (replace the board libraries)',
  board_test_qemu_sources: 'sources of the QEMU image (replace the hardware ones)',
  board_test_qemu_includes: 'extra include directories of the QEMU image',
  board_test_qemu_ncpu: '`OS_NCPU` of the QEMU image',
};

const LIST_PURPOSE = {
  BOARD_TEST_HWD_ONLY: 'tests without a QEMU image',
  BOARD_TEST_QEMU_ONLY: 'tests without a hardware image',
  BOARD_TEST_NO_KERNEL: 'bare-metal tests, linked without the RTOS',
  BOARD_TEST_SELF_CONTAINED: 'tests that must not get the shared `test/<board>/src/`',
  BOARD_TEST_NEED_DEVICES: 'tests that link the board device drivers',
};

/** The hooks and lists this port's builder really offers (they differ per port). */
function builderHooks(testCmake) {
  const hooks = [];
  for (const match of testCmake.matchAll(/function\s*\(\s*(board_test_[a-z_]+)/g)) {
    if (!hooks.includes(match[1])) hooks.push(match[1]);
  }
  const lists = [];
  for (const match of testCmake.matchAll(/set\s*\(\s*(BOARD_TEST_[A-Z_]+)\s+""\s*\)/g)) {
    if (!lists.includes(match[1])) lists.push(match[1]);
  }
  return { hooks, lists };
}

function read(file) {
  return isFile(file) ? fs.readFileSync(file, 'utf8') : '';
}

function stripComments(text) {
  return text.replace(/#[^\n]*/g, '');
}

function render(template, values) {
  let text = template;
  for (const [key, value] of Object.entries(values)) {
    text = text.replaceAll(`{{${key}}}`, String(value));
  }
  return text;
}

function cmakeList(text, name) {
  const match = stripComments(text).match(
    new RegExp(`set\\s*\\(\\s*${name}\\s+([^)]*)\\)`)
  );
  return match ? match[1].trim().split(/\s+/).filter(Boolean) : [];
}

function kernelTargets(kernelDir) {
  const text = stripComments(read(path.join(kernelDir, 'CMakeLists.txt')));
  const names = new Set();
  for (const match of text.matchAll(/add_library\s*\(\s*(micro-os-plus::iii-[A-Za-z0-9_-]+)\s+ALIAS/g)) {
    if (match[1] !== 'micro-os-plus::iii-core') names.add(match[1]);
  }
  return [...names];
}

function cmakeGuide(config, project, platform, tests) {
  const root = config.destination;
  const kernel = config.kernel?.scaffoldName ?? 'micro-os-plus-iii-smp';
  const port = project.scaffoldName;
  const board = platform.board;
  const portDir = path.join(root, port);
  const app = tests[0]?.app ?? '<app>';
  const configuration =
    (config.build?.configurations ?? []).find((entry) => entry.platform === platform.id)
      ?.name ?? '<configuration>';

  const testCmake = stripComments(read(path.join(portDir, 'test', 'CMakeLists.txt')));
  const portCmake = stripComments(read(path.join(portDir, 'CMakeLists.txt')));
  const testsCmakeFile = path.join(portDir, 'test', board, 'tests.cmake');
  const testsCmake = stripComments(read(testsCmakeFile));
  const boardCmake = read(path.join(portDir, 'test', 'boards', board, 'board.cmake'));

  const portLib = testCmake.match(/set\s*\(\s*_libs\s+(micro-os-plus::[A-Za-z0-9_-]+)/)?.[1] ??
    `micro-os-plus::${project.architecture}`;
  const portInterface =
    portCmake.match(
      new RegExp(`add_library\\s*\\(\\s*${portLib.replace(/[-:]/g, '\\$&')}\\s+ALIAS\\s+([A-Za-z0-9_-]+)`)
    )?.[1] ?? `${port}-interface`;

  const globMatch = portCmake.match(/file\s*\(\s*GLOB\s+_board_sources[^)]*\)/);
  const extensions = [...new Set((globMatch?.[0] ?? '').match(/\*\.[A-Za-z]+/g) ?? ['*.cpp'])];
  const boardGlob = extensions.map((ext) => `\`${ext}\``).join(', ');

  const flags = cmakeList(boardCmake, 'UOS_BOARD_FLAGS');
  const boardFlags = flags.length ? `\`${flags.join(' ')}\`` : 'the host compiler defaults';

  const { hooks, lists } = builderHooks(testCmake);
  const libsHook =
    hooks.find((hook) => /^board_test_(libs|libraries)$/.test(hook)) ?? 'board_test_libs';
  const hookTable = [
    '| Hook or list | Purpose |',
    '| --- | --- |',
    ...hooks.map(
      (hook) => `| \`${hook} (_app _out)\` | ${HOOK_PURPOSE[hook] ?? 'see the comment in `test/CMakeLists.txt`'} |`
    ),
    ...lists.map(
      (name) =>
        `| \`${name}\` | ${(LIST_PURPOSE[name] ?? 'see the comment in `test/CMakeLists.txt`').replace('<board>', board)} |`
    ),
  ].join('\n');
  const defined = hooks.filter((hook) =>
    new RegExp(`function\\s*\\(\\s*${hook}\\b`).test(testsCmake)
  );
  let hookNote;
  if (!isFile(testsCmakeFile)) {
    hookNote =
      `This board has no \`tests.cmake\` yet: create \`${port}/test/${board}/tests.cmake\` ` +
      'and define only the hooks you need; the defaults return an empty list.';
  } else if (defined.length) {
    hookNote =
      `This board's \`tests.cmake\` already defines ${defined
        .map((hook) => `\`${hook}()\``)
        .join(', ')}: add a branch for your test **inside** the existing function. ` +
      'A hook that is not listed here can be added as a new function; the defaults return an empty list.';
  } else {
    hookNote =
      "This board's `tests.cmake` defines none of the hooks yet: add the function you need; " +
      'the defaults return an empty list.';
  }

  const sourcesDefined = defined.includes('board_test_sources');
  const sourcesHook = sourcesDefined
    ? [
        '```cmake',
        '# the first statement of the existing board_test_sources():',
        `if (_app STREQUAL "${app}")`,
        `  set (\${_out} "\${CMAKE_CURRENT_FUNCTION_LIST_DIR}/${app}/fast-math.c" PARENT_SCOPE)`,
        '  return ()',
        'endif ()',
        '```',
        '',
        "`board_test_sources()` already exists in this board's `tests.cmake`. If it already",
        `returns files for \`${app}\` (board glue such as the UART), do not return early:`,
        'append your file to the list that branch returns, so the test keeps its glue.',
      ].join('\n')
    : [
        '```cmake',
        'function (board_test_sources _app _out)',
        `  if (_app STREQUAL "${app}")`,
        `    set (\${_out} "\${CMAKE_CURRENT_FUNCTION_LIST_DIR}/${app}/fast-math.c" PARENT_SCOPE)`,
        '  else ()',
        '    set (${_out} "" PARENT_SCOPE)',
        '  endif ()',
        'endfunction ()',
        '```',
      ].join('\n');

  const hasQemu = /set\s*\(\s*UOS_BOARD_LINKER_QEMU\b/.test(stripComments(boardCmake));
  const posix = project.architecture === 'posix';
  let variantNote;
  let newCtest;
  if (posix) {
    variantNote = 'This board runs on the host: the only variant is `host`.';
    newCtest = `${platform.id}-my-test-host`;
  } else if (hasQemu && !tests.some((test) => /qemu/.test(test.ctestPattern ?? ''))) {
    variantNote =
      'The board can also build `qemu` images, but the selected test is hardware-only, so the ' +
      "board's QEMU support was not copied. **Add every new test to `BOARD_TEST_HWD_ONLY` in " +
      '`tests.cmake`** (`list (APPEND BOARD_TEST_HWD_ONLY my-test)` after the existing `set`); ' +
      'otherwise CMake also generates a `qemu` image whose sources are missing and the configure ' +
      'step fails. For QEMU images, re-scaffold selecting a test that has one.';
    newCtest = `${platform.id}-my-test-hwd`;
  } else if (hasQemu) {
    variantNote =
      'This board has a QEMU linker script, so a test gets two variants, `qemu` and `hwd`. ' +
      'A test that needs the real hardware (SMP, UART, USB, timers) must be added to ' +
      '`BOARD_TEST_HWD_ONLY` in `tests.cmake`, otherwise its `qemu` image is built and run too.';
    newCtest = `${platform.id}-my-test-qemu,${platform.id}-my-test-hwd`;
  } else {
    variantNote = 'This board has no QEMU image: the only variant is `hwd` (real hardware, over the probe).';
    newCtest = `${platform.id}-my-test-hwd`;
  }

  const suites = isDirectory(path.join(root, 'tests', 'sources'))
    ? fs.readdirSync(path.join(root, 'tests', 'sources'))
    : [];
  const suiteNote = suites.length
    ? `This workspace carries the suites ${suites.map((name) => `\`tests/sources/${name}/\``).join(', ')} ` +
      `(target \`test::<suite>\`). A new suite is a directory there with a \`CMakeLists.txt\` exporting ` +
      `\`test::<suite>\`; list it in \`tests/platforms/${platform.id}/cmake/dependencies-folders.cmake\` ` +
      `and return the target from \`${libsHook}()\`.`
    : 'The selected test uses none, so `tests/sources/` and the xPack libraries were not copied. ' +
      `To use one, copy \`tests/sources/<suite>/\` (and the xPack under \`tests/xpacks/\`) from the source ` +
      `harness, list the directory in \`tests/platforms/${platform.id}/cmake/dependencies-folders.cmake\` ` +
      `and return \`test::<suite>\` from \`${libsHook}()\`, or re-scaffold selecting a test that already uses it.`;

  const runnerRows = [];
  const boardDir = path.join(portDir, 'test', 'boards', board);
  for (const [name, text] of [
    ['hw.sh', 'programs the board over OpenOCD and waits for the `RESULT:` line | to change the probe commands or the wait time'],
    ['openocd.cfg', 'probe and target configuration | to use another probe or adapter speed'],
    ['qemu.sh', 'runs the QEMU images outside CTest | to change the machine arguments'],
    ['run.sh', 'runs the host executables outside CTest | normally never'],
  ]) {
    if (isFile(path.join(boardDir, name))) {
      runnerRows.push(`| \`${port}/test/boards/${board}/${name}\` | ${text} |`);
    }
  }
  if (isDirectory(path.join(root, kernel, 'test_smpl'))) {
    runnerRows.push(
      `| \`${kernel}/test_smpl/run-*.sh\` | shared host/QEMU/hardware runners that parse the verdict and write the logs | normally never |`
    );
  }

  const hwd = tests.some((test) => /hwd/.test(test.ctestPattern ?? ''));
  const runNote = posix
    ? 'The test is a host executable; nothing but the compiler is needed to run it.'
    : hwd
      ? 'Hardware (`-hwd`) cases need the board and the probe. `./test.sh` skips them unless ' +
        '`--hwd` is given or the requested test has no other image. One board run is one CTest case; ' +
        'its log is under `tests/build/<configuration>/`.'
      : 'The QEMU cases run without any hardware.';

  return render(fs.readFileSync(TEMPLATE, 'utf8'), {
    KERNEL_TARGETS: kernelTargets(path.join(root, kernel))
      .map((name) => `\`${name}\``)
      .join(', ') || '(none)',
    KERNEL: kernel,
    PORT_INTERFACE: portInterface,
    PORT_LIB: portLib,
    PORT: port,
    BOARD_GLOB: boardGlob,
    BOARD_FLAGS: boardFlags,
    BOARD: board,
    PLATFORM: platform.id,
    CONFIG: configuration,
    APP: app,
    SOURCES_HOOK: sourcesHook,
    HOOK_TABLE: hookTable,
    LIBS_HOOK: libsHook,
    HOOK_NOTE: hookNote,
    SUITE_NOTE: suiteNote,
    VARIANT_NOTE: variantNote,
    NEW_CTEST: newCtest,
    RUNNER_ROWS: runnerRows.join('\n'),
    HWD_FLAG: posix ? '      ' : ' --hwd',
    RUN_NOTE: runNote,
    SOURCE_PORT: project.sourcePath ?? path.join(config.sourceRoot ?? '', project.id),
  });
}

function cargoGuide(config, project, platform, tests) {
  const port = project.scaffoldName;
  const board = platform.board;
  const app = tests[0]?.app ?? '<app>';
  const kernel = config.kernel?.scaffoldName ?? 'micro-os-plus-iii-rust';
  return [
    '## Adding new functionality to this workspace',
    '',
    `The port is a Cargo workspace; the board crate \`${port}/test/boards/${board}/\` is the`,
    '`bsp` library and every test is an `[[example]]` of it.',
    '',
    '| You add | Put it in | Register it in |',
    '| --- | --- | --- |',
    `| module of the test | \`${port}/test/${board}/${app}/<name>.rs\` | \`mod <name>;\` in \`main.rs\` |`,
    `| board code | \`${port}/test/boards/${board}/src/<name>.rs\` | \`pub mod <name>;\` in \`src/lib.rs\` |`,
    `| crates.io or path dependency | — | \`[dependencies]\` of \`${port}/test/boards/${board}/Cargo.toml\` |`,
    `| port crate | \`${port}/crates/<crate>/\` | covered by \`members = ["crates/*", ...]\` |`,
    `| kernel code | \`${kernel}/crates/\` | the kernel workspace \`Cargo.toml\` |`,
    `| new test | \`${port}/test/${board}/<name>/main.rs\` | an \`[[example]]\` block in the board \`Cargo.toml\` |`,
    '',
    '```toml',
    '[[example]]',
    'name = "my-test"',
    `path = "../../${board}/my-test/main.rs"`,
    '# required-features = ["single-core"]   # when it needs a non-default feature',
    '```',
    '',
    '`tests/build.sh` builds the examples of the board crate; `tests/test.sh` calls the board',
    `runner (\`${port}/test/boards/${board}/hw.sh <test>\` or \`qemu.sh\`). To run a new test, call`,
    'that runner with its name, or add a line for it to `tests/test.sh`.',
    '',
    'Re-running the scaffolder removes every test directory that is not selected; copy new',
    'work back to the source repository first.',
    '',
  ].join('\n');
}

function zigGuide(config, project, platform, tests) {
  const port = project.scaffoldName;
  const app = tests[0]?.app ?? '<app>';
  return [
    '## Adding new functionality to this workspace',
    '',
    `- A module of the test: add the \`.zig\` file next to \`${app}\`'s \`main.zig\` and \`@import\` it.`,
    `- Board or port code: add it under \`${port}/src/\` and import it from the board file.`,
    `- A dependency: add it to \`${port}/build.zig.zon\` and wire the module in \`${port}/build.zig\`.`,
    `- A new test: add the directory with a \`main.zig\`, then add it to the \`tests\` (and`,
    `  \`board_tests\`) tables in \`${port}/build.zig\`; run it with`,
    `  \`zig build run -Dboard=${platform.board} -Dtest=<name>\`.`,
    '',
    'Re-running the scaffolder removes every test directory that is not selected; copy new',
    'work back to the source repository first.',
    '',
  ].join('\n');
}

/** Upstream-style platforms: the test is a portable suite under tests/sources/. */
function suiteGuide(config, project, platform, tests) {
  const kernel = config.kernel?.scaffoldName ?? 'micro-os-plus-iii-smp';
  const test = tests[0];
  const suite = test.app;
  const target =
    (test.ctestPattern ?? '').replace(/^\^/, '').replace(/\$$/, '').replace(`${platform.id}-`, '') ||
    `${suite}-test`;
  const configuration =
    (config.build?.configurations ?? []).find((entry) => entry.platform === platform.id)
      ?.name ?? '<configuration>';
  const platformFile = `tests/platforms/${platform.id}/CMakeLists.txt`;
  return [
    '## Adding new functionality to this workspace',
    '',
    `The selected test is a portable harness suite: \`tests/sources/${suite}/\` exports the`,
    `INTERFACE target \`test::${suite}\`, and \`${platformFile}\` turns it into the executable`,
    `\`${target}\` and the CTest case \`${platform.id}-${target}\`. Sources are listed explicitly;`,
    'nothing is globbed here.',
    '',
    '| You add | Put it in | Edit |',
    '| --- | --- | --- |',
    `| source of the test | \`tests/sources/${suite}/src/\` | \`target_sources (...)\` in \`tests/sources/${suite}/CMakeLists.txt\` |`,
    `| header of the test | \`tests/sources/${suite}/include/\` | nothing, the directory is on the include path |`,
    `| definition, option, link option | — | \`target_compile_definitions\` / \`target_compile_options\` / \`target_link_options\` in the same file |`,
    `| library | anywhere in the workspace | \`target_link_libraries (...)\` in the same file, or as an extra argument of \`add_suite_executable ()\` |`,
    `| platform code (start-up, device) | \`tests/platforms/${platform.id}/\` | \`cmake/platform-library.cmake\` there |`,
    `| kernel source | \`${kernel}/src/\` | \`target_sources (micro-os-plus-iii-interface ...)\` in \`${kernel}/CMakeLists.txt\` |`,
    `| port source | \`${project.scaffoldName}/src/\` | the port interface target in \`${project.scaffoldName}/CMakeLists.txt\` |`,
    '',
    '### Add a source file',
    '',
    '```cmake',
    `# tests/sources/${suite}/CMakeLists.txt`,
    `target_sources (test-${suite}-interface INTERFACE src/main.cpp src/test.cpp src/filter.cpp)`,
    '```',
    '',
    '### Add a library',
    '',
    'Declare it as an INTERFACE target (so it is compiled with the platform flags) and link it:',
    '',
    '```cmake',
    `# tests/sources/${suite}/CMakeLists.txt`,
    'add_library (mylib INTERFACE)',
    'target_sources (mylib INTERFACE "${CMAKE_CURRENT_LIST_DIR}/../../libs/mylib/src/mylib.cpp")',
    'target_include_directories (mylib INTERFACE "${CMAKE_CURRENT_LIST_DIR}/../../libs/mylib/include")',
    `target_link_libraries (test-${suite}-interface INTERFACE mylib)`,
    '```',
    '',
    'A pre-built archive is linked the same way, by its absolute path; it must be built for',
    "the platform's CPU and float ABI.",
    '',
    '### Add a new test',
    '',
    '```bash',
    `cp -r tests/sources/${suite} tests/sources/my-suite`,
    `sed -i 's/${suite}/my-suite/g' tests/sources/my-suite/CMakeLists.txt`,
    '```',
    '',
    'Then register it in two places:',
    '',
    '```cmake',
    `# tests/platforms/${platform.id}/cmake/dependencies-folders.cmake, inside the list`,
    '  "${CMAKE_SOURCE_DIR}/sources/my-suite"',
    '',
    `# ${platformFile}, next to the existing call`,
    'add_suite_executable (my-suite-test my-suite)',
    '```',
    '',
    '```bash',
    'cd tests',
    `./test.sh ${configuration} my-suite-test`,
    '```',
    '',
    `The CTest case is \`${platform.id}-my-suite-test\`. To make it part of the default run, add a`,
    'tab separated line to `tests/scripts/selected-tests.txt`:',
    '',
    '```text',
    `${configuration}\tmy-suite\t${platform.id}-my-suite-test`,
    '```',
    '',
    '### Build and run scripts',
    '',
    '| Script | What it does | When to edit |',
    '| --- | --- | --- |',
    '| `tests/scripts/env.sh` | tool paths and `PATH`, relative to the workspace | to change a tool, or export `UOS_TOOL_<NAME>` first |',
    '| `tests/build.sh` | `cmake -S tests -B tests/build/<configuration> -G Ninja`, then the build | to pass another `-D` option (append to `CMAKE_ARGS`) |',
    '| `tests/test.sh` | builds, then runs CTest for the named tests (`--list`, `--all`, `--regex`) | normally never |',
    `| \`${platformFile}\` | \`add_suite_executable ()\`: the executable, the run command (QEMU machine, CPU) and the timeout | to change how a test is run |`,
    '',
    'Re-running the scaffolder on this folder restores the harness from the source and removes',
    'the suites that are not selected, **including the ones added here**. Copy new work to the',
    'source repository first.',
    '',
  ].join('\n');
}

function leanExtensionGuide(config, project, platform, tests) {
  if (!project || !platform) return '';
  if (tests[0]?.kind === 'suite') return suiteGuide(config, project, platform, tests);
  if (project.buildSystem === 'cargo') return cargoGuide(config, project, platform, tests);
  if (project.buildSystem === 'zig') return zigGuide(config, project, platform, tests);
  return cmakeGuide(config, project, platform, tests);
}

module.exports = { leanExtensionGuide };
