'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isDirectory, isFile, naturalCompare, pathExists } = require('./util');

function readList(text, name) {
  const cleaned = text.replace(/#[^\n]*/g, '');
  const match = cleaned.match(new RegExp(`set\\s*\\(\\s*${name}\\s+([\\s\\S]*?)\\)`));
  if (!match) return [];
  return match[1].split(/\s+/).filter(Boolean);
}

function removeIfEmpty(dir) {
  try {
    if (isDirectory(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch {
    // ignore
  }
}

function selectedTestsByPlatform(config) {
  const map = new Map();
  for (const entry of config.build?.configurations ?? []) {
    if (entry.buildSystem && entry.buildSystem !== 'cmake') continue;
    map.set(
      entry.platform,
      new Set((entry.tests ?? []).map((test) => test.app))
    );
  }
  return map;
}

function selectedBoardsByProject(config, project) {
  const boards = new Set();
  for (const platformId of selectedTestsByPlatform(config).keys()) {
    const platform = (project.platforms ?? []).find((item) => item.id === platformId);
    if (platform?.board) boards.add(platform.board);
  }
  return boards;
}

function helperDirsForApp(appDir) {
  const helpers = new Set();
  let files = [];
  try {
    files = fs
      .readdirSync(appDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.(cpp|cc|cxx|c|h|hpp|rs|zig)$/.test(entry.name))
      .map((entry) => path.join(appDir, entry.name));
  } catch {
    return helpers;
  }
  for (const file of files) {
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const match of text.matchAll(/#include\s+"\.\.\/([^/"]+)\//g)) {
      helpers.add(match[1]);
    }
  }
  return helpers;
}

function patchSkipList(file, names) {
  if (!names.size || !isFile(file)) return false;
  let text = fs.readFileSync(file, 'utf8');
  const original = text;
  for (const name of names) {
    if (text.includes(`_app STREQUAL "${name}"`)) continue;
    text = text.replace(
      /if \(_app STREQUAL "include" OR _app STREQUAL "src"\)/,
      `if (_app STREQUAL "include" OR _app STREQUAL "src" OR _app STREQUAL "${name}")`
    );
  }
  if (text !== original) {
    fs.writeFileSync(file, text);
    return true;
  }
  return false;
}

function referencedBoardDirs(project, boardsDir, boardId) {
  const refs = new Set();
  const boardCmake = path.join(boardsDir, boardId, 'board.cmake');
  if (!isFile(boardCmake)) return refs;
  const text = fs.readFileSync(boardCmake, 'utf8');
  for (const match of text.matchAll(/set\s*\(\s*UOS_BOARD_[A-Z0-9_]+\s+"([^"]+)"/g)) {
    const raw = match[1]
      .replaceAll('${CMAKE_CURRENT_LIST_DIR}', path.join(boardsDir, boardId))
      .replaceAll('${CMAKE_CURRENT_SOURCE_DIR}', path.join(boardsDir, boardId));
    const absolute = path.resolve(path.join(boardsDir, boardId), raw);
    const rel = path.relative(boardsDir, absolute);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      refs.add(rel.split(path.sep)[0]);
    }
  }
  return refs;
}

function prunePortTests(project, destination, selectedTests, selectedBoards) {
  const portDir = path.join(destination, project.scaffoldName);
  const testDir = path.join(portDir, 'test');
  if (!isDirectory(testDir)) return;

  const boardsDir = path.join(testDir, 'boards');
  const keepBoardDirs = new Set(selectedBoards);
  if (isDirectory(boardsDir)) {
    for (const board of selectedBoards) {
      for (const ref of referencedBoardDirs(project, boardsDir, board)) {
        keepBoardDirs.add(ref);
      }
    }
    for (const entry of fs.readdirSync(boardsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === 'shared' || keepBoardDirs.has(entry.name)) continue;
      fs.rmSync(path.join(boardsDir, entry.name), { recursive: true, force: true });
    }
  }

  for (const board of selectedBoards) {
    const boardTestDir = path.join(testDir, board);
    if (!isDirectory(boardTestDir)) continue;
    let keep = new Set();
    for (const [platformId, set] of selectedTests.entries()) {
      const platform = (project.platforms ?? []).find((item) => item.id === platformId);
      if (platform?.board === board && set.size > 0) {
        keep = set;
        break;
      }
    }

    const helpers = new Set();
    for (const entry of fs.readdirSync(boardTestDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (['include', 'src'].includes(entry.name)) continue;
      if (!keep.has(entry.name)) continue;
      for (const helper of helperDirsForApp(path.join(boardTestDir, entry.name))) {
        if (isDirectory(path.join(boardTestDir, helper))) helpers.add(helper);
      }
    }

    for (const entry of fs.readdirSync(boardTestDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (['include', 'src'].includes(entry.name)) continue;
      if (keep.has(entry.name) || helpers.has(entry.name)) continue;
      fs.rmSync(path.join(boardTestDir, entry.name), { recursive: true, force: true });
    }

    patchSkipList(path.join(testDir, 'CMakeLists.txt'), helpers);
    for (const platformId of selectedTests.keys()) {
      const platformCmake = path.join(
        destination,
        'tests',
        'platforms',
        platformId,
        'CMakeLists.txt'
      );
      patchSkipList(platformCmake, helpers);
    }
  }

  // Remove test directories of boards that are no longer present.
  for (const entry of fs.readdirSync(testDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (['boards', 'include', 'src'].includes(entry.name)) continue;
    if (selectedBoards.has(entry.name)) continue;
    if (entry.name.startsWith('build')) continue;
    fs.rmSync(path.join(testDir, entry.name), { recursive: true, force: true });
  }
}
function removeCmakeCalls(text, command, keep) {
  let result = '';
  let cursor = 0;
  const token = `${command} (`;
  while (true) {
    const start = text.indexOf(token, cursor);
    if (start < 0) break;
    let depth = 0;
    let end = start;
    for (; end < text.length; end += 1) {
      if (text[end] === '(') depth += 1;
      else if (text[end] === ')') {
        depth -= 1;
        if (depth === 0) {
          end += 1;
          break;
        }
      }
    }
    const call = text.slice(start, end);
    const match = call.match(
      new RegExp(`${command}\\s*\\(\\s*([^\\s)]+)(?:\\s+([^\\s)]+))?`)
    );
    const name = match?.[1] ?? '';
    const suite = match?.[2] ?? '';
    if (!keep(name, suite)) {
      result += text.slice(cursor, start);
    } else {
      result += text.slice(cursor, end);
    }
    cursor = end;
  }
  result += text.slice(cursor);
  return result;
}

function prunePlatformTargets(destination, platformId, selectedApps) {
  const file = path.join(
    destination,
    'tests',
    'platforms',
    platformId,
    'CMakeLists.txt'
  );
  if (!isFile(file)) return;
  let text = fs.readFileSync(file, 'utf8');
  const original = text;

  text = removeCmakeCalls(
    text,
    'add_suite_executable',
    (name, suite) =>
      selectedApps.has(suite) ||
      selectedApps.has(name) ||
      [...selectedApps].some(
        (app) => app.startsWith(`${suite}-`) || app.startsWith(`${name}-`)
      )
  );
  text = removeCmakeCalls(
    text,
    'add_test_executable',
    (name) =>
      selectedApps.has(name) ||
      [...selectedApps].some((app) => app.startsWith(`${name}-`) || name.startsWith(`${app}-`))
  );

  // The native platform adds the CMSIS-OS validator as an extra target, not
  // from a test directory.
  if (!selectedApps.has('cmsis-os-validator')) {
    const start = text.indexOf('add_executable (cmsis-os-validator-test)');
    if (start >= 0) {
      const marker = 'PROPERTIES LABELS "host" TIMEOUT 600\n)';
      const end = text.indexOf(marker, start);
      if (end >= 0) {
        text = text.slice(0, start) + text.slice(end + marker.length + 1);
      }
    }
  }

  if (text !== original) fs.writeFileSync(file, text);
}

function pruneHarness(config, destination, selectedTests) {
  const testsDir = path.join(destination, 'tests');
  if (!isDirectory(testsDir)) return;
  const platformsDir = path.join(testsDir, 'platforms');
  const keepPlatforms = new Set(selectedTests.keys());

  if (isDirectory(platformsDir)) {
    for (const entry of fs.readdirSync(platformsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (!keepPlatforms.has(entry.name)) {
        fs.rmSync(path.join(platformsDir, entry.name), { recursive: true, force: true });
      }
    }
  }

  // Which harness suites do the selected tests need?
  const keptSuites = new Set();
  for (const platformId of keepPlatforms) {
    const project = (config.projects ?? []).find((item) =>
      (item.platforms ?? []).some((platform) => platform.id === platformId)
    );
    const platform = project?.platforms.find((item) => item.id === platformId);
    if (!project || !platform?.board) continue;
    const testsCmake = path.join(
      destination,
      project.scaffoldName,
      'test',
      platform.board,
      'tests.cmake'
    );
    if (!isFile(testsCmake)) continue;
    const text = fs.readFileSync(testsCmake, 'utf8');
    const suites = readList(text, 'BOARD_TEST_HARNESS_SUITES');
    const selected = selectedTests.get(platformId) ?? new Set();
    const availableSuites = isDirectory(path.join(testsDir, 'sources'))
      ? fs
          .readdirSync(path.join(testsDir, 'sources'), { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
      : [];
    for (const app of selected) {
      if (suites.includes(app)) keptSuites.add(app);
      for (const suite of availableSuites) {
        if (app === suite || app.startsWith(`${suite}-`)) keptSuites.add(suite);
      }
    }
  }

  const sourcesDir = path.join(testsDir, 'sources');
  if (isDirectory(sourcesDir)) {
    for (const entry of fs.readdirSync(sourcesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (!keptSuites.has(entry.name)) {
        fs.rmSync(path.join(sourcesDir, entry.name), { recursive: true, force: true });
      }
    }
    removeIfEmpty(sourcesDir);
  }

  // Remove platform-level targets that are not part of the selection.
  for (const [platformId, apps] of selectedTests.entries()) {
    prunePlatformTargets(destination, platformId, apps);
  }

  // Device layer and xPack libraries.
  const depsTexts = new Map();
  for (const platformId of keepPlatforms) {
    const deps = path.join(
      testsDir,
      'platforms',
      platformId,
      'cmake',
      'dependencies-folders.cmake'
    );
    if (isFile(deps)) depsTexts.set(platformId, fs.readFileSync(deps, 'utf8'));
  }
  const qemuNeeded = (config.build?.configurations ?? []).some(
    (entry) =>
      keepPlatforms.has(entry.platform) &&
      (entry.tests ?? []).some((test) => /qemu/.test(test.ctestPattern ?? ''))
  );
  const deviceReferenced = [...depsTexts.values()].some((text) =>
    text.includes('device-qemu-cortexm')
  );
  const deviceDir = path.join(testsDir, 'device-qemu-cortexm');
  if (!(qemuNeeded && deviceReferenced) && isDirectory(deviceDir)) {
    fs.rmSync(deviceDir, { recursive: true, force: true });
  }

  const xpacksDir = path.join(testsDir, 'xpacks');
  if (isDirectory(xpacksDir)) {
    const keep = new Set(['@micro-os-plus/build-helper']);
    if (keptSuites.has('rtos-apis')) keep.add('@xpacks/chan-fatfs');
    if (keptSuites.has('cmsis-os-validator')) {
      keep.add('@xpacks/arm-cmsis-rtos-validator');
    }
    for (const entry of fs.readdirSync(xpacksDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const top = path.join(xpacksDir, entry.name);
      if (entry.name.startsWith('@')) {
        for (const child of fs.readdirSync(top, { withFileTypes: true })) {
          const rel = `${entry.name}/${child.name}`;
          if (keep.has(rel)) continue;
          fs.rmSync(path.join(top, child.name), { recursive: true, force: true });
        }
        removeIfEmpty(top);
      } else if (!keep.has(entry.name)) {
        fs.rmSync(top, { recursive: true, force: true });
      }
    }
  }

  // Trim build-helper to the CMake module, the toolchains and, for host
  // builds, the library-path probe.
  const buildHelper = path.join(xpacksDir, '@micro-os-plus', 'build-helper');
  if (isDirectory(buildHelper)) {
    const keepFiles = new Set([
      'package.json',
      'LICENSE',
      'cmake/micro-os-plus-build-helper.cmake',
      'cmake/toolchains/arm-none-eabi-gcc.cmake',
      'cmake/toolchains/aarch64-none-elf-gcc.cmake',
      'cmake/toolchains/riscv-none-elf-gcc.cmake',
      'cmake/toolchains/gcc.cmake',
    ]);
    const usesHost = (config.build?.configurations ?? []).some(
      (entry) => !entry.toolchainFile
    );
    if (usesHost) keepFiles.add('dev-scripts/get-libraries-paths.sh');
    const walk = (dir, rel = '') => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const childRel = rel ? `${rel}/${entry.name}` : entry.name;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full, childRel);
          removeIfEmpty(full);
        } else if (!keepFiles.has(childRel)) {
          fs.rmSync(full, { force: true });
        }
      }
    };
    walk(buildHelper);
  }

  // Top-level workspace docs are not needed by a minimal build.
  const docsDir = path.join(destination, 'docs');
  if (isDirectory(docsDir)) fs.rmSync(docsDir, { recursive: true, force: true });

  // Filter each kept platform's original dependency list to entries that
  // still exist after pruning. Build-tree xPack links are kept only when the
  // selected tests need them.
  for (const platformId of keepPlatforms) {
    const deps = path.join(
      testsDir,
      'platforms',
      platformId,
      'cmake',
      'dependencies-folders.cmake'
    );
    const original = depsTexts.get(platformId);
    if (!original) continue;
    const project = (config.projects ?? []).find((item) =>
      (item.platforms ?? []).some((platform) => platform.id === platformId)
    );
    const entries = [...original.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
    const kept = entries.filter((entry) => {
      if (entry.includes('${CMAKE_BINARY_DIR}')) {
        if (entry.includes('libucontext')) return project?.architecture === 'posix';
        return qemuNeeded;
      }
      const absolute = entry.replace('${CMAKE_SOURCE_DIR}', testsDir);
      return isDirectory(absolute);
    });
    fs.writeFileSync(
      deps,
      [
        '# Generated minimal dependency list (micro-os-scaffold).',
        'set (xpack_dependencies_folders',
        ...kept.map((entry) => `  "${entry}"`),
        ')',
        '',
      ].join('\n')
    );
  }

  // Harness documentation and unused top-level extras.
  for (const name of ['README.md', 'TO-CHECK.md', 'package.json.original']) {
    fs.rmSync(path.join(testsDir, name), { force: true });
  }
  const deprecated = path.join(testsDir, 'deprecated');
  if (isDirectory(deprecated)) fs.rmSync(deprecated, { recursive: true, force: true });

  // Shared runners are only needed by platforms that call them.
  const runnersNeeded = [...keepPlatforms].some((platformId) => {
    const cmake = path.join(testsDir, 'platforms', platformId, 'CMakeLists.txt');
    if (!isFile(cmake)) return false;
    return /test_smpl|run-qemu|run-host|run-hw/.test(fs.readFileSync(cmake, 'utf8'));
  });
  const runners = path.join(destination, 'test_smpl');
  if (!runnersNeeded && isDirectory(runners)) {
    fs.rmSync(runners, { recursive: true, force: true });
  }

  // The integration entry point is not used by a minimal build/test tree.
  const integration = path.join(destination, 'integration');
  if (isDirectory(integration)) fs.rmSync(integration, { recursive: true, force: true });

  // Generated OpenOCD index is only useful when it has entries.
  const openocd = path.join(testsDir, 'openocd');
  if (isDirectory(openocd)) {
    const cfgs = [];
    const collect = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) collect(full);
        else if (entry.name.endsWith('.cfg')) cfgs.push(full);
      }
    };
    collect(openocd);
    if (!cfgs.length) fs.rmSync(openocd, { recursive: true, force: true });
  }
}

function selectedAppsByBoard(config) {
  const map = new Map();
  for (const entry of config.build?.configurations ?? []) {
    if (entry.buildSystem !== 'cargo') continue;
    map.set(entry.board, new Set((entry.tests ?? []).map((test) => test.app)));
  }
  return map;
}

function pruneCargoWorkspace(config, destination) {
  const selected = selectedAppsByBoard(config);
  if (!selected.size) return { boards: 0, tests: 0 };
  for (const project of config.projects ?? []) {
    if (project.role === 'kernel') continue;
    if (project.buildSystem !== 'cargo') continue;
    if (!(config.selectedProjects ?? []).includes(project.id)) continue;
    const portDir = project.destinationPath;

    // Remove unselected board crates and their test directories.
    const boardsDir = path.join(portDir, 'test', 'boards');
    if (isDirectory(boardsDir)) {
      for (const entry of fs.readdirSync(boardsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (entry.name === 'shared' || selected.has(entry.name)) continue;
        fs.rmSync(path.join(boardsDir, entry.name), { recursive: true, force: true });
      }
    }
    const testRoot = path.join(portDir, 'test');
    if (isDirectory(testRoot)) {
      for (const entry of fs.readdirSync(testRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (['boards', 'include', 'src'].includes(entry.name)) continue;
        if (selected.has(entry.name)) continue;
        fs.rmSync(path.join(testRoot, entry.name), { recursive: true, force: true });
      }
    }

    for (const [board, apps] of selected.entries()) {
      const boardTestDir = path.join(testRoot, board);
      if (!isDirectory(boardTestDir)) continue;
      for (const entry of fs.readdirSync(boardTestDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (['include', 'src'].includes(entry.name)) continue;
        if (apps.has(entry.name)) continue;
        fs.rmSync(path.join(boardTestDir, entry.name), { recursive: true, force: true });
      }

      // Remove example blocks for the tests that are no longer present.
      const boardCargo = path.join(boardsDir, board, 'Cargo.toml');
      if (isFile(boardCargo)) {
        let text = fs.readFileSync(boardCargo, 'utf8');
        const parts = text.split(/(?=\[\[example\]\])/);
        const kept = parts.filter((part) => {
          if (!part.startsWith('[[example]]')) return true;
          const match = part.match(/^\s*path\s*=\s*"([^"]+)"/m);
          if (!match) return true;
          const app = path.basename(path.dirname(match[1]));
          return apps.has(app);
        });
        fs.writeFileSync(boardCargo, kept.join(''));
      }
    }

    // Rewrite the workspace member list to the selected board crates.
    const workspaceCargo = path.join(portDir, 'Cargo.toml');
    if (isFile(workspaceCargo)) {
      let text = fs.readFileSync(workspaceCargo, 'utf8');
      const members = ['crates/*'];
      if (isDirectory(path.join(portDir, 'drivers'))) members.push('drivers');
      for (const board of selected.keys()) members.push(`test/boards/${board}`);
      text = text.replace(
        /^members\s*=\s*\[[\s\S]*?\]/m,
        `members = [${members.map((member) => `"${member}"`).join(', ')}]`
      );
      fs.writeFileSync(workspaceCargo, text);
    }
  }
  return {
    boards: selected.size,
    tests: [...selected.values()].reduce((total, set) => total + set.size, 0),
  };
}

function splitZigEntries(body) {
  const entries = [];
  let cursor = 0;
  while (true) {
    const start = body.indexOf('.{', cursor);
    if (start < 0) break;
    let depth = 0;
    let end = start;
    for (; end < body.length; end += 1) {
      if (body[end] === '{') depth += 1;
      else if (body[end] === '}') {
        depth -= 1;
        if (depth === 0) {
          end += 1;
          break;
        }
      }
    }
    while (end < body.length && /[\s,]/.test(body[end])) end += 1;
    entries.push(body.slice(start, end));
    cursor = end;
  }
  return entries;
}

function replaceZigTable(text, headerRegex, keep) {
  const match = text.match(headerRegex);
  if (!match) return text;
  const body = match[2];
  const entries = splitZigEntries(body).filter(keep);
  return text.replace(headerRegex, `${match[1]}\n${entries.join('\n')}\n${match[3]}`);
}

function zigId(entry) {
  const match = entry.match(
    /\.(?:id|board)\s*=\s*\.(?:"([^"]+)"|@"([^"]+)"|([A-Za-z0-9_-]+))/
  );
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

function zigName(entry) {
  return entry.match(/\.name\s*=\s*"([^"]+)"/)?.[1] ?? null;
}

function zigDir(entry) {
  return entry.match(/\.dir\s*=\s*"([^"]+)"/)?.[1] ?? null;
}

function pruneZigWorkspace(config, destination) {
  const selected = new Map();
  for (const entry of config.build?.configurations ?? []) {
    if (entry.buildSystem !== 'zig') continue;
    selected.set(entry.board, new Set((entry.tests ?? []).map((test) => test.app)));
  }
  if (!selected.size) return { boards: 0, tests: 0 };
  const allSelectedApps = new Set(
    [...selected.values()].flatMap((apps) => [...apps])
  );
  const selectedBoards = new Set(selected.keys());

  for (const project of config.projects ?? []) {
    if (project.role === 'kernel') continue;
    if (project.buildSystem !== 'zig') continue;
    if (!(config.selectedProjects ?? []).includes(project.id)) continue;
    const portDir = project.destinationPath;
    const buildZig = path.join(portDir, 'build.zig');
    if (!isFile(buildZig)) continue;
    let text = fs.readFileSync(buildZig, 'utf8');

    // Map selected test names to their source folder (the .dir override).
    const testDirs = new Map();
    const testMatch = text.match(
      /(?:pub )?const tests = \[_\]Test\{([\s\S]*?)\n\};/
    );
    if (testMatch) {
      for (const entry of splitZigEntries(testMatch[1])) {
        const name = zigName(entry);
        if (name) testDirs.set(name, zigDir(entry) ?? name);
      }
    }

    // Prune the board list.
    text = replaceZigTable(
      text,
      /((?:pub )?const boards = \[_\]Board\{)([\s\S]*?)(\n\};)/,
      (entry) => {
        const id = zigId(entry);
        return id ? selectedBoards.has(id) : false;
      }
    );

    // Prune the test list.
    text = replaceZigTable(
      text,
      /((?:pub )?const tests = \[_\]Test\{)([\s\S]*?)(\n\};)/,
      (entry) => {
        const name = zigName(entry);
        return name ? allSelectedApps.has(name) : false;
      }
    );

    // Cortex-M uses a board_tests table in addition to the generic tests.
    text = replaceZigTable(
      text,
      /(const board_tests = \[_\]struct \{[^\n]*\n)([\s\S]*?)(\n\};)/,
      (entry) => {
        const board = zigId(entry);
        const name = zigName(entry);
        return Boolean(
          board && name && selectedBoards.has(board) && (selected.get(board)?.has(name) ?? false)
        );
      }
    );
    fs.writeFileSync(buildZig, text);

    // Remove board sources that are no longer selected.
    const boardsDir = path.join(portDir, 'boards');
    if (isDirectory(boardsDir)) {
      for (const entry of fs.readdirSync(boardsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (selectedBoards.has(entry.name)) continue;
        fs.rmSync(path.join(boardsDir, entry.name), { recursive: true, force: true });
      }
    }
    const srcBoards = path.join(portDir, 'src', 'boards');
    if (isDirectory(srcBoards)) {
      for (const entry of fs.readdirSync(srcBoards, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.zig')) continue;
        const board = entry.name.replace(/\.zig$/, '');
        if (selectedBoards.has(board)) continue;
        fs.rmSync(path.join(srcBoards, entry.name), { force: true });
      }
    }

    // Prune test directories.
    const testRoot = path.join(portDir, 'test');
    if (!isDirectory(testRoot)) continue;
    const keepDirs = new Set();
    for (const app of allSelectedApps) {
      const dir = testDirs.get(app) ?? app;
      keepDirs.add(dir.split('/')[0]);
    }
    for (const entry of fs.readdirSync(testRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (['include', 'src', 'boards', 'shared'].includes(entry.name)) continue;
      if (selectedBoards.has(entry.name)) {
        // Cortex-M per-board test directory: keep only selected applications.
        const apps = selected.get(entry.name) ?? new Set();
        const boardDir = path.join(testRoot, entry.name);
        for (const appEntry of fs.readdirSync(boardDir, { withFileTypes: true })) {
          if (!appEntry.isDirectory()) continue;
          if (['include', 'src'].includes(appEntry.name)) continue;
          if (apps.has(appEntry.name)) continue;
          fs.rmSync(path.join(boardDir, appEntry.name), { recursive: true, force: true });
        }
        continue;
      }
      if (!keepDirs.has(entry.name)) {
        fs.rmSync(path.join(testRoot, entry.name), { recursive: true, force: true });
      }
    }
  }
  return {
    boards: selectedBoards.size,
    tests: allSelectedApps.size,
  };
}

function pruneCMakeWorkspace(config, destination) {
  const selected = selectedTestsByPlatform(config);
  if (!selected.size) return { platforms: [], suites: [] };

  for (const project of config.projects ?? []) {
    if (project.role === 'kernel') continue;
    if (!(config.selectedProjects ?? []).includes(project.id)) continue;
    if (project.buildSystem !== 'cmake') continue;
    const selectedBoards = selectedBoardsByProject(config, project);
    prunePortTests(project, destination, selected, selectedBoards);
  }

  pruneHarness(config, destination, selected);
  return {
    platforms: [...selected.keys()],
    tests: [...selected.values()].reduce((total, set) => total + set.size, 0),
  };
}

function pruneWorkspace(config, destination) {
  if (config.projects?.some((project) => project.buildSystem === 'cargo' && (config.selectedProjects ?? []).includes(project.id))) {
    return pruneCargoWorkspace(config, destination);
  }
  if (config.projects?.some((project) => project.buildSystem === 'zig' && (config.selectedProjects ?? []).includes(project.id))) {
    return pruneZigWorkspace(config, destination);
  }
  return pruneCMakeWorkspace(config, destination);
}

module.exports = { pruneWorkspace, pruneCMakeWorkspace, pruneCargoWorkspace, pruneZigWorkspace };
