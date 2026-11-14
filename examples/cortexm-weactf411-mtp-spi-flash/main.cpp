/*
 * mtp-spi-flash — the WeAct F411CE's SPI NOR flash (W25Q series on SPI1,
 * PA4..PA7), tested with µTest++ through the board's own drivers
 * (boards/weactf411: spi.cpp, flash.cpp, flatfs.cpp).
 *
 *   00 - Device       spi::init, the transport spi::probe () chose, the JEDEC
 *                     ID (Winbond) and the size it gives, status register idle
 *   01 - Raw flash    erase, program, read back; a write across page
 *                     boundaries; NOR rules: program only clears bits, erase
 *                     sets them; bytes around a write stay erased
 *   02 - Transports   the same data read through polled, IRQ and DMA, timed
 *   03 - flatfs       format, add, find, read back, CRC, bad name, reformat
 *   04 - Threads      two threads, each with its own sector, through one mutex
 *
 * Only the top 64 KiB of the part is touched (computed from the JEDEC size):
 * the primary flatfs archive at 0 and spi-pipeline's partitions from 1 MiB
 * stay as they are.
 */
#include <mtp_board.hpp>

#include <board.hpp>
#include <flash.hpp>
#include <spi.hpp>

#include <cstdio>

// The suites live in suite-*.cpp, one per file; each registers itself.

int
os_main (int argc, char* argv[])
{
  mtp_board::start ("mtp-spi-flash"); // also switches the UART on

  spi::init ();
  const spi::transport chosen = spi::probe ();
  spi::set_transport (chosen);
  std::printf ("# SPI1 transport chosen by spi::probe (): %s\n",
               spi::transport_name (chosen));

  return mtp_board::run (argc, argv);
}
