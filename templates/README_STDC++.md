# Standard C++ threads on µOS++: the StateOS stdc++ package

<p class="subtitle">How to use std::thread, mutexes, condition variables, futures, the C++20 synchronisation classes and the chrono clocks on µOS++ III boards, with the package that micro-os-scaffold adds with <code>--stdcpp</code></p>

---

## 1. Why this package exists

The C++ standard library that comes with a bare-metal GCC (`arm-none-eabi`,
`aarch64-none-elf`) is built **without a thread model**: there is no operating system
underneath it. So, out of the box, on a µOS++ board:

- `<thread>`, `std::mutex`'s timed parts, `std::condition_variable`, `std::call_once`
  and `<future>` are disabled or do not link;
- `std::chrono::steady_clock::now ()` has no clock to read;
- `thread_local` has no thread to belong to;
- C++20 `<barrier>`, `<latch>` and `<semaphore>` are missing or fall back to busy
  waiting.

The **StateOS stdc++ package**, adapted to µOS++ III, fills these gaps by implementing
the small layer libstdc++ expects from an operating system (the "gthread" layer) on top
of the µOS++ kernel objects. Your code stays standard C++: the same source compiles
on a PC and on the board.

```cpp
#include <thread>
#include <future>

int answer ()
{
  std::future<int> f = std::async (std::launch::async, [] { return 6 * 7; });
  return f.get ();   // 42, computed by another µOS++ thread
}
```

It has been verified with the same test suites on:

| Board | Cores | Result |
| --- | --- | --- |
| Raspberry Pi 4 B (AArch64, Cortex-A72) | 4 | 75/75 checks on the board |
| Raspberry Pi Zero 2 W (AArch32, Cortex-A53) | 4 | 75/75 on the board |
| Raspberry Pi Pico 2 (RP2350, Cortex-M33) | 2 | 75/75 on the board; single-core under QEMU |
| WeAct F411CE (STM32F411, Cortex-M4F) | 1 | the same suites, on the board |

---

## 2. Getting it into a workspace

Add `--stdcpp` when scaffolding. With `--micro-test-plus` as well, you also get a
ready-made test:

```bash
cd micro-os-scaffold
node bin/scaffold.js ../ws-rpi4b \
  --select aarch64-rpi4b.clock-test \
  --micro-test-plus https://github.com/micro-os-plus/micro-test-plus-xpack.git \
  --micro-test-plus-ref v6.0.0 \
  --stdcpp --yes
cd ../ws-rpi4b/tests && ./run.sh mtp-stdcpp
```

| Option | Effect |
| --- | --- |
| `--stdcpp` | add the package bundled with the scaffolder (the verified copy) |
| `--stdcpp-from <folder or git URL>` | take the package from somewhere else |
| `--stdcpp-ref <tag or branch>` | what to clone when `--stdcpp-from` is a git URL |
| `--no-stdcpp` | remove it from a workspace that has it |

The choice is recorded in `scaffold.json` and kept by later runs.

What the workspace gets:

| Path | What it is |
| --- | --- |
| `third_party/stateos-stdc++/` | the package (headers, sources, its own `README.md` and licences) |
| `<port>/test/<board>/tests.cmake` | a `stateos-stdc++` block that makes the library available, and a hook branch for `mtp-stdcpp` |
| `<port>/test/<board>/mtp-stdcpp/` | the test: six suites that exercise every part (with `--micro-test-plus`) |

---

## 3. Using it in your own test

The package is a CMake **INTERFACE library** named `stateos-stdc++`. A test uses it by
returning that name from the board's library hook in `tests.cmake`. Nothing else is
needed: the include directory, the define and the sources come with it.

```cmake
function (board_test_libs _app _out)
  # My test uses standard C++ threads.
  if (_app STREQUAL "my-threads-test")
    set (${_out} stateos-stdc++ PARENT_SCOPE)
    return ()
  endif ()
  # A µTest++ test that also uses them: link both.
  if (_app STREQUAL "mtp-my-threads")
    set (${_out} stateos-stdc++ uos-micro-test-plus PARENT_SCOPE)
    return ()
  endif ()
  # ... the existing branches ...
endfunction ()
```

Put your branch **first** in the function: the generated µTest++ branch for `mtp-*`
returns early, so a branch placed after it never runs for an `mtp-*` name.

Then write ordinary C++:

```cpp
#include <cmsis-plus/rtos/os.h>
#include <thread>

int
os_main (int, char*[])
{
  int result = 0;
  std::thread worker ([&result] { result = 42; });
  worker.join ();
  return result == 42 ? 0 : 1;
}
```

`os_main` runs on the kernel's main thread. Everything below works from there and from
any thread it starts.

---

## 4. What you can use

| Header | Available | Notes |
| --- | --- | --- |
| `<thread>` | `std::thread`, `std::jthread`, `std::this_thread::get_id/yield/sleep_for/sleep_until`, `std::stop_token` | each `std::thread` is a µOS++ thread (section 7) |
| `<mutex>` | `mutex`, `recursive_mutex`, `timed_mutex`, `recursive_timed_mutex`, `lock_guard`, `unique_lock`, `scoped_lock`, `call_once` | on µOS++ mutexes |
| `<shared_mutex>` | `shared_mutex`, `shared_lock` | readers together, a writer alone |
| `<condition_variable>` | `condition_variable`, `condition_variable_any`, `notify_all_at_thread_exit` | timed waits use the kernel clock |
| `<future>` | `promise`, `future`, `shared_future`, `packaged_task`, `async` (both launch policies), `set_value_at_thread_exit` | `std::launch::async` starts a new thread per call |
| `<semaphore>` | `counting_semaphore`, `binary_semaphore` | the package's own, on the kernel's semaphore |
| `<latch>` | `latch` | on a µOS++ mutex and condition variable |
| `<barrier>` | `barrier` (with a completion function) | see the rule in section 8 |
| `<chrono>` | `steady_clock`, `system_clock`, every duration and `_ms`/`_s` literal | both clocks are the kernel's tick, 1 ms |
| `thread_local` | yes | emulated (section 7) |
| `<atomic>` | the toolchain's own | see section 8 for the RP2040/RP2350 |

---

## 5. Examples

Each example is taken from, or follows, the verified suites in
`templates/stdcpp/mtp-stdcpp/`. They use `using namespace std::chrono_literals;` for
`10ms`, `500ms`.

### 5.1 Threads: join, detach, jthread

```cpp
#include <thread>
#include <atomic>

void
threads ()
{
  int value = 0;
  std::thread t ([&value] { value = 1; });
  t.join ();                                     // wait for it to finish

  std::thread d ([] { /* runs on its own */ });
  d.detach ();                                   // its memory is reclaimed later

  std::atomic<bool> stopped{ false };
  {
    std::jthread worker ([&] (std::stop_token token) {
      while (!token.stop_requested ())
        {
          std::this_thread::sleep_for (1ms);
        }
      stopped = true;
    });
    // the jthread asks the worker to stop and joins it here, at scope exit
  }
}
```

### 5.2 Mutexes and call_once

```cpp
#include <mutex>

std::mutex m;
int shared_counter = 0;

void
add_one ()
{
  std::lock_guard<std::mutex> lock (m);          // unlocks at the end of the scope
  ++shared_counter;
}

std::timed_mutex tm;

bool
try_for_a_while ()
{
  if (tm.try_lock_for (10ms))                    // wait at most 10 ms
    {
      tm.unlock ();
      return true;
    }
  return false;
}

std::once_flag once;

void
init_once ()
{
  std::call_once (once, [] { /* runs exactly once, whatever thread calls first */ });
}
```

### 5.3 Condition variable

```cpp
#include <condition_variable>
#include <mutex>

std::mutex m;
std::condition_variable cv;
bool ready = false;

void
producer ()
{
  {
    std::lock_guard<std::mutex> lock (m);
    ready = true;
  }
  cv.notify_one ();
}

bool
consumer ()
{
  std::unique_lock<std::mutex> lock (m);
  // waits until ready is true, or 500 ms pass; the predicate also guards
  // against spurious wake-ups
  return cv.wait_for (lock, 500ms, [] { return ready; });
}
```

### 5.4 Futures: promise, async, packaged_task

```cpp
#include <future>
#include <thread>

int
futures ()
{
  // A promise: one thread sets the value, another waits for it.
  std::promise<int> p;
  std::future<int> f = p.get_future ();
  std::thread t ([&p] { p.set_value (7); });
  int a = f.get ();                              // 7
  t.join ();

  // async on another thread.
  std::future<int> g = std::async (std::launch::async, [] { return 6 * 7; });

  // deferred: runs in this thread, when get () is called.
  std::future<int> h = std::async (std::launch::deferred, [] { return 1; });

  // packaged_task: a callable whose result goes to a future.
  std::packaged_task<int (int)> task ([] (int x) { return x * 2; });
  std::future<int> r = task.get_future ();
  std::thread u (std::move (task), 21);
  u.join ();

  return a + g.get () + h.get () + r.get ();     // 7 + 42 + 1 + 42
}
```

`future::wait_for (0ms)` tells you whether the value is there without blocking
(`std::future_status::ready` or `timeout`).

### 5.5 C++20 semaphores, latch and barrier

```cpp
#include <barrier>
#include <latch>
#include <semaphore>
#include <thread>

void
sync ()
{
  // Ping-pong between two threads.
  std::binary_semaphore ping (0), pong (0);
  std::thread th ([&] { ping.acquire (); pong.release (); });
  ping.release ();
  bool answered = pong.try_acquire_for (500ms);
  th.join ();

  // A latch: everyone waits until three arrivals.
  std::latch gate (3);
  std::thread a ([&] { gate.arrive_and_wait (); });
  std::thread b ([&] { gate.arrive_and_wait (); });
  gate.arrive_and_wait ();
  a.join ();
  b.join ();

  // A barrier: three threads meet; the completion runs once per phase.
  int phases = 0;
  std::barrier meet (3, [&] () noexcept { ++phases; });
  std::thread c ([&] { meet.arrive_and_wait (); });
  std::thread d ([&] { meet.arrive_and_wait (); });
  meet.arrive_and_wait ();
  c.join ();
  d.join ();
  (void)answered;
}
```

### 5.6 Clocks and sleeping

```cpp
#include <chrono>
#include <thread>

long
measure ()
{
  auto start = std::chrono::steady_clock::now ();
  std::this_thread::sleep_for (20ms);
  auto took = std::chrono::steady_clock::now () - start;
  return std::chrono::duration_cast<std::chrono::milliseconds> (took).count ();  // about 20
}
```

### 5.7 thread_local

```cpp
#include <thread>

thread_local int per_thread = 0;   // every thread has its own copy

void
tls ()
{
  per_thread = 1;                   // this thread's copy
  std::thread t ([] { per_thread = 2; });   // the new thread's copy
  t.join ();
  // here per_thread is still 1
}
```

---

## 6. Testing it: the `mtp-stdcpp` test

With `--micro-test-plus`, `mtp-stdcpp` runs six suites, 75 checks on a multi-core board:

| Suite | Checks |
| --- | --- |
| 01 std::thread and TLS | create, join, detach, `jthread`, ids, yield, sleep, `thread_local` |
| 02 promise and future | value, void, `wait_for` status, `shared_future` |
| 03 packaged_task and async | deferred and async, `set_value_at_thread_exit` |
| 04 mutexes and call_once | `lock_guard`, timed, recursive, `call_once` |
| 05 condition variable and C++20 sync | `condition_variable`, semaphores, latch, barrier, `shared_mutex` |
| 06 chrono | the two clocks, sleeps, duration conversions |

On a multi-core board the other cores join the scheduler first ("00 - Cores"), so the
threads really run in parallel. Run it with `./run.sh mtp-stdcpp` (QEMU) or
`./run.sh mtp-stdcpp --hwd-only` (board). `templates/README_API_CTEST.md` explains how
µTest++ tests work.

---

## 7. How it works, in short

- **The gthread layer.** libstdc++ calls a small set of functions for everything it
  needs from an OS: `__gthread_create`, `__gthread_mutex_lock`, `__gthread_cond_wait`,
  and so on. The package implements them (`src/gthread.cc`) with µOS++ objects:
  `os::rtos::thread`, `mutex`, `mutex_recursive`, `condition_variable`.
- **Header order.** The package's `include/` directory comes **before** the toolchain's
  C++ headers. That way `<bits/gthr-default.h>`, `<barrier>`, `<latch>` and
  `<semaphore>` are the package's versions. The library also defines
  `_GLIBCXX_HAS_GTHREADS=1`, which switches on the thread parts of libstdc++.
- **Threads.** A `std::thread` is an `os::rtos::thread` created on the free store with
  normal priority and a fixed stack: **16 KiB on AArch64, 4 KiB elsewhere**. A detached
  thread is remembered (up to eight at a time) and deleted once the kernel reports it
  finished.
- **Clocks.** `steady_clock` and `system_clock` both read the kernel's system clock:
  1 ms ticks since boot. There is no wall-clock time unless your application sets one.
- **thread_local.** Emulated (`src/emutls.cc`): each variable is allocated per thread on
  first use. It works everywhere, but costs a lookup per access.
- **Sources.** The package is an INTERFACE library: its seven `.cc` files are compiled
  into each test that links it, with that test's flags (CPU, FPU, core count).

The package's own `third_party/stateos-stdc++/README.md` describes each file.

---

## 8. Limits and rules

1. **Fixed thread stacks.** `std::thread` cannot choose its stack size, priority or core.
   When you need them, create an `os::rtos::thread` with `thread::attributes`
   (`th_stack_size_bytes`, `th_priority`, `th_cpu_affinity`). Mixing both kinds of thread
   in one program is fine.
2. **Deep recursion or big local arrays** in a `std::thread` body need more than 4 KiB on
   Cortex-M: move the data to the heap, or use an `os::rtos::thread`.
3. **No exceptions.** These builds have none, so an error that the standard reports by
   throwing (for example `std::future_error` from a second `get ()`) ends the program.
   Check before you call.
4. **The barrier's completion function** runs with the barrier's internal mutex held:
   it must not call the barrier again.
5. **RP2040/RP2350:** `std::atomic` loads and stores are fine, but read-modify-write
   (`fetch_add`, `exchange`, `compare_exchange`) does **not** exclude the other core. For a
   value two cores update, use a `std::mutex` (or the µTest++ board support's
   `mtp_board::atomic_add ()` in tests).
6. **Time is in 1 ms ticks.** `sleep_for (100us)` sleeps at least one tick. Timeouts round
   up to whole ticks.
7. **`std::async (std::launch::async, ...)`** starts a new thread each call. In a loop,
   prefer a few long-lived threads.
8. **Heap.** Threads, futures and `thread_local` blocks come from the free store, so the
   board must give the heap to µOS++ at start-up. Every µTest++ board does.

---

## 9. Mixing with the µOS++ API

A `std::thread` **is** a µOS++ thread, so the kernel API works on it:

```cpp
#include <cmsis-plus/rtos/os.h>
#include <thread>

void
pin_myself ()
{
  // From inside a std::thread: move it to core 1.
  os::rtos::this_thread::thread ().cpu_affinity (1u << 1);
}
```

And kernel objects can be used next to standard ones in the same program: a
`std::mutex` and an `os::rtos::semaphore_counting` do not interfere.

---

## 10. Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| `std::thread` does not compile: `'thread' is not a member of 'std'` | the test does not link `stateos-stdc++` (section 3), so the define and the include order are missing |
| `stateos-stdc++ not found at .../third_party/stateos-stdc++` at configure time | the workspace was scaffolded without `--stdcpp`, or the folder was removed |
| A crash inside a `std::thread` | its 4 KiB stack (Cortex-M) overflowed (rule 2) |
| A two-core counter is sometimes short on a Pico 2 | `std::atomic::fetch_add` across cores (rule 5) |
| A wait times out early | timeouts are in 1 ms ticks (rule 6) |
| `static_assert` in `gthread.cc` about sizes | a kernel object grew past the storage the header reserves: update `__GTHREAD_STORAGE_BYTES` in `include/bits/gthr-default.h` |

---

## 11. Reference

- `third_party/stateos-stdc++/README.md`: the files of the package and the differences
  from the StateOS original.
- `rpi4b-smp/STDCXX.md` in `micro-os-scaffold-ctest-examples`: the detailed porting guide
  (the gthread contract, the design of every file, the test walkthrough).
- `scaffold.md`, chapter 13.9: what `--stdcpp` adds to a workspace.
- `templates/README_API_CTEST.md`: writing and running µTest++ tests.
- Licences: the GCC-derived files carry the GCC Runtime Library Exception
  (`src/COPYING3`, `src/COPYING.RUNTIME`); the StateOS adaptations are MIT (`LICENSE`).
