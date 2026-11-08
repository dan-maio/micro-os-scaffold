'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { copyPath, copyTree, ensureDir, isDirectory, isFile, pathExists, writeFile, writeJson } = require('./util');
const { toolBinDirs } = require('./tools');
const { topReadme, projectReadme, integrationReadme } = require('./readme');
const { pruneWorkspace } = require('./prune');
const { pruneLeanWorkspace, slimConfig, leanReadme } = require('./lean');

const KERNEL_DEST = 'micro-os-plus-iii-smp';

const COPY_EXCLUDE_DIRS = new Set([
  '.git',
  '.kilo',
  '.cache',
  'node_modules',
  'xpacks',
  '.qoder',
  'target',
  '.zig-cache',
  'zig-out',
  'zig-pkg',
]);

function repoExclude(rel) {
  const segments = rel.split('/');
  return segments.some(
    (segment) => segment === 'build' || /^build[-_]/.test(segment) || COPY_EXCLUDE_DIRS.has(segment)
  );
}

function code(value) {
  return `\`${value}\``;
}

function table(headers, rows) {
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n');
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function copyKernel(kernelProject, sourceRoot, destination) {
  const src = kernelProject?.sourcePath ?? path.join(sourceRoot, 'micro-os-plus-iii');
  const dest = path.join(destination, kernelProject?.scaffoldName ?? KERNEL_DEST);
  const isCMake = !kernelProject || kernelProject.buildSystem === 'cmake';
  copyTree(src, dest, {
    excludeRel: (rel) => {
      if (isCMake && (rel === 'tests' || rel.startsWith('tests/'))) return true;
      return repoExclude(rel);
    },
  });
  return dest;
}

function copyPort(project, destination) {
  const dest = path.join(destination, project.scaffoldName);
  copyTree(project.sourcePath, dest, {
    excludeRel: (rel) => repoExclude(rel),
  });
  return dest;
}

function copyHarness(discovery, destination, toolsInfo) {
  const sourceHarness = path.join(discovery.sourceRoot, 'micro-os-plus-iii', 'tests');
  const dest = path.join(destination, 'tests');
  ensureDir(dest);

  const entries = [
    'CMakeLists.txt',
    'cmake',
    'platforms',
    'sources',
    'deprecated',
    'device-qemu-cortexm',
    'README.md',
    'LICENSE',
    'TO-CHECK.md',
    'package.json',
  ];
  for (const entry of entries) {
    const src = path.join(sourceHarness, entry);
    if (!pathExists(src)) continue;
    const target = entry === 'package.json' ? path.join(dest, 'package.json.original') : path.join(dest, entry);
    copyPath(src, target);
  }

  // Shared CTest runners live beside the harness in the original layout.
  const runners = path.join(discovery.sourceRoot, 'micro-os-plus-iii', 'test_smpl');
  if (isDirectory(runners)) {
    copyTree(runners, path.join(destination, 'test_smpl'));
  }

  // xPack dependencies used by the CMake harness. Copy the resolved trees so
  // the generated workspace is self-contained and independent of xpm.
  const xpackCopies = [
    ['build-helper', path.join(dest, 'xpacks', '@micro-os-plus', 'build-helper')],
    ['arm-cmsis-rtos-validator', path.join(dest, 'xpacks', '@xpacks', 'arm-cmsis-rtos-validator')],
    ['chan-fatfs', path.join(dest, 'xpacks', '@xpacks', 'chan-fatfs')],
    ['libucontext', path.join(dest, 'xpacks', '@xpack-3rd-party', 'libucontext')],
  ];
  const copiedXpacks = {};
  for (const [key, target] of xpackCopies) {
    const library = toolsInfo.libraries[key];
    if (library?.found) {
      copyTree(library.path, target);
      copiedXpacks[key] = {
        source: library.path,
        destination: target,
        version: library.version,
      };
    }
  }
  return { dest, copiedXpacks };
}

function patchHarnessTests(destination) {
  const changes = [];
  const testsMain = path.join(destination, 'tests', 'cmake', 'tests-main.cmake');
  if (isFile(testsMain)) {
    let text = fs.readFileSync(testsMain, 'utf8');
    const original = text;
    text = text.replace(
      /get_filename_component\s*\(\s*_uos_siblings\s+"\$\{CMAKE_SOURCE_DIR\}\/\.\.\/\.\."\s+ABSOLUTE\s*\)/,
      'get_filename_component (_uos_siblings "${CMAKE_SOURCE_DIR}/.." ABSOLUTE)'
    );
    text = text.replace(
      /set\s*\(\s*UOS_SMP_DIR\s+"\$\{CMAKE_SOURCE_DIR\}\/\.\."/,
      'set (UOS_SMP_DIR "${CMAKE_SOURCE_DIR}/../micro-os-plus-iii-smp"'
    );
    if (text !== original) {
      const banner = [
        '# -----------------------------------------------------------------------------',
        '# Scaffold adaptation: the tests/ directory is a sibling of the kernel',
        '# (micro-os-plus-iii-smp) and of the ports, not a child of the kernel.',
        '# Only the two path resolutions below were changed.',
        '# -----------------------------------------------------------------------------',
        '',
      ].join('\n');
      if (!text.includes('Scaffold adaptation')) text = `${banner}${text}`;
      fs.writeFileSync(testsMain, text);
      changes.push('tests/cmake/tests-main.cmake: sibling root + kernel path');
    }
  }

  const testsCMake = path.join(destination, 'tests', 'CMakeLists.txt');
  if (isFile(testsCMake)) {
    let text = fs.readFileSync(testsCMake, 'utf8');
    const original = text;
    text = text.replace(
      /"\$\{CMAKE_CURRENT_SOURCE_DIR\}\/\.\.\/package\.json"/,
      '"${CMAKE_CURRENT_SOURCE_DIR}/../micro-os-plus-iii-smp/package.json"'
    );
    if (text !== original) {
      fs.writeFileSync(testsCMake, text);
      changes.push('tests/CMakeLists.txt: kernel package.json path');
    }
  }

  // Make the QEMU selection honour the path recorded in scaffold.json (via
  // UOS_QEMU_XPACK_ROOT) before falling back to the historical HOME glob.
  const platformsDir = path.join(destination, 'tests', 'platforms');
  if (isDirectory(platformsDir)) {
    for (const entry of fs.readdirSync(platformsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const cmakeFile = path.join(platformsDir, entry.name, 'CMakeLists.txt');
      if (!isFile(cmakeFile)) continue;
      let text = fs.readFileSync(cmakeFile, 'utf8');
      if (!text.includes('$ENV{HOME}/.local/xPacks/@xpack-dev-tools/qemu-arm')) continue;
      const original = text;
      text = text.replace(
        /file \(GLOB _qemu_bins\s*\n\s*"\$ENV\{HOME\}\/\.local\/xPacks\/@xpack-dev-tools\/qemu-arm\/\*\/\.content\/bin"\s*\)/,
        [
          'if (DEFINED ENV{UOS_QEMU_XPACK_ROOT} AND EXISTS "$ENV{UOS_QEMU_XPACK_ROOT}")',
          '  set (_qemu_root "$ENV{UOS_QEMU_XPACK_ROOT}")',
          'else ()',
          '  set (_qemu_root "$ENV{HOME}/.local/xPacks/@xpack-dev-tools/qemu-arm")',
          'endif ()',
          'file (GLOB _qemu_bins "${_qemu_root}/*/.content/bin")',
        ].join('\n')
      );
      if (text !== original) {
        fs.writeFileSync(cmakeFile, text);
        changes.push(`tests/platforms/${entry.name}/CMakeLists.txt: QEMU root from environment`);
      }
    }
  }
  return changes;
}

function copyTopLevelDocs(sourceRoot, destination) {
  const docsDir = path.join(destination, 'docs');
  ensureDir(docsDir);
  for (const entry of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!/\.(md|pdf)$/i.test(entry.name)) continue;
    fs.copyFileSync(path.join(sourceRoot, entry.name), path.join(docsDir, entry.name));
  }
  return docsDir;
}

function xpackRootForTool(tool) {
  if (!tool?.path) return null;
  const marker = `${path.sep}.content${path.sep}bin${path.sep}`;
  const index = tool.path.indexOf(marker);
  if (index === -1) return null;
  // .../qemu-arm/<version>/.content/bin/qemu-system-arm -> .../qemu-arm
  return path.dirname(path.dirname(path.dirname(path.dirname(tool.path))));
}

function generateEnvScript(config, destination) {
  const lines = [
    '#!/usr/bin/env bash',
    '# -----------------------------------------------------------------------------',
    '# GENERATED by micro-os-scaffold. Do not edit by hand.',
    '# The source of truth is ../scaffold.json; re-run the scaffolder after editing it.',
    '# -----------------------------------------------------------------------------',
    `export SCAFFOLD_ROOT=${shellQuote(destination)}`,
    '',
    '# Tool paths (from scaffold.json).',
  ];
  for (const tool of Object.values(config.tools ?? {}).sort((a, b) => a.key.localeCompare(b.key))) {
    const name = tool.key.replace(/[^A-Za-z0-9]/g, '_').toUpperCase();
    if (tool.found) {
      lines.push(`export UOS_TOOL_${name}=${shellQuote(tool.path)}`);
    }
  }
  const binDirs = toolBinDirs(config);
  lines.push('');
  lines.push('# PATH: the detected tool directories first.');
  lines.push(`export PATH=${shellQuote(binDirs.join(path.delimiter))}:"$PATH"`);
  const qemuTool =
    config.tools?.['qemu-system-aarch64']?.found
      ? config.tools['qemu-system-aarch64']
      : config.tools?.['qemu-system-arm'];
  const qemuRoot = xpackRootForTool(qemuTool);
  if (qemuRoot) lines.push(`export UOS_QEMU_XPACK_ROOT=${shellQuote(qemuRoot)}`);
  lines.push('');
  lines.push('# Kernel and port roots (siblings, as tests-main.cmake expects).');
  lines.push(`export UOS_SMP_DIR=${shellQuote(path.join(destination, KERNEL_DEST))}`);
  for (const project of config.selectedProjects ?? []) {
    const name = project.replace(/[^A-Za-z0-9]/g, '_').toUpperCase();
    lines.push(`export UOS_PROJECT_${name}=${shellQuote(path.join(destination, project))}`);
  }
  lines.push('');
  lines.push(`export UOS_BUILD_HELPER=${shellQuote(path.join(destination, 'tests', 'xpacks', '@micro-os-plus', 'build-helper'))}`);
  lines.push(`export UOS_TOOLCHAIN_FILE_ARM=${shellQuote(path.join(destination, 'tests', 'xpacks', '@micro-os-plus', 'build-helper', 'cmake', 'toolchains', 'arm-none-eabi-gcc.cmake'))}`);
  lines.push(`export UOS_TOOLCHAIN_FILE_AARCH64=${shellQuote(path.join(destination, 'tests', 'xpacks', '@micro-os-plus', 'build-helper', 'cmake', 'toolchains', 'aarch64-none-elf-gcc.cmake'))}`);
  lines.push(`export UOS_TOOLCHAIN_FILE_RISCV=${shellQuote(path.join(destination, 'tests', 'xpacks', '@micro-os-plus', 'build-helper', 'cmake', 'toolchains', 'riscv-none-elf-gcc.cmake'))}`);
  lines.push('');
  lines.push('# Locally prepared xPack libraries used by CMake.');
  for (const [key, library] of Object.entries(config.libraries ?? {})) {
    if (!library.found) continue;
    const name = key.replace(/[^A-Za-z0-9]/g, '_').toUpperCase();
    lines.push(`export UOS_LIB_${name}=${shellQuote(library.path)}`);
  }
  lines.push('');
  return lines.join('\n');
}

function generateBuildScript(config, destination) {
  const configs = config.build.configurations ?? [];
  const defaultConfig = configs[0]?.name ?? '';
  const caseLines = [];
  for (const entry of configs) {
    const args = [`PLATFORM=${shellQuote(entry.platform)}`, `BUILD_TYPE=${shellQuote(entry.buildType)}`];
    if (entry.toolchainFile) args.push(`TOOLCHAIN=${shellQuote(entry.toolchainFile)}`);
    else args.push('TOOLCHAIN=');
    if (!entry.toolchain) args.push('HOST_COMPILERS=1');
    else args.push('HOST_COMPILERS=');
    caseLines.push(`    ${entry.name}) ${args.join('; ')} ;;`);
  }
  const lines = [
    '#!/usr/bin/env bash',
    '# -----------------------------------------------------------------------------',
    '# GENERATED by micro-os-scaffold. Configure and build one test configuration.',
    '# Tool paths come from tests/scripts/env.sh, generated from scaffold.json.',
    '#',
    '#   tests/build.sh                       # default configuration',
    '#   tests/build.sh <configuration>       # one configuration',
    '#   tests/build.sh --list                # list configurations',
    '#   tests/build.sh --clean <config>      # remove the build tree only',
    '#   tests/build.sh --tests <config>      # build, then run CTest',
    '# -----------------------------------------------------------------------------',
    'set -uo pipefail',
    'HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
    'source "$HERE/scripts/env.sh"',
    '',
    'list_configs() {',
    '  sed -n "s/^    \\([^)]*\\)) PLATFORM=.*/\\1/p" "$HERE/build.sh"',
    '}',
    '',
    `DEFAULT_CONFIG=${shellQuote(defaultConfig)}`,
    'CLEAN=0',
    'RUN_TESTS=0',
    'CONFIG=""',
    'for arg in "$@"; do',
    '  case "$arg" in',
    '    --list) list_configs; exit 0 ;;',
    '    --clean) CLEAN=1 ;;',
    '    --tests) RUN_TESTS=1 ;;',
    '    -h|--help) sed -n "2,15p" "$0"; exit 0 ;;',
    '    -*) echo "Unknown option: $arg" >&2; exit 2 ;;',
    '    *) CONFIG="$arg" ;;',
    '  esac',
    'done',
    'CONFIG="${CONFIG:-$DEFAULT_CONFIG}"',
    '',
    'PLATFORM=""',
    'BUILD_TYPE="Debug"',
    'TOOLCHAIN=""',
    'HOST_COMPILERS=""',
    'case "$CONFIG" in',
    ...caseLines,
    '    *) echo "Unknown configuration: $CONFIG" >&2; echo "Known: $DEFAULT_CONFIG (and --list)" >&2; exit 2 ;;',
    'esac',
    '',
    'BUILD_DIR="$HERE/build/$CONFIG"',
    'if [[ "$CLEAN" == "1" ]]; then',
    '  rm -rf "$BUILD_DIR"',
    '  echo "Removed $BUILD_DIR"',
    '  exit 0',
    'fi',
    '',
    'prepare_xpack_links() {',
    '  mkdir -p "$BUILD_DIR/xpacks/@xpacks" "$BUILD_DIR/xpacks/@xpack-3rd-party"',
    '  for pair in \\',
    '    "UOS_LIB_LIBUCONTEXT:$BUILD_DIR/xpacks/@xpack-3rd-party/libucontext" \\',
    '    "UOS_LIB_ARM_CMSIS_CORE:$BUILD_DIR/xpacks/@xpack-3rd-party/arm-cmsis-core" \\',
    '    "UOS_LIB_ARM_CMSIS:$BUILD_DIR/xpacks/@xpacks/arm-cmsis" \\',
    '    "UOS_LIB_RASPBERRYPI_PICO_SDK:$BUILD_DIR/xpacks/@xpack-3rd-party/raspberrypi-pico-sdk"; do',
    '    var="${pair%%:*}"',
    '    target="${pair#*:}"',
    '    source_path="${!var:-}"',
    '    if [[ -n "$source_path" && -d "$source_path" ]]; then',
    '      ln -sfn "$source_path" "$target"',
    '    fi',
    '  done',
    '}',
    '',
    'prepare_xpack_links',
    'CMAKE_ARGS=(-S "$HERE" -B "$BUILD_DIR" -G Ninja',
    '  -D "CMAKE_BUILD_TYPE=$BUILD_TYPE" -D "PLATFORM_NAME=$PLATFORM")',
    'if [[ -n "$TOOLCHAIN" ]]; then',
    '  CMAKE_ARGS+=(-D "CMAKE_TOOLCHAIN_FILE=$HERE/$TOOLCHAIN")',
    'fi',
    'if [[ "$HOST_COMPILERS" == "1" ]]; then',
    '  [[ -n "${UOS_TOOL_GCC:-}" ]] && CMAKE_ARGS+=(-D "CMAKE_C_COMPILER=$UOS_TOOL_GCC")',
    '  [[ -n "${UOS_TOOL_G__:-}" ]] && CMAKE_ARGS+=(-D "CMAKE_CXX_COMPILER=$UOS_TOOL_G__")',
    'fi',
    '',
    'echo "== configure $CONFIG (platform=$PLATFORM, build=$BUILD_TYPE)"',
    'cmake "${CMAKE_ARGS[@]}" || exit $?',
    'echo "== build $CONFIG"',
    'cmake --build "$BUILD_DIR" -- -k 0 || exit $?',
    'if [[ "$RUN_TESTS" == "1" ]]; then',
    '  exec "$HERE/test.sh" "$CONFIG"',
    'fi',
    '',
  ];
  return lines.join('\n');
}

/**
 * Turn a simple anchored CTest pattern into exact test names.
 * "^p-app-(qemu|hwd|host)$" -> p-app-qemu, p-app-hwd, p-app-host
 * "^p-suite$"               -> p-suite
 */
function expandCtestPattern(pattern) {
  if (!pattern) return [];
  const body = pattern.replace(/^\^/, '').replace(/\$$/, '');
  const group = body.match(/\(([^()]+)\)/);
  if (group) {
    return group[1].split('|').map((alternative) => body.replace(group[0], alternative));
  }
  return [body];
}

function generateSelectedTests(config, destination) {
  const lines = [
    '# GENERATED by micro-os-scaffold from scaffold.json.',
    '# configuration<TAB>selection<TAB>ctest-name[,ctest-name...]',
  ];
  for (const entry of config.build.configurations ?? []) {
    for (const test of entry.tests ?? []) {
      const names = expandCtestPattern(test.ctestPattern);
      if (!names.length) continue;
      lines.push(
        `${entry.name}\t${test.selectionId ?? test.app}\t${names.join(',')}`
      );
    }
  }
  writeFile(path.join(destination, 'tests', 'scripts', 'selected-tests.txt'), `${lines.join('\n')}\n`);
}

function generateTestScript(config, destination) {
  const defaultConfig = config.build.configurations?.[0]?.name ?? '';
  const template = fs.readFileSync(
    path.join(__dirname, '..', 'templates', 'test.sh'),
    'utf8'
  );
  return template.replaceAll('__DEFAULT_CONFIG__', defaultConfig);
}

function generateWrappers(destination) {
  const scripts = {
    'tests/qemu.sh': [
      '#!/usr/bin/env bash',
      'source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/scripts/env.sh"',
      'if [[ -n "${UOS_TOOL_QEMU_SYSTEM_AARCH64:-}" ]]; then',
      '  exec "$UOS_TOOL_QEMU_SYSTEM_AARCH64" "$@"',
      'fi',
      'exec "${UOS_TOOL_QEMU_SYSTEM_ARM:-qemu-system-arm}" "$@"',
      '',
    ].join('\n'),
    'tests/openocd.sh': [
      '#!/usr/bin/env bash',
      'source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/scripts/env.sh"',
      'exec "${UOS_TOOL_OPENOCD:-openocd}" "$@"',
      '',
    ].join('\n'),
  };
  for (const [rel, content] of Object.entries(scripts)) {
    writeFile(path.join(destination, rel), content, 0o755);
  }
}

function generateIntegrationCMake(config, destination) {
  const ports = config.projects.filter(
    (project) => project.role !== 'kernel' && (config.selectedProjects ?? []).includes(project.id)
  );
  const written = [];
  for (const port of ports) {
    const toolchainFile =
      port.architecture === 'aarch64'
        ? 'aarch64-none-elf-gcc.cmake'
        : port.architecture === 'riscv'
          ? 'riscv-none-elf-gcc.cmake'
          : port.architecture === 'posix'
            ? null
            : 'arm-none-eabi-gcc.cmake';
    const configureHint = toolchainFile
      ? `cmake -S . -B ../../../build/integration-${port.id} -G Ninja \\\n` +
        `  -D CMAKE_TOOLCHAIN_FILE=../../tests/xpacks/@micro-os-plus/build-helper/cmake/toolchains/${toolchainFile}`
      : `cmake -S . -B ../../../build/integration-${port.id} -G Ninja \\\n` +
        `  -D CMAKE_C_COMPILER="$UOS_TOOL_GCC" -D CMAKE_CXX_COMPILER="$UOS_TOOL_G__"`;
    const lines = [
      '# -----------------------------------------------------------------------------',
      '# GENERATED by micro-os-scaffold.',
      '#',
      `# Source-level integration of ${port.id} with the SMP kernel.`,
      '# The kernel and the port contribute their sources and include directories',
      '# directly to consumers through CMake INTERFACE libraries',
      `# (micro-os-plus::iii and micro-os-plus::${port.architecture}).`,
      '#',
      '# This is a minimal, standalone entry point. The maintained build and test',
      '# path is ../../tests/ (CMake + CTest).',
      '#',
      '#   source ../../tests/scripts/env.sh',
      `#   ${configureHint.replaceAll('\n', '\n#   ')}`,
      '# -----------------------------------------------------------------------------',
      'cmake_minimum_required (VERSION 3.20)',
      `project (micro-os-plus-iii-smp-${port.id} LANGUAGES C CXX ASM)`,
      '',
      'get_filename_component (_root "${CMAKE_CURRENT_SOURCE_DIR}/../.." ABSOLUTE)',
      `set (UOS_SMP_DIR "\${_root}/${KERNEL_DEST}" CACHE PATH "µOS++ III SMP kernel" FORCE)`,
      'if (NOT EXISTS "${UOS_SMP_DIR}/CMakeLists.txt")',
      '  message (FATAL_ERROR "Kernel not found at ${UOS_SMP_DIR}")',
      'endif ()',
      'add_subdirectory ("${UOS_SMP_DIR}" kernel-bin)',
      '',
      `set (BOARD "${
        port.platforms?.find((platform) => platform.id === port.defaultPlatform)?.board ??
        port.boards?.[0]?.id ??
        ''
      }" CACHE STRING "Target board")`,
      `add_subdirectory ("\${_root}/${port.scaffoldName}" "${port.id}-bin")`,
      '',
      '# A consumer in this tree links the interface targets, for example:',
      `#   target_link_libraries (app PRIVATE micro-os-plus::iii micro-os-plus::${port.architecture})`,
      '',
    ];
    const dir = path.join(destination, 'integration', port.scaffoldName);
    ensureDir(dir);
    writeFile(path.join(dir, 'CMakeLists.txt'), lines.join('\n'));
    written.push(dir);
  }
  return written;
}

function generateOpenocdIndex(config, destination) {
  const root = path.join(destination, 'tests', 'openocd');
  ensureDir(root);
  const rows = [];
  for (const project of config.projects) {
    if (project.role === 'kernel') continue;
    if (!(config.selectedProjects ?? []).includes(project.id)) continue;
    const selectedBoards = new Set(
      (project.platforms ?? [])
        .filter((platform) => (config.selectedPlatforms ?? []).includes(platform.id))
        .map((platform) => platform.board)
    );
    for (const board of project.boards ?? []) {
      if (!selectedBoards.has(board.id)) continue;
      if (!board.openocdConfig) continue;
      const boardDir = path.join(root, project.scaffoldName);
      ensureDir(boardDir);
      const wrapper = path.join(boardDir, `${board.id}.cfg`);
      const relative = path
        .relative(path.dirname(wrapper), path.join(destination, project.scaffoldName, 'test', 'boards', board.id, 'openocd.cfg'))
        .replaceAll(path.sep, '/');
      const text = [
        `# GENERATED OpenOCD entry point for ${project.id} / ${board.id}.`,
        '# The real configuration stays in the project; this wrapper only makes the',
        '# board configs discoverable from tests/openocd/. Edit the project copy.',
        `source [file join [file dirname [info script]] ${JSON.stringify(relative)}]`,
        '',
      ].join('\n');
      writeFile(wrapper, text);
      rows.push([
        code(`${project.scaffoldName}/${board.id}.cfg`),
        board.adapter ?? '—',
        board.transport ?? '—',
        board.vidPid ? code(board.vidPid) : '—',
        code(`../${project.scaffoldName}/test/boards/${board.id}/openocd.cfg`),
      ]);
    }
  }
  if (!rows.length) {
    fs.rmSync(root, { recursive: true, force: true });
    return { root: null, count: 0 };
  }
  const lines = [
    '# OpenOCD board configurations',
    '',
    'Generated entry points for every board of the selected projects. Each file sources the',
    "project's own `openocd.cfg`, so there is a single maintained copy per board.",
    '',
    '```bash',
    './tests/openocd.sh -f tests/openocd/<project>/<board>.cfg',
    '```',
    '',
    rows.length
      ? table(['Entry point', 'Adapter', 'Transport', 'VID:PID', 'Project config'], rows)
      : 'No selected project has an OpenOCD board configuration.',
    '',
    'The hardware CTest cases (`-hwd`) use `test_smpl/run-hw.sh` through the board `hw.sh`;',
    'they do not use these wrappers, but both resolve the same project configuration.',
    '',
  ];
  writeFile(path.join(root, 'README.md'), lines.join('\n'));
  return { root, count: rows.length };
}

function writeProjectManifest(destination, config, extras) {
  writeJson(path.join(destination, '.scaffold-manifest.json'), {
    generatedAt: new Date().toISOString(),
    generator: config.generator,
    kernel: KERNEL_DEST,
    projects: config.projects.map((project) => ({
      id: project.id,
      role: project.role,
      destination: path.basename(project.destinationPath),
      selected: (config.selectedProjects ?? []).includes(project.id),
    })),
    harness: 'tests',
    sharedRunners: config.lean ? null : 'test_smpl',
    docs: config.lean ? null : 'docs',
    integration: config.lean ? null : 'integration',
    mode: config.lean ? 'lean' : config.minimal ? 'minimal' : 'full',
    xpacks: extras.copiedXpacks,
    externals: extras.externals,
    patches: extras.patches,
  });
}

/**
 * Rewrite the generated READMEs from the current configuration. Called once
 * after scaffolding and again after build verification, so the status tables
 * in the documentation match scaffold.json.
 */
function refreshDocs(config, destination) {
  writeFile(path.join(destination, 'README.md'), topReadme(config));
  for (const project of config.projects) {
    if (project.role === 'kernel') continue;
    if (!(config.selectedProjects ?? []).includes(project.id)) continue;
    const readmePath = path.join(
      destination,
      project.scaffoldName,
      'README-SCAFFOLD.md'
    );
    if (config.lean) {
      fs.rmSync(readmePath, { force: true });
      continue;
    }
    writeFile(readmePath, projectReadme(config, project));
  }
  const cmakeWorkspace =
    config.kernel?.buildSystem === 'cmake' ||
    config.projects.some(
      (project) =>
        project.buildSystem === 'cmake' &&
        (config.selectedProjects ?? []).includes(project.id)
    );
  if (cmakeWorkspace && !config.minimal) {
    writeFile(path.join(destination, 'integration', 'README.md'), integrationReadme(config));
  }
}



function patchBoardPreTests(config, destination) {
  const patches = [];
  for (const project of config.projects) {
    if (project.role === 'kernel') continue;
    if (!(config.selectedProjects ?? []).includes(project.id)) continue;
    for (const board of project.boards ?? []) {
      if (!board.preTestScript) continue;
      const runner = path.join(
        project.destinationPath,
        'test',
        'boards',
        board.id,
        'hw.sh'
      );
      if (!isFile(runner)) continue;
      const relativePre = path.relative(project.sourcePath, board.preTestScript);
      const destPre = path.join(project.destinationPath, relativePre);
      if (!isFile(destPre)) continue;
      let text = fs.readFileSync(runner, 'utf8');
      if (text.includes('SCAFFOLD PRE-TEST')) continue;
      const relative = path
        .relative(path.dirname(runner), destPre)
        .replaceAll(path.sep, '/');
      const block = [
        '',
        '# SCAFFOLD PRE-TEST: put the board into the state the runner expects.',
        'if [[ "${UOS_SKIP_PRE_TEST:-0}" != "1" ]]; then',
        `  echo "== pre-test: ${board.id} =="`,
        `  bash "$HERE/${relative}" || exit $?`,
        'fi',
        '',
      ].join('\n');
      const lines = text.split(/\r?\n/);
      let at = lines.findIndex((line) => /^SECS=/.test(line));
      if (at >= 0) {
        lines.splice(at + 1, 0, block);
      } else {
        at = lines.findIndex((line) => /^ELF=/.test(line));
        if (at < 0) continue;
        lines.splice(at, 0, block);
      }
      fs.writeFileSync(runner, lines.join('\n'));
      patches.push(
        `test/boards/${board.id}/hw.sh: pre-test ${path.basename(destPre)}`
      );

      const manual = path.join(destination, 'tests', 'scripts', `prepare-${board.id}.sh`);
      writeFile(
        manual,
        [
          '#!/usr/bin/env bash',
          `# GENERATED by micro-os-scaffold: prepare ${board.id} before -hwd tests.`,
          'source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/env.sh"',
          `exec bash ${shellQuote(destPre)} "$@"`,
          '',
        ].join('\n'),
        0o755
      );
    }
  }
  return patches;
}

function prepareZigDependencies(config, destination) {
  const externals = [];
  const copied = new Map();
  const externDir = path.join(destination, 'extern');
  const knownProjects = new Map(
    (config.projects ?? [])
      .filter((project) => project.destinationPath)
      .map((project) => [path.resolve(project.sourcePath), project.destinationPath])
  );
  for (const project of config.projects) {
    if (project.role === 'kernel' || project.buildSystem !== 'zig') continue;
    if (!(config.selectedProjects ?? []).includes(project.id)) continue;
    const projectDir = path.join(destination, project.scaffoldName);
    const zon = path.join(projectDir, 'build.zig.zon');
    if (!isFile(zon)) continue;
    let text = fs.readFileSync(zon, 'utf8');
    let changed = false;
    text = text.replace(/\.path\s*=\s*"([^"]+)"/g, (match, relativePath) => {
      const sourcePath = path.resolve(project.sourcePath, relativePath);
      if (!isDirectory(sourcePath)) return match;
      const knownProject = knownProjects.get(sourcePath);
      if (knownProject) {
        const newRelative = path
          .relative(projectDir, knownProject)
          .replaceAll(path.sep, '/');
        changed = true;
        return `.path = "${newRelative}"`;
      }
      const insideDestination = path.relative(destination, sourcePath);
      if (!insideDestination.startsWith('..') && !path.isAbsolute(insideDestination)) {
        return match; // already inside the destination
      }
      let target = copied.get(sourcePath);
      if (!target) {
        const name = path.basename(sourcePath);
        let candidate = path.join(externDir, name);
        let suffix = 2;
        while (pathExists(candidate)) candidate = path.join(externDir, `${name}-${suffix++}`);
        copyTree(sourcePath, candidate);
        copied.set(sourcePath, candidate);
        externals.push({ name, source: sourcePath, destination: candidate });
        target = candidate;
      }
      const newRelative = path
        .relative(projectDir, target)
        .replaceAll(path.sep, '/');
      changed = true;
      return `.path = "${newRelative}"`;
    });
    if (changed) {
      fs.writeFileSync(zon, text);
    }
  }
  return externals;
}

function generateGenericEnvScript(config, destination) {
  const lines = [
    '#!/usr/bin/env bash',
    '# GENERATED by micro-os-scaffold. Tool paths from scaffold.json.',
    `export SCAFFOLD_ROOT=${shellQuote(destination)}`,
  ];
  for (const tool of Object.values(config.tools ?? {}).sort((a, b) => a.key.localeCompare(b.key))) {
    if (!tool.found) continue;
    const name = tool.key.replace(/[^A-Za-z0-9]/g, '_').toUpperCase();
    lines.push(`export UOS_TOOL_${name}=${shellQuote(tool.path)}`);
  }
  const binDirs = toolBinDirs(config);
  lines.push(`export PATH=${shellQuote(binDirs.join(path.delimiter))}:"$PATH"`);
  lines.push('');
  return lines.join('\n');
}

function cargoTargetFor(entry, project) {
  if (project?.architecture === 'posix') return '';
  if (project?.architecture === 'aarch64') return 'aarch64-unknown-none';
  if (entry.board === 'pico') return 'thumbv6m-none-eabi';
  if (entry.board?.startsWith('pico2')) return 'thumbv8m.main-none-eabihf';
  return 'thumbv7em-none-eabihf';
}

function generateBackendBuildScript(config, destination) {
  const entries = config.build.configurations ?? [];
  const defaultConfig = entries[0]?.name ?? '';
  const lines = [
    '#!/usr/bin/env bash',
    '# GENERATED by micro-os-scaffold. Build one Cargo or Zig configuration.',
    'set -uo pipefail',
    'HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
    'source "$HERE/scripts/env.sh"',
    `DEFAULT_CONFIG=${shellQuote(defaultConfig)}`,
    'CONFIG="${1:-$DEFAULT_CONFIG}"',
    'SYSTEM=""',
    'PROJECT=""',
    'BOARD=""',
    'TARGET=""',
    'case "$CONFIG" in',
  ];
  for (const entry of entries) {
    const project = (config.projects ?? []).find((item) => item.id === entry.project);
    lines.push(
      `  ${entry.name}) SYSTEM=${shellQuote(entry.buildSystem)}; PROJECT=${shellQuote(project?.destinationPath ?? '')}; BOARD=${shellQuote(entry.board ?? '')}; TARGET=${shellQuote(cargoTargetFor(entry, project))} ;;`
    );
  }
  lines.push(
    '  *) echo "Unknown configuration: $CONFIG" >&2; exit 2 ;;',
    'esac',
    'case "$SYSTEM" in',
    '  cargo)',
    '    cd "$PROJECT"',
    '    if [[ "$BOARD" == "native" || -z "$TARGET" ]]; then',
    '      exec cargo build --workspace',
    '    fi',
    '    exec cargo build -p "$BOARD" --examples --target "$TARGET"',
    '    ;;',
    '  zig)',
    '    cd "$PROJECT"',
    '    if [[ "$BOARD" == "native" || -z "$BOARD" ]]; then',
    '      exec zig build',
    '    fi',
    '    exec zig build -Dboard="$BOARD"',
    '    ;;',
    '  *) echo "Unknown build system: $SYSTEM" >&2; exit 2 ;;',
    'esac',
    ''
  );
  return lines.join('\n');
}

function generateBackendTestScript(config, destination) {
  const entries = config.build.configurations ?? [];
  const defaultConfig = entries[0]?.name ?? '';
  const lines = [
    '#!/usr/bin/env bash',
    '# GENERATED by micro-os-scaffold. Run selected Cargo or Zig tests.',
    'set -uo pipefail',
    'HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
    'source "$HERE/scripts/env.sh"',
    `DEFAULT_CONFIG=${shellQuote(defaultConfig)}`,
    'CONFIG="${1:-$DEFAULT_CONFIG}"',
    'case "$CONFIG" in',
  ];
  for (const entry of entries) {
    const project = (config.projects ?? []).find((item) => item.id === entry.project);
    lines.push(`  ${entry.name})`);
    lines.push(`    cd ${shellQuote(project?.destinationPath ?? '')} || exit $?`);
    if (entry.buildSystem === 'cargo') {
      if (entry.board === 'native') {
        lines.push('    exec cargo test --workspace');
      } else {
        const tests = entry.tests ?? [];
        for (const test of tests) {
          lines.push(
            `    bash test/boards/${entry.board}/hw.sh ${shellQuote(test.app)} 600 || exit $?`
          );
        }
      }
    } else if (entry.buildSystem === 'zig') {
      const tests = entry.tests ?? [];
      if (tests.length) {
        for (const test of tests) {
          const boardArg =
            entry.board && entry.board !== 'native'
              ? `-Dboard=${shellQuote(entry.board)} `
              : '';
          lines.push(
            `    zig build run ${boardArg}-Dtest=${shellQuote(test.app)} || exit $?`
          );
        }
      } else {
        lines.push('    exec zig build test');
      }
    } else {
      lines.push('    echo "Unknown build system" >&2; exit 2');
    }
    lines.push('    ;;');
  }
  lines.push('  *) echo "Unknown configuration: $CONFIG" >&2; exit 2 ;;', 'esac', '');
  return lines.join('\n');
}
function scaffold(options) {
  const { destination, discovery, config, toolsInfo } = options;
  ensureDir(destination);
  config.minimal = options.minimal !== false;
  config.lean = Boolean(options.lean);

  const extras = { copiedXpacks: {}, patches: [], externals: [] };
  const kernelDest = copyKernel(config.kernel, discovery.sourceRoot, destination);
  config.kernel.destinationPath = kernelDest;

  for (const project of config.projects) {
    if (project.role === 'kernel') continue;
    if (!(config.selectedProjects ?? []).includes(project.id)) continue;
    copyPort(project, destination);
  }
  const externals = prepareZigDependencies(config, destination);
  extras.externals = externals;
  extras.patches.push(...patchBoardPreTests(config, destination));

  const cmakeWorkspace =
    config.kernel?.buildSystem === 'cmake' ||
    config.projects.some(
      (project) =>
        project.buildSystem === 'cmake' &&
        (config.selectedProjects ?? []).includes(project.id)
    );
  let harness = { copiedXpacks: {}, patches: [] };
  let integrationDirs = [];
  if (cmakeWorkspace) {
    harness = copyHarness(discovery, destination, toolsInfo);
    extras.copiedXpacks = harness.copiedXpacks;
    extras.patches = patchHarnessTests(destination);
  } else {
    const runners = config.kernel?.sourcePath
      ? path.join(config.kernel.sourcePath, 'test_smpl')
      : null;
    if (runners && isDirectory(runners)) {
      copyTree(runners, path.join(destination, 'test_smpl'));
    }
    ensureDir(path.join(destination, 'tests', 'scripts'));
  }
  copyTopLevelDocs(discovery.sourceRoot, destination);

  writeFile(
    path.join(destination, 'tests', 'scripts', 'env.sh'),
    cmakeWorkspace
      ? generateEnvScript(config, destination)
      : generateGenericEnvScript(config, destination),
    0o755
  );
  writeFile(
    path.join(destination, 'tests', 'build.sh'),
    cmakeWorkspace
      ? generateBuildScript(config, destination)
      : generateBackendBuildScript(config, destination),
    0o755
  );
  writeFile(
    path.join(destination, 'tests', 'test.sh'),
    cmakeWorkspace
      ? generateTestScript(config, destination)
      : generateBackendTestScript(config, destination),
    0o755
  );
  if (cmakeWorkspace) {
    generateSelectedTests(config, destination);
    generateWrappers(destination);
  } else {
    fs.rmSync(path.join(destination, 'tests', 'scripts', 'selected-tests.txt'), { force: true });
  }
  // Older generated workspaces had a single aggregate integration file; it
  // cannot work because the ports need different toolchains.
  fs.rmSync(path.join(destination, 'integration', 'CMakeLists.txt'), { force: true });
  if (cmakeWorkspace) {
    integrationDirs = generateIntegrationCMake(config, destination);
    writeFile(path.join(destination, 'integration', 'README.md'), integrationReadme(config));
  } else {
    fs.rmSync(path.join(destination, 'integration'), { recursive: true, force: true });
  }

  if (config.minimal) {
    pruneWorkspace(config, destination);
    if (config.lean) {
      pruneLeanWorkspace(config, destination);
    }
    // Start from a clean build tree: a previous full scaffold may have left
    // objects for tests that are no longer present.
    for (const entry of config.build?.configurations ?? []) {
      fs.rmSync(path.join(destination, 'tests', 'build', entry.name), {
        recursive: true,
        force: true,
      });
    }
  }
  refreshDocs(config, destination);
  const openocd = config.lean
    ? { root: null, count: 0 }
    : generateOpenocdIndex(config, destination);
  if (config.lean) {
    fs.rmSync(path.join(destination, 'tests', 'openocd'), {
      recursive: true,
      force: true,
    });
  }

  writeProjectManifest(destination, config, extras);
  if (config.lean) {
    writeJson(path.join(destination, 'scaffold.json'), slimConfig(config));
    writeFile(path.join(destination, 'README.md'), leanReadme(config));
  }
  return {
    destination,
    kernel: kernelDest,
    projects: (config.selectedProjects ?? []).map((id) => path.join(destination, id)),
    tests: path.join(destination, 'tests'),
    sharedRunners: path.join(destination, 'test_smpl'),
    docs: path.join(destination, 'docs'),
    integration: path.join(destination, 'integration'),
    integrationDirs,
    openocd,
    xpacks: extras.copiedXpacks,
    externals: extras.externals,
    patches: extras.patches,
  };
}

module.exports = {
  scaffold,
  refreshDocs,
  patchHarnessTests,
  KERNEL_DEST,
  shellQuote,
};
