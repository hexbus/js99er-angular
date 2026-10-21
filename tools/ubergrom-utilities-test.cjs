const assert = require('node:assert/strict');
const {test} = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {ZipReader, Uint8ArrayReader, Uint8ArrayWriter} = require('@zip.js/zip.js');
require('@angular/compiler');
process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({module:'commonjs', moduleResolution:'node', target:'es2020'});
require('ts-node/register/transpile-only');
const {of, throwError} = require('rxjs');
const {Log} = require('../src/app/classes/log.ts');
Log.instance = {info(){}, warn(){}, error(){}, debug(){}};
const {DiskImage} = require('../src/app/emulator/classes/disk-image.ts');
const {SoftwareMenuComponent} = require('../src/app/components/software-menu/software-menu.component.ts');
const root = path.resolve(__dirname, '../src/assets/software/ubergrom-utilities');
const menu = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../src/assets/software/index.json')));
const item = menu.items.find(i => i.name === 'Apps').items.find(i => i.name === 'UberGROM Utilities (disk)');

test('disk-only menu keeps the cartridge, while ordinary cartridge and paired-disk entries still work', () => {
    assert.equal(item.url, undefined);
    assert.equal(item.diskUrl, 'software/ubergrom-utilities/UberGROM-Utilities.dsk');
    const calls = [], software = {}, file = {};
    const modules = {loadModuleFromURL(url) { calls.push(['fetchModule', url]); return of(software); }};
    const disks = {fetchDiskFileFromURL(url) { calls.push(['fetchDisk', url]); return of(file); }};
    const commands = {
        loadSoftware(value) { calls.push(['cartridge', value]); },
        unloadSoftware() { calls.push(['unload']); },
        loadDisk(drive, files) { calls.push(['disk', drive, files]); }
    };
    const component = new SoftwareMenuComponent({}, {}, modules, disks, {}, commands);
    component.openSoftware(item.url, item.diskUrl);
    assert.deepEqual(calls, [['fetchDisk', item.diskUrl], ['disk', 0, [file]]]);
    calls.length = 0;
    component.openSoftware(); // TI BASIC still unloads a cartridge.
    assert.deepEqual(calls, [['unload']]);
    calls.length = 0;
    component.openSoftware('software/test.rpk', 'software/test.dsk');
    assert.deepEqual(calls, [['fetchModule','software/test.rpk'], ['cartridge',software],
        ['fetchDisk','software/test.dsk'], ['disk',0,[file]]]);
    calls.length = 0;
    disks.fetchDiskFileFromURL = () => throwError(() => new Error('Missing disk'));
    component.openSoftware(item.url, item.diskUrl);
    assert.deepEqual(calls, []); // A failed disk fetch must not unload/reset anything.
});

async function entries(name) {
    const reader = new ZipReader(new Uint8ArrayReader(Uint8Array.from(fs.readFileSync(path.join(root, 'Original-archives', name)))));
    try {
        const result = {};
        for (const entry of await reader.getEntries()) {
            if (!entry.directory) result[entry.filename] = await entry.getData(new Uint8ArrayWriter());
        }
        return result;
    } finally { await reader.close(); }
}

test('utilities disk programs match the original releases and notices retain their recorded bytes', async () => {
    const disk = new DiskImage('VERIFY', null);
    disk.loadBinaryImage(Uint8Array.from(fs.readFileSync(path.join(root, 'UberGROM-Utilities.dsk'))));
    assert.deepEqual(Object.keys(disk.getFiles()).sort(), ['GROMCFG','GROMCFH','GROMLOAD','GROMTEST','GROMTESU'].sort());
    const released = await entries('gromtest.zip');
    const sources = JSON.parse(fs.readFileSync(path.join(root, 'PROGRAM-SOURCES.json')));
    const upstream = new DiskImage('ORIGINAL', null);
    // These payload hashes were recorded from the pinned original TI files,
    // independently of the assembled disk. GROMSim.zip has older utility builds.
    for (const file of sources.files) {
        const program = disk.getFile(file.name).getProgram();
        assert.equal(program.length, file.program_bytes, file.name);
        assert.equal(createHash('sha256').update(program).digest('hex'), file.program_sha256, file.name);
    }
    for (const name of ['GROMTEST','GROMTESU']) {
        const file = upstream.loadTIFile(name, released[name], false);
        assert.deepEqual(disk.getFile(name).getProgram(), file.getProgram(), name);
    }
    for (const line of fs.readFileSync(path.join(root, 'SHA256.txt'), 'utf8').trim().split(/\r?\n/)) {
        const [expected, name] = line.split('  ');
        assert.equal(createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex'), expected, name);
    }
});
