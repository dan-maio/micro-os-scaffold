'use strict';

/*
 * The CLI path for a restructured source (see discover.js). bin/scaffold.js
 * calls these when isV2Source () is true; old-layout sources keep the
 * original pipeline.
 */

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { readJson, run, writeJson, writeFile } = require('../util');
const { discoverV2, printDiscoveryV2 } = require('./discover');
const { resolveSelectionV2, scaffoldV2 } = require('./scaffold');
const { readmeV2 } = require('./readme');
const { microTestPlusSection, stdcppSection } = require('./readme-options');
const microTestPlus = require('../micro-test-plus');
const stdcpp = require('../stdcpp');
const { integrateV2 } = require('./micro-test-plus');
const { integrateStdcppV2 } = require('./stdcpp');

/** µTest++ and stdc++: given now, or kept from the previous scaffold.json unless dropped. */
function resolveOptions(options, previous, log) {
  const mtpSpec = options.noMicroTestPlus
    ? null
    : options.microTestPlus ?? process.env.SCAFFOLD_MICRO_TEST_PLUS ?? previous?.microTestPlus?.spec ?? null;
  const mtpRef = options.microTestPlus ? options.microTestPlusRef : options.microTestPlusRef ?? previous?.microTestPlus?.ref ?? null;
  const mtpForce = options.microTestPlusForce || (!options.microTestPlus && Boolean(previous?.microTestPlus?.force));
  let framework = null;
  if (mtpSpec) {
    log('');
    log('µTest++ (micro-test-plus):');
    framework = microTestPlus.resolveFramework(mtpSpec, mtpRef);
  }
  const env = process.env.SCAFFOLD_STDCPP;
  const fromEnv = env && env !== '0' ? (env === '1' ? 'bundled' : env) : null;
  let stdcppSpec = null;
  if (!options.noStdcpp) {
    stdcppSpec = options.stdcpp ? options.stdcppFrom ?? 'bundled' : fromEnv ?? previous?.stdcpp?.spec ?? null;
  }
  const stdcppRef = options.stdcpp ? options.stdcppRef : options.stdcppRef ?? previous?.stdcpp?.ref ?? null;
  let pkg = null;
  if (stdcppSpec) {
    log('');
    log('StateOS stdc++:');
    pkg = stdcpp.resolvePackage(stdcppSpec === 'bundled' ? null : stdcppSpec, stdcppRef);
  }
  const regenerate = [];
  if (framework) {
    regenerate.push(`--micro-test-plus ${framework.spec}`);
    if (framework.ref) regenerate.push(`--micro-test-plus-ref ${framework.ref}`);
    if (mtpForce) regenerate.push('--micro-test-plus-force');
  }
  if (pkg) regenerate.push(pkg.spec === 'bundled' || pkg.kind === 'bundled' ? '--stdcpp' : `--stdcpp-from ${pkg.spec}`);
  return { framework, mtpForce, pkg, regenerate };
}

function discoverCommandV2(root) {
  printDiscoveryV2(discoverV2(root));
  return 0;
}

/** The selection tokens: --select, SCAFFOLD_SELECT, else the previous scaffold.json. */
function selectionTokens(options, previous) {
  const explicit = options.select ?? process.env.SCAFFOLD_SELECT ?? null;
  if (explicit) return explicit.split(',').map((t) => t.trim()).filter(Boolean);
  if (previous?.layout === 'v2' && previous.selection?.length) {
    return previous.selection.flatMap((entry) =>
      entry.all ? [entry.platform] : entry.apps.map((app) => `${entry.platform}.${app}`)
    );
  }
  return [];
}

function verify(destination, configurations, log) {
  const results = [];
  for (const configuration of configurations) {
    log(`\n=== ${configuration.name} ===`);
    const started = Date.now();
    const result = run(path.join(destination, 'run.sh'), ['build', '-c', configuration.name], {
      cwd: destination,
      timeout: 3600000,
    });
    const status = result.status === 0 ? 'pass' : 'fail';
    const logFile = path.join(destination, 'build-logs', `${configuration.name}.build.log`);
    writeFile(logFile, `${result.stdout ?? ''}${result.stderr ?? ''}`);
    log(`  ${status.toUpperCase()} (${Math.round((Date.now() - started) / 1000)} s); log: ${path.relative(destination, logFile)}`);
    results.push({ name: configuration.name, status, log: path.relative(destination, logFile) });
  }
  return results;
}

/**
 * Scaffold from a new-layout source. `hooks.integrate (manifest, discovery,
 * destination)` adds the options (µTest++, stdc++) after the copy.
 */
function scaffoldCommandV2(options, { source, sourceUrl = null, sourceBranch = null, destination, previous, generator, hooks = {} }) {
  const log = console.log;
  const discovery = discoverV2(source);
  printDiscoveryV2(discovery);
  const tokens = selectionTokens(options, previous);
  if (!tokens.length) {
    throw new Error(
      'Select at least one platform or test: --select <platform>[.<test>],... ' +
        '(for example --select cortexm-weactf411.spi-pipeline). Run `discover` to list them.'
    );
  }
  const selection = resolveSelectionV2(discovery, tokens);
  const wantedConfigs = options.configurations?.length
    ? options.configurations
    : previous?.layout === 'v2'
      ? previous.configurations?.map((c) => c.name)
      : null;
  log('');
  log(`Destination: ${destination}`);
  log(
    `Selection:   ${selection
      .map((s) => (s.apps ? s.apps.map((a) => `${s.platform.id}.${a}`).join(', ') : `${s.platform.id} (all tests)`))
      .join(', ')}`
  );
  const extras = resolveOptions(options, previous, log);
  const result = scaffoldV2({
    discovery,
    destination,
    selection,
    configurationNames: wantedConfigs,
    options: {
      generator,
      previous,
      integrate: (sel) => {
        const records = { regenerateOptions: extras.regenerate };
        if (extras.framework) {
          log('');
          records.microTestPlus = integrateV2({
            discovery,
            destination,
            selection: sel,
            framework: extras.framework,
            force: extras.mtpForce,
            log,
          });
        }
        if (extras.pkg) {
          records.stdcpp = integrateStdcppV2({
            destination,
            selection: sel,
            pkg: extras.pkg,
            mtpRecord: records.microTestPlus,
            log,
          });
        }
        if (hooks.integrate) Object.assign(records, hooks.integrate(sel) ?? {});
        return records;
      },
    },
    log,
  });
  // A git source: record the URLs and the branch, so a re-scaffold (and the
  // README's Regenerate command) clones them again rather than using the
  // clone cache.
  if (sourceUrl) {
    result.manifest.sourceUrl = sourceUrl;
    result.manifest.sourceBranch = sourceBranch;
  }
  if (options.build !== false) {
    result.manifest.build = { results: verify(destination, result.configurations, log) };
  }
  writeJson(path.join(destination, 'scaffold.json'), result.manifest);
  writeFile(
    path.join(destination, 'README.md'),
    readmeV2(result.manifest, discovery, [
      microTestPlusSection(result.manifest.microTestPlus),
      stdcppSection(result.manifest.stdcpp),
    ])
  );
  const failed = (result.manifest.build?.results ?? []).filter((r) => r.status !== 'pass');
  log('');
  log(`Workspace: ${destination}`);
  log(`  run:      cd ${destination} && ./run.sh list`);
  if (result.manifest.build) {
    log(`  build:    ${failed.length ? `FAIL (${failed.map((f) => f.name).join(', ')})` : 'PASS'}`);
  }
  return failed.length ? 1 : 0;
}

function loadPrevious(destination) {
  return readJson(path.join(destination, 'scaffold.json'), null);
}

/** list/build/clean on a new-layout workspace: they are ./run.sh's. */
function workspaceCommandV2(destination, sub, manifest) {
  if (sub === 'list') {
    console.log(`Workspace ${destination} (new layout), from ${manifest.sourceRoot}:`);
    for (const entry of manifest.selection ?? []) {
      console.log(`  ${entry.platform}: ${entry.tests.map((t) => `${t.app} (${t.kind})`).join(', ')}`);
    }
    for (const test of manifest.localTests?.tests ?? []) console.log(`  local: ${test.name}`);
    console.log(`Configurations: ${(manifest.configurations ?? []).map((c) => c.name).join(', ')}`);
    return 0;
  }
  const args = sub === 'build' ? ['build'] : ['clean'];
  let status = 0;
  for (const configuration of manifest.configurations ?? []) {
    const result = spawnSync(path.join(destination, 'run.sh'), [...args, '-c', configuration.name], {
      cwd: destination,
      stdio: 'inherit',
    });
    if (result.status !== 0) status = 1;
  }
  return status;
}

module.exports = { discoverCommandV2, scaffoldCommandV2, loadPrevious, workspaceCommandV2 };
