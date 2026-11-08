'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isDirectory, isFile } = require('./util');

/*
 * Lean mode: keep the kernel repository complete (it is the interface the
 * test is written against), and keep only the build- and run-essential files
 * of the selected port. Everything a test does not need -- port docs,
 * changelogs, PDFs, editor settings, alternate configs and unrelated boards
 * -- is removed.
 */

const PORT_ROOT_KEEP = new Set([
  'CMakeLists.txt',
  'LICENSE',
  'cmake',
  'include',
  'soc',
  'src',
  'qemu',
  'test',
]);

const PORT_ROOT_KEEP_FILE = [
  /\.cfg$/i,
  /\.gdb$/i,
  /^hw.*\.sh$/i,
  /^vf2-.*\.sh$/i,
  /reset-to-uboot.*\.sh$/i,
];

const BOARD_DIR_DROP = /\.(md|pdf|png|jpg|jpeg|svg)$/i;

function boardKeepDirs(portDir, boardId) {
  const keep = new Set(['include', 'src', 'test', 'qemu']);
  const boardCmake = path.join(portDir, 'test', 'boards', boardId, 'board.cmake');
  if (!isFile(boardCmake)) return keep;

  const text = fs.readFileSync(boardCmake, 'utf8');
  for (const match of text.matchAll(/\binclude-[A-Za-z0-9_-]+/g)) {
    keep.add(match[0]);
  }

  const socDir = path.join(portDir, 'soc');
  const socDirs = isDirectory(socDir)
    ? fs
        .readdirSync(socDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    : [];
  for (const match of text.matchAll(/\bsoc-([A-Za-z0-9_]+)/g)) {
    const suffix = match[1];
    for (const dir of socDirs) {
      if (
        suffix === dir ||
        suffix.startsWith(dir) ||
        (suffix.startsWith('stm32f4') && dir === 'stm32f4xx')
      ) {
        keep.add(`soc/${dir}`);
      }
    }
  }
  return keep;
}

function prunePortRoot(project, destination, boardId) {
  const portDir = path.join(destination, project.scaffoldName);
  if (!isDirectory(portDir)) return;
  const keepDirs = boardKeepDirs(portDir, boardId);
  for (const entry of fs.readdirSync(portDir, { withFileTypes: true })) {
    const name = entry.name;
    if (entry.isDirectory() && name === 'soc') {
      const socDir = path.join(portDir, 'soc');
      for (const child of fs.readdirSync(socDir, { withFileTypes: true })) {
        if (!child.isDirectory()) continue;
        if (keepDirs.has(`soc/${child.name}`)) continue;
        fs.rmSync(path.join(socDir, child.name), { recursive: true, force: true });
      }
      continue;
    }
    if (PORT_ROOT_KEEP.has(name) || keepDirs.has(name)) continue;
    if (entry.isFile() && PORT_ROOT_KEEP_FILE.some((rule) => rule.test(name))) {
      continue;
    }
    fs.rmSync(path.join(portDir, name), { recursive: true, force: true });
  }
}

function pruneBoardDirs(project, destination) {
  const testDir = path.join(destination, project.scaffoldName, 'test');
  const boardsDir = path.join(testDir, 'boards');
  if (!isDirectory(boardsDir)) return;
  for (const board of fs.readdirSync(boardsDir, { withFileTypes: true })) {
    if (!board.isDirectory()) continue;
    const boardDir = path.join(boardsDir, board.name);
    for (const entry of fs.readdirSync(boardDir, { withFileTypes: true })) {
      const full = path.join(boardDir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'debug' && fs.readdirSync(full).length === 0) {
          fs.rmSync(full, { recursive: true, force: true });
        }
        continue;
      }
      if (BOARD_DIR_DROP.test(entry.name)) fs.rmSync(full, { force: true });
    }
  }
}

function pruneBuildHelper(config, destination) {
  const helper = path.join(
    destination,
    'tests',
    'xpacks',
    '@micro-os-plus',
    'build-helper',
    'cmake',
    'toolchains'
  );
  if (!isDirectory(helper)) return;
  const keep = new Set();
  for (const entry of config.build?.configurations ?? []) {
    if (entry.toolchainFile) {
      keep.add(path.basename(entry.toolchainFile));
    } else {
      keep.add('gcc.cmake');
    }
  }
  for (const entry of fs.readdirSync(helper, { withFileTypes: true })) {
    if (entry.isFile() && keep.has(entry.name)) continue;
    fs.rmSync(path.join(helper, entry.name), { recursive: true, force: true });
  }
}

function pruneLeanHarness(config, destination) {
  const testsDir = path.join(destination, 'tests');
  const qemuNeeded = (config.build?.configurations ?? []).some((entry) =>
    (entry.tests ?? []).some((test) => /qemu/.test(test.ctestPattern ?? ''))
  );
  if (!qemuNeeded) fs.rmSync(path.join(testsDir, 'qemu.sh'), { force: true });
  fs.rmSync(path.join(testsDir, 'openocd'), { recursive: true, force: true });
  pruneBuildHelper(config, destination);
}

function pruneHarnessExtras(destination) {
  const testsDir = path.join(destination, 'tests');
  for (const name of ['README.md', 'TO-CHECK.md', 'package.json.original']) {
    fs.rmSync(path.join(testsDir, name), { force: true });
  }
  for (const name of ['deprecated', 'openocd']) {
    const full = path.join(testsDir, name);
    if (isDirectory(full) && fs.readdirSync(full).length === 0) {
      fs.rmSync(full, { recursive: true, force: true });
    }
  }
  // The per-port scaffold notes duplicate the top-level lean README.
  for (const entry of fs.readdirSync(destination, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    fs.rmSync(path.join(destination, entry.name, 'README-SCAFFOLD.md'), {
      force: true,
    });
  }
}

function pruneBoardExtras(config, destination, project, platform) {
  const boardDir = path.join(
    destination,
    project.scaffoldName,
    'test',
    'boards',
    platform.board
  );
  if (!isDirectory(boardDir)) return;
  const apps = [];
  let qemuNeeded = false;
  for (const entry of config.build?.configurations ?? []) {
    if (entry.platform !== platform.id) continue;
    for (const test of entry.tests ?? []) {
      apps.push(test.app);
      if (/qemu/.test(test.ctestPattern ?? '')) qemuNeeded = true;
    }
  }
  if (!apps.some((app) => /usb/.test(app))) {
    fs.rmSync(path.join(boardDir, 'usb'), { recursive: true, force: true });
  }
  if (!qemuNeeded) {
    fs.rmSync(path.join(boardDir, 'qemu'), { recursive: true, force: true });
  }
}

const CARGO_ROOT_KEEP = new Set([
  'Cargo.toml',
  'Cargo.lock',
  'rust-toolchain.toml',
  'clippy.toml',
  'LICENSE',
  'crates',
  'drivers',
  'test',
  '.cargo',
  'target',
]);

const ZIG_ROOT_KEEP = new Set([
  'build.zig',
  'build.zig.zon',
  'src',
  'test',
  'extern',
  'LICENSE',
  'zig-out',
  'zig-pkg',
  '.zig-cache',
]);

function removeDocFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'target' || entry.name === '.git') continue;
      removeDocFiles(full);
      continue;
    }
    if (BOARD_DIR_DROP.test(entry.name) || /^README(\.|$)/i.test(entry.name)) {
      fs.rmSync(full, { force: true });
    }
  }
}

function cargoCrateRefs(portDir, text) {
  const keep = new Set();
  const queue = [text];
  while (queue.length) {
    const current = queue.pop();
    for (const match of current.matchAll(/path\s*=\s*"([^"]+)"/g)) {
      const ref = match[1].match(/crates\/([A-Za-z0-9_-]+)/);
      if (!ref || keep.has(ref[1])) continue;
      const dir = path.join(portDir, 'crates', ref[1]);
      if (!isDirectory(dir)) continue;
      keep.add(ref[1]);
      const manifest = path.join(dir, 'Cargo.toml');
      if (isFile(manifest)) queue.push(fs.readFileSync(manifest, 'utf8'));
    }
  }
  return keep;
}

function pruneLeanCargoProject(config, destination, project) {
  const portDir = path.join(destination, project.scaffoldName);
  if (!isDirectory(portDir)) return;

  for (const entry of fs.readdirSync(portDir, { withFileTypes: true })) {
    if (CARGO_ROOT_KEEP.has(entry.name)) continue;
    fs.rmSync(path.join(portDir, entry.name), { recursive: true, force: true });
  }

  const boards = new Set();
  for (const platform of project.platforms ?? []) {
    if ((config.selectedPlatforms ?? []).includes(platform.id)) boards.add(platform.board);
  }
  const keepCrates = new Set();
  for (const board of boards) {
    const manifest = path.join(portDir, 'test', 'boards', board, 'Cargo.toml');
    if (!isFile(manifest)) continue;
    for (const name of cargoCrateRefs(portDir, fs.readFileSync(manifest, 'utf8'))) {
      keepCrates.add(name);
    }
  }
  const cratesDir = path.join(portDir, 'crates');
  if (keepCrates.size && isDirectory(cratesDir)) {
    for (const entry of fs.readdirSync(cratesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (keepCrates.has(entry.name)) continue;
      fs.rmSync(path.join(cratesDir, entry.name), { recursive: true, force: true });
    }
  }

  removeDocFiles(path.join(portDir, 'test'));
}

function pruneZigExtern(destination) {
  const externDir = path.join(destination, 'extern');
  if (!isDirectory(externDir)) return;
  for (const dep of fs.readdirSync(externDir, { withFileTypes: true })) {
    if (!dep.isDirectory()) continue;
    const depDir = path.join(externDir, dep.name);
    for (const name of ['.git', '.github', 'design', 'examples', 'sim', 'website']) {
      fs.rmSync(path.join(depDir, name), { recursive: true, force: true });
    }
    for (const name of ['.gitattributes', '.gitignore', 'README.md', 'README.pdf']) {
      fs.rmSync(path.join(depDir, name), { force: true });
    }
  }
}

function pruneLeanZigProject(config, destination, project) {
  const portDir = path.join(destination, project.scaffoldName);
  if (!isDirectory(portDir)) return;

  for (const entry of fs.readdirSync(portDir, { withFileTypes: true })) {
    if (ZIG_ROOT_KEEP.has(entry.name)) continue;
    fs.rmSync(path.join(portDir, entry.name), { recursive: true, force: true });
  }

  removeDocFiles(path.join(portDir, 'test'));
  pruneZigExtern(destination);
}

function pruneLeanWorkspace(config, destination) {
  for (const project of config.projects ?? []) {
    if (project.role === 'kernel') continue;
    if (!(config.selectedProjects ?? []).includes(project.id)) continue;
    if (project.buildSystem === 'cargo') {
      pruneLeanCargoProject(config, destination, project);
      continue;
    }
    if (project.buildSystem === 'zig') {
      pruneLeanZigProject(config, destination, project);
      continue;
    }
    if (project.buildSystem !== 'cmake') continue;
    for (const platform of project.platforms ?? []) {
      if (!(config.selectedPlatforms ?? []).includes(platform.id)) continue;
      prunePortRoot(project, destination, platform.board);
      pruneBoardExtras(config, destination, project, platform);
    }
    pruneBoardDirs(project, destination);
  }
  pruneHarnessExtras(destination);
  pruneLeanHarness(config, destination);
  for (const name of ['docs', 'test_smpl', 'integration']) {
    fs.rmSync(path.join(destination, name), { recursive: true, force: true });
  }
}

function selectedPlatformIds(config) {
  return new Set(config.selectedPlatforms ?? []);
}

function selectedAppIds(config) {
  return new Set(
    (config.selectedTests ?? []).map((test) => `${test.platform}/${test.app}`)
  );
}

function neededTools(config) {
  const keys = new Set();
  let cmake = false;

  for (const entry of config.build?.configurations ?? []) {
    if (entry.buildSystem === 'cargo') {
      keys.add('cargo');
      keys.add('rustc');
    } else if (entry.buildSystem === 'zig') {
      keys.add('zig');
    } else if (!entry.buildSystem || entry.buildSystem === 'cmake') {
      cmake = true;
      if (entry.toolchain) {
        keys.add(entry.toolchain);
        keys.add(entry.toolchain.replace(/-gcc$/, '-g++'));
        keys.add(entry.toolchain.replace(/-gcc$/, '-gdb'));
      } else {
        keys.add('gcc');
        keys.add('g++');
        keys.add('gdb');
      }
    }
  }
  if (cmake) {
    keys.add('cmake');
    keys.add('git');
    keys.add('ninja');
    keys.add('python3');
  }

  const selected = new Set(config.selectedPlatforms ?? []);
  const platforms = [];
  for (const project of config.projects ?? []) {
    for (const platform of project.platforms ?? []) {
      if (selected.has(platform.id)) platforms.push({ project, platform });
    }
  }
  if (platforms.some(({ platform }) => platform.hasHardwareTests)) {
    keys.add('openocd');
  }

  const wantsQemu = (config.build?.configurations ?? []).some((entry) =>
    (entry.tests ?? []).some((test) => /qemu/.test(test.ctestPattern ?? ''))
  );
  if (wantsQemu) {
    for (const { project } of platforms) {
      if (project.architecture === 'riscv') {
        keys.add('qemu-system-riscv32');
        keys.add('qemu-system-riscv64');
      } else if (project.architecture === 'aarch64') {
        keys.add('qemu-system-aarch64');
      } else if (
        project.architecture === 'arm' ||
        project.architecture === 'cortexm' ||
        project.architecture === 'aarch32'
      ) {
        keys.add('qemu-system-arm');
      }
    }
  }

  const tools = {};
  for (const [key, tool] of Object.entries(config.tools ?? {})) {
    if (keys.has(key)) tools[key] = tool;
  }
  return tools;
}

function slimConfig(config) {
  const platforms = selectedPlatformIds(config);
  const apps = selectedAppIds(config);
  return {
    schemaVersion: config.schemaVersion,
    generatedAt: config.generatedAt,
    generator: config.generator,
    sourceRoot: config.sourceRoot,
    destination: config.destination,
    mode: 'lean',
    minimal: true,
    lean: true,
    kernel: config.kernel
      ? {
          id: config.kernel.id,
          scaffoldName: config.kernel.scaffoldName,
          version: config.kernel.version,
          role: config.kernel.role,
          buildSystem: config.kernel.buildSystem,
          architecture: config.kernel.architecture,
          destinationPath: config.kernel.destinationPath,
        }
      : null,
    projects: (config.projects ?? [])
      .filter(
        (project) =>
          project.role === 'kernel' ||
          (config.selectedProjects ?? []).includes(project.id)
      )
      .map((project) => ({
        id: project.id,
        index: project.index,
        role: project.role,
        scaffoldName: project.scaffoldName,
        destinationPath: project.destinationPath,
        buildSystem: project.buildSystem,
        architecture: project.architecture,
        version: project.version,
        tools: project.tools,
        platforms: (project.platforms ?? [])
          .filter((platform) => platforms.has(platform.id))
          .map((platform) => ({
            id: platform.id,
            board: platform.board,
            project: platform.project,
            selectionId: platform.selectionId,
            platformIndex: platform.platformIndex,
            qemu: platform.qemu,
            hasHardwareTests: platform.hasHardwareTests,
            tests: (platform.tests ?? []).filter((test) =>
              apps.has(`${platform.id}/${test.app}`)
            ),
          })),
        boards: (project.boards ?? []).filter(
          (board) =>
            !platforms.size ||
            (project.platforms ?? []).some(
              (platform) =>
                platforms.has(platform.id) && platform.board === board.id
            )
        ),
      })),
    selectedProjects: config.selectedProjects,
    selectedSelections: config.selectedSelections,
    selectedPlatforms: config.selectedPlatforms,
    selectedTests: config.selectedTests,
    tools: neededTools(config),
    libraries: config.libraries,
    build: config.build,
  };
}

function toolRows(config) {
  return Object.entries(neededTools(config))
    .filter(([, tool]) => tool?.found)
    .map(([key, tool]) => `| \`${key}\` | \`${tool.version ?? '?'}\` | \`${tool.path}\` |`);
}

function leanReadme(config) {
  const lines = [];
  const project = (config.projects ?? []).find(
    (item) =>
      item.role !== 'kernel' &&
      (config.selectedProjects ?? []).includes(item.id)
  );
  const platform = project?.platforms?.find((item) =>
    (config.selectedPlatforms ?? []).includes(item.id)
  );
  const tests = config.selectedTests ?? [];
  const title =
    tests.length === 1
      ? `${project?.scaffoldName} / ${platform?.id} / ${tests[0].app}`
      : `${project?.scaffoldName} / ${platform?.id}`;

  lines.push(`# Minimal test workspace: ${title}`, '');
  lines.push(
    'Generated by `micro-os-scaffold` in **lean** mode. The kernel is copied',
    'complete because the test is written against its interface; the port keeps',
    'only the files its build and runner need; the test harness',
    'and test scripts keep only the selected test and the material it references.',
    ''
  );

  lines.push('## Selected test', '');
  lines.push('| Selection | Test | CTest |', '| --- | --- | --- |');
  for (const test of tests) {
    lines.push(
      `| \`${test.selectionId}\` | \`${platform?.id}/${test.app}\` | \`${test.ctestPattern || '—'}\` |`
    );
  }
  lines.push('');

  lines.push('## Layout', '');
  const kernelName = config.kernel?.scaffoldName ?? 'micro-os-plus-iii';
  const portName = project?.scaffoldName ?? '<port>';
  const pad = (text, width) => `${text}${' '.repeat(Math.max(1, width - text.length))}`;
  lines.push('```text');
  lines.push(`${pad(`${kernelName}/`, 28)}kernel, complete`);
  lines.push(`${pad(`${portName}/`, 28)}port, selected test only`);
  lines.push(
    `${pad('tests/', 28)}${
      project?.buildSystem === 'cmake'
        ? 'harness, selected platform only'
        : 'generated build and test scripts'
    }`
  );
  lines.push(`${pad('scaffold.json', 28)}slim manifest`);
  lines.push('```', '');

  const board = platform?.board ?? '<board>';
  lines.push('Kept in the port:', '');
  if (project?.buildSystem === 'cargo') {
    lines.push('- `Cargo.toml`, `Cargo.lock`, `rust-toolchain.toml`');
    lines.push('- `crates/` (the port crates the board uses)');
    lines.push(`- \`test/boards/${board}/\` (board crate)`);
    for (const test of tests) {
      lines.push(`- \`test/${board}/${test.app}/\``);
    }
  } else if (project?.buildSystem === 'zig') {
    lines.push('- `build.zig`, `build.zig.zon`');
    lines.push('- `src/` (selected board sources and shared helpers)');
    for (const test of tests) {
      lines.push(`- \`test/${test.app}/\` or \`test/${board}/${test.app}/\``);
    }
  } else {
    const portBuildDirs = ['CMakeLists.txt', 'cmake/', 'include/'];
    if (isDirectory(path.join(config.destination, portName, 'soc'))) {
      portBuildDirs.push('soc/');
    }
    portBuildDirs.push('src/');
    lines.push(`- ${portBuildDirs.map((name) => `\`${name}\``).join(', ')}`);
    lines.push(`- \`test/boards/${board}/\` (board files, linker script, runner)`);
    lines.push(`- \`test/${board}/include/\`, \`test/${board}/src/\`, \`tests.cmake\``);
    for (const test of tests) {
      lines.push(`- \`test/${board}/${test.app}/\``);
    }
  }
  lines.push('');

  lines.push('## Tools', '');
  lines.push('| Tool | Version | Path |', '| --- | --- | --- |');
  lines.push(...toolRows(config));
  lines.push('');

  const buildEntries = config.build?.configurations ?? [];
  if (buildEntries.length) {
    lines.push('## Build', '', '```bash', 'cd tests');
    for (const entry of buildEntries) {
      lines.push(`./build.sh ${entry.name}`);
    }
    lines.push('```', '');
    lines.push('## Run the test', '', '```bash');
    for (const entry of buildEntries) {
      if (entry.buildSystem && entry.buildSystem !== 'cmake') {
        lines.push(`./test.sh ${entry.name}`);
      } else {
        for (const test of entry.tests ?? []) {
          lines.push(`./test.sh ${entry.name} ${test.selectionId ?? test.app}`);
        }
      }
    }
    lines.push('```', '');
  }

  const preTest = project?.boards?.find((item) => item.id === board)?.preTestScript;
  if (preTest) {
    lines.push('## Board preparation', '');
    lines.push(
      'The hardware runner resets the board before each `-hwd` run. Set',
      '`UOS_SKIP_PRE_TEST=1` to skip it.',
      ''
    );
  }

  lines.push('## Regenerate', '', '```bash');
  lines.push('node /home/dan/Work/micro-os-scaffold/bin/scaffold.js \\');
  lines.push(`  ${config.destination} \\`);
  lines.push(`  --source ${config.sourceRoot} \\`);
  const selectors = [];
  for (const test of tests) {
    const owner = (config.projects ?? []).find(
      (item) => item.id === test.project
    );
    const plat = owner?.platforms?.find((item) => item.id === test.platform);
    if (plat) selectors.push(`${plat.selectionId}.${test.app}`);
  }
  lines.push(
    `  --select ${(selectors.length ? selectors : config.selectedSelections ?? []).join(',')} \\`
  );
  lines.push('  --lean --yes');
  lines.push('```', '');

  return `${lines.join('\n')}\n`;
}

function cleanLeanOutputs(config, destination) {
  for (const entry of config.build?.configurations ?? []) {
    const project = (config.projects ?? []).find((item) => item.id === entry.project);
    if (entry.buildSystem === 'cargo') {
      if (project?.destinationPath) {
        fs.rmSync(path.join(project.destinationPath, 'target'), {
          recursive: true,
          force: true,
        });
      }
    } else if (entry.buildSystem === 'zig') {
      if (project?.destinationPath) {
        for (const name of ['.zig-cache', 'zig-out', 'zig-pkg']) {
          fs.rmSync(path.join(project.destinationPath, name), {
            recursive: true,
            force: true,
          });
        }
      }
    } else {
      fs.rmSync(path.join(destination, 'tests', 'build', entry.name), {
        recursive: true,
        force: true,
      });
    }
  }
  const buildRoot = path.join(destination, 'tests', 'build');
  if (isDirectory(buildRoot) && fs.readdirSync(buildRoot).length === 0) {
    fs.rmSync(buildRoot, { recursive: true, force: true });
  }
}

module.exports = {
  pruneLeanWorkspace,
  cleanLeanOutputs,
  slimConfig,
  leanReadme,
};
