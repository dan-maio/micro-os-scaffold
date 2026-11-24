# micro-os-scaffold

A dependency-free Node.js application that discovers µOS++ III SMP projects in a source
workspace, records the local toolchain in a JSON configuration file, scaffolds a reproducible
workspace (kernel + selected port + the selected test and its harness), and verifies it with a
real test build.

In a CMake workspace the kernel and ports are consumed as **source-level INTERFACE targets**
(`add_subdirectory`), never as pre-built libraries. Cargo workspaces use path dependencies and
Zig workspaces use `build.zig.zon` path dependencies.

## Requirements

- Node.js 18 or newer (no npm packages are installed; everything uses the Node standard library).
- For C/C++ and RISC-V: a cross C/C++ toolchain, CMake, Ninja, and optionally QEMU/OpenOCD.
- For Rust: Cargo and Rustc.
- For Zig: Zig.
The tool locator reports anything missing instead of inventing a path.

## Quick start

```bash
# List the architectures, boards and tests found in a workspace (read-only)
node bin/scaffold.js discover --source /path/to/micro-os-plus-workspace

# Scaffold into the current folder (the first positional argument defaults to '.')
node bin/scaffold.js --source /path/to/micro-os-plus-workspace --select all

# One test, lean layout (the default): complete kernel + only what the test needs
node bin/scaffold.js /path/to/output \
  --source /path/to/micro-os-plus-workspace \
  --select cortexm-pico2.smp-mat-test-ram --yes

# The same, from git repositories instead of a local folder
node bin/scaffold.js /path/to/output \
  --source https://github.com/<user>/micro-os-plus-iii.git,https://github.com/<user>/micro-os-plus-iii-cortexm.git \
  --branch smp --select cortexm-pico2.smp-mat-test-ram --yes

# Scaffold four specific boards and verify them
node bin/scaffold.js /path/to/output \
  --source /path/to/micro-os-plus-workspace \
  --select 2.3,3.2,4.13,5.1

# Select individual tests: architecture 2, board 3, test 1
node bin/scaffold.js /path/to/output \
  --source /path/to/micro-os-plus-workspace \
  --select 2.3.1,5.1.1
```

The first positional argument is the destination folder, as specified. If it is omitted, the
current folder is used.

## The restructured source (`micro-os-plus-iii/tests/`)

Since 2026-11-24 the source workspace (branch `align/smp-upstream`) has a new layout: one
kernel repository holds the whole test harness, and the ports and device packages sit one
folder deeper, by architecture:

```text
<source>/micro-os-plus-iii/                 kernel; tests/ is the harness
  tests/platforms/<platform>/               a board: cmake/, include/, src/, openocd.cfg,
                                            tests/ (its own tests + tests.cmake)
  tests/sources/<test>/                     shared tests, named per platform in
                                            UOS_TESTS_SOURCES / UOS_TESTS_SUITES
  tests/board-tests/                        the one test builder (the hooks)
  tests/cmake/uos-tests-run.cmake           CTest registration (qemu, hwd, host)
  tests/package.json                        the xpm configurations (one per build)
<source>/<arch>/micro-os-plus-iii-<arch>/   ports
<source>/<dir>/micro-os-plus-iii-devices-*/ device packages
```

The scaffolder recognises it (`micro-os-plus-iii/tests/platforms/` and `board-tests/`) and
uses a separate pipeline, `lib/v2/`. The old layout keeps the original pipeline.

```bash
node bin/scaffold.js discover --source /home/dan/Desktop/micro-os-plu-iii-smp-pr-github
node bin/scaffold.js /path/to/output \
  --source /home/dan/Desktop/micro-os-plu-iii-smp-pr-github \
  --select cortexm-weactf411.spi-pipeline \
  --micro-test-plus https://github.com/micro-os-plus/micro-test-plus-xpack.git \
  --micro-test-plus-ref v6.0.0 --stdcpp --yes
```

| | New layout (`lib/v2/`) |
| --- | --- |
| Selection | `<platform>` (every test) or `<platform>.<test>`, or the ids `discover` prints (`13`, `13.2`); comma-separated |
| Configurations | from `tests/package.json` (with its `inherit` chain): the platform's `-cmake-gcc-debug` by default, or `--config <name>` |
| Workspace | mirrors the source: `micro-os-plus-iii/` complete (its `tests/` pruned), the port and device packages the platform names, `third_party/` for the options |
| Pruning | `tests/platforms/` keeps the selected platforms; a platform keeps its selected own tests; its `UOS_TESTS_*` lists and `cmake/dependencies-folders.cmake` keep the selected shared tests; `tests/sources/` keeps what is still named; build-helper keeps the toolchain files in use; git-ignored folders (`.kilo/`, build trees, caches) and the tool links are not copied |
| Entry point | `./run.sh` at the workspace root (`build`, `test`, `list`, `all`, `clean`; `--hwd`, `--hwd-only`, `-R`, `-c`). It links the workspace's package copies into `micro-os-plus-iii/tests/build/<C>/xpacks/@micro-os-plus/` (relative links), the per-configuration libraries (`@xpacks/arm-cmsis`) and the pinned tools (`xpacks/.bin`), then runs the configuration's own `cmake -S . -B build/<C> ... -D PLATFORM_NAME=<p> -D CMAKE_TOOLCHAIN_FILE=...`. It never runs `xpm link` |
| Tool paths | `scripts/env.sh` (generated), the tool folders pinned by the configuration's `devDependencies` in the xPack store |
| Results | `build/<C>/ctest.xml`, `ctest.log`; a µTest++ test's TAP report in `build/<C>/mtp-reports/<ctest name>.tap` |
| `--micro-test-plus` | the board support in `micro-os-plus-iii/tests/mtp/`, the tests in `tests/platforms/<p>/tests/mtp-*/`, the CMake block in that `tests.cmake`; the command line (`argv[0]`, `--output-file`) through the registration helpers in `tests/cmake/uos-tests-run.cmake` (marked `SCAFFOLD µTest++`), and for a Cortex-M platform's inline QEMU `add_test` |
| `--stdcpp` | `third_party/stateos-stdc++/`, wired in each platform's `tests/tests.cmake`; `mtp-stdcpp` where µTest++ is |
| Local tests | `scripts/local-tests.txt` and `tests.local.cmake` (below) |

Verified (2026-11-24) with the six workspaces of `micro-os-scaffold-ctest-examples`: all
build; every QEMU case passes (Pi 4 B 7/7 with `mtp-eth-net` skipped under QEMU as designed,
Zero 2 W AArch64 4/4, AArch32 5/5, Pico 2 `smp-stdcpp-test` 1/1); the µTest++ TAP reports and
`argv` arrive. On the boards: Pi 4 B 7/7 hardware cases, Pico 2 6/6 (`mtp-smp` speed-up 3.85x
and 1.99x, `mtp-stdcpp` 75/75 on both); the WeAct and Zero 2 W workspaces are not yet re-run.
Two workspaces added later the same day:

- `luckfox-lyra`: 21/21 classic tests, and µTest++ 3/3 with the OpenOCD polling fix.
- `rpi-zero-2w-aarch64-usb-stdcpp`, whose local test `usb-sd-stdcpp` is `usb_test` rewritten
  on the stdc++ package. Driven by the source's `host_xfer.py` on the board (0 B to 1 MiB),
  it reported `RESULT: PASS`. On its way it found a bcm283x USB driver bug: DMA into a
  caller's buffer that shares cache lines lost the last 48 bytes of 1 MiB transfers. It is
  fixed in the source device package (`027acb3`).
- `rpi-zero-2w-aarch32-usb-stdcpp`: the same test on the AArch32 Zero 2 W. It passes the full
  matrix and a random 1 MiB file, which confirms the AArch32 driver's fix. Its `std::thread`
  stacks are 16 KiB, through the stdc++ package's new `STATEOS_STDCPP_THREAD_STACK_BYTES`
  define (the default is 4 KiB outside AArch64).

## Local tests (`scripts/local-tests.txt`)

A test added by hand to a workspace survives a re-scaffold when it is listed in
`scripts/local-tests.txt` (new layout; `tests/scripts/local-tests.txt` in the specification
for the old one). The scaffolder never writes that file:

```text
# Tests added by hand to this workspace.
spi-stdcpp-test                 # micro-os-plus-iii/tests/platforms/<p>/tests/spi-stdcpp-test/
cortexm-pico2/my-test           # one platform only
keep third_party/my-lib         # any other file or folder, kept as it is
```

- Before it copies anything, the scaffolder sets aside the listed test folders, every
  `tests/platforms/<p>/tests/tests.local.cmake`, and the `keep` paths; it puts them back
  (the local copy wins) after the copy, the pruning and the options, even when the run
  fails. A stash left by an interrupted run is restored first.
- `./run.sh` runs the listed tests by default; `./run.sh list` marks them `L` (the
  scaffolded selection `*`).
- `tests.local.cmake` holds their CMake wiring. Every hook of the builder
  (`board_test_libs`, `_defines`, `_sources`, `_includes`, `_linker`, `_options`, `_ncpu`,
  `_qemu_libs`, `_qemu_sources`, `_qemu_includes`, `_sd_posix`, `board_test_libraries`) first
  asks its twin `<hook>_local (_app _out)`, when the file defines one; a twin that sets
  `${_out}` answers for that test. The file may also append to the lists
  (`BOARD_TEST_HWD_ONLY`, ...).

  ```cmake
  function (board_test_libs_local _app _out)
    if (_app STREQUAL "spi-stdcpp-test")
      set (${_out} stateos-stdc++ uos-micro-test-plus PARENT_SCOPE)
    endif ()
  endfunction ()
  ```
- A local test named like a shared test of its platform (`smp_test4`) replaces it: the name
  leaves the platform's `UOS_TESTS_*` lists.
- Rejected: a `keep` path outside the workspace or on a generated path (`run.sh`,
  `scripts/env.sh`, `scaffold.json`, `README.md`, `build-logs/`, `micro-os-plus-iii/tests/mtp/`,
  `micro-os-plus-iii/tests/build/`, `third_party/micro-test-plus/`,
  `third_party/stateos-stdc++/`), a starter name (`mtp-example`, `mtp-args`, `mtp-smp`,
  `mtp-eth-net`, `mtp-stdcpp`), a malformed line. A `keep` path inside the kernel or a
  package is allowed, with a warning on every run (source updates of it are not applied).
- `scaffold.json` records them under `localTests` (informational; the list is the source of
  truth).

## What a generated workspace gives you

Four things are the same for every CMake workspace, in every mode:

- **One entry point.** `tests/run.sh` configures, builds, runs, lists and cleans.
  `build.sh`, `test.sh`, `openocd.sh`, `qemu.sh` and `selected-tests.txt` are gone;
  `tests/scripts/env.sh` remains as the generated tool-path file.
- **A real command line on the target.** os_main() receives argc/argv from
  semihosting: OpenOCD passes `arm semihosting_cmdline <app> ...`, QEMU passes
  `-semihosting-config ...,arg=<app>,arg=...`; the host uses the process
  arguments. A µTest++ test can therefore be configured per CTest case.
  The `mtp-args` CTest case asserts that this transport really works
  (`argc >= 3`, `argv[0]` names the test, `argv[1]` is `--output-file`, and
  `argv[2]` ends in `.tap`).
- **Results in files.** Every µTest++ test writes its complete TAP report to a
  file through semihosting (`--output-file <path>`, wired by the runner into
  `.hw-logs/<app>.tap`, `.qemu-logs/<app>.tap` or `.host-logs/<app>.tap`,
  next to the runner's own log), and `tests/run.sh` writes the CTest JUnit
  summary to `build/<configuration>/ctest.xml` and the full CTest output to
  `build/<configuration>/ctest.log`. CTest itself caps each console snippet in
  the JUnit file at 1 KiB; the `.tap` file is the complete report.
- **Self-registering suites.** A µTest++ suite is a namespace-scope
  `mt::static_suite` in its own source file; the runner discovers it through the
  C++ static constructors. There is no list of suites in `main.cpp` to keep in
  step with the files.

## Selection model: architecture.board.test

The numbered list is hierarchical:

```text
 1. micro-os-plus-iii-smp          (kernel, always scaffolded)
 2. micro-os-plus-iii-aarch32
     2.1 aarch32-luckfox-lyra      (board luckfox-lyra, 20 tests)
         2.1.1 clock-test
         2.1.2 sd_test
         ...
     2.2 aarch32-rpi-zero-2w
     2.3 aarch32-rpi3b
 3. micro-os-plus-iii-aarch64
 4. micro-os-plus-iii-cortexm
 5. micro-os-plus-iii-posix-arch
```

A selection token has up to three numeric levels:

| Token | Meaning |
| --- | --- |
| `2` | Architecture 2: every board and every test |
| `2.3` | Architecture 2, board/platform 3: every test of that board |
| `2.3.1` | Architecture 2, board/platform 3, test 1 |

Platform ids and test app names also work in place of numbers, for example
`aarch32-rpi3b`, `2.3.smp_test1` or `riscv-pico2.smp-mat-test-ram`. Multiple tokens are comma separated.
`all` selects every board and every test of the port architectures (the kernel is always
scaffolded and is not a build target).

The selected leaves are written to `scaffold.json` as `selectedSelections`,
`selectedPlatforms` and `selectedTests`. One build configuration is created per selected
board. For CMake workspaces, `tests/run.sh` embeds the exact CTest names of each
configuration and runs only those tests by default.

## Commands

| Command | Purpose |
| --- | --- |
| `node bin/scaffold.js [dest] [options]` | Discover, write `scaffold.json`, copy the layout, then build. |
| `node bin/scaffold.js discover [--source dir]` | Scan and list architectures, boards and tests; no files are written. |
| `node bin/scaffold.js list [dest]` | Show selected boards/tests, tools and build results from an existing `scaffold.json`. |
| `node bin/scaffold.js build [dest] [--clean]` | Run the verification builds recorded in `scaffold.json` only (`--clean`: remove the build trees afterwards). |
| `node bin/scaffold.js clean [dest]` | Remove the compiled build trees (`tests/build`, `target`, `zig-out`). |
| `node bin/scaffold.js scaffold [dest]` | Explicit form of the default action. |

Options:

| Option | Meaning |
| --- | --- |
| `--source <dir\|urls>` | Source workspace: a folder holding the sibling repositories, or a comma separated list of git URLs cloned as siblings into `~/.cache/micro-os-scaffold` (default: the source recorded in `scaffold.json`, then the current folder). |
| `--branch <name>` | Branch to clone when `--source` is a git URL (`url#branch` sets it per repository). |
| `--select <list>` | `architecture[.board[.test]]` tokens, ids, or `all`. Default: previous selection, else one default board per port. |
| `--config <name>` | Build only this configuration (repeatable). |
| `--no-build` | Scaffold without the verification build. |
| `--clean` | Remove the build output directories after the verification build. |
| `--list-only` | Discover and write `scaffold.json`, copy nothing. |
| `--lean` | Full kernel, plus only the build/run files of the selected test (default). |
| `--minimal` | Keep the whole selected port; prune only the unselected boards, tests, platforms and suites. |
| `--full` | Copy the complete harness and every platform/board/test. |
| `--micro-test-plus <git-url\|folder>` | Add the µTest++ test framework and the `mtp-*` starter tests (see "µTest++ tests" below). |
| `--micro-test-plus-ref <tag\|branch>` | What to clone when `--micro-test-plus` is a git URL. |
| `--micro-test-plus-force` | Integrate µTest++ also on boards that fail the runtime rule. |
| `--no-micro-test-plus` | Drop a µTest++ integration recorded in `scaffold.json`. |
| `--stdcpp` | Add the StateOS stdc++ package adapted to µOS++ III (the bundled, verified copy) and, with `--micro-test-plus`, the test `mtp-stdcpp` (see "StateOS stdc++" below). |
| `--stdcpp-from <git-url\|folder>` | Take the package from this folder or repository instead (implies `--stdcpp`). |
| `--stdcpp-ref <tag\|branch>` | What to clone when `--stdcpp-from` is a git URL. |
| `--no-stdcpp` | Drop a stdc++ integration recorded in `scaffold.json`. |
| `--yes` | Non-interactive; use the default selection. |
| `--help` | Usage. |
| `--version` | Print the tool version. |

The strictest layout option given wins; a re-run without one keeps the layout recorded in
`scaffold.json`. With git sources the numeric ids depend on which repositories were cloned,
so prefer names (`cortexm-pico2.smp-mat-test-ram`) or run `discover` with the same `--source`.

Environment: `SCAFFOLD_SOURCE`, `SCAFFOLD_SELECT`, `SCAFFOLD_MICRO_TEST_PLUS`, `SCAFFOLD_STDCPP` (`1` or a source), `SCAFFOLD_CACHE` (clone cache),
`SCAFFOLD_DEBUG=1` (stack traces).
Per-tool overrides use `SCAFFOLD_<TOOL>` (for example `SCAFFOLD_CMAKE=/opt/cmake/bin/cmake`).

When stdin is a terminal the scaffolder prints the numbered tree and asks for a
`architecture.board.test` selection. In scripts or CI, pass `--select` (or `--yes`).

## What counts as an architecture

A direct child of the source workspace is a project when it:

- is named `micro-os-plus-iii` or `micro-os-plus-iii-*`;
- has a build entry point: `CMakeLists.txt`, `Cargo.toml`, or `build.zig`.

The kernel is always included and is not a build target. It is scaffolded as
`micro-os-plus-iii-smp` for CMake workspaces, and keeps its original name for Cargo
(`micro-os-plus-iii-rust`) and Zig (`micro-os-plus-iii`) workspaces. Every other project
is an architecture port. Discovery also reads:

- `test/boards/<board>/` for board ids, `hw.sh`, `openocd.cfg`, adapter, transport and VID:PID;
- `test/<board>/<app>/` and `tests/sources/<suite>/` for the selectable tests;
- `tests/platforms/<platform>/` for the platform catalogue, `BOARD`, QEMU binaries and hardware
  test support;
- `tests/package.json` for the xpm build configurations (`<platform>-cmake-<toolchain>-<type>`);
- the sources for C/C++/ASM/Rust/Zig and the documentation (`.md`, `.pdf`);
- existing `CMakeCache.txt` files to compare previously used tool paths with the current ones.

## Cargo and Zig workspaces

The same discovery/scaffolding flow handles the Rust and Zig sibling trees:

- **Cargo:** a project is detected by `Cargo.toml`. The kernel is
  `micro-os-plus-iii-rust`; ports are `micro-os-plus-iii-<arch>`. Boards are
  `test/boards/<board>/` and tests are `test/<board>/<app>/main.rs`.
- **Zig:** a project is detected by `build.zig`. The kernel is
  `micro-os-plus-iii`; ports are `micro-os-plus-iii-<arch>`. Boards come from
  `boards/<board>/` or `test/<board>/`; tests are `main.zig` directories.
- **Platforms:** `tests/platforms/*` is not involved. A platform is derived from the
  architecture and board (`cortexm-pico2`, `aarch64-rpi4b`, `native`, …), and the
  selection id is still `architecture.board.test`.
- **Build configs:** one per platform, named `<platform>-cargo-debug` or
  `<platform>-zig-debug`.
- **Generated scripts:** for a cross Cargo board, `tests/build.sh` runs
  `cargo build -p <board> --examples --target <target>`; for a native Cargo board it runs
  `cargo build --workspace`. Zig runs `zig build -Dboard=<board>`. `tests/test.sh` runs the
  board's `hw.sh <app>` for cross Cargo boards, `cargo test --workspace` for native Cargo, and
  `zig build run -Dboard=<board> -Dtest=<app>` for Zig.
- **Zig path dependencies:** external `build.zig.zon` paths (for example MicroZig) are
  copied under `<destination>/extern/` and the copied manifest is rewritten to the
  relative local path, so the scaffold builds without the original absolute location.
- **Verified build:** Cargo projects run `cargo build -p <board> --examples --target <target>`
  (or `cargo test --workspace` for native); Zig projects run `zig build -Dboard=<board>` with
  the detected `cargo`, `rustc` and `zig` paths.

The generated README for a Cargo or Zig project is build-system-specific; the CMake
extension guide applies only to the CMake projects in a mixed workspace.

## `scaffold.json`

`scaffold.json` is the single source of truth. It records:

- `sourceRoot`, `destination`, `inputLayout`, `generatedLayout`;
- `kernel` and `projects[]`: id, role, architecture, version, git branch/commit, languages,
  boards, platforms, per-board tests, documentation, size, destination path, required tools;
- `selectedSelections`, `selectedPlatforms`, `selectedTests`, `selections`;
- `tools`: absolute `path`, `binDir`, raw and parsed `version`, detection `origin`, and
  `previousPaths`/`reconciled` when a stale path was found in an existing build tree;
- `libraries`: the local xPack libraries used by the harness (`build-helper`, `arm-cmsis`,
  `arm-cmsis-core`, `arm-cmsis-rtos-validator`, `chan-fatfs`, `libucontext`,
  `raspberrypi-pico-sdk`);
- `missingTools`;
- `platformCatalog`, `harness.buildConfigurations`;
- `build.configurations[]` with one entry per selected board and its selected tests;
- `build.results[]` with configure/build exit codes, logs, the compilers CMake actually used,
  and any mismatch against the JSON.

Lean mode writes a **slim** manifest: it keeps the selected project/platform/test, the tools
used by that configuration and the build result, and omits the full discovery catalogue
(`platformCatalog`, `harness`, `inputLayout`, `generatedLayout`, `missingTools`).

Tool lookup order: `SCAFFOLD_<TOOL>` → `PATH` → the local xPack repository
(`~/.local/xPacks/@xpack-dev-tools/<tool>/<version>/.content/bin`). QEMU deliberately prefers
the xPack tree because the CTest harness resolves it there. The newest installed version wins.
On every run the JSON is refreshed and compared with paths recorded by earlier CMake caches.

## Generated layout

The tree below is the full CMake layout (`--full`). Minimal mode removes `integration/`,
the top-level `docs/`, unused platforms/suites/xPacks and other boards/tests; lean mode (the
default) additionally removes port docs, unused SoC support, the per-port
`README-SCAFFOLD.md`, and the build outputs. Cargo and Zig
workspaces contain the corresponding project tree and the generated `tests/` scripts instead
of the CMake harness.

```text
<destination>/
├── scaffold.json                 single source of truth
├── README.md                     top-level guide (regenerated after the build)
├── docs/                         BUILD-TEST-CTEST-SYSTEM.md/.pdf and other workspace docs
├── integration/<port>/           per-port source-level add_subdirectory glue
├── micro-os-plus-iii-smp/        complete kernel copy (with test_smpl/, the shared runners)
├── <port>/                       complete selected port copy (original files preserved)
│   └── README-SCAFFOLD.md        generated guide for that project
├── tests/                        adapted CTest harness
│   ├── run.sh                    the one entry point: build, test, list, clean
│   ├── ARCHITECTURE.md           general guide to the harness folders and flow
│   ├── scripts/env.sh            PATH and UOS_* variables derived from scaffold.json
│   ├── build/<config>/ctest.xml  CTest JUnit summary (1 KiB snippet per test)
│   ├── build/<config>/ctest.log  full CTest output
│   ├── platforms/, sources/, cmake/, device-qemu-cortexm/
│   └── xpacks/                   build-helper, validator, chan-fatfs, libucontext
└── build-logs/                   configure/build logs from the verification
```

The original repositories are never modified. The edits to copied files are the sibling
path resolutions in `tests/` (the harness is now a sibling of the kernel instead of a child, so
the kernel, its `package.json` and its `test_smpl/` runners are reached through
`../micro-os-plus-iii-smp`), the QEMU root lookup, which now honours `UOS_QEMU_XPACK_ROOT`
from `scaffold.json`, and — with `--micro-test-plus` — the runner patches that pass the
debugger command line and the report path (the board `hw.sh` and the shared
`run-hw.sh`/`run-qemu.sh`/`run-host.sh` get one marked block each). `tests/scripts/env.sh`
derives the workspace root from its own location, so a generated workspace can be moved;
if a build tree is moved with it, `tests/run.sh` detects the stale absolute paths in the
CMake cache and reconfigures instead of failing.
All are listed in the generated README and in `.scaffold-manifest.json`.

## Minimal pruning (`--minimal`, and the first stage of lean)

For every build system the scaffolder copies only what the selected tests need.
The top-level workspace `docs/` is not copied; lean mode additionally reduces the
port and removes the build outputs.

### CMake (C/C++ and RISC-V)

- the kernel repository is copied integrally;
- the selected port is copied integrally for its source/SoC/include/CMake/docs;
- only the selected board directories (`test/boards/<board>/`, plus `shared/`
  and any board source directory referenced by a selected `board.cmake`) are kept;
- inside each selected board's test directory only the selected test
  applications, plus the shared `include/`, `src/` and `tests.cmake`, are kept;
- sibling sources included with `#include "../<app>/..."` are kept as helpers
  and excluded from the test build (both CMake builders are patched);
- under `tests/` only the selected platforms, the harness suites referenced by
  those tests, the required xPack libraries and `build-helper` are kept;
- `device-qemu-cortexm` is kept only when a QEMU test is selected;
- `tests/deprecated/`, `tests/README.md`, the harness package
  copy, the generated OpenOCD index, the top-level workspace `docs/` and the
  integration entry point are removed when not used by the selection.

### Cargo (Rust)

- the kernel and port crates are copied integrally;
- only the selected board crate under `test/boards/<board>/` and the selected
  test directories under `test/<board>/<app>/` are kept;
- the workspace `Cargo.toml` member list is rewritten to the selected board;
- each board `Cargo.toml` keeps only the `[[example]]` blocks for the selected
  tests.

### Zig

- the kernel and port sources are copied integrally;
- only the selected board sources (`boards/<board>/` or
  `src/boards/<board>.zig`), the local board helpers they import, and selected
  test directories are kept;
- the `boards`, `tests` and `board_tests` tables in `build.zig` are pruned;
- external `build.zig.zon` path dependencies are still copied under `extern/`
  and the copied manifest paths are rewritten.

The build verification runs after pruning, so a missing dependency is caught
immediately. Use `--full` to keep the previous complete harness and all board
tests (useful for exploring a whole port).

## Lean mode (`--lean`, the default)

Lean is the strictest layout for every build system. It keeps the kernel
repository complete (the test is written against its interface), reduces the
port to the files its build and runner actually use, and removes the build
caches after verification so the workspace contains only source and scripts.

### CMake (C/C++ and RISC-V)

- `CMakeLists.txt`, `cmake/`, `include/`, `src/`, `LICENSE`;
- only the `include-*` and `soc/*` directories named by the selected board's
  `board.cmake` (for example `include-rp2350` and `soc/rp2350` for the Pico 2,
  so the STM32 support is not copied);
- `test/boards/<board>/` and `test/boards/shared/`;
- `test/<board>/include/`, `test/<board>/src/`, `tests.cmake` and the selected
  test directory;
- the runner files the board needs (`hw.sh`, `openocd.cfg`, linker scripts,
  board `.cfg` files, and the VF2 reset scripts);
- only the selected board's USB/QEMU support when the test uses it.
- probe configurations, GDB scripts and reset scripts at the port root only
  when the selected board's scripts name them (the JH7110/VisionFive 2 files
  are not copied for a Mango Pi or Pico 2 selection).

### Cargo (Rust)

- `Cargo.toml`, `Cargo.lock`, `rust-toolchain.toml`, `LICENSE`;
- only the port crates the selected board's `Cargo.toml` references
  (transitively);
- `test/boards/<board>/` and the selected `test/<board>/<app>/`;
- the workspace `members` and `[[example]]` lists are already reduced by the
  normal minimal pruning.

### Zig

- `build.zig`, `build.zig.zon`, `src/`, `LICENSE`;
- the selected board source and the local board helpers it imports, plus the
  selected test directory;
- `extern/microzig` is kept for the build, but its `.git`, examples, design,
  simulation and website trees are removed.

Lean mode drops port docs, changelogs, PDFs, PNGs, package metadata, editor
settings, `conf_back/`, alternate SoC families and unrelated test support. The
top-level metadata is reduced to the selected project/platform/test, the tools
actually used by that configuration, and the build result; `README.md` becomes
a test-specific page whose last part, *Adding new functionality to this
workspace*, explains with the real port/board/test names where a new source
file, library or test goes and which CMake file or script integrates it. Per-port `README-SCAFFOLD.md` files are not
written. After verification the CMake build tree, Cargo `target/` and the Zig
caches (`zig-out/`, `zig-pkg/`, `.zig-cache/`) are removed; run
`tests/run.sh` rebuilds them.

Documentation files (`.md`, `.pdf`, images) inside the port's `test/` tree are
removed too. When several boards are selected, the port keeps the union of the
SoC and include directories they name. A board whose selected tests are all
hardware-only loses its `qemu/` support; a test added later must then be listed
in `BOARD_TEST_HWD_ONLY`.

The kernel sources, headers, configuration and documentation remain complete, as
requested, so the interface stays available. Version-control metadata and build
caches are excluded by the copy filter.

## Build verification

After scaffolding, the application runs the real build for the selected build system.

For CMake:

1. creates `tests/build/<configuration>/`;
2. links the xPack libraries the configuration needs into that build tree;
3. runs `cmake -S tests -B tests/build/<configuration> -G Ninja` with the platform, build type,
   the cross toolchain file, and (for the native port) the explicit host compiler paths;
4. runs `cmake --build ... -- -k 0`;
5. reads `CMakeCache.txt` back to confirm CMake used the compilers recorded in `scaffold.json`.

For Cargo it runs `cargo build -p <board> --examples --target <target>` (or
`cargo test --workspace` for native). For Zig it runs `zig build -Dboard=<board>`.

In every case it writes `build-logs/<configuration>.*.log`, records the result in
`scaffold.json` and rewrites the README tables. Failures are reported and produce a non-zero
exit code; they are never silently ignored.

## Generated project guides

In minimal and full modes each selected port gets a `README-SCAFFOLD.md`; lean mode omits these
and writes a single top-level README (selection, layout, tools, build/run commands, and the
extension guide generated by `lib/lean-guide.js` from `templates/README-LEAN-CMAKE.md`). The guide documents, with the values
detected in this environment:

- the compiler/toolchain and exact versions and paths;
- how to add source files and headers;
- how to configure additional builds (the full configuration table comes from the harness);
- how to add and run tests (board test directories, `tests.cmake` hooks, selection ids and exact CTest names);
- the debugging probes per board (adapter, transport, VID:PID, OpenOCD config path) and how to
  switch between CMSIS-DAP, ST-Link, J-Link, FTDI, SWD and JTAG;
- how to build, execute and debug, including a GDB session recipe;
- C/C++ specifics and the actual state of Rust/Zig support (nothing is invented when absent);
- the preserved documentation (`.md` and `.pdf`).

The original `README.md` of each project is preserved untouched next to the generated guide.

Board-specific hardware preparation is discovered too. For the VisionFive 2 Lite the
`vf2-reset-to-uboot-picoprobe.sh` script is run automatically by the copied board
`hw.sh` before each `-hwd` test; it resets the SoC and interrupts U-Boot autoboot so
the test can be loaded into DDR. Set `UOS_SKIP_PRE_TEST=1` to skip it. The generated
`tests/scripts/prepare-visionfive2-lite.sh` runs the same preparation manually.

The generated workspace `README.md` is itself templated:

- `templates/README-EXTENSION.md` — where to add files, devices, boards, SoCs, tests and
  dependencies, and which CMake targets/hooks to edit;
- `templates/README-WORKED-EXAMPLE.md` — the complete SMP 20×20 matrix multiply example;
- `templates/run.sh` — the single build/test entry point;
- `lib/extension-guide.js` — fills the port/board/platform/configuration placeholders.

Every minimal or full CMake scaffold therefore contains the full extension guide and the worked
SMP example out of the box. Lean scaffolds carry the test-specific guide instead: it reads the
hook names from the port's own `test/CMakeLists.txt` (they differ between ports, for example
`board_test_libs` on Cortex-M and `board_test_libraries` on the POSIX port), so every snippet
can be pasted as written.

## Adding files, devices, boards and tests

The generated workspace is ordinary CMake source. Nothing is installed as a
pre-built library: the kernel and each port export INTERFACE targets whose
sources are compiled into the test executables. Use the following locations.

### 0. Where things live

```text
<destination>/
├── micro-os-plus-iii-smp/
│   ├── CMakeLists.txt              kernel INTERFACE targets
│   ├── include/                    public kernel headers
│   └── src/                        kernel sources
├── <port>/
│   ├── CMakeLists.txt              port + SoC + board INTERFACE targets
│   ├── include*/                   port headers
│   ├── src/                        port-wide sources
│   ├── soc/<soc>/include, src/     device/SoC support
│   └── test/
│       ├── CMakeLists.txt          builds one target per test directory
│       ├── boards/<board>/         board facts, startup, glue, linker, probe
│       └── <board>/
│           ├── tests.cmake         per-test hooks
│           └── <app>/              one directory per test application
└── tests/
    ├── CMakeLists.txt              harness entry point
    ├── cmake/                      global CMake helpers
    ├── platforms/<platform>/       platform selection and CTest registration
    ├── sources/<suite>/            portable harness suites
    └── xpacks/                     build-helper and other xPack dependencies
```

### 1. Add a source file to the kernel

1. Put the file under `micro-os-plus-iii-smp/src/<group>/` (for example
   `src/rtos/`).
2. Add it to the kernel interface target in
   `micro-os-plus-iii-smp/CMakeLists.txt`:

   ```cmake
   target_sources (
     micro-os-plus-iii-interface
     INTERFACE
       src/rtos/os-new-feature.cpp
   )
   ```

3. Put headers under `micro-os-plus-iii-smp/include/` — that directory is
   already on the interface include path.
4. If the new code is an optional group (not every port needs it), create a
   separate INTERFACE target, an alias such as
   `micro-os-plus::iii-new-feature`, and link that alias from the port or
   board that needs it.

### 2. Add a source file to a port

1. Port-wide sources go under `<port>/src/` and are added to the port
   interface target in `<port>/CMakeLists.txt`:

   ```cmake
   target_sources (
     micro-os-plus-iii-cortexm-interface
     INTERFACE
       src/new-port-file.cpp
   )
   ```

2. Board-only sources go under `<port>/test/boards/<board>/src/`. The port
   CMakeLists globs that directory (`*.c`, `*.cpp`, `*.S`) automatically.
3. Per-test glue goes under `<port>/test/boards/<board>/glue/` and is named
   per test in `test/<board>/tests.cmake` through `board_test_sources()`.
   It is deliberately not globbed, because different tests link different
   subsets.
4. Headers go under the port `include/` (port-wide) or the board
   `test/boards/<board>/include/` (board-only). Add board include paths with
   `UOS_BOARD_PORT_INCLUDE` in `board.cmake`, or with
   `target_include_directories()` in the port CMakeLists.

### 3. Add a new device / SoC

Use this when adding a new silicon family, not a new board of an existing one.

1. Create the device tree:

   ```text
   <port>/soc/<soc>/
   ├── include/                 CMSIS device header, SoC registers
   └── src/                     system_<soc>.c, vectors, clocks
   ```

2. Add an INTERFACE target in the port CMakeLists:

   ```cmake
   add_library (micro-os-plus-iii-soc-<soc>-interface INTERFACE)
   target_include_directories (
     micro-os-plus-iii-soc-<soc>-interface
     INTERFACE
       "${CMAKE_CURRENT_SOURCE_DIR}/soc/<soc>/include"
       "${CMAKE_CURRENT_SOURCE_DIR}/soc/<soc>/include/cmsis"
   )
   target_sources (
     micro-os-plus-iii-soc-<soc>-interface
     INTERFACE
       "${CMAKE_CURRENT_SOURCE_DIR}/soc/<soc>/src/system_<soc>.c"
   )
   add_library (micro-os-plus::soc-<soc>
                ALIAS micro-os-plus-iii-soc-<soc>-interface)
   ```

3. Link it from the board in `test/boards/<board>/board.cmake`:

   ```cmake
   set (UOS_BOARD_LIBS micro-os-plus::soc-<soc>)
   ```

4. Add the startup code, vector table, clock setup and linker scripts under
   `test/boards/<board>/`. The board `src/` directory is globbed.

### 4. Add a new board

A board is a directory under `<port>/test/boards/<board>/` containing at
least `board.cmake`:

| Variable | Required | Meaning |
|---|---|---|
| `UOS_BOARD_SRC_DIR` | yes | directory that holds the board sources |
| `UOS_BOARD_FLAGS` | yes | CPU flags, e.g. `-mcpu=cortex-m33 -mthumb -mfloat-abi=hard` |
| `UOS_BOARD_NCPU` | yes | number of CPUs visible to the RTOS |
| `UOS_BOARD_CAPS` | yes | capability list, e.g. `smp led uart` |
| `UOS_BOARD_LINKER_HW` | yes | linker script for hardware |
| `UOS_BOARD_DEFINES` | yes | board compile definitions |
| `UOS_BOARD_LINKER_QEMU` | optional | linker script for the QEMU image |
| `UOS_BOARD_LIBS` | optional | SoC/board libraries, e.g. `micro-os-plus::soc-rp2350` |
| `UOS_BOARD_PORT_CORE` | optional | port-specific scheduler core |
| `UOS_BOARD_PORT_INCLUDE` | optional | port include overlay, searched first |
| `UOS_BOARD_RTOS_GLUE` | optional | per-board RTOS glue sources |

Also create:

```text
<port>/test/boards/<board>/
├── board.cmake
├── openocd.cfg          probe configuration
├── hw.sh                hardware runner
├── linker.ld            hardware memory map
├── linker-qemu.ld       optional QEMU memory map
├── src/                 startup, vectors, clocks, LEDs
├── include/             board headers, CMSIS os-app-config.h
└── glue/                optional per-test glue
```

Add the board's tests under `<port>/test/<board>/` and its hooks in
`<port>/test/<board>/tests.cmake`.

For a new CTest platform, create `tests/platforms/<platform>/` by copying a
similar platform and adjusting:

```text
tests/platforms/<platform>/
├── CMakeLists.txt
├── cmake/definitions.cmake          sets BOARD
├── cmake/dependencies-folders.cmake
├── cmake/platform-library.cmake
└── include/cmsis-plus/platform.h
```

Finally add a build configuration in `tests/package.json` using the naming
`<platform>-cmake-<toolchain>-<debug|release>`, or add the selection to
`scaffold.json` and re-run the scaffolder.

### 5. Add a new test application

1. Create a directory under the board's test tree:

   ```text
   <port>/test/<board>/<app>/
   └── main.cpp
   ```

   At least one `.c`, `.cpp` or `.S` file is required. The port's
   `test/CMakeLists.txt` discovers every such directory; there is no central
   test list.

2. Add per-test settings to `<port>/test/<board>/tests.cmake` when needed:

   | Hook / list | Use |
   |---|---|
   | `BOARD_TEST_HWD_ONLY` | test has no QEMU image |
   | `BOARD_TEST_NO_KERNEL` | bare-metal test, no RTOS |
   | `BOARD_TEST_SELF_CONTAINED` | test brings its own startup and must not get shared `src/` |
   | `BOARD_TEST_NEED_DEVICES` | link the board device drivers |
   | `board_test_sources(_app _out)` | extra source files |
   | `board_test_includes(_app _out)` | extra include directories |
   | `board_test_defines(_app _out)` | extra compile definitions |
   | `board_test_options(_app _out)` | extra compile options |
   | `board_test_linker(_app _out)` | alternate linker script |
   | `board_test_ncpu(_app _out)` | override `OS_NCPU` |
   | `board_test_libs(_app _out)` | extra libraries, e.g. `test::rtos-apis` |
   | `board_test_qemu_libs/sources/includes` | what the QEMU variant links instead of the board |

3. CTest names are generated as:

   ```text
   <platform>-<app>-qemu
   <platform>-<app>-hwd
   <platform>-<app>-host
   ```

4. Register the selection in `scaffold.json` (or re-run the scaffolder with
   `--select <architecture>.<board>.<test>`). The generated
   `./run.sh list` shows the exact CTest names; `./run.sh <selection-id>` runs one.

5. Build and run:

   ```bash
   cd tests
   ./run.sh build -c <configuration>
   ./run.sh -c <configuration> <selection-id | test-directory-name>
   ```

   Examples:

   ```bash
   ./run.sh -c cortexm-pico2-cmake-gcc-debug 2.3.1
   ./run.sh -c cortexm-pico2-cmake-gcc-debug 4.4.11 4.4.12
   ```

### 6. Add a portable harness suite

Portable suites live in `tests/sources/<suite>/` and export
`test::<suite>`:

```text
tests/sources/<suite>/
├── CMakeLists.txt        add_library(test::<suite> INTERFACE ...)
├── include/              suite headers, os-app-config.h
└── *.cpp                 suite implementation
```

1. Add the directory to
   `tests/platforms/<platform>/cmake/dependencies-folders.cmake` so it is
   `add_subdirectory()`'d.
2. Link `test::<suite>` from the board test that uses it through
   `board_test_libs()`.
3. If the suite needs its own `cmsis-plus/os-app-config.h`, place it in the
   suite's include directory and let `board_test_includes()` put it first.

### 7. Add a dependency / xPack

- Add the dependency to `tests/package.json` and run `xpm install` in the
  original harness, or copy the resolved xPack into `tests/xpacks/`.
- The scaffold records detected libraries in `scaffold.json` under
  `libraries`, and `tests/run.sh` links the ones a build needs into
  `tests/build/<configuration>/xpacks/`.
- Keep the path in `scaffold.json`; do not hard-code it in CMake.

### 8. Build and test after changes

```bash
cd tests

# Reconfigure + build (CMake re-runs every time)
./run.sh build -c cortexm-pico2-cmake-gcc-debug

# List all registered cases (`*` = run by default)
./run.sh list -c cortexm-pico2-cmake-gcc-debug

# Run a selected case by selection id (no regex on the command line)
./run.sh -c cortexm-pico2-cmake-gcc-debug 4.4.4

# Run all selected tests, including hardware
./run.sh -c cortexm-pico2-cmake-gcc-debug --hwd

# Advanced: ad-hoc CTest regex
./run.sh -c cortexm-pico2-cmake-gcc-debug --regex 'exc-test'
```

`CONFIGURE_DEPENDS` globs mean a normal `./run.sh` notices new test
directories and new board source files. If a file is added to an explicit
`target_sources()` list, edit the CMakeLists as described above.

### 9. Minimal workspaces

A reduced workspace (for example a Pico 2 workspace for one selected board
and test) contains only the selected board and tests. Adding a different
board or SoC to a reduced workspace requires restoring its files from the
source repository, or re-running the scaffolder with that selection and pruning
again. Adding another test for the **same** board only needs the test
directory, its `tests.cmake` hooks, and a selection entry.

The generated workspace README contains a complete worked example: the
`matmul-f32-20` test (**SMP** 20×20 floating-point matrix multiply, UART
output, verdict). It shows the source file, the exact `tests.cmake` hooks,
core launch and worker affinity, the barrier, the selection registration, the
build command and the expected hardware output. The example is illustrative:
its test directory must exist in the source repository and be committed there
before a clean re-scaffold can reproduce it.

## µTest++ tests (`--micro-test-plus`)

`--micro-test-plus <git-url|folder>` adds the µTest++ unit-test framework
(<https://github.com/micro-os-plus/micro-test-plus-xpack>,
docs <https://micro-os-plus.github.io/micro-test-plus-xpack/>) to the workspace.
A µTest++ test is an ordinary test directory named `mtp-<name>`: the harness builds
and registers it like any other; inside, a µTest++ runner checks with `t.expect`
and reports in TAP, ending with the `RESULT:` line the runners read.

A test is a `main.cpp` with three lines and one file per suite:

```cpp
// main.cpp
int os_main (int argc, char* argv[])
{
  mtp_board::start ("mtp-example");
#if defined(MTP_HAS_SMP_BOOT) && MTP_HAS_SMP_BOOT
  mtp_board::release_cores ();
#endif
  return mtp_board::run (argc, argv);
}
#include <mtp_startup.hpp>

// suite-basics.cpp
mt::static_suite suite_basics{
  "02 - Basics", mtp_board::runner (), [] (mt::suite& ts) {
    ts.test ("comparisons", [] (auto& t) { t.expect (mt::eq (6 * 7, 42)); });
  }
};
```

The suite registers itself; `run_suites()` discovers it and runs the static suites
sorted by name. Adding a file is adding a suite, and nothing else changes.

The generated runners pass the case name and the report path on the target's command
line. On a probe this is `arm semihosting_cmdline <app> --output-file <path>`; under
QEMU it is `-semihosting-config enable=on,target=native,arg=<app>,arg=--output-file,arg=<path>`.
On the host the same two arguments are the process arguments. The complete TAP report
is written through semihosting, without any board needing `_open()`/`_write()`:
`-Wl,--wrap=fopen` sends the reporter's `fopen()` to `mtp_semihosting::open()`. On Cortex-M,
`-Wl,--wrap=main` gives `os_main()` the debugger's command line on a board whose reset code
calls `main (0, NULL)` itself (the Pico 2's `boot.S`).

```bash
node bin/scaffold.js ../ws-pico2 --select cortexm-pico2.smp-mat-test \
  --micro-test-plus https://github.com/micro-os-plus/micro-test-plus-xpack.git \
  --micro-test-plus-ref v6.0.0 --yes
cd ../ws-pico2/tests && ./run.sh -c cortexm-pico2-cmake-gcc-debug mtp-example mtp-args mtp-smp --hwd
```

What it adds: the framework in `third_party/micro-test-plus/` (unchanged), the board
support in `<port>/test/mtp/` (`mtp_board.*`, `mtp_semihosting.hpp`, `mtp_startup.hpp`), a µTest++ block in each board's `tests.cmake` that links
it to every `mtp-*` test, the starter tests `mtp-example` and `mtp-args` (the
semihosting `argc`/`argv` check), on boards whose other cores it can start,
`mtp-smp`, and on boards with the GENET v5 + lwIP Ethernet stack
(`test/boards/<board>/net/src/`), `mtp-eth-net`.

- **The runtime rule.** A board gets µTest++ only if its boot runs the static
  constructors, its linker script keeps `.init_array` and defines
  `_Heap_Begin`/`_Heap_Limit`, its start-up hands that heap to the µOS++ free store, and
  `sbrk` uses it. The scaffolder checks this in the sources (`--micro-test-plus-force`
  overrides); `mtp-example` checks it again on the target.
- **Console models.** AArch32/AArch64: a stdout stream to the UART and to semihosting
  `SYS_WRITE0`, batched; Cortex-M: a strong `_write ()`, with the newlib-nano printf
  wrapped so that µTest++'s `%zu` prints, and the UART switched on first where the board
  leaves that to its tests (the STM32 boards); POSIX: the host's stdout.
- **`mtp-smp`** checks affinity, critical sections, spinlocks, mutexes (with priority
  inheritance across cores), the scheduler, cross-core sync, a queue stress and atomic
  read-modify-write on every core, and measures the speed-up of the same work on every
  core against one (3.86x on the Pi 4 B and Zero 2 W AArch64, 3.91x on the Zero 2 W
  AArch32, 1.77x on the 2-core Pico 2). Spinlocks and `atomic_add ()` use the board's
  method: `LDAXR`/`STLXR` (`LDAEX`/`STLEX` on AArch32) on the Raspberry Pi, the SIO
  hardware spinlocks on the RP2040/RP2350, whose `LDREX`/`STREX` do not exclude the
  other core.
- **`mtp-eth-net`** (on boards with the GENET v5 + BCM54213PE + lwIP stack, such as the
  Pi 4 B) checks SMP core release, MAC/PHY/ring initialisation, auto-negotiation and
  DHCPv4 lease acquisition, 56 B and 256 B ICMP echo rounds to the gateway, and FAT32
  SD card telemetry (`tests/MTPNET.LOG`), skipping cleanly under QEMU.
- **Verified on the boards:** Zero 2 W AArch64 27 + 78 checks (3.86x speed-up),
  Zero 2 W AArch32 27 + 78 (3.91x speed-up), Pi 4 B 27 + 78 (3.86x speed-up) + 25 in
  `mtp-eth-net` (plus classic `eth-net`), Pico 2 (RP2350) 27 + 71 (1.77x speed-up on
  2 cores), NUCLEO-F411 (Cortex-M4) 24, WeAct F411CE 24, plus 52 in a board-specific
  SPI-flash test (`examples/cortexm-weactf411-mtp-spi-flash/`); the same flash is also
  tested by five classic tests without µTest++
  (`examples/cortexm-weactf411-flash-battery/`), 5/5.

`scaffold.md`, chapter 13, explains the integration, analysed from the hand-made one in
`micro-os-scaffold-workspace-rpi-zero-2w`, and how to run with two probes on one host.

## StateOS stdc++ (`--stdcpp`)

`--stdcpp` adds the StateOS stdc++ package adapted to µOS++ III: the parts of libstdc++
a bare-metal toolchain leaves out, implemented over the kernel's objects. That is the
GCC gthread layer (`std::thread`, `std::mutex`, `std::condition_variable`,
`std::call_once`), `std::future`/`promise`/`async`/`packaged_task`, `system_clock` and
`steady_clock` over the kernel clock, emulated `thread_local`, and C++20 `<barrier>`,
`<latch>` and `<semaphore>`.

```bash
node bin/scaffold.js ../ws-rpi4b --select aarch64-rpi4b.clock-test \
  --micro-test-plus https://github.com/micro-os-plus/micro-test-plus-xpack.git \
  --micro-test-plus-ref v6.0.0 --stdcpp --yes
cd ../ws-rpi4b/tests && ./run.sh mtp-stdcpp
```

- **The package** is bundled with the scaffolder (`templates/stdcpp/stateos-stdc++/`),
  the copy used and verified in `micro-os-scaffold-ctest-examples`. It is copied unchanged
  to `third_party/stateos-stdc++/`. `--stdcpp-from <folder|git-url>` takes another copy.
- **Each board** gets a `stateos-stdc++` block in its `tests.cmake` (an INTERFACE
  library: its sources compile into each test that links it, with that test's flags).
- **With `--micro-test-plus`**, each µTest++ board also gets the test `mtp-stdcpp`, with
  six suites: `std::thread` and TLS, promise/future, packaged_task/async, mutexes and
  `call_once`, the synchronisation primitives, and chrono. It is linked to the package
  from the board's library hook. Without µTest++ only the library is wired; a test links
  it by returning `stateos-stdc++` from the hook.
- **Verified:** the same suites pass on the Raspberry Pi 4 B (4 cores), the Pico 2 (2 cores,
  and single-core under QEMU) and the WeAct F411CE (1 core). A scaffold made with
  `--stdcpp` passes 75/75 under QEMU on the Pi 4 B, and builds for the Pico 2 and the WeAct.

`scaffold.md`, chapter 13.9, has the details. The option is recorded in `scaffold.json` and
kept by later runs; `--no-stdcpp` removes it.

## Moving or renaming the workspace

The generated workspace is relocatable. `tests/scripts/env.sh` and
`tests/run.sh` find the root from their own location, and CMake uses the
sibling paths, so renaming the top folder does not break the build.

If a `tests/build/<configuration>/` tree is moved with the workspace, its
`CMakeCache.txt` still holds the old absolute paths. `tests/run.sh` detects
this (it compares `CMAKE_CACHEFILE_DIR` and `CMAKE_HOME_DIRECTORY` with the
current folders), removes the stale tree and configures again. No manual
`tests/run.sh clean` is needed.

Two things are intentionally absolute:

- the tool paths in `tests/scripts/env.sh`; on the same machine they keep
  working, on another machine re-scaffold or override them with
  `UOS_TOOL_<NAME>`;
- the metadata in `scaffold.json` (`destination`, the µTest++ source path);
  it is not used by the build. Re-scaffolding refreshes it.

## Idempotence and updates

Every run rescans the workspace, refreshes the tool paths/versions, rewrites `scaffold.json`,
and copies the selected projects over the existing destination. Minimal and lean runs start
each selected configuration from a clean build tree, so tests that are no longer present cannot
leave stale objects behind. Lean mode also removes the build outputs after verification. If a
project is deselected it is left on disk but is no longer listed in
`selectedProjects`/`selectedPlatforms`; remove it manually if desired.

## Limitations

- The scaffolder does not install tools. Missing tools are listed in `scaffold.json` and block
  the affected build with an explicit `blocked` status.
- Rust and Zig projects are detected and scaffolded when present; the Rust and Zig trial
  workspaces are built and verified.
- Hardware (`-hwd`) tests require the physical board and probe. `tests/run.sh` excludes `hwd`
  cases by default, except when the selected test has no other image: then that hardware test
  is run so the selection is not silently ignored.
- Lean workspaces do not contain build outputs; `tests/run.sh` builds before it runs.
- Re-running the scaffolder on a workspace removes test directories that are not selected,
  unless `scripts/local-tests.txt` lists them (new layout, see "Local tests"). In an old-layout
  workspace, copy new work to the source repository first.
- µTest++ was run on the Zero 2 W (AArch64 and AArch32), the Pi 4 B, the Pico 2, the
  NUCLEO-F411, the WeAct F411CE and the Luckfox Lyra (RK3506); other boards are integrated by
  the same rules but not yet run on hardware.
- Luckfox Lyra: without a fix, a µTest++ test hangs, because OpenOCD's background polling
  sometimes misses a semihosting halt of core 0. The source's `openocd.cfg` now polls core 0
  every 100 ms from a Tcl timer (micro-os-plus-iii commit `06d365fe`), so every new Lyra
  workspace has the fix. Each semihosting
  call costs about 0.55 s through the WCH-Link, so a µTest++ test takes minutes there.
