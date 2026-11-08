'use strict';

const path = require('node:path');
const { readJson, writeJson } = require('./util');

const SCHEMA_VERSION = 1;
const CONFIG_NAME = 'scaffold.json';

function configPath(destination) {
  return path.join(destination, CONFIG_NAME);
}

function loadConfig(destination) {
  return readJson(configPath(destination), null);
}

function toolchainFor(project) {
  if (project.buildSystem && project.buildSystem !== 'cmake') return null;
  if (project.architecture === 'posix') return null;
  if (project.architecture === 'aarch64') return 'aarch64-none-elf-gcc';
  if (project.architecture === 'riscv') return 'riscv-none-elf-gcc';
  if (project.architecture === 'aarch32' || project.architecture === 'cortexm') {
    return 'arm-none-eabi-gcc';
  }
  return null;
}

function toolchainForPlatform(platformId, project) {
  if (!platformId || platformId === 'native' || platformId.startsWith('native-')) return null;
  if (platformId.startsWith('aarch64')) return 'aarch64-none-elf-gcc';
  if (platformId.startsWith('riscv')) return 'riscv-none-elf-gcc';
  if (
    /^(aarch32|cortexm|qemu-cortex|pico2|2xcortex|nucleo|raspberrypi-pico)/.test(platformId)
  ) {
    return 'arm-none-eabi-gcc';
  }
  return toolchainFor(project);
}

function buildConfigurationForPlatform(platformId, project, discovery) {
  if (!platformId) return null;
  if (project.buildSystem && project.buildSystem !== 'cmake') {
    const available = discovery.buildConfigurations.filter(
      (config) =>
        config.platform === platformId && config.buildSystem === project.buildSystem
    );
    const chosen = available[0] ?? null;
    if (!chosen) return null;
    const platform = project.platforms?.find((entry) => entry.id === platformId);
    return {
      name: chosen.name,
      project: project.id,
      platform: platformId,
      board: platform?.board ?? null,
      buildType: chosen.buildType,
      buildSystem: project.buildSystem,
      toolchain: null,
      toolchainFile: null,
      available: available.map((config) => config.name),
    };
  }
  const available = discovery.buildConfigurations.filter(
    (config) => config.platform === platformId
  );
  const preferred = [
    `${platformId}-cmake-sys-debug`,
    `${platformId}-cmake-gcc-debug`,
  ];
  let chosen = null;
  for (const name of preferred) {
    chosen = available.find((config) => config.name === name) ?? null;
    if (chosen) break;
  }
  chosen ??= available.find((config) => config.buildType === 'Debug') ?? available[0] ?? null;
  if (!chosen) return null;
  const toolchain = toolchainForPlatform(platformId, project);
  return {
    name: chosen.name,
    project: project.id,
    platform: platformId,
    buildType: chosen.buildType,
    toolchain,
    toolchainFile: toolchain
      ? `xpacks/@micro-os-plus/build-helper/cmake/toolchains/${toolchain}.cmake`
      : null,
    available: available.map((config) => config.name),
  };
}

function inputLayout(sourceRoot) {
  return {
    root: sourceRoot,
    entries: [
      'micro-os-plus-iii/                  portable SMP kernel + shared test harness (scaffolded as micro-os-plus-iii-smp)',
      'micro-os-plus-iii-aarch32/          AArch32 architecture port (Raspberry Pi, Luckfox Lyra)',
      'micro-os-plus-iii-aarch64/          AArch64 architecture port (Raspberry Pi)',
      'micro-os-plus-iii-cortexm/          Cortex-M architecture port (RP2040/RP2350, STM32F4)',
      'micro-os-plus-iii-posix-arch/       synthetic POSIX host port',
      'BUILD-TEST-CTEST-SYSTEM.md/.pdf    build/test documentation (copied to docs/)',
    ],
    notes: [
      'Each project is a git working copy with a CMakeLists.txt and package.json at its root.',
      'The kernel owns tests/ (the xpm/CMake harness) and test_smpl/ (the shared CTest runners).',
      'Architecture ports own test/boards/<board>/ (board facts + probe configuration) and test/<board>/ (test applications).',
    ],
  };
}

function generatedLayout() {
  return {
    entries: [
      'scaffold.json                        single source of truth: projects, selected ports, tool paths/versions, build configs',
      'README.md                            top-level guide: layouts, tools, build/test/debug workflows',
      'docs/                                build/test documentation copied from the source workspace',
      'integration/<port>/CMakeLists.txt     per-port source-level integration (add_subdirectory kernel + port)',
      'micro-os-plus-iii-smp/               complete kernel copy (CMake, src/, include/, docs); source-level interface',
      '<port>/                              complete selected port copy; original CMake and documentation preserved',
      '<port>/README-SCAFFOLD.md            generated project guide (toolchain, sources, builds, tests, probes)',
      'tests/                               CTest harness adapted to this layout (cmake/, platforms/, sources/)',
      'tests/build/<config>/                per-configuration build tree and prepared xPack links',
      'tests/build.sh                       configure + build a configuration using the tool paths in scaffold.json',
      'tests/test.sh                        run the selected CTest tests (hardware tests excluded by default)',
      'tests/scripts/selected-tests.txt     configuration-to-test mapping recorded from scaffold.json',
      'tests/openocd/<project>/<board>.cfg  OpenOCD entry points that source each board configuration',
      'tests/openocd/README.md              probe/transport index for every selected board',
      'tests/scripts/env.sh                 generated environment (PATH, UOS_*_DIR) derived from scaffold.json',
      'test_smpl/                           shared QEMU/host/OpenOCD runners used by CTest',
      'build-logs/<config>.<phase>.log      captured configure/build output from the verification step',
    ],
    notes: [
      'Original repositories are never modified; everything generated lives under the destination.',
      'The only edits applied to copied files are the sibling-path resolutions in tests/ (documented in README.md).',
    ],
  };
}

function buildConfig(destination, discovery, toolsInfo, options = {}) {
  const projects = discovery.projects.map((project) => {
    const cloned = JSON.parse(JSON.stringify(project));
    cloned.destinationPath = path.join(destination, project.scaffoldName);
    cloned.tools = project.tools;
    return cloned;
  });

  // The kernel is always scaffolded, but only selected platforms are build
  // targets. A selection item is {projectId, platformId, all, tests[]}.
  let selections = options.selection?.selections ?? null;
  if (!selections) {
    selections = projects
      .filter((project) => project.selected && project.role !== 'kernel' && project.defaultPlatform)
      .map((project) => {
        const platform = project.platforms.find((entry) => entry.id === project.defaultPlatform);
        return {
          projectId: project.id,
          platformId: project.defaultPlatform,
          platformSelectionId: platform?.selectionId ?? null,
          all: true,
          tests: platform ? platform.tests.map((test) => test.app) : [],
        };
      });
  }

  for (const project of projects) {
    const relevant = selections.filter((selection) => selection.projectId === project.id);
    project.selected = project.role !== 'kernel' && relevant.length > 0;
    project.selectedPlatforms = relevant
      .map((selection) => selection.platformId)
      .filter(Boolean);
  }
  const selected = projects.filter((project) => project.selected);

  const detailedSelections = selections.map((selection) => {
    const project = projects.find((entry) => entry.id === selection.projectId);
    const platform = project?.platforms.find((entry) => entry.id === selection.platformId);
    const tests = (selection.tests ?? []).map((app) => {
      const test = platform?.tests.find((entry) => entry.app === app);
      return {
        app,
        selectionId: test?.selectionId ?? null,
        ctestPattern: test?.ctestPattern ?? null,
        kind: test?.kind ?? null,
      };
    });
    return {
      ...selection,
      projectName: project?.scaffoldName ?? selection.projectId,
      platformName: platform?.id ?? null,
      platformSelectionId: platform?.selectionId ?? selection.platformSelectionId ?? null,
      board: platform?.board ?? null,
      tests,
    };
  });

  const configurationMap = new Map();
  for (const selection of detailedSelections) {
    if (!selection.platformId) continue;
    const project = projects.find((entry) => entry.id === selection.projectId);
    const platform = project?.platforms.find((entry) => entry.id === selection.platformId);
    if (!project || !platform) continue;
    const base = buildConfigurationForPlatform(platform.id, project, discovery);
    if (!base) continue;
    if (!configurationMap.has(base.name)) {
      configurationMap.set(base.name, {
        ...base,
        selectionIds: [],
        tests: [],
      });
    }
    const entry = configurationMap.get(base.name);
    if (selection.all) entry.selectionIds.push(platform.selectionId);
    for (const test of selection.tests) {
      if (!entry.tests.some((item) => item.app === test.app)) {
        entry.tests.push(test);
      }
      if (test.selectionId && !entry.selectionIds.includes(test.selectionId)) {
        entry.selectionIds.push(test.selectionId);
      }
    }
  }
  const configurations = [...configurationMap.values()].sort((a, b) =>
    a.name.localeCompare(b.name)
  );

  const selectedPlatforms = [
    ...new Set(detailedSelections.map((selection) => selection.platformId).filter(Boolean)),
  ];
  const selectedTests = detailedSelections.flatMap((selection) =>
    selection.tests.map((test) => ({
      selectionId: test.selectionId,
      project: selection.projectId,
      platform: selection.platformId,
      board: selection.board,
      app: test.app,
      ctestPattern: test.ctestPattern,
      kind: test.kind,
    }))
  );
  const selectedSelections =
    options.selection?.selectionIds?.length
      ? options.selection.selectionIds
      : detailedSelections.flatMap((selection) =>
          selection.all && selection.platformSelectionId
            ? [selection.platformSelectionId]
            : selection.tests.map((test) => test.selectionId).filter(Boolean)
        );

  const previous = options.previous ?? null;
  const previousResults = new Map(
    (previous?.build?.results ?? []).map((result) => [result.name, result])
  );

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    generator: {
      name: 'micro-os-scaffold',
      version: options.generatorVersion ?? '1.0.0',
      node: process.version,
      cli: options.cliPath ?? null,
    },
    adaptations: [
      'tests/cmake/tests-main.cmake: the sibling root is tests/.. and UOS_SMP_DIR is tests/../micro-os-plus-iii-smp.',
      'tests/CMakeLists.txt: xpack_display_greetings reads the kernel package.json from that same sibling path.',
      'tests/platforms/*/CMakeLists.txt: QEMU discovery honours UOS_QEMU_XPACK_ROOT, which tests/scripts/env.sh derives from scaffold.json.',
    ],
    sourceRoot: discovery.sourceRoot,
    destination,
    inputLayout: inputLayout(discovery.sourceRoot),
    generatedLayout: generatedLayout(),
    kernel: projects.find((project) => project.role === 'kernel') ?? null,
    projects,
    selectedProjects: selected.map((project) => project.id),
    selectedSelections,
    selectedPlatforms,
    selectedTests,
    selections: detailedSelections,
    tools: toolsInfo.tools,
    libraries: toolsInfo.libraries,
    missingTools: toolsInfo.missing,
    toolNotes: toolsInfo.notes,
    toolReferences: toolsInfo.references,
    environment: toolsInfo.environment,
    platformCatalog: discovery.platforms,
    harness: {
      sourcePath: discovery.harness.sourcePath,
      destinationPath: path.join(destination, 'tests'),
      sharedRunners: path.join(destination, 'test_smpl'),
      buildConfigurations: discovery.buildConfigurations,
    },
    build: {
      configurations: configurations.map((config) => ({
        ...config,
        result: previousResults.get(config.name) ?? null,
      })),
      results: previousResults.size ? [...previousResults.values()] : [],
      status: previousResults.size
        ? [...previousResults.values()].every((result) => result.status === 'pass')
          ? 'pass'
          : 'fail'
        : 'pending',
      complete: previous?.build?.complete ?? false,
      verifiedAt: previous?.build?.verifiedAt ?? null,
    },
  };
}

function saveConfig(destination, config) {
  writeJson(configPath(destination), config);
  return config;
}

module.exports = {
  SCHEMA_VERSION,
  CONFIG_NAME,
  configPath,
  loadConfig,
  saveConfig,
  buildConfig,
  toolchainFor,
  toolchainForPlatform,
};
