'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function run(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: options.timeout ?? 120000,
    maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
    cwd: options.cwd,
    env: options.env ?? process.env,
    shell: false,
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error,
  };
}

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function which(bin, extraPath = '') {
  if (!bin) return null;
  if (bin.includes(path.sep) && isExecutable(bin)) return path.resolve(bin);
  const pathEnv = [extraPath, process.env.PATH ?? ''].filter(Boolean).join(path.delimiter);
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, bin);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

function firstLine(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? '';
}

function versionOf(bin, args = ['--version']) {
  if (!bin) return null;
  const result = run(bin, args, { timeout: 20000 });
  const text = firstLine(result.stdout) || firstLine(result.stderr);
  return text || null;
}

function naturalCompare(a, b) {
  return String(a).localeCompare(String(b), 'en', { numeric: true, sensitivity: 'base' });
}

function newestDir(parent) {
  try {
    const dirs = fs
      .readdirSync(parent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort(naturalCompare);
    return dirs.length ? path.join(parent, dirs[dirs.length - 1]) : null;
  } catch {
    return null;
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeFile(file, content, mode) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, content);
  if (mode !== undefined) fs.chmodSync(file, mode);
}

function pathExists(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function realPath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function makeWritable(root) {
  const visit = (current) => {
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch {
      return;
    }
    if (stat.isDirectory()) {
      try {
        fs.chmodSync(current, stat.mode | 0o700);
      } catch {
        // ignore
      }
      for (const entry of fs.readdirSync(current)) visit(path.join(current, entry));
    } else if (stat.isFile()) {
      try {
        fs.chmodSync(current, stat.mode | 0o600);
      } catch {
        // ignore
      }
    }
  };
  if (pathExists(root)) visit(root);
}

/**
 * Copy a directory tree, preserving executable bits.
 * Symlinks are dereferenced (the source workspaces use symlinks for xPacks).
 */
function copyTree(src, dest, options = {}) {
  const excludeDirs = new Set(options.excludeDirs ?? []);
  const excludeNames = new Set(options.excludeNames ?? []);
  const excludeRel = options.excludeRel ?? (() => false);
  const source = realPath(src);
  if (!isDirectory(source)) {
    throw new Error(`copyTree: source is not a directory: ${src}`);
  }

  const shouldCopy = (current) => {
    const rel = path.relative(source, current);
    if (rel === '') return true;
    const base = path.basename(current);
    if (excludeDirs.has(base) && isDirectory(current)) return false;
    if (excludeNames.has(base)) return false;
    if (excludeRel(rel.replaceAll(path.sep, '/'))) return false;
    return true;
  };

  const destExisted = isDirectory(dest);
  ensureDir(dest);
  // xPack trees are installed read-only; make an existing destination
  // writable before refreshing it, otherwise a second scaffold run fails.
  if (destExisted) makeWritable(dest);
  fs.cpSync(source, dest, {
    recursive: true,
    force: true,
    errorOnExist: false,
    dereference: true,
    filter: (current) => shouldCopy(current),
  });
  makeWritable(dest);
  return dest;
}

/**
 * Copy a file or a directory tree. Files are dereferenced and overwritten.
 */
function copyPath(src, dest) {
  const source = realPath(src);
  if (isDirectory(source)) return copyTree(source, dest);
  if (isFile(source)) {
    ensureDir(path.dirname(dest));
    fs.copyFileSync(source, dest);
    fs.chmodSync(dest, fs.statSync(source).mode & 0o777);
    return dest;
  }
  throw new Error(`copyPath: unsupported source: ${src}`);
}

function walk(dir, options = {}) {
  const excludeDirs = new Set(options.excludeDirs ?? []);
  const excludeNames = new Set(options.excludeNames ?? []);
  const files = [];
  const visit = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (excludeDirs.has(entry.name) || excludeNames.has(entry.name)) continue;
        visit(full);
      } else if (entry.isFile()) {
        if (excludeNames.has(entry.name)) continue;
        files.push(full);
      }
    }
  };
  visit(dir);
  return files;
}

function relativeFiles(root, files) {
  return files.map((file) => path.relative(root, file).replaceAll(path.sep, '/')).sort();
}

function gitInfo(dir) {
  const inside = run('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'], { timeout: 10000 });
  if (inside.status !== 0 || inside.stdout.trim() !== 'true') return null;
  const branch = run('git', ['-C', dir, 'branch', '--show-current'], { timeout: 10000 }).stdout.trim();
  const commit = run('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], { timeout: 10000 }).stdout.trim();
  const subject = run('git', ['-C', dir, 'log', '-1', '--pretty=%s'], { timeout: 10000 }).stdout.trim();
  const remote = run('git', ['-C', dir, 'remote', 'get-url', 'origin'], { timeout: 10000 }).stdout.trim();
  const dirty = run('git', ['-C', dir, 'status', '--porcelain'], { timeout: 20000 }).stdout.trim().length > 0;
  return { branch, commit, subject, remote, dirty };
}

function humanBytes(bytes) {
  if (!Number.isFinite(bytes)) return '?';
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function dirSize(dir, options = {}) {
  const files = walk(dir, options);
  let total = 0;
  for (const file of files) {
    try {
      total += fs.statSync(file).size;
    } catch {
      // ignore
    }
  }
  return total;
}

function findProjectForToken(token, projects) {
  const numeric = /^\d+$/.test(token) ? Number(token) : null;
  if (numeric !== null) {
    return projects.find((project) => project.index === numeric) ?? null;
  }
  const exact = projects.find(
    (project) => project.id === token || project.scaffoldName === token
  );
  if (exact) return exact;
  const byArchitecture = projects.filter(
    (project) =>
      project.architecture === token ||
      project.id === `micro-os-plus-iii-${token}` ||
      project.id.endsWith(`-${token}`)
  );
  return byArchitecture.length === 1 ? byArchitecture[0] : null;
}

/**
 * Parse the three-level selection syntax:
 *   "2"      architecture 2, every platform and every test
 *   "2.3"    architecture 2, platform 3, every test
 *   "2.3.1"  architecture 2, platform 3, test 1
 * Also accepts project ids and platform ids in place of the numbers.
 */
function parseHierarchicalSelection(value, projects) {
  if (!value) return null;
  const tokens = String(value)
    .split(/[\s,]+/)
    .map((token) => token.trim())
    .filter(Boolean);
  if (!tokens.length) return null;

  const items = new Map();
  const add = (project, platform, selectedTests, wholePlatform) => {
    if (!platform) {
      const key = `${project.id}::`;
      if (!items.has(key)) {
        items.set(key, { projectId: project.id, platformId: null, all: true, tests: [] });
      }
      return;
    }
    const key = `${project.id}::${platform.id}`;
    if (!items.has(key)) {
      items.set(key, {
        projectId: project.id,
        platformId: platform.id,
        platformSelectionId: platform.selectionId,
        all: false,
        tests: [],
      });
    }
    const item = items.get(key);
    if (wholePlatform) {
      item.all = true;
      item.tests = platform.tests.map((test) => test.app);
    } else {
      for (const app of selectedTests) {
        if (!item.tests.includes(app)) item.tests.push(app);
      }
    }
  };

  const selectedTokens = tokens.some((token) => token.toLowerCase() === 'all')
    ? projects.filter((project) => project.role !== 'kernel').map((project) => String(project.index))
    : tokens;

  for (const token of selectedTokens) {
    if (token.toLowerCase() === 'all') continue;
    let parts = token.split('.').filter(Boolean);
    // A platform id may open the token: "cortexm-pico2" or
    // "cortexm-pico2.smp-mat-test". Ports are searched before the kernel.
    if (!/^\d+$/.test(parts[0]) && !findProjectForToken(parts[0], projects)) {
      const owner = [...projects]
        .sort((x, y) => (x.role === 'kernel') - (y.role === 'kernel'))
        .find((project) => project.platforms.some((item) => item.id === parts[0]));
      if (owner) parts = [String(owner.index), ...parts];
    }
    if (parts.length > 3) {
      throw new Error(`Invalid selection '${token}': use architecture.board.test (for example 2.3.1).`);
    }
    const project = findProjectForToken(parts[0], projects);
    if (!project) {
      throw new Error(
        `Unknown architecture '${parts[0]}'. Known: ${projects
          .map((item) => `${item.index}=${item.scaffoldName}`)
          .join(', ')}`
      );
    }
    if (parts.length === 1) {
      if (!project.platforms.length) {
        add(project, null, [], true);
      } else {
        for (const platform of project.platforms) add(project, platform, [], true);
      }
      continue;
    }

    let platform;
    if (/^\d+$/.test(parts[1])) {
      platform = project.platforms[Number(parts[1]) - 1];
    } else {
      platform = project.platforms.find((item) => item.id === parts[1]);
    }
    if (!platform) {
      throw new Error(
        `Unknown board/platform '${parts[0]}.${parts[1]}'. Known for ${project.scaffoldName}: ${project.platforms
          .map((item) => `${item.selectionId}=${item.id}`)
          .join(', ')}`
      );
    }
    if (parts.length === 2) {
      add(project, platform, [], true);
      continue;
    }

    let test;
    if (/^\d+$/.test(parts[2])) {
      test = platform.tests[Number(parts[2]) - 1];
    } else {
      test = platform.tests.find((item) => item.app === parts[2]);
    }
    if (!test) {
      throw new Error(
        `Unknown test '${parts[0]}.${parts[1]}.${parts[2]}'. Known for ${platform.id}: ${
          platform.tests
            .map((item) => `${item.selectionId}=${item.app}`)
            .join(', ') || '(none)'
        }`
      );
    }
    add(project, platform, [test.app], false);
  }

  const selections = [...items.values()].map((item) => {
    const project = projects.find((entry) => entry.id === item.projectId);
    const platform = project?.platforms.find((entry) => entry.id === item.platformId);
    return {
      ...item,
      projectName: project?.scaffoldName ?? item.projectId,
      platformName: platform?.id ?? null,
      platformSelectionId: platform?.selectionId ?? null,
      tests: item.all && platform ? platform.tests.map((test) => test.app) : item.tests,
    };
  });

  const selectionIds = [];
  for (const item of selections) {
    if (item.all || !item.platformSelectionId) {
      selectionIds.push(item.platformSelectionId ?? `${item.projectId}`);
    } else {
      const project = projects.find((entry) => entry.id === item.projectId);
      const platform = project?.platforms.find((entry) => entry.id === item.platformId);
      for (const app of item.tests) {
        const test = platform?.tests.find((entry) => entry.app === app);
        if (test) selectionIds.push(test.selectionId);
      }
    }
  }

  return { selections, selectionIds };
}

function parseSelection(value, projects) {
  if (!value) return null;
  const tokens = String(value)
    .split(/[\s,]+/)
    .map((token) => token.trim())
    .filter(Boolean);
  if (!tokens.length) return null;
  if (tokens.some((token) => token.toLowerCase() === 'all')) {
    return projects.map((project) => project.id);
  }
  const selected = [];
  for (const token of tokens) {
    const byNumber = projects.find((project) => String(project.index) === token);
    const byId = projects.find((project) => project.id === token || project.scaffoldName === token);
    const match = byNumber ?? byId;
    if (!match) {
      throw new Error(`Unknown project in selection: '${token}'`);
    }
    if (!selected.includes(match.id)) selected.push(match.id);
  }
  return selected;
}

module.exports = {
  run,
  which,
  versionOf,
  naturalCompare,
  newestDir,
  ensureDir,
  readJson,
  writeJson,
  writeFile,
  pathExists,
  realPath,
  isDirectory,
  isFile,
  isExecutable,
  copyTree,
  copyPath,
  makeWritable,
  walk,
  relativeFiles,
  gitInfo,
  humanBytes,
  dirSize,
  parseSelection,
  parseHierarchicalSelection,
  firstLine,
};
