// 01 - Raw flash: erase, program, read back, page boundaries, NOR rules.
// One suite, one file: it registers itself with the runner; there is no
// list of suites to keep in step with the files.
#include <mtp_board.hpp>
#include "flash_helpers.hpp"

using namespace os::rtos;
using namespace mtp_flash;

mt::static_suite suite_raw{
  "01 - Raw flash", mtp_board::runner (),
  [] (mt::suite& ts) {
  ts.test ("erase leaves the sector at 0xFF", [] (auto& t) {
    t.expect (flash::sector_erase (sector_a ())) << "sector_erase () completed";
    flash::read (sector_a (), g_buf, sector);
    t.expect (all_are (g_buf, sector, 0xFF)) << "4 KiB of 0xFF";
  });

  ts.test ("one page programmed reads back", [] (auto& t) {
    fill (g_expect, page, 0x5A);
    t.expect (flash::page_program (sector_a (), g_expect, page))
        << "page_program () completed";
    flash::read (sector_a (), g_buf, page);
    t.expect (std::memcmp (g_buf, g_expect, page) == 0) << "256 bytes equal";
  });

  ts.test ("a write across page boundaries", [] (auto& t) {
    // 600 bytes at page offset 200 of the second page: three page crossings.
    const std::uint32_t at = sector_a () + page + 200;
    fill (g_expect, 600, 0xC3);
    t.expect (flash::write (at, g_expect, 600)) << "write () completed";
    flash::read (at, g_buf, 600);
    t.expect (std::memcmp (g_buf, g_expect, 600) == 0) << "600 bytes equal";
    flash::read (sector_a () + page, g_buf, 200);
    t.expect (all_are (g_buf, 200, 0xFF)) << "the 200 bytes before it still erased";
    flash::read (at + 600, g_buf, 256);
    t.expect (all_are (g_buf, 256, 0xFF)) << "the 256 bytes after it still erased";
  });

  ts.test ("NOR: programming only clears bits", [] (auto& t) {
    const std::uint32_t at = sector_a () + 3 * page;
    std::uint8_t a[16];
    std::uint8_t b[16];
    std::memset (a, 0xF0, sizeof (a));
    std::memset (b, 0x0F, sizeof (b));
    t.expect (flash::page_program (at, a, sizeof (a))) << "program 0xF0";
    t.expect (flash::page_program (at, b, sizeof (b))) << "program 0x0F over it";
    flash::read (at, g_buf, sizeof (a));
    t.expect (all_are (g_buf, sizeof (a), 0x00)) << "0xF0 & 0x0F = 0x00";
  });

  ts.test ("erase sets every bit again", [] (auto& t) {
    t.expect (flash::sector_erase (sector_a ())) << "sector_erase () completed";
    flash::read (sector_a (), g_buf, sector);
    t.expect (all_are (g_buf, sector, 0xFF)) << "4 KiB of 0xFF";
    t.expect (mt::eq (flash::read_status1 () & 0x03u, 0u)) << "idle, latch clear";
  });
  }
};
