## Worked example: add an SMP 20×20 float matrix multiply test

This is a complete worked example for adding a **two-core SMP test** to the
selected board. It uses the selection id **{{EXAMPLE_SELECTION}}** and the app
`{{EXAMPLE_APP}}` as the concrete case. It touches one source directory, one
`tests.cmake` file and one selection entry.

**Goal:** generate two 20×20 `float` matrices on core 0, split the 20 output
rows across both Cortex-M33 cores, synchronise with an SIO-spinlock barrier,
print `C` on UART0, verify `sum(C)`, and end with `RESULT: PASS`.

### Step 1 — create the test source

```text
{{EXAMPLE_PATH}}/main.cpp
```

The complete file is in the workspace. Its structure is:

```cpp
#include <cmsis-plus/rtos/os.h>   // os_main, threads, OS_NCPU
#include <bsp/multicore.hpp>      // launch_core1
#include <bsp/rp2350.hpp>         // SIO_SPINLOCK0
#include <bsp/uart.hpp>
#include <hw_result.hpp>
#include <cstdint>
#include <cstdio>

using namespace os::rtos;

extern "C" {
  void port_smp_secondary_start (void);
  unsigned port_core1_stack_top (void);
  void port_smp_core0_ipi_enable (void);
}
namespace os { namespace rtos { namespace scheduler {
  extern thread* os_idle_thread_core[OS_NCPU];
} } }

namespace {
constexpr int N = 20;
float A[N][N], B[N][N], C[N][N];

// Generation-based barrier protected by SIO spinlock slot 2.
class Barrier {
  // init(count, slot), wait(): see the full file / smp-mat-test
};

Barrier g_barrier;
thread::stack::element_t worker_stacks[OS_NCPU][1024];

void* worker (void* arg) {
  const int cpu = static_cast<int> (reinterpret_cast<std::intptr_t> (arg));
  const int rows = N / OS_NCPU;
  const int first = cpu * rows;
  const int last = (cpu == OS_NCPU - 1) ? N : first + rows;

  for (int row = first; row < last; ++row)
    for (int column = 0; column < N; ++column) {
      float sum = 0.0f;
      for (int k = 0; k < N; ++k)
        sum += A[row][k] * B[k][column];
      C[row][column] = sum;
    }

  g_barrier.wait ();
  return nullptr;
}
} // namespace

int os_main (int, char*[]) {
  this_thread::thread ().cpu_affinity (1u << 0);

  for (int i = 0; i < N; ++i)
    for (int j = 0; j < N; ++j) {
      A[i][j] = float (i + 1) + float (j) * 0.25f;
      B[i][j] = float (j + 1) - float (i) * 0.125f;
    }

  g_barrier.init (OS_NCPU + 1, 2);   // main + one worker per core

  // Core-1 idle thread, registered before the launch.
  static thread::stack::element_t idle1_stack[512];
  static thread* idle1_thread_ptr;
  {
    thread::attributes attr = thread::initializer;
    attr.th_stack_address = idle1_stack;
    attr.th_stack_size_bytes = sizeof (idle1_stack);
    idle1_thread_ptr = new thread ("idle1", secondary_idle, nullptr, attr);
    os::rtos::scheduler::os_idle_thread_core[1] = idle1_thread_ptr;
  }

  multicore::launch_core1 (port_smp_secondary_start,
                           port_core1_stack_top ());
  port_smp_core0_ipi_enable ();

  for (int cpu = 0; cpu < OS_NCPU; ++cpu) {
    thread::attributes attr = thread::initializer;
    attr.th_stack_address = worker_stacks[cpu];
    attr.th_stack_size_bytes = sizeof (worker_stacks[cpu]);
    thread* t = new thread ("worker", worker,
                            reinterpret_cast<void*> (
                                static_cast<std::intptr_t> (cpu)), attr);
    t->cpu_affinity (1u << cpu);
  }

  g_barrier.wait ();    // main + both workers

  // print C rows on UART0, compute sum(C), RESULT: PASS/FAIL
  float total = 0.0f;
  for (int i = 0; i < N; ++i)
    for (int j = 0; j < N; ++j)
      total += C[i][j];
  const bool pass = (total > 950874.5f) && (total < 950875.5f);
  if (pass) hw_result::ok (); else hw_result::fail ();
  return 0;
}
```

Key points:

- `#include <cmsis-plus/rtos/os.h>` is required: it declares `os_main` with
  C linkage.
- `OS_NCPU` is **2** on the Pico 2, so the kernel builds the SMP scheduler and
  `OS_USE_SMP_SCHEDULER` is derived from the core count.
- Core 1 is started through the bootrom FIFO with
  `multicore::launch_core1()`; `os_idle_thread_core[1]` must be registered
  before the launch.
- The barrier uses **SIO hardware spinlock slot 2**. LDREX/STREX is only
  per-core on the RP2350, so a normal C++ spinlock would not synchronise the
  two cores. Slots 0 and 1 belong to the kernel and console.
- Each worker is pinned with `cpu_affinity(1u << cpu)`: worker 0 on core 0,
  worker 1 on core 1.
- `print_fixed()` avoids `%f` in newlib-nano.
- `hw_result::ok()/fail()` emits `RESULT: PASS/FAIL` over semihosting and
  exits through `SYS_EXIT`.

### Step 2 — declare the test properties

Edit `{{PORT}}/test/{{BOARD}}/tests.cmake`:

```cmake
# Keep matmul-f32-20 OUT of _single_core: it must run at OS_NCPU=2.
set (_single_core smp-test1 sc-test-ko)

# This test uses the board UART and clocks; it has no QEMU image.
set (BOARD_TEST_HWD_ONLY
     ...
     smp-test-usb-hid
     {{EXAMPLE_APP}}
     clock-test)
```

Why:

- Keeping the app out of `_single_core` makes `board_test_ncpu()` return
  `UOS_BOARD_NCPU` (2), links the board's `multicore.cpp`, and enables the SMP
  kernel path.
- `BOARD_TEST_HWD_ONLY` avoids a `-qemu` image; the test prints on the board
  UART, which QEMU's generic M33 machine does not model.

No `CMakeLists.txt` edit is needed. The port's `test/CMakeLists.txt`
discovers every directory under `test/{{BOARD}}/` that contains a `.cpp`:

```cmake
file (GLOB _test_dirs LIST_DIRECTORIES true CONFIGURE_DEPENDS "${_test_dir}/*")
...
file (GLOB _srcs CONFIGURE_DEPENDS "${_dir}/*.cpp")
if (NOT _srcs)
  continue ()
endif ()
```

### Step 3 — register the selection

The test is picked up by the globs; `./run.sh list` shows its CTest name
(`{{EXAMPLE_CTEST}}`). Add it to the configuration selection in `scaffold.json`
(`build.configurations[].tests`) to run it by default.

In a full scaffold, add the same id to `scaffold.json` (`selectedSelections`,
`selectedTests`, the platform `tests` array and the build configuration
`tests` array), or re-run the scaffolder with
`--select {{EXAMPLE_SELECTION}}`.

### Step 4 — build

```bash
cd tests
./run.sh build {{CONFIG}}
```

The build discovers the new directory and produces:

```text
tests/build/{{CONFIG}}/platform-bin/port-tests/test/{{EXAMPLE_APP}}-hwd.elf
```

### Step 5 — run on hardware

```bash
./run.sh {{CONFIG}} {{EXAMPLE_SELECTION}}
```

The test is flash-resident: OpenOCD programs it, starts both cores, and the
verdict arrives over semihosting. On UART0 you see:

```text
Scheduler: µOS++ RP2350 Cortex-M33 SMP, 2 cores, 1ms tick
...
  Pico 2 / RP2350 - {{EXAMPLE_APP}} (SMP)
  20 x 20 float matrix multiplication
  two Cortex-M33 cores, 10 rows each
...
A and B generated on core 0.
Launching core 1...
Workers running on both cores; waiting at barrier...
C =
-33.438 34.062 101.562 169.062 ...
...
-104.688 342.813 790.313 1237.813 ... 8397.813
sum(C) = 950875.008
RESULT: PASS
```

CTest reports:

```text
{{EXAMPLE_APP}}            PASS  (3s)
1/1 Test: {{EXAMPLE_CTEST}} ...   Passed    3.06 sec
```

### Step 6 — make it part of the source project

The workspace is a reduced copy. To keep the test across re-scaffolding:

1. Put the same `main.cpp` under
   `<source>/{{PORT}}/test/{{BOARD}}/{{EXAMPLE_APP}}/`.
2. Add the `BOARD_TEST_HWD_ONLY` entry to the source port's
   `test/{{BOARD}}/tests.cmake`, and keep the app out of `_single_core`.
3. Re-run the scaffolder with the selection that includes the new test.
