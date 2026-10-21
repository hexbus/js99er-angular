const assert = require('node:assert/strict');
const {test} = require('node:test');
const fs = require('node:fs');
const {createHash} = require('node:crypto');
const {ZipReader, Uint8ArrayReader, Uint8ArrayWriter} = require('@zip.js/zip.js');
require('@angular/compiler');
process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({module:'commonjs', moduleResolution:'node', target:'es2020'});
require('ts-node/register/transpile-only');
const {of, throwError} = require('rxjs');
const {UberGromComponent} = require('../src/app/components/ubergrom/ubergrom.component.ts');
const {UberGrom} = require('../src/app/emulator/classes/ubergrom.ts');

test('blank template preserves original recovery, clears user space and creates independent boards', async () => {
    const reader = new ZipReader(new Uint8ArrayReader(Uint8Array.from(fs.readFileSync(require.resolve('../src/assets/software/ubergrom-blank.zip')))));
    let files;
    try {
        files = Object.fromEntries(await Promise.all((await reader.getEntries()).map(async e => [e.filename, await e.getData(new Uint8ArrayWriter())])));
    } finally { await reader.close(); }
    assert.deepEqual(Object.keys(files).sort(), ['README.txt','Source License.txt','eeprom.bin','flash.bin','ubergrom.json'].sort());
    assert.equal(files['flash.bin'].length, 131072);
    assert(files['flash.bin'].subarray(0,0x1e000).every(b => b === 255));
    assert.equal(createHash('sha256').update(files['flash.bin'].subarray(0x1e000)).digest('hex'), '3c90c9ddb44eea6415e1e4362b99afe6c6fd601c427177acb2e3bfa325fbabc6');
    assert.equal(files['eeprom.bin'].length, 4096);
    assert(files['eeprom.bin'].every(b => b === 255));
    const manifest = JSON.parse(Buffer.from(files['ubergrom.json']).toString());
    assert.equal(manifest.format, 'js99er-ubergrom-1');assert.equal(manifest.rom, undefined);
    global.location = {protocol:'http:', hostname:'localhost'};
    const loaded = [];
    const modules = {loadModuleFromURL(url) {
        assert.equal(url, 'software/ubergrom-blank.zip');
        return of({ubergrom:{flash:files['flash.bin'].slice(), eeprom:files['eeprom.bin'].slice()}});
    }};
    const panel = new UberGromComponent({}, {loadSoftware:s => loaded.push(s)}, {markForCheck(){}}, modules);
    await panel.blank();await panel.blank();
    assert.equal(loaded.length, 2);
    assert.notEqual(loaded[0].ubergrom.storageKey, loaded[1].ubergrom.storageKey);
    const board = new UberGrom(loaded[0].ubergrom);
    assert(board.canUseRecovery());board.selectRecovery(true);assert(board.isRecoveryActive());
    assert.equal(board.eeprom[0], 0);assert.equal(board.eeprom[1], 255);
    modules.loadModuleFromURL = () => throwError(() => new Error('Missing template'));
    await panel.blank();assert.equal(loaded.length, 2);assert.match(panel.blankStatus, /Missing template/);
    modules.loadModuleFromURL = () => of({ubergrom:{flash:new Uint8Array(131072).fill(255), eeprom:new Uint8Array(4096).fill(255)}});
    await panel.blank();assert.equal(loaded.length, 2);assert.match(panel.blankStatus, /recognized recovery firmware/);
    assert.equal(panel.creatingBlank, false);
});
