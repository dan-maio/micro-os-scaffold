// mtp-spi-flash suites — see main.cpp.
#include <mtp_board.hpp>

#include <flash.hpp>
#include <flatfs.hpp>
#include <spi.hpp>

#include <cmsis_device.h>

#include <cstdint>
#include <cstdio>
#include <cstring>

using namespace os::rtos;

namespace
{
  constexpr std::uint32_t sector = 4096;
  constexpr std::uint32_t page = 256;
  constexpr std::uint32_t scratch_span = 64u * 1024u; // the top 64 KiB

  std::uint32_t g_size = 0; // the part's size, from the JEDEC ID

  // The scratch layout, from the top of the part down:
  //   top - 4 KiB         sector A: raw tests and transports
  //   top - 8, - 12 KiB   sectors B, C: one per thread
  //   top - 64 .. -16 KiB a 48 KiB flatfs partition
  std::uint32_t
  sector_a ()
  {
    return g_size - sector;
  }

  std::uint32_t
  sector_b ()
  {
    return g_size - 2 * sector;
  }

  std::uint32_t
  sector_c ()
  {
    return g_size - 3 * sector;
  }

  std::uint32_t
  fs_base ()
  {
    return g_size - scratch_span;
  }

  constexpr std::uint32_t fs_size = 48u * 1024u;

  std::uint8_t
  pattern (std::uint32_t i, std::uint8_t seed)
  {
    return static_cast<std::uint8_t> ((i * 7u + seed) ^ (i >> 8));
  }

  void
  fill (std::uint8_t* buf, std::size_t len, std::uint8_t seed)
  {
    for (std::size_t i = 0; i < len; ++i)
      {
        buf[i] = pattern (static_cast<std::uint32_t> (i), seed);
      }
  }

  bool
  all_are (const std::uint8_t* buf, std::size_t len, std::uint8_t value)
  {
    for (std::size_t i = 0; i < len; ++i)
      {
        if (buf[i] != value)
          {
            return false;
          }
      }
    return true;
  }

  const char*
  fmt (const char* format, unsigned a, unsigned b = 0, unsigned c = 0)
  {
    static char text[128];
    std::snprintf (text, sizeof (text), format, a, b, c);
    return text;
  }

  std::uint8_t g_buf[sector];
  std::uint8_t g_expect[sector];
} // namespace

// ===========================================================================
// 00 - Device
// ===========================================================================
void
suite_device (mt::suite& ts)
{
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

// ===========================================================================
// 01 - Raw flash
// ===========================================================================
void
suite_raw (mt::suite& ts)
{
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

// ===========================================================================
// 02 - Transports
// ===========================================================================
void
suite_transports (mt::suite& ts)
{
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

// ===========================================================================
// 03 - flatfs
// ===========================================================================
namespace
{
  std::uint8_t g_alpha[1000];
  std::uint8_t g_beta[3000];
} // namespace

void
suite_flatfs (mt::suite& ts)
{
  ts.test ("format an empty partition", [] (auto& t) {
    const flatfs::Partition p{ fs_base (), fs_size };
    t.expect (p.format () == flatfs::error::none) << "format () = none";
    t.expect (p.valid ()) << "the superblock is valid";
    t.expect (mt::eq (p.count (), 0u)) << "no file";
  });

  ts.test ("add two files and find them", [] (auto& t) {
    const flatfs::Partition p{ fs_base (), fs_size };
    fill (g_alpha, sizeof (g_alpha), 0x11);
    fill (g_beta, sizeof (g_beta), 0x77);
    t.expect (p.add ("alpha", 5, g_alpha, sizeof (g_alpha)) == flatfs::error::none)
        << "add alpha (1000 B)";
    t.expect (p.add ("beta", 4, g_beta, sizeof (g_beta)) == flatfs::error::none)
        << "add beta (3000 B)";
    t.expect (mt::eq (p.count (), 2u)) << "two files";
    flatfs::Entry e{};
    t.expect (p.find ("beta", 4, e)) << "find beta";
    t.expect (mt::eq (e.size, 3000u)) << "its size";
    t.expect (mt::eq (e.crc, flatfs::crc32 (g_beta, sizeof (g_beta))))
        << "its CRC-32 is the data's";
    t.expect (!p.find ("gamma", 5, e)) << "no gamma";
  });

  ts.test ("read a file back, whole and from an offset", [] (auto& t) {
    const flatfs::Partition p{ fs_base (), fs_size };
    flatfs::Entry e{};
    t.expect (p.find ("beta", 4, e)) << "find beta";
    static std::uint8_t back[3000];
    t.expect (mt::eq (p.read_blob_at (e, 0, back, sizeof (back)), 3000))
        << "3000 bytes read";
    t.expect (std::memcmp (back, g_beta, sizeof (back)) == 0) << "equal to what was added";
    t.expect (mt::eq (p.read_blob_at (e, 2900, back, sizeof (back)), 100))
        << "100 bytes from offset 2900";
    t.expect (std::memcmp (back, g_beta + 2900, 100) == 0) << "the right 100";
    t.expect (mt::eq (p.read_blob_at (e, 3000, back, sizeof (back)), 0))
        << "nothing past the end";
  });

  ts.test ("a name too long is refused", [] (auto& t) {
    const flatfs::Partition p{ fs_base (), fs_size };
    t.expect (p.add ("sixteen-chars-xx", 16, g_alpha, 8) == flatfs::error::bad_name)
        << "16 characters: bad_name";
    t.expect (mt::eq (p.count (), 2u)) << "still two files";
  });

  ts.test ("reformat empties it", [] (auto& t) {
    const flatfs::Partition p{ fs_base (), fs_size };
    t.expect (p.format () == flatfs::error::none) << "format () = none";
    t.expect (mt::eq (p.count (), 0u)) << "no file";
  });
}

// ===========================================================================
// 04 - Threads
// ===========================================================================
namespace
{
  mutex* g_bus = nullptr;
  constexpr unsigned thread_rounds = 4;
  constexpr std::size_t thread_len = 1024;

  struct job
  {
    std::uint32_t base;
    std::uint8_t seed;
    unsigned good;
  };

  job g_job_b;
  job g_job_c;

  void*
  flash_worker (void* arg)
  {
    auto* j = static_cast<job*> (arg);
    static std::uint8_t data_b[thread_len], back_b[thread_len];
    static std::uint8_t data_c[thread_len], back_c[thread_len];
    std::uint8_t* data = (j == &g_job_b) ? data_b : data_c;
    std::uint8_t* back = (j == &g_job_b) ? back_b : back_c;
    for (unsigned r = 0; r < thread_rounds; ++r)
      {
        fill (data, thread_len, static_cast<std::uint8_t> (j->seed + r));
        bool ok = true;
        {
          (void)g_bus->lock ();
          ok = ok && flash::sector_erase (j->base);
          (void)g_bus->unlock ();
        }
        this_thread::yield ();
        {
          (void)g_bus->lock ();
          ok = ok && flash::write (j->base, data, thread_len);
          (void)g_bus->unlock ();
        }
        this_thread::yield ();
        {
          (void)g_bus->lock ();
          flash::read (j->base, back, thread_len);
          (void)g_bus->unlock ();
        }
        if (ok && std::memcmp (back, data, thread_len) == 0)
          {
            ++j->good;
          }
      }
    return nullptr;
  }
} // namespace

void
suite_threads (mt::suite& ts)
{
  ts.test ("two threads, two sectors, one bus mutex", [] (auto& t) {
    mutex bus{ "mtp-spi-bus" };
    g_bus = &bus;
    g_job_b = { sector_b (), 0x31, 0 };
    g_job_c = { sector_c (), 0x97, 0 };
    thread::attributes attr;
    attr.th_stack_size_bytes = 2048;
    thread tb{ "mtp-flash-b", flash_worker, &g_job_b, attr };
    thread tc{ "mtp-flash-c", flash_worker, &g_job_c, attr };
    (void)tb.join ();
    (void)tc.join ();
    t.expect (mt::eq (g_job_b.good, thread_rounds))
        << "thread B: 4 rounds of erase, write 1 KiB, read back";
    t.expect (mt::eq (g_job_c.good, thread_rounds))
        << "thread C: 4 rounds of erase, write 1 KiB, read back";
  });
}
