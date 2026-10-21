const assert = require('node:assert/strict');
const {test} = require('node:test');
require('@angular/compiler');
process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({module:'commonjs', moduleResolution:'node', target:'es2020'});
require('ts-node/register/transpile-only');
const {UberGrom} = require('../src/app/emulator/classes/ubergrom.ts');
const {Cartridge} = require('../src/app/emulator/classes/cartridge.ts');
const {Software} = require('../src/app/classes/software.ts');
const {Settings} = require('../src/app/classes/settings.ts');

function image() {
    const flash = new Uint8Array(131072).fill(255), eeprom = new Uint8Array(4096).fill(255);
    eeprom[0] = 3; eeprom[1] = 252; // bases enabled, built-in boot override disabled
    return {flash, eeprom};
}
function map(image, base, slot, device) {
    const index = base * 16 + 2 + slot;
    image.eeprom[index] = device; image.eeprom[index + 8] = device ^ 255;
}
function addr(u, a, base = 0) { u.writePort(0x9c02 + base * 4, a & 0xff00); u.writePort(0x9c02 + base * 4, a << 8); }
function read(u, a, base = 0) { addr(u, a, base); return u.readPort(0x9800 + base * 4) >>> 8; }
function write(u, a, v, base = 0) { addr(u, a, base); u.writePort(0x9c00 + base * 4, v << 8); }
function unlock(u) { for (const v of [0x55,0xaa,0x5a]) write(u,0xffff,v,15); }

test('live GROMCFG mapping and inverse-byte validation, independent bases', () => {
    const i = image(); map(i,0,3,0x10); map(i,1,3,0x11);
    i.flash[0] = 0x12; i.flash[8192] = 0x34;
    const u = new UberGrom(i);
    assert.equal(read(u,0x6000),0x12); assert.equal(read(u,0x6000,1),0x34);
    unlock(u);
    write(u,0xf805,0x11,15); // invalid until complement written
    addr(u,0x6000); assert.equal(u.readPort(0x9800),undefined);
    write(u,0xf80d,0xee,15);
    assert.equal(read(u,0x6000),0x34);
});

test('recovery decision follows GPL reads, stays latched across reset, and preserves configuration access', () => {
    const i=image(); i.eeprom[0]=1; i.eeprom[1]=254;
    map(i,0,3,0);map(i,0,7,0x10);
    const u=new UberGrom(i);
    // Synthetic bytes isolate the interface state machine. Private integration
    // tests separately execute the supplied, fingerprinted firmware on a TI CPU.
    u.recoveryAvailable=true;u.recoveryState=0xff;
    u.flash[0x1e08c]=0xaa;u.flash[0x1e0ae]=0xbb;u.flash[0x1ee6e]=0xcc;
    assert.equal(read(u,0xe000),0xaa);
    read(u,0xe019);read(u,0xe01a);assert.equal(u.getState().recoveryState,0x81);
    read(u,0xe00c);assert.equal(u.getState().recoveryState,0x81);
    read(u,0xe00d);assert.equal(u.getState().recoveryState,1);
    assert.equal(read(u,0x6000),0xbb);assert.equal(read(u,0x6000,1),0xbb);
    assert.equal(read(u,0x70a0),0xcc);assert.equal(read(u,0xf800,15),1);
    write(u,0x6000,0x42);assert.equal(u.ram[0],0,'recovery GROM writes must not reach underlying RAM');
    u.resetAddress();assert.equal(u.getState().recoveryState,1);
    const s=u.getState();u.restoreState(s);assert.equal(u.getState().recoveryState,1);
    u.recoveryState=0xff;read(u,0xe01a);read(u,0xe00d);
    assert.equal(u.getState().recoveryState,0);assert.equal(read(u,0x6000),0);
    u.recoveryState=0xff;u.eeprom[0]=3;u.eeprom[1]=252;read(u,0xe000);
    assert.equal(u.getState().recoveryState,0);
    u.eeprom[0]=1;u.eeprom[1]=254;read(u,0xe000);assert.equal(u.getState().recoveryState,0);
});

test('unrecognized or absent AVR firmware cannot inject a recovery program', () => {
    for(const size of [120*1024,128*1024]) {
        const i=image();i.flash=i.flash.slice(0,size);i.eeprom[0]=0;i.eeprom[1]=255;
        const u=new UberGrom(i);assert.equal(u.getState().recoveryState,0);
        addr(u,0xe000);assert.equal(u.readPort(0x9800),undefined);
        const s=u.getState();s.recoveryState=1;u.restoreState(s);
        assert.equal(u.getState().recoveryState,0);
    }
});

test('calibrated RAM waits follow live mappings without delaying Flash or unmapped data', () => {
    const i=image();map(i,0,3,0);map(i,1,3,0x10);const u=new UberGrom(i);
    addr(u,0x6000);assert.equal(u.getAccessWaitCycles(0x9800,false),102);
    assert.equal(u.getAccessWaitCycles(0x9c00,true),90);
    assert.equal(u.getAccessWaitCycles(0x9804,false),0);
    assert.equal(u.getAccessWaitCycles(0x9808,false),0);
    assert.equal(u.getAccessWaitCycles(0x9802,false),15);
    unlock(u);write(u,0xf805,0x10,15);write(u,0xf80d,0xef,15);
    addr(u,0x6000);assert.equal(u.getAccessWaitCycles(0x9800,false),0);
});

test('UART paced streams survive repeated FIFO wraps and GPIO-controlled pauses', () => {
    const i=image();map(i,0,3,0x50);map(i,1,3,0x30);const u=new UberGrom(i);
    const count=65536,received=[],sent=[];let pins=0;
    u.setConnection({transmit:b=>sent.push(b),writeGPIO:(v,d)=>{pins=v&d;}});
    u.configureSerial({baud:38400,dataBits:8,parity:'none',stopBits:1});
    write(u,0x6020,1,1); // GPIO0 output: the application's ready signal.
    for(let offset=0;offset<count;offset+=128){
        write(u,0x6021,1,1);assert.equal(pins&1,1);
        u.receiveSerial(Uint8Array.from({length:128},(_,n)=>(offset+n)*37&255));
        write(u,0x6021,0,1);assert.equal(pins&1,0); // peer sends nothing while paused
        for(let n=0;n<128;n++){const b=read(u,0x7000);received.push(b);write(u,0x6100,b);}
        u.advanceCycles(Math.ceil(128*10*3000000/u.serialSettings().baud));
        assert.equal(read(u,0x6020)&0x70,0);assert.equal(read(u,0x6024),0);
    }
    assert.equal(sent.length,count);assert.deepEqual(sent,received);
    assert.deepEqual(received,Array.from({length:count},(_,n)=>n*37&255));
    // The bridge may use GPIO as a handshake; the AVR does not implement CTS.
    // Unpaced input must report overrun rather than silently pretend it fits.
    u.receiveSerial(new Uint8Array(1024));assert.equal(read(u,0x6024),255);
    assert.equal(read(u,0x6020)&0x20,0x20);assert.equal(read(u,0x6020)&0x20,0);
});
test('EEPROM lock, JP4 configuration protection and writable user area', () => {
    const i=image(); map(i,0,4,0x20); const u=new UberGrom(i);
    write(u,0x8102,42); assert.equal(read(u,0x8102),255);
    unlock(u); u.writeProtected=true;
    write(u,0xf800,7,15); assert.equal(read(u,0xf800,15),3);
    write(u,0x8102,42); assert.equal(read(u,0x8102),42);
    assert.equal(u.takeWaitCycles(),10200);
    write(u,0xffff,0,15); write(u,0x8102,43); assert.equal(read(u,0x8102),42);
});
test('both RAM pages and invalid tail; shared counter and released rollover behavior', () => {
    const i=image(); map(i,0,3,0); map(i,0,4,1); const u=new UberGrom(i);
    write(u,0x7fff,0xa5); assert.equal(read(u,0x7fff),0xa5);
    assert.equal(u.getAddress(),0x6000);
    write(u,0x9bff,0x5a); assert.equal(read(u,0x9bff),0x5a);
    addr(u,0x9c00); assert.equal(u.readPort(0x9800),undefined);
    // Firmware masks the increment with 3FFF: 9FFF becomes A000.
    addr(u,0x9fff); u.readPort(0x9800); assert.equal(u.getAddress(),0xa000);
    unlock(u); write(u,0xf800,7,15); write(u,0xf801,248,15);
    addr(u,0x7fff); u.readPort(0x9800); assert.equal(u.getAddress(),0x8000);
    addr(u,0xffff); u.readPort(0x9800); assert.equal(u.getAddress(),0xe000);
});
test('Flash erase/program, buffer pairs, protected firmware and write protection', () => {
    const i=image(); map(i,0,3,0x60); map(i,0,4,0x15); const u=new UberGrom(i);
    write(u,0x6104,5); write(u,0x6100,0);
    write(u,0x6101,0x31); write(u,0x6102,0xce);
    addr(u,0x8000); assert.equal(u.readPort(0x9800),undefined);
    for(let n=0;n<256;n++) write(u,0x6000+n,n);
    write(u,0x6101,0xd2); write(u,0x6102,0x2d);
    assert.equal(read(u,0x6103),0);
    assert.deepEqual(u.flash.slice(5*8192,5*8192+256),Uint8Array.from({length:256},(_,n)=>n));
    assert.equal(read(u,0x8001),1);
    u.writeProtected=true; write(u,0x6101,0x31); assert.equal(read(u,0x6103),2);
    u.writeProtected=false; write(u,0x6104,15); assert.equal(read(u,0x6103),3);
    assert.ok(u.flash.subarray(120*1024).every(v=>v===255));
});
test('timer follows emulated cycles and latches high byte on low-byte read', () => {
    const i=image(); map(i,0,3,0x70); const u=new UberGrom(i);
    u.advanceCycles(384*255); assert.equal(read(u,0x6020),255);
    u.advanceCycles(384*2); assert.equal(read(u,0x6021),0);
    assert.equal(read(u,0x6020),1); assert.equal(read(u,0x6021),1);
    u.advanceCycles(384*65536); assert.equal(read(u,0x6020),1);
});
test('UART format/divisor commit, bounded buffers, byte timing and error clearing', () => {
    const i=image(); map(i,0,3,0x50); const u=new UberGrom(i), sent=[];
    u.setConnection({transmit:b=>sent.push(b)});
    write(u,0x6021,3); write(u,0x6022,51);
    assert.equal(read(u,0x6022),8); write(u,0x6023,0);
    assert.equal(u.serialSettings().baud,8000000/(16*52));
    write(u,0x6100,65); assert.equal(read(u,0x6025),254);
    u.advanceCycles(3000); assert.equal(sent.length,0);
    u.advanceCycles(120); assert.deepEqual(sent,[65]);
    u.receiveSerial(Uint8Array.from({length:256},(_,n)=>n));
    assert.equal(read(u,0x6024),255); assert.equal(read(u,0x6020)&0x20,0x20);
    assert.equal(read(u,0x6020)&0x20,0);
    for(let n=0;n<255;n++) assert.equal(read(u,0x7000),n);
    assert.equal(read(u,0x7000),0);
});
test('ADC channels and GPIO direction, externally driven inputs and pull-ups', () => {
    const i=image(); map(i,0,3,0x43); map(i,0,4,0x30);
    const u=new UberGrom(i); let pins;
    u.setConnection({readADC:c=>c*60,readGPIO:()=>({value:4,driven:4}),writeGPIO:(v,d)=>pins=[v,d]});
    assert.equal(read(u,0x6020),180); assert.equal(u.takeWaitCycles(),912);
    read(u,0x6020); assert.equal(u.takeWaitCycles(),624);
    write(u,0x8020,3); write(u,0x8021,9);
    assert.deepEqual(pins,[9,3]); assert.equal(read(u,0x8021),13);
});
test('manual UART controls use attainable rates and remain writable by TI software', () => {
    const i=image(); map(i,0,3,0x50); const u=new UberGrom(i), changes=[];
    u.setConnection({configureSerial:s=>changes.push(s)});
    u.configureSerial({baud:38400,dataBits:7,parity:'even',stopBits:2});
    assert.deepEqual(u.serialSettings(),{baud:8000000/(16*13),dataBits:7,parity:'even',stopBits:2});
    assert.deepEqual(changes.at(-1),u.serialSettings());
    assert.equal(read(u,0x6021),0x1a);
    assert.equal(read(u,0x6022),12);
    write(u,0x6021,0x23); write(u,0x6022,51); write(u,0x6023,0);
    assert.deepEqual(u.serialSettings(),{baud:8000000/(8*52),dataBits:8,parity:'none',stopBits:1});
    for(const baud of [0,NaN,Infinity,100,1000001]) {
        assert.throws(()=>u.configureSerial({baud,dataBits:8,parity:'none',stopBits:1}));
    }
});
test('save state preserves device data and counters without retaining external endpoints', () => {
    const i=image(); map(i,0,3,0); const u=new UberGrom(i);
    write(u,0x6000,123); u.advanceCycles(1234);
    const state=u.getState(), restored=new UberGrom(i); restored.restoreState(state);
    write(u,0x6000,222); assert.equal(read(restored,0x6000),123);
    assert.equal(restored.getState().elapsedCycles,1234);
    const sw=new Software(); sw.ubergrom=i; sw.rom=new Uint8Array(524288);
    const cart=new Cartridge(sw,new Settings()); cart.getUberGrom().restoreState(state);
    const copy=new Cartridge(new Software(),new Settings()); copy.restoreState(cart.getState());
    assert.equal(read(copy.getUberGrom(),0x6000),123);
});

test('WebSocket bridge exchanges UART settings, binary bytes and ADC/GPIO without a device-specific protocol', () => {
    const original=global.WebSocket, sockets=[];
    class Socket {
        static OPEN=1;
        constructor(url){this.url=url;this.readyState=0;this.sent=[];sockets.push(this);}
        send(value){this.sent.push(value);}
        close(){this.readyState=3;this.onclose?.();}
    }
    global.WebSocket=Socket;
    try {
        const {UberGromWebSocket}=require('../src/app/emulator/classes/ubergrom-websocket.ts');
        const received=[],status=[],bridge=new UberGromWebSocket('ws://127.0.0.1:9902/ubergrom',
            bytes=>received.push([...bytes]),text=>status.push(text));
        const i=image(),u=new UberGrom(i);
        u.configureSerial({baud:38400,dataBits:7,parity:'odd',stopBits:2});
        u.setConnection(bridge);
        const socket=sockets[0];socket.readyState=1;socket.onopen();
        assert.deepEqual(JSON.parse(socket.sent[1]),{type:'serial',...u.serialSettings()});
        bridge.transmit(0x41);assert.deepEqual([...socket.sent.at(-1)],[0x41]);
        socket.onmessage({data:new Uint8Array([0,65,255]).buffer});
        assert.deepEqual(received,[[0,65,255]]);
        socket.onmessage({data:'{"type":"adc","channel":3,"value":213}'});
        socket.onmessage({data:'{"type":"adc","channel":3,"value":999}'});
        socket.onmessage({data:'{"type":"gpio","value":5,"driven":7}'});
        assert.equal(bridge.readADC(3),213);
        assert.deepEqual(bridge.readGPIO(),{value:5,driven:7});
        bridge.writeGPIO(8,12);
        assert.deepEqual(JSON.parse(socket.sent.at(-1)),{type:'gpio',value:8,direction:12});
        u.setConnection();
        assert.equal(socket.onmessage,null);assert.deepEqual(status,['Connected']);
        assert.throws(()=>new UberGromWebSocket('https://example.invalid',()=>{},()=>{}));
    } finally {global.WebSocket=original;}
});

test('explicit package loader validates separate Flash, EEPROM and ROM resources', async () => {
    const {ModuleService}=require('../src/app/services/module.service.ts');
    // This parser does not use HTTP or the browser log's periodic flush timer.
    const service=Object.create(ModuleService.prototype);
    const manifest={format:'js99er-ubergrom-1',name:'Synthetic',flash:'flash.bin',eeprom:'eeprom.bin',rom:'rom.bin'};
    const entry=(filename,size)=>({filename,uncompressedSize:size,getData:async()=>new Blob([new Uint8Array(size).fill(255)])});
    const entries=[entry('flash.bin',131072),entry('eeprom.bin',4096),entry('rom.bin',524288)];
    const input={getData:async()=>JSON.stringify(manifest)};
    const module=await service.loadUberGrom(input,entries);
    assert.equal(module.rom.length,524288);
    assert.equal(module.ubergrom.eeprom.length,4096);
    assert.equal(module.name,'Synthetic');
    await assert.rejects(()=>service.loadUberGrom(input,[...entries,entries[0]]),/duplicate/i);
    await assert.rejects(()=>service.loadUberGrom(input,[entries[0],entry('eeprom.bin',4095),entries[2]]),/sized/);
    await assert.rejects(()=>service.loadUberGrom({getData:async()=>'{"format":"unknown"}'},entries),/format/);
});
