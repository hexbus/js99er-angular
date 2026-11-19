import {BlobReader, BlobWriter, TextReader, TextWriter, Uint8ArrayReader, ZipReader, ZipWriter} from '@zip.js/zip.js';
import {firstValueFrom} from 'rxjs';
import {ModuleService} from '../services/module.service';
import {exportUberGromRpk, loadUberGromRpk} from './ubergrom-package';
import {UberGrom} from '../emulator/classes/ubergrom';
import {UberGromStorage} from './ubergrom-storage';

describe('Proposed UberGROM RPK package', () => {
    const service: ModuleService = Object.create(ModuleService.prototype);
    const image = () => ({flash: new Uint8Array(131072).fill(255), eeprom: new Uint8Array(4096).fill(255), writeProtected: true});
    const load = (blob: Blob) => firstValueFrom(service.loadRPKOrZipModule(new BlobReader(blob)));
    // Optional private library supplied by a local Karma config; no cartridge
    // images or machine-specific paths are checked into the source tree.
    const library: {source: string; rpk: string}[] = (window as any).__karma__.config.args[0]?.cartridges || [];
    for (const pair of library) {
        it('preserves the loaded cartridge: ' + pair.rpk.split('/').pop(), async () => {
            const fetchCart = async (path: string) => {
                const response = await fetch('/absolute' + path);
                if (!response.ok) throw new Error('Cannot load test fixture: ' + path);
                return load(await response.blob());
            };
            const original = await fetchCart(pair.source), converted = await fetchCart(pair.rpk);
            expect(converted.ubergrom).toEqual(original.ubergrom);
            expect(converted.rom).toEqual(original.rom);
            expect(new UberGrom(converted.ubergrom!).getState()).toEqual(new UberGrom(original.ubergrom!).getState());
        });
    }
    const xml = (text: string) => new DOMParser().parseFromString(text, 'text/xml');
    const layout = `<romset><resources><rom id="f" file="flash.bin"/><rom id="e" file="eeprom.bin"/></resources>
        <configuration><pcb type="ubergrom"><socket id="flash_socket" uses="f"/>
        <socket id="eeprom_socket" uses="e"/></pcb></configuration></romset>`;
    const persistentLayout = layout
        .replace('<rom id="f" file="flash.bin"/>',
            '<ram id="f" type="persistent" length="131072" file="test-flash.nv" preloaded="flash.bin"/>')
        .replace('<rom id="e" file="eeprom.bin"/>',
            '<ram id="e" type="persistent" length="4096" file="test-eeprom.nv" preloaded="eeprom.bin"/>');
    async function archive(text: string, data = image(), extra?: string) {
        const writer = new ZipWriter(new BlobWriter());
        await writer.add('layout.xml', new TextReader(text));
        await writer.add('flash.bin', new Uint8ArrayReader(data.flash));
        await writer.add('eeprom.bin', new Uint8ArrayReader(data.eeprom));
        if (extra) await writer.add('ubergrom.json', new TextReader(extra));
        return writer.close();
    }
    it('exports and loads identical memories, JP4 and optional parallel ROM through the public loader', async () => {
        for (const size of [0, 8192, 524288]) {
            const input = image();
            input.flash[2345] = 123; input.eeprom[1234] = 99;
            const rom = size ? Uint8Array.from({length: size}, (_, i) => i & 255) : undefined;
            const result = await load(await exportUberGromRpk(input, rom));
            expect(result.ubergrom!.flash).toEqual(input.flash);
            expect(result.ubergrom!.eeprom).toEqual(input.eeprom);
            expect(result.ubergrom!.writeProtected).toBeTrue();
            if (rom) expect(result.rom).toEqual(rom); else expect(result.rom).toBeFalsy();
        }
    });
    it('keeps JSON loading compatible and produces the same device state and GROM reads', async () => {
        const input = image(); input.eeprom[0] = 3; input.eeprom[1] = 252;
        input.eeprom[5] = 0x10; input.eeprom[13] = 0xef; input.flash[0] = 0x42;
        const writer = new ZipWriter(new BlobWriter());
        await writer.add('ubergrom.json', new TextReader(JSON.stringify({format: 'js99er-ubergrom-1',
            flash: 'flash.bin', eeprom: 'eeprom.bin', writeProtected: true})));
        await writer.add('flash.bin', new Uint8ArrayReader(input.flash));
        await writer.add('eeprom.bin', new Uint8ArrayReader(input.eeprom));
        const legacy = await load(await writer.close());
        const proposed = await load(await exportUberGromRpk(input));
        expect(proposed.ubergrom).toEqual(legacy.ubergrom);
        for (const sw of [legacy, proposed]) {
            const device = new UberGrom(sw.ubergrom!);
            device.writePort(0x9c02, 0x6000); device.writePort(0x9c02, 0);
            expect(device.readPort(0x9800)).toBe(0x4200);
        }
    });
    it('accepts 120 KiB Flash and defaults JP4 to unprotected', async () => {
        const input = image(); input.flash = input.flash.slice(0, 122880);
        const sw = await load(await archive(layout, input));
        expect(sw.ubergrom!.flash.length).toBe(122880);
        expect(sw.ubergrom!.writeProtected).toBeFalse();
        expect(new UberGrom(sw.ubergrom!).flash.length).toBe(131072);
        const exported = await load(await exportUberGromRpk(sw.ubergrom!));
        expect(exported.ubergrom!.flash.slice(0, 122880)).toEqual(input.flash);
        expect(exported.ubergrom!.flash.slice(122880).every(byte => byte === 255)).toBeTrue();
    });

    it('loads declared preloads and ignores a bundled file with the save name', async () => {
        const input = image();
        input.flash[0] = 0x56;
        input.eeprom[0] = 0x78;
        const writer = new ZipWriter(new BlobWriter());
        await writer.add('layout.xml', new TextReader(persistentLayout));
        await writer.add('flash.bin', new Uint8ArrayReader(input.flash));
        await writer.add('eeprom.bin', new Uint8ArrayReader(input.eeprom));
        await writer.add('test-flash.nv', new Uint8ArrayReader(new Uint8Array(131072)));
        await writer.add('test-eeprom.nv', new Uint8ArrayReader(new Uint8Array(4096)));
        const software = await load(await writer.close());
        expect(software.ubergrom!.flash[0]).toBe(0x56);
        expect(software.ubergrom!.eeprom[0]).toBe(0x78);
    });

    it('checks the persistent declarations and requires full-sized Flash preloads', async () => {
        const invalid = [
            persistentLayout.replace('type="persistent"', 'type="volatile"'),
            persistentLayout.replace('length="131072"', 'length="122880"'),
            persistentLayout.replace('length="4096"', 'length="131072"'),
            persistentLayout.replace('file="test-eeprom.nv"', 'file="test-flash.nv"'),
            persistentLayout.replace('file="test-eeprom.nv"', ''),
            persistentLayout.replace('preloaded="flash.bin"', ''),
            persistentLayout.replace('preloaded="flash.bin"', 'preloaded="absent.bin"'),
            persistentLayout.replace('flash_socket', 'rom_socket')
        ];
        for (const text of invalid) {
            await expectAsync(load(await archive(text))).toBeRejected();
        }
        const input = image();
        input.flash = input.flash.slice(0, 122880);
        await expectAsync(load(await archive(persistentLayout, input))).toBeRejected();
    });
    it('shares existing browser saves across equivalent JSON and RPK images', async () => {
        const input = image();
        // Unique contents keep this test away from other saved cartridges.
        crypto.getRandomValues(input.flash.subarray(0, 32));
        const original = await load(await exportUberGromRpk(input));
        await UberGromStorage.prepare(original);
        const key = original.ubergrom!.storageKey!;
        try {
            const device = new UberGrom(original.ubergrom!);
            device.flash[1000] = 0x56; device.eeprom[1000] = 0x78;
            await UberGromStorage.save(device);
            const writer = new ZipWriter(new BlobWriter());
            await writer.add('ubergrom.json', new TextReader(JSON.stringify({format: 'js99er-ubergrom-1',
                flash: 'flash.bin', eeprom: 'eeprom.bin'})));
            await writer.add('flash.bin', new Uint8ArrayReader(input.flash));
            await writer.add('eeprom.bin', new Uint8ArrayReader(input.eeprom));
            const legacy = await load(await writer.close());
            await UberGromStorage.prepare(legacy);
            expect(legacy.ubergrom!.storageKey).toBe(key);
            expect(legacy.ubergrom!.flash[1000]).toBe(0x56);
            expect(legacy.ubergrom!.eeprom[1000]).toBe(0x78);
            const olderRpk = await load(await archive(layout, input));
            await UberGromStorage.prepare(olderRpk);
            expect(olderRpk.ubergrom!.storageKey).toBe(key);
            expect(olderRpk.ubergrom!.flash[1000]).toBe(0x56);
            expect(olderRpk.ubergrom!.eeprom[1000]).toBe(0x78);
            const exported = await load(await exportUberGromRpk(device.exportImage()));
            expect(exported.ubergrom!.flash[1000]).toBe(0x56);
            expect(exported.ubergrom!.eeprom[1000]).toBe(0x78);
        } finally {
            await new Promise<void>((resolve, reject) => {
                const request = indexedDB.open('js99er-ubergrom', 1);
                request.onerror = () => reject(request.error);
                request.onsuccess = () => {
                    const db = request.result, tx = db.transaction('cartridges', 'readwrite');
                    tx.objectStore('cartridges').delete(key);
                    tx.oncomplete = () => { db.close(); resolve(); };
                    tx.onerror = () => { db.close(); reject(tx.error); };
                };
            });
        }
    });
    it('rejects malformed, incomplete, ambiguous and unsupported layouts', async () => {
        const invalid = [
            layout.replace('flash_socket', 'grom_socket'),
            layout.replace('uses="e"', 'uses="missing"'),
            layout.replace('uses="e"', 'uses="f"'),
            layout.replace('<socket id="eeprom_socket" uses="e"/>', ''),
            layout.replace('<pcb type="ubergrom">', '<pcb type="ubergrom" write_protected="maybe">'),
            layout.replace('<pcb type="ubergrom">', '<pcb type="ubergrom" initial_bank="last">'),
            layout.replace('</resources>', '<rom id="f" file="other.bin"/></resources>'),
            layout.replace('</resources>', '<rom id="unused" file="other.bin"/></resources>'),
            layout.replace('file="eeprom.bin"', 'file="flash.bin"'),
            layout.replace('</pcb>', '<socket id="flash_socket" uses="f"/></pcb>'),
            layout.replace('</configuration>', '<pcb type="ubergrom"/></configuration>'),
            layout.replace('<pcb type="ubergrom">', '<pcb type="standard"/><pcb type="ubergrom">'),
            layout.replace('file="flash.bin"', 'file="absent.bin"'),
            '<!DOCTYPE romset>' + layout,
            layout.replace('</romset>', '')
        ];
        for (const text of invalid) await expectAsync(load(await archive(text))).toBeRejected();
        await expectAsync(load(await archive(layout, image(), '{}'))).toBeRejected();
        await expectAsync(load(await archive(' '.repeat(65537) + layout))).toBeRejected();
        const bad = image(); bad.eeprom = new Uint8Array(4095);
        await expectAsync(load(await archive(layout, bad))).toBeRejected();
    });
    it('rejects duplicate ZIP members and wrong parallel ROM sizes', async () => {
        const reader = new ZipReader(new BlobReader(await archive(layout)));
        try {
            const entries = await reader.getEntries();
            await expectAsync(loadUberGromRpk(xml(layout), [...entries, entries.find(e => e.filename === 'flash.bin')!])).toBeRejected();
        } finally { await reader.close(); }
        await expectAsync(load(await exportUberGromRpk(image(), new Uint8Array(8193)))).toBeRejected();
    });
    it('verifies optional resource CRC and SHA-1', async () => {
        const bytes = image().eeprom;
        const digest = await crypto.subtle.digest('SHA-1', bytes);
        const sha = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
        // CRC32 of 4096 FF bytes, independently checked with Python zlib.
        const checked = layout.replace('file="eeprom.bin"', `file="eeprom.bin" crc="f154670a" sha1="${sha}"`);
        await expectAsync(load(await archive(checked))).toBeResolved();
        await expectAsync(load(await archive(checked.replace('f154670a', '00000000')))).toBeRejected();
        await expectAsync(load(await archive(checked.replace(sha, '0'.repeat(40))))).toBeRejected();
    });
    it('reads release metadata for regular and Gigacart RPKs', async () => {
        service['log'] = {info() {}} as any;
        for (const type of ['standard', 'gigacart']) {
            const writer = new ZipWriter(new BlobWriter());
            await writer.add('layout.xml', new TextReader(`<romset><resources><rom id="r" file="r.bin"/></resources>
                <configuration><pcb type="${type}"><socket id="rom_socket" uses="r"/></pcb></configuration>
                <rpkversion>1.10</rpkversion></romset>`));
            await writer.add('r.bin', new Uint8ArrayReader(new Uint8Array(8192).fill(42)));
            const sw = await load(await writer.close());
            expect(sw.rom![0]).toBe(42); expect(sw.ubergrom).toBeFalsy();
            expect(sw.gigacart).toBe(type === 'gigacart');
            expect(sw.rpkVersion).toBe('1.10');
        }
    });
    it('preserves the UberGROM release independently of the layout version on export', async () => {
        const versioned = persistentLayout.replace('<romset>', '<romset version="1.0">')
            .replace('</romset>', '<rpkversion> 1.10 &amp; &lt;beta&gt; </rpkversion></romset>');
        const original = await load(await archive(versioned));
        expect(original.rpkVersion).toBe('1.10 & <beta>');
        const exported = await exportUberGromRpk(original.ubergrom!, original.rom, original.rpkVersion);
        expect((await load(exported)).rpkVersion).toBe(original.rpkVersion);
    });
    it('retains the shipped recovery bytes when converting the blank template to RPK', async () => {
        const legacy = await load(await (await fetch('/assets/software/ubergrom-blank.zip')).blob());
        const sw = await load(await exportUberGromRpk(legacy.ubergrom!));
        expect(sw.ubergrom!.flash).toEqual(legacy.ubergrom!.flash);
        expect(new UberGrom(sw.ubergrom!).canUseRecovery()).toBeTrue();
        const reader = new ZipReader(new BlobReader(await exportUberGromRpk(sw.ubergrom!)));
        try {
            const entries = await reader.getEntries();
            expect(entries.some(e => e.filename === 'ubergrom.json')).toBeFalse();
            const text = await entries.find(e => e.filename === 'layout.xml')!.getData!(new TextWriter());
            const manifest = xml(text);
            expect(manifest.querySelector('pcb')?.getAttribute('type')).toBe('ubergrom');
            expect(manifest.documentElement.getAttribute('version')).toBe('1.0');
            expect(manifest.querySelector('rpkversion')).toBeNull();
            expect(entries.map(entry => entry.filename).sort()).toEqual(['eeprom.bin', 'flash.bin', 'layout.xml']);
            const flash = manifest.querySelector('ram[id="flash"]')!;
            const eeprom = manifest.querySelector('ram[id="eeprom"]')!;
            expect([flash.getAttribute('type'), eeprom.getAttribute('type')]).toEqual(['persistent', 'persistent']);
            expect([flash.getAttribute('length'), eeprom.getAttribute('length')]).toEqual(['131072', '4096']);
            expect([flash.getAttribute('preloaded'), eeprom.getAttribute('preloaded')]).toEqual(['flash.bin', 'eeprom.bin']);
            const flashSave = flash.getAttribute('file')!;
            const eepromSave = eeprom.getAttribute('file')!;
            expect(flashSave).toMatch(/-flash\.nv$/);
            expect(eepromSave).toMatch(/-eeprom\.nv$/);
        } finally { await reader.close(); }
    });
});
