/*
 * flash-transports — the same 4 KiB read through each SPI1 transport the
 * WeAct F411CE's driver has (polled, IRQ, DMA), checked and timed.
 *
 * spi::probe () keeps the first transport that works (DMA here) and never
 * unmasks SPI1's interrupt; forcing IRQ with spi::set_transport () alone
 * would time out every transfer (2 + len/8 ticks) and redo it polled, right
 * data and an IRQ path never run. So the IRQ run unmasks SPI1 as probe ()
 * does for that candidate, and each transport must keep a rate floor and
 * stay the active one.
 * Classic board test: UART report, RESULT through hw_result (flash_check.hpp).
 */
#include <flash_check.hpp>

#include <cmsis_device.h>

using namespace flash_check;

namespace
{
  std::uint8_t g_buf[sector];
  std::uint8_t g_expect[sector];
  constexpr unsigned rounds = 64; // 256 KiB per transport
  constexpr unsigned floor_kib_s = 100;
} // namespace

int
os_main (int, char*[])
{
  if (!bring_up ("flash-transports"))
    {
      finish ();
    }
  const spi::transport chosen = spi::current ();
  const std::uint32_t a = sector_a ();

  section ("4 KiB of known data");
  fill (g_expect, sector, 0x21);
  check (flash::sector_erase (a), "scratch sector erased");
  check (flash::write (a, g_expect, sector), "4 KiB written");

  unsigned rate[3] = {};
  for (spi::transport tr : { spi::transport::polled, spi::transport::irq,
                             spi::transport::dma })
    {
      section (spi::transport_name (tr));
      if (tr == spi::transport::irq)
        {
          NVIC_SetPriority (SPI1_IRQn, 5);
          NVIC_ClearPendingIRQ (SPI1_IRQn);
          NVIC_EnableIRQ (SPI1_IRQn);
        }
      spi::set_transport (tr);
      bool same = true;
      const auto t0 = os::rtos::sysclock.now ();
      for (unsigned r = 0; r < rounds; ++r)
        {
          std::memset (g_buf, 0, sizeof (g_buf));
          flash::read (a, g_buf, sector);
          same = same && std::memcmp (g_buf, g_expect, sector) == 0;
        }
      const unsigned ms = elapsed_ms (t0);
      const bool still = spi::current () == tr;
      if (tr == spi::transport::irq)
        {
          NVIC_DisableIRQ (SPI1_IRQn);
          NVIC_ClearPendingIRQ (SPI1_IRQn);
        }
      const unsigned kib_s = ms ? (rounds * 4u * 1000u) / ms : 0;
      rate[static_cast<int> (tr)] = kib_s;
      check (same, "64 reads of 4 KiB equal what was written");
      check (kib_s >= floor_kib_s, "%u KiB/s (%u ms for 256 KiB), floor %u",
             kib_s, ms, floor_kib_s);
      check (still, "still the active transport (not demoted to polled)");
    }
  spi::set_transport (chosen);

  section ("comparison");
  check (rate[2] > rate[0], "DMA faster than polled (%u > %u KiB/s)", rate[2],
         rate[0]);

  finish ();
}
