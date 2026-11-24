# Example: a board-specific µTest++ test, `mtp-spi-flash` (WeAct F411CE)

A µTest++ test written for one board, in a workspace scaffolded with
`--micro-test-plus`. It tests the WeAct F411CE's SPI NOR flash (a Winbond
W25Q128, 16 MiB, on SPI1) through the board's own drivers in
`micro-os-plus-iii/tests/platforms/cortexm-weactf411/src/` (`spi.cpp`, `flash.cpp`,
`flatfs.cpp`).

To use it (current layout):

1. Copy `main.cpp`, `flash_helpers.hpp` and the `suite-*.cpp` files to
   `micro-os-plus-iii/tests/platforms/cortexm-weactf411/tests/mtp-spi-flash/`.
2. Add `mtp-spi-flash` to `scripts/local-tests.txt`, so that a re-scaffold
   keeps it.
3. Run `./run.sh --hwd-only mtp-spi-flash`.

Like every `mtp-*` folder, it needs no CMake change. Each suite is its own file and
registers itself with a `mt::static_suite`; there is no list in `main.cpp`. The
complete TAP report is written to
`micro-os-plus-iii/tests/build/cortexm-weactf411-cmake-gcc-debug/mtp-reports/cortexm-weactf411-mtp-spi-flash-hwd.tap`.
Checked on 2026-11-24: it builds this way in a current-layout WeAct workspace.

In an old-layout workspace, the folder went to
`micro-os-plus-iii-cortexm/test/weactf411/mtp-spi-flash/`, the report to
`.hw-logs/mtp-spi-flash.tap`, and a re-scaffold removed it.

| Suite | Checks |
| --- | --- |
| 00 Device | JEDEC ID (Winbond `ef 40 18`), size, status idle, the transport `spi::probe ()` kept |
| 01 Raw flash | erase, program, read back, a write across page boundaries, NOR rules |
| 02 Transports | the same data through polled, IRQ and DMA, each >= 100 KiB/s and still active |
| 03 flatfs | format, add, find, CRC-32, read back whole and from an offset, bad name, reformat |
| 04 Threads | two threads, two sectors, one bus mutex |

Result on the board (2026-11-14): 52/52 checks; polled 1406 KiB/s, IRQ 759 KiB/s,
DMA 2188 KiB/s. Only the top 64 KiB of the part is written.

Two lessons, in the test's comments:

- `spi::probe ()` keeps the first transport that works (DMA) and never unmasks
  SPI1's interrupt. Forcing the IRQ transport with `spi::set_transport ()` alone
  makes every transfer time out (2 + len/8 ticks) and be redone polled: the data is
  right, the IRQ path is never run. The test unmasks SPI1 as `probe ()` does for
  that candidate.
- A rate floor per transport turns such a silent fallback (7 KiB/s) into a failure.
