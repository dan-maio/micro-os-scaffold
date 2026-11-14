'use strict';

/*
 * The "µTest++ tests" section of a generated workspace README, written when
 * the workspace was scaffolded with --micro-test-plus.
 */

function code(value) {
  return `\`${value}\``;
}

function statusText(entry) {
  switch (entry.status) {
    case 'integrated':
      return 'integrated';
    case 'integrated-forced':
      return 'integrated (--micro-test-plus-force; the runtime rule is not met)';
    case 'rule-not-met':
      return `not integrated: the runtime rule is not met (${entry.why})`;
    case 'no-console-model':
      return `not integrated: ${entry.why}`;
    default:
      return `not integrated: ${entry.why ?? entry.status}`;
  }
}

function readmeSection(config) {
  const record = config.microTestPlus;
  if (!record) return '';
  const lines = [];
  const integrated = record.boards.filter((entry) => entry.status.startsWith('integrated'));
  const configurationOf = (platform) =>
    (config.build?.configurations ?? []).find((entry) => entry.platform === platform)?.name ??
    '<configuration>';

  lines.push('## µTest++ tests', '');
  lines.push(
    `This workspace was scaffolded with ${code('--micro-test-plus')}: the µTest++ test framework`,
    `(${record.name} ${record.version ?? '?'}, from ${code(record.spec)}${record.ref ? ` at ${code(record.ref)}` : ''})`,
    `is in ${code(`${record.destination}/`)}, unchanged, and the boards below can run tests`,
    'written with it. Such a test is an ordinary test directory named `mtp-<name>`: the',
    'harness builds and registers it with CTest like every other test; inside, a µTest++',
    'runner checks with `t.expect (...)` and reports in TAP.',
    ''
  );

  const smpText = (entry) =>
    ({ 1: 'test-smp-boot', 2: 'launch_core1 (RP2)' })[entry.smpBoot] ?? (entry.status?.startsWith('integrated') ? 'core 0 only' : '—');
  lines.push(
    '| Platform | Board | µTest++ | Console | Other cores | Starter tests (CTest) |',
    '| --- | --- | --- | --- | --- | --- |'
  );
  for (const entry of record.boards) {
    lines.push(
      `| ${code(entry.platform)} | ${code(entry.board ?? '—')} | ${statusText(entry)} | ` +
        `${entry.console?.model ? `model ${entry.console.model}` : '—'} | ${smpText(entry)} | ` +
        `${entry.ctest ? entry.ctest.map(code).join(', ') : '—'} |`
    );
  }
  lines.push('');

  lines.push('### The runtime rule', '');
  lines.push(
    'A board gets µTest++ only if it meets the rule every µTest++ board must meet. The',
    'scaffolder checked it in the sources (`scaffold.json`, `microTestPlus.boards[].runtime`):',
    '',
    '- the boot code runs the static constructors (`__libc_init_array` or `os_run_init_array`);',
    '- the linker script keeps `.init_array` between `__init_array_start` and `__init_array_end`;',
    '- the linker script defines the heap, `_Heap_Begin` .. `_Heap_Limit`;',
    '- the start-up hands the heap to the µOS++ free store (`os_startup_initialize_free_store`), which',
    '  `malloc` and `new` use, before the constructors run;',
    '- `sbrk ()` works over the same region.',
    '',
    'The starter test checks the same on the target, in its suite "01 - Runtime".',
    ''
  );
  for (const entry of record.boards.filter((e) => e.runtime)) {
    lines.push(`${code(entry.platform)}:`, '');
    for (const check of entry.runtime) {
      lines.push(`- ${check.ok ? 'ok' : 'MISSING'}: ${check.rule}${check.ok ? ` (${check.evidence})` : ` -- ${check.why}`}`);
    }
    lines.push('');
  }

  if (!integrated.length) {
    lines.push('No selected board could take µTest++; see the table above.', '');
    return `${lines.join('\n')}\n`;
  }

  const first = integrated[0];
  const config0 = configurationOf(first.platform);
  lines.push('### Running', '');
  lines.push('```bash', 'cd tests');
  for (const entry of integrated) {
    const conf = configurationOf(entry.platform);
    const apps = (entry.starters ?? ['mtp-example']).join(' ');
    if (entry.ctest.some((name) => name.endsWith('-qemu') || name.endsWith('-host'))) {
      lines.push(`./run.sh -c ${conf} ${apps}              # under QEMU / on the host`);
    }
    if (entry.ctest.some((name) => name.endsWith('-hwd'))) {
      lines.push(`./run.sh -c ${conf} ${apps} --hwd        # on the board`);
    }
  }
  lines.push('```', '');
  lines.push(
    'The TAP report goes to the board\'s console and to the runner; the run ends with',
    '`RESULT: PASS (...)` or `RESULT: FAIL (...)`. A failed check prints its file and line.',
    'The complete report is also a file, written through semihosting: the runner passes',
    '`--output-file <log>/<app>.tap` on the OpenOCD/QEMU command line.',
    'The CTest result is `build/<configuration>/ctest.xml` (JUnit).',
    '',
    'Two probes of the same kind on one host (for example a JTAG probe for a Raspberry Pi and',
    'a Debug Probe for a Pico 2, both `2e8a:000c`): OpenOCD takes the first it finds. Point',
    '`OPENOCD` at a wrapper that picks one by its USB serial',
    '(`cat /sys/bus/usb/devices/*/serial`), and keep it next to the OpenOCD scripts tree,',
    'which the runner looks for at `$(dirname $OPENOCD)/../openocd/scripts`:',
    '',
    '```sh',
    '#!/bin/sh',
    'exec /path/to/xpack-openocd/bin/openocd -c "adapter serial E46268C3571E0D36" "$@"',
    '```',
    ''
  );

  lines.push('### What was added', '');
  lines.push(`- ${code(`${record.destination}/`)}: the framework (include/, src/, CMakeLists.txt, licences).`);
  const supports = [...new Set(integrated.map((entry) => entry.support))];
  for (const support of supports) {
    lines.push(`- ${code(`${support}/`)}: the board support (\`mtp_board.*\`, \`mtp_semihosting.hpp\`, \`mtp_startup.hpp\`, README.md).`);
  }
  for (const entry of integrated) {
    const testDir = entry.example.replace(/\/mtp-example$/, '');
    lines.push(
      `- ${code(`${entry.example}/`)}: the starter test; a µTest++ block at the end of` +
        ` ${code(`${testDir}/tests.cmake`)} and one branch in its library hook.`
    );
    if ((entry.starters ?? []).includes('mtp-args')) {
      lines.push(`- ${code(`${testDir}/mtp-args/`)}: the semihosting argc/argv check (below).`);
    }
    if ((entry.starters ?? []).includes('mtp-smp')) {
      lines.push(`- ${code(`${testDir}/mtp-smp/`)}: the SMP test (below).`);
    }
    if ((entry.starters ?? []).includes('mtp-eth-net')) {
      lines.push(`- ${code(`${testDir}/mtp-eth-net/`)}: the Ethernet + lwIP network test.`);
    }
  }
  lines.push('- `tests/run.sh`: the starter tests are in each configuration\'s selection, so they run by default.', '');

  if (integrated.some((entry) => (entry.starters ?? []).includes('mtp-args'))) {
    lines.push('### The arguments test, `mtp-args`', '');
    lines.push(
      'It checks the transport itself: the runner passes',
      '',
      '```text',
      'arm semihosting_cmdline mtp-args --output-file <path>',
      '```',
      '',
      '(QEMU: `-semihosting-config ...,arg=mtp-args,arg=--output-file,arg=<path>`;',
      'host: the same two process arguments). The suite checks that `os_main ()`',
      'received at least three words, that `argv[0]` names the test, that',
      '`argv[1]` is `--output-file`, that `argv[2]` ends in `.tap`, and that',
      '`mtp_board::argument_count()` parsed the same count. A runner that drops',
      'the command line fails this CTest case instead of silently running the',
      'test with an empty `argv`.',
      ''
    );
  }

  if (integrated.some((entry) => (entry.starters ?? []).includes('mtp-smp'))) {
    lines.push('### The SMP test, `mtp-smp`', '');
    lines.push(
      'On the boards whose other cores the board support can start, `mtp-smp` checks the SMP',
      'scheduler on every core (it is written for `OS_NCPU` cores):',
      '',
      '| Suite | What it checks |',
      '| --- | --- |',
      '| 00 Cores | the other cores started and joined the scheduler |',
      '| 01 Affinity | a pinned thread runs on its core; affinity changes at run time |',
      '| 02 Critical sections | `interrupts::critical_section` excludes every core, masks, nests and restores; a core waits while another holds the kernel lock; `scheduler::critical_section` holds off switches on its core and leaves the others running |',
      '| 03 Spinlocks | `mtp_board::spinlock`: no lost update from every core; `try_lock` refused while another core holds it |',
      '| 04 Mutexes | contention from every core; `try_lock`/`timed_lock` against another core; recursive; priority inheritance across cores |',
      '| 05 Scheduler | preemption of a busy thread; `yield` between equal priorities; `sleep_for` on every core; load spread |',
      '| 06 Cross-core sync | semaphore ping-pong, ordered message queue, event flags, a barrier of all cores |',
      '| 07 Queue stress | one producer per core into one bounded queue: nothing lost or duplicated |',
      '| 08 Atomic read-modify-write | `mtp_board::atomic_add ()` from every core; `std::atomic` where the hardware supports it |',
      '| 09 Speed-up | the same CPU-bound work on one core, then on every core at once: at least 0.8 x `OS_NCPU` faster on the board (reported only under QEMU) |',
      '',
      'Spinlocks and `atomic_add ()` go through the board\'s own method, printed at the start of the',
      'report (`# cross-core sync method: ...`):',
      '',
      '- Raspberry Pi (AArch64): the exclusive monitor, `LDAXR`/`STLXR`, compiled inline',
      '  (`no-outline-atomics`, not libgcc\'s run-time choice);',
      '- AArch32: `LDREX`/`STREX` (`LDAEX`/`STLEX` on an ARMv8 core);',
      '- RP2040/RP2350: the SIO hardware spinlocks (8..30 for `spinlock`, 31 for `atomic_add ()`;',
      '  0 is the kernel\'s, 1 the console\'s). Their `LDREX`/`STREX` exclude only the same core',
      '  (measured on a Pico 2: 51547 of 100000 increments from two cores survived), so',
      '  `std::atomic` read-modify-write is not checked there and must not be shared between cores.',
      '',
      'Inside `scheduler::critical_section` a test must not wait on `sysclock`: on the RP2350 the',
      'scheduler lock masks this core\'s interrupts and the clock stands still. Bound such waits by',
      'iterations.',
      ''
    );
  }

  lines.push('### How it works', '');
  lines.push(
    '1. **Registration.** `mtp-example/` is a test directory like the others: the port\'s',
    '   builder globs it, makes its images, and the platform registers',
    `   ${code(`${first.platform}-mtp-example-<variant>`)} with CTest.`,
    '2. **Linking.** The µTest++ block in `tests.cmake` declares the INTERFACE library',
    '   `uos-micro-test-plus`: the framework\'s sources, `mtp_board.cpp`, the include paths, and',
    '   `MICRO_OS_PLUS_MICRO_TEST_PLUS_ENABLED`, `_GNU_SOURCE` and the `MTP_*` defines. The library',
    '   hook links it to every test whose name starts with `mtp-`.',
    '3. **Start-up.** The board boots as for every test: the boot code clears `.bss`, sets up the',
    '   heap, runs the static constructors (the µTest++ runner is one), then calls `os_main ()`',
    '   on the main thread. On the boards whose tests carry their own start-up, `mtp_startup.hpp`',
    '   provides it.',
    '4. **The run.** `os_main ()` calls `mtp_board::start ()`, which routes stdout (below),',
    '   optionally `release_cores ()`, then `mtp_board::run (argc, argv)`: it initialises',
    '   the runner, runs the static suites, prints the RESULT line and ends the run.',
    '   Each suite registers itself with a namespace-scope `mt::static_suite`; there is no',
    '   list of suites to maintain.',
    '5. **The report.** µTest++ prints through stdout. Console model 1: stdout is replaced by a',
    '   stream that writes to the UART at once and sends the text to the host with semihosting',
    '   `SYS_WRITE0`, at the end of each suite (every line under QEMU), because every',
    '   semihosting call halts the cores. Model 2: a strong `_write ()` does the same in place',
    '   of the port\'s weak stub. Model 3: the host\'s stdout. The runner (`run-hw.sh`,',
    '   `run-qemu.sh`, `run-host.sh`) collects that output and looks for `RESULT: PASS`.',
    '6. **newlib-nano** (`MTP_NANO_PRINTF=1`). µTest++ prints sizes with `%zu`, which nano does',
    '   not know; the board support wraps the printf family (`-Wl,--wrap=...`) to drop the `z`',
    '   (`size_t` is `unsigned int` there) and links `_printf_float` for the `approx ()` messages.',
    '   The framework stays unchanged.',
    '7. **Boards whose QEMU image replaces the board** (`board_test_qemu_libs` in `tests.cmake`,',
    '   as on the Pico 2): the `mtp-*` tests are hardware only, because the runtime rule was',
    '   checked on the board, not on the emulated stand-in.',
    ''
  );

  lines.push('### Adding a µTest++ test', '');
  lines.push(
    `Copy the starter test and edit it; no CMake file needs changing:`,
    '',
    '```bash',
    `cp -r ${first.example} ${first.example.replace(/mtp-example$/, 'mtp-mine')}   # or mtp-smp, for a multi-core test`,
    `$EDITOR ${first.example.replace(/mtp-example$/, 'mtp-mine')}/*.cpp`,
    `cd tests && ./run.sh -c ${config0} mtp-mine`,
    '```',
    '',
    '- One suite per source file, registered by the file itself:',
    '  `mt::static_suite s{ "NN - Name", mtp_board::runner (), [] (mt::suite& ts) { ... } };`',
    '  There is no list of suites in `main.cpp`; the runner discovers them (sorted by name).',
    '- `main.cpp` is only `start ()`, the optional `release_cores ()`, and `run (argc, argv)`.',
    '- Use `t.expect (...)`, not `t.require (...)`: the build has no exceptions, so a failed',
    '  `require` aborts the whole run.',
    '- Compare kernel results with `mtp::ok` or `mtp::code (EWOULDBLOCK)` and the other POSIX errors.',
    '- A test that needs the real board ends its QEMU image with `return mtp_board::skip ("why");`',
    '  under `#if !defined(HW_BUILD)`.',
    '- A check that depends on one core pins its threads to core 0 (`th_cpu_affinity = 1u << 0`)',
    '  when the test releases the other cores.',
    '- Name the report path in the CTest case (the runners do it for `mtp-*`): `--output-file <path>`.',
    '',
    `The board support's own README (${code(`${supports[0]}/README.md`)}) lists the defines.`,
    ''
  );
  return `${lines.join('\n')}\n`;
}

module.exports = { readmeSection };
