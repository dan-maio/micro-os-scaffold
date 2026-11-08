## Adding files, devices, boards and tests

The generated workspace is ordinary CMake source. Nothing is installed as a
pre-built library: the kernel and each port export INTERFACE targets whose
sources are compiled into the test executables.

### 0. Where things live

```text
<destination>/
├── micro-os-plus-iii-smp/
│   ├── CMakeLists.txt              kernel INTERFACE targets
│   ├── include/                    public kernel headers
│   └── src/                        kernel sources
├── {{PORT}}/
│   ├── CMakeLists.txt              port + SoC + board INTERFACE targets
│   ├── include*/                   port headers
│   ├── src/                        port-wide sources
│   ├── soc/<soc>/include, src/     device/SoC support
│   └── test/
│       ├── CMakeLists.txt          builds one target per test directory
│       ├── boards/{{BOARD}}/       board facts, startup, glue, linker, probe
│       └── {{BOARD}}/
│           ├── tests.cmake         per-test hooks
│           └── <app>/              one directory per test application
└── tests/
    ├── CMakeLists.txt              harness entry point
    ├── cmake/                      global CMake helpers
    ├── platforms/{{PLATFORM}}/     platform selection and CTest registration
    ├── sources/<suite>/            portable harness suites
    └── xpacks/                     build-helper and other xPack dependencies
```

### 1. Add a source file to the kernel

1. Put the file under `micro-os-plus-iii-smp/src/<group>/`.
2. Add it to the kernel interface target in
   `micro-os-plus-iii-smp/CMakeLists.txt`:

   ```cmake
   target_sources (
     micro-os-plus-iii-interface
     INTERFACE
       src/rtos/os-new-feature.cpp
   )
   ```

3. Put headers under `micro-os-plus-iii-smp/include/`; that directory is
   already on the interface include path.
4. If the code is optional, create a separate INTERFACE target, an alias such
   as `micro-os-plus::iii-new-feature`, and link it only from the port or board
   that needs it.

### 2. Add a source file to the port

1. Port-wide sources go under `{{PORT}}/src/` and are added to the port
   interface target in `{{PORT}}/CMakeLists.txt`:

   ```cmake
   target_sources (
     {{PORT_INTERFACE}}
     INTERFACE
       src/new-port-file.cpp
   )
   ```

2. Board-only sources go under `{{PORT}}/test/boards/{{BOARD}}/src/`. The
   port CMakeLists globs that directory (`*.c`, `*.cpp`, `*.S`) automatically.
3. Per-test glue goes under `{{PORT}}/test/boards/{{BOARD}}/glue/` and is
   named per test in `test/{{BOARD}}/tests.cmake` through
   `board_test_sources()`. It is intentionally not globbed.
4. Headers go under the port `include/` (port-wide) or the board
   `test/boards/{{BOARD}}/include/` (board-only). Add include paths with
   `UOS_BOARD_PORT_INCLUDE` in `board.cmake` or
   `target_include_directories()` in the port CMakeLists.

### 3. Add a new device / SoC

1. Create the device tree:

   ```text
   {{PORT}}/soc/<soc>/
   ├── include/                 CMSIS device header, SoC registers
   └── src/                     system_<soc>.c, vectors, clocks
   ```

2. Add an INTERFACE target in `{{PORT}}/CMakeLists.txt`:

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

3. Link it from the board in `test/boards/{{BOARD}}/board.cmake`:

   ```cmake
   set (UOS_BOARD_LIBS micro-os-plus::soc-<soc>)
   ```

4. Put the startup code, vectors, clocks and linker scripts under
   `test/boards/{{BOARD}}/`. The board `src/` directory is globbed.

### 4. Add a new board

A board is a directory under `{{PORT}}/test/boards/<board>/` containing at
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
| `UOS_BOARD_LIBS` | optional | SoC/board libraries |
| `UOS_BOARD_PORT_CORE` | optional | port-specific scheduler core |
| `UOS_BOARD_PORT_INCLUDE` | optional | port include overlay, searched first |
| `UOS_BOARD_RTOS_GLUE` | optional | per-board RTOS glue sources |

Add:

```text
{{PORT}}/test/boards/<board>/
├── board.cmake
├── openocd.cfg
├── hw.sh
├── linker.ld
├── linker-qemu.ld       optional
├── src/                 startup, vectors, clocks, LEDs
├── include/             board headers, cmsis-plus/os-app-config.h
└── glue/                optional per-test glue
```

Create `{{PORT}}/test/<board>/` for its tests and
`{{PORT}}/test/<board>/tests.cmake`. For a new CTest platform, copy
`tests/platforms/{{PLATFORM}}/` to `tests/platforms/<platform>/` and set
`BOARD` in `cmake/definitions.cmake`.

### 5. Add a new test application

1. Create the application directory:

   ```text
   {{PORT}}/test/{{BOARD}}/<app>/
   └── main.cpp
   ```

   At least one `.c`, `.cpp` or `.S` file is required. The port's
   `test/CMakeLists.txt` discovers every such directory.

2. Add per-test settings in `{{PORT}}/test/{{BOARD}}/tests.cmake`:

   | Hook / list | Use |
   |---|---|
   | `BOARD_TEST_HWD_ONLY` | test has no QEMU image |
   | `BOARD_TEST_NO_KERNEL` | bare-metal test, no RTOS |
   | `BOARD_TEST_SELF_CONTAINED` | own startup, no shared `src/` |
   | `board_test_sources(_app _out)` | extra sources |
   | `board_test_includes(_app _out)` | extra include dirs |
   | `board_test_defines(_app _out)` | extra defines |
   | `board_test_options(_app _out)` | extra compile options |
   | `board_test_linker(_app _out)` | alternate linker script |
   | `board_test_ncpu(_app _out)` | override `OS_NCPU` |
   | `board_test_libs(_app _out)` | extra libraries |
   | `board_test_qemu_libs/sources/includes` | what the QEMU variant links |

3. CTest names are generated as:

   ```text
   {{PLATFORM}}-<app>-qemu
   {{PLATFORM}}-<app>-hwd
   {{PLATFORM}}-<app>-host
   ```

4. Register the selection in `scaffold.json` or re-run the scaffolder with
   `--select <architecture>.<board>.<test>`. The generated
   `tests/scripts/selected-tests.txt` maps selection ids to exact CTest names.

5. Build and run:

   ```bash
   cd tests
   ./build.sh {{CONFIG}}
   ./test.sh {{CONFIG}} <selection-id>
   ```

### 6. Add a portable harness suite

Portable suites live in `tests/sources/<suite>/` and export `test::<suite>`:

```text
tests/sources/<suite>/
├── CMakeLists.txt        add_library(test::<suite> INTERFACE ...)
├── include/              suite headers, os-app-config.h
└── *.cpp                 suite implementation
```

Add the directory to
`tests/platforms/{{PLATFORM}}/cmake/dependencies-folders.cmake`, then link
`test::<suite>` from `board_test_libs()` in the board's `tests.cmake`.

### 7. Add a dependency / xPack

Add the dependency to `tests/package.json` and run `xpm install`, or copy the
resolved xPack into `tests/xpacks/`. The scaffold records detected libraries in
`scaffold.json` under `libraries`; `tests/build.sh` links the ones a build
needs into `tests/build/<configuration>/xpacks/`. Keep paths in
`scaffold.json`, not hard-coded in CMake.

### 8. Build and test after changes

```bash
cd tests
./build.sh {{CONFIG}}
ctest --test-dir build/{{CONFIG}} -N
./test.sh {{CONFIG}} {{EXAMPLE_SELECTION}}
./test.sh {{CONFIG}} --hwd
```

`CONFIGURE_DEPENDS` globs mean a normal `./build.sh` notices new test
directories and new board source files. Files added to an explicit
`target_sources()` list still need the CMakeLists edit described above.

### 9. Minimal workspaces

A reduced workspace contains only the selected board and tests. Adding a
different board or SoC requires restoring its files from the source
repository, or re-running the scaffolder with that selection and pruning
again. Adding another test for the **same** board only needs the test
directory, its `tests.cmake` hooks, and a selection entry.
