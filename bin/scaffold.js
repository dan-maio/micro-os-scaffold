#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');

const { discover } = require('../lib/discover');
const { detectTools } = require('../lib/tools');
const { loadConfig, saveConfig, buildConfig } = require('../lib/config');
const { scaffold, refreshDocs } = require('../lib/scaffold');
const { slimConfig, leanReadme, cleanLeanOutputs } = require('../lib/lean');
const { runVerification } = require('../lib/build');
const { resolveSource } = require('../lib/source');
const { parseHierarchicalSelection, isDirectory, readJson, writeFile } = require('../lib/util');

const PACKAGE = readJson(path.join(__dirname, '..', 'package.json'), {});
const DEFAULT_DESTINATION = '.';

function usage() {
  return `micro-os-scaffold ${PACKAGE.version ?? ''}

Usage:
  node bin/scaffold.js [destination] [options]

The first positional argument is the destination folder (default: the current
folder). On the first run the source workspace is discovered and scaffold.json is
created; later runs read that JSON as the source of truth and refresh it.

Subcommands:
  discover [--source <dir>]      list architectures, boards and tests in the source workspace
  list [destination]             list selected boards/tests from an existing scaffold.json
  build [destination]            run the verification builds recorded in scaffold.json
  scaffold [destination]         explicit form of the default action

Options:
  --source <dir|urls>   source workspace: a folder holding the sibling repositories,
                        or a comma separated list of git URLs to clone as siblings
                        (default: scaffold.json, then cwd)
  --branch <name>       branch to clone when --source is a git URL (or url#branch)
  --select <list>       architecture[.board[.test]] tokens, ids, or 'all'
                        (e.g. 2, 2.3, 2.3.1; default: previous, else one board per port)
  --config <name>       build only this configuration (repeatable)
  --no-build            scaffold only, do not run the verification build
  --list-only           discover and write scaffold.json, do not copy files
  --yes                 non-interactive: accept the default selection
  --lean                complete kernel + only the files the selected test needs
                        to build and run (default)
  --minimal             keep the whole selected port (docs, all SoCs); prune only
                        the unselected boards, tests, platforms and suites
  --full                copy the complete harness and all platform/board tests
  --version             print the tool version
  --help                show this help

Environment:
  SCAFFOLD_SOURCE       same as --source
  SCAFFOLD_SELECT       same as --select`;
}

function parseArgs(argv) {
  const result = {
    subcommand: null,
    destination: null,
    source: null,
    select: null,
    configurations: [],
    build: true,
    listOnly: false,
    yes: false,
    branch: null,
    mode: null,
    version: false,
    help: false,
  };
  const knownSubcommands = new Set(['discover', 'list', 'build', 'scaffold']);
  const positional = [];
  const modes = new Set();
  let index = 0;
  const nextValue = (option) => {
    const value = argv[++index];
    if (value === undefined) throw new Error(`Option ${option} requires a value`);
    return value;
  };
  for (index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') result.help = true;
    else if (arg === '--version' || arg === '-V') result.version = true;
    else if (arg === '--source') result.source = nextValue('--source');
    else if (arg.startsWith('--source=')) result.source = arg.slice('--source='.length);
    else if (arg === '--select') result.select = nextValue('--select');
    else if (arg.startsWith('--select=')) result.select = arg.slice('--select='.length);
    else if (arg === '--config') result.configurations.push(nextValue('--config'));
    else if (arg.startsWith('--config=')) result.configurations.push(arg.slice('--config='.length));
    else if (arg === '--dest') result.destination = nextValue('--dest');
    else if (arg === '--no-build') result.build = false;
    else if (arg === '--build') result.build = true;
    else if (arg === '--list-only') result.listOnly = true;
    else if (arg === '--yes' || arg === '-y') result.yes = true;
    else if (arg === '--branch') result.branch = nextValue('--branch');
    else if (arg.startsWith('--branch=')) result.branch = arg.slice('--branch='.length);
    else if (arg === '--minimal' || arg === '--lean' || arg === '--full') modes.add(arg.slice(2));
    else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else positional.push(arg);
  }
  if (positional.length && knownSubcommands.has(positional[0])) {
    result.subcommand = positional.shift();
  }
  if (positional.length && !result.destination) result.destination = positional.shift();
  if (positional.length) throw new Error(`Unexpected argument: ${positional[0]}`);
  // The strictest requested layout wins; null means "not given on the command line".
  result.mode = modes.has('lean') ? 'lean' : modes.has('minimal') ? 'minimal' : modes.has('full') ? 'full' : null;
  return result;
}

function resolveDestination(value) {
  return path.resolve(value ?? DEFAULT_DESTINATION);
}

function printDiscoverList(discovery, options = {}) {
  const showTests = options.tests !== false;
  console.log(`Discovered ${discovery.projects.length} architectures in ${discovery.sourceRoot}:`);
  for (const project of discovery.projects) {
    const role = project.role === 'kernel' ? 'kernel, always scaffolded' : `port, ${project.architecture}`;
    const version = project.version ? ` v${project.version}` : '';
    const commit = project.git?.commit ? ` @${project.git.commit}` : '';
    const counts = `${project.platforms.length} boards, ${project.testCount} tests`;
    console.log(
      ` ${String(project.index).padStart(2)}. ${project.scaffoldName}${version}  [${role}; ${counts}]${commit}`
    );
    console.log(`      ${project.sourcePath}`);
    for (const platform of project.platforms) {
      console.log(
        `      ${platform.selectionId.padEnd(6)} ${platform.id}  (board ${platform.board ?? '—'}, ${platform.tests.length} tests)`
      );
      if (!showTests) continue;
      for (const test of platform.tests) {
        console.log(`             ${test.selectionId.padEnd(8)} ${test.app}`);
      }
    }
  }
}

function printToolSummary(config) {
  console.log('');
  console.log('Tool paths recorded in scaffold.json:');
  for (const tool of Object.values(config.tools ?? {}).sort((a, b) => a.key.localeCompare(b.key))) {
    if (!tool.found) {
      console.log(`  ${tool.key.padEnd(26)} MISSING`);
    } else {
      console.log(`  ${tool.key.padEnd(26)} ${String(tool.version ?? '?').padEnd(20)} ${tool.path}`);
    }
  }
  if (config.missingTools?.length) {
    console.log('');
    console.log(`Missing required tools: ${config.missingTools.join(', ')}`);
  }
}

function defaultSelection(discovery, previous) {
  if (previous?.selectedSelections?.length) {
    try {
      const parsed = parseHierarchicalSelection(
        previous.selectedSelections.join(','),
        discovery.projects
      );
      if (parsed?.selections.length) return parsed;
    } catch {
      // fall through to the first-run default
    }
  }
  const tokens = [];
  for (const project of discovery.ports) {
    if (!project.defaultPlatform) continue;
    const platform = project.platforms.find((entry) => entry.id === project.defaultPlatform);
    if (platform) tokens.push(platform.selectionId);
  }
  return parseHierarchicalSelection(tokens.join(','), discovery.projects);
}

async function chooseSelection(discovery, options, previous) {
  const fallback = defaultSelection(discovery, previous);
  const envSelection = process.env.SCAFFOLD_SELECT;
  const explicit = options.select ?? envSelection;
  if (explicit) return parseHierarchicalSelection(explicit, discovery.projects);
  if (options.yes || !stdin.isTTY) return fallback;
  const defaultLabel = fallback?.selectionIds?.join(',') || 'none';
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    for (;;) {
      const answer = (
        await rl.question(
          `\nSelect architecture.board.test (e.g. 2.3 or 2.3.1; comma separated, 'all'; Enter = ${defaultLabel}): `
        )
      ).trim();
      if (!answer) return fallback;
      try {
        return parseHierarchicalSelection(answer, discovery.projects);
      } catch (error) {
        console.log(error.message);
      }
    }
  } finally {
    rl.close();
  }
}

function printSelection(selection, discovery) {
  if (!selection?.selections?.length) {
    console.log('No architecture board selected; only the kernel and the test harness will be scaffolded.');
    return;
  }
  console.log('Selected:');
  for (const item of selection.selections) {
    if (!item.platformName) {
      console.log(`  ${item.projectName}: (no board)`);
      continue;
    }
    if (item.all) {
      console.log(
        `  ${item.platformSelectionId} ${item.platformName}  (${item.tests.length} tests)`
      );
    } else {
      const project = discovery.projects.find((entry) => entry.id === item.projectId);
      const platform = project?.platforms.find((entry) => entry.id === item.platformId);
      for (const app of item.tests) {
        const test = platform?.tests.find((entry) => entry.app === app);
        console.log(
          `  ${test?.selectionId ?? '?'} ${item.platformName}/${app}`
        );
      }
    }
  }
}

function requiredToolKeys(discovery, selectedIds) {
  const keys = new Set();
  for (const project of discovery.projects) {
    if (project.role === 'kernel') continue;
    if (!selectedIds.includes(project.id)) continue;
    for (const key of project.tools ?? []) keys.add(key);
  }
  return [...keys];
}

async function commandDiscover(options) {
  const { root } = resolveSource(options.source ?? process.env.SCAFFOLD_SOURCE ?? process.cwd(), {
    branch: options.branch,
  });
  const discovery = discover(root);
  printDiscoverList(discovery);
  return 0;
}

function commandList(options) {
  const destination = resolveDestination(options.destination);
  const config = loadConfig(destination);
  if (!config) throw new Error(`No scaffold.json in ${destination}; run the scaffolder first.`);
  console.log(`Architectures recorded in ${path.join(destination, 'scaffold.json')}:`);
  for (const project of config.projects) {
    const selected = project.role === 'kernel' || config.selectedProjects.includes(project.id);
    console.log(
      `  ${String(project.index).padStart(2)}. ${project.scaffoldName}  [${project.role}]  ` +
        `${selected ? 'selected' : 'not selected'}  ${project.destinationPath ?? ''}`
    );
    for (const platform of project.platforms ?? []) {
      const chosen = (config.selectedPlatforms ?? []).includes(platform.id);
      if (!chosen) continue;
      const tests = (config.selectedTests ?? []).filter(
        (test) => test.platform === platform.id
      );
      console.log(
        `      ${platform.selectionId} ${platform.id}  (${tests.length}/${platform.tests.length} tests selected)`
      );
      for (const test of tests) {
        if (test.selectionId) console.log(`          ${test.selectionId} ${test.app}`);
      }
    }
  }
  console.log('');
  console.log(`Selected selections: ${(config.selectedSelections ?? []).join(', ') || 'none'}`);
  printToolSummary(config);
  if (config.build?.results?.length) {
    console.log('');
    console.log('Build results:');
    for (const result of config.build.results) {
      console.log(`  ${result.status.toUpperCase().padEnd(7)} ${result.name}`);
    }
  }
  return 0;
}

function commandBuild(options) {
  const destination = resolveDestination(options.destination);
  const config = loadConfig(destination);
  if (!config) throw new Error(`No scaffold.json in ${destination}; run the scaffolder first.`);
  if (!isDirectory(path.join(destination, 'tests'))) {
    throw new Error(`The tests harness is missing from ${destination}; run the scaffolder again.`);
  }
  const outcome = runVerification({
    config,
    destination,
    configurations: options.configurations,
  });
  if (config.lean) cleanLeanOutputs(config, destination);
  saveConfig(destination, config.lean ? slimConfig(config) : config);
  if (config.lean) {
    writeFile(path.join(destination, 'README.md'), leanReadme(config));
  } else {
    refreshDocs(config, destination);
  }
  return outcome.status === 'pass' ? 0 : 1;
}

async function commandScaffold(options) {
  const destination = resolveDestination(options.destination);
  const previous = loadConfig(destination);
  const resolved = resolveSource(
    options.source ??
      process.env.SCAFFOLD_SOURCE ??
      previous?.sourceUrl ??
      previous?.sourceRoot ??
      process.cwd(),
    { branch: options.branch ?? previous?.sourceBranch ?? null }
  );
  const source = resolved.root;
  // Default: lean. A re-run without a mode option keeps the previous layout.
  const previousMode =
    previous?.mode ??
    (previous?.lean ? 'lean' : previous?.minimal === false ? 'full' : previous?.minimal ? 'minimal' : null);
  const mode = options.mode ?? previousMode ?? 'lean';
  if (
    !isDirectory(path.join(source, 'micro-os-plus-iii')) &&
    !isDirectory(path.join(source, 'micro-os-plus-iii-smp')) &&
    !isDirectory(path.join(source, 'micro-os-plus-iii-rust'))
  ) {
    throw new Error(
      `No micro-os-plus-iii kernel found in ${source}. Pass --source <workspace> (the folder that holds the sibling repositories).`
    );
  }

  const discovery = discover(source);
  console.log(`Source workspace: ${discovery.sourceRoot}`);
  console.log(`Destination:      ${destination}`);
  printDiscoverList(discovery);

  const selection = await chooseSelection(discovery, options, previous);
  const ports = discovery.ports.map((project) => project.id);
  const selectedIds = [
    ...new Set((selection?.selections ?? []).map((item) => item.projectId)),
  ].filter((id) => ports.includes(id));
  console.log('');
  printSelection(selection, discovery);

  const toolsInfo = detectTools(requiredToolKeys(discovery, selectedIds), { sourceRoot: source });
  const config = buildConfig(destination, discovery, toolsInfo, {
    previous,
    selection,
    generatorVersion: PACKAGE.version,
    cliPath: path.resolve(process.argv[1]),
  });
  config.sourceUrl = resolved.url;
  config.sourceBranch = resolved.branch;
  config.mode = mode;
  saveConfig(destination, config);
  printToolSummary(config);

  if (options.listOnly) {
    console.log('');
    console.log(`scaffold.json written to ${path.join(destination, 'scaffold.json')} (list-only; no files copied).`);
    return 0;
  }

  console.log('');
  console.log('Scaffolding...');
  const result = scaffold({
    destination,
    discovery,
    config,
    toolsInfo,
    minimal: mode !== 'full',
    lean: mode === 'lean',
  });
  console.log(`  layout:        ${mode}`);
  saveConfig(destination, config.lean ? slimConfig(config) : config);
  console.log(`  kernel:        ${result.kernel}`);
  for (const project of result.projects) console.log(`  port:          ${project}`);
  console.log(`  test harness:  ${result.tests}`);
  if (result.sharedRunners) console.log(`  shared runners: ${result.sharedRunners}`);
  if (result.docs) console.log(`  docs:          ${result.docs}`);
  if (result.integration) console.log(`  integration:   ${result.integration}`);
  if (result.openocd.root) {
    console.log(`  openocd:       ${result.openocd.root} (${result.openocd.count} board configs)`);
  }
  for (const patch of result.patches) console.log(`  patched:       ${patch}`);
  for (const [key, xpack] of Object.entries(result.xpacks)) {
    console.log(`  xpack:         ${key} ${xpack.version ?? ''} -> ${xpack.destination}`);
  }

  if (!options.build) {
    console.log('');
    console.log('Build verification skipped (--no-build).');
    return 0;
  }
  if (!config.build.configurations.length) {
    console.log('');
    console.log('No build configuration applies (no port selected); build verification skipped.');
    return 0;
  }

  console.log('');
  console.log('Verifying with a test build using the tool paths in scaffold.json...');
  const outcome = runVerification({
    config,
    destination,
    configurations: options.configurations,
  });
  if (config.lean) cleanLeanOutputs(config, destination);
  saveConfig(destination, config.lean ? slimConfig(config) : config);
  if (config.lean) {
    writeFile(path.join(destination, 'README.md'), leanReadme(config));
  } else {
    refreshDocs(config, destination);
  }
  console.log('');
  console.log(`Overall build status: ${outcome.status.toUpperCase()}`);
  console.log(`Logs: ${outcome.logsDir}`);
  console.log(`Configuration: ${path.join(destination, 'scaffold.json')}`);
  return outcome.status === 'pass' ? 0 : 1;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error('');
    console.error(usage());
    return 2;
  }
  if (options.version) {
    console.log(`${PACKAGE.name ?? 'micro-os-scaffold'} ${PACKAGE.version ?? ''}`.trim());
    return 0;
  }
  if (options.help) {
    console.log(usage());
    return 0;
  }
  try {
    if (options.subcommand === 'discover') return await commandDiscover(options);
    if (options.subcommand === 'list') return commandList(options);
    if (options.subcommand === 'build') return commandBuild(options);
    return await commandScaffold(options);
  } catch (error) {
    console.error(`error: ${error.message}`);
    if (process.env.SCAFFOLD_DEBUG) console.error(error.stack);
    return 1;
  }
}

main().then((code) => {
  process.exitCode = code;
});
