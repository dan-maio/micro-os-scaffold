# Micro-OS Scaffold

<p class="subtitle">A detailed guide to building minimal, test-specific µOS++ workspaces for C/C++, RISC-V, Rust and Zig</p>

**Version 1.0 · November 2026**

This document is the long-form companion to `README.md`. It explains the
problem the scaffolder solves, the repository and selection model, the
scaffolding pipeline, the generated scripts, the build/architecture/language
specifics, how to use the tool, and how to extend a test application locally.

---

# Table of contents

1. Executive summary
2. The problem this tool solves
3. Vocabulary
4. The source world: kernels, ports, boards and tests
5. How a workspace is selected
6. `scaffold.json`: the single source of truth
7. The scaffolding pipeline, step by step
8. The generated scripts
9. Build-system and architecture specifics
10. Minimal mode versus lean mode
11. How to use the scaffolder
12. Extending a test application locally
13. µTest++ tests (`--micro-test-plus`)
14. Rules, invariants and design philosophy
15. Troubleshooting
16. The current trial workspaces
17. Limitations and future work
18. Glossary
19. Appendix A: typical lean layouts
20. Appendix B: command cheat sheet

---

# 1. Executive summary

`micro-os-scaffold` is a small Node.js command-line application. It reads a
source workspace that contains several µOS++ repositories, discovers which
architectures, boards and tests exist, and produces a new, self-contained
workspace in a destination directory.

The destination is not a copy of everything. It is a **scaffold**: a reduced
tree that contains exactly the material needed to build and run one selected
test, or a small set of selected tests.

The tool has three layout levels:

| Mode | What it is for |
| --- | --- |
| `--lean` (default) | Strict test-only layout for CMake, Cargo and Zig. Keeps the kernel complete, keeps only build/run-essential port files, writes a slim manifest and a README with a concrete extension guide, and removes build caches after verification. |
| `--minimal` | Copies the kernel and the whole port, plus only the selected board, platform, test applications, harness suites and xPack libraries. Keeps the build tree. |
| `--full` | Copies the complete harness, every platform, every board and every test. Useful for exploring a port, not for focused work. |

The most important invariant is simple: **the source repositories are read
only**. The tool discovers and copies; it never edits the source. Everything
new is written under the destination.

The second invariant is also simple: **the kernel is copied complete**. The
kernel is the interface that every test is written against. Its headers,
sources, configuration and documentation stay available. Here “complete”
means the source tree: version-control metadata and build caches are excluded
by the copy filter. The reduction is applied to the port, the board support,
the harness and the selected tests, not to the kernel.

The result is reproducible from `scaffold.json`, build-verified, and small
enough to hand to another developer or to archive with a bug report.

---

# 2. The problem this tool solves

## 2.1 Many repositories, many combinations

A µOS++ development machine typically contains sibling repositories such as:

- a portable kernel;
- one or more architecture ports;
- a CTest harness;
- a Rust workspace with board crates;
- a Zig workspace with board definitions;
- external packages such as MicroZig, CMSIS, FatFs, libucontext or the
  Raspberry Pi Pico SDK.

Each port contains several boards. Each board contains several test
applications. A test may be a normal board application, a harness suite, a
QEMU-only image, a hardware-only image, a RAM-resident image, or a native host
program.

A full workspace therefore contains thousands of files and, after a few
builds, several gigabytes of objects and caches. Most of those files are
irrelevant to the one test a developer is currently debugging.

## 2.2 Why copying the whole thing is a bad answer

A naive copy has several problems:

1. **Noise.** Searching for a symbol or a configuration option returns hits
   from dozens of boards and tests that have nothing to do with the task.
2. **Size.** Build trees and package caches dominate the copy. A whole Rust
   workspace can be hundreds of megabytes before it even starts.
3. **Wrong dependencies.** A build may accidentally pick up a header or a
   CMake file from an unrelated board, hiding a real dependency.
4. **Slow CI and review.** A test-specific artifact should be small enough to
   attach to an issue, a pull request or a CI job.
5. **Different build systems.** C/C++ and RISC-V use CMake and CTest; Rust
   uses Cargo; Zig uses `build.zig`. One pruning strategy cannot be written
   only in terms of CMake variables.

## 2.3 The requirements that shaped the design

The tool was built around these requirements:

- Keep the kernel complete, because the test is written against its public
  interface.
- Keep only the selected port, board and test material.
- Never modify the source repositories.
- Generate a manifest that records exactly what was selected and which tools
  were used.
- Build the result immediately, so a missing file is discovered at scaffold
  time rather than a week later.
- Support CMake, Cargo and Zig with the same user-facing model.
- Make the generated workspace reproducible by re-running one command.

---

# 3. Vocabulary

The following words are used consistently throughout the tool and this
document.

| Term | Meaning |
| --- | --- |
| **Kernel** | The portable µOS++ III kernel: scheduler, threads, mutexes, semaphores, memory pools, timers, POSIX layer, C++ wrappers. |
| **Port** | The architecture-specific layer: startup code, trap/interrupt entry, context switch, MMU/MPU setup, UART, clocks, board glue. Examples: `micro-os-plus-iii-cortexm`, `micro-os-plus-iii-riscv`. |
| **Board** | A concrete piece of hardware or an emulated target: `pico2`, `visionfive2-lite`, `nucleof411`, `native`. |
| **Platform** | The build-level combination of a port and a board. A platform has an id such as `cortexm-pico2` or `riscv-visionfive2-lite`. |
| **Test application** | A directory with the test source, for example `smp-mat-test` or `matmul-f32-20`. |
| **Harness suite** | A portable test suite from the kernel's `tests/sources/` tree, built as a board application by a placeholder directory. |
| **Selection** | A three-level identifier `architecture.board.test`, for example `4.4.12`. |
| **Configuration** | One build/test command line, for example `cortexm-pico2-cmake-gcc-debug`. |
| **xPack** | A binary or source package used by the build: toolchain, OpenOCD, QEMU, CMSIS, FatFs, build helper. |
| **BSP** | Board support package: the board-specific headers and sources. |
| **HAL** | Hardware abstraction layer. |
| **CTest** | CMake's test runner. A CMake workspace registers named test cases; `ctest` runs them. |
| **OpenOCD** | Open On-Chip Debugger. It talks to a JTAG/SWD probe and loads the ELF image into the board. |
| **JTAG / SWD** | Debug interfaces used by OpenOCD to reach the CPU. |
| **HART** | A RISC-V hardware thread. A four-hart CPU can run four independent instruction streams. |
| **SMP** | Symmetric multiprocessing: several CPUs run one kernel and share memory. |
| **UART** | Serial port used for test output. |
| **QEMU** | Emulator used for tests that do not need real silicon. |
| **Linker script** | A file that tells the linker where code, data, stack and heap live in memory. |
| **ELF** | The executable image loaded on the board or run in QEMU. |
| **Lean mode** | The strictest scaffold layout, implemented by `--lean`. |

---

# 4. The source world: kernels, ports, boards and tests

The scaffolder does not assume one universal directory layout. It discovers
the layout by inspecting the source root.

## 4.1 CMake workspaces (C, C++ and RISC-V)

A typical source root contains:

```text
source-root/
  micro-os-plus-iii-smp/        portable kernel (copied complete)
  micro-os-plus-iii/            kernel test harness (tests/)
  micro-os-plus-iii-cortexm/    Arm Cortex-M port
  micro-os-plus-iii-aarch32/    Arm AArch32 port
  micro-os-plus-iii-aarch64/    Arm AArch64 port
  micro-os-plus-iii-riscv/      RISC-V port
  micro-os-plus-iii-posix-arch/ POSIX host port
```

For a CMake workspace the tool copies `micro-os-plus-iii-smp` as the kernel.
It copies the CTest harness from the sibling `micro-os-plus-iii/tests` tree.
It copies only the selected port repository.

Inside a port:

```text
micro-os-plus-iii-cortexm/
  CMakeLists.txt
  cmake/
  include/  include-rp2350/  include-m33/ ...
  soc/                             SoC support (STM32, RP2040, RP2350)
  src/                             port sources
  test/
    boards/<board>/                board.cmake, linker scripts, hw.sh, OpenOCD cfg
    boards/shared/                 cross-board helpers (hw_result.hpp, syscalls)
    <board>/                       board test applications
      include/                     shared test headers
      src/                         shared test sources (e.g. smp-autostart.cpp)
      tests.cmake                  per-test hooks
      <app>/main.cpp               one test application
```

The CMake harness (`tests/`) provides the top-level build, the platform
definitions, the portable suites, and the xPack wiring.

## 4.2 Rust workspaces (Cargo)

A Rust source root contains:

```text
source-root/
  micro-os-plus-iii-rust/         kernel crates
  micro-os-plus-iii-cortexm/      Cortex-M port (Cargo workspace)
  micro-os-plus-iii-aarch64/      AArch64 port
  micro-os-plus-iii-posix-arch/   native port
```

Inside a port:

```text
micro-os-plus-iii-cortexm/
  Cargo.toml                      workspace members
  Cargo.lock
  rust-toolchain.toml
  crates/
    uos-port-cortexm/
    uos-port-rp2350/
    uos-port-rp2040/
  test/
    boards/<board>/Cargo.toml     board crate, with [[example]] blocks
    <board>/<app>/main.rs         test application
```

Each test is a Cargo example of the board crate. The board crate depends on
the kernel crates and on one or more port crates.

## 4.3 Zig workspaces

A Zig source root contains:

```text
source-root/
  micro-os-plus-iii/              Zig kernel
  micro-os-plus-iii-cortexm/      Cortex-M port
  micro-os-plus-iii-aarch64/      AArch64 port
  micro-os-plus-iii-aarch32/      AArch32 port
  micro-os-plus-iii-posix-arch/   native port
```

Inside a port:

```text
micro-os-plus-iii-cortexm/
  build.zig                       board table, test table, board_tests table
  build.zig.zon                   dependencies (kernel, MicroZig)
  src/
    boards/pico2.zig              board definitions
  test/
    pico2/<app>/main.zig          board test application
    <app>/main.zig                portable test application
  extern/microzig/                external Zig package, copied by the tool
```

The Zig build selects a board and a test through build options:
`zig build -Dboard=pico2 -Dtest=smp-test-ko`.

---

# 5. How a workspace is selected

## 5.1 Discovery

On every run the scaffolder rescans the source root. Discovery classifies
each repository as a kernel or a port, then enumerates:

- platforms (port plus board);
- boards;
- test applications;
- QEMU and hardware capabilities;
- tool requirements.

The result is a catalogue such as:

```text
2.4    riscv-visionfive2-lite  (board visionfive2-lite, 22 tests)
       2.4.1   blinky
       2.4.2   clock-catchup
       2.4.3   clock-test
       ...
       2.4.17  smp-mat-test
```

## 5.2 Selection identifiers

A selection is written:

```text
<architecture>.<board>.<test>
```

For example:

| Selection | Meaning |
| --- | --- |
| `2` | every platform and every test of architecture 2 |
| `2.4` | every test of architecture 2, platform 4 |
| `2.4.17` | one test |

The numeric test index is assigned **alphabetically by application name**.
This is convenient for humans but has one consequence worth remembering: if a
new test directory is added to a board, the indexes of tests after it shift.
For that reason the scaffolder also accepts names:

```text
--select 2.4.smp-mat-test
--select 4.4.smp-mat-test-ram
--select 3.1.smoke
--select 4.3.smp-test-ko
```

A name token is resolved against the current discovery result. This is the
recommended form for scripts and documentation, because it survives index
changes.

## 5.3 Multiple selections

Selections can be comma-separated:

```bash
--select 2.4.smp-mat-test,2.4.clock-test
```

Whole boards are also possible:

```bash
--select 2.4
```

`--select all` selects every port, board and test. It is useful for
exploration, but it defeats the purpose of a focused workspace.

---

# 6. `scaffold.json`: the single source of truth

Every generated workspace contains `scaffold.json`. The file records:

- the source root and destination;
- the generator version and generation time;
- the kernel and selected projects;
- the selected platforms, selections and tests;
- the tool paths and versions that were detected;
- the xPack libraries;
- the build configurations and their verification results;
- the layout mode (`full`, `minimal` or `lean`).

The generated scripts do not guess. `tests/scripts/env.sh` is generated from
`scaffold.json`, and so is the only executable, `tests/run.sh`.

A full manifest contains the complete discovery catalogue. A lean manifest is
deliberately much smaller: it keeps only the selected project, platform and
test, the tools actually used, and the build result.

Example of the information that matters to a user:

```json
{
  "mode": "lean",
  "selectedSelections": ["2.4.17"],
  "selectedTests": [
    {
      "selectionId": "2.4.17",
      "platform": "riscv-visionfive2-lite",
      "board": "visionfive2-lite",
      "app": "smp-mat-test",
      "ctestPattern": "^riscv-visionfive2-lite-smp-mat-test-hwd$"
    }
  ],
  "tools": {
    "riscv-none-elf-gcc": { "version": "15.2.0", "path": "..." }
  },
  "build": {
    "configurations": [
      {
        "name": "riscv-visionfive2-lite-cmake-gcc-debug",
        "platform": "riscv-visionfive2-lite",
        "tests": [{ "app": "smp-mat-test" }]
      }
    ],
    "results": [{ "status": "pass" }]
  }
}
```

The `list` subcommand reads this file and shows the selected boards, tests,
tools and build results.

---

# 7. The scaffolding pipeline, step by step

This is the order in which a normal run works.

## Step 1 — Discover the source workspace

The tool scans the source root and builds the in-memory catalogue. It also
checks for the kernel repository and fails early if the source root is wrong.

## Step 2 — Choose the selection

The selection can come from:

1. the `--select` command-line option;
2. the environment variable `SCAFFOLD_SELECT`;
3. the previous `scaffold.json` in the destination;
4. an interactive prompt;
5. a default selection when `--yes` is used.

## Step 3 — Detect tools

The tool resolves the tools needed by the selected port: compilers, debuggers,
CMake, Ninja, OpenOCD, QEMU, Cargo, Rustc, Zig, Python, Git. It searches the
`PATH` first and then the local xPack repository.

The detected absolute paths and versions are written to `scaffold.json`. This
is what makes the generated workspace independent of the current shell
environment.

## Step 4 — Write the configuration

The configuration is written before copying. If the run is interrupted, the
destination still records what was intended.

## Step 5 — Copy the kernel

The kernel is copied **complete**. In a CMake workspace it is normally named
`micro-os-plus-iii-smp`; in a Rust workspace `micro-os-plus-iii-rust`; in a
Zig workspace `micro-os-plus-iii`.

Build directories, object trees and caches are excluded by the copy filter,
but source, headers, configuration and documentation are kept.

## Step 6 — Copy the selected ports

Only the ports referenced by the selection are copied. For a single Arm test,
the Cortex-M port is copied and the RISC-V port is not. For a single RISC-V
test, the reverse is true.

## Step 7 — Copy the harness and dependencies

For CMake workspaces the CTest harness is copied from
`micro-os-plus-iii/tests`. For Cargo and Zig workspaces the harness is not
needed; the generated `tests/` directory contains only the scripts that drive
the build.

Required xPack libraries are copied from their resolved locations. This makes
the workspace self-contained and independent of `xpm install` at build time.

## Step 8 — Generate the scripts

The tool writes:

```text
tests/scripts/env.sh
tests/run.sh
tests/ARCHITECTURE.md
```

It also copies or generates the runner helpers and the CTest registration.

## Step 9 — Apply minimal pruning

This is the ordinary reduction:

- other boards are removed;
- other test applications are removed;
- other platforms are removed;
- unused harness suites and xPack libraries are removed;
- unused QEMU device support is removed;
- unused integration files, harness documentation and the top-level workspace
  `docs/` are removed;
- the port's board list is reduced to the selected board and its referenced
  board directories.

The kernel and the selected port source are kept complete at this level.

## Step 10 — Apply lean pruning, when requested

Lean mode goes further:

- port documentation, PDFs, changelogs and package metadata are removed;
- only the SoC and include families named by the selected `board.cmake` are
  kept;
- unrelated board USB and QEMU support is removed;
- for Cargo, only the port crates referenced by the selected board crate are
  kept;
- for Zig, the external MicroZig package loses its examples, design,
  simulation and website trees, and only the selected board sources plus the
  local helpers they import are kept;
- top-level `docs/` and `integration/` are removed (the shared `test_smpl/` runners are used from the complete kernel copy, in every mode);
- the manifest is rewritten in slim form;
- the README is rewritten as a test-specific page that ends with the guide for adding files, libraries and tests.

## Step 11 — Verify with a real build

The tool runs the same build a user would run:

- **CMake:** configure with the selected toolchain and build with Ninja.
- **Cargo:** `cargo build -p <board> --examples --target <target>`.
- **Zig:** `zig build -Dboard=<board>`.

Logs are written to `build-logs/`. The result is stored in `scaffold.json`.

For CMake, the tool also reads `CMakeCache.txt` back and confirms that the
compiler paths used by CMake match the paths recorded in the manifest. This
catches a surprising number of environment problems.

## Step 12 — Finish the documentation

A top-level `README.md` is generated. In normal minimal mode it describes the
selected boards, tests, tools, build commands, test commands and the board
preparation hook. In lean mode it is a short page focused on one test.

Per-port `README-SCAFFOLD.md` files are generated in normal mode and omitted
in lean mode, because the top-level page already covers the only selected
test.

## Step 13 — Clean the build outputs, in lean mode

Lean mode removes the CMake build tree, the Cargo `target/` directory and the
Zig caches after verification. The workspace then contains source, scripts
and logs, but not a prebuilt binary. `tests/run.sh` rebuilds it before
running.

---

# 8. The generated scripts

## 8.1 `tests/scripts/env.sh`

This file exports the tool paths from `scaffold.json` and sets up the library
paths needed by the build. It is sourced by the other scripts.

- `SCAFFOLD_ROOT` is derived from the location of the script, and every path
  inside the workspace is written relative to it, so the workspace can be moved
  or copied to another folder and still build.
- Every tool is exported as `UOS_TOOL_<NAME>="${UOS_TOOL_<NAME>:-<detected path>}"`:
  export the variable before calling the scripts to use another tool without
  regenerating.
- A lean workspace lists only the tools its selection uses (compiler, CMake,
  Ninja, and OpenOCD/QEMU when a test needs them).

## 8.2 `tests/run.sh build`

For CMake, the one script configures the build with the recorded platform,
build type, toolchain file and compiler paths, then runs Ninja:

```bash
cd tests
./run.sh build
./run.sh build -c cortexm-pico2-cmake-gcc-debug
./run.sh clean -c cortexm-pico2-cmake-gcc-debug
```

For Cargo and Zig, the generated `tests/build.sh` performs the corresponding
command:

```bash
cargo build -p nucleof411 --examples --target thumbv7em-none-eabihf
zig build -Dboard=pico2
```

## 8.3 `tests/run.sh`

For CMake, one script does everything: configure and build, then run CTest.
A test is named by its selection id, its application directory name, or its
full CTest name:

```bash
cd tests
./run.sh                                                   # build + the selected tests
./run.sh build                                             # build only
./run.sh -c riscv-visionfive2-lite-cmake-gcc-debug 2.4.17  # by selection id
./run.sh -c cortexm-pico2-cmake-gcc-debug my-new-test      # by directory name
./run.sh list                                              # registered cases (* = selected)
./run.sh all --hwd                                         # everything registered
./run.sh clean                                             # remove the build tree
```

| Option | Meaning |
| --- | --- |
| `-c`, `--config <name>` | the build configuration (default: the first in `scaffold.json`) |
| `--hwd` | include the hardware cases (they also run when the named test has no other image) |
| `--all` | every CTest case registered in the build tree |
| `--list` | list the registered cases; the selected ones are marked `*` |
| `--regex <re>` | ad-hoc CTest regular expression |
| `--no-build` | skip the configure/build step |
| `-v` | verbose CTest output |

Naming a test by its directory is what makes a test added locally runnable
without touching any list: its CTest case is `<platform>-<app>-<variant>`.
The default run (no test name) uses the names written into `run.sh` from
`scaffold.json`, so a test is part of it when it is part of the configuration
selection. Re-run the scaffolder to change the selection; there is no separate
mapping file to edit.

`run.sh` also writes the CTest JUnit summary (`build/<configuration>/ctest.xml`),
next to the µTest++ TAP report of each run.

For Cargo and Zig, the generated `build.sh`/`test.sh` remain; they are specific
to those build systems:

```bash
./test.sh cortexm-nucleof411-cargo-debug
./test.sh cortexm-pico2-zig-debug
```

### Moving or renaming the workspace

`tests/scripts/env.sh` and `tests/run.sh` derive the workspace root from
their own location; the CMake files use the sibling paths. Renaming the top
folder therefore works without editing any file.

A build tree moved with the workspace is a special case: its
`CMakeCache.txt` keeps absolute paths. `tests/run.sh` compares
`CMAKE_CACHEFILE_DIR` and `CMAKE_HOME_DIRECTORY` with the current folders,
removes the stale tree and configures afresh, so a moved workspace builds
without a manual `clean`.

The tool paths in `tests/scripts/env.sh` remain absolute. On another
machine, re-scaffold or override them with `UOS_TOOL_<NAME>`. The
`destination` and µTest++ source path in `scaffold.json` are metadata, not
build inputs; re-scaffolding refreshes them.

## 8.4 Logs

Every verification writes:

```text
build-logs/<configuration>.configure.log
build-logs/<configuration>.build.log
```

These logs are the first place to look when a generated workspace fails to
build.

The test runs write their own files:

```text
tests/build/<configuration>/ctest.xml             CTest JUnit summary
tests/build/<configuration>/ctest.log             full CTest console output
tests/build/<configuration>/platform-bin/.../     runner build directory
  .hw-logs/<app>.tap                              complete µTest++ report (board)
  .qemu-logs/<app>.tap                            complete µTest++ report (QEMU)
  .host-logs/<app>.tap                            complete µTest++ report (host)
```

`ctest.xml` is what CI reads. CTest caps the console text it copies into each
test case at 1 KiB and says so in the XML; the `.tap` file is the complete
µTest++ report, and `ctest.log` (copied from CTest's
`Testing/Temporary/LastTest.log`) is the full console output.

---

# 9. Build-system and architecture specifics

## 9.1 CMake, C and C++ on Arm Cortex-M

The Cortex-M ports use CMake, Ninja and the Arm GNU toolchain. A platform
directory under `tests/platforms/` describes the build for one board.

Key files:

| File | Role |
| --- | --- |
| `tests/CMakeLists.txt` | Top-level harness entry point. |
| `tests/platforms/<platform>/CMakeLists.txt` | Registers the board's tests as CTest cases. |
| `tests/platforms/<platform>/cmake/definitions.cmake` | Compiler flags, defines, platform identity. |
| `port/test/boards/<board>/board.cmake` | Board facts: CPU, flags, linker scripts, UART, multicore, USB. |
| `port/test/<board>/tests.cmake` | Per-test hooks: extra sources, includes, defines, linker, CPU count. |

A board test produces one or two CTest cases:

```text
<platform>-<app>-qemu
<platform>-<app>-hwd
```

`qemu` runs in the emulator. `hwd` is loaded onto real hardware with OpenOCD.
A hardware-only board, such as the VisionFive 2 Lite, produces only `hwd`.

The board's `hw.sh` is the hardware runner. It checks that the ELF is newer
than its sources, starts OpenOCD, loads the image, runs it, captures the UART
output, and interprets the final `RESULT:` line.

**Pico 2 example.** The `cortexm-pico2` platform targets the RP2350, a
dual-core Cortex-M33. `OS_NCPU` is 2. The `smp-mat-test-ram` test includes
`../smp-mat-test/main.cpp` and uses a RAM-resident linker script; it is the
lean ARM trial workspace.

**AArch32 and AArch64.** The same CMake model applies. AArch32 boards such as
the Raspberry Pi 3 B use a board-specific source directory referenced by
`board.cmake`; that directory is retained by primitive pruning even when it
is not the selected board name. AArch64 boards use the same platform pattern
with the AArch64 toolchain.

**Native POSIX.** The native platform builds host executables with `gcc` and
`g++`. It uses libucontext for context switching. Its CTest labels are `host`,
not `hwd` or `qemu`.

## 9.2 CMake and RISC-V on the VisionFive 2 Lite

The RISC-V port targets several boards. The trial workspace uses the
StarFive VisionFive 2 Lite:

- SoC: JH-7110S;
- CPU: four SiFive U74 harts, RV64GC;
- hardware threads: `mhartid` 1..4 map to µOS++ CPUs 0..3;
- `OS_NCPU`: 4;
- image: loaded into DDR at `0x40200000`;
- debug probe: DAPLink or Raspberry Pi Pico picoprobe;
- emulator: none, because QEMU does not model the JH-7110S;
- tests: hardware-only (`hwd`).

**SMP autostart.** A test that is not self-launching gets a generated wrapper:
its `os_main()` is renamed to `vf2_test_os_main()`, and
`test/visionfive2-lite/src/smp-autostart.cpp` provides `os_main()`. That
wrapper starts CPUs 1..3 with their idle threads, verifies that each one runs
on its own hart, prints the SMP banner, and then calls the test. This is why a
simple test can use all four harts without writing launch code itself.

**Board preparation.** The generated `hw.sh` resets the board to the U-Boot
prompt before each hardware run:

```text
bash "$HERE/../../../vf2-reset-to-uboot-picoprobe.sh"
```

The path is relative to the board runner, so it works regardless of the CTest
working directory. Set `UOS_SKIP_PRE_TEST=1` to skip the reset when the board
is already in the right state. A manual helper is generated at
`tests/scripts/prepare-visionfive2-lite.sh`.

**SMP matmul example.** The local `matmul-f32-20` experiment split the 20
output rows across the four harts, pinned one worker per CPU, synchronised
with an AMO spin barrier, printed the matrix on the UART, checked
`sum(C) = 950875.008`, and ended with `RESULT: PASS`. It was removed from the
source repository because it was never tracked by git. Section 12 explains how
to add such a test properly.

## 9.3 Rust and Cargo

Rust workspaces are Cargo workspaces.

A board crate lives at `test/boards/<board>/Cargo.toml`. It provides the
`bsp` library and declares each test as an example:

```toml
[[example]]
name = "smoke"
path = "../../nucleof411/smoke/main.rs"
```

The workspace `Cargo.toml` lists the board crate as a member:

```toml
members = ["crates/*", "test/boards/nucleof411"]
```

Minimal pruning rewrites both lists:

- it removes board crates and test directories that are not selected;
- it keeps only the `[[example]]` blocks whose source directory is selected.

Lean pruning additionally:

- keeps only the port crates reachable from the selected board crate;
- removes port READMEs, PDFs and development scripts;
- removes the build `target/` directory after verification.

The hardware runner is `test/boards/<board>/hw.sh`. For the native port the
test command is `cargo test --workspace`; for a cross board it is
`cargo build -p <board> --examples --target <target>` followed by the board
runner.

## 9.4 Zig

A Zig port is driven by `build.zig`. It contains three tables:

| Table | Purpose |
| --- | --- |
| `boards` | Board id, source file, CPU count. |
| `tests` | Test name and optional special sources or flags. |
| `board_tests` | Which test lives in which board-specific directory. |

Minimal pruning rewrites those tables, removes other board sources (keeping
the selected board files and every local `.zig` helper they import, directly
or transitively) and removes other test directories. The build still uses
the same `build.zig` logic; it simply sees fewer entries.

Lean pruning additionally removes port docs, PDFs and caches, and trims the
external `extern/microzig` package to its build-essential directories.

The external dependency is recorded in `build.zig.zon`:

```zig
.dependencies = .{
    .micro_os_plus_iii = .{ .path = "../micro-os-plus-iii" },
    .microzig = .{ .path = "../extern/microzig" },
}
```

The scaffolder copies the external package under `extern/` and rewrites the
path, so the generated workspace does not depend on the original
`~/Downloads/...` location.

Build and run:

```bash
zig build -Dboard=pico2
zig build run -Dboard=pico2 -Dtest=smp-test-ko
```

## 9.5 Summary table

| Ecosystem | Build system | Kernel | Test unit | Hardware runner |
| --- | --- | --- | --- | --- |
| C/C++ | CMake + CTest | `micro-os-plus-iii-smp` | `main.cpp` in a board directory | `test/boards/<board>/hw.sh` |
| RISC-V | CMake + CTest | `micro-os-plus-iii-smp` | `main.cpp` in a board directory | `test/boards/<board>/hw.sh` |
| Rust | Cargo | `micro-os-plus-iii-rust` | Cargo example | `test/boards/<board>/hw.sh` |
| Zig | `build.zig` | `micro-os-plus-iii` | `test/.../main.zig` | `zig build run` / board script |
| Native | CMake / Cargo | host kernel | host test | direct executable / `cargo test` |

---

# 10. Minimal mode versus lean mode

## 10.1 What minimal mode keeps

Minimal mode (`--minimal`; lean is the default) keeps enough of the port to build any test on
the selected board without surprises:

- the kernel complete;
- the selected port complete for its source, headers, CMake and docs;
- the selected board and its referenced board directories;
- the selected test applications and their shared `include/` and `src/`;
- sibling sources included with `#include "../<app>/..."`;
- the selected platform and the harness suites it references;
- the required xPack libraries;
- the build tree.

## 10.2 What lean mode removes

| Area | Lean behaviour |
| --- | --- |
| Kernel | Kept complete. |
| Port docs | Removed. |
| Port PDFs and images | Removed. |
| Port package metadata | Removed. |
| Unrelated SoC families | Removed, based on `board.cmake`. |
| Unrelated include families | Removed, based on `board.cmake`. |
| Unrelated boards | Removed. |
| Unrelated tests | Removed. |
| Unrelated USB/QEMU support | Removed. |
| Harness suites | Only referenced suites are kept. |
| xPack libraries | Only required libraries are kept. |
| Toolchains in build-helper | Only the used toolchain is kept. |
| Cargo port crates | Only crates reachable from the board crate. |
| Zig MicroZig extras | Examples, design, simulation and website removed. |
| Manifest | Slim, selected entries only. |
| README | Short, test-specific. |
| Build outputs | Removed after verification. |

## 10.3 What this means in practice

A lean workspace is a **source scaffold**, not a prebuilt bundle. The first
thing to do after receiving one is:

```bash
cd tests
./run.sh build -c <configuration>
```

Then run the test. This is deliberate: the workspace stays small and every
binary is built from the recorded toolchain, not copied from another machine.

## 10.4 Measured trial workspaces

| Workspace | Selection | Test | Build | Size | Files |
| --- | --- | --- | --- | --- | --- |
| `micro-os-scaffold-workspace-minimal-arm` | `4.4.12` | `smp-mat-test-ram` | PASS | 16 MB | 451 |
| `micro-os-scaffold-workspace-minimal-riscv` | `2.4.17` | `smp-mat-test` | PASS | 16 MB | 468 |
| `micro-os-scaffold-workspace-minimal-rust` | `3.1.5` | `smoke` | PASS | 7.5 MB | 135 |
| `micro-os-scaffold-workspace-minimal-zig` | `4.3.4` | `smp-test-ko` | PASS | 18 MB | 809 |

The sizes include the complete kernel, the selected port, the external Zig
package where applicable, the scripts and the logs. They do not include the
build outputs, which lean mode removes.

---

# 11. How to use the scaffolder

## 11.1 Prerequisites

- Node.js 18 or newer.
- The toolchains for the target: Arm GNU GCC, RISC-V GNU GCC, Rust, Zig.
- CMake and Ninja for CMake workspaces.
- OpenOCD and a probe for hardware tests.
- The source workspace: the directory that contains the sibling µOS++
  repositories.

## 11.2 First run

```bash
node /path/to/micro-os-scaffold/bin/scaffold.js \
  /path/to/destination \
  --source /path/to/source-workspace \
  --select 4.4.smp-mat-test-ram \
  --yes
```

`--yes` is non-interactive. Without it, the tool prompts for a selection.

## 11.3 Lean run

```bash
node /path/to/micro-os-scaffold/bin/scaffold.js \
  /path/to/destination \
  --source /path/to/source-workspace \
  --select 2.4.smp-mat-test \
  --lean --yes
```

## 11.4 Commands

| Command | Purpose |
| --- | --- |
| `node bin/scaffold.js [dest]` | Discover, write `scaffold.json`, copy, prune, build. |
| `node bin/scaffold.js discover [--source dir]` | List architectures, boards and tests; write nothing. |
| `node bin/scaffold.js list [dest]` | Show the selected board/tests, tools and results. |
| `node bin/scaffold.js build [dest]` | Run the build verification recorded in `scaffold.json`. |
| `node bin/scaffold.js scaffold [dest]` | Explicit form of the default action. |

## 11.5 Options

| Option | Meaning |
| --- | --- |
| `--source <dir\|urls>` | Source workspace: a folder holding the sibling repositories, or a comma separated list of git URLs cloned as siblings (see 11.8). |
| `--branch <name>` | Branch to clone when `--source` is a git URL (`url#branch` sets it per repository). |
| `--select <list>` | `architecture[.board[.test]]`, names, ids, or `all`. |
| `--config <name>` | Build only this configuration (repeatable). |
| `--no-build` | Scaffold without the verification build. |
| `--list-only` | Discover and write `scaffold.json`, copy nothing. |
| `--yes` | Non-interactive; use the default selection. |
| `--lean` | Complete kernel plus only the files the selected test needs to build and run (default). |
| `--minimal` | Keeps the whole selected port; prunes only unselected boards, tests, platforms and suites. |
| `--full` | Complete harness and all boards/tests. |
| `--micro-test-plus <git-url\|folder>` | Add the µTest++ framework and the `mtp-*` starter tests (chapter 13). |
| `--micro-test-plus-ref <tag\|branch>` | What to clone when `--micro-test-plus` is a git URL. |
| `--micro-test-plus-force` | Integrate also on boards that fail the runtime rule (13.3). |
| `--no-micro-test-plus` | Drop a µTest++ integration recorded in `scaffold.json`. |
| `--help` | Usage. |
| `--version` | Print the tool version. |

Environment variables:

```text
SCAFFOLD_SOURCE   default source workspace
SCAFFOLD_SELECT   default selection
SCAFFOLD_CACHE    where git sources are cloned (default ~/.cache/micro-os-scaffold)
SCAFFOLD_DEBUG=1  print stack traces on error
SCAFFOLD_MICRO_TEST_PLUS  default for --micro-test-plus
```

The strictest layout option given wins (`--lean` over `--minimal` over
`--full`). A re-run without a layout option keeps the layout recorded in
`scaffold.json`.

## 11.8 Scaffolding from git repositories

The source workspace does not have to exist locally. Give the repositories
(the kernel and the port you need) as git URLs; they are cloned shallowly as
siblings into a cache folder and discovered as usual:

```bash
node bin/scaffold.js /path/to/destination \
  --source https://github.com/<user>/micro-os-plus-iii.git,https://github.com/<user>/micro-os-plus-iii-cortexm.git \
  --branch smp \
  --select cortexm-pico2.smp-mat-test-ram --yes
```

A single URL may also be one repository that contains every project. The
numeric selection ids depend on which repositories are present, so with a
partial clone prefer names (`cortexm-pico2.smp-mat-test-ram`) or run
`discover` with the same `--source` first. A later run updates the cached
clones; the URLs and the branch are recorded in `scaffold.json`.

## 11.6 Hardware test flow

The general flow is:

```bash
cd destination/tests
./run.sh -c <configuration> <selection-id>
```

For the VisionFive 2 Lite, `run.sh` invokes the board runner, which invokes
the reset script, starts OpenOCD, loads the ELF, runs it and prints the UART
output. To skip the reset:

```bash
UOS_SKIP_PRE_TEST=1 ./run.sh -c riscv-visionfive2-lite-cmake-gcc-debug 2.4.17
```

## 11.7 Native flow

```bash
./run.sh -c native-cmake-sys-debug 5.1.1
```

The native test runs as an ordinary host process and reports through its exit
status and stdout.

---

# 12. Extending a test application locally

This section is the practical part. It explains how to add a new test without
breaking the scaffold model.

## 12.1 The general rule

A test must exist in the **source** workspace if it is to survive a
re-scaffold. Adding a directory only in the generated workspace works until
the next scaffold run, which will treat it as material that was not selected
and remove it.

The correct workflow is:

1. add the test to the source repository;
2. register it in the build system;
3. select it by name;
4. re-scaffold;
5. build and run.

If the source repository is a git checkout, commit the test. An untracked
directory is still discovered by the filesystem scan, but it is not part of
the repository and will not be reproduced from a clean checkout.

## 12.2 CMake: adding a board test

Take a board such as `visionfive2-lite` and a test named `matmul-f32-20`.

**Step 1: create the source directory.**

```text
micro-os-plus-iii-riscv/test/visionfive2-lite/matmul-f32-20/main.cpp
```

The test must define `os_main()` and include the kernel header:

```cpp
#include <cmsis-plus/rtos/os.h>
#include <uart.hpp>
#include <hw_result.hpp>

int os_main (int, char*[])
{
  uart::write ("RESULT: PASS\n");
  hw_result::ok ();
  return 0;
}
```

For the VisionFive 2 Lite, a simple test gets SMP autostart automatically: its
`os_main()` is renamed, and the wrapper starts CPUs 1..3 before calling it. A
test that wants to launch the secondary cores itself must be listed in
`_vf2_self_launching_tests`.

**Step 2: declare per-test properties, only when needed.**

Edit `micro-os-plus-iii-riscv/test/visionfive2-lite/tests.cmake`. Most tests
need nothing. Add an entry only when the test needs extra sources, include
directories, defines, a linker script or a non-default CPU count. For
example, a test that needs an extra library:

```cmake
function (board_test_libs _app _out)
  if ("${_app}" STREQUAL "matmul-f32-20")
    set (${_out} some::library PARENT_SCOPE)
  else ()
    set (${_out} "" PARENT_SCOPE)
  endif ()
endfunction ()
```

**Step 3: no CMakeLists edit.**

The port's `test/CMakeLists.txt` globs every directory under `test/<board>/`
that contains a `.cpp`. The scaffold platform CMake also globs every test
directory and registers a `-hwd` CTest case. Adding the directory is enough.

**Step 4: add the selection.**

For a full (non-lean) CMake workspace, the simplest path is to re-run the
scaffolder with the name token:

```bash
node bin/scaffold.js <destination> \
  --source <source-root> \
  --select 2.4.matmul-f32-20 \
  --yes
```

For a manual addition to an existing `scaffold.json`, add the test to:

- the platform's `tests` array;
- `selectedTests`;
- the top-level `selections[].tests`;
- the build configuration's `tests`;
- `selectedSelections`.

`./run.sh list` shows the exact CTest name. Add the test to the configuration
selection in `scaffold.json` to run it by default (or name it directly).

**Step 5: build and run.**

```bash
cd tests
./run.sh -c riscv-visionfive2-lite-cmake-gcc-debug 2.4.matmul-f32-20
```

Expected hardware output:

```text
smp: 4 cores ... -- SMP running
matmul-f32-20 ...
sum(C) = 950875.008
RESULT: PASS
```

**Step 6: commit it.**

If the source is a git repository:

```bash
cd micro-os-plus-iii-riscv
git add test/visionfive2-lite/matmul-f32-20
git commit -m "visionfive2-lite: add matmul-f32-20 test"
```

Then re-scaffold. This is the step that prevents the “not on git” problem.

## 12.3 A genuinely SMP CMake test

A test that wants to use several CPUs should not merely run under the SMP
scheduler; it should distribute work. The matmul experiment did this:

- `N = 20`, `OS_NCPU = 4`, five rows per CPU;
- one worker thread per CPU, pinned with `cpu_affinity(1u << cpu)`;
- an AMO-based generation barrier (`amoswap.aq`) with `this_thread::yield()`;
- a per-CPU row counter, checked after the barrier;
- `RESULT: PASS` only if both the numerical result and all four row counts
  are correct.

On RISC-V, a normal C++ spinlock is not enough if the architecture does not
provide globally coherent load/store exclusives for the operation you use.
The AMO instruction is the safe primitive on the U74. On Cortex-M the port may
use a different mechanism (for example the RP2350 SIO spinlock or the SSE-200
mailbox, depending on the platform).

## 12.4 Rust: adding a test

**Step 1: create the test source.**

```text
micro-os-plus-iii-cortexm/test/nucleof411/my-test/main.rs
```

**Step 2: add an example to the board crate.**

Edit `test/boards/nucleof411/Cargo.toml`:

```toml
[[example]]
name = "my-test"
path = "../../nucleof411/my-test/main.rs"
```

**Step 3: make sure the board is a workspace member.**

The workspace `Cargo.toml` must list the board crate:

```toml
members = ["crates/*", "test/boards/nucleof411"]
```

Minimal pruning rewrites this list automatically for selected boards.

**Step 4: select and scaffold.**

```bash
node bin/scaffold.js <destination> \
  --source <rust-source-root> \
  --select 3.1.my-test \
  --lean --yes
```

**Step 5: build and run.**

```bash
cd tests
./build.sh cortexm-nucleof411-cargo-debug
./test.sh cortexm-nucleof411-cargo-debug
```

For the native Rust port, the test is a normal Cargo test and is run with
`cargo test --workspace`.

## 12.5 Zig: adding a test

**Step 1: create the test source.**

For a board-specific test on the Pico 2:

```text
micro-os-plus-iii-cortexm/test/pico2/my-test/main.zig
```

For a portable test:

```text
micro-os-plus-iii-cortexm/test/my-test/main.zig
```

**Step 2: register it in `build.zig`.**

Add an entry to the `tests` table:

```zig
.{ .name = "my-test" },
```

If the test lives in a board-specific directory, also add a `board_tests`
entry:

```zig
.{ .board = .pico2, .name = "my-test" },
```

If it needs special C sources or flags, add them to the `Test` entry, as the
existing `rtos-apis` test does.

**Step 3: select and scaffold.**

```bash
node bin/scaffold.js <destination> \
  --source <zig-source-root> \
  --select 4.3.my-test \
  --lean --yes
```

**Step 4: build and run.**

```bash
cd tests
./build.sh cortexm-pico2-zig-debug
./test.sh cortexm-pico2-zig-debug
```

Or directly:

```bash
zig build -Dboard=pico2
zig build run -Dboard=pico2 -Dtest=my-test
```

## 12.6 Extending in a lean workspace

The `README.md` generated in a lean workspace contains a complete, concrete
guide ("Adding new functionality to this workspace") written with the real
names of the selected port, board, platform, configuration and test, and with
the hooks that port's builder actually offers. It covers:

- which CMake file picks up each kind of file (globbed or explicit);
- adding a source or header to the test, a C/assembly file through
  `board_test_sources()`, shared board-test code and board glue;
- per-test definitions, options, linker script and CPU count;
- adding a library: an INTERFACE target of your own sources, a pre-built
  archive, an optional kernel component, a harness suite or xPack;
- adding a new test directory and the CTest case it produces;
- what each build/run script does and when to edit it.

Lean workspaces remove the build tree; `run.sh` rebuilds it:

```bash
cd tests
./run.sh -c <configuration> <test-directory-name>
```

A board whose selected test is hardware-only is copied without its QEMU
support; a new test must then be listed in `BOARD_TEST_HWD_ONLY`.

Do not edit files in `tests/build`, `target`, `zig-out` or `zig-pkg`: they are
generated and removed by the next lean run.

Re-running the scaffolder removes every test directory that is not selected,
including the ones added locally. If the change must survive regeneration,
copy it to the source repository first.

---

# 13. µTest++ tests (`--micro-test-plus`)

µTest++ (`micro-test-plus`, <https://github.com/micro-os-plus/micro-test-plus-xpack>,
documentation at <https://micro-os-plus.github.io/micro-test-plus-xpack/>) is the
µOS++ unit-test framework: a runner, suites, test cases, `expect` checks, and a TAP
report. `--micro-test-plus` adds it to a scaffolded workspace, so that tests written
with it build, run and report through the same CMake/CTest harness as every other
test.

```bash
# From a folder (an npm/xpm install, or a checkout)
node bin/scaffold.js /path/to/destination --select cortexm-pico2.smp-mat-test \
  --micro-test-plus ~/xpacks/micro-test-plus --yes

# From git, at a tag
node bin/scaffold.js /path/to/destination --select aarch64-rpi-zero-2w.smp-mat-test \
  --micro-test-plus https://github.com/micro-os-plus/micro-test-plus-xpack.git \
  --micro-test-plus-ref v6.0.0 --yes
```

The option is recorded in `scaffold.json` (`microTestPlus`) and kept by later runs;
`--no-micro-test-plus` removes it.

## 13.1 How the reference workspace does it

The design follows the hand-made integration in
`micro-os-scaffold-workspace-rpi-zero-2w` (a lean `aarch64-rpi-zero-2w` workspace
with four µTest++ tests: `mtp-rtos`, `mtp-smp`, `mtp-sdcard`, `mtp-wifi`, 243
checks, all passing on the board). Its parts are:

| Part | Where | Role |
| --- | --- | --- |
| The framework | `third_party/micro-test-plus/` | µTest++ 6.0.0, unchanged: `include/`, `src/` |
| Board support | `<port>/test/mtp/` | `mtp_board.*` (runner, static suites, console, RESULT line, cores, report file), `mtp_semihosting.hpp`, `mtp_startup.hpp` |
| CMake | `<port>/test/rpi-zero-2w/tests.cmake` | an INTERFACE library with the framework sources, the board support and the defines; one branch in `board_test_libs` links it to every `mtp-*` test |
| Tests | `<port>/test/rpi-zero-2w/mtp-*/` | ordinary test directories: globbed, built, registered as `<platform>-mtp-<name>-qemu\|hwd` |

A µTest++ test then runs like any other:

1. **Build and registration.** The port's builder globs the test directory and makes
   its images; nothing in CMake names the test.
2. **Start-up and arguments.** The boot code clears `.bss`, hands the linker heap to
   the µOS++ free store, runs the static constructors (the static suites register
   themselves), then calls `os_main (argc, argv)`. The command line comes from
   semihosting: OpenOCD `arm semihosting_cmdline <app> ...`, QEMU
   `-semihosting-config ...,arg=<app>,arg=...`; the host passes its process arguments.
3. **The run.** `os_main ()` calls `mtp_board::start ()` (routes stdout), optionally
   `release_cores ()`, then `mtp_board::run (argc, argv)`, which initialises the runner,
   runs the static suites, and prints `RESULT: PASS|FAIL (...)` and signals the verdict.
   There is no `add_suite` list: each suite file registers itself with a
   `mt::static_suite` at namespace scope.
4. **The report.** µTest++ prints TAP on stdout. The board support sends it to the UART
   at once and to the host through semihosting `SYS_WRITE0`, batched per suite: every
   semihosting call halts the cores while the debugger serves it. The complete report is
   also written to a file through semihosting (the runner passes
   `--output-file <path>` in the debugger command line), and `run.sh` writes the CTest
   JUnit summary. `run-hw.sh` (OpenOCD) or `run-qemu.sh` collects the console text and
   looks for `RESULT: PASS`.

Lessons from that integration, now built into the scaffolder:

- the build is strict C++20, which hides `fopencookie ()` and `sbrk ()`: `_GNU_SOURCE`;
- newlib has no `CLOCK_MONOTONIC`: no µTest++ timings;
- µTest++ opens the report file with `fopen ()`; the support wraps it (`-Wl,--wrap=fopen`) over the semihosting file calls, so no board needs `_open ()`;
- QEMU drops semihosting `SYS_WRITE` on handle 1: the support uses `SYS_WRITE0`;
- the build has no exceptions: tests use `expect`, never `require`;
- µTest++ compares `const char*` as C strings: compare addresses as `std::uintptr_t`
  (a pointer comparison once read the heap as a string and took six minutes on the board);
- newlib's stdio needs `_write`, `_read`, `_close`, `_fstat`, `_isatty`, `_lseek`: the
  AArch64 port defines them (`src/handlers.cpp`), the AArch32 port does not, so the board
  support provides weak ones for console model 1 (`_write` to the same console).

## 13.2 What the scaffolder adds

| Added | Where |
| --- | --- |
| The framework, unchanged | `third_party/micro-test-plus/` (from the folder, or a clone cached in `~/.cache/micro-os-scaffold/micro-test-plus/<sha>`) |
| Board support, per port | `<port>/test/mtp/`: `mtp_board.hpp`, `mtp_board.cpp`, `mtp_semihosting.hpp`, `mtp_startup.hpp`, `README.md` |
| A µTest++ block | at the end of `<port>/test/<board>/tests.cmake`, plus one `^mtp-` branch in its library hook |
| `mtp-example` | every integrated board: "00 - Cores" (if the cores can be released), "01 - Runtime", "02 - Basics" |
| `mtp-args` | every integrated board: "00 - Arguments", the semihosting `argc`/`argv` check (13.5) |
| `mtp-smp` | the boards whose other cores the support can start (13.5) |
| `mtp-eth-net` | the boards with the GENET v5 + BCM54213PE + lwIP Ethernet stack in `test/boards/<board>/net/src/` (`<platform>-eth`, `BOARD_TEST_NEED_DEVICES`) |
| Selection | the starter tests are added to the configuration, so `tests/run.sh` runs them by default |
| Documentation | a "µTest++ tests" section in the workspace `README.md` |

The block defines what the board support needs to know:

| Define | Meaning |
| --- | --- |
| `MTP_CONSOLE=1\|2\|3` | the console model (13.4) |
| `MTP_HAS_SMP_BOOT=0\|1\|2` | how to release the other cores: none, the port's test-smp-boot helpers, or `multicore::launch_core1` (RP2040/RP2350) |
| `MTP_NANO_PRINTF=1` | the port links newlib-nano (13.4) |
| `MTP_UART_INIT=1` | the board's start-up leaves the UART off and its tests switch it on (13.4) |
| `MTP_CARRY_STARTUP=1` | the tests carry their own start-up (`mtp_startup.hpp`) |
| `MTP_HOSTED` | POSIX native: no linker heap |

A board whose QEMU image replaces the board (`board_test_qemu_libs` in `tests.cmake`,
as on the Pico 2, which runs a generic single-core Cortex-M33 under QEMU) gets its
`mtp-*` tests on hardware only: the runtime rule was checked on the board.

## 13.3 The runtime rule

Every board that runs µTest++ must have a boot phase that runs the static
constructors, and a heap that `malloc`/`new` and `sbrk` use, defined by the linker
script. The scaffolder checks it in the sources before it integrates a board:

- the linker script keeps `.init_array` between `__init_array_start` and `__init_array_end`;
- the linker script defines `_Heap_Begin` and `_Heap_Limit`;
- the boot code calls `__libc_init_array` or `os_run_init_array`;
- the start-up calls `os_startup_initialize_free_store` (or the tests carry their own start-up);
- `_sbrk` works over `_Heap_Limit`.

The evidence (file and line) goes to `scaffold.json` and to the workspace README.
A board that fails is reported `rule-not-met` and left out;
`--micro-test-plus-force` integrates it anyway. On the target, `mtp-example` checks
the same at run time ("01 - Runtime": `.data`/`.bss`, constructor order with
`init_priority`, allocation inside `_Heap_Begin .. _Heap_Limit`, `sbrk`).

## 13.4 Console models

| Model | Ports | stdout goes |
| --- | --- | --- |
| 1 | AArch32, AArch64 | a `fopencookie` stream: UART at once (`uart1.putc_uart`), host by batched `SYS_WRITE0` |
| 2 | Cortex-M | a strong `_write ()` replacing the port's weak stub: `uart::write`, host by `hw_result::semi_write0` |
| 3 | POSIX native | the host's stdout |

Cortex-M links newlib-nano, whose printf has no `z` modifier: µTest++'s `%zu` printed
`zu` and ate no argument (`ok zu - ...`). With `MTP_NANO_PRINTF=1` the block links the
printf family through wrappers (`-Wl,--wrap=printf,...`) that drop the `z` (`size_t`
is `unsigned int` there), and links `-u _printf_float` for the `approx ()` messages.
The framework stays unchanged.

The UART must be on before the first write. The RP2040/RP2350 glue switches it on at
start-up; the STM32 boards (nucleof411, weactf411, weactf412) leave USART2 off and each
test calls `uart::init (board::UART_BAUD)`. The scaffolder recognises those boards
(`board.hpp` defines `UART_BAUD`, `uart.hpp` declares `init (std::uint32_t)`) and sets
`MTP_UART_INIT=1`, so that `mtp_board::start ()` does the same. Without it the first
`uart::write ()` waits for TXE on a disabled USART for ever: the board boots to `main ()`
and then prints nothing.

### The command line: `mtp-args`

The command line reaches the image through semihosting, and the generated runner always
passes the test name and the report path:

```text
arm semihosting_cmdline <app> --output-file <path>       (OpenOCD)
-semihosting-config ...,arg=<app>,arg=--output-file,arg=<path>   (QEMU)
<app> --output-file <path>                               (host process arguments)
```

`mtp-args` is the CTest case for that transport. `main.cpp` records `argc`/`argv` as
`os_main ()` receives them, and its one suite (`suite-args.cpp`) checks:

- `argc >= 3` — the program name, `--output-file`, and its value;
- `argv[0]` names the test (`mtp-args`);
- `argv[1]` is `--output-file`;
- `argv[2]` ends in `.tap`;
- `mtp_board::argument_count()` parsed the same count.

A runner that drops the command line fails this case instead of silently running the
test with an empty `argv`. The test is a normal `mtp-*` directory with a single
`mt::static_suite`, and is added to every µTest++ board.

## 13.5 SMP tests: `mtp-smp`

`release_cores ()` pins the runner to core 0, starts the other cores and waits for them
to join the scheduler:

- `MTP_HAS_SMP_BOOT=1`: the port's helpers (`smp_install_boot_threads`,
  `smp::start_secondary_cores`, `test_wait_secondaries`);
- `MTP_HAS_SMP_BOOT=2`: on the RP2040/RP2350 core 1 does not start at boot; the support
  registers its idle thread (`os_idle_thread_core[1]`), calls
  `multicore::launch_core1 (port_smp_secondary_start, port_core1_stack_top ())` and
  then `port_smp_core0_ipi_enable ()`, as the board's `smp-mat-test` does. Without it a
  pico2 test links the SMP kernel (`NCPU=2`) and runs on core 0 alone.

`mtp-smp` is written for `OS_NCPU` cores:

| Suite | Checks |
| --- | --- |
| 00 Cores | the other cores joined |
| 01 Affinity | pinned threads stay on their core; affinity changes at run time |
| 02 Critical sections | `interrupts::critical_section` excludes every core, masks, nests, restores; a core waits while another holds the kernel lock; `scheduler::critical_section` holds off switches on its core and not on the others |
| 03 Spinlocks | no lost update from every core; `try_lock` refused while another core holds it |
| 04 Mutexes | contention, `try_lock`/`timed_lock` against another core, recursive, priority inheritance across cores |
| 05 Scheduler | preemption, `yield`, `sleep_for` on every core, load spread |
| 06 Cross-core sync | semaphore ping-pong, ordered message queue, event flags, a 200-round barrier |
| 07 Queue stress | one producer per core into one bounded queue |
| 08 Atomic read-modify-write | `mtp_board::atomic_add ()` from every core; `std::atomic` where the hardware supports it |
| 09 Speed-up | the same CPU-bound work on one core, then on every core at once; at least 0.8 x `OS_NCPU` faster on the board (reported only under QEMU) |

Cross-core read-modify-write goes through each board's own method,
`mtp_board::sync_method ()`, printed at the start of the report:

| Board | Method | Instructions |
| --- | --- | --- |
| Raspberry Pi (AArch64) | exclusive monitor | `LDAXR`/`STLXR`, inline (`no-outline-atomics`: GCC would otherwise call libgcc's `__aarch64_ldadd4_acq_rel`, which picks LSE or LDAXR at run time) |
| AArch32 (ARMv8 core) | exclusive monitor | `LDAEX`/`STLEX` for `atomic_add ()` and the spinlock, `LDREX`/`STREX` for plain `std::atomic` |
| RP2040/RP2350 | SIO hardware spinlocks | 8..30 for `mtp_board::spinlock`, 31 for `atomic_add ()`; 0 is the kernel's, 1 the console's, 2-3 `smp-mat-test`'s |

On the RP2350 `LDREX`/`STREX` exclude only the same core: `std::atomic::fetch_add`
from both cores kept 51547 of 100000 increments. `std::atomic` read-modify-write is
therefore not checked there, and must not be shared between its cores.

Two port differences the tests respect:

- On the RP2350 `scheduler::critical_section` masks this core's interrupts and takes
  the kernel spinlock; on AArch64 it only marks the core locked. Inside it the clock
  may stand still, so a test bounds such waits by iterations, never by `sysclock`.
- `scheduler::critical_section` is per core on both: another core keeps running.

Suite 09 answers "is it really SMP" with a number. A work unit (integer arithmetic in
registers: no shared memory, no lock, no kernel call) is calibrated to at least 100 ms
on one core; one thread pinned to one core does `OS_NCPU` units, then one thread per
core does one unit each, at once. The ratio of the two times is the speed-up: about
`OS_NCPU` when the cores really run in parallel, about 1 when they do not. Other
suites prove parallelism by construction: a pinned thread reads its core from MPIDR;
core 1 runs while core 0 holds its scheduler lock, or spins with its interrupts masked
on the kernel lock.

## 13.6 Measured

| Board | Test | Result |
| --- | --- | --- |
| Raspberry Pi Zero 2 W, AArch64, 4 cores (A53) | `mtp-example` | 27/27, board (110 ms on target) |
| | `mtp-smp` (LDAXR/STLXR) with 09 Speed-up | 78/78, board, 50 s; **3.86x** (1 core 672 ms, 4 cores 174 ms) |
| Raspberry Pi Zero 2 W, AArch32, 4 cores (A53) | `mtp-example` | 27/27, board (110 ms on target) |
| | `mtp-smp` (LDAEX/STLEX) with 09 Speed-up | 78/78, board, 55 s; **3.91x** (1 core 673 ms, 4 cores 172 ms) |
| Raspberry Pi 4 B, AArch64, 4 cores (A72) | `mtp-example` | 27/27, board (102 ms on target) |
| | `mtp-smp` (LDAXR/STLXR) with 09 Speed-up | 78/78, board, 38 s; **3.86x** (1 core 718 ms, 4 cores 186 ms); 3.72–3.90x under QEMU (host-dependent) |
| | `mtp-eth-net` (GENET v5 + BCM54213PE + lwIP) | 25/25, board, 38 s (10.1 s on target; 1000 Mbit/s full duplex, DHCP lease, 4/4 56 B + 2/2 256 B ICMP replies, 0 DMA errors, `tests/MTPNET.LOG` on SD card) |
| | `eth-net` (classic GENET v5 + lwIP, no µTest++) | PASS, board, 24 s (`tests/ETHNET.LOG` on SD card) |
| Raspberry Pi Pico 2, RP2350, 2 cores (M33) | `mtp-example` | 27/27, board, 8 s (95 ms on target) |
| | `mtp-smp` (SIO) with 09 Speed-up | 71/71, board, 8 s (1735 ms on target); **1.77x** (1 core 450 ms, 2 cores 254 ms) |
| ST NUCLEO-F411RE, Cortex-M4, 1 core | `mtp-example` | 24/24, board (ST-LINK/V2-1), 11 s (115 ms on target) |
| WeAct F411CE, Cortex-M4, 1 core | `mtp-example` | 24/24, board (WCH-Link), 20 s (90 ms on target) |
| | `mtp-spi-flash` (board-specific, 13.8) | 52/52, board, 24 s (3988 ms on target); W25Q128: polled 1398, IRQ 759, DMA 2206 KiB/s |
| | the same flash as 5 classic tests, no µTest++ (13.8) | 5/5, board, 10-13 s each |

## 13.7 Running, and two probes on one host

```bash
cd destination/tests
./run.sh -c <configuration> mtp-example mtp-args mtp-smp             # QEMU (or host) images
./run.sh -c <configuration> mtp-example mtp-args mtp-smp --hwd       # on the board
```

The Raspberry Pi boards' OpenOCD config defaults to a J-Link; with the CMSIS-DAP JTAG
probe say `PROBE=cmsis-dap`. Two probes of the same USB id on one host (a JTAG probe
for a Raspberry Pi and a Debug Probe for a Pico 2, both `2e8a:000c`) need one to be
named: point `OPENOCD` at a wrapper that adds `adapter serial <serial>`
(`cat /sys/bus/usb/devices/*/serial`), placed so that
`$(dirname $OPENOCD)/../openocd/scripts` is OpenOCD's scripts tree:

```sh
#!/bin/sh
exec /path/to/xpack-openocd/bin/openocd -c "adapter serial E46268C3571E0D36" "$@"
```

## 13.8 Adding a µTest++ test

Copy a starter test to `mtp-<name>` and edit it; no CMake file changes. One suite per
source file, registered by a namespace-scope `mt::static_suite`:

```cpp
mt::static_suite suite_basics{ "02 - Basics", mtp_board::runner (),
                               [] (mt::suite& ts) { ... } };
```

The runner discovers the static suites and runs them sorted by name; `main.cpp` only
calls `start ()`, the optional `release_cores ()`, and `run (argc, argv)`. Use
`t.expect`, compare
kernel results with `mtp::ok` or `mtp::code (EWOULDBLOCK)`, end a QEMU image that needs
the hardware with `return mtp_board::skip ("why");`, and pin threads to core 0 when a
check depends on one core. For data shared between cores use the kernel,
`mtp_board::spinlock` or `mtp_board::atomic_add ()`.

A test can also be written for one board's own hardware. `examples/cortexm-weactf411-mtp-spi-flash/`
tests the WeAct F411CE's SPI NOR flash (W25Q128) through the board's drivers: JEDEC ID,
erase/program/read and NOR rules, the same data through polled, IRQ and DMA, flatfs, and two
threads sharing the bus under a mutex. Rules that came out of it:

- touch only a scratch area the board's other tests do not use (here the top 64 KiB of the
  part, computed from the JEDEC size);
- a driver that falls back silently (a transport whose completion never arrives is timed out
  and redone polled) passes a data check; give each path a rate floor and check it is still
  the active one;
- reproduce what the driver's own set-up does before forcing a path (`spi::probe ()` keeps
  DMA and leaves SPI1's interrupt masked; the IRQ path needs it unmasked);
- add the test to the configuration selection (`scaffold.json`) to run it by default,
  and keep a copy in the source repository: a re-scaffold removes it.

The same checks can be written without µTest++. `examples/cortexm-weactf411-flash-battery/`
splits them into five classic tests (`flash-id`, `flash-raw`, `flash-transports`,
`flash-flatfs`, `flash-threads`): each its own `os_main`, one numbered `ok`/`FAIL` line per
check on the UART, `RESULT: PASS|FAIL` through `hw_result`, and one shared header-only helper
in the board's test `include/` (so the board's other tests link nothing new). The trade-off:
no framework and one CTest case per area, but a plain report instead of TAP, and only the
verdict reaches the runner's log; the per-check lines are on the UART.

On boards that carry the GENET v5 + BCM54213PE + lwIP Ethernet stack in
`test/boards/<board>/net/src/` (such as the Raspberry Pi 4 B), the scaffolder also adds
`mtp-eth-net` (`templates/micro-test-plus/mtp-eth-net/`), links it against
`uos-micro-test-plus` and `<platform>-eth`, and adds it to `BOARD_TEST_NEED_DEVICES`. Its five
suites (10 test cases, 25 checks) verify SMP core release, GENET v5 MAC/PHY/ring initialisation
(`0x600d84a2` BCM54213PE), Gigabit link auto-negotiation and lwIP DHCPv4 lease acquisition,
56 B and 256 B ICMP echo rounds to the gateway with zero DMA errors, and FAT32 SD card logging
(`tests/MTPNET.LOG`), while skipping cleanly under QEMU (`!HW_BUILD`).

---

# 14. Rules, invariants and design philosophy

## 14.1 Source repositories are read-only

The scaffolder reads the source root and writes only to the destination. It
does not commit, format, patch or delete source files. The generated
workspace may contain patched copies (for example, a harness path adapted to
the sibling layout), but the originals are untouched.

## 14.2 The kernel is complete

The kernel is the interface. Keeping it complete means:

- every public header is available;
- the documentation and configuration examples remain;
- a test can be written, compiled and debugged without guessing which parts
  of the kernel were removed.

## 14.3 The port is selected, not exhaustive

The port contains support for several boards and SoCs. The scaffolder keeps
the selected board and the source/SoC/include families it actually names. It
does not keep every board “just in case”.

## 14.4 Tests are named, not globbed

A selected test is copied because it was selected, not because it happened to
be in a directory. Sibling sources pulled in with `#include "../<app>/..."`
are kept as helpers and excluded from the test build, so a helper does not
become an accidental second test.

## 14.5 Every scaffold is build-verified

A workspace that cannot build is not useful. The tool runs the real build and
records the result before declaring success.

## 14.6 Reproducibility comes from the manifest

`scaffold.json` records the selection, the tool paths and the configuration.
Re-running the same command recreates the same workspace, even if the current
shell environment changes.

## 14.7 Selection ids are convenient, names are stable

Numeric ids are short and readable, but they are assigned alphabetically. A
new test shifts later ids. Use `architecture.board.<app-name>` in scripts and
documentation.

---

# 15. Troubleshooting

| Symptom | Likely cause | What to do |
| --- | --- | --- |
| `Could not find toolchain file` | The selected toolchain was not copied or the build-helper was over-pruned. | Re-run the scaffolder without `--lean`; check `tests/xpacks/@micro-os-plus/build-helper/cmake/toolchains/`. |
| `CMAKE_C_COMPILER not set` | The toolchain file is missing or the compiler path is wrong. | Check `tests/scripts/env.sh` and the `tools` section of `scaffold.json`. |
| `ninja: error: ... missing and no known rule to make it` | A board source directory or linker script was pruned. | Re-run with `--minimal`; check the selected board's `board.cmake` references. |
| `missing compiler` during `build` | The slim manifest lost the compiler entries. | Re-scaffold (not just `build`) so tool detection runs again. |
| CTest lists no tests | The build tree was removed (lean mode) or the test is not registered. | Run `tests/run.sh list`; re-run the scaffolder if the selection is wrong. |
| Hardware test fails immediately | The board is not at the U-Boot prompt, no probe, or no UART device. | Check the probe and `/dev/ttyUSB*`; run the reset script; use `UOS_SKIP_PRE_TEST=1` only when appropriate. |
| `vf2-reset-to-uboot: no such serial device` | The USB-UART is not connected. | Connect it or adjust `PROBE_TTY`/the reset script. |
| Selection resolves to the wrong test | Numeric ids shifted after a new test was added. | Use the app-name token, for example `2.4.smp-mat-test`. |
| A test disappears after re-scaffolding | It exists only in the generated workspace. | Add it to the source repository, register it, commit it, then re-scaffold. |
| Zig rebuild is slow after lean cleanup | `zig-pkg` and `.zig-cache` were removed. | Expected; the first build repopulates them. |
| Cargo rebuild is slow after lean cleanup | `target/` was removed. | Expected; the first build repopulates it. |

---

# 16. The current trial workspaces

The four trial workspaces were generated to validate the lean design.

## 16.1 Arm Cortex-M

```text
/home/dan/Work/micro-os-scaffold-workspace-minimal-arm
```

- selection: `4.4.12`
- test: `cortexm-pico2/smp-mat-test-ram`
- build: `cortexm-pico2-cmake-gcc-debug`, PASS
- size: 16 MB, 451 files
- test: SMP matrix solver running entirely in SRAM on the RP2350.

Regenerate:

```bash
node /home/dan/Work/micro-os-scaffold/bin/scaffold.js \
  /home/dan/Work/micro-os-scaffold-workspace-minimal-arm \
  --source /home/dan/Desktop/micro-os-plu-iii-smp-pr-github \
  --select 4.4.smp-mat-test-ram \
  --lean --yes
```

## 16.2 RISC-V VisionFive 2 Lite

```text
/home/dan/Work/micro-os-scaffold-workspace-minimal-riscv
```

- selection: `2.4.17`
- test: `riscv-visionfive2-lite/smp-mat-test`
- build: `riscv-visionfive2-lite-cmake-gcc-debug`, PASS
- size: 16 MB, 468 files
- test: parallel block linear solver on four U74 harts.

Regenerate:

```bash
node /home/dan/Work/micro-os-scaffold/bin/scaffold.js \
  /home/dan/Work/micro-os-scaffold-workspace-minimal-riscv \
  --source /home/dan/Desktop/micro-os-plu-iii-smp-riscv-pr-github \
  --select 2.4.smp-mat-test \
  --lean --yes
```

## 16.3 Rust Cortex-M

```text
/home/dan/Work/micro-os-scaffold-workspace-minimal-rust
```

- selection: `3.1.5`
- test: `cortexm-nucleof411/smoke`
- build: `cortexm-nucleof411-cargo-debug`, PASS
- size: 7.5 MB, 135 files
- test: the board smoke test as a Cargo example.

Regenerate:

```bash
node /home/dan/Work/micro-os-scaffold/bin/scaffold.js \
  /home/dan/Work/micro-os-scaffold-workspace-minimal-rust \
  --source /home/dan/Desktop/micro-os-plu-iii-smp-rust-pr-github \
  --select 3.1.smoke \
  --lean --yes
```

## 16.4 Zig Cortex-M

```text
/home/dan/Work/micro-os-scaffold-workspace-minimal-zig
```

- selection: `4.3.4`
- test: `cortexm-pico2/smp-test-ko`
- build: `cortexm-pico2-zig-debug`, PASS
- size: 18 MB, 809 files
- test: the SMP test-ko application as a Zig test.

Regenerate:

```bash
node /home/dan/Work/micro-os-scaffold/bin/scaffold.js \
  /home/dan/Work/micro-os-scaffold-workspace-minimal-zig \
  --source /home/dan/Desktop/micro-os-plu-iii-smp-zig-pr-github \
  --select 4.3.smp-test-ko \
  --lean --yes
```

## 16.5 What the trials prove

- CMake pruning survives a Cortex-M build and a RISC-V build.
- Cargo pruning survives a cross-target build.
- Zig pruning survives a board build with an external package.
- Lean manifests and READMEs are generated for all three build systems.
- Build outputs can be removed after verification without breaking the
  ability to rebuild from source.

---

# 17. Limitations and future work

- **Hardware availability.** The tool can build a hardware test without a
  board, but it cannot run it. The trial workspaces were built and verified;
  hardware execution depends on the probe and the UART being present.
- **VisionFive 2 Lite is hardware-only.** QEMU does not model the JH-7110S.
- **Zig external package.** The generated workspace carries
  `extern/microzig`. It is trimmed, but it is still a real dependency with its
  own files. A future version could make the external package a link instead
  of a copy.
- **Selection id stability.** Numeric ids are alphabetical and therefore
  sensitive to new test directories. Name tokens are the stable form.
- **Lean build outputs.** Lean removes build trees. A user who wants an
  immediately runnable binary should use `--minimal` or rebuild.
- **Source test provenance.** The tool discovers files on disk, including
  untracked files. A test that is only present locally will be scaffolded,
  but it will not survive a clean checkout. Commit tests that matter.
- **µTest++ coverage.** `--micro-test-plus` was verified on the Zero 2 W
  and Pi 4 B (AArch64), the Zero 2 W (AArch32), the Pico 2 (RP2350), the
  NUCLEO-F411 and the WeAct F411CE (Cortex-M4), on the boards, including
  Suite 09 (speed-up) across all four SMP configurations and `mtp-eth-net` on
  the Pi 4 B. The other ports' boards are integrated by the same rules but not
  yet run. Probe selection by serial number is a wrapper (13.7), not yet an
  option of the runner.

---

# 18. Glossary

| Term | Definition |
| --- | --- |
| **AMO** | RISC-V atomic memory operation, used for spinlocks and barriers. |
| **BSP** | Board support package. |
| **CMake** | Build-system generator used by the C/C++ and RISC-V ports. |
| **CTest** | CMake's test runner. |
| **ELF** | Executable and Linkable Format: the image loaded on the target. |
| **HAL** | Hardware abstraction layer. |
| **HART** | RISC-V hardware thread. |
| **JTAG** | Debug interface used by OpenOCD. |
| **Lean mode** | Strict test-only scaffold produced by `--lean`. |
| **Minimal mode** | Default reduced scaffold. |
| **OpenOCD** | Open On-Chip Debugger. |
| **Platform** | Port plus board, as seen by the build. |
| **Port** | Architecture-specific µOS++ layer. |
| **QEMU** | Emulator. |
| **SMP** | Symmetric multiprocessing. |
| **SWD** | Serial Wire Debug, an Arm debug interface. |
| **UART** | Serial console. |
| **xPack** | A packaged tool or library used by the build. |
| **Zig** | Language and build system used by the Zig port. |

---

# 19. Appendix A: typical lean layouts

## 19.1 CMake lean workspace

```text
destination/
  README.md
  scaffold.json
  .scaffold-manifest.json
  build-logs/
  micro-os-plus-iii-smp/          kernel, complete
  micro-os-plus-iii-riscv/        selected port
    CMakeLists.txt
    cmake/
    include/
    src/
    qemu/                         referenced by the port CMake
    test/
      boards/visionfive2-lite/
      visionfive2-lite/
        include/
        src/
        tests.cmake
        smp-mat-test/
    vf2-reset-to-uboot-picoprobe.sh
    jh7110_picoprobe.cfg ...
  tests/
    CMakeLists.txt
    cmake/
    platforms/riscv-visionfive2-lite/
    scripts/
    xpacks/@micro-os-plus/build-helper/
```

## 19.2 Cargo lean workspace

```text
destination/
  README.md
  scaffold.json
  micro-os-plus-iii-rust/         kernel
  micro-os-plus-iii-cortexm/      selected port
    Cargo.toml
    Cargo.lock
    rust-toolchain.toml
    crates/uos-port-cortexm/
    test/boards/nucleof411/
    test/nucleof411/smoke/
  tests/
    build.sh
    test.sh
    scripts/env.sh
```

## 19.3 Zig lean workspace

```text
destination/
  README.md
  scaffold.json
  micro-os-plus-iii/              kernel
  micro-os-plus-iii-cortexm/      selected port
    build.zig
    build.zig.zon
    src/boards/pico2.zig
    test/pico2/smp-test-ko/
  extern/microzig/                trimmed external package
  tests/
    build.sh
    test.sh
    scripts/env.sh
```

---

# 20. Appendix B: command cheat sheet

```bash
# Discover the source workspace
node bin/scaffold.js discover --source /path/to/source

# Normal minimal workspace
node bin/scaffold.js /path/to/dest \
  --source /path/to/source --select 4.4.12 --yes

# Lean workspace
node bin/scaffold.js /path/to/dest \
  --source /path/to/source --select 4.4.smp-mat-test-ram --lean --yes

# Full workspace
node bin/scaffold.js /path/to/dest \
  --source /path/to/source --select all --full --yes

# Show what was selected
node bin/scaffold.js list /path/to/dest

# Rebuild the recorded configurations
node bin/scaffold.js build /path/to/dest

# Build and run one CMake test
cd /path/to/dest/tests
./run.sh -c riscv-visionfive2-lite-cmake-gcc-debug 2.4.17

# Build and run one Cargo test
cd /path/to/dest/tests
./build.sh cortexm-nucleof411-cargo-debug
./test.sh cortexm-nucleof411-cargo-debug

# Build and run one Zig test
cd /path/to/dest/tests
./build.sh cortexm-pico2-zig-debug
./test.sh cortexm-pico2-zig-debug

# Skip the VisionFive 2 reset
UOS_SKIP_PRE_TEST=1 ./run.sh -c riscv-visionfive2-lite-cmake-gcc-debug 2.4.17
```

---

*End of document.*
