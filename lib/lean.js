'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isDirectory, isFile } = require('./util');
const { leanExtensionGuide } = require('./lean-guide');
const { readmeSection: microTestPlusReadme } = require('./micro-test-plus-readme');

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

/**
 * Text of the scripts and configurations that drive the selected boards: the
 * board directories, the board test directories and the port's test/ scripts.
 */
function boardScriptText(portDir, boardIds) {
  const chunks = [];
  const wanted = /\.(sh|cfg|cmake|gdb|tcl|py)$|^CMakeLists\.txt$/i;
  const visit = (dir, depth) => {
    if (!isDirectory(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth > 0) visit(full, depth - 1);
      } else if (wanted.test(entry.name)) {
        chunks.push(fs.readFileSync(full, 'utf8'));
      }
    }
  };
  visit(path.join(portDir, 'test'), 0);
  visit(path.join(portDir, 'cmake'), 1);
  for (const boardId of boardIds) {
    visit(path.join(portDir, 'test', 'boards', boardId), 2);
    visit(path.join(portDir, 'test', boardId), 2);
  }
  const rootCmake = path.join(portDir, 'CMakeLists.txt');
  if (isFile(rootCmake)) chunks.push(fs.readFileSync(rootCmake, 'utf8'));
  return chunks.join('\n');
}

function prunePortRoot(project, destination, boardIds) {
  const portDir = path.join(destination, project.scaffoldName);
  if (!isDirectory(portDir)) return;
  // The union of what every selected board needs: pruning board by board
  // would remove the SoC support of the boards handled earlier.
  const keepDirs = new Set();
  for (const boardId of boardIds) {
    for (const name of boardKeepDirs(portDir, boardId)) keepDirs.add(name);
  }
  const candidates = [];
  // A root directory the port's CMake files name (drivers/, devices/ ...) is
  // a build input even though it is not one of the standard directories.
  const cmakeText = boardScriptText(portDir, boardIds).replace(/#[^\n]*/g, '');
  const namedInCmake = (name) =>
    !/^(include-|build|doc)/.test(name) &&
    new RegExp(`[/"\\s]${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`).test(cmakeText);
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
    if (entry.isDirectory() && namedInCmake(name)) continue;
    if (entry.isFile() && PORT_ROOT_KEEP_FILE.some((rule) => rule.test(name))) {
      candidates.push(name);
      continue;
    }
    fs.rmSync(path.join(portDir, name), { recursive: true, force: true });
  }
  // Probe configurations and reset scripts at the port root belong to one
  // board each: keep those the selected boards name, and what these name.
  let text = boardScriptText(portDir, boardIds);
  const kept = new Set();
  for (let changed = true; changed; ) {
    changed = false;
    for (const name of candidates) {
      if (kept.has(name) || !text.includes(name)) continue;
      kept.add(name);
      text += `\n${fs.readFileSync(path.join(portDir, name), 'utf8')}`;
      changed = true;
    }
  }
  for (const name of candidates) {
    if (!kept.has(name)) fs.rmSync(path.join(portDir, name), { force: true });
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
  // The OpenOCD wrapper is only useful when the selection has a probe.
  if (!neededTools(config).openocd) {
    fs.rmSync(path.join(testsDir, 'openocd.sh'), { force: true });
  }
  fs.rmSync(path.join(testsDir, 'openocd'), { recursive: true, force: true });
  pruneBuildHelper(config, destination);
}

function pruneHarnessExtras(destination) {
  const testsDir = path.join(destination, 'tests');
  for (const name of ['README.md', 'TO-CHECK.md', 'package.json.original']) {
    fs.rmSync(path.join(testsDir, name), { force: true });
  }
  const platformsDir = path.join(testsDir, 'platforms');
  if (isDirectory(platformsDir)) removeDocFiles(platformsDir);
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

function pruneBoardExtras(config, destination, project, board) {
  const boardDir = path.join(destination, project.scaffoldName, 'test', 'boards', board);
  if (!isDirectory(boardDir)) return;
  const platformIds = new Set(
    (project.platforms ?? [])
      .filter((platform) => platform.board === board)
      .map((platform) => platform.id)
  );
  const apps = [];
  let qemuNeeded = false;
  for (const entry of config.build?.configurations ?? []) {
    if (!platformIds.has(entry.platform)) continue;
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
    if (
      BOARD_DIR_DROP.test(entry.name) ||
      /^README(\.|$)/i.test(entry.name) ||
      entry.name === '.gitkeep' ||
      /\.(bak|orig)$/i.test(entry.name)
    ) {
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
    const selected = (project.platforms ?? []).filter((platform) =>
      (config.selectedPlatforms ?? []).includes(platform.id)
    );
    if (!selected.length) continue;
    prunePortRoot(project, destination, [...new Set(selected.map((platform) => platform.board))]);
    for (const board of new Set(selected.map((platform) => platform.board))) {
      pruneBoardExtras(config, destination, project, board);
    }
    pruneBoardDirs(project, destination);
    // Documentation and placeholders are not build or run inputs.
    const portTest = path.join(destination, project.scaffoldName, 'test');
    if (isDirectory(portTest)) removeDocFiles(portTest);
  }
  pruneHarnessExtras(destination);
  pruneLeanHarness(config, destination);
  for (const name of ['docs', 'integration']) {
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
    sourceUrl: config.sourceUrl,
    sourceBranch: config.sourceBranch,
    microTestPlus: config.microTestPlus,
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
  const allTests = config.selectedTests ?? [];
  // The selection the workspace was made for; the µTest++ starter test is
  // added by the scaffolder and listed with it, but is not a selection.
  const tests = allTests.filter ((test) => test.kind !== 'micro-test-plus');
  const title =
    tests.length === 1
      ? `${project?.scaffoldName} / ${platform?.id} / ${tests[0].app}`
      : `${project?.scaffoldName} / ${platform?.id}`;

  lines.push(`# Minimal test workspace: ${title}`, '');
  lines.push(
    'Generated by `micro-os-scaffold` in **lean** mode. The kernel is copied',
    'complete because the test is written against its interface; the port keeps',
    'only the files its build and runner need; the test harness and scripts',
    'keep only the selected test and the material it references.',
    '',
    'The workspace is self-contained and relocatable: the scripts find it from',
    'their own location, and a build tree moved with it is detected and rebuilt.',
    '[Adding new functionality](#adding-new-functionality-to-this-workspace)',
    'explains where new files, libraries and tests go.',
    ''
  );

  lines.push('## Selected test', '');
  const isCmake = !project?.buildSystem || project.buildSystem === 'cmake';
  if (isCmake) {
    lines.push('| Selection | Test | CTest cases |', '| --- | --- | --- |');
  } else {
    lines.push('| Selection | Test |', '| --- | --- |');
  }
  for (const test of allTests) {
    const row = `| \`${test.selectionId ?? test.app}\` | \`${test.platform ?? platform?.id}/${test.app}\` |`;
    lines.push(isCmake ? `${row} \`${test.ctestPattern || '—'}\` |` : row);
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
    lines.push('## Build and run', '', '```bash', 'cd tests');
    if (isCmake) {
      for (const entry of buildEntries) {
        lines.push(`./run.sh build -c ${entry.name}`);
      }
      lines.push('');
      for (const entry of buildEntries) {
        lines.push(`./run.sh -c ${entry.name}           # build + the selected tests`);
      }
      lines.push('./run.sh list                        # the CTest cases');
      lines.push('./run.sh --hwd                       # include the board cases');
    } else {
      for (const entry of buildEntries) {
        lines.push(`./build.sh ${entry.name}`);
        lines.push(`./test.sh ${entry.name}`);
      }
    }
    lines.push('```', '');
    if (isCmake) {
      lines.push(
        '`run.sh` configures and builds first, then runs CTest. It takes an',
        'application directory name (`mtp-example`), a full CTest name or a',
        'selection id; without a name it runs the selected tests. Hardware',
        '(`-hwd`) cases need the board and the probe: `--hwd` includes them,',
        '`all` runs everything.',
        '',
        'The results are files too: `build/<configuration>/ctest.xml` (JUnit;',
        'CTest caps each console snippet at 1 KiB),',
        '`build/<configuration>/ctest.log` (the full CTest output), and the complete',
        'µTest++ TAP report next to each runner log (`<app>.tap` in `.hw-logs`,',
        '`.qemu-logs` or `.host-logs`).',
        ''
      );
    }
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

  const guide = leanExtensionGuide(config, project, platform, tests);
  if (guide) lines.push(guide.trimEnd(), '');
  const mtpSection = microTestPlusReadme (config);
  if (mtpSection) lines.push(mtpSection.trimEnd(), '');

  lines.push('## Regenerate', '', '```bash');
  lines.push(`node ${config.generator?.cli ?? 'bin/scaffold.js'} \\`);
  lines.push(`  ${config.destination} \\`);
  lines.push(`  --source ${config.sourceUrl ?? config.sourceRoot} \\`);
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
  if (config.sourceBranch) lines.push(`  --branch ${config.sourceBranch} \\`);
  if (config.microTestPlus?.spec) {
    lines.push(`  --micro-test-plus ${config.microTestPlus.spec} \\`);
    if (config.microTestPlus.ref) lines.push(`  --micro-test-plus-ref ${config.microTestPlus.ref} \\`);
  }
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
    if (entry.result) {
      entry.result.buildTreeCleaned = true;
    }
  }
  for (const res of config.build?.results ?? []) {
    res.buildTreeCleaned = true;
  }
  const buildRoot = path.join(destination, 'tests', 'build');
  // Cargo and Zig build inside the project; their per-configuration folder here is empty.
  if (isDirectory(buildRoot)) {
    for (const name of fs.readdirSync(buildRoot)) {
      const dir = path.join(buildRoot, name);
      if (isDirectory(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
    }
  }
  if (isDirectory(buildRoot) && fs.readdirSync(buildRoot).length === 0) {
    fs.rmSync(buildRoot, { recursive: true, force: true });
  }
}

module.exports = {
  neededTools,
  pruneLeanWorkspace,
  cleanLeanOutputs,
  slimConfig,
  leanReadme,
};
