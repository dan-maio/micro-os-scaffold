/*
 * flash-raw — erase, program and read back on a scratch sector at the top of
 * the WeAct F411CE's SPI NOR flash: a page, a write across page boundaries
 * with the bytes around it untouched, and the NOR rules (programming only
 * clears bits; erase sets them again).
 * Classic board test: UART report, RESULT through hw_result (flash_check.hpp).
 */
#include <flash_check.hpp>

using namespace flash_check;

namespace
{
  std::uint8_t g_buf[sector];
  std::uint8_t g_expect[sector];
} // namespace

int
os_main (int, char*[])
{
  if (!bring_up ("flash-raw"))
    {
      finish ();
    }
  const std::uint32_t a = sector_a ();
  say ("scratch sector at 0x%06x\n", static_cast<unsigned> (a));

  section ("erase");
  auto t0 = os::rtos::sysclock.now ();
  check (flash::sector_erase (a), "sector_erase () completed (%u ms)",
         elapsed_ms (t0));
  flash::read (a, g_buf, sector);
  check (all_are (g_buf, sector, 0xFF), "4 KiB of 0xFF");

  section ("one page");
  fill (g_expect, page, 0x5A);
  check (flash::page_program (a, g_expect, page), "page_program () of 256 bytes");
  flash::read (a, g_buf, page);
  check (std::memcmp (g_buf, g_expect, page) == 0, "256 bytes read back equal");

  section ("across page boundaries");
  const std::uint32_t at = a + page + 200; // 600 bytes: three page crossings
  fill (g_expect, 600, 0xC3);
  check (flash::write (at, g_expect, 600), "write () of 600 bytes at page offset 200");
  flash::read (at, g_buf, 600);
  check (std::memcmp (g_buf, g_expect, 600) == 0, "600 bytes read back equal");
  flash::read (a + page, g_buf, 200);
  check (all_are (g_buf, 200, 0xFF), "the 200 bytes before it still erased");
  flash::read (at + 600, g_buf, 256);
  check (all_are (g_buf, 256, 0xFF), "the 256 bytes after it still erased");
  flash::read (a, g_buf, page);
  fill (g_expect, page, 0x5A);
  check (std::memcmp (g_buf, g_expect, page) == 0, "the first page unchanged");

  section ("NOR rules");
  const std::uint32_t nor = a + 3 * page;
  std::uint8_t f0[16];
  std::uint8_t zf[16];
  std::memset (f0, 0xF0, sizeof (f0));
  std::memset (zf, 0x0F, sizeof (zf));
  check (flash::page_program (nor, f0, sizeof (f0)), "program 0xF0");
  check (flash::page_program (nor, zf, sizeof (zf)), "program 0x0F over it");
  flash::read (nor, g_buf, sizeof (f0));
  check (all_are (g_buf, sizeof (f0), 0x00), "reads 0x00: programming only clears bits");

  section ("erase again");
  t0 = os::rtos::sysclock.now ();
  check (flash::sector_erase (a), "sector_erase () completed (%u ms)",
         elapsed_ms (t0));
  flash::read (a, g_buf, sector);
  check (all_are (g_buf, sector, 0xFF), "4 KiB of 0xFF: erase sets every bit");
  check ((flash::read_status1 () & 0x03u) == 0, "status idle, latch clear");

  finish ();
}
