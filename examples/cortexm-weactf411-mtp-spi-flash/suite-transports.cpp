// 02 - Transports: the same data through polled, IRQ and DMA, with rate floors.
// One suite, one file: it registers itself with the runner; there is no
// list of suites to keep in step with the files.
#include <mtp_board.hpp>
#include "flash_helpers.hpp"

using namespace os::rtos;
using namespace mtp_flash;

mt::static_suite suite_transports{
  "02 - Transports", mtp_board::runner (),
  [] (mt::suite& ts) {
  ts.test ("the same 4 KiB through polled, IRQ and DMA", [] (auto& t) {
    const spi::transport chosen = spi::current ();
    fill (g_expect, sector, 0x21);
    (void)flash::sector_erase (sector_a ());
    t.expect (flash::write (sector_a (), g_expect, sector)) << "4 KiB written";

    for (spi::transport tr : { spi::transport::polled, spi::transport::irq,
                               spi::transport::dma })
      {
        // spi::probe () kept the first transport that worked (DMA here) and
        // never unmasked SPI1's interrupt; to run the IRQ transport, do what
        // probe () does for that candidate, and mask it again after.
        if (tr == spi::transport::irq)
          {
            NVIC_SetPriority (SPI1_IRQn, 5);
            NVIC_ClearPendingIRQ (SPI1_IRQn);
            NVIC_EnableIRQ (SPI1_IRQn);
          }
        spi::set_transport (tr);
        std::memset (g_buf, 0, sizeof (g_buf));
        constexpr unsigned rounds = 64; // 256 KiB, long enough for a ms clock
        bool same = true;
        const auto begin = sysclock.now ();
        for (unsigned r = 0; r < rounds; ++r)
          {
            flash::read (sector_a (), g_buf, sector);
            same = same && std::memcmp (g_buf, g_expect, sector) == 0;
          }
        const auto ticks = sysclock.now () - begin;
        const unsigned ms = static_cast<unsigned> (
            (static_cast<std::uint64_t> (ticks) * 1000u)
            / clock_systick::frequency_hz);
        const unsigned kib_s = ms ? (rounds * 4u * 1000u) / ms : 0;
        std::printf ("# %-6s %u x 4 KiB in %u ms, %u KiB/s\n",
                     spi::transport_name (tr), rounds, ms, kib_s);
        if (tr == spi::transport::irq)
          {
            NVIC_DisableIRQ (SPI1_IRQn);
            NVIC_ClearPendingIRQ (SPI1_IRQn);
          }
        t.expect (same) << spi::transport_name (tr)
                        << ": 64 reads of 4 KiB equal what was written";
        // A transport whose completion never arrives times out each transfer
        // (2 + len/8 ticks) and is redone polled: the data is right but the
        // rate collapses (7 KiB/s). The floor catches that silent fallback.
        t.expect (mt::ge (kib_s, 100u))
            << spi::transport_name (tr) << ": at least 100 KiB/s ("
            << kib_s << " KiB/s)";
        t.expect (spi::current () == tr)
            << spi::transport_name (tr) << ": still the active transport (not demoted)";
      }
    spi::set_transport (chosen);
  });
  }
};
