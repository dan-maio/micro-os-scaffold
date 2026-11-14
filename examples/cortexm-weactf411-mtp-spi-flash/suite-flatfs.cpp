// 03 - flatfs: format, files, CRC, partial reads, bad names, reformat.
// One suite, one file: it registers itself with the runner; there is no
// list of suites to keep in step with the files.
#include <mtp_board.hpp>
#include "flash_helpers.hpp"

using namespace os::rtos;
using namespace mtp_flash;

namespace
{
  std::uint8_t g_alpha[1000];
  std::uint8_t g_beta[3000];
} // namespace

mt::static_suite suite_flatfs{
  "03 - flatfs", mtp_board::runner (),
  [] (mt::suite& ts) {
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
};
