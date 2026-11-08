'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  dirSize,
  gitInfo,
  isDirectory,
  isFile,
  naturalCompare,
  readJson,
  relativeFiles,
  walk,
} = require('./util');

const REPO_EXCLUDE_DIRS = new Set([
  '.git',
  '.kilo',
  '.cache',
  'node_modules',
  'xpacks',
  'build',
  'target',
  '.zig-cache',
  'zig-out',
  'zig-pkg',
]);

function isRepoExcludedDir(name) {
  return REPO_EXCLUDE_DIRS.has(name) || /^build[-_]/.test(name);
}

function classifyArchitecture(id, sourcePath) {
  if (/posix/.test(id)) return 'posix';
  if (/riscv/.test(id)) return 'riscv';
  if (/aarch64/.test(id)) return 'aarch64';
  if (/aarch32/.test(id)) return 'aarch32';
  if (/cortexm|cortex-m/.test(id)) return 'cortexm';
  if (isFile(path.join(sourcePath, 'src/rtos/os-core.cpp')) && isDirectory(path.join(sourcePath, 'include/cmsis-plus'))) {
    return 'portable';
  }
  return 'unknown';
}

function detectLanguages(sourcePath) {
  const extensionMap = new Map([
    ['.c', 'C'],
    ['.cpp', 'C++'],
    ['.cc', 'C++'],
    ['.cxx', 'C++'],
    ['.hpp', 'C++ headers'],
    ['.h', 'C headers'],
    ['.S', 'ASM'],
    ['.s', 'ASM'],
    ['.rs', 'Rust'],
    ['.zig', 'Zig'],
  ]);
  const counts = new Map();
  const files = walk(sourcePath, {
    excludeDirs: [...REPO_EXCLUDE_DIRS],
  });
  for (const file of files) {
    const ext = path.extname(file);
    const language = extensionMap.get(ext);
    if (language) counts.set(language, (counts.get(language) ?? 0) + 1);
  }
  const order = ['C', 'C++', 'C++ headers', 'C headers', 'ASM', 'Rust', 'Zig'];
  return order
    .filter((language) => counts.has(language))
    .map((language) => ({ language, files: counts.get(language) }));
}

function detectProbe(boardDir) {
  const openocdFile = path.join(boardDir, 'openocd.cfg');
  const hwFile = path.join(boardDir, 'hw.sh');
  const probe = {
    hardwareRunner: isFile(hwFile) ? path.join(boardDir, 'hw.sh') : null,
    openocdConfig: isFile(openocdFile) ? openocdFile : null,
    adapter: null,
    transport: null,
    vidPid: null,
    gdbServer: null,
  };
  if (!probe.openocdConfig) return probe;
  const text = fs.readFileSync(openocdFile, 'utf8');
  const adapter = text.match(/^\s*adapter\s+driver\s+(\S+)/m);
  if (adapter) probe.adapter = adapter[1];
  const sourced = text.match(/source\s+\[find\s+interface\/([^\]]+)\]/);
  if (sourced) probe.adapter = sourced[1].replace(/\.cfg$/, '');
  const boardSource = text.match(/source\s+\[find\s+board\/([^\]]+)\]/);
  if (boardSource) probe.adapter = `board/${boardSource[1].replace(/\.cfg$/, '')}`;
  const transport = text.match(/^\s*transport\s+select\s+(\S+)/m);
  if (transport) probe.transport = transport[1];
  const vidPid = text.match(/cmsis-dap\s+vid_pid\s+((?:0x[0-9a-fA-F]+\s+){1,8}0x[0-9a-fA-F]+)/);
  if (vidPid) probe.vidPid = vidPid[1].trim();
  probe.gdbServer = /gdb\s+port\s+disabled/.test(text) ? 'disabled' : 'enabled';
  return probe;
}

function detectBuildSystem(sourcePath) {
  if (isFile(path.join(sourcePath, 'CMakeLists.txt'))) return 'cmake';
  if (isFile(path.join(sourcePath, 'Cargo.toml'))) return 'cargo';
  if (isFile(path.join(sourcePath, 'build.zig'))) return 'zig';
  return null;
}

function isTestSource(name) {
  return (
    name === 'main.cpp' ||
    name === 'main.c' ||
    name === 'main.rs' ||
    name === 'main.zig' ||
    /\.(cpp|cc|cxx|c|rs|zig)$/.test(name)
  );
}

function testIfDirectory(dir, app, kind) {
  try {
    const files = fs.readdirSync(dir, { withFileTypes: true });
    if (!files.some((file) => file.isFile() && isTestSource(file.name))) return null;
  } catch {
    return null;
  }
  return { app, target: app, kind, path: dir };
}

function detectBoardTests(sourcePath, boardId) {
  const dir = path.join(sourcePath, 'test', boardId);
  const tests = [];
  if (!isDirectory(dir)) return tests;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (['include', 'src', 'boards', 'shared'].includes(entry.name)) continue;
    if (entry.name.startsWith('build')) continue;
    const test = testIfDirectory(path.join(dir, entry.name), entry.name, 'board-test');
    if (test) tests.push(test);
  }
  return tests.sort((a, b) => naturalCompare(a.app, b.app));
}

function detectPreTest(sourcePath, boardDir, boardId) {
  const candidates = [
    path.join(boardDir, 'pre-test.sh'),
    path.join(boardDir, `${boardId}-prepare.sh`),
  ];
  if (/visionfive|vf2/i.test(boardId)) {
    candidates.push(
      path.join(sourcePath, 'vf2-reset-to-uboot-picoprobe.sh'),
      path.join(sourcePath, 'vf2-reset-to-uboot.sh')
    );
  }
  for (const candidate of candidates) {
    if (isFile(candidate)) return candidate;
  }
  // Generic: a reset-to-U-Boot helper at the project root, only for a
  // VisionFive/VF2 board.
  if (!/visionfive|vf2/i.test(boardId)) return null;
  try {
    const files = fs
      .readdirSync(sourcePath, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /reset.*uboot.*\.sh$/i.test(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => (a.includes('picoprobe') ? -1 : b.includes('picoprobe') ? 1 : 0));
    if (files.length) return path.join(sourcePath, files[0]);
  } catch {
    // ignore
  }
  return null;
}

function detectBoards(sourcePath, buildSystem) {
  const boards = new Map();
  const add = (id, dir) => {
    if (boards.has(id)) return;
    boards.set(id, {
      id,
      ...detectProbe(dir),
      preTestScript: detectPreTest(sourcePath, dir, id),
      tests: buildSystem === 'cmake' ? [] : detectBoardTests(sourcePath, id),
    });
  };

  for (const base of ['test/boards', 'boards']) {
    const dir = path.join(sourcePath, base);
    if (!isDirectory(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (['shared', 'include', 'src'].includes(entry.name)) continue;
      add(entry.name, path.join(dir, entry.name));
    }
  }

  // A root `boards/` directory means the tests under `test/` are shared
  // applications for every board (Zig AArch ports). Otherwise each
  // `test/<board>/` owns its tests (Cortex-M, Rust, Zig Cortex-M/POSIX).
  const hasTopBoardsDir = isDirectory(path.join(sourcePath, 'boards'));
  const testDir = path.join(sourcePath, 'test');
  const shared = [];
  if (isDirectory(testDir)) {
    for (const entry of fs.readdirSync(testDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (['include', 'src', 'boards', 'shared', 'build'].includes(entry.name)) continue;
      if (entry.name.startsWith('build')) continue;
      if (hasTopBoardsDir) {
        const test = testIfDirectory(path.join(testDir, entry.name), entry.name, 'shared-test');
        if (test) shared.push(test);
      } else {
        const tests = detectBoardTests(sourcePath, entry.name);
        if (tests.length) add(entry.name, path.join(testDir, entry.name));
      }
    }
  }
  if (buildSystem !== 'cmake' && shared.length) {
    for (const board of boards.values()) {
      if (board.tests.length === 0) board.tests = shared.slice();
    }
  }

  // Zig POSIX port: no board directory, one synthetic `native` board and the
  // test applications are test/<app>/main.zig.
  if (buildSystem === 'zig' && boards.size === 0 && /posix/.test(path.basename(sourcePath))) {
    const nativeTests = [];
    if (isDirectory(testDir)) {
      for (const entry of fs.readdirSync(testDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (['include', 'src', 'boards', 'shared'].includes(entry.name)) continue;
        const test = testIfDirectory(path.join(testDir, entry.name), entry.name, 'shared-test');
        if (test) nativeTests.push(test);
      }
    }
    boards.set('native', {
      id: 'native',
      ...detectProbe(sourcePath),
      tests: nativeTests,
    });
  }

  return [...boards.values()].sort((a, b) => naturalCompare(a.id, b.id));
}

function detectDocumentation(sourcePath) {
  const files = walk(sourcePath, { excludeDirs: [...REPO_EXCLUDE_DIRS] });
  const markdown = [];
  const pdf = [];
  for (const file of files) {
    const rel = path.relative(sourcePath, file).replaceAll(path.sep, '/');
    if (rel.endsWith('.md')) markdown.push(rel);
    if (rel.endsWith('.pdf')) pdf.push(rel);
  }
  return { markdown: markdown.sort(), pdf: pdf.sort() };
}

function readPackage(sourcePath) {
  return readJson(path.join(sourcePath, 'package.json'), {}) ?? {};
}

function platformProjectMapping(platform, kernelDir, kernelId = 'micro-os-plus-iii') {
  if (platform.startsWith('aarch32')) return 'micro-os-plus-iii-aarch32';
  if (platform.startsWith('aarch64')) return 'micro-os-plus-iii-aarch64';
  if (platform.startsWith('riscv')) return 'micro-os-plus-iii-riscv';
  if (platform === 'native') return 'micro-os-plus-iii-posix-arch';
  if (
    platform.startsWith('cortexm') ||
    platform.startsWith('qemu-cortex') ||
    platform.startsWith('pico2') ||
    platform.startsWith('2xcortex')
  ) {
    return 'micro-os-plus-iii-cortexm';
  }
  // Legacy upstream boards use the kernel directly.
  if (isDirectory(path.join(kernelDir, 'tests', 'platforms', platform))) return kernelId;
  return null;
}

function inferBoardFromPlatformId(id) {
  if (id === 'native') return 'native';
  for (const prefix of ['aarch32-', 'aarch64-', 'cortexm-']) {
    if (id.startsWith(prefix)) return id.slice(prefix.length);
  }
  return null;
}

function detectPlatforms(kernelDir, kernelId) {
  const platformsDir = path.join(kernelDir, 'tests', 'platforms');
  const platforms = [];
  if (!isDirectory(platformsDir)) return platforms;
  for (const entry of fs.readdirSync(platformsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const id = entry.name;
    const dir = path.join(platformsDir, id);
    const definitions = path.join(dir, 'cmake', 'definitions.cmake');
    let board = null;
    if (isFile(definitions)) {
      // Anchored at the start of a line so commented examples do not win.
      const match = fs
        .readFileSync(definitions, 'utf8')
        .match(/^\s*set\s*\(\s*BOARD\s+"([^"]+)"/m);
      if (match) board = match[1];
    }
    if (!board) board = inferBoardFromPlatformId(id);
    const cmakeText = isFile(path.join(dir, 'CMakeLists.txt'))
      ? fs.readFileSync(path.join(dir, 'CMakeLists.txt'), 'utf8')
      : '';
    const qemu = [];
    for (const binary of ['qemu-system-arm', 'qemu-system-aarch64', 'qemu-system-riscv32', 'qemu-system-riscv64']) {
      if (cmakeText.includes(binary)) qemu.push(binary);
    }
    platforms.push({
      id,
      board,
      project: platformProjectMapping(id, kernelDir, kernelId),
      qemu,
      hasHardwareTests: /-hwd|-hw\b|hw\.sh/.test(cmakeText),
    });
  }
  return platforms.sort((a, b) => naturalCompare(a.id, b.id));
}

function detectBuildConfigurations(kernelDir) {
  const packageJson = readJson(path.join(kernelDir, 'tests', 'package.json'), {}) ?? {};
  const configurations = packageJson?.xpack?.buildConfigurations ?? {};
  const result = [];
  for (const [name, value] of Object.entries(configurations)) {
    if (value?.hidden) continue;
    const match = name.match(/^(.*)-cmake-(.*?)-(debug|release)$/);
    if (!match) continue;
    result.push({
      name,
      platform: match[1],
      toolchain: match[2],
      buildType: match[3] === 'release' ? 'Release' : 'Debug',
      inherits: value?.inherit ?? null,
    });
  }
  return result.sort((a, b) => naturalCompare(a.name, b.name));
}

function readCmakeList(text, name) {
  // Strip comments first so a ')' inside a comment cannot close the list.
  const cleaned = text.replace(/#[^\n]*/g, '');
  const match = cleaned.match(new RegExp(`set\\s*\\(\\s*${name}\\s+([\\s\\S]*?)\\)`));
  if (!match) return [];
  return match[1].split(/\s+/).filter(Boolean);
}

function detectPlatformTests(platform, project, kernelDir) {
  const tests = [];
  const platformCmake = path.join(kernelDir, 'tests', 'platforms', platform.id, 'CMakeLists.txt');
  const text = isFile(platformCmake) ? fs.readFileSync(platformCmake, 'utf8') : '';

  // Upstream-style platforms build portable harness suites directly.
  const suites = [];
  for (const match of text.matchAll(
    /add_suite_executable\s*\(\s*([A-Za-z0-9_.-]+)\s+([A-Za-z0-9_.-]+)/g
  )) {
    suites.push({
      app: match[2],
      target: match[1],
      kind: 'suite',
      ctestPattern: `^${platform.id}-${match[1]}$`,
    });
  }
  if (suites.length) return suites;

  // Legacy upstream boards name their CTest cases directly.
  const legacy = [];
  for (const match of text.matchAll(/add_test_executable\s*\(\s*([A-Za-z0-9_.-]+)/g)) {
    legacy.push({
      app: match[1],
      target: match[1],
      kind: 'legacy-board',
      ctestPattern: `^${match[1]}$`,
    });
  }
  if (legacy.length) return legacy;

  // Port platforms own one test directory per application under test/<board>/.
  if (project && project.role !== 'kernel' && platform.board) {
    const testDir = path.join(project.sourcePath, 'test', platform.board);
    if (isDirectory(testDir)) {
      const testsCmake = path.join(testDir, 'tests.cmake');
      const hwdOnly = isFile(testsCmake)
        ? readCmakeList(fs.readFileSync(testsCmake, 'utf8'), 'BOARD_TEST_HWD_ONLY')
        : [];
      const boardCmake = path.join(
        project.sourcePath,
        'test',
        'boards',
        platform.board,
        'board.cmake'
      );
      const boardText = isFile(boardCmake)
        ? fs.readFileSync(boardCmake, 'utf8').replace(/#[^\n]*/g, '')
        : '';
      const hasQemuLinker = /set\s*\(\s*UOS_BOARD_LINKER_QEMU\b/.test(boardText);
      for (const entry of fs.readdirSync(testDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (['include', 'src'].includes(entry.name)) continue;
        const appDir = path.join(testDir, entry.name);
        let sources = [];
        try {
          sources = fs.readdirSync(appDir).filter((name) => name.endsWith('.cpp'));
        } catch {
          continue;
        }
        if (!sources.length) continue;
        const variants =
          project.architecture === 'posix'
            ? ['host']
            : hwdOnly.includes(entry.name) || !hasQemuLinker
              ? ['hwd']
              : ['qemu', 'hwd'];
        const variantPattern =
          variants.length === 1 ? variants[0] : `(${variants.join('|')})`;
        tests.push({
          app: entry.name,
          target: entry.name,
          kind: 'board-test',
          path: appDir,
          ctestPattern: `^${platform.id}-${entry.name}-${variantPattern}$`,
        });
      }
    }
  }
  return tests.sort((a, b) => naturalCompare(a.app, b.app));
}

function inferTools(project, platforms, buildConfigurations) {
  const tools = new Set(['cmake', 'ninja', 'git', 'python3']);
  const languages = project.languages.map((entry) => entry.language);
  if (languages.includes('C') || languages.includes('C++') || languages.includes('ASM')) {
    if (project.architecture === 'posix') {
      tools.add('gcc');
      tools.add('g++');
    } else if (project.architecture === 'aarch64') {
      tools.add('aarch64-none-elf-gcc');
      tools.add('aarch64-none-elf-g++');
      tools.add('aarch64-none-elf-gdb');
    } else if (project.architecture !== 'portable') {
      tools.add('arm-none-eabi-gcc');
      tools.add('arm-none-eabi-g++');
      tools.add('arm-none-eabi-gdb');
    }
  }
  if (languages.includes('Rust') || project.buildSystem === 'cargo') {
    tools.add('rustc');
    tools.add('cargo');
  }
  if (languages.includes('Zig') || project.buildSystem === 'zig') tools.add('zig');

  for (const platform of platforms) {
    for (const qemu of platform.qemu) tools.add(qemu);
    if (platform.hasHardwareTests) tools.add('openocd');
  }
  if (project.architecture === 'riscv') {
    tools.add('riscv-none-elf-gcc');
    tools.add('riscv-none-elf-g++');
    tools.add('riscv-none-elf-gdb');
    // The RISC-V platforms delegate QEMU to their board qemu.sh scripts.
    tools.add('qemu-system-riscv32');
    tools.add('qemu-system-riscv64');
  }
  const hasHardware = (project.boards ?? []).some((board) => board.hardwareRunner);
  if (hasHardware) {
    tools.add('openocd');
    if (project.architecture === 'aarch64') tools.add('aarch64-none-elf-gdb');
    else if (project.architecture !== 'posix') tools.add('arm-none-eabi-gdb');
  }
  return [...tools].sort(naturalCompare);
}

function pickDefaultPlatform(projectId, platforms, buildConfigurations) {
  const preferred = {
    'micro-os-plus-iii-aarch32': 'aarch32-rpi3b',
    'micro-os-plus-iii-aarch64': 'aarch64-rpi3b',
    'micro-os-plus-iii-cortexm': 'qemu-cortex-m7f',
    'micro-os-plus-iii-riscv': 'riscv-milkv-duo',
    'micro-os-plus-iii-posix-arch': 'native',
  }[projectId];
  if (preferred && platforms.some((platform) => platform.id === preferred)) return preferred;
  const withDebug = platforms.find((platform) =>
    buildConfigurations.some(
      (config) => config.platform === platform.id && config.buildType === 'Debug'
    )
  );
  return withDebug?.id ?? platforms[0]?.id ?? null;
}

function pickDefaultBuildConfiguration(platformId, buildConfigurations) {
  if (!platformId) return null;
  const matching = buildConfigurations.filter(
    (config) => config.platform === platformId && config.buildType === 'Debug'
  );
  if (!matching.length) return buildConfigurations.find((c) => c.platform === platformId)?.name ?? null;
  // Prefer the host "sys" configuration for native, then gcc, then anything.
  const order = [
    `${platformId}-cmake-sys-debug`,
    `${platformId}-cmake-gcc-debug`,
  ];
  for (const name of order) {
    if (matching.some((config) => config.name === name)) return name;
  }
  return matching[0].name;
}

function discoverProject(sourcePath, kernelDir, id, buildSystem) {
  const pkg = readPackage(sourcePath);
  const isKernel = sourcePath === kernelDir;
  const architecture = isKernel ? 'portable' : classifyArchitecture(id, sourcePath);
  const boards = detectBoards(sourcePath, buildSystem);
  const documentation = detectDocumentation(sourcePath);
  const languages = detectLanguages(sourcePath);
  const sizeBytes = dirSize(sourcePath, { excludeDirs: [...REPO_EXCLUDE_DIRS] });
  const project = {
    id,
    name: pkg.description ?? id,
    packageName: pkg.name ?? id,
    version: pkg.version ?? null,
    role: isKernel ? 'kernel' : 'port',
    buildSystem,
    architecture,
    sourcePath,
    git: gitInfo(sourcePath),
    languages,
    boards,
    documentation,
    sizeBytes,
  };
  return project;
}

function findKernelDir(root) {
  // CMake workspace.
  for (const name of [
    'micro-os-plus-iii',
    'micro-os-plus-iii.git',
    'micro-os-plus-iii-smp',
    'micro-os-plus-iii-smp.git',
  ]) {
    const candidate = path.join(root, name);
    if (isFile(path.join(candidate, 'CMakeLists.txt'))) return candidate;
  }
  // Rust workspace: the kernel is the -rust repository.
  for (const name of ['micro-os-plus-iii-rust', 'micro-os-plus-iii-rust.git']) {
    const candidate = path.join(root, name);
    if (isFile(path.join(candidate, 'Cargo.toml'))) return candidate;
  }
  // Zig workspace: the kernel has build.zig.
  for (const name of ['micro-os-plus-iii', 'micro-os-plus-iii.git']) {
    const candidate = path.join(root, name);
    if (isFile(path.join(candidate, 'build.zig'))) return candidate;
  }
  return path.join(root, 'micro-os-plus-iii');
}

function discover(sourceRoot) {
  const root = path.resolve(sourceRoot);
  if (!isDirectory(root)) {
    throw new Error(`Source root does not exist or is not a directory: ${root}`);
  }
  const kernelDir = findKernelDir(root);
  const kernelId = path.basename(kernelDir).replace(/\.git$/, '');
  const kernelBuildSystem = detectBuildSystem(kernelDir);
  const isCMakeWorkspace = kernelBuildSystem === 'cmake';
  const platforms = isCMakeWorkspace ? detectPlatforms(kernelDir, kernelId) : [];
  const buildConfigurations = isCMakeWorkspace ? detectBuildConfigurations(kernelDir) : [];

  const candidates = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const sourcePath = path.join(root, entry.name);
    if (!/^micro-os-plus-iii($|[-.])/.test(entry.name)) continue;
    const buildSystem = detectBuildSystem(sourcePath);
    if (!buildSystem) continue;
    const id = entry.name.replace(/\.git$/, '');
    // When both names exist, micro-os-plus-iii is the kernel and
    // micro-os-plus-iii-smp is the same project under its release name.
    if (id === 'micro-os-plus-iii-smp' && sourcePath !== kernelDir) continue;
    candidates.push({ sourcePath, id, buildSystem });
  }
  candidates.sort((a, b) => {
    if (a.sourcePath === kernelDir) return -1;
    if (b.sourcePath === kernelDir) return 1;
    return naturalCompare(a.sourcePath, b.sourcePath);
  });

  const projects = candidates.map((candidate) =>
    discoverProject(candidate.sourcePath, kernelDir, candidate.id, candidate.buildSystem)
  );
  for (const project of projects) {
    if (project.buildSystem === 'cmake') {
      const ownPlatforms = platforms.filter((platform) => platform.project === project.id);
      project.platforms = ownPlatforms;
    } else {
      // Cargo/Zig projects own their boards and shared test directories.
      project.platforms = project.boards.map((board) => {
        const platformId =
          board.id === 'native'
            ? 'native'
            : `${project.architecture}-${board.id}`;
        return {
          id: platformId,
          board: board.id,
          project: project.id,
          qemu: [],
          hasHardwareTests: Boolean(board.hardwareRunner || board.openocdConfig),
          tests: board.tests ?? [],
          generic: true,
        };
      });
      for (const platform of project.platforms) {
        buildConfigurations.push({
          name: `${platform.id}-${project.buildSystem}-debug`,
          platform: platform.id,
          toolchain: project.buildSystem,
          buildType: 'Debug',
          buildSystem: project.buildSystem,
          generic: true,
        });
      }
    }
    project.defaultPlatform =
      project.role === 'kernel'
        ? null
        : pickDefaultPlatform(project.id, project.platforms, buildConfigurations);
    project.defaultBuildConfiguration = pickDefaultBuildConfiguration(
      project.defaultPlatform,
      buildConfigurations
    );
    project.tools = inferTools(project, project.platforms, buildConfigurations);
    project.selected = project.role !== 'kernel';
    project.scaffoldName =
      project.role === 'kernel'
        ? project.buildSystem === 'cmake'
          ? 'micro-os-plus-iii-smp'
          : project.id
        : project.id;
  }

  projects.sort((a, b) => {
    if (a.role === 'kernel' && b.role !== 'kernel') return -1;
    if (b.role === 'kernel' && a.role !== 'kernel') return 1;
    return naturalCompare(a.id, b.id);
  });
  projects.forEach((project, index) => {
    project.index = index + 1;
  });
  // Attach the three-level selection identity: architecture.platform.test.
  for (const project of projects) {
    project.platforms.forEach((platform, platformIndex) => {
      platform.platformIndex = platformIndex + 1;
      platform.selectionId = `${project.index}.${platform.platformIndex}`;
      const platformTests = platform.generic
        ? platform.tests
        : detectPlatformTests(platform, project, kernelDir);
      platform.tests = platformTests.map((test, testIndex) => ({
        ...test,
        testIndex: testIndex + 1,
        selectionId: `${platform.selectionId}.${testIndex + 1}`,
      }));
      platform.testCount = platform.tests.length;
    });
    project.platformCount = project.platforms.length;
    project.testCount = project.platforms.reduce(
      (total, platform) => total + platform.tests.length,
      0
    );
  }

  const harnessDir = path.join(kernelDir, 'tests');
  const harness = {
    sourcePath: isCMakeWorkspace ? harnessDir : null,
    platforms,
    buildConfigurations,
    sharedRunnersDir: isCMakeWorkspace
      ? path.join(kernelDir, 'test_smpl')
      : isDirectory(path.join(kernelDir, 'test_smpl'))
        ? path.join(kernelDir, 'test_smpl')
        : null,
    xpacks: {},
  };

  const kernel = projects.find((project) => project.role === 'kernel') ?? null;
  const ports = projects.filter((project) => project.role !== 'kernel');

  return {
    sourceRoot: root,
    discoveredAt: new Date().toISOString(),
    kernel,
    ports,
    projects,
    platforms,
    buildConfigurations,
    harness,
  };
}

module.exports = { discover, platformProjectMapping };
