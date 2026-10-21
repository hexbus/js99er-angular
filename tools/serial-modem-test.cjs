const assert=require('node:assert/strict'),net=require('node:net');
const {Modem,Telnet}=require('../tools/serial-modem.cjs');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(f){for(let i=0;i<200;i++){if(f())return;await sleep(10);}throw Error('Timed out');}
(async()=>{
 let wire=[],received=[];const t=new Telnet(b=>wire.push(...b),b=>received.push(...b));
 for(const b of [255,251,0,255,253,0,255,251,1,255,253,42,255,250,24,1,255,240,65,255,255,13,0])t.input([b]);
 assert.deepEqual(wire,[255,253,0,255,251,0,255,253,1,255,252,42]);
 assert.deepEqual(received,[65,255,13,0]);wire=[];t.input([255,251,0,255,253,0]);assert.deepEqual(wire,[]);
 t.output([0,255,13,10]);assert.deepEqual(wire,[0,255,255,13,10]);
 wire=[];received=[];const n=new Telnet(b=>wire.push(...b),b=>received.push(...b));n.input([13]);n.input([0,65]);assert.deepEqual(received,[13,65]);n.output([13]);assert.deepEqual(wire,[13,0]);
 let peer,netBytes=[];const server=net.createServer(s=>{peer=s;s.on('data',b=>netBytes.push(...b));});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 let output=[];const m=new Modem(b=>output.push(...b),{guard:30});const send=s=>m.input(Buffer.from(s)),text=()=>Buffer.from(output).toString();
 m.input([19,17,10]);assert.deepEqual(output,[],'command mode must not echo XOFF/XON back to the terminal');
 send('A');m.input([19,17]);send('T\r');assert.equal(text(),'AT\r\r\nOK\r\n');output=[];send('ATE0\r');output=[];send('ATDT invalid:99999\r');assert(text().includes('ERROR'));
 output=[];send('ATDT 127.0.0.1:'+server.address().port+'\r');await until(()=>text().includes('CONNECT'));
 peer.write(Buffer.from([255,251,0,255,253,0]));await until(()=>netBytes.length===6);netBytes=[];
 const bytes=Buffer.from(Array.from({length:256},(_,i)=>i));m.input(bytes);await until(()=>netBytes.length>=257);assert.deepEqual(Buffer.from(netBytes),Buffer.concat([bytes,Buffer.from([255])]));
 output=[];peer.write(Buffer.from([65,255,255,66]));await until(()=>output.length===3);assert.deepEqual(output,[65,255,66]);
 await sleep(40);send('+++');assert(!m.command,'escape must wait for the trailing guard');await until(()=>m.command);assert(text().includes('OK'));output=[];send('ATO\r');assert(text().includes('CONNECT'));assert(!m.command);
 // A single plus after silence must reach the peer, not disappear.
 netBytes=[];await sleep(40);send('+');await until(()=>netBytes.length);assert.deepEqual(netBytes,[43]);assert(!m.command);
 await sleep(40);send('+++');await until(()=>m.command);output=[];send('ATH\r');assert(text().includes('OK'));assert.equal(m.socket,null);
 output=[];send('ATDT tcp://127.0.0.1:'+server.address().port+'\r');await until(()=>text().includes('CONNECT'));netBytes=[];m.input([255,13]);await until(()=>netBytes.length===2);assert.deepEqual(netBytes,[255,13]);
 output=[];peer.destroy();await until(()=>text().includes('NO CARRIER'));m.close();await new Promise(r=>server.close(r));
 console.log('PASS: fragmented Telnet negotiation, IAC escaping, binary/NVT bytes, AT commands, real TCP dial, all 256 bytes, guarded escape, ATO, ATH, raw TCP, remote close');
})().catch(e=>{console.error(e);process.exit(1);});
