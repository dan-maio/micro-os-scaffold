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
13. Rules, invariants and design philosophy
14. Troubleshooting
15. The current trial workspaces
16. Limitations and future work
17. Glossary
18. Appendix A: typical lean layouts
19. Appendix B: command cheat sheet

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
| `--minimal` (default) | Copies the kernel and port, plus only the selected board, platform, test applications, harness suites and xPack libraries. Keeps the build tree. |
| `--full` | Copies the complete harness, every platform, every board and every test. Useful for exploring a port, not for focused work. |
| `--lean` | Strict test-only layout for CMake, Cargo and Zig. Keeps the kernel complete, keeps only build/run-essential port files, writes a slim manifest and a short README, and removes build caches after verification. |

The most important invariant is simple: **the source repositories are read
only**. The tool discovers and copies; it never edits the source. Everything
new is written under the destination.

The second invariant is also simple: **the kernel is copied complete**. The
kernel is the interface that every test is written against. Its headers,
sources, configuration and documentation stay available. The reduction is
applied to the port, the board support, the harness and the selected tests,
not to the kernel.

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
`scaffold.json`, and `tests/build.sh` and `tests/test.sh` are generated from
the same configuration.

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
tests/build.sh
tests/test.sh
tests/scripts/selected-tests.txt   (CMake)
```

It also copies or generates the runner helpers and the CTest registration.

## Step 9 — Apply minimal pruning

This is the ordinary reduction:

- other boards are removed;
- other test applications are removed;
- other platforms are removed;
- unused harness suites and xPack libraries are removed;
- unused QEMU device support is removed;
- unused integration files and documentation are removed;
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
  simulation and website trees;
- top-level `docs/`, `test_smpl/` and `integration/` are removed;
- the manifest is rewritten in slim form;
- the README is rewritten as a short test-specific page.

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
and logs, but not a prebuilt binary. Run `tests/build.sh` before
`tests/test.sh`.

---

# 8. The generated scripts

## 8.1 `tests/scripts/env.sh`

This file exports the absolute tool paths from `scaffold.json` and sets up the
library paths needed by the build. It is sourced by the other scripts. It is
the reason a generated workspace can be moved to another shell and still use
the same toolchain.

## 8.2 `tests/build.sh`

For CMake:

```bash
cd tests
./build.sh cortexm-pico2-cmake-gcc-debug
```

The script configures the build with the recorded platform, build type,
toolchain file and compiler paths, then runs Ninja.

Useful forms:

```bash
./build.sh --list
./build.sh --clean <config>
./build.sh --tests <config>
```

For Cargo and Zig, the script performs the corresponding command:

```bash
cargo build -p nucleof411 --examples --target thumbv7em-none-eabihf
zig build -Dboard=pico2
```

## 8.3 `tests/test.sh`

For CMake, the script maps a selection id to exact CTest names and runs them:

```bash
cd tests
./test.sh riscv-visionfive2-lite-cmake-gcc-debug 2.4.17
```

It also accepts CTest-name fragments, `--hwd` and `--regex`. The mapping lives
in `tests/scripts/selected-tests.txt`:

```text
configuration<TAB>selection-id<TAB>ctest-name[,ctest-name...]
```

For Cargo and Zig, the script runs the board/hardware runner or the Zig run
command for the selected configuration:

```bash
./test.sh cortexm-nucleof411-cargo-debug
./test.sh cortexm-pico2-zig-debug
```

## 8.4 Logs

Every verification writes:

```text
build-logs/<configuration>.configure.log
build-logs/<configuration>.build.log
```

These logs are the first place to look when a generated workspace fails to
build.

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

Minimal pruning rewrites those tables, removes other board sources and
removes other test directories. The build still uses the same
`build.zig` logic; it simply sees fewer entries.

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

Minimal mode is the default. It keeps enough of the port to build any test on
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
./build.sh <configuration>
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
| `--source <dir>` | Source workspace. |
| `--select <list>` | `architecture[.board[.test]]`, names, ids, or `all`. |
| `--config <name>` | Build only this configuration (repeatable). |
| `--no-build` | Scaffold without the verification build. |
| `--list-only` | Discover and write `scaffold.json`, copy nothing. |
| `--yes` | Non-interactive; use the default selection. |
| `--minimal` | Normal minimal layout (default). |
| `--full` | Complete harness and all boards/tests. |
| `--lean` | Strict test-only layout. |
| `--help` | Usage. |

Environment variables:

```text
SCAFFOLD_SOURCE   default source workspace
SCAFFOLD_SELECT   default selection
SCAFFOLD_DEBUG=1  print stack traces on error
```

## 11.6 Hardware test flow

The general flow is:

```bash
cd destination/tests
./build.sh <configuration>
./test.sh <configuration> <selection-id>
```

For the VisionFive 2 Lite, `test.sh` invokes the board runner, which invokes
the reset script, starts OpenOCD, loads the ELF, runs it and prints the UART
output. To skip the reset:

```bash
UOS_SKIP_PRE_TEST=1 ./test.sh riscv-visionfive2-lite-cmake-gcc-debug 2.4.17
```

## 11.7 Native flow

```bash
./build.sh native-cmake-sys-debug
./test.sh native-cmake-sys-debug 5.1.1
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

Also add the exact CTest name to `tests/scripts/selected-tests.txt`:

```text
riscv-visionfive2-lite-cmake-gcc-debug	2.4.matmul-f32-20	riscv-visionfive2-lite-matmul-f32-20-hwd
```

**Step 5: build and run.**

```bash
cd tests
./build.sh riscv-visionfive2-lite-cmake-gcc-debug
./test.sh riscv-visionfive2-lite-cmake-gcc-debug 2.4.matmul-f32-20
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

Lean workspaces remove the build tree. After adding or changing a test:

```bash
cd tests
./build.sh <configuration>
./test.sh <configuration> <selection>
```

Do not edit files in `tests/build`, `target`, `zig-out` or `zig-pkg`: they are
generated and removed by the next lean run.

If the change must survive regeneration, make it in the source repository and
re-run the scaffolder with `--lean`.

---

# 13. Rules, invariants and design philosophy

## 13.1 Source repositories are read-only

The scaffolder reads the source root and writes only to the destination. It
does not commit, format, patch or delete source files. The generated
workspace may contain patched copies (for example, a harness path adapted to
the sibling layout), but the originals are untouched.

## 13.2 The kernel is complete

The kernel is the interface. Keeping it complete means:

- every public header is available;
- the documentation and configuration examples remain;
- a test can be written, compiled and debugged without guessing which parts
  of the kernel were removed.

## 13.3 The port is selected, not exhaustive

The port contains support for several boards and SoCs. The scaffolder keeps
the selected board and the source/SoC/include families it actually names. It
does not keep every board “just in case”.

## 13.4 Tests are named, not globbed

A selected test is copied because it was selected, not because it happened to
be in a directory. Sibling sources pulled in with `#include "../<app>/..."`
are kept as helpers and excluded from the test build, so a helper does not
become an accidental second test.

## 13.5 Every scaffold is build-verified

A workspace that cannot build is not useful. The tool runs the real build and
records the result before declaring success.

## 13.6 Reproducibility comes from the manifest

`scaffold.json` records the selection, the tool paths and the configuration.
Re-running the same command recreates the same workspace, even if the current
shell environment changes.

## 13.7 Selection ids are convenient, names are stable

Numeric ids are short and readable, but they are assigned alphabetically. A
new test shifts later ids. Use `architecture.board.<app-name>` in scripts and
documentation.

---

# 14. Troubleshooting

| Symptom | Likely cause | What to do |
| --- | --- | --- |
| `Could not find toolchain file` | The selected toolchain was not copied or the build-helper was over-pruned. | Re-run the scaffolder without `--lean`; check `tests/xpacks/@micro-os-plus/build-helper/cmake/toolchains/`. |
| `CMAKE_C_COMPILER not set` | The toolchain file is missing or the compiler path is wrong. | Check `tests/scripts/env.sh` and the `tools` section of `scaffold.json`. |
| `ninja: error: ... missing and no known rule to make it` | A board source directory or linker script was pruned. | Re-run with `--minimal`; check the selected board's `board.cmake` references. |
| `missing compiler` during `build` | The slim manifest lost the compiler entries. | Re-scaffold (not just `build`) so tool detection runs again. |
| CTest lists no tests | The build tree was removed (lean mode) or the test is not registered. | Run `tests/build.sh`; check `tests/scripts/selected-tests.txt`. |
| Hardware test fails immediately | The board is not at the U-Boot prompt, no probe, or no UART device. | Check the probe and `/dev/ttyUSB*`; run the reset script; use `UOS_SKIP_PRE_TEST=1` only when appropriate. |
| `vf2-reset-to-uboot: no such serial device` | The USB-UART is not connected. | Connect it or adjust `PROBE_TTY`/the reset script. |
| Selection resolves to the wrong test | Numeric ids shifted after a new test was added. | Use the app-name token, for example `2.4.smp-mat-test`. |
| A test disappears after re-scaffolding | It exists only in the generated workspace. | Add it to the source repository, register it, commit it, then re-scaffold. |
| Zig rebuild is slow after lean cleanup | `zig-pkg` and `.zig-cache` were removed. | Expected; the first build repopulates them. |
| Cargo rebuild is slow after lean cleanup | `target/` was removed. | Expected; the first build repopulates it. |

---

# 15. The current trial workspaces

The four trial workspaces were generated to validate the lean design.

## 15.1 Arm Cortex-M

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

## 15.2 RISC-V VisionFive 2 Lite

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

## 15.3 Rust Cortex-M

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

## 15.4 Zig Cortex-M

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

## 15.5 What the trials prove

- CMake pruning survives a Cortex-M build and a RISC-V build.
- Cargo pruning survives a cross-target build.
- Zig pruning survives a board build with an external package.
- Lean manifests and READMEs are generated for all three build systems.
- Build outputs can be removed after verification without breaking the
  ability to rebuild from source.

---

# 16. Limitations and future work

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

---

# 17. Glossary

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

# 18. Appendix A: typical lean layouts

## 18.1 CMake lean workspace

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

## 18.2 Cargo lean workspace

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

## 18.3 Zig lean workspace

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

# 19. Appendix B: command cheat sheet

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
./build.sh riscv-visionfive2-lite-cmake-gcc-debug
./test.sh riscv-visionfive2-lite-cmake-gcc-debug 2.4.17

# Build and run one Cargo test
cd /path/to/dest/tests
./build.sh cortexm-nucleof411-cargo-debug
./test.sh cortexm-nucleof411-cargo-debug

# Build and run one Zig test
cd /path/to/dest/tests
./build.sh cortexm-pico2-zig-debug
./test.sh cortexm-pico2-zig-debug

# Skip the VisionFive 2 reset
UOS_SKIP_PRE_TEST=1 ./test.sh riscv-visionfive2-lite-cmake-gcc-debug 2.4.17
```

---

*End of document.*
