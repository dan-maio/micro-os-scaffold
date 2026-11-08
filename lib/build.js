'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ensureDir, pathExists, run, writeFile } = require('./util');
const { toolEnvFromJson } = require('./tools');

function prependBinDir(env, dir) {
  if (!dir) return;
  env.PATH = `${dir}${path.delimiter}${env.PATH ?? ''}`;
}

function prepareXpackLinks(config, destination, buildDir) {
  const links = [
    ['libucontext', path.join(buildDir, 'xpacks', '@xpack-3rd-party', 'libucontext')],
    ['arm-cmsis-core', path.join(buildDir, 'xpacks', '@xpack-3rd-party', 'arm-cmsis-core')],
    ['raspberrypi-pico-sdk', path.join(buildDir, 'xpacks', '@xpack-3rd-party', 'raspberrypi-pico-sdk')],
    ['arm-cmsis', path.join(buildDir, 'xpacks', '@xpacks', 'arm-cmsis')],
  ];
  const prepared = [];
  const localLibucontext = path.join(destination, 'tests', 'xpacks', '@xpack-3rd-party', 'libucontext');
  for (const [key, target] of links) {
    const library = config.libraries?.[key];
    let source = library?.found ? library.path : null;
    if (key === 'libucontext' && pathExists(localLibucontext)) source = localLibucontext;
    if (!source) continue;
    ensureDir(path.dirname(target));
    try {
      fs.rmSync(target, { recursive: true, force: true });
      fs.symlinkSync(source, target, 'dir');
      prepared.push({ key, source, target });
    } catch (error) {
      prepared.push({ key, source, target, error: error.message });
    }
  }
  return prepared;
}

function readCache(buildDir) {
  const result = {};
  const cacheFile = path.join(buildDir, 'CMakeCache.txt');
  if (pathExists(cacheFile)) {
    const text = fs.readFileSync(cacheFile, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^(CMAKE_[A-Z_]+(?:_COMPILER|_MAKE_PROGRAM|_LINKER)):[A-Z]+=(.+)$/);
      if (match) result[match[1]] = match[2].trim();
    }
  }
  // Toolchain files set the compilers as normal variables, so CMake records
  // them in CMakeFiles/<version>/CMake<LANG>Compiler.cmake, not in the cache.
  const cmakeFiles = path.join(buildDir, 'CMakeFiles');
  if (pathExists(cmakeFiles)) {
    for (const entry of fs.readdirSync(cmakeFiles, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      for (const language of ['C', 'CXX']) {
        const file = path.join(cmakeFiles, entry.name, `CMake${language}Compiler.cmake`);
        if (!pathExists(file)) continue;
        const text = fs.readFileSync(file, 'utf8');
        const match = text.match(new RegExp(`set\\(CMAKE_${language}_COMPILER "([^"]+)"\\)`));
        if (match) result[`CMAKE_${language}_COMPILER`] = match[1];
      }
    }
  }
  return result;
}

function tail(text, lines = 40) {
  const all = String(text ?? '').trimEnd().split(/\r?\n/);
  return all.slice(Math.max(0, all.length - lines)).join('\n');
}

function runVerification(options) {
  const { config, destination, log = console.log } = options;
  const testsDir = path.join(destination, 'tests');
  const requested = options.configurations?.length
    ? new Set(options.configurations)
    : null;
  const entries = (config.build?.configurations ?? []).filter(
    (entry) => !requested || requested.has(entry.name)
  );

  if (!entries.length) {
    throw new Error('No build configurations to verify. Select at least one port project.');
  }

  const logsDir = path.join(destination, 'build-logs');
  ensureDir(logsDir);
  const results = [];

  for (const entry of entries) {
    const project = (config.projects ?? []).find((item) => item.id === entry.project);
    const buildDir = path.join(testsDir, 'build', entry.name);
    ensureDir(buildDir);
    const logBase = path.join(logsDir, entry.name);
    const startedAt = new Date().toISOString();
    log('');
    log(`=== ${entry.name} (${entry.project}) ===`);

    if (entry.buildSystem && entry.buildSystem !== 'cmake') {
      const projectDir = project?.destinationPath ?? path.join(destination, entry.project);
      const env = toolEnvFromJson(config);
      let command = 'cargo';
      let args = ['build', '--workspace'];
      if (entry.buildSystem === 'cargo') {
        if (project?.architecture === 'posix') {
          args = ['test', '--workspace'];
        } else {
          const target =
            project?.architecture === 'aarch64'
              ? 'aarch64-unknown-none'
              : entry.board === 'pico'
                ? 'thumbv6m-none-eabi'
                : entry.board?.startsWith('pico2')
                  ? 'thumbv8m.main-none-eabihf'
                  : 'thumbv7em-none-eabihf';
          args = ['build', '-p', entry.board, '--examples', '--target', target];
        }
      } else if (entry.buildSystem === 'zig') {
        command = 'zig';
        args = ['build'];
        if (entry.board && entry.board !== 'native') {
          args.push(`-Dboard=${entry.board}`);
        }
      }
      log(`  ${entry.buildSystem}: ${command} ${args.join(' ')}`);
      const result = run(command, args, {
        cwd: projectDir,
        env,
        timeout: options.buildTimeout ?? 60 * 60 * 1000,
      });
      writeFile(`${logBase}.build.log`, `${result.stdout}${result.stderr}`);
      const ok = result.status === 0;
      log(ok ? '  PASS' : `  FAILED (exit ${result.status}); see ${logBase}.build.log`);
      if (!ok) log(tail(result.stdout + result.stderr, 30));
      results.push({
        name: entry.name,
        project: entry.project,
        platform: entry.platform,
        status: ok ? 'pass' : 'fail',
        buildSystem: entry.buildSystem,
        configure: { exitCode: 0, log: null },
        build: { exitCode: result.status, log: `${logBase}.build.log` },
        startedAt,
        finishedAt: new Date().toISOString(),
        logDir: logsDir,
      });
      continue;
    }

    const compilerKey = entry.toolchain === 'aarch64-none-elf-gcc'
      ? 'aarch64-none-elf-gcc'
      : entry.toolchain === 'riscv-none-elf-gcc'
        ? 'riscv-none-elf-gcc'
        : entry.toolchain === 'arm-none-eabi-gcc'
          ? 'arm-none-eabi-gcc'
          : 'gcc';
    const cxxKey = compilerKey === 'gcc' ? 'g++' : compilerKey.replace(/-gcc$/, '-g++');
    const compiler = config.tools?.[compilerKey];
    const cxx = config.tools?.[cxxKey];
    if (!compiler?.found || !cxx?.found) {
      const reason = `missing compiler: ${!compiler?.found ? compilerKey : ''} ${!cxx?.found ? cxxKey : ''}`.trim();
      results.push({
        name: entry.name,
        project: entry.project,
        platform: entry.platform,
        status: 'blocked',
        reason,
        startedAt,
        finishedAt: new Date().toISOString(),
        logDir: logsDir,
      });
      log(`  BLOCKED: ${reason}`);
      continue;
    }

    const links = prepareXpackLinks(config, destination, buildDir);
    const env = toolEnvFromJson(config);
    prependBinDir(env, path.dirname(compiler.path));

    const args = [
      '-S', testsDir,
      '-B', buildDir,
      '-G', 'Ninja',
      '-D', `CMAKE_BUILD_TYPE=${entry.buildType}`,
      '-D', `PLATFORM_NAME=${entry.platform}`,
    ];
    if (entry.toolchainFile) {
      args.push('-D', `CMAKE_TOOLCHAIN_FILE=${path.join(testsDir, entry.toolchainFile)}`);
    } else {
      args.push('-D', `CMAKE_C_COMPILER=${compiler.path}`);
      args.push('-D', `CMAKE_CXX_COMPILER=${cxx.path}`);
    }

    log(`  configure: ${entry.platform} / ${entry.buildType}`);
    const configure = run('cmake', args, {
      cwd: testsDir,
      env,
      timeout: options.configureTimeout ?? 10 * 60 * 1000,
    });
    writeFile(`${logBase}.configure.log`, `${configure.stdout}${configure.stderr}`);
    const cache = readCache(buildDir);

    if (configure.status !== 0) {
      log(`  CONFIGURE FAILED (exit ${configure.status}); see ${logBase}.configure.log`);
      log(tail(configure.stdout + configure.stderr, 30));
      results.push({
        name: entry.name,
        project: entry.project,
        platform: entry.platform,
        status: 'fail',
        phase: 'configure',
        configure: {
          exitCode: configure.status,
          log: `${logBase}.configure.log`,
        },
        actual: cache,
        expected: { compiler: compiler.path, cxx: cxx.path },
        xpackLinks: links,
        startedAt,
        finishedAt: new Date().toISOString(),
        logDir: logsDir,
      });
      continue;
    }

    log('  build: cmake --build');
    const build = run('cmake', ['--build', buildDir, '--', '-k', '0'], {
      cwd: testsDir,
      env,
      timeout: options.buildTimeout ?? 60 * 60 * 1000,
    });
    writeFile(`${logBase}.build.log`, `${build.stdout}${build.stderr}`);
    const ok = build.status === 0;
    const actualMismatch = [];
    if (cache.CMAKE_C_COMPILER && cache.CMAKE_C_COMPILER !== compiler.path) {
      actualMismatch.push(`C compiler: ${cache.CMAKE_C_COMPILER} != ${compiler.path}`);
    }
    if (cache.CMAKE_CXX_COMPILER && cache.CMAKE_CXX_COMPILER !== cxx.path) {
      actualMismatch.push(`C++ compiler: ${cache.CMAKE_CXX_COMPILER} != ${cxx.path}`);
    }
    if (ok) {
      log(`  PASS (configure + build)`);
    } else {
      log(`  BUILD FAILED (exit ${build.status}); see ${logBase}.build.log`);
      log(tail(build.stdout + build.stderr, 30));
    }
    if (actualMismatch.length) {
      log(`  NOTE: actual compilers differ from scaffold.json: ${actualMismatch.join('; ')}`);
    }
    results.push({
      name: entry.name,
      project: entry.project,
      platform: entry.platform,
      status: ok ? 'pass' : 'fail',
      phase: ok ? 'build' : 'build',
      configure: {
        exitCode: configure.status,
        log: `${logBase}.configure.log`,
      },
      build: {
        exitCode: build.status,
        log: `${logBase}.build.log`,
      },
      actual: cache,
      expected: { compiler: compiler.path, cxx: cxx.path },
      compilerMismatch: actualMismatch,
      xpackLinks: links,
      startedAt,
      finishedAt: new Date().toISOString(),
      logDir: logsDir,
    });
  }

  for (const result of results) {
    const entry = (config.build?.configurations ?? []).find((item) => item.name === result.name);
    if (entry) entry.result = result;
  }
  const previous = new Map((config.build?.results ?? []).map((result) => [result.name, result]));
  for (const result of results) previous.set(result.name, result);
  config.build.results = [...previous.values()];
  // The overall status reflects every recorded configuration, not only the
  // subset built in this invocation. The exit code still reflects this run.
  config.build.status = config.build.results.every((result) => result.status === 'pass')
    ? 'pass'
    : 'fail';
  config.build.complete = (config.build.configurations ?? []).every((entry) => entry.result);
  config.build.verifiedAt = new Date().toISOString();

  log('');
  log('=== Build verification summary ===');
  for (const result of results) {
    const suffix = result.reason ? ` (${result.reason})` : '';
    log(`  ${result.status.toUpperCase().padEnd(7)} ${result.name}${suffix}`);
  }
  return { results, status: config.build.status, logsDir };
}

module.exports = { runVerification, prepareXpackLinks };
