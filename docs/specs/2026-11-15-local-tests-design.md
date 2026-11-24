# Spec: local tests that survive a re-scaffold

**Status:** implemented 2026-11-24 for the new source layout (`lib/v2/local.js`; paths in section 12); open questions decided 2026-11-15 (section 11)<br>
**Date:** 2026-11-15<br>
**Repository:** `micro-os-scaffold` (with a migration in `micro-os-scaffold-ctest-examples`)<br>
**Origin:** code review of the scaffolds and examples, finding #3

---

## 1. Problem

A test added by hand to a scaffolded workspace is fragile. It needs three things, and
the scaffolder protects none of them:

| The test needs | Where it lives today | Lost when |
| --- | --- | --- |
| its **test directory** | `<port>/test/<board>/<name>/` | a re-scaffold: `prunePortTests ()` in `lib/prune.js` removes every test directory that `scaffold.json` does not select |
| its **default selection** | the `SELECTED=(...)` array written into `tests/run.sh` by `generateRunScript ()` in `lib/scaffold.js` | `run.sh` is regenerated (every scaffold run) |
| its **CMake wiring** (for example a `board_test_libs` branch that links `stateos-stdc++`) | a hand edit inside `<port>/test/<board>/tests.cmake` | `copyPort ()` copies `tests.cmake` fresh from the source repository |

There is also no supported way to add a hand-made test to the default selection
without editing the generated `run.sh`. Three workspaces in
`micro-os-scaffold-ctest-examples` do exactly that today: `rpi4b-smp` (`smp_test4`),
`pico2-smp-stdcpp` (`smp-stdcpp-test`) and `weactf411-spi-stdcpp` (`spi-stdcpp-test`).
Their `README.md` "Rebuilding this workspace" commands would delete those tests.

## 2. Goals and non-goals

**Goals**

- G1. A user can list hand-made tests in one file, and `tests/run.sh` runs them by
  default, without regenerating anything.
- G2. A re-scaffold keeps those test directories, and any other paths the user names,
  byte for byte.
- G3. A test's CMake wiring (libraries, defines, sources, includes, ...) can live in a
  user-owned file that a re-scaffold keeps, while `tests.cmake` still follows the source
  repository.
- G4. Nothing changes for a workspace that has neither file.
- G5. The workspace README and `scaffold.json` say what is local.

**Non-goals**

- Merging hand edits made inside generated files (`tests.cmake`, `run.sh`). Those stay
  generated; the user's part moves to the two local files.
- Cargo and Zig workspaces (they have their own `build.sh`/`test.sh`). Out of scope for
  the first version; the design must not break them.
- Tests that belong in the source repository. Committing them there and selecting them
  with `--select` remains the right way for tests meant to last.

## 3. Design overview

Two user-owned files, never written by the scaffolder:

| File | Purpose |
| --- | --- |
| `tests/scripts/local-tests.txt` | which test directories are local (kept and run by default), and which other paths to keep |
| `<port>/test/<board>/tests.local.cmake` | the CMake wiring of the local tests, through `*_local` hook functions |

And three changes in the scaffolder:

1. `templates/run.sh` reads `local-tests.txt` at run time.
2. `scaffold ()` sets the listed paths aside before copying the port and restores them
   at the end.
3. The `tests.cmake` patcher includes `tests.local.cmake` and makes every board hook
   call its `*_local` twin first.

## 4. `tests/scripts/local-tests.txt`

### 4.1 Format

```text
# Tests added by hand to this workspace. micro-os-scaffold never writes this
# file: a re-scaffold keeps what it lists, and tests/run.sh runs the tests by
# default.
#
#   <test-directory>          a test of this workspace's board(s)
#   keep <path>               a file or folder (relative to the workspace)
#                             kept as it is

spi-stdcpp-test
keep third_party/my-lib
```

- One entry per line. `#` starts a comment (whole line or end of line). Blank lines are
  ignored. Leading and trailing white space is ignored.
- **Test entry:** a bare name, matching a directory `<port>/test/<board>/<name>/` of a
  selected board. The name must match `^[A-Za-z0-9][A-Za-z0-9._-]*$`.
- **Keep entry:** `keep <path>`, a path relative to the workspace root, file or folder.
- Optional board prefix for multi-board workspaces: `<board>/<name>` (for example
  `pico2/my-test`). Without it, the name matches the directory on every selected board
  that has it.

### 4.2 Validation (at scaffold time; errors stop the scaffold before anything is copied)

| Rule | Why |
| --- | --- |
| a `keep` path must stay inside the workspace (no absolute path, no `..` after normalisation) | the scaffolder never touches anything outside the destination |
| a `keep` path must not be, contain, or lie inside a generated path: `tests/run.sh`, `tests/scripts/env.sh`, `scaffold.json`, `README.md`, `<port>/test/mtp/`, `third_party/micro-test-plus/`, `third_party/stateos-stdc++/`, `tests/build/` | generated files are rewritten on every run; keeping them would hide updates. Use `--stdcpp-from` or `--micro-test-plus` for the packages |
| a test name must not be a generated starter: `mtp-example`, `mtp-args`, `mtp-smp`, `mtp-eth-net`, `mtp-stdcpp` | those are rewritten by the options |
| a test name that is also selected in `scaffold.json` is reported as a warning ("already selected; the local copy wins") | supports a locally modified copy of a source test, as `smp_test4` is |
| a test entry with no matching directory before the run is a warning, not an error | the user may have deleted it; nothing to keep |

### 4.3 `tests/run.sh` (template change)

After `REGISTERED` is computed, append the local tests of the current configuration to
`SELECTED`:

```bash
LOCAL_TESTS="$HERE/scripts/local-tests.txt"
if [[ -f "$LOCAL_TESTS" ]]; then
  while IFS= read -r line; do
    line="${line%%#*}"
    read -r first rest <<< "$line"
    [[ -z "$first" || "$first" == "keep" ]] && continue
    first="${first##*/}"                      # a board prefix does not matter here
    while IFS= read -r name; do
      [[ -n "$name" ]] && SELECTED+=("$name")
    done <<< "$(application_names "$first")"
  done < "$LOCAL_TESTS"
fi
```

- `application_names ()` already maps a directory name to its CTest names
  (`<platform>-<name>-qemu|hwd|host`) for this configuration. A local test that this
  configuration does not have adds nothing.
- Duplicates are harmless (the CTest regular expression is an alternation).
- `./run.sh list` marks the local tests with `L` and the scaffolded selection with `*`
  (decision 2), so the list shows which tests a re-scaffold regenerates and which it keeps:

  ```text
  CTest cases of cortexm-weactf411-cmake-gcc-debug (* = selected, L = local):
    * cortexm-weactf411-mtp-example-hwd
    L cortexm-weactf411-spi-stdcpp-test-hwd
  ```

  To support this, the block above also collects the local names in a `LOCAL=()`
  array; the `list` loop prints `L` for a name in `LOCAL`, else `*` for one in
  `SELECTED`.
- `--hwd`, `--hwd-only` and `all` behave as for any selected test.

## 5. `<port>/test/<board>/tests.local.cmake`

### 5.1 What the user writes

Any of these functions, each with the hook's signature `(_app _out)`:

```cmake
# tests.local.cmake -- the CMake wiring of this board's local tests.
# micro-os-scaffold never writes this file; a re-scaffold keeps it.

function (board_test_libs_local _app _out)
  if (_app STREQUAL "spi-stdcpp-test")
    set (${_out} stateos-stdc++ uos-micro-test-plus PARENT_SCOPE)
  endif ()
endfunction ()

function (board_test_defines_local _app _out)
  if (_app STREQUAL "spi-stdcpp-test")
    set (${_out} SPI_SCRATCH_TOP=1 PARENT_SCOPE)
  endif ()
endfunction ()
```

Contract: a `*_local` function sets `${_out}` (with `PARENT_SCOPE`) only for the tests it
handles. If it leaves `${_out}` unset, the generated hook runs as before.

### 5.2 Which hooks get a local twin

All ten hooks the CMake ports declare in `<port>/test/CMakeLists.txt` (verified in
cortexm, aarch64, aarch32, posix-arch):

`board_test_defines`, `board_test_sources`, `board_test_includes`, `board_test_linker`,
`board_test_options`, `board_test_ncpu`, `board_test_libs` (the posix port calls it
`board_test_libraries`; `libsHookName ()` in `lib/micro-test-plus.js` already detects
it), `board_test_qemu_libs`, `board_test_qemu_sources`, `board_test_qemu_includes`.

Lists (`BOARD_TEST_HWD_ONLY`, `BOARD_TEST_NEED_DEVICES`, `BOARD_TEST_SELF_CONTAINED`,
`BOARD_TEST_NO_KERNEL`) need no twin: `tests.local.cmake` is included at the end of
`tests.cmake`, so it can simply `list (APPEND BOARD_TEST_HWD_ONLY spi-stdcpp-test)`.

### 5.3 What the scaffolder generates

The port declares the default hooks **before** it includes `tests.cmake`, and a board's
`tests.cmake` may redefine some of them. So the scaffolder patches `tests.cmake`, after
the existing `--micro-test-plus` and `--stdcpp` blocks, in two steps:

**a. A dispatch line at the top of every hook `tests.cmake` defines.** The same
regular-expression insertion that `patchLibsHook ()` already uses for the `mtp-*`
branch, inserted **first** in the body (before the µTest++ and stdc++ branches):

```cmake
function (board_test_libs _app _out)
  # local tests (micro-os-scaffold): tests.local.cmake may answer first.
  if (COMMAND board_test_libs_local)
    set (_local_out "")
    board_test_libs_local ("${_app}" _local_out)
    if (DEFINED _local_out AND NOT "${_local_out}" STREQUAL "")
      set (${_out} ${_local_out} PARENT_SCOPE)
      return ()
    endif ()
  endif ()
  # ... the generated mtp-* and mtp-stdcpp branches, then the source's own body ...
```

**b. A block at the end of `tests.cmake`:**

```cmake
# ---- local tests (micro-os-scaffold) ---------------------------------------
# A user-owned tests.local.cmake next to this file holds the CMake wiring of
# the tests listed in tests/scripts/local-tests.txt. A re-scaffold keeps it.
include ("${CMAKE_CURRENT_LIST_DIR}/tests.local.cmake" OPTIONAL)

# Hooks this file does not define still consult the local twins: wrap the
# port's default, which ran before this file was included.
# (generated only for the hooks tests.cmake does not define)
function (board_test_options _app _out)
  if (COMMAND board_test_options_local)
    set (_local_out "")
    board_test_options_local ("${_app}" _local_out)
    if (NOT "${_local_out}" STREQUAL "")
      set (${_out} ${_local_out} PARENT_SCOPE)
      return ()
    endif ()
  endif ()
  set (${_out} "" PARENT_SCOPE)              # the port default's answer
endfunction ()
```

Notes:

- The wrapper for a hook that `tests.cmake` does not define must reproduce the port's
  default answer. All ten defaults return an empty list today; the generator reads
  the default's body from `<port>/test/CMakeLists.txt` and refuses to wrap a hook whose
  default is not `set (${_out} "" PARENT_SCOPE)` (it then reports that the hook cannot
  have a local twin, rather than guess).
- `board_test_ncpu` returns one value, not a list; the same code works.
- The dispatch is generated whether or not `tests.local.cmake` exists (it is guarded by
  `COMMAND`), so creating the file later needs no re-scaffold.
- Marker: `micro-os-scaffold local tests`, so a re-run does not insert twice (the same
  pattern as `MARK` in `lib/micro-test-plus.js` and `lib/stdcpp.js`).

## 6. Scaffolder pipeline changes (`lib/scaffold.js`)

### 6.1 Order

`scaffold ()` today: `copyKernel` → `copyPort` (overwrites files with the source's) →
harness and scripts → `pruneWorkspace` (removes unselected test directories) →
`microTestPlus.integrate` → `stdcpp.integrate` → `refreshDocs` → manifest.

New steps, marked **(new)**:

1. **(new) `stashLocal ()`**, before `copyKernel`:
   - read `tests/scripts/local-tests.txt` from the destination, if any; validate (4.2);
   - resolve each test entry to its existing directories `<port>/test/<board>/<name>/`;
   - add every `<port>/test/<board>/tests.local.cmake` that exists;
   - move all of them, and every `keep` path, to a stash folder
     `<destination>/.scaffold-local-stash/` (same file system, so a rename), recording
     the original relative paths in `stash.json`.
   It must run **before** `copyPort`: a local test that shares its name with a source test
   (`smp_test4`) would otherwise have its files overwritten by the source's.
2. `copyKernel`, `copyPort`, harness, scripts, pruning, µTest++, stdc++: unchanged.
3. **(new) `patchLocalHooks ()`**, after `stdcpp.integrate`: 5.3 on every selected
   board's `tests.cmake`.
4. **(new) `restoreLocal ()`**, after `patchLocalHooks`:
   - move every stashed path back (removing whatever the copy put there first, so the local
     copy wins), then delete the stash folder;
   - record the result in `config.localTests` (6.3);
   - regenerate `tests/run.sh` (it does not embed local tests; nothing to add, but the
     regeneration order stays: run.sh last).
5. `refreshDocs`, manifest: unchanged except 6.3 and 7.

### 6.2 Failure safety

- If anything throws between stash and restore, a `try/finally` restores the stash before
  the error propagates. A stash folder found at the start of a run (a crash of a previous
  run) is restored first, with a warning, before anything else.
- `--list-only` does not stash (nothing is copied).
- The stash folder name is excluded from `copyTree` and from the lean pruning.

### 6.3 `scaffold.json`

```json
"localTests": {
  "file": "tests/scripts/local-tests.txt",
  "tests": [
    { "name": "spi-stdcpp-test", "paths": ["micro-os-plus-iii-cortexm/test/weactf411/spi-stdcpp-test"] }
  ],
  "keep": ["third_party/my-lib"],
  "hookFiles": ["micro-os-plus-iii-cortexm/test/weactf411/tests.local.cmake"]
}
```

Informational only: `local-tests.txt` is the source of truth. `slimConfig ()` in
`lib/lean.js` keeps the key.

## 7. Documentation changes

| File | Change |
| --- | --- |
| generated workspace `README.md` (`lib/lean.js`, `lib/readme.js`) | "Kept in the port" lists local tests as `(local: tests/scripts/local-tests.txt)`; a "Local tests" section with the two files and an example; the Regenerate command is unchanged (local files need no option) |
| `README.md`, `scaffold.md` | a section "Local tests": the two files, the format, the rules (4.2), and when to prefer the source repository; remove "re-scaffolding removes tests added locally" from the limitations, or narrow it to tests not listed |
| `templates/README_API_CTEST.md` §10 | replace "a test you add by hand ... runs when you name it ... a re-scaffold removes it" with the local-tests procedure |
| `templates/README_STDC++.md` §3 | show `tests.local.cmake` for linking `stateos-stdc++` to a local test |
| `templates/TESTS-ARCHITECTURE.md` | in the hooks chapter, the local twins and their precedence |
| `templates/README-LEAN-CMAKE.md` | the "Adding a new test" step: add the name to `local-tests.txt` |

## 8. Migration of `micro-os-scaffold-ctest-examples`

| Workspace | Test | Migration |
| --- | --- | --- |
| `rpi4b-smp` | `smp_test4` (StateOS stdc++ suites; hand branch in `tests.cmake`) | re-scaffold with `--stdcpp`: the generated `mtp-stdcpp` has the same six suites. Remove `smp_test4` from the hand edits. Keep `STDCXX.md` references valid (it describes `smp_test4`; add a note that `mtp-stdcpp` is its generated successor, or keep `smp_test4` as a local test with `local-tests.txt` + `tests.local.cmake` if the guide must stay literal) |
| `pico2-smp-stdcpp` | `smp-stdcpp-test` | **stays local** (decision 4): on the Pico 2 the generated `mtp-*` tests are hardware-only (the QEMU image replaces the board), and `smp-stdcpp-test` also runs single-core under QEMU, which must be kept. `smp-stdcpp-test` goes in `local-tests.txt`; its `stateos-stdc++ uos-micro-test-plus` branch moves to `tests.local.cmake`; scaffold with `--stdcpp` for the package. `mtp-stdcpp` is generated as well (hardware only); both may stay |
| `weactf411-spi-stdcpp` | `spi-stdcpp-test` (stdc++ suites + the SPI-flash suite) | stays local: `spi-stdcpp-test` in `local-tests.txt`; its `stateos-stdc++ uos-micro-test-plus` branch moves to `tests.local.cmake`; scaffold with `--stdcpp` so the package is present |
| all three | hand-edited `SELECTED` in `tests/run.sh` | disappears: `run.sh` is regenerated, the local list adds the tests |
| all three | the shared `third_party/stateos-stdc++` symlink to the repository root | replaced by the copy `--stdcpp` makes (140 KiB each), or kept with `keep third_party/stateos-stdc++` if the single shared copy is preferred (then the validation of 4.2 must allow it when `--stdcpp` is not used) |

## 9. Verification plan

**Unit-level (no board):**

1. Parse and validate `local-tests.txt`: every rule of 4.2, comments, blank lines, board
   prefix, a name with no directory.
2. `run.sh` with a local list: `./run.sh list` marks the local tests; `./run.sh`,
   `--hwd`, `--hwd-only`, `all` select the expected cases. Check selection by the
   "== run N cases" count, or by `ctest -N -R`. Do **not** fake `ctest` on `PATH`: `env.sh`
   puts the toolchain's directories first, so a `PATH` stand-in is bypassed and the real
   tests run.
3. Hook dispatch: a scratch board whose `tests.local.cmake` sets libraries, defines and
   `BOARD_TEST_HWD_ONLY` for one test; `cmake` configure; inspect the generated
   `build.ninja` for that test's defines and libraries; check that other tests are
   unchanged.

**Re-scaffold round trips (scratch copies of the example workspaces):**

4. `weactf411-spi-stdcpp` with `local-tests.txt` and `tests.local.cmake`: re-scaffold with
   the command from its README; `spi-stdcpp-test` and the two local files are
   byte-identical afterwards (`diff -r` against a copy taken before); it builds; it is in
   `./run.sh list` with `*`.
5. The same with a crash injected between stash and restore (for example a throwing
   `stdcpp.integrate`): the stash is restored; a second run finds no stash folder.
6. A local test that shares its name with a source test (`smp_test4` in `rpi4b-smp`): the
   local files win.
7. A workspace with neither file: the generated tree is byte-identical to today's
   (`diff -r` of two scaffolds, before and after the change, excluding timestamps in
   `scaffold.json`).

**Boards (when connected):**

8. WeAct F411CE: `./run.sh --hwd-only` runs `spi-stdcpp-test` from the local list and
   passes (104 checks today).
9. Pi 4 B and Pico 2: after migration, `mtp-stdcpp` passes 75/75 on the boards.

## 10. Acceptance criteria

- A1. Re-scaffolding each example workspace with its documented command loses no test
  and no local file (9.4, 9.6).
- A2. The hand-made tests run by default with no edit to a generated file (9.2).
- A3. A workspace without local files scaffolds exactly as before (9.7).
- A4. The docs of section 7 describe the feature, and the doc/code check (the same
  check run on 2026-11-15: options, run.sh, API names, paths, PDFs) passes.
- A5. All board results of section 9 recorded in `scaffold.md` 13.6 and in the examples'
  `HOW-TO-RUN.md`.

## 11. Decisions (2026-11-15)

| # | Question | Decision |
| --- | --- | --- |
| 1 | Where does the local list live? | `tests/scripts/local-tests.txt`, as specified in section 4 |
| 2 | Mark local tests differently in `./run.sh list`? | **Yes:** `L` for local tests, `*` for the scaffolded selection (4.3) |
| 3 | May `keep` name files inside a port (for example a modified board driver)? | **Yes.** Such a path is restored over the source's copy; every scaffold run prints a warning naming it (`kept local: <path> -- source updates of this file are not applied`) and `scaffold.json` lists it under `localTests.keep` |
| 4 | Pico 2 `smp-stdcpp-test` (QEMU single-core case) | **Keep it local** (section 8): `local-tests.txt` + `tests.local.cmake`, not replaced by `mtp-stdcpp` |

## 12. As implemented (2026-11-24, new source layout)

The source was restructured before this specification was implemented, so it was implemented
for the new layout only (`lib/v2/local.js`, `lib/v2/scaffold.js`, `templates/v2/run.sh`). The
old-layout pipeline is unchanged. The paths of the sections above map as follows:

| Specified (old layout) | Implemented (new layout) |
| --- | --- |
| `tests/scripts/local-tests.txt` | `scripts/local-tests.txt` (beside the root `run.sh`; the old `tests/scripts/` folder moved there) |
| `<port>/test/<board>/<name>/` | `micro-os-plus-iii/tests/platforms/<platform>/tests/<name>/` |
| `<board>/<name>` prefix | `<platform>/<name>` |
| `<port>/test/<board>/tests.local.cmake` | `micro-os-plus-iii/tests/platforms/<platform>/tests/tests.local.cmake` |
| the ten hooks of `<port>/test/CMakeLists.txt` | every hook of `micro-os-plus-iii/tests/board-tests/CMakeLists.txt` (twelve, with `board_test_sd_posix` and `board_test_libraries`) |
| refuse to wrap a hook whose default is not empty (5.3) | the wrapper copies the default's body from `board-tests/CMakeLists.txt` (`board_test_ncpu` and `board_test_sd_posix` return the board's values) |
| generated paths of 4.2 | `run.sh`, `scripts/env.sh`, `scaffold.json`, `README.md`, `build-logs/`, `micro-os-plus-iii/tests/mtp/`, `micro-os-plus-iii/tests/build/`, `third_party/micro-test-plus/`, `third_party/stateos-stdc++/`, `.scaffold-local-stash/` |

Additions: `cleanGenerated ()` removes the previous scaffold's generated tree after the stash
(the old pipeline copied over it); a local test named like a shared test of its platform
(`smp_test4` in `tests/sources/`) is dropped from the platform's `UOS_TESTS_*` lists, which the
new builder requires (it stops on a name that is both).

Verification done (section 9): 1 (validation), 2 (`./run.sh list` marks `L`, the default run
includes the local tests), 4 and 6 (round trips, `weactf411-spi-stdcpp` and `rpi4b-smp`,
byte-identical; `smp_test4` replaces the shared test and passes 75/75 under QEMU), 5 (failure
injected between stash and restore). 7 does not apply (no previous new-layout pipeline to
compare with). 8 and 9 (boards) are pending.
