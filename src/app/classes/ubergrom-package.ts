import {BlobWriter, Entry, TextReader, Uint8ArrayReader, ZipWriter} from '@zip.js/zip.js';
import {Software} from './software';
import {UberGrom, UberGromImage} from '../emulator/classes/ubergrom';

// Proposed RPK binding; see docs/ubergrom-rpk.md. Both package formats
// produce the same device image. Mappings remain in EEPROM, not in XML.
export interface UberGromPackage {
    name?: string;
    flash: string;
    eeprom: string;
    rom?: string;
    writeProtected?: boolean;
}

export async function loadUberGromImages(data: UberGromPackage, entries: Entry[], resources?: Map<string, Element>): Promise<Software> {
    const read = async (name: string, sizes: number[]) => {
        const matches = entries.filter(e => e.filename === name && !e.directory);
        if (matches.length !== 1 || !sizes.includes(matches[0].uncompressedSize)) {
            throw new Error('Missing, duplicate or incorrectly sized UberGROM image: ' + name);
        }
        const blob = await matches[0].getData!(new BlobWriter(), {checkSignature: true});
        if (!sizes.includes(blob.size)) throw new Error('Incorrectly sized UberGROM image: ' + name);
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const resource = resources?.get(name);
        if (resource?.hasAttribute('crc')) {
            const expected = resource.getAttribute('crc')!;
            let crc = 0xffffffff;
            for (const byte of bytes) {
                crc ^= byte;
                for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
            }
            if (!/^[\da-f]{8}$/i.test(expected) || ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0') !== expected.toLowerCase()) {
                throw new Error('UberGROM CRC mismatch: ' + name);
            }
        }
        if (resource?.hasAttribute('sha1')) {
            const expected = resource.getAttribute('sha1')!;
            const digest = await crypto.subtle.digest('SHA-1', await blob.arrayBuffer());
            const actual = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
            if (!/^[\da-f]{40}$/i.test(expected) || actual !== expected.toLowerCase()) throw new Error('UberGROM SHA-1 mismatch: ' + name);
        }
        return bytes;
    };
    const software = new Software();
    software.name = data.name || 'UberGROM';
    software.ubergrom = {
        flash: await read(data.flash, [122880, 131072]),
        eeprom: await read(data.eeprom, [4096]),
        writeProtected: !!data.writeProtected
    };
    if (data.rom) software.rom = await read(data.rom, [8192, 16384, 32768, 65536, 131072, 262144, 524288]);
    new UberGrom(software.ubergrom);
    return software;
}

export async function loadUberGromRpk(xml: Document, entries: Entry[]): Promise<Software> {
    const fail = () => { throw new Error('Invalid UberGROM RPK layout. See docs/ubergrom-rpk.md.'); };
    const root = xml.documentElement;
    if (xml.getElementsByTagName('parsererror').length || root.tagName !== 'romset' || xml.doctype) fail();
    const children = (parent: Element, tag: string) => Array.from(parent.children).filter(e => e.tagName === tag);
    const single = (parent: Element, tag: string): Element => {
        const found = children(parent, tag);
        if (found.length !== 1) fail();
        return found[0];
    };
    const pcb = single(single(root, 'configuration'), 'pcb');
    const resourceList = single(root, 'resources');
    if (xml.getElementsByTagName('pcb').length !== 1 || pcb.getAttribute('type') !== 'ubergrom') fail();
    if (Array.from(pcb.attributes).some(a => !['type', 'write_protected'].includes(a.name))) fail();
    const protection = pcb.getAttribute('write_protected');
    if (protection !== null && protection !== 'true' && protection !== 'false') fail();
    const byId = new Map<string, Element>(), byFile = new Map<string, Element>();
    for (const resource of Array.from(resourceList.children)) {
        const id = resource.getAttribute('id'), file = resource.getAttribute('file');
        if (resource.tagName !== 'rom' || !id || !file || byId.has(id) || byFile.has(file)) fail();
        byId.set(id!, resource);
        byFile.set(file!, resource);
    }
    const sockets = new Map<string, string>(), used = new Set<string>();
    for (const socket of Array.from(pcb.children)) {
        const id = socket.getAttribute('id'), uses = socket.getAttribute('uses');
        if (socket.tagName !== 'socket' || !id || !['flash_socket', 'eeprom_socket', 'rom_socket'].includes(id) ||
            sockets.has(id) || !uses || !byId.has(uses) || used.has(uses)) fail();
        sockets.set(id!, byId.get(uses!)!.getAttribute('file')!);
        used.add(uses!);
    }
    if (!sockets.has('flash_socket') || !sockets.has('eeprom_socket') || used.size !== byId.size) fail();
    return loadUberGromImages({flash: sockets.get('flash_socket')!, eeprom: sockets.get('eeprom_socket')!,
        rom: sockets.get('rom_socket'), writeProtected: protection === 'true'}, entries, byFile);
}

export async function exportUberGromRpk(image: UberGromImage, rom?: Uint8Array): Promise<Blob> {
    const writer = new ZipWriter(new BlobWriter('application/zip'));
    const hasRom = !!rom?.length;
    const layout = `<?xml version="1.0" encoding="UTF-8"?>
<romset>
  <resources>
    <rom id="flash" file="flash.bin" />
    <rom id="eeprom" file="eeprom.bin" />${hasRom ? '\n    <rom id="rom" file="rom.bin" />' : ''}
  </resources>
  <configuration>
    <pcb type="ubergrom" write_protected="${!!image.writeProtected}">
      <socket id="flash_socket" uses="flash" />
      <socket id="eeprom_socket" uses="eeprom" />${hasRom ? '\n      <socket id="rom_socket" uses="rom" />' : ''}
    </pcb>
  </configuration>
</romset>
`;
    await writer.add('layout.xml', new TextReader(layout));
    await writer.add('flash.bin', new Uint8ArrayReader(image.flash));
    await writer.add('eeprom.bin', new Uint8ArrayReader(image.eeprom));
    if (hasRom) await writer.add('rom.bin', new Uint8ArrayReader(rom!));
    return writer.close();
}
