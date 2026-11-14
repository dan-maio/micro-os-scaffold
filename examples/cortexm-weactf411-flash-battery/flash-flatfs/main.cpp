/*
 * flash-flatfs — the WeAct F411CE's flat file system (boards/weactf411
 * flatfs.cpp) on a 48 KiB scratch partition at the top of the SPI NOR part:
 * format, add, find, CRC-32, read back whole and from an offset, a name too
 * long, reformat.
 * Classic board test: UART report, RESULT through hw_result (flash_check.hpp).
 */
#include <flash_check.hpp>
#include <flatfs.hpp>

using namespace flash_check;

namespace
{
  std::uint8_t g_alpha[1000];
  std::uint8_t g_beta[3000];
  std::uint8_t g_back[3000];
} // namespace

int
os_main (int, char*[])
{
  if (!bring_up ("flash-flatfs"))
    {
      finish ();
    }
  const flatfs::Partition p{ fs_base (), fs_size };
  say ("partition 0x%06x, %u KiB\n", static_cast<unsigned> (p.base ()),
       static_cast<unsigned> (p.size () / 1024u));

  section ("format");
  auto t0 = os::rtos::sysclock.now ();
  check (p.format () == flatfs::error::none, "format () = none (%u ms)",
         elapsed_ms (t0));
  check (p.valid (), "the superblock is valid");
  check (p.count () == 0, "no file");

  section ("add");
  fill (g_alpha, sizeof (g_alpha), 0x11);
  fill (g_beta, sizeof (g_beta), 0x77);
  check (p.add ("alpha", 5, g_alpha, sizeof (g_alpha)) == flatfs::error::none,
         "add alpha, 1000 bytes");
  check (p.add ("beta", 4, g_beta, sizeof (g_beta)) == flatfs::error::none,
         "add beta, 3000 bytes");
  check (p.count () == 2, "two files (%u)", static_cast<unsigned> (p.count ()));

  section ("find");
  flatfs::Entry e{};
  check (p.find ("beta", 4, e), "find beta");
  check (e.size == 3000, "its size, 3000 (%u)", static_cast<unsigned> (e.size));
  check (e.crc == flatfs::crc32 (g_beta, sizeof (g_beta)),
         "its CRC-32 is the data's (0x%08x)", static_cast<unsigned> (e.crc));
  flatfs::Entry none{};
  check (!p.find ("gamma", 5, none), "no gamma");

  section ("read back");
  check (p.read_blob_at (e, 0, g_back, sizeof (g_back)) == 3000, "3000 bytes read");
  check (std::memcmp (g_back, g_beta, sizeof (g_back)) == 0, "equal to what was added");
  check (p.read_blob_at (e, 2900, g_back, sizeof (g_back)) == 100,
         "100 bytes from offset 2900");
  check (std::memcmp (g_back, g_beta + 2900, 100) == 0, "the right 100");
  check (p.read_blob_at (e, 3000, g_back, sizeof (g_back)) == 0,
         "nothing past the end");
  flatfs::Entry ea{};
  check (p.find ("alpha", 5, ea) && p.read_blob_at (ea, 0, g_back, 1000) == 1000
             && std::memcmp (g_back, g_alpha, 1000) == 0,
         "alpha reads back too");

  section ("rules");
  check (p.add ("sixteen-chars-xx", 16, g_alpha, 8) == flatfs::error::bad_name,
         "a 16-character name: bad_name");
  check (p.add ("", 0, g_alpha, 8) == flatfs::error::bad_name, "an empty name: bad_name");
  check (p.count () == 2, "still two files");

  section ("reformat");
  check (p.format () == flatfs::error::none, "format () = none");
  check (p.count () == 0, "no file");

  finish ();
}
