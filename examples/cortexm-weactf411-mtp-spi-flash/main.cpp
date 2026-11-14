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

void suite_device (mt::suite& ts);
void suite_raw (mt::suite& ts);
void suite_transports (mt::suite& ts);
void suite_flatfs (mt::suite& ts);
void suite_threads (mt::suite& ts);

mt::runner tr;

int
os_main (int, char*[])
{
  mtp_board::start ("mtp-spi-flash"); // also switches the UART on

  spi::init ();
  const spi::transport chosen = spi::probe ();
  spi::set_transport (chosen);
  std::printf ("# SPI1 transport chosen by spi::probe (): %s\n",
               spi::transport_name (chosen));

  tr.initialise (mtp_board::options ());
  tr.add_suite ("00 - Device", suite_device);
  tr.add_suite ("01 - Raw flash", suite_raw);
  tr.add_suite ("02 - Transports", suite_transports);
  tr.add_suite ("03 - flatfs", suite_flatfs);
  tr.add_suite ("04 - Threads", suite_threads);
  return mtp_board::finish (tr.run_suites ());
}
