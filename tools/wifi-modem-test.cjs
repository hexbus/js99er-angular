const assert = require('node:assert/strict');
const {test} = require('node:test');
const net = require('node:net');
const {WebSocket} = require('ws');
const {createModemServer, startModem} = require('./wifi-modem.cjs');
const origin = 'http://127.0.0.1:4205';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(f) { for (let i=0;i<1000;i++) { if(f()) return; await sleep(10); } throw Error('Timed out'); }

test('real WebSocket modem follows UART settings and carries binary TCP traffic; disconnect hangs up', async () => {
    const service = createModemServer([origin]);
    const peers = new Set();
    const echo = net.createServer(s => { peers.add(s); s.on('close',()=>peers.delete(s)); s.on('data',b=>s.write(b)); });
    let ws;
    try {
        await new Promise(r=>service.server.listen(0,'127.0.0.1',r));
        await new Promise(r=>echo.listen(0,'127.0.0.1',r));
        const url = `ws://127.0.0.1:${service.server.address().port}/modem`;
        ws = new WebSocket(url,{origin});
        const received=[];
        ws.on('message',(b,binary)=>{ assert(binary); received.push(...b); });
        await new Promise((r,j)=>{ ws.on('open',r); ws.on('error',j); });
        const text = ()=>Buffer.from(received).toString();
        const send = s=>ws.send(Buffer.from(s));
        send('ATE0\r'); await until(()=>text().endsWith('OK\r\n'));
        // Change baud AND framing repeatedly on the same live connection.
        for(const [baud,dataBits,parity,stopBits] of [[300,7,'even',2],[9600,8,'none',1],[38461.538,8,'none',1],[115200,8,'odd',1]]) {
            ws.send(JSON.stringify({type:'serial',baud,dataBits,parity,stopBits}));
            received.length=0;
            send(`ATDTtcp://127.0.0.1:${echo.address().port}\r`);
            await until(()=>text().endsWith(`CONNECT ${Math.round(baud)}\r\n`));
            received.length=0;
            const payload=Buffer.from(Array.from({length:baud === 300 ? 64 : 256},(_,i)=>i));
            ws.send(payload); await until(()=>received.length===payload.length);
            assert.deepEqual(Buffer.from(received),payload);
            for(const peer of peers) peer.destroy();
            await until(()=>text().endsWith('NO CARRIER\r\n'));
            received.length=0; send('AT\r'); await until(()=>text().endsWith('OK\r\n'));
        }
        received.length=0; send(`ATDT127.0.0.1:${echo.address().port}\r`);
        await until(()=>text().includes('CONNECT'));
        ws.close(); await until(()=>peers.size===0);
    } finally {
        ws?.terminate(); for(const peer of peers) peer.destroy();
        await service.close(); await new Promise(r=>echo.close(r));
    }
});

test('rejects other origins, wrong endpoints and a second client; reuses only compatible service', async () => {
    const service = createModemServer([origin]); let first;
    try {
        await new Promise(r=>service.server.listen(0,'127.0.0.1',r));
        const port=service.server.address().port, url=`ws://127.0.0.1:${port}/modem`;
        const reject = (endpoint,from) => new Promise((resolve,reject) => {
            const ws=new WebSocket(endpoint,{origin:from});
            ws.once('error',e=>{assert.match(e.message,/403/);resolve();});
            ws.once('open',()=>{ws.terminate();reject(Error('Unexpected connection'));});
        });
        await reject(url,'https://unrelated.example');
        await reject(url+'-wrong',origin);
        first=new WebSocket(url,{origin}); await new Promise((r,j)=>{first.once('open',r);first.once('error',j);});
        await reject(url,origin);
        const reused=await startModem([origin],port); await reused.close();
        assert.equal(service.server.listening,true);
        await assert.rejects(startModem(['http://localhost:9999'],port),/incompatible/);
    } finally { first?.terminate(); await service.close(); }
});
