"""Convert legacy js99er UberGROM ZIPs to the proposed RPK binding.

Writes new files only. Expands short Flash images to the board's capacity.
See docs/ubergrom-rpk.md. Uses only the Python standard library.
"""
import argparse
import json
from pathlib import Path
import xml.etree.ElementTree as ET
from uuid import uuid4
from zipfile import ZipFile, ZIP_DEFLATED


def convert(source, destination, rpk_version=None):
    with ZipFile(source) as archive:
        names = archive.namelist()
        if 'ubergrom.json' not in names:
            return False
        if len(set(names)) != len(names) or 'layout.xml' in names:
            raise ValueError(f'Duplicate or conflicting descriptions: {source}')
        info = archive.getinfo('ubergrom.json')
        if info.file_size > 16384:
            raise ValueError(f'Oversized manifest: {source}')
        manifest = json.loads(archive.read(info))
        if manifest.get('format') != 'js99er-ubergrom-1':
            raise ValueError(f'Unsupported format: {source}')
        protection = manifest.get('writeProtected', False)
        if not isinstance(protection, bool):
            raise ValueError(f'Invalid write protection: {source}')
        root = ET.Element('romset', version='1.0')
        resources = ET.SubElement(root, 'resources')
        pcb = ET.SubElement(ET.SubElement(root, 'configuration'), 'pcb',
                            type='ubergrom', write_protected=str(protection).lower())
        used = set()
        save_prefix = f'ubergrom-{uuid4()}'
        flash_name = manifest.get('flash')
        for kind, sizes in [('flash', (122880, 131072)), ('eeprom', (4096,)),
                            ('rom', (8192, 16384, 32768, 65536, 131072, 262144, 524288))]:
            name = manifest.get(kind)
            if kind == 'rom' and not name:
                continue
            if not isinstance(name, str) or name not in names or name in used or archive.getinfo(name).file_size not in sizes:
                raise ValueError(f'Invalid {kind} image: {source}')
            used.add(name)
            if kind == 'rom':
                ET.SubElement(resources, 'rom', id=kind, file=name)
            else:
                ET.SubElement(resources, 'ram', id=kind, type='persistent',
                              length='131072' if kind == 'flash' else '4096',
                              file=f'{save_prefix}-{kind}.nv', preloaded=name)
            ET.SubElement(pcb, 'socket', id=kind + '_socket', uses=kind)
        if rpk_version:
            ET.SubElement(root, 'rpkversion').text = rpk_version
        ET.indent(root, space='  ')
        layout = ET.tostring(root, encoding='utf-8', xml_declaration=True)
        # Reading every member checks its ZIP CRC before creating the output.
        members = {}
        for name in names:
            if name != 'ubergrom.json':
                data = archive.read(name)
                members[name] = data.ljust(131072, b'\xff') if name == flash_name else data
    destination.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(destination, 'x', compression=ZIP_DEFLATED) as output:
        output.writestr('layout.xml', layout)
        for name, data in members.items():
            output.writestr(name, data)
    with ZipFile(destination) as output:
        for name, data in members.items():
            if output.read(name) != data:
                raise ValueError(f'Conversion verification failed: {destination}: {name}')
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('destination', type=Path)
    parser.add_argument('--rpkversion', help='Release version to put in each converted RPK')
    args = parser.parse_args()
    source, destination = args.source.resolve(), args.destination.resolve()
    if source == destination or source in destination.parents:
        parser.error('Use a separate output directory, outside the source directory.')
    if not source.is_dir():
        parser.error('Source must be a directory.')
    count = 0
    for path in sorted(source.rglob('*.zip')):
        target = destination / path.relative_to(source).with_suffix('.rpk')
        if convert(path, target, args.rpkversion):
            count += 1
            print(target)
    print(f'Converted and byte-verified {count} packages. Source files unchanged.')


if __name__ == '__main__':
    main()
