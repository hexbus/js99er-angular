"""Build the blank cartridge template from an owner's full UberGROM package.

Usage: python tools/build-blank-ubergrom.py cartridge.zip Source-License.txt
Only the recognized, unchanged firmware is retained; no application or ROM data.
"""
import hashlib
import json
from pathlib import Path
import sys
import zipfile

FIRMWARE_SHA256 = '3c90c9ddb44eea6415e1e4362b99afe6c6fd601c427177acb2e3bfa325fbabc6'

with zipfile.ZipFile(sys.argv[1]) as source:
    manifest = json.loads(source.read('ubergrom.json'))
    flash = source.read(manifest['flash'])
    assert len(flash) == 131072, 'A full 128 KiB ATmega image is required'
    firmware = flash[0x1e000:]
    assert hashlib.sha256(firmware).hexdigest() == FIRMWARE_SHA256, 'Unrecognized recovery firmware'

output = Path(__file__).resolve().parents[1] / 'src/assets/software/ubergrom-blank.zip'
notice = '''Blank UberGROM cartridge template

UberGROM firmware by Mike Brent (Tursi): https://harmlesslion.com
Source: https://github.com/tursilion/ubergrom
Firmware is unchanged. The UberGROM Addendum in Source License.txt permits
release of cartridges using the unmodified firmware with attribution.

Application Flash (120 KiB) and EEPROM (4 KiB) are erased. The final 8 KiB
contains the original firmware, including EASYbug and Run Program File.
js99er initializes erased EEPROM with the firmware's initial mappings.
No parallel ROM, application, GROMCFG or disk is included.
Hold Space during startup to select recovery.

Firmware SHA-256: ''' + FIRMWARE_SHA256 + '\n'
files = {
    'ubergrom.json': json.dumps({'format': 'js99er-ubergrom-1', 'name': 'Blank UberGROM with recovery',
                                'flash': 'flash.bin', 'eeprom': 'eeprom.bin'}, indent=2).encode(),
    'flash.bin': b'\xff' * 0x1e000 + firmware,
    'eeprom.bin': b'\xff' * 4096,
    'README.txt': notice.encode(),
    'Source License.txt': Path(sys.argv[2]).read_bytes(),
}
with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED) as target:
    for name, contents in files.items():
        info = zipfile.ZipInfo(name, (2026, 10, 21, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        target.writestr(info, contents)
print(output)
print('Firmware SHA-256:', FIRMWARE_SHA256)
