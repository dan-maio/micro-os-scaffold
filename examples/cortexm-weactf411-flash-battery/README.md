# Example: a classic test battery for one board (WeAct F411CE SPI flash)

The same SPI NOR flash as `../cortexm-weactf411-mtp-spi-flash/`, tested
**without µTest++**: five classic board tests in the style of `mos-test1` and
`spi-pipeline`. Each has its own `os_main`, prints one numbered `ok`/`FAIL` line
per check on the UART (USART1, 115200 8N1) and a summary, and ends with
`RESULT: PASS|FAIL` through `hw_result`, which the runner reads over
semihosting. One area per test, so each is its own CTest case and a failure
names its area.

| Test (CTest `cortexm-weactf411-<name>-hwd`) | Checks |
| --- | --- |
| `flash-id` | JEDEC ID (Winbond, W25Q family, size), ID stable, status idle, an interrupt-driven transport kept, a stable read |
| `flash-raw` | erase to 0xFF, one page, 600 bytes across page boundaries with the bytes around it untouched, NOR rules, erase again |
| `flash-transports` | 256 KiB through polled, IRQ and DMA: data equal, >= 100 KiB/s, still the active transport; DMA faster than polled |
| `flash-flatfs` | format, add two files, find, CRC-32, read back whole and from an offset, bad names, reformat |
| `flash-threads` | two threads, 8 rounds each of erase, write and read back 1 KiB under one bus mutex: all good, interleaved, mutex free, each sector its own thread's data |

`include/flash_check.hpp` is what they share, header only (no source file
reaches the board's other tests): the check counter and report, `finish ()`
with the RESULT line, `bring_up ()` (UART, SPI1, `spi::probe ()`, JEDEC size),
and the scratch layout. Only the top 64 KiB of the part is written.

To use it in a workspace scaffolded for `cortexm-weactf411` (current layout):

1. Copy the five folders to `micro-os-plus-iii/tests/platforms/cortexm-weactf411/tests/`,
   and `include/flash_check.hpp` to that folder's `include/`. The builder puts
   it on every test's include path. No CMake change is needed.
2. List them in the workspace's `scripts/local-tests.txt`, so that a
   re-scaffold keeps them and `./run.sh` runs them by default:

   ```text
   flash-id
   flash-raw
   flash-transports
   flash-flatfs
   flash-threads
   keep micro-os-plus-iii/tests/platforms/cortexm-weactf411/tests/include
   ```
3. Run `./run.sh --hwd-only` (board and probe attached).

Checked on 2026-11-24: in a current-layout WeAct workspace the five build
this way, and `./run.sh list` shows them as local tests (`L`).

In an old-layout workspace, the folders went to
`micro-os-plus-iii-cortexm/test/weactf411/` instead, were added to the selection
in `scaffold.json`, and were run with
`./run.sh -c cortexm-weactf411-cmake-gcc-debug flash-id flash-raw flash-transports flash-flatfs flash-threads --hwd-only`.

Result on the board (2026-11-14, W25Q128 `ef 40 18`, WCH-Link): 5/5 passed,
4 to 6 s each.

Compared with the µTest++ version: the same checks, no framework, a plain
report; but one RESULT per test instead of one per run, and no TAP, so a CI
system gets five pass/fail cases rather than one structured report.
