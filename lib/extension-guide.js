'use strict';

const fs = require('node:fs');
const path = require('node:path');

const TEMPLATE_DIR = path.join(__dirname, '..', 'templates');

function render(template, values) {
  let text = template;
  for (const [key, value] of Object.entries(values)) {
    text = text.replaceAll(`{{${key}}}`, String(value));
  }
  return text;
}

function exampleContext(config) {
  const selectedProjects = new Set(config.selectedProjects ?? []);
  const ports = (config.projects ?? []).filter(
    (project) => project.role !== 'kernel' && selectedProjects.has(project.id)
  );
  const port =
    ports.find((project) => project.id === 'micro-os-plus-iii-cortexm') ?? ports[0] ?? null;

  const selectedPlatforms = new Set(
    (config.selections ?? [])
      .filter((selection) => selection.projectId === port?.id)
      .map((selection) => selection.platformId)
  );
  const platforms = port?.platforms ?? [];
  const pico2Selected =
    port?.id === 'micro-os-plus-iii-cortexm' &&
    platforms.some(
      (platform) => platform.id === 'cortexm-pico2' && selectedPlatforms.has(platform.id)
    );

  const platform = pico2Selected
    ? platforms.find((entry) => entry.id === 'cortexm-pico2')
    : platforms.find((entry) => selectedPlatforms.has(entry.id)) ??
      platforms.find((entry) => entry.id === port?.defaultPlatform) ??
      platforms[0] ??
      null;

  const concrete = Boolean(port && platform && pico2Selected);
  const portName = port?.scaffoldName ?? '<port>';
  const boardName = concrete ? platform.board ?? '<board>' : '<board>';
  const platformName = concrete ? platform.id : '<platform>';
  const architecture = port?.architecture ?? '<arch>';
  const portInterface = port
    ? `micro-os-plus-iii-${port.architecture}-interface`
    : 'micro-os-plus-iii-<arch>-interface';
  const configuration =
    config.build?.configurations?.[0]?.name ?? '<configuration>';
  const exampleApp = 'matmul-f32-20';
  const exampleSelection = concrete ? '4.4.22' : '<architecture>.<board>.<test>';
  const exampleCtest = concrete
    ? `${platformName}-${exampleApp}-hwd`
    : '<platform>-matmul-f32-20-hwd';
  const examplePath = `${portName}/test/${boardName}/${exampleApp}`;

  return {
    PORT: portName,
    BOARD: boardName,
    PLATFORM: platformName,
    ARCH: architecture,
    PORT_INTERFACE: portInterface,
    CONFIG: configuration,
    EXAMPLE_APP: exampleApp,
    EXAMPLE_SELECTION: exampleSelection,
    EXAMPLE_CTEST: exampleCtest,
    EXAMPLE_PATH: examplePath,
    CONCRETE: concrete,
  };
}

function extensionGuide(config) {
  const template = fs.readFileSync(path.join(TEMPLATE_DIR, 'README-EXTENSION.md'), 'utf8');
  return render(template, exampleContext(config));
}

function workedExample(config) {
  const template = fs.readFileSync(
    path.join(TEMPLATE_DIR, 'README-WORKED-EXAMPLE.md'),
    'utf8'
  );
  const context = exampleContext(config);
  const note = context.CONCRETE
    ? ''
    : '> The concrete paths and UART API below are from the `cortexm-pico2`\n' +
      '> example. Adapt `<port>`, `<board>`, `<platform>`, the UART header and\n' +
      '> the selection id to the selected target.\n\n';
  return note + render(template, context);
}

module.exports = { extensionGuide, workedExample, exampleContext };
