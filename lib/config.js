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

function inputLayout(sourceRoot, projects = []) {
  const kernel = projects.find((project) => project.role === 'kernel');
  const ports = projects.filter((project) => project.role !== 'kernel');
  const entries = [];
  if (kernel) {
    entries.push(`${kernel.scaffoldName}/  ${kernel.buildSystem} kernel and interface`);
  }
  for (const port of ports) {
    entries.push(
      `${port.scaffoldName}/  ${port.architecture} port, ${port.buildSystem} build system`
    );
  }
  entries.push('*.md, *.pdf  workspace documentation (copied to docs/ in full mode)');
  return {
    root: sourceRoot,
    entries,
    notes: [
      'Each project is a working copy with its own build entry point (CMakeLists.txt, Cargo.toml or build.zig).',
      'The kernel is always scaffolded; the ports are copied only when selected.',
      'Ports own boards and tests: CMake uses test/boards/ and test/<board>/; Cargo uses test/boards/ and test/<board>/; Zig uses boards/ or test/<board>/.',
    ],
  };
}

function generatedLayout(projects = []) {
  const selected = projects.filter(
    (project) => project.role !== 'kernel' && project.selected
  );
  const systems = new Set(selected.map((project) => project.buildSystem ?? 'cmake'));
  const kernel = projects.find((project) => project.role === 'kernel');
  const kernelName = kernel?.scaffoldName ?? 'micro-os-plus-iii-smp';
  const entries = [
    'scaffold.json                        single source of truth: selection, tool paths/versions, build configs',
    'README.md                            generated workspace guide',
    '.scaffold-manifest.json              compact manifest of what was copied and patched',
    'docs/                                workspace documentation copied from the source root (full mode)',
  ];

  if (systems.has('cmake')) {
    entries.push(
      'integration/<port>/CMakeLists.txt     per-port source-level CMake integration (full mode)',
      `${kernelName}/               complete kernel copy (CMake, src/, include/, docs)`,
      '<port>/                              selected port copy; original CMake and documentation preserved',
      '<port>/README-SCAFFOLD.md            generated project guide (normal and full modes)',
      'tests/                               CTest harness adapted to this layout',
      'tests/build/<config>/                per-configuration build tree (removed in lean mode)',
      'tests/build.sh                       configure + build a configuration',
      'tests/test.sh                        run the selected CTest tests',
      'tests/scripts/selected-tests.txt     configuration-to-test mapping',
      'tests/openocd/<project>/<board>.cfg  generated OpenOCD entry points',
      'micro-os-plus-iii-smp/test_smpl/     shared QEMU/host/OpenOCD runners (part of the kernel copy)'
    );
  }

  if (systems.has('cargo')) {
    entries.push(
      `${kernelName}/                  complete Rust kernel`,
      '<port>/                              Cargo workspace for the selected board',
      '<port>/README-SCAFFOLD.md            generated project guide (normal and full modes)',
      'tests/build.sh                       cargo build for the selected board',
      'tests/test.sh                        board runner or cargo test'
    );
  }

  if (systems.has('zig')) {
    entries.push(
      `${kernelName}/                  complete Zig kernel`,
      '<port>/                              Zig workspace for the selected board',
      'extern/                              copied build.zig.zon path dependencies',
      '<port>/README-SCAFFOLD.md            generated project guide (normal and full modes)',
      'tests/build.sh                       zig build for the selected board',
      'tests/test.sh                        zig build run for the selected test'
    );
  }

  entries.push('build-logs/<config>.*.log           captured configure/build output');

  const notes = [
    'Original repositories are never modified; everything generated lives under the destination.',
    'Normal minimal mode removes unused platforms, boards, tests, suites and xPacks; it still starts each selected configuration from a clean build tree.',
    'Lean mode keeps only the selected test material and removes the build outputs after verification.',
  ];
  return { entries, notes };
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
  const hasCmake = selected.some(
    (project) => (project.buildSystem ?? 'cmake') === 'cmake'
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
    adaptations: hasCmake
      ? [
          'tests/cmake/tests-main.cmake: the sibling root is tests/.. and UOS_SMP_DIR is tests/../micro-os-plus-iii-smp.',
          'tests/CMakeLists.txt: xpack_display_greetings reads the kernel package.json from that same sibling path.',
          'tests/platforms/*/CMakeLists.txt: QEMU discovery honours UOS_QEMU_XPACK_ROOT, which tests/scripts/env.sh derives from scaffold.json.',
        ]
      : [],
    sourceRoot: discovery.sourceRoot,
    destination,
    inputLayout: inputLayout(discovery.sourceRoot, projects),
    generatedLayout: generatedLayout(projects),
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
      sharedRunners: path.join(destination, 'micro-os-plus-iii-smp', 'test_smpl'),
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
