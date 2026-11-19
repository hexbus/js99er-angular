# UberGROM RPK proposal

This is a working proposal for Mike Brent (Tursi), Jon Guidry and the emulator
authors to discuss. It is implemented locally in js99er. It is not yet an
agreed cross-emulator standard, and the names can change after discussion.

An UberGROM cartridge has several separate memories. The package needs to tell
the emulator which file belongs to each one. RPK already gives us a ZIP with
an XML description, so we can use that instead of a separate JSON format.

## What goes in the file

Save a ZIP as `MyCartridge.rpk`. Put `layout.xml` at its root, alongside the
memory images it names. This example includes the optional parallel ROM:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<romset version="1.0">
  <resources>
    <ram id="flash" type="persistent" length="131072" file="mycart-flash.nv" preloaded="flash.bin" />
    <ram id="eeprom" type="persistent" length="4096" file="mycart-eeprom.nv" preloaded="eeprom.bin" />
    <rom id="rom" file="rom.bin" />
  </resources>
  <configuration>
    <pcb type="ubergrom" write_protected="false">
      <socket id="flash_socket" uses="flash" />
      <socket id="eeprom_socket" uses="eeprom" />
      <socket id="rom_socket" uses="rom" />
    </pcb>
  </configuration>
  <rpkversion>1.0</rpkversion>
</romset>
```

`rpkversion` is optional release metadata for any RPK. It is a direct child
of `romset` and is independent of the layout's `version` attribute. js99er
preserves it on export when the loaded package specifies it.

The `id` and file names are arbitrary. Each `uses` value connects a socket to
its resource. For persistent RAM, `preloaded` names the starting image inside
the RPK and `file` names the separate save. Use distinct save names for Flash
and EEPROM. A ZIP member with the save name only supplies a starting image
when `preloaded` explicitly names that member.

| Socket | Contents | Size | Required? |
| --- | --- | --- | --- |
| `flash_socket` | ATmega1284P Flash image | 128 KiB (120 KiB also accepted in legacy layouts) | Yes |
| `eeprom_socket` | ATmega EEPROM, including GROM mappings and saved data | 4 KiB | Yes |
| `rom_socket` | Separate parallel cartridge ROM | 8, 16, 32, 64, 128, 256 or 512 KiB | No |

Without a parallel ROM, omit its resource and socket. Do not supply an empty
file. A regular GROM dump is not an ATmega Flash image.

## What the emulator does

- `type="ubergrom"` selects the production ATmega1284P UberGROM board model.
- Flash and EEPROM load as separate memories. The EEPROM tells the board which
  device and page appear at each GROM base and slot. XML does not duplicate or
  override those mappings.
- `write_protected="true"` starts with JP4 protection enabled. `false`, or
  omitting the attribute, starts with it disabled. This is the board's JP4
  behavior, not a lock on every memory or on the RPK file itself. See the
  [device documentation](ubergrom.md) for programming behavior.
- The optional parallel ROM uses the existing non-inverted, address-based
  8 KiB banking and starts at bank zero. There are no Gigacart data bits here.
- A 120 KiB Flash image is padded with `FF` to 128 KiB. It does not acquire
  recovery firmware. A full 128 KiB image preserves the last 8 KiB for
  firmware/recovery; that region is not ordinary writable GROM storage.
- Recovery is available only when the image contains firmware the emulator
  recognizes. An image with erased application space and intact recovery is
  what js99er's **Create blank virtual UberGROM** supplies.

The RPK is a cartridge image, not an emulator save state. It does not save
volatile RAM, the current ROM bank, UART queues, timer state or an active
recovery override. Those still belong to emulator save states. Host serial
ports, network addresses, Wi-Fi modem settings, ADC inputs and GPIO wiring
also stay in emulator settings, outside the cartridge package.

## Loading, saving and older packages

Choose **Load cart** and select the RPK. **Export current cartridge** now writes
`ubergrom.rpk`, containing the current Flash, EEPROM, optional ROM and JP4
setting. The exported images are the starting contents for the new package.
The exporter assigns distinct `.nv` save names and leaves the source RPK
intact. js99er keeps runtime saves in IndexedDB under the existing key derived
from the starting image bytes. A matching browser save takes precedence when
you load a package. See the [UberGROM instructions](ubergrom.md#programming-and-saved-data).

Existing ZIPs with `ubergrom.json` and RPKs that describe the initial Flash and
EEPROM as `<rom>` continue to load.
Do not include both `layout.xml` and `ubergrom.json` in one archive.

For a batch conversion, use:

```text
python tools/convert-ubergrom-rpk.py SOURCE_DIRECTORY NEW_OUTPUT_DIRECTORY
```

Pass `--rpkversion 1.0` to assign a release version to each converted package.

The converter finds the older JSON packages, keeps their directory structure,
preserves accompanying documentation and writes new RPKs. It extends 120 KiB
Flash images to 128 KiB with `FF` bytes. That changes the browser save key for
those packages. Use **Export current cartridge** to capture browser-saved
changes in a new RPK. The converter leaves the source files alone and refuses
to overwrite an existing output file.

## Validation rules in this implementation

There must be exactly one layout, one board and one resource per socket.
Flash and EEPROM sockets are required. Duplicate IDs, files or sockets,
unconnected resources, unknown sockets and unknown board settings are errors.
The JP4 attribute accepts only `true` or `false`. XML is UTF-8; DTDs are not used.
The layout may be at most 64 KiB. Referenced filenames must match ZIP entries
exactly, including case. Each persistent preload must match its declared and
board-supported size.

Optional resource `crc` and `sha1` attributes are checked against the image
bytes before loading. Use eight hexadecimal digits for CRC32 or forty for
SHA-1. ZIP entry CRCs are checked too. The exporter omits the optional XML
hashes, so a later export cannot retain stale hashes from an earlier image.

## Running the checks

Run `npm run test:ubergrom-rpk` for the browser package tests. They exercise
loading, export/reload, browser persistence, recovery, optional checksums,
invalid layouts and the existing ordinary/Gigacart RPK paths. Chrome must be
installed; set `CHROME_BIN` if it is not found automatically.

This uses a dedicated test TypeScript configuration because the existing
aggregate suite currently has an unrelated type error in the disk component
specification. The emulator regression scripts remain separate.

## Points to discuss with Mike and the emulator authors

Are `ubergrom`, `flash_socket`, `eeprom_socket` and `rom_socket` the right names?
Should JP4 be expressed this way, or only be an emulator control? Is supporting
both 120 and 128 KiB Flash images useful across implementations? Are there
other physical board variants we should distinguish before agreeing on this?

This proposal describes the board we emulate now. It does not require MAME or
Classic99 to accept these names before their authors have agreed and added
support. No firmware changes are part of this work.

Hardware and firmware reference: Mike Brent's
[UberGROM project](https://github.com/tursilion/ubergrom).

Assisted by Codex.
