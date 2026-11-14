/*
 * flash-id — the WeAct F411CE's SPI NOR flash answers: SPI1 comes up, the
 * transport spi::probe () keeps, the JEDEC ID (Winbond) and the size it
 * gives, the status register idle, and a read that is stable.
 * Classic board test: UART report, RESULT through hw_result (flash_check.hpp).
 */
#include <flash_check.hpp>

using namespace flash_check;

int
os_main (int, char*[])
{
  if (!bring_up ("flash-id"))
    {
      finish ();
    }

  section ("identity");
  const flash::JedecId id = flash::read_id ();
  check (id.manufacturer == 0xEF, "manufacturer 0xEF, Winbond (0x%02x)",
         id.manufacturer);
  check (id.mem_type == 0x40 || id.mem_type == 0x60 || id.mem_type == 0x70,
         "memory type a W25Q family code (0x%02x)", id.mem_type);
  check (id.capacity >= 0x14 && id.capacity <= 0x19,
         "capacity code 0x14..0x19, 1..32 MiB (0x%02x = %u KiB)", id.capacity,
         static_cast<unsigned> (st ().size / 1024u));
  const flash::JedecId again = flash::read_id ();
  check (std::memcmp (&id, &again, sizeof (id)) == 0,
         "the ID reads the same twice");

  section ("status and transport");
  const unsigned sr1 = flash::read_status1 ();
  check ((sr1 & 0x01u) == 0, "status BUSY clear (SR1 0x%02x)", sr1);
  check ((sr1 & 0x02u) == 0, "write-enable latch clear");
  check (spi::current () != spi::transport::polled,
         "spi::probe () kept an interrupt-driven transport (%s)",
         spi::transport_name (spi::current ()));

  section ("a stable read");
  static std::uint8_t a[sector];
  static std::uint8_t b[sector];
  flash::read (0, a, sector);
  flash::read (0, b, sector);
  check (std::memcmp (a, b, sector) == 0,
         "the first 4 KiB read twice the same (flatfs superblock area)");

  finish ();
}
