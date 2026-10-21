const assert = require('node:assert/strict');
const {test} = require('node:test');
process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({module:'commonjs', moduleResolution:'node', target:'es2020'});
require('ts-node/register/transpile-only');
const {PhysicalMemoryView, inspectUberGromMappings} = require('../src/app/classes/ubergrom-inspector.ts');
const {UberGrom} = require('../src/app/emulator/classes/ubergrom.ts');

function fixture() {
    const eeprom = new Uint8Array(4096).fill(255);
    eeprom[0] = 3; eeprom[1] = 252;
    return new UberGrom({eeprom, flash:new Uint8Array(131072).fill(255)});
}
function map(u, base, slot, value) {
    const index = base * 16 + 2 + slot;
    u.eeprom[index] = value; u.eeprom[index + 8] = value ^ 255;
}
test('inspector identifies every supported service, with partial memory pages and invalid mappings', () => {
    const u = fixture();
    const examples = [[0,'RAM'],[1,'RAM'],[0x10,'ATmega Flash'],[0x1e,'ATmega Flash'],
        [0x20,'EEPROM'],[0x30,'GPIO'],[0x40,'ADC'],[0x43,'ADC'],[0x50,'Serial UART'],
        [0x60,'Flash controller'],[0x6f,'Flash controller'],[0x70,'Timer']];
    for (const [value, type] of examples) {
        map(u, 15, 7, value);
        const row = inspectUberGromMappings(u.eeprom,15).rows[4];
        assert.equal(row.type, type); assert.equal(row.range,'>E000 - >F7FF');
        assert.equal(row.offset,'>00F9'); assert.equal(row.checkOffset,'>0101');
    }
    for (const value of [2,0x1f,0x21,0x31,0x44,0x51,0x71,0xff]) {
        map(u,0,3,value);
        assert.match(inspectUberGromMappings(u.eeprom,0).rows[0].type,/^Unmapped/);
    }
    map(u,0,3,1);
    assert.match(inspectUberGromMappings(u.eeprom,0).rows[0].detail,/>2000 - >3BFF; rest of slot unmapped/);
    map(u,0,3,0x20);
    assert.match(inspectUberGromMappings(u.eeprom,0).rows[0].detail,/>0000 - >0FFF; rest of slot unmapped/);
    u.eeprom[13] ^= 1;
    assert.match(inspectUberGromMappings(u.eeprom,0).rows[0].type,/invalid check byte/);
});

test('base selection and corrupt flags agree with the emulator mapping', () => {
    const u = fixture(); map(u,0,3,0); map(u,7,3,0x50);
    assert.equal(inspectUberGromMappings(u.eeprom,7).rows[0].type,'Serial UART');
    u.eeprom[0]=2;u.eeprom[1]=253;
    const shared=inspectUberGromMappings(u.eeprom,7);
    assert.equal(shared.sourceBase,0); assert.equal(shared.rows[0].type,'RAM');
    u.eeprom[1]=0;
    assert.equal(inspectUberGromMappings(u.eeprom,7).flagsValid,false);
    assert.equal(inspectUberGromMappings(u.eeprom,7).sourceBase,0);
});

test('all bases and physical viewers preserve device state, including UART, timer and recovery', () => {
    const u=fixture(); u.receiveSerial(Uint8Array.from([65,66]));
    u.recoveryAvailable=true;u.recoveryState=0xff;u.timerHigh=0x12;u.address=0xe019;
    u.ram[0]=0x41;u.ram[u.ram.length-1]=0x42;u.flash[0x10000]=0x43;u.flash[0x1ffff]=0x44;
    const before=u.getState();
    for(let base=0;base<16;base++) inspectUberGromMappings(u.eeprom,base);
    for(const bytes of [u.ram,u.eeprom,u.flash]) {
        const view=new PhysicalMemoryView(bytes);
        assert.equal(view.getMemorySize(),bytes.length);
        assert.equal(view.getWord(0),(bytes[0]<<8)|bytes[1]);
        assert.equal(view.getWord(bytes.length),0);
        assert.match(view.hexView(bytes.length,16,16,bytes.length).lines[0].text,/-- --/);
        assert.match(view.hexView(0,16,16,0).lines[0].text,/>0000:/);
        view.hexView(0,bytes.length,16,0);
    }
    const flash=new PhysicalMemoryView(u.flash);
    assert.match(flash.hexView(0x10000,16,16,0x10000).lines[0].text,/>10000: 43/);
    assert.match(flash.hexView(0x1fff0,16,16,0x1fff0).lines[0].text,/>1FFF0:.*44/);
    assert.deepEqual(u.getState(),before);
});

test('manual recovery requires usable firmware, survives reset and leaves EEPROM intact', () => {
    const u=fixture();const original=u.eeprom.slice();
    assert.equal(u.canUseRecovery(),false);u.selectRecovery(true);assert.equal(u.isRecoveryActive(),false);
    u.recoveryAvailable=true;u.eeprom[0]=1;u.eeprom[1]=254;
    const configured=u.eeprom.slice();u.selectRecovery(true);assert(u.isRecoveryActive());
    u.resetAddress();assert(u.isRecoveryActive());assert.deepEqual(u.eeprom,configured);
    const saved=u.getState();u.selectRecovery(false);assert(!u.isRecoveryActive());
    u.restoreState(saved);assert(u.isRecoveryActive());
    u.eeprom.set(original);assert(!u.canUseRecovery());u.selectRecovery(true);assert(!u.isRecoveryActive());
});
