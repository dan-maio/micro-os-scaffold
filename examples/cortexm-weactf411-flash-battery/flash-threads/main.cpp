/*
 * flash-threads — the WeAct F411CE's SPI NOR flash used from two µOS++
 * threads at once, each with its own scratch sector, the bus serialised by
 * one mutex: rounds of erase, write 1 KiB, read back, with yields between
 * the steps so the threads interleave. The driver's DMA/IRQ completions are
 * kernel semaphores, so this also checks they wake the right thread.
 * Classic board test: UART report, RESULT through hw_result (flash_check.hpp).
 */
#include <flash_check.hpp>

using namespace flash_check;
using namespace os::rtos;

namespace
{
  constexpr unsigned rounds = 8;
  constexpr std::size_t len = 1024;

  mutex* g_bus = nullptr;

  struct job
  {
    std::uint32_t base;
    std::uint8_t seed;
    unsigned good;
    unsigned steps; // bus acquisitions
    std::uint8_t data[len];
    std::uint8_t back[len];
  };

  job g_b;
  job g_c;
  volatile unsigned g_order[2 * rounds * 3];
  volatile unsigned g_order_at = 0;

  void
  step (job& j, unsigned who)
  {
    (void)g_bus->lock ();
    ++j.steps;
    {
      interrupts::critical_section ics;
      if (g_order_at < sizeof (g_order) / sizeof (g_order[0]))
        {
          g_order[g_order_at] = who;
          g_order_at = g_order_at + 1;
        }
    }
  }

  void*
  worker (void* arg)
  {
    auto& j = *static_cast<job*> (arg);
    const unsigned who = (&j == &g_b) ? 1u : 2u;
    for (unsigned r = 0; r < rounds; ++r)
      {
        fill (j.data, len, static_cast<std::uint8_t> (j.seed + r));
        bool ok = true;
        step (j, who);
        ok = ok && flash::sector_erase (j.base);
        (void)g_bus->unlock ();
        this_thread::yield ();
        step (j, who);
        ok = ok && flash::write (j.base, j.data, len);
        (void)g_bus->unlock ();
        this_thread::yield ();
        step (j, who);
        flash::read (j.base, j.back, len);
        (void)g_bus->unlock ();
        if (ok && std::memcmp (j.back, j.data, len) == 0)
          {
            ++j.good;
          }
        this_thread::yield ();
      }
    return nullptr;
  }
} // namespace

int
os_main (int, char*[])
{
  if (!bring_up ("flash-threads"))
    {
      finish ();
    }
  say ("sectors B 0x%06x, C 0x%06x, %u rounds of 1 KiB each\n",
       static_cast<unsigned> (sector_b ()), static_cast<unsigned> (sector_c ()),
       rounds);

  mutex bus{ "flash-bus" };
  g_bus = &bus;
  g_b.base = sector_b ();
  g_b.seed = 0x31;
  g_c.base = sector_c ();
  g_c.seed = 0x97;

  section ("two threads");
  thread::attributes attr;
  attr.th_stack_size_bytes = 2048;
  const auto t0 = sysclock.now ();
  thread tb{ "flash-b", worker, &g_b, attr };
  thread tc{ "flash-c", worker, &g_c, attr };
  (void)tb.join ();
  (void)tc.join ();
  const unsigned ms = elapsed_ms (t0);

  check (g_b.good == rounds, "thread B: %u of %u rounds read back equal", g_b.good,
         rounds);
  check (g_c.good == rounds, "thread C: %u of %u rounds read back equal", g_c.good,
         rounds);
  check (g_b.steps == 3 * rounds && g_c.steps == 3 * rounds,
         "every step took the bus mutex (%u + %u)", g_b.steps, g_c.steps);
  unsigned switches = 0;
  for (unsigned i = 1; i < g_order_at; ++i)
    {
      switches += g_order[i] != g_order[i - 1] ? 1u : 0u;
    }
  check (switches >= rounds, "the threads interleaved on the bus (%u switches)",
         switches);
  check (bus.owner () == nullptr, "the bus mutex is free at the end");
  say ("%u ms for both\n", ms);

  section ("each sector holds its own thread's last data");
  static std::uint8_t back[len];
  static std::uint8_t expect[len];
  flash::read (sector_b (), back, len);
  fill (expect, len, static_cast<std::uint8_t> (0x31 + rounds - 1));
  check (std::memcmp (back, expect, len) == 0, "sector B: thread B's last round");
  flash::read (sector_c (), back, len);
  fill (expect, len, static_cast<std::uint8_t> (0x97 + rounds - 1));
  check (std::memcmp (back, expect, len) == 0, "sector C: thread C's last round");

  finish ();
}
