# Analysis: the restructured source workspace and what it means for micro-os-scaffold

**Date:** 2026-11-24<br>
**Source:** `/home/dan/Desktop/micro-os-plu-iii-smp-pr-github/`, branch `align/smp-upstream`
(kernel `b9887856`, 2026-11-21)<br>
**Scaffolder:** `micro-os-scaffold` at `66b067c`<br>
**Status:** implemented 2026-11-24 (`lib/v2/`; `README.md` "The restructured source", `scaffold.md` chapter 14); decisions in section 6

---

## 1. What changed in the source

### 1.1 Repositories and layout

Before (until 2026-11-15): sibling repositories at the root of the source folder.

```text
micro-os-plu-iii-smp-pr-github/
  micro-os-plus-iii-smp/        kernel (+ test_smpl/ runners)
  micro-os-plus-iii-aarch32/    port, with test/boards/<board>/ and test/<board>/<test>/
  micro-os-plus-iii-aarch64/
  micro-os-plus-iii-cortexm/
  micro-os-plus-iii-posix-arch/
  (tests/ harness used by the scaffolder)
```

Now: one folder per architecture, ten code repositories, and a records repository at the root.

```text
micro-os-plu-iii-smp-pr-github/           root repo: workspace records only (.gitignore: /*)
  micro-os-plus-iii/                      kernel + the whole test harness (tests/)
  aarch32/micro-os-plus-iii-aarch32/      port
  aarch32/micro-os-plus-iii-devices-rk3506/
  aarch64/micro-os-plus-iii-aarch64/
  cortexm/micro-os-plus-iii-cortexm/
  cortexm/micro-os-plus-iii-devices-rp2xxx/
  cortexm/micro-os-plus-iii-devices-stm32f4/
  posix-arch/micro-os-plus-iii-posix-arch/
  common/micro-os-plus-iii-devices-bcm283x/
  common/micro-os-plus-iii-devices-storage/
  workspace-records/, WORKING-WITH-LOCAL-BARE.md
```

Each code repository is independent (no submodules), on branch `align/smp-upstream`, backed
up in `~/Downloads/GIT/micro-os-plu-iii-smp-pr-local/<name>.git` (remote `local`).

### 1.2 Names

| Was | Is |
| --- | --- |
| kernel `micro-os-plus-iii-smp` (folder and package) | `micro-os-plus-iii`, package `@micro-os-plus/micro-os-plus-iii` 7.2.0-pre.1 |
| ports 0.1.0 / 1.x | `@micro-os-plus/micro-os-plus-iii-<arch>`; cortexm and posix-arch 2.0.0-pre.1, aarch32/aarch64 0.1.0-pre.1 |
| board drivers inside the ports | five device packages `micro-os-plus-iii-devices-{bcm283x,storage,rk3506,rp2xxx,stm32f4}` |
| `test_smpl/` shared runners (`run-hw.sh`, `run-qemu.sh`, `run-host.sh`) | gone; CTest runs QEMU, the host and OpenOCD itself |
| `<port>/test/boards/<board>/hw.sh` | gone ("drop hwsh", `b83c530b`) |
| shared port scaffolding (`hw_result.hpp`, `board-contract.cpp`) | `micro-os-plus-iii/tests/smp-support/` |

### 1.3 Where tests live now

| Was | Is |
| --- | --- |
| `<port>/test/boards/<board>/` (board code, linker script, `openocd.cfg`) | `micro-os-plus-iii/tests/platforms/<platform>/` (`include/`, `src/`, `device/linker-scripts/`, `openocd.cfg`, `cmake/`) |
| `<port>/test/<board>/<test>/` (board tests) | `micro-os-plus-iii/tests/platforms/<platform>/tests/<test>/` |
| `<port>/test/<board>/tests.cmake` | `micro-os-plus-iii/tests/platforms/<platform>/tests/tests.cmake` |
| `<port>/test/CMakeLists.txt` (one builder per port) | `micro-os-plus-iii/tests/board-tests/CMakeLists.txt` (one builder) |
| per-board copies of `smp-mat-test`, `smp_test0..4`, `clock-test`, `sd_test` (AArch) | shared, `micro-os-plus-iii/tests/sources/<test>/`, chosen per platform by `UOS_TESTS_SOURCES`, `UOS_TESTS_PORTABLE`, `UOS_TESTS_SUITES` in `platforms/<platform>/CMakeLists.txt` |

The builder keeps the same hooks (`board_test_defines`, `_sources`, `_includes`, `_linker`,
`_options`, `_ncpu`, `_libs`, `_qemu_libs`, `_qemu_sources`, `_qemu_includes`, plus new
`board_test_sd_posix` and `board_test_libraries`) and the same lists (`BOARD_TEST_HWD_ONLY`,
`_NO_KERNEL`, `_SELF_CONTAINED`). It still globs one test per directory of
`platforms/<platform>/tests/`. 24 platforms, 14 with a `tests/` folder.

### 1.4 Configuration, build and run

- **xpm drives everything**, from `micro-os-plus-iii/tests/package.json`: 120 build
  configurations `<platform>-cmake-<toolchain>-<debug|release>`, composed by `inherit` from
  hidden fragments (`cortexm-actions`, `aarch64-dependencies`, ...).
- **Per configuration:** `xpm run install` (pinned tools into `build/<C>/xpacks/.bin`),
  `xpm run link-deps` (links the port and device packages into
  `build/<C>/xpacks/@micro-os-plus/<package>`), `prepare`, `build`, `test` (`ctest -LE hwd`,
  or `-L hwd` on hardware-only configs), `test-hwd`. Group actions: `test-all`,
  `test-smp-cmake`, `test-<platform>-cmake`, ...
- **Package resolution:** `platforms/<platform>/cmake/dependencies-folders.cmake` lists
  `${CMAKE_BINARY_DIR}/xpacks/@micro-os-plus/micro-os-plus-iii-<pkg>`. `link-deps` fills those
  through `xpm link <package> --config <C>`, which needs a **machine-wide** registration made by
  `xpm link` inside each working copy (today: the Desktop copies).
- **CTest labels:** `qemu`, `host`, `hwd`, `hwd-reset` (AArch reset fixture per hardware test),
  `hwd-manual`. Verdict: `PASS/FAIL/SKIP_REGULAR_EXPRESSION "RESULT: ..."`.
- **QEMU cases:** `uos_tests_add_qemu ()` in `tests/cmake/uos-tests-run.cmake`, a plain
  `add_test` on `qemu-system-*` with `-semihosting-config enable=on,target=native`.
- **Hardware cases:** `uos_tests_add_hwd ()`: CTest runs OpenOCD with the platform's
  `openocd.cfg` and `tests/cmake/uos-hwd.tcl` (`uos_hwd_run`: halt, semihosting on, load,
  resume); AArch boards get `<test>-hwd-reset`. OpenOCD from `PATH`, QEMU from
  `build/<C>/xpacks/.bin` hints.
- **Probes:** `PROBE=jlink|olimex|cmsis-dap` (AArch Pi), `UOS_HW_ADAPTER_SERIAL=<serial>`
  (several CMSIS-DAP probes; this is the serial selection the examples did with OpenOCD
  wrappers), `UOS_HW_ADAPTER_KHZ=<kHz>`.

### 1.5 Not in the source

No µTest++ and no StateOS stdc++ integration (the only StateOS code is the Luckfox Lyra USB
environment). `--micro-test-plus` and `--stdcpp` remain the scaffolder's.

## 2. State of the scaffolder against the new source

`node bin/scaffold.js discover --source <new source>` finds **only the kernel**, named by its
old id `micro-os-plus-iii-smp`, with four "boards" that are the kernel's upstream examples
(`nucleo-f411re`, ...). It finds no port (they are one folder deeper) and no board test (they
are in the kernel's `tests/platforms/`). Every later step assumes the old layout:

| Scaffolder part | Old assumption | Broken by |
| --- | --- | --- |
| `lib/discover.js` | ports are siblings named `micro-os-plus-iii-<arch>` at the root; boards in `<port>/test/boards/`, tests in `<port>/test/<board>/` | 1.1, 1.3 |
| `copyKernel` / `copyPort` / `copyHarness` (`lib/scaffold.js`) | the kernel's `tests/` is excluded and a separate harness is copied; `test_smpl/` runners | 1.3, 1.2 |
| `lib/prune.js`, `lib/lean.js` | prune `<port>/test/<board>/<test>/`, `platforms/<platform>` in a harness | 1.3, and the `UOS_TESTS_*` lists |
| `templates/run.sh` | calls CMake with the old harness; `-hwd` by name suffix; links `UOS_LIB_*` | 1.4 (labels, link-deps) |
| `lib/micro-test-plus.js` | board support in `<port>/test/mtp/`; hooks in `<port>/test/<board>/tests.cmake`; patches `run-hw.sh`/`run-qemu.sh`/`run-host.sh` and board `hw.sh` for the command line and the TAP file; console detection in `<port>/test/boards/<board>/` | 1.2, 1.3, 1.4 |
| `lib/stdcpp.js` | `tests.cmake` at `<port>/test/<board>/`; `../../../third_party` relative path | 1.3 |
| generated docs (`lean.js`, `readme.js`, templates) | all paths above | all |
| the local-tests spec (2026-11-15) | `<port>/test/<board>/<name>/`, `tests.cmake` there, `run.sh` selection by name | 1.3, 1.4 |

The examples repository `micro-os-scaffold-ctest-examples` (six workspaces) was generated
from the old layout. Its workspaces still build and run on their own (they carry their old
copies), but they no longer correspond to the source.

## 3. Mapping of the scaffolder concepts onto the new layout

| Concept | New location |
| --- | --- |
| kernel | `micro-os-plus-iii/` (complete, as before) |
| port(s) | `<arch>/micro-os-plus-iii-<arch>/` |
| device packages | `<arch-or-common>/micro-os-plus-iii-devices-*/`, those a platform's `dependencies-folders.cmake` names |
| harness | `micro-os-plus-iii/tests/` (no separate copy) |
| platform / board | `micro-os-plus-iii/tests/platforms/<platform>/` |
| board test | `.../platforms/<platform>/tests/<test>/`, or a shared `tests/sources/<test>/` listed by the platform |
| per-test hooks | `.../platforms/<platform>/tests/tests.cmake` |
| configuration | `tests/package.json` `xpack.buildConfigurations.<C>` |
| µTest++ board support | `micro-os-plus-iii/tests/mtp/` (next to `smp-support/`) |
| µTest++ command line / TAP file | `uos_tests_add_qemu ()` (QEMU `arg=`), `uos-hwd.tcl` (`arm semihosting_cmdline`), `uos_tests_add_host ()` |
| µTest++ console detection | `platforms/<platform>/include/uart.hpp` (or `bsp/uart.hpp`), `smp-support/include/hw_result.hpp` |
| stdc++ package | `<workspace>/third_party/stateos-stdc++/`, `../../../../../third_party` from `platforms/<p>/tests/` |
| local tests (spec) | `platforms/<platform>/tests/<name>/`, `tests.local.cmake` next to `tests.cmake` |

## 4. Lean workspace in the new layout

```text
<workspace>/
  micro-os-plus-iii/                      kernel, complete; tests/ pruned to:
    tests/platforms/<platform>/           the selected platform(s) only
      tests/<selected tests>/             only the selected board tests
    tests/sources/<selected portable tests and suites>/
    tests/board-tests/, cmake/, smp-support/, device-qemu-cortexm/ (if the platform uses it)
    tests/package.json                    the selected configurations only
  <arch>/micro-os-plus-iii-<arch>/        the platform's port
  <dir>/micro-os-plus-iii-devices-*/      the devices its dependencies-folders.cmake names
  third_party/                            micro-test-plus, stateos-stdc++ (options)
  run.sh or tests/run.sh                  the one entry point (section 6, decision 1)
  scaffold.json, README.md
```

Package links: the scaffolder creates `micro-os-plus-iii/tests/build/<C>/xpacks/@micro-os-plus/<pkg>`
as relative symbolic links to the workspace's own copies, and `build/<C>/xpacks/.bin` links to
the tools found by the scaffolder, without `xpm link` (no machine-wide registration changes).

## 5. Risks

- **Machine-wide xpm links.** Running `xpm link` in a scaffolded copy would retarget the
  global registration, so the source workspace's `xpm run link-deps` would then link the
  scaffold's copies. The scaffolder must not do it.
- **Pruning the `UOS_TESTS_*` lists** in `platforms/<platform>/CMakeLists.txt` must keep the
  CMake valid (the existing `removeCmakeCalls` machinery, with tests).
- **120 configurations** in `package.json`: the lean copy keeps the selected ones and the
  hidden fragments they inherit.
- **Hardware results** recorded in the docs (`scaffold.md` 13.6, the examples' `HOW-TO-RUN.md`)
  were measured on the old layout; they must be re-measured or marked as such.

## 6. Decisions

Decided 2026-11-24:

| # | Question | Decision |
| --- | --- | --- |
| 1 | How does a workspace build and run? | **Its own `run.sh`.** It creates the `build/<C>/xpacks/@micro-os-plus/<pkg>` links to the workspace's own copies and the tool links itself, then runs CMake and CTest with the new labels. It never runs `xpm link`, so the machine-wide registrations keep pointing at the source |
| 2 | Layout | **Mirror the source:** `micro-os-plus-iii/`, `<arch>/micro-os-plus-iii-<arch>/`, `<dir>/micro-os-plus-iii-devices-*/` (section 4) |
| 3 | The six example workspaces | **Re-scaffold all** from the new source once the scaffolder works, keeping the hand-made tests through the local-tests mechanism, then QEMU and board runs |
| 4 | Order | **Layout first** (discovery, copy, prune, run.sh, µTest++, stdc++, docs), **then local tests** (the 2026-11-15 spec, updated to the new paths), **then the examples**; each step tested before the next |
