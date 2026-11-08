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
`aarch32-rpi3b` or `2.3.smp_test1`. Multiple tokens are comma separated.
`all` selects every board and every test of the port architectures (the kernel is always
scaffolded and is not a build target).

The selected leaves are written to `scaffold.json` as `selectedSelections`,
`selectedPlatforms` and `selectedTests`. One build configuration is created per selected
board. For CMake workspaces, `tests/scripts/selected-tests.txt` maps each configuration to the
exact CTest names of the selected tests, and `tests/test.sh` runs only those tests by default.

## Commands

| Command | Purpose |
| --- | --- |
| `node bin/scaffold.js [dest] [options]` | Discover, write `scaffold.json`, copy the layout, then build. |
| `node bin/scaffold.js discover [--source dir]` | Scan and list architectures, boards and tests; no files are written. |
| `node bin/scaffold.js list [dest]` | Show selected boards/tests, tools and build results from an existing `scaffold.json`. |
| `node bin/scaffold.js build [dest]` | Run the verification builds recorded in `scaffold.json` only. |
| `node bin/scaffold.js scaffold [dest]` | Explicit form of the default action. |

Options:

| Option | Meaning |
| --- | --- |
| `--source <dir>` | Source workspace (default: `scaffold.json`'s `sourceRoot`, then the current folder). |
| `--select <list>` | `architecture[.board[.test]]` tokens, ids, or `all`. Default: previous selection, else one default board per port. |
| `--config <name>` | Build only this configuration (repeatable). |
| `--no-build` | Scaffold without the verification build. |
| `--list-only` | Discover and write `scaffold.json`, copy nothing. |
| `--minimal` | Copy only the selected tests/platforms/suites (default). |
| `--full` | Copy the complete harness and every platform/board/test. |
| `--lean` | Strict test-only layout: full kernel, build/run files for the selected test only. Implies `--minimal`; wins over `--full`. |
| `--yes` | Non-interactive; use the default selection. |
| `--help` | Usage. |
| `--version` | Print the tool version. |

Environment: `SCAFFOLD_SOURCE`, `SCAFFOLD_SELECT`, `SCAFFOLD_DEBUG=1` (stack traces).
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

The tree below is the full CMake layout. Default minimal mode removes `integration/`,
`test_smpl/` when unused, the top-level `docs/`, unused platforms/suites/xPacks and other
boards/tests; lean mode removes port docs, the per-port `README-SCAFFOLD.md`, and the build
outputs. Cargo and Zig
workspaces contain the corresponding project tree and the generated `tests/` scripts instead
of the CMake harness.

```text
<destination>/
├── scaffold.json                 single source of truth
├── README.md                     top-level guide (regenerated after the build)
├── docs/                         BUILD-TEST-CTEST-SYSTEM.md/.pdf and other workspace docs
├── integration/<port>/           per-port source-level add_subdirectory glue
├── micro-os-plus-iii-smp/        complete kernel copy
├── <port>/                       complete selected port copy (original files preserved)
│   └── README-SCAFFOLD.md        generated guide for that project
├── tests/                        adapted CTest harness
│   ├── build.sh                  configure + build from scaffold.json
│   ├── test.sh                   run only the selected CTest tests
│   ├── openocd.sh, qemu.sh       wrappers using the recorded tool paths
│   ├── scripts/env.sh            PATH and UOS_* variables derived from scaffold.json
│   ├── scripts/selected-tests.txt configuration-to-test mapping
│   ├── platforms/, sources/, cmake/, device-qemu-cortexm/
│   └── xpacks/                   build-helper, validator, chan-fatfs, libucontext
├── test_smpl/                    shared run-host/run-qemu/run-hw runners
└── build-logs/                   configure/build logs from the verification
```

The original repositories are never modified. The only edits to copied files are the sibling
path resolutions in `tests/` (the harness is now a sibling of the kernel instead of a child) and
the QEMU root lookup, which now honours `UOS_QEMU_XPACK_ROOT` from `scaffold.json`. Both are
listed in the generated README and in `.scaffold-manifest.json`.

## Minimal pruning (default)

For every build system the scaffolder copies only what the selected tests need.
The top-level workspace `docs/` and the CMake `test_smpl/` runners are removed
when they are not needed; lean mode additionally removes the build outputs.

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
- `test_smpl/`, `tests/deprecated/`, `tests/README.md`, the harness package
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

## Lean mode (`--lean`)

`--lean` is the strictest layout for every build system. It keeps the kernel
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
a short test-specific page. Per-port `README-SCAFFOLD.md` files are not
written. After verification the CMake build tree, Cargo `target/` and the Zig
caches (`zig-out/`, `zig-pkg/`, `.zig-cache/`) are removed; run
`tests/build.sh` before `tests/test.sh`.

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

In normal and full modes each selected port gets a `README-SCAFFOLD.md`; lean mode omits these
and writes a single short top-level README instead. The guide documents, with the values
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
- `templates/test.sh` — the selection-id CTest runner;
- `lib/extension-guide.js` — fills the port/board/platform/configuration placeholders.

Every normal or full CMake scaffold therefore contains the full extension guide and the worked
SMP example out of the box. Lean scaffolds carry a short test-specific README instead.

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
   `tests/scripts/selected-tests.txt` maps selection IDs to exact CTest names.

5. Build and run:

   ```bash
   cd tests
   ./build.sh <configuration>
   ./test.sh <configuration> <selection-id>
   ```

   Examples:

   ```bash
   ./test.sh cortexm-pico2-cmake-gcc-debug 2.3.1
   ./test.sh cortexm-pico2-cmake-gcc-debug 4.4.11 4.4.12
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
  `libraries`, and `tests/build.sh` links the ones a build needs into
  `tests/build/<configuration>/xpacks/`.
- Keep the path in `scaffold.json`; do not hard-code it in CMake.

### 8. Build and test after changes

```bash
cd tests

# Reconfigure + build (CMake re-runs every time)
./build.sh cortexm-pico2-cmake-gcc-debug

# List all registered cases
ctest --test-dir build/cortexm-pico2-cmake-gcc-debug -N

# Run a selected case by selection id (no regex on the command line)
./test.sh cortexm-pico2-cmake-gcc-debug 4.4.4

# Run all selected tests, including hardware
./test.sh cortexm-pico2-cmake-gcc-debug --hwd

# Advanced: ad-hoc CTest regex
./test.sh cortexm-pico2-cmake-gcc-debug --regex 'exc-test'
```

`CONFIGURE_DEPENDS` globs mean a normal `./build.sh` notices new test
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
- Hardware (`-hwd`) tests require the physical board and probe. `tests/test.sh` excludes `hwd`
  cases by default, except when the selected test has no other image: then that hardware test
  is run so the selection is not silently ignored.
- Lean workspaces do not contain build outputs. Run `tests/build.sh` before `tests/test.sh`.
