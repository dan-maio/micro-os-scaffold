'use strict';

/* The README sections of the options (µTest++, stdc++) in a v2 workspace. */

const code = (value) => `\`${value}\``;

function microTestPlusSection(record) {
  if (!record) return '';
  const lines = [
    '## µTest++ (`--micro-test-plus`)',
    '',
    `µTest++ ${record.version ?? ''} from ${code(record.spec)}${record.ref ? ` (${record.ref})` : ''} is in`,
    `${code(`${record.destination}/`)}; the board support (console, verdict, report file, cores) is in`,
    `${code(`${record.support}/`)} (its README lists the defines and the SMP helpers).`,
    '',
    '| Platform | Status | Console | SMP boot | Starter tests |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const p of record.platforms) {
    lines.push(
      `| ${code(p.platform)} | ${p.status}${p.why ? `: ${p.why}` : ''} | ${p.console?.model ?? '—'} | ${p.smpBoot ?? '—'} | ` +
        `${(p.starters ?? []).map(code).join(', ') || '—'} |`
    );
  }
  lines.push(
    '',
    'A µTest++ test is a folder `micro-os-plus-iii/tests/platforms/<platform>/tests/mtp-<name>/`:',
    'copy `mtp-example/` (or `mtp-smp/` for a multi-core test). Every `mtp-*` folder links',
    'µTest++ through the block at the end of the platform\'s `tests/tests.cmake`.',
    '',
    'Each `mtp-*` case gets its name as `argv[0]` and `--output-file <report>`: the complete',
    'TAP report is `micro-os-plus-iii/tests/build/<configuration>/mtp-reports/<ctest name>.tap`',
    '(written through semihosting under QEMU and on the board). The registration helpers in',
    '`micro-os-plus-iii/tests/cmake/uos-tests-run.cmake` carry the change, marked',
    '`SCAFFOLD µTest++`; other tests are unchanged.',
    ''
  );
  return lines.join('\n');
}

function stdcppSection(record) {
  if (!record) return '';
  const lines = [
    '## StateOS stdc++ (`--stdcpp`)',
    '',
    `The StateOS stdc++ package adapted to µOS++ III is in ${code(`${record.destination}/`)}`,
    `(from ${record.spec === 'bundled' ? 'the copy bundled with micro-os-scaffold' : code(record.spec)}): the GCC gthread`,
    'layer (`std::thread`, `std::mutex`, `std::condition_variable`, `std::call_once`),',
    '`std::future`/`promise`/`async`, the clocks over the kernel clock, emulated',
    '`thread_local`, and C++20 `<barrier>`, `<latch>`, `<semaphore>`.',
    '',
    '| Platform | stdc++ | Starter test |',
    '| --- | --- | --- |',
  ];
  for (const p of record.platforms) {
    lines.push(`| ${code(p.platform)} | ${p.status}${p.why ? ` (${p.why})` : ''} | ${p.starter ? code(p.starter) : '—'} |`);
  }
  lines.push(
    '',
    'To use it from another test, return `stateos-stdc++` from the library hook in the',
    'platform\'s `tests/tests.cmake`, as the `mtp-stdcpp` branch does. On the RP2040/RP2350',
    'a `std::atomic` read-modify-write does not exclude the other core: use the package\'s',
    'mutexes or `mtp_board::atomic_add ()` there.',
    ''
  );
  return lines.join('\n');
}

module.exports = { microTestPlusSection, stdcppSection };
