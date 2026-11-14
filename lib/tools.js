'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  firstLine,
  isDirectory,
  isExecutable,
  isFile,
  naturalCompare,
  newestDir,
  run,
  versionOf,
  which,
} = require('./util');

const HOME = os.homedir();
const XPACK_ROOTS = [
  path.join(HOME, '.local', 'xPacks'),
  path.join(HOME, 'xpacks'),
  path.join(HOME, '.xpacks'),
  path.join(HOME, '.local', 'share', 'xPacks'),
];

const TOOL_SPECS = {
  cmake: { binary: 'cmake', xpack: 'cmake', versionArgs: ['--version'], kind: 'build' },
  ninja: { binary: 'ninja', xpack: 'ninja-build', versionArgs: ['--version'], kind: 'build' },
  make: { binary: 'make', xpack: null, versionArgs: ['--version'], kind: 'build' },
  git: { binary: 'git', xpack: null, versionArgs: ['--version'], kind: 'vcs' },
  python3: { binary: 'python3', xpack: null, versionArgs: ['--version'], kind: 'scripting' },
  gcc: { binary: 'gcc', xpack: 'gcc', versionArgs: ['--version'], kind: 'compiler', language: 'C' },
  'g++': { binary: 'g++', xpack: 'gcc', versionArgs: ['--version'], kind: 'compiler', language: 'C++' },
  clang: { binary: 'clang', xpack: 'clang', versionArgs: ['--version'], kind: 'compiler', language: 'C' },
  'clang++': { binary: 'clang++', xpack: 'clang', versionArgs: ['--version'], kind: 'compiler', language: 'C++' },
  gdb: { binary: 'gdb', xpack: null, versionArgs: ['--version'], kind: 'debugger' },
  'arm-none-eabi-gcc': {
    binary: 'arm-none-eabi-gcc',
    xpack: 'arm-none-eabi-gcc',
    versionArgs: ['--version'],
    kind: 'compiler',
    language: 'C',
  },
  'arm-none-eabi-g++': {
    binary: 'arm-none-eabi-g++',
    xpack: 'arm-none-eabi-gcc',
    versionArgs: ['--version'],
    kind: 'compiler',
    language: 'C++',
  },
  'arm-none-eabi-gdb': {
    binary: 'arm-none-eabi-gdb',
    xpack: 'arm-none-eabi-gcc',
    versionArgs: ['--version'],
    kind: 'debugger',
  },
  'aarch64-none-elf-gcc': {
    binary: 'aarch64-none-elf-gcc',
    xpack: 'aarch64-none-elf-gcc',
    versionArgs: ['--version'],
    kind: 'compiler',
    language: 'C',
  },
  'aarch64-none-elf-g++': {
    binary: 'aarch64-none-elf-g++',
    xpack: 'aarch64-none-elf-gcc',
    versionArgs: ['--version'],
    kind: 'compiler',
    language: 'C++',
  },
  'aarch64-none-elf-gdb': {
    binary: 'aarch64-none-elf-gdb',
    xpack: 'aarch64-none-elf-gcc',
    versionArgs: ['--version'],
    kind: 'debugger',
  },
  'riscv-none-elf-gcc': {
    binary: 'riscv-none-elf-gcc',
    xpack: 'riscv-none-elf-gcc',
    versionArgs: ['--version'],
    kind: 'compiler',
    language: 'C',
  },
  'riscv-none-elf-g++': {
    binary: 'riscv-none-elf-g++',
    xpack: 'riscv-none-elf-gcc',
    versionArgs: ['--version'],
    kind: 'compiler',
    language: 'C++',
  },
  'riscv-none-elf-gdb': {
    binary: 'riscv-none-elf-gdb',
    xpack: 'riscv-none-elf-gcc',
    versionArgs: ['--version'],
    kind: 'debugger',
  },
  'qemu-system-arm': {
    binary: 'qemu-system-arm',
    xpack: 'qemu-arm',
    versionArgs: ['--version'],
    kind: 'emulator',
    // The test harness historically resolves QEMU through the xPack tree.
    // Prefer that tree so scaffold.json and CTest name the same binary.
    preferXpack: true,
  },
  'qemu-system-aarch64': {
    binary: 'qemu-system-aarch64',
    xpack: 'qemu-arm',
    versionArgs: ['--version'],
    kind: 'emulator',
    preferXpack: true,
  },
  'qemu-system-riscv32': {
    binary: 'qemu-system-riscv32',
    xpack: 'qemu-riscv',
    versionArgs: ['--version'],
    kind: 'emulator',
    preferXpack: true,
  },
  'qemu-system-riscv64': {
    binary: 'qemu-system-riscv64',
    xpack: 'qemu-riscv',
    versionArgs: ['--version'],
    kind: 'emulator',
    preferXpack: true,
  },
  openocd: { binary: 'openocd', xpack: 'openocd', versionArgs: ['--version'], kind: 'debug-probe' },
  zig: { binary: 'zig', xpack: null, versionArgs: ['version'], kind: 'compiler', language: 'Zig' },
  rustc: { binary: 'rustc', xpack: null, versionArgs: ['--version'], kind: 'compiler', language: 'Rust' },
  cargo: { binary: 'cargo', xpack: null, versionArgs: ['--version'], kind: 'build', language: 'Rust' },
};

const LIBRARY_SPECS = {
  'build-helper': { names: ['build-helper'], namespace: '@micro-os-plus' },
  'arm-cmsis': { names: ['arm-cmsis'], namespace: '@xpacks' },
  'arm-cmsis-rtos-validator': { names: ['arm-cmsis-rtos-validator'], namespace: '@xpacks' },
  'chan-fatfs': { names: ['chan-fatfs'], namespace: '@xpacks' },
  libucontext: { names: ['libucontext'], namespace: '@xpack-3rd-party' },
  'arm-cmsis-core': { names: ['arm-cmsis-core'], namespace: '@xpack-3rd-party' },
  'raspberrypi-pico-sdk': { names: ['raspberrypi-pico-sdk'], namespace: '@xpack-3rd-party' },
};

function parseVersion(text) {
  const match = String(text ?? '').match(/(\d+\.\d+(?:\.\d+)?(?:[-+][\w.-]+)?)/);
  return match ? match[1] : null;
}

function xpackBinCandidates(xpackName, binary) {
  const result = [];
  for (const root of XPACK_ROOTS) {
    const base = path.join(root, '@xpack-dev-tools', xpackName);
    try {
      const versions = fs
        .readdirSync(base, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort(naturalCompare);
      for (const version of versions.reverse()) {
        for (const prefix of ['.content/bin', 'bin']) {
          const candidate = path.join(base, version, prefix, binary);
          if (isExecutable(candidate)) result.push(candidate);
        }
      }
    } catch {
      // not installed from xPacks
    }
  }
  return result;
}

function findToolPath(key, sourceRoot) {
  const spec = TOOL_SPECS[key];
  if (!spec) return null;
  const envKey = `SCAFFOLD_${key.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`;
  if (process.env[envKey] && isExecutable(process.env[envKey])) {
    return { path: process.env[envKey], origin: 'environment' };
  }
  if (spec.preferXpack && spec.xpack) {
    const candidates = xpackBinCandidates(spec.xpack, spec.binary);
    if (candidates.length) return { path: fs.realpathSync(candidates[0]), origin: 'xPacks' };
  }
  const onPath = which(spec.binary);
  if (onPath) {
    // Resolve a PATH hit to the real binary, but never resolve a shim whose
    // real target has a different name (rustup's cargo/rustc are the case).
    try {
      const resolved = fs.realpathSync(onPath);
      if (path.basename(resolved) === path.basename(spec.binary)) {
        return { path: resolved, origin: 'PATH' };
      }
    } catch {
      // fall through to the literal PATH entry
    }
    return { path: onPath, origin: 'PATH' };
  }
  if (spec.xpack) {
    const candidates = xpackBinCandidates(spec.xpack, spec.binary);
    if (candidates.length) return { path: fs.realpathSync(candidates[0]), origin: 'xPacks' };
  }
  // Last resort: the workspace's own xpacks/.bin shims.
  if (sourceRoot) {
    const candidates = [
      path.join(sourceRoot, 'micro-os-plus-iii', 'tests', 'xpacks', '.bin', spec.binary),
      path.join(sourceRoot, 'micro-os-plus-iii', 'xpacks', '.bin', spec.binary),
    ];
    for (const candidate of candidates) {
      if (isExecutable(candidate)) {
        try {
          return { path: fs.realpathSync(candidate), origin: 'workspace-xpacks' };
        } catch {
          return { path: candidate, origin: 'workspace-xpacks' };
        }
      }
    }
  }
  return null;
}

function detectTool(key, sourceRoot) {
  const spec = TOOL_SPECS[key];
  const found = findToolPath(key, sourceRoot);
  if (!found) {
    return {
      key,
      kind: spec.kind,
      language: spec.language ?? null,
      found: false,
      path: null,
      version: null,
      rawVersion: null,
      origin: null,
    };
  }
  const rawVersion = versionOf(found.path, spec.versionArgs);
  return {
    key,
    kind: spec.kind,
    language: spec.language ?? null,
    found: true,
    path: found.path,
    binDir: path.dirname(found.path),
    version: parseVersion(rawVersion),
    rawVersion,
    origin: found.origin,
  };
}

function findLibrary(key, sourceRoot) {
  const spec = LIBRARY_SPECS[key];
  const roots = [];
  for (const root of XPACK_ROOTS) {
    roots.push(path.join(root, spec.namespace, spec.names[0]));
  }
  if (sourceRoot) {
    roots.push(
      path.join(sourceRoot, 'micro-os-plus-iii', 'tests', 'xpacks', spec.namespace, spec.names[0])
    );
  }
  for (const root of roots) {
    if (!isDirectory(root)) continue;
    let selected = root;
    let version = null;
    if (isFile(path.join(root, 'package.json'))) {
      // The path is the package itself (xpm link convention).
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
        version = pkg.version ?? null;
      } catch {
        // ignore
      }
    } else {
      const newest = newestDir(root);
      if (newest) {
        selected = newest;
        version = path.basename(newest);
      }
    }
    return {
      key,
      kind: 'library',
      found: true,
      path: fs.realpathSync(selected),
      version,
      origin: selected.startsWith(HOME) ? 'xPacks' : 'workspace',
    };
  }
  return { key, kind: 'library', found: false, path: null, version: null, origin: null };
}

function scanReferencedPaths(sourceRoot) {
  const references = [];
  const cacheFiles = [];
  const kernelBuildRoot = path.join(sourceRoot, 'micro-os-plus-iii', 'tests', 'build');
  if (isDirectory(kernelBuildRoot)) {
    for (const entry of fs.readdirSync(kernelBuildRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const cache = path.join(kernelBuildRoot, entry.name, 'CMakeCache.txt');
        if (isFile(cache)) cacheFiles.push(cache);
      }
    }
  }
  for (const entry of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('micro-os-plus-iii')) continue;
    const dir = path.join(sourceRoot, entry.name);
    for (const child of fs.readdirSync(dir, { withFileTypes: true })) {
      if (child.isDirectory() && child.name.startsWith('build')) {
        const cache = path.join(dir, child.name, 'CMakeCache.txt');
        if (isFile(cache)) cacheFiles.push(cache);
      }
    }
  }
  const seen = new Set();
  for (const cache of cacheFiles.slice(0, 100)) {
    let text;
    try {
      text = fs.readFileSync(cache, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^(CMAKE_[A-Z_]+(?:_COMPILER|_MAKE_PROGRAM|_LINKER|TOOLCHAIN_FILE)?):[A-Z]+=(.+)$/);
      if (!match) continue;
      const key = match[1];
      const value = match[2].trim();
      if (!value) continue;
      const record = { variable: key, path: value, cache };
      const id = `${key}=${value}`;
      if (!seen.has(id)) {
        seen.add(id);
        references.push(record);
      }
    }
  }
  return references;
}

function reconcileTools(tools, references) {
  const byBinary = new Map();
  for (const tool of Object.values(tools)) {
    if (tool.found) byBinary.set(path.basename(tool.path), tool);
  }
  for (const reference of references) {
    // Only absolute paths name a tool location; bare names come from PATH.
    if (!path.isAbsolute(reference.path)) continue;
    const binary = path.basename(reference.path);
    const tool = byBinary.get(binary);
    if (!tool) continue;
    let resolved = reference.path;
    try {
      resolved = fs.realpathSync(reference.path);
    } catch {
      // keep the literal path
    }
    if (resolved === tool.path) continue;
    tool.previousPaths ??= [];
    if (!tool.previousPaths.includes(resolved)) tool.previousPaths.push(resolved);
    tool.reconciled = true;
  }
  return tools;
}

function environmentInfo() {
  return {
    platform: process.platform,
    arch: process.arch,
    hostname: os.hostname(),
    release: os.release(),
    node: process.version,
    npm: (run('npm', ['--version'], { timeout: 10000 }).stdout || '').trim() || null,
    xpackRoots: XPACK_ROOTS.filter((root) => isDirectory(root)),
    pathEntries: (process.env.PATH ?? '').split(path.delimiter).filter(Boolean),
  };
}

function detectTools(requiredKeys, options = {}) {
  const sourceRoot = options.sourceRoot;
  const requested = new Set(requiredKeys);
  const keys = new Set(requiredKeys);
  for (const foundational of [
    'cmake',
    'ninja',
    'git',
    'python3',
    'gcc',
    'g++',
    'make',
    'gdb',
    'clang',
    'clang++',
    'zig',
    'rustc',
    'cargo',
  ]) {
    keys.add(foundational);
  }
  const tools = {};
  for (const key of [...keys].sort(naturalCompare)) {
    if (!TOOL_SPECS[key]) continue;
    tools[key] = detectTool(key, sourceRoot);
  }
  const libraries = {};
  for (const key of Object.keys(LIBRARY_SPECS)) {
    libraries[key] = findLibrary(key, sourceRoot);
  }
  const references = scanReferencedPaths(sourceRoot);
  reconcileTools(tools, references);
  // Only tools a selected project actually requires are allowed to block a
  // build. Optional languages (Rust, Zig) are detected but not mandatory.
  const missing = [...requested]
    .filter((key) => TOOL_SPECS[key] && !tools[key]?.found)
    .sort(naturalCompare);

  return {
    detectedAt: new Date().toISOString(),
    environment: environmentInfo(),
    tools,
    libraries,
    missing,
    references,
    notes: [
      'Paths are absolute and resolved through PATH first, then through the local xPacks repository.',
      'previousPaths/reconciled record a path found in an existing CMakeCache.txt that differs from the path detected now.',
    ],
  };
}

function toolEnvFromJson(config) {
  const env = { ...process.env };
  const dirs = new Set();
  for (const tool of Object.values(config.tools ?? {})) {
    if (tool.found && tool.binDir) dirs.add(tool.binDir);
  }
  const pathValue = [...dirs].join(path.delimiter);
  env.PATH = pathValue ? `${pathValue}${path.delimiter}${env.PATH ?? ''}` : env.PATH;
  return env;
}

function toolBinDirs(config) {
  const dirs = new Set();
  for (const tool of Object.values(config.tools ?? {})) {
    if (tool.found && tool.binDir) dirs.add(tool.binDir);
  }
  return [...dirs];
}

module.exports = {
  TOOL_SPECS,
  LIBRARY_SPECS,
  detectTools,
  toolEnvFromJson,
  toolBinDirs,
  parseVersion,
  firstLine,
};
