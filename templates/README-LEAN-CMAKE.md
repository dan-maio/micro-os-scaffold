## Adding new functionality to this workspace

Everything is compiled from source: the kernel (`{{KERNEL}}/`) and the port
(`{{PORT}}/`) export CMake INTERFACE targets, and the test executable compiles
their sources together with its own. There is no library to rebuild or install;
after any change run `./build.sh` (or `./test.sh`, which builds first).

### Which file picks up what

| You add | Put it in | Picked up by | Edit a CMake file? |
| --- | --- | --- | --- |
| `.cpp` of the test | `{{PORT}}/test/{{BOARD}}/{{APP}}/` | `test/CMakeLists.txt` globs `<app>/*.cpp` | no |
| header of the test | the same directory | the directory is on the include path | no |
| `.c` / `.S` of the test | the same directory | not globbed | `board_test_sources()` in `test/{{BOARD}}/tests.cmake` |
| code shared by all tests of the board | `{{PORT}}/test/{{BOARD}}/src/*.cpp`, `include/` | globbed, on the include path | no |
| board code (driver, start-up) | `{{PORT}}/test/boards/{{BOARD}}/src/` | `{{PORT}}/CMakeLists.txt` globs {{BOARD_GLOB}} | no |
| board glue used by some tests only | `{{PORT}}/test/boards/{{BOARD}}/glue/` | named, never globbed | `board.cmake` variable + `board_test_sources()` |
| port source | `{{PORT}}/src/` | explicit list | `target_sources ({{PORT_INTERFACE}} ...)` in `{{PORT}}/CMakeLists.txt` |
| kernel source | `{{KERNEL}}/src/` | explicit list | `target_sources (micro-os-plus-iii-interface ...)` in `{{KERNEL}}/CMakeLists.txt` |
| a library | anywhere in the workspace | an INTERFACE or STATIC target | `{{LIBS_HOOK}}()` in `tests.cmake` |
| a new test | `{{PORT}}/test/{{BOARD}}/<name>/` | globbed: one executable and one CTest case per directory | only for non-default settings |

The globs use `CONFIGURE_DEPENDS`, and `build.sh` re-runs CMake every time, so
a new file or directory is noticed without removing the build tree.

### 1. Add a source file to the test

```bash
cd {{PORT}}/test/{{BOARD}}/{{APP}}
$EDITOR filter.cpp filter.hpp          # #include "filter.hpp" from main.cpp
cd ../../../../tests && ./build.sh
```

A C or assembly file is not globbed. Name it in the board's
`{{PORT}}/test/{{BOARD}}/tests.cmake`:

{{SOURCES_HOOK}}

Code that several tests of this board use goes to
`{{PORT}}/test/{{BOARD}}/src/` (sources) and `{{PORT}}/test/{{BOARD}}/include/`
(headers); both are compiled into every test of the board.

### 2. Per-test build settings

`{{PORT}}/test/{{BOARD}}/tests.cmake` is included by `{{PORT}}/test/CMakeLists.txt`
and holds everything a directory listing cannot express. Each hook receives the
test name in `_app` and returns a list in `_out`:

{{HOOK_TABLE}}

{{HOOK_NOTE}}

Example, a definition and an option for one test:

```cmake
function (board_test_defines _app _out)
  if (_app STREQUAL "{{APP}}")
    set (${_out} MATRIX_SIZE=64 USE_FAST_PATH PARENT_SCOPE)
  else ()
    set (${_out} "" PARENT_SCOPE)
  endif ()
endfunction ()
```

### 3. Add a library

**A library of your own sources.** Keep it inside the workspace, declare it
once in `tests.cmake`, and return it from `{{LIBS_HOOK}}()`:

```cmake
# {{PORT}}/test/{{BOARD}}/tests.cmake
if (NOT TARGET mylib)
  add_library (mylib INTERFACE)
  target_sources (mylib INTERFACE
    "${CMAKE_CURRENT_LIST_DIR}/../../libs/mylib/src/mylib.cpp")
  target_include_directories (mylib INTERFACE
    "${CMAKE_CURRENT_LIST_DIR}/../../libs/mylib/include")
  target_compile_definitions (mylib INTERFACE MYLIB_STATIC)
endif ()

function ({{LIBS_HOOK}} _app _out)
  if (_app STREQUAL "{{APP}}")
    set (${_out} mylib PARENT_SCOPE)
  else ()
    set (${_out} "" PARENT_SCOPE)
  endif ()
endfunction ()
```

An INTERFACE library is compiled with the test's own flags (CPU, FPU,
`OS_NCPU`), which is what a bare-metal image needs. `{{PORT}}/libs/mylib/` is
only a suggested place; any path works.

**A pre-built archive.** Return its absolute path, and add its headers with
`board_test_includes()`. It must be built with the board's flags
({{BOARD_FLAGS}}):

```cmake
set (${_out} "${CMAKE_CURRENT_LIST_DIR}/../../libs/vendor/libvendor.a" PARENT_SCOPE)
```

**An optional kernel component.** The kernel exports, besides
`micro-os-plus::iii`, the targets {{KERNEL_TARGETS}}. Return the one you need
from `{{LIBS_HOOK}}()`; the test already links `{{PORT_LIB}}`.

**A portable harness suite or an xPack.** {{SUITE_NOTE}}

### 4. Add a new test

A test is a directory with at least one `.cpp` file; there is no test list to
edit.

```bash
cp -r {{PORT}}/test/{{BOARD}}/{{APP}} {{PORT}}/test/{{BOARD}}/my-test
$EDITOR {{PORT}}/test/{{BOARD}}/my-test/main.cpp
cd tests
./test.sh {{CONFIG}} my-test
```

- The executable is `my-test-<variant>` and the CTest case is
  `{{PLATFORM}}-my-test-<variant>`; both are created by the globs in
  `{{PORT}}/test/CMakeLists.txt` and `tests/platforms/{{PLATFORM}}/CMakeLists.txt`.
- {{VARIANT_NOTE}}
- A copied test does not inherit the settings of the original: wherever
  `tests.cmake` names `{{APP}}` (a list, or a branch of a hook: linker script,
  sources, libraries, CPU count), add `my-test` too if it needs the same.
- `./test.sh {{CONFIG}} --list` shows every registered case.
- To make the new test part of the default run (`./test.sh` with no test
  name), add one line to `tests/scripts/selected-tests.txt`; the three fields
  are separated by tabs:

  ```text
  {{CONFIG}}	my-test	{{NEW_CTEST}}
  ```

- A test reports its verdict by printing `RESULT: PASS` or `RESULT: FAIL`;
  that line is what the runner looks for.

### 5. Kernel and port sources

The kernel is complete in `{{KERNEL}}/`. A new kernel or port source file is
not globbed; add it to the interface target:

```cmake
# {{KERNEL}}/CMakeLists.txt
target_sources (micro-os-plus-iii-interface INTERFACE src/rtos/os-new-feature.cpp)

# {{PORT}}/CMakeLists.txt
target_sources ({{PORT_INTERFACE}} INTERFACE src/new-port-file.cpp)
```

Headers go under the existing `include/` directories, which are already on the
interface include path.

### 6. Build and run scripts

| Script | What it does | When to edit |
| --- | --- | --- |
| `tests/scripts/env.sh` | tool paths and `PATH`, relative to the workspace | to change a tool, or export `UOS_TOOL_<NAME>` before calling the scripts |
| `tests/build.sh` | `cmake -S tests -B tests/build/<configuration> -G Ninja`, then the build | to pass another `-D` option to CMake (append to `CMAKE_ARGS`) |
| `tests/test.sh` | builds, then runs CTest for the named tests | normally never |
| `tests/scripts/selected-tests.txt` | the tests `./test.sh` runs by default | when a new test should run by default |
| `tests/platforms/{{PLATFORM}}/CMakeLists.txt` | registers the CTest cases and the command that runs each | to change the run command, its arguments or the timeout |
{{RUNNER_ROWS}}

```bash
cd tests
./build.sh                      # configure and build
./build.sh --clean              # remove the build tree
./test.sh                       # build, run the selected test
./test.sh {{CONFIG}} my-test    # build, run one test by name
./test.sh --list                # the registered CTest cases
{{HWD_ONLY_LINE}}./test.sh --all{{HWD_FLAG}}               # everything that is registered
```

{{RUN_NOTE}}

### 7. Keep the changes

Re-running the scaffolder on this folder copies the source repositories over it
and removes every test directory that is not selected, **including the ones
added here**. Copy new work back to the source repository
(`{{SOURCE_PORT}}`) before regenerating, or scaffold into another folder.
