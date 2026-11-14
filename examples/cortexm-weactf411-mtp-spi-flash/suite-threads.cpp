// 04 - Threads: two threads, two sectors, one bus mutex.
// One suite, one file: it registers itself with the runner; there is no
// list of suites to keep in step with the files.
#include <mtp_board.hpp>
#include "flash_helpers.hpp"

using namespace os::rtos;
using namespace mtp_flash;

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

mt::static_suite suite_threads{
  "04 - Threads", mtp_board::runner (),
  [] (mt::suite& ts) {
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
};
