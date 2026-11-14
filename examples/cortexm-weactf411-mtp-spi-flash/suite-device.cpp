// 00 - Device: the JEDEC ID, the size and an idle status register.
// One suite, one file: it registers itself with the runner; there is no
// list of suites to keep in step with the files.
#include <mtp_board.hpp>
#include "flash_helpers.hpp"

using namespace os::rtos;
using namespace mtp_flash;

mt::static_suite suite_device{
  "00 - Device", mtp_board::runner (),
  [] (mt::suite& ts) {
  ts.test ("the part answers with a Winbond JEDEC ID", [] (auto& t) {
    const flash::JedecId id = flash::read_id ();
    std::printf ("# JEDEC ID: %02x %02x %02x\n", id.manufacturer, id.mem_type,
                 id.capacity);
    t.expect (mt::eq (static_cast<unsigned> (id.manufacturer), 0xEFu))
        << "manufacturer 0xEF (Winbond)";
    t.expect (mt::all_of (mt::ge (static_cast<unsigned> (id.capacity), 0x14u),
                          mt::le (static_cast<unsigned> (id.capacity), 0x19u)))
        << "capacity code 0x14..0x19 (1..32 MiB)";
    if (id.capacity >= 0x14 && id.capacity <= 0x19)
      {
        g_size = 1u << id.capacity;
      }
    t.expect (mt::ge (g_size, 2u * 1024u * 1024u))
        << fmt ("size %u KiB, at least 2 MiB (the scratch area is the top 64 KiB)",
                g_size / 1024u);
  });

  ts.test ("the status register is idle", [] (auto& t) {
    const unsigned status = flash::read_status1 ();
    t.expect (mt::eq (status & 0x01u, 0u)) << fmt ("BUSY clear (SR1 0x%02x)", status);
    t.expect (mt::eq (status & 0x02u, 0u)) << "write-enable latch clear";
  });

  ts.test ("spi::probe () kept an interrupt-driven transport", [] (auto& t) {
    const spi::transport now = spi::current ();
    t.expect (now != spi::transport::polled)
        << "DMA or IRQ completes on this board; chosen: "
        << spi::transport_name (now);
  });
  }
};
