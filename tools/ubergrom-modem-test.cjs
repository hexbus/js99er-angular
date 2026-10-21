const assert=require('node:assert/strict');
const {test}=require('node:test');
require('@angular/compiler');
process.env.TS_NODE_COMPILER_OPTIONS=JSON.stringify({module:'commonjs',moduleResolution:'node',target:'es2020'});
require('ts-node/register/transpile-only');
const {Subject}=require('rxjs');
const {UberGromComponent}=require('../src/app/components/ubergrom/ubergrom.component.ts');
const {UberGrom}=require('../src/app/emulator/classes/ubergrom.ts');
const {ConsoleEventType:E}=require('../src/app/classes/console-event.ts');

test('checkbox connects automatically, remembers choice, restores normal serial and follows UART changes',()=>{
    const sockets=[];
    global.location={protocol:'http:',hostname:'127.0.0.1'};
    const storage=new Map(); global.localStorage={getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)};
    global.WebSocket=class {
        static OPEN=1;readyState=1;messages=[];closed=false;
        constructor(url){this.url=url;sockets.push(this);}
        send(b){this.messages.push(b);}
        close(){this.closed=true;}
    };
    const events=new Subject(), c=new UberGromComponent(events,{}, {markForCheck(){}});
    let device=new UberGrom({flash:new Uint8Array(131072).fill(255),eeprom:new Uint8Array(4096).fill(255)});
    const ready=()=>events.next({type:E.READY,data:{getMemory:()=>({getCartridge:()=>({getUberGrom:()=>device})})}});
    c.ngOnInit(); ready();
    try {
        assert.equal(c.status,'Local connection'); assert.equal(sockets.length,0);
        c.setWifiModem(true);
        assert.equal(sockets[0].url,'ws://127.0.0.1:4210/modem'); sockets[0].onopen();
        assert.equal(c.status,'Connected'); assert.equal(storage.get('ubergrom-wifi-modem'),'true');
        for(const baud of [300,9600,19200,38400,115200]) {
            device.configureSerial({baud,dataBits:8,parity:'none',stopBits:1});
            const messages=sockets[0].messages.filter(m=>typeof m==='string').map(JSON.parse);
            assert.deepEqual(messages.filter(m=>m.type==='serial').at(-1),{type:'serial',...device.serialSettings()});
        }
        c.mode='loopback'; c.setWifiModem(false); assert(sockets[0].closed); assert.equal(c.status,'Local connection');
        c.setWifiModem(true); const previous=sockets.at(-1);
        events.next({type:E.STATE_RESTORED}); assert(previous.closed); assert.notEqual(sockets.at(-1),previous);
        c.ngOnDestroy(); assert(sockets.at(-1).closed);
        const other=new UberGromComponent(new Subject(),{}, {markForCheck(){}});other.ngOnInit();
        assert(other.wifiModem);other.ngOnDestroy();
        global.location={protocol:'https:',hostname:'js99er.net'};
        const hosted=new UberGromComponent(new Subject(),{}, {markForCheck(){}});hosted.ngOnInit();
        assert(!hosted.wifiModem);assert(!hosted.wifiModemAvailable);hosted.ngOnDestroy();
    } finally { c.ngOnDestroy(); }
});
