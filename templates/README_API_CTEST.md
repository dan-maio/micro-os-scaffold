# Writing tests with µTest++ and CTest on µOS++ boards

<p class="subtitle">A practical guide to the test framework that micro-os-scaffold adds with <code>--micro-test-plus</code>: how a test is built, run and reported, the API, and worked examples</p>

---

## 1. The big picture

Two tools work together. It helps to keep them apart in your head:

| Tool | Where it runs | What it does |
| --- | --- | --- |
| **µTest++** (`micro-test-plus`) | **inside** the test image, on the board or under QEMU | runs your checks, counts passes and failures, writes a report (TAP) |
| **CTest** (part of CMake) | on your **PC** | builds one image per test directory, starts it on the board or in QEMU, and reads the verdict |

Between them sits a small piece of glue that micro-os-scaffold generates for each
port, the **board support** (`test/mtp/mtp_board.hpp` and `.cpp`). It sends µTest++'s
output to the board's UART and to the PC (through semihosting), passes the command
line from the debugger to `main`, starts the other cores on SMP boards, and prints the
final `RESULT: PASS` or `RESULT: FAIL` line that CTest looks for.

So, in one sentence: **you write µTest++ checks in a test directory; CTest builds and
runs it; the board support connects the two.**

```text
 your PC                                    the board (or QEMU)
 ------------------------------------       -----------------------------------
 tests/run.sh  ->  CTest  ->  runner  ---->  image of test/<board>/mtp-mytest/
                              (OpenOCD          os_main()
                               or QEMU)           mtp_board::start ()
                                                  mtp_board::run ()  -> your suites
   "RESULT: PASS"  <-------- semihosting ----    mtp_board::finish ()
   .hw-logs/mtp-mytest.tap <- semihosting file   (the full TAP report)
                                     UART  ---->  your terminal (the same report)
```

---

## 2. Getting it into a workspace

µTest++ is added when the workspace is scaffolded:

```bash
cd micro-os-scaffold
node bin/scaffold.js ../ws-pico2 \
  --select cortexm-pico2.smp-test4 \
  --micro-test-plus https://github.com/micro-os-plus/micro-test-plus-xpack.git \
  --micro-test-plus-ref v6.0.0 \
  --yes
```

`--micro-test-plus` also accepts a folder (for example an existing copy of the
framework). The option is remembered in `scaffold.json`, so later runs keep it.

What you get:

| Path | What it is |
| --- | --- |
| `third_party/micro-test-plus/` | the framework, unchanged |
| `<port>/test/mtp/` | the board support: `mtp_board.hpp`, `mtp_board.cpp`, `mtp_semihosting.hpp`, `mtp_startup.hpp`, `README.md` |
| `<port>/test/<board>/tests.cmake` | a µTest++ block at the end, and one branch in the library hook that links µTest++ into every test whose directory name starts with `mtp-` |
| `<port>/test/<board>/mtp-example/` | the starter test: runtime checks and a few basics to copy from |
| `<port>/test/<board>/mtp-args/` | checks that the command line reaches `main` |
| `<port>/test/<board>/mtp-smp/` | on multi-core boards: the SMP test (affinity, locks, scheduler, speed-up) |

A board only gets µTest++ if it meets the **runtime rule**: its start-up runs the C++
static constructors, and its linker script defines a heap that `malloc`, `new` and
`sbrk` use. The scaffolder checks this in the sources and `mtp-example` checks it again
on the target.

**In a workspace scaffolded from the restructured source** (`micro-os-plus-iii/tests/`,
since 2026-11-24) the same files have other paths, and the entry point moved to the
workspace root:

| In this guide | New layout |
| --- | --- |
| `<port>/test/mtp/` | `micro-os-plus-iii/tests/mtp/` |
| `<port>/test/<board>/tests.cmake`, `.../mtp-*/` | `micro-os-plus-iii/tests/platforms/<platform>/tests/tests.cmake`, `.../tests/mtp-*/` |
| `cd tests && ./run.sh` | `./run.sh` (workspace root) |
| `tests/build/<C>/.../.qemu-logs/<test>.tap`, `.hw-logs/<test>.tap` | `micro-os-plus-iii/tests/build/<C>/mtp-reports/<platform>-<test>-qemu.tap` (`-hwd.tap`) |
| the runner scripts pass the command line | the registration helpers in `micro-os-plus-iii/tests/cmake/uos-tests-run.cmake` do (marked `SCAFFOLD µTest++`) |

Everything else in this guide (the API, the suites, the rules) is the same.

---

## 3. Your first test, step by step

**1. Copy the starter test** (any directory named `mtp-*` is a µTest++ test):

```bash
cd ws-pico2/micro-os-plus-iii-cortexm/test/pico2
cp -r mtp-example mtp-mytest
rm mtp-mytest/suite-runtime.cpp          # keep main.cpp and one suite to edit
```

**2. Edit `main.cpp`**: only the name changes.

```cpp
#include <mtp_board.hpp>

int
os_main (int argc, char* argv[])
{
  mtp_board::start ("mtp-mytest");        // the name in the report
#if defined(MTP_HAS_SMP_BOOT) && MTP_HAS_SMP_BOOT
  mtp_board::release_cores ();            // multi-core boards: start the other cores
#endif
  return mtp_board::run (argc, argv);     // run every suite, print the RESULT line
}

#include <mtp_startup.hpp>                // keep this last line as it is
```

**3. Write a suite** in `suite-basics.cpp` (rename it as you like):

```cpp
#include <mtp_board.hpp>

mt::static_suite suite_basics{
  "01 - My first suite", mtp_board::runner (), [] (mt::suite& ts) {
    ts.test ("arithmetic", [] (auto& t) {
      t.expect (mt::eq (6 * 7, 42)) << "six times seven";
      t.expect (mt::lt (1, 2)) << "one is less than two";
    });
  }
};
```

**4. Build and run** (no CMake file needs editing):

```bash
cd ws-pico2/tests
./run.sh list                    # the new test is there: cortexm-pico2-mtp-mytest-hwd
./run.sh mtp-mytest              # QEMU image if the board has one
./run.sh mtp-mytest --hwd-only   # on the board (board and probe connected)
```

**5. Read the result.** The console shows the CTest verdict. The full report is a file:

```text
tests/build/<configuration>/platform-bin/port-tests/.hw-logs/mtp-mytest.tap
```

```text
# Subtest: 01 - My first suite
    ok 1 - arithmetic # { passed, 2 checks }
ok 1 - 01 - My first suite # { passed, 2 checks in 1 test case }
# { total: 2 checks passed, 0 failed, in 1 test case, 1 test suite }
RESULT: PASS (mtp-mytest: all µTest++ checks passed, 12 ms)
```

To have `./run.sh` (without a name) run your test by default, see section 10.

---

## 4. How a test is organised

| Level | What it is | How you make one |
| --- | --- | --- |
| **Test directory** | one image, one CTest case per variant (`-qemu`, `-hwd`, `-host`) | a directory `mtp-<name>/` with `main.cpp` |
| **Suite** | a named group of test cases, a section of the report | one `mt::static_suite` per file |
| **Test case** | a named group of checks | `ts.test ("name", [] (auto& t) { ... })` |
| **Check** | one condition | `t.expect (condition) << "message";` |

**Suites register themselves.** A `static_suite` is a global object: when the image
starts, its constructor adds the suite to the runner. There is no list of suites to
keep up to date. Add a file, and its suite runs.

**Order.** The suites run sorted by name. That is why the names start with a number:
`"00 - Cores"`, `"01 - Runtime"`, `"02 - Basics"`. Inside a suite the test cases run in
the order you write them.

**One suite per file** keeps the report readable and the files small. A suite can hold
as many test cases as you like.

---

## 5. The API

The namespace alias `mt` (for `micro_os_plus::micro_test_plus`) is defined by
`mtp_board.hpp`; include that header and nothing else from the framework.

### 5.1 Suites and test cases

```cpp
mt::static_suite my_suite{ "NN - Name", mtp_board::runner (), [] (mt::suite& ts) {

  // A test case: a name and a body.
  ts.test ("name", [] (auto& t) {
    t.expect (...) << "message";
  });

  // The same body for several values: one test case per value,
  // named "name (1)", "name (2)", ...
  ts.test_each ("one case per value", { 1u, 2u, 3u },
                [] (auto& t, unsigned n) { t.expect (mt::gt (n, 0u)); });

  // A test case may itself contain test cases (they nest in the report).
  ts.test ("outer", [] (auto& t) {
    t.test ("inner", [] (auto& t2) { t2.expect (true); });
  });
} };
```

`test_each` also takes any container (`std::array`, `std::vector`, ...).

### 5.2 Checks

| Call | Meaning |
| --- | --- |
| `t.expect (cond) << "msg";` | record a pass or a failure and **continue**. Use this. |
| `t.require (cond) << "msg";` | stop on failure. These builds have **no exceptions**, so a failed `require` **aborts the whole run**, not just the test case. Avoid it on the boards. |

`cond` is a comparator from the table below, or anything that converts to `bool`
(`t.expect (ready)`, `t.expect (ptr != nullptr)`). With a comparator, a failure prints
both values; with a plain `bool`, it prints only the condition text.

The message after `<<` is optional; it may chain several values:
`t.expect (...) << "core " << n << " passed";`.

**Write the check and its message in one statement.** The result is reported at the end
of the statement; do not store it in a variable.

### 5.3 Comparators

| Comparator | True when | Example |
| --- | --- | --- |
| `mt::eq (a, b)` | `a == b` | `mt::eq (count, 3u)` |
| `mt::ne (a, b)` | `a != b` | `mt::ne (ptr, nullptr)` |
| `mt::lt (a, b)` | `a < b` | `mt::lt (elapsed, 100u)` |
| `mt::le (a, b)` | `a <= b` | `mt::le (used, size)` |
| `mt::gt (a, b)` | `a > b` | `mt::gt (rate, 0u)` |
| `mt::ge (a, b)` | `a >= b` | `mt::ge (speedup_x100, 320u)` |
| `mt::approx (a, b, tol)` | `|a - b| <= tol` | `mt::approx (0.1 + 0.2, 0.3, 1e-9)` |
| `mt::all_of (c1, c2, ...)` | every condition | `mt::all_of (mt::ge (x, lo), mt::le (x, hi))` |
| `mt::any_of (c1, c2, ...)` | at least one | `mt::any_of (mt::eq (r, mtp::ok), mt::eq (r, mtp::code (EAGAIN)))` |
| `mt::negate (c)` | `c` is false | `mt::negate (mt::eq (a, b))` |

**Text and pointers.** A `const char*` (or `char*`) is compared as a **C string**, by
its characters. To compare **addresses**, convert them to integers first:

```cpp
t.expect (mt::le (reinterpret_cast<std::uintptr_t> (p),
                  reinterpret_cast<std::uintptr_t> (&_Heap_Limit)));
```

(Comparing two `char*` that point into raw memory reads it as text until a zero byte,
which can take minutes and print garbage.)

### 5.4 Kernel result codes

Kernel calls return a `result_t`: `result::ok` or a POSIX error number. The board support
gives them printable names:

```cpp
t.expect (mt::eq (sem.post (), mtp::ok)) << "post";
t.expect (mt::eq (sem.try_wait (), mtp::code (EWOULDBLOCK))) << "empty";
t.expect (mt::eq (mx.timed_lock (10), mtp::code (ETIMEDOUT))) << "busy";
```

### 5.5 The board support, `mtp_board`

**Running a test**

| Function | Use |
| --- | --- |
| `start ("name")` | first call in `os_main`: sets up the console, prints a banner |
| `run (argc, argv)` | parses the command line, runs every suite, ends with the RESULT line; returns the exit code |
| `runner ()` | the runner your `static_suite`s register with |
| `initialise (argc, argv)` | only if you must do something between the set-up and the suites (then call `mtp_board::runner ().run_suites ()` and `finish ()` yourself) |
| `finish (code)` | prints `RESULT: PASS` or `RESULT: FAIL (...)` and ends the run (called by `run`) |
| `skip ("why")` | ends the run as `RESULT: SKIP (why)`, which counts as a pass |
| `flush ()` | sends what is waiting to the PC now |
| `elapsed_ms ()` | milliseconds since `start ()` |
| `argument_count ()`, `argument (i)` | the raw command line, for tests of the transport itself |

**Multi-core boards** (available when `MTP_HAS_SMP_BOOT` is set):

| Function | Use |
| --- | --- |
| `release_cores ()` | start the other cores and wait for them; pins the caller to core 0 |
| `cores_joined ()`, `cores_summary ()` | did every core join, and a printable summary |
| `cpu_id ()` | the core running the caller, `0 .. OS_NCPU-1` |
| `irqs_masked ()` | is this core's interrupt mask set |
| `spinlock` | a lock between cores, for the test's own data (`lock`, `try_lock`, `unlock`) |
| `atomic_add (&x, n)` | add `n` to `x` so no other core can split the step; returns the old value |
| `sync_method ()` | which hardware mechanism the two above use on this board |
| `cpu_relax ()` | a "spinning" hint for busy-wait loops |

### 5.6 Compile-time facts you can test

| Macro | Meaning |
| --- | --- |
| `HW_BUILD` | this image runs on the board |
| `QEMU_BUILD` | this image runs under QEMU |
| `OS_NCPU` | number of cores the kernel was built for |
| `MTP_HAS_SMP_BOOT` | 1 or 2 when the board support can start other cores, else 0 |
| `MTP_CONSOLE` | how output reaches the PC: 1 (A-profile), 2 (Cortex-M), 3 (the host) |

---

## 6. Running tests

All runs go through one script, `tests/run.sh`. It always builds first.

| Command | What it does |
| --- | --- |
| `./run.sh` | build, then run the selected tests (hardware cases only if nothing else exists) |
| `./run.sh list` | list every CTest case; `*` marks the selected ones |
| `./run.sh mtp-mytest` | run one test (all its variants, except hardware) |
| `./run.sh mtp-mytest --hwd-only` | run only its hardware case |
| `./run.sh --hwd` | include the hardware cases |
| `./run.sh all` | everything registered, hardware included |
| `./run.sh -R 'regex'` | any CTest regular expression |
| `./run.sh build`, `./run.sh clean` | build only; remove the build tree |
| `-c <configuration>` | another configuration of the workspace |

A test directory becomes one CTest case per variant: `<platform>-<directory>-qemu`,
`-hwd` (board) or `-host` (native). Boards without a QEMU image only have `-hwd`.

**Results are files:**

| File | Content |
| --- | --- |
| `build/<configuration>/ctest.xml` | the JUnit summary (CTest keeps a 1 KiB snippet per test) |
| `build/<configuration>/ctest.log` | the full CTest output |
| `.hw-logs/<test>.tap`, `.qemu-logs/<test>.tap`, `.host-logs/<test>.tap` | the complete µTest++ report, next to the runner's log |

**Command line.** The runner passes a command line to the image, through the debugger
(`arm semihosting_cmdline`) or QEMU (`-semihosting-config ...,arg=`). `run ()` gives it
to µTest++, which understands:

| Option | Effect |
| --- | --- |
| `--output-file <path>` | write the complete TAP report to a file (the runners always add it) |
| `--filter=<pattern>` | run only the suites and test cases whose name matches |
| `--list` | list the suites and test cases without running them |
| `--verbose`, `--quiet`, `--silent` | more or less output |

**Where the output goes on a board.** The report is written to the board's UART at once
(open your terminal on it), and to the PC through semihosting, in batches: every
semihosting call halts the cores while the debugger serves it, so the board support
sends text at the end of each suite. Only the RESULT line and the TAP file are needed by
CTest.

---

## 7. Examples

### 7.1 Kernel objects

```cpp
#include <mtp_board.hpp>
#include <cerrno>

using namespace os::rtos;

mt::static_suite suite_kernel{
  "01 - Kernel objects", mtp_board::runner (), [] (mt::suite& ts) {

    ts.test ("message queue keeps order", [] (auto& t) {
      message_queue_typed<std::uint64_t> q{ "q", 4 };  // messages >= sizeof (void*)
      for (std::uint64_t v = 1; v <= 3; ++v)
        {
          t.expect (mt::eq (q.send (&v), mtp::ok)) << "send " << v;
        }
      std::uint64_t got = 0;
      t.expect (mt::eq (q.receive (&got), mtp::ok));
      t.expect (mt::eq (got, std::uint64_t{ 1 })) << "first in, first out";
    });

    ts.test ("mutex try_lock", [] (auto& t) {
      mutex mx{ "mx" };
      t.expect (mt::eq (mx.try_lock (), mtp::ok)) << "free";
      t.expect (mt::eq (mx.unlock (), mtp::ok));
    });
  }
};
```

### 7.2 A second thread, and waiting with a timeout

```cpp
#include <mtp_board.hpp>

using namespace os::rtos;

namespace
{
  semaphore_binary* g_done = nullptr;

  void*
  worker (void*)
  {
    sysclock.sleep_for (5);   // 5 ticks
    (void)g_done->post ();
    return nullptr;
  }
}

mt::static_suite suite_threads{
  "02 - Threads", mtp_board::runner (), [] (mt::suite& ts) {
    ts.test ("a thread signals back", [] (auto& t) {
      semaphore_binary done{ "done", 0 };
      g_done = &done;
      thread::attributes attr;
      attr.th_stack_size_bytes = 4096;
      thread th{ "worker", worker, nullptr, attr };
      t.expect (mt::eq (done.timed_wait (100), mtp::ok)) << "within 100 ticks";
      (void)th.join ();
    });
  }
};
```

### 7.3 Every core at once (SMP boards)

```cpp
#include <mtp_board.hpp>

using namespace os::rtos;

namespace
{
  volatile std::uint32_t g_count = 0;

  void*
  add_many (void*)
  {
    for (int i = 0; i < 10000; ++i)
      {
        (void)mtp_board::atomic_add (&g_count, 1);   // safe across cores
      }
    return nullptr;
  }
}

mt::static_suite suite_cores_add{
  "03 - Every core", mtp_board::runner (), [] (mt::suite& ts) {
    ts.test ("no lost update", [] (auto& t) {
      g_count = 0;
      thread* th[OS_NCPU] = {};
      for (unsigned c = 0; c < OS_NCPU; ++c)
        {
          thread::attributes attr;
          attr.th_stack_size_bytes = 4096;
          attr.th_cpu_affinity = 1u << c;              // pin to core c
          th[c] = new thread{ "add", add_many, nullptr, attr };
        }
      for (auto* p : th)
        {
          (void)p->join ();
          delete p;
        }
      t.expect (mt::eq (static_cast<std::uint32_t> (g_count),
                        static_cast<std::uint32_t> (OS_NCPU * 10000)))
          << "through " << mtp_board::sync_method ();
    });
  }
};
```

### 7.4 A test that needs real hardware

```cpp
int
os_main (int argc, char* argv[])
{
  mtp_board::start ("mtp-sdcard");
#if !defined(HW_BUILD)
  return mtp_board::skip ("QEMU models no SD card");
#else
  return mtp_board::run (argc, argv);
#endif
}
```

### 7.5 A test that is not named `mtp-*`

The `mtp-*` naming is only a convenience: the library hook links µTest++ to those
directories. Any test can use it with one branch in the board's `tests.cmake`:

```cmake
function (board_test_libs _app _out)
  if (_app STREQUAL "my-stdcpp-test")
    set (${_out} uos-micro-test-plus PARENT_SCOPE)
    return ()
  endif ()
  # ... the existing branches ...
endfunction ()
```

---

## 8. Rules that save time

1. **Use `expect`, not `require`.** Without exceptions a failed `require` ends the
   whole run.
2. **Compare addresses as integers** (`std::uintptr_t`), never as `char*`.
3. **One suite per file**, named `"NN - Name"` for the order.
4. **Pin threads to a core** (`th_cpu_affinity = 1u << n`) when a check depends on
   where they run. `release_cores ()` keeps the runner on core 0.
5. **Shared counters between cores:** use the kernel (mutex, critical section),
   `mtp_board::spinlock` or `mtp_board::atomic_add ()`. On the RP2040/RP2350,
   `std::atomic` read-modify-write (`fetch_add`, `exchange`) does **not** exclude the
   other core.
6. **Do not wait on the clock inside a scheduler lock.** On the RP2350,
   `scheduler::critical_section` masks this core's interrupts and the clock stops;
   bound such waits by a loop count.
7. **Message queues** need messages of at least `sizeof (void*)` (8 bytes on AArch64).
8. **Thread stacks:** 4 KiB is enough on Cortex-M for simple bodies; use 16 KiB on
   AArch64, and more for anything that formats text.
9. **Keep timing checks loose.** Ticks are 1 ms, and semihosting halts the cores.

---

## 9. Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| The board boots to `main ()` and prints nothing | the UART is not switched on (STM32 boards: the scaffolder sets `MTP_UART_INIT`; a hand-made board support must call `uart::init`) |
| `ok zu - ...` in the report | newlib-nano printf without `%zu`: the scaffolder's printf wrappers are missing (`MTP_NANO_PRINTF`) |
| A run takes minutes and prints garbage | a `char*` compared as a string (rule 2) |
| The run hangs inside a test | waiting on `sysclock` inside a scheduler lock (rule 6), or a thread joining itself |
| `RESULT: FAIL` with no failed check | a failed `require`, or the image crashed: look at the UART |
| `watchdog reset FAILED -- OpenOCD did not reach the board` | probe or wiring: the board's JTAG/SWD does not answer (see the workspace README for the probe) |
| `undefined reference to _write` (AArch32) | an old board support: re-scaffold; the current one provides the system calls |

---

## 10. Running your test by default, and keeping it

`./run.sh` without a name runs the tests selected when the workspace was scaffolded,
plus the starter tests. A test you add by hand is built and listed, and runs when you
name it (`./run.sh mtp-mytest`).

A **re-scaffold** rebuilds the workspace from the source repository and removes test
folders it does not know, unless they are **local tests** (new layout):

1. list the folder name in `scripts/local-tests.txt` at the workspace root (one name per
   line; `#` starts a comment; `keep <path>` keeps any other file or folder);
2. put its CMake wiring in `micro-os-plus-iii/tests/platforms/<platform>/tests/tests.local.cmake`,
   next to `tests.cmake`, as `*_local` twins of the hooks:

   ```cmake
   function (board_test_libs_local _app _out)
     if (_app STREQUAL "my-test")
       set (${_out} uos-micro-test-plus PARENT_SCOPE)
     endif ()
   endfunction ()
   ```

   A name starting with `mtp-` gets µTest++ without this; a local test needs the file only
   for what the generated hooks do not give it.

`./run.sh` then runs the test by default, `./run.sh list` marks it `L`, and a re-scaffold
keeps the folder, `tests.local.cmake` and the list byte for byte. Tests meant to last
belong in the source repository (then select them when scaffolding).

In an old-layout workspace there are no local tests: keep your tests in the source
repository, or in version control next to the workspace.

---

## 11. Reference material

- The framework's own documentation: <https://micro-os-plus.github.io/micro-test-plus-xpack/>
- The generated `<port>/test/mtp/README.md`: the defines of this port's board support.
- `tests/ARCHITECTURE.md` in a workspace of the old layout: how the harness, the runners and
  CTest fit together. A workspace of the current layout has no such file; its `README.md`
  describes the layout, and `micro-os-plus-iii/tests/cmake/` holds the harness.
- `scaffold.md`, chapter 13: how the scaffolder integrates µTest++, and the results measured on the boards.
- Worked examples in the scaffolder: `templates/micro-test-plus/` (the starter tests),
  `examples/cortexm-weactf411-mtp-spi-flash/` (a test of one board's own hardware).
