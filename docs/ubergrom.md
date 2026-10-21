# UberGROM in js99er

This experimental implementation treats UberGROM as a programmable cartridge.
It keeps the ATmega Flash and EEPROM separate from the parallel cartridge ROM.
GROMCFG can change the active board's mappings and program its memory. Software
can use its RAM, EEPROM, Flash controller, UART, timer, ADC and GPIO.

The implementation models the TI-visible interface, not AVR instructions.
See [validation and remaining work](#validation-and-remaining-work) before
treating it as a complete hardware replacement.

## Load a cartridge

Use **Load cart** to select a ZIP with `ubergrom.json` at its root:

```json
{
  "format": "js99er-ubergrom-1",
  "name": "My cartridge",
  "flash": "flash.bin",
  "eeprom": "eeprom.bin",
  "rom": "rom.bin",
  "writeProtected": false
}
```

The names identify files inside that ZIP:

| File | Meaning | Accepted size |
| --- | --- | --- |
| `flash.bin` | ATmega Flash image | 120 or 128 KiB |
| `eeprom.bin` | ATmega EEPROM, including device mappings | 4 KiB |
| `rom.bin` | Optional, separate parallel ROM | Power of two, 8-512 KiB |

The last 8 KiB of a 128 KiB ATmega image is retained when exporting, but is not
mapped as ordinary GROM or programmable storage. A 120 KiB input is padded
with `FF` there. The parallel ROM is non-inverted address-banked ROM; its
contents are not the ATmega Flash.

This is an explicit js99er package format, not an RPK standard. A raw `.bin`
does not identify all these memories and is not guessed to be an UberGROM.
Keep the source EEPROM with its matching Flash image: it determines what the
TI sees.

## Programming and saved data

Open the **UberGROM** tab for JP4 write protection and **Export current
cartridge**. Export includes the current ATmega Flash, EEPROM, optional ROM
and manifest.

Flash and EEPROM changes are saved in IndexedDB for this browser and site.
Loading the same original package resumes that cartridge's stored contents.
Export backups before clearing browser data or moving to another browser.
Persistence errors are reported in the Log.

**Create blank virtual UberGROM** creates empty cartridge space with the original
recovery firmware intact. Each board has a separate storage identity, 120 KiB of
erased application Flash, fresh EEPROM initialized to the firmware's initial
mappings, and no parallel ROM. Hold Space during startup, or check **Use recovery
mode** and press **Reset**, to reach **Easy Bug** and **Run Program File**.
Use Run Program File to load GROMCFG from a mounted disk with 32K RAM enabled.
GROMCFG itself is not included in the cartridge.

The template is `src/assets/software/ubergrom-blank.zip`. It includes Tursi's
unmodified firmware, attribution and original license. The UberGROM Addendum
permits cartridges using his unmodified firmware. Rebuild it using
`tools/build-blank-ubergrom.py` with a full UberGROM package and the original
license file; the builder verifies the firmware SHA-256 listed below.
A missing or invalid template reports an error and leaves the current cartridge
in place; it never falls back to creating a board without recovery.

## Recovery at power-up

With the released AVR firmware present and recovery enabled in EEPROM, hold
Space during cartridge startup. The console then offers **Easy Bug** and
**Run Program File** even if the user GROM mappings are damaged. The latter
can load GROMCFG from disk to repair the board. The UberGROM tab shows whether
recovery is available, disabled, active, or normal startup was selected.

The emulator executes the recovery GPL already in the supplied Flash image;
the blank template supplies that same unmodified firmware. The emulator does
not replace the console's keyboard test.
The temporary power-up header is at GROM `>E000`. Once startup finishes,
recovery overrides `>6000–>7FFF` on bases 0 and 1 only. Configuration access
on base 15 remains available. Reset preserves the power-up decision, as on
the powered board; reloading the cartridge creates a new power-up session.
Save states preserve the decision too.

The currently recognized 8 KiB firmware section (`>1E000–>1FFFF`) has SHA-256
`3c90c9ddb44eea6415e1e4362b99afe6c6fd601c427177acb2e3bfa325fbabc6`.
The same firmware is present in the tested standard UBE1/UBF1 and UberHDX
images. A 120 KiB application-only image, erased firmware, or another firmware
layout still supports the ordinary emulated services, but does not acquire an
invented recovery program. Its tab reports recovery as unavailable.

Both a native CPU test and browser test exercise Space through the console.
The native test also enters Easy Bug and loads the real GROMCFG using Run
Program File, with the ordinary GROM slots unmapped.

GROMCFG has been tested from an Editor/Assembler cartridge package with a disk
containing GROMCFG. Its changes apply to the running board. JP4 protects
configuration and Flash; the user EEPROM area remains writable.

## Adjustable serial settings

The tab displays **Actual UART**: baud rate, data bits, parity and stop bits.
These come from the emulated registers, independently of what a terminal's
menu claims to select.

Set the desired baud rate, 5-8 data bits, none/even/odd parity, and 1 or 2 stop
bits, then select **Apply to UART**. Custom baud rates are accepted within the
8 MHz AVR's divider range. The closest achievable rate is displayed; for
example 38,400 becomes approximately 38,461.54 baud.

These controls write the same register state TI software controls. They do
not lock the UART: later program writes take effect. **Copy actual settings**
copies the current values into the controls. A new board or browser reload
starts with firmware defaults; emulator save states preserve UART registers.

Available connections:

- **Local serial terminal** displays transmitted characters and sends text
  back to the TI. Select no line ending, CR, LF or CR+LF.
- **Serial loopback test** returns transmitted bytes to the TI.
- **External WebSocket service** connects to a bridge address you supply.
  It carries binary bytes and reports UART settings to the bridge.

### Wi-Fi modem checkbox

In the local build, start js99er with **Start-js99er.bat**, load your UberGROM
cartridge, and check **Wi-Fi modem** in the UberGROM tab. Then run Telco or
TIMXT with its UberGROM serial driver. Type `AT` and press Enter for `OK`,
then type `ATDTbbs.net` to dial. For another port, use `ATDTbbs.net:2323`.
The launcher starts the modem service automatically; there is no second
program to launch and no bridge address to enter.

The checkbox connects immediately and is remembered in this browser.
Unchecking it hangs up and returns to the selected ordinary serial connection.
It does not change the cartridge's EEPROM mapping or the terminal's UART
settings. Leaving the UberGROM tab does not end the connection. Reloading
the page ends any call; the remembered checkbox reconnects the modem when
an UberGROM is loaded, but does not redial a BBS.

The modem receives the UART's actual baud rate, data bits, parity and stop
bits on connection and whenever TI software changes the registers. This is
automatic synchronization, not auto-baud guessing from typed characters.
For example, Telco's 38,400 setting produces about 38,461.54 baud, reported
by the modem as `CONNECT 38462`. Receive delivery uses that framing/rate,
with small, conservatively paced bursts; this does not promise physical
serial timing or full line-rate throughput.

Supported commands include `AT`, `ATI`, `ATE0`/`ATE1`, `ATDT`, `ATH`, `ATZ`,
and `ATO`. To leave an active connection temporarily, wait one second,
type `+++`, then wait another second. `ATH` hangs up; `ATO` returns to the
connection. `ATDTtcp://host:port` selects raw TCP instead of Telnet.

The implementation is a small AT/Telnet modem, not an ESP firmware or Wi-Fi
radio emulator. It does not add automatic RTS/CTS or XON/XOFF flow control.
Only one browser modem connection is accepted at a time.

For developers, `npm run serve` also starts both services. The default app
port is 4205, and `npm run serve -- --port 4206` selects another port. The
modem binds only to `127.0.0.1:4210`, accepting the local launcher's explicit
browser origins. An existing compatible modem is reused. A public website
such as js99er.net needs its own hosted connection service; this local-only
checkbox is disabled on hosted sites. No public relay is bundled.

### Ordinary serial connections

Select **Connect** after choosing a connection. **Disconnect** closes it.
Local ADC sliders supply four 8-bit inputs. GPIO inputs and outputs are also
available. The bridge can supply these inputs instead.

UART framing and transmit time follow the emulated CPU clock. Pause stops
transmission. Incoming bridge messages currently enter the receive buffer as
bursts, not as individual timed electrical transitions. The buffer holds 255
bytes; programs must service it. RTS/CTS, XON/XOFF and a modem command set are
not silently synthesized. A program and its bridge must implement their
chosen flow-control/protocol behavior, using GPIO where appropriate.

### Terminal compatibility

The archived UberGROM TIMXT v1.1.2017 initializes at approximately 19,200
baud, 8-N-1. Its menu does not reconfigure the UART, and its keyboard scanner
still polls a CRU-based RS232 device. In the tested setup that fills the
software receive buffer with unwanted bytes. Loading this unmodified archive
therefore does not provide working menu-controlled serial settings.

A separate private TIMXT binary patch replaces that polling hook and connects
the six baud and six format choices to the UART. All 36 combinations passed
actual-program menu, buffered input, and transmit/receive tests. A browser
run also verified menu-selected 38.4K/7E1 with input and output afterward.
The patched program is not bundled with js99er.

A separate private TELCO 2.3 integration passed four native-menu configurations
(9600/8N1, 19200/7E1, 38400/8O2, 57600/8N1), transmit/receive, and saved-settings
restart. TELCO's video detection also requires the VRAM-write/read-buffer
correction covered by `npm run test:vdp-ports`. These checks used emulated
UART endpoints; physical serial compatibility remains open.

Further private patches passed XMODEM CRC and 1K packets in both directions,
including files larger than 32 KiB and the real WebSocket bridge. The generic
disk controller now supports direct file output and raw-sector input for data
files, covered by `npm run test:direct-files`. Disk/TIFILES import and export
corrections preserve fixed-record counts and multi-sector data.

The detailed local instructions and evidence are maintained in
the separate TELCO/TIMXT package. Those terminal binaries and
the experimental transfer launcher are not bundled with js99er. The separate
Telco transfer build now recovers repeated packets. TIMXT also passed TI-file
YMODEM batch transfers. Protocol details, limits and ZMODEM follow-on scope
remain in that canonical transfer document.

## Connection API

`UberGromConnection` is independent of the cartridge model. A connection can
implement `transmit`, `configureSerial`, `readADC`, `readGPIO`, `writeGPIO`
and `close`. Received bytes enter through `UberGrom.receiveSerial`.

The optional WebSocket transport uses binary messages for UART bytes, in
either direction. Outbound JSON messages include:

```json
{"type":"hello","protocol":"js99er-ubergrom-1"}
{"type":"serial","baud":38461.53846153846,"dataBits":7,"parity":"even","stopBits":2}
{"type":"gpio","value":0,"direction":0}
```

Inbound JSON messages:

```json
{"type":"adc","channel":0,"value":128}
{"type":"gpio","value":5,"driven":15}
```

ADC channels are 0-3 and values 0-255. GPIO uses four low bits; `direction`
marks output bits and `driven` identifies externally driven input bits.
Undriven inputs follow emulated pull-ups.

This connection API carries bytes and device settings. It does not implement
UberHDX, TIPI, FujiNet or a physical serial-port driver. The optional local
AT/Telnet modem described above is a separate service. Those services can be connected
without adding their protocols to the memory mapper. An HTTPS deployment
needs a browser-permitted secure bridge (`wss://`).

Unloading a cartridge closes its connection. Restoring a save state cannot
rewind an external service. Ordinary external connections remain disconnected;
with Wi-Fi modem checked, restoration connects a fresh modem in command mode
and never resumes or redials the previous call.

## Validation and remaining work

Run `npm run test:ubergrom` for synthetic mapping, EEPROM protection,
Flash programming, RAM, UART, timer, ADC/GPIO, save-state, package-validation
and bridge-contract tests. No commercial cartridge images are included.

Additional private-image checks used the production emulator classes:

- 32 packages: console menu and first-selection smoke checks.
- Editor/Assembler: BASIC UBE1/UBG1 save, load, run and delete; editor file
  save/reload including a file larger than 8 KiB; RAM test.
- TI Writer, Multiplan and Return to Pirate's Isle: application save/reload.
- Tunnels of Doom: all 23 ROM1 filenames; two UBG1 save/fresh-load/Continue
  scenarios.
- SMU: 22 launch scenarios. Test Trainer: 28 lesson scenarios. Advertizer:
  six demo scenarios.
- Actual GROMCFG: RAM mapping, Flash remapping, programming and saving an
  8 KiB pattern, compared byte for byte.
- Patched TIMXT and TELCO: native-menu serial tests, XMODEM/1K, TIMXT YMODEM,
  and Telco TIFILES ZMODEM cancellation/resume. The current private Telco disk
  also passed 24 regression groups covering its launcher, storage, 40/80
  display, status bar and transfers. Original terminal personalities and
  legacy protocols are not all qualified for UberGROM/F18A.
- Unmodified UberHDX v2.0: native-UI catalog and 8 KiB PROGRAM transfers in
  both directions, byte-exact with file metadata checked. The peer was a
  deterministic fixture based on Fred Kaal's published HDX server protocol,
  not his running Windows server. Other file types and HDX error recovery
  remain untested.
- Browser UI: synthetic TI code transmitted `HELLO` through the local terminal
  and a real local WebSocket connection. Settings reached the bridge.
  EEPROM contents survived browser reload and were checked in exported ZIPs.

The mapper, UberGROM, VDP, direct-file, memory-inspector and audio-gate
regression suites passed. The production build passed. After the RAM timing change, all 24 terminal groups and the application
save/reload, Tunnels of Doom, SMU, Test Trainer and Advertizer suites passed
again. The 32-package inventory was also repeated; a first-selection smoke
check is not a full application test.

## RAM timing calibration

The calibration uses Jon's photographed Corcomp 32K-sidecar UGBENCH run of
September 24, 2026, and the exact same benchmark binary. The data check passes.
Beyond js99er's existing port costs, the model adds 15 CPU cycles per address
access, 102 per mapped RAM read, and 90 per mapped RAM write. These are fitted
3 MHz CPU wait costs, not a claim about exact AVR instruction counts.

| UGBENCH workload | Recorded hardware ticks | Emulator ticks |
| --- | ---: | ---: |
| Byte read, 4,096 operations | 349,440 | 349,440 |
| Byte write, 4,096 operations | 353,021 | 352,768 |
| Word read, 4,096 operations | 376,064 | 376,064 |
| Word write, 4,096 operations | 379,041 | 379,648 |
| Read 65,536 bytes | 322,979 | 323,072 |
| Write 65,536 bytes | 363,481 | 364,032 |
| Fill 65,536 bytes | 354,065 | 354,816 |

All seven workloads agree within 0.22%. The empty timer sample remains 768
emulator ticks versus 512 recorded ticks. That discrepancy is retained:
changing the shared TMS9901 timing merely to fit this sample would affect
unrelated cartridges. Before calibration, the bulk-read total was 218,112
ticks. The correction applies to UberGROM; ordinary GROM and Gigacart retain
their existing timing.

This is calibration against one observed setup, not independent validation
on a second board. Different oscillators, console bus timing and electrical
effects can differ. The measured program SHA-256 is
`4443237eb735e476367608c3f4a01edac2d70f5aa38ce9869703f7ae27d546a6`.

## Remaining physical limits

These checks do not establish exhaustive application compatibility or timing
accuracy. EEPROM, Flash and ADC delays are nominal. Physical UART devices
and electrical framing have not been measured in this qualification. A
65,536-byte paced UART test covers FIFO wrapping and application-controlled
GPIO pauses; an unpaced burst correctly reports overflow at 255 buffered
bytes. This does not invent automatic RTS/CTS support in the AVR firmware.
External modem interoperability and listening quality still require checks
with the intended physical setup.

Released firmware and older prose differ in some details. This model follows
the firmware's counter increment mask and initial GPIO registers; it does not
silently treat the older descriptions as equivalent.

## References and credit

Mike Brent (Tursi)'s [UberGROM repository](https://github.com/tursilion/ubergrom)
is the primary interface and firmware reference.
[The maintained UberGROM materials](https://github.com/hexbus/ubergrom) include
board documentation and contributed examples.
Fred Kaal's [HDX server source](https://hexbus.com/ti99geek/Projects/ti99hdx/Files/ti99hdx122b_src.zip)
supplies the protocol reference for the private UberHDX application test.

Jon supplied board knowledge, cartridge images and real-system observations.
The implementation was independently written with OpenAI Codex assistance.
Reference firmware and third-party application binaries are not bundled here.

## Utilities and blank-board checks

Tursi's released GROMTEST passed all eight service tests. GROMCFG programmed
and verified all 15 application Flash pages, and GROMLOAD restored Flash and
EEPROM after the test deliberately overwrote user data. These runs used a
private utilities disk; the disk and its programs are not included here.
The loose repository GROMTEST build has a Flash pattern-generation mismatch;
the unchanged gromtest.zip release passed and was used for these checks.

The blank-board browser test booted Easy Bug and Run Program File, checked
fresh storage identities, verified recovery after reload, and confirmed that
a missing template leaves the current cartridge intact. A CPU integration
run loaded the original GROMCFG from disk and configured its Flash service.
Run `npm run test:ubergrom-blank` for the shipped template and creation tests.
