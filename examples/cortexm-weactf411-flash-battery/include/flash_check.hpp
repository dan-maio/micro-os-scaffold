/*
 * flash_check.hpp — what the flash-* tests share (header only, so no test
 * of this board links anything it does not use).
 *
 * The flash-* tests are classic board tests: their own os_main, a report on
 * the UART (USART1, 115200 8N1), one line per check, and the verdict the
 * runner reads: "RESULT: PASS" / "RESULT: FAIL" through semihosting
 * (hw_result::ok / fail), also printed on the UART.
 *
 *   check (cond, "what %u", value)   one numbered check, "ok" or "FAIL"
 *   section ("name")                 a heading
 *   finish ()                        summary, RESULT line, end of run
 *   bring_up ()                      UART, SPI1, spi::probe (), JEDEC ID
 *
 * Only the top 64 KiB of the SPI NOR part is written (from the JEDEC size):
 * the primary flatfs archive at 0 and spi-pipeline's partitions from 1 MiB
 * stay as they are.
 *
 *   top - 4 KiB          sector A    (flash-raw, flash-transports)
 *   top - 8, -12 KiB     sectors B, C (flash-threads)
 *   top - 64 .. -16 KiB  a 48 KiB flatfs partition (flash-flatfs)
 */
#ifndef WEACTF411_FLASH_CHECK_HPP_
#define WEACTF411_FLASH_CHECK_HPP_

#include <cmsis-plus/rtos/os.h>

#include <board.hpp>
#include <flash.hpp>
#include <hw_result.hpp>
#include <spi.hpp>
#include <uart.hpp>

#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <cstring>

namespace flash_check
{
  inline constexpr std::uint32_t sector = 4096;
  inline constexpr std::uint32_t page = 256;
  inline constexpr std::uint32_t scratch_span = 64u * 1024u;
  inline constexpr std::uint32_t fs_size = 48u * 1024u;

  struct state
  {
    const char* name = "flash";
    unsigned checks = 0;
    unsigned failed = 0;
    std::uint32_t size = 0; // the part's size, from the JEDEC ID
    os::rtos::clock::timestamp_t start = 0;
  };

  inline state&
  st ()
  {
    static state s;
    return s;
  }

  // printf to the UART (newlib-nano: no %z, no float; cast to unsigned).
  inline void __attribute__ ((format (printf, 1, 2)))
  say (const char* format, ...)
  {
    char line[160];
    va_list ap;
    va_start (ap, format);
    const int n = std::vsnprintf (line, sizeof (line), format, ap);
    va_end (ap);
    if (n > 0)
      {
        uart::write (line, static_cast<std::size_t> (
                               n < static_cast<int> (sizeof (line))
                                   ? n
                                   : static_cast<int> (sizeof (line)) - 1));
      }
  }

  inline void
  section (const char* title)
  {
    say ("\n-- %s\n", title);
  }

  // One numbered check. Returns `cond`, so a test can stop a chain early.
  inline bool __attribute__ ((format (printf, 2, 3)))
  check (bool cond, const char* format, ...)
  {
    char what[128];
    va_list ap;
    va_start (ap, format);
    std::vsnprintf (what, sizeof (what), format, ap);
    va_end (ap);
    auto& s = st ();
    ++s.checks;
    if (!cond)
      {
        ++s.failed;
      }
    say ("  %-4s %2u  %s\n", cond ? "ok" : "FAIL", s.checks, what);
    return cond;
  }

  inline unsigned
  elapsed_ms (os::rtos::clock::timestamp_t since)
  {
    return static_cast<unsigned> (
        (static_cast<std::uint64_t> (os::rtos::sysclock.now () - since) * 1000u)
        / os::rtos::clock_systick::frequency_hz);
  }

  // Summary, the RESULT line on the UART, the verdict to the runner.
  [[noreturn]] inline void
  finish ()
  {
    auto& s = st ();
    const bool pass = s.checks > 0 && s.failed == 0;
    say ("\n%s: %u of %u checks passed, %u ms\n", s.name, s.checks - s.failed,
         s.checks, elapsed_ms (s.start));
    say ("RESULT: %s (%s)\n", pass ? "PASS" : "FAIL", s.name);
    if (pass)
      {
        hw_result::ok ();
      }
    hw_result::fail ();
    __builtin_unreachable ();
  }

  // UART, SPI1, the transport spi::probe () keeps, the JEDEC ID. Checks the
  // part is a Winbond of at least 2 MiB and returns false if not (the
  // caller then finishes: nothing else can be checked).
  inline bool
  bring_up (const char* name)
  {
    auto& s = st ();
    s.name = name;
    s.start = os::rtos::sysclock.now ();
    uart::init (board::UART_BAUD);
    say ("\n=== %s: WeAct F411CE, SPI NOR flash on SPI1 ===\n", name);
    spi::init ();
    const spi::transport tr = spi::probe ();
    spi::set_transport (tr);
    say ("SPI1 transport kept by spi::probe (): %s\n", spi::transport_name (tr));
    const flash::JedecId id = flash::read_id ();
    say ("JEDEC ID: %02x %02x %02x\n", id.manufacturer, id.mem_type,
         id.capacity);
    if (id.manufacturer == 0xEF && id.capacity >= 0x14 && id.capacity <= 0x19)
      {
        s.size = 1u << id.capacity;
      }
    return check (s.size >= 2u * 1024u * 1024u,
                  "a Winbond part of at least 2 MiB (%u KiB)",
                  static_cast<unsigned> (s.size / 1024u));
  }

  inline std::uint32_t
  sector_a ()
  {
    return st ().size - sector;
  }

  inline std::uint32_t
  sector_b ()
  {
    return st ().size - 2 * sector;
  }

  inline std::uint32_t
  sector_c ()
  {
    return st ().size - 3 * sector;
  }

  inline std::uint32_t
  fs_base ()
  {
    return st ().size - scratch_span;
  }

  inline std::uint8_t
  pattern (std::uint32_t i, std::uint8_t seed)
  {
    return static_cast<std::uint8_t> ((i * 7u + seed) ^ (i >> 8));
  }

  inline void
  fill (std::uint8_t* buf, std::size_t len, std::uint8_t seed)
  {
    for (std::size_t i = 0; i < len; ++i)
      {
        buf[i] = pattern (static_cast<std::uint32_t> (i), seed);
      }
  }

  inline bool
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
} // namespace flash_check

#endif /* WEACTF411_FLASH_CHECK_HPP_ */
