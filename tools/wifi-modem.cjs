// Local AT/Telnet service, owned by the js99er launcher. No cartridge files
// are served here. Only the launcher's explicit browser origins may connect.
const http = require('node:http');
const {WebSocketServer} = require('ws');
const {Modem} = require('./serial-modem.cjs');

function createModemServer(origins) {
    const allowed = new Set(origins);
    const server = http.createServer((req, res) => {
        if (req.url === '/health') {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({service: 'js99er-wifi-modem-1', origins: [...allowed]}));
        } else { res.writeHead(404); res.end(); }
    });
    const wss = new WebSocketServer({noServer: true, maxPayload: 65536});
    server.on('upgrade', (req, socket, head) => {
        if (req.url !== '/modem' || !allowed.has(req.headers.origin) || wss.clients.size) {
            socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
            return;
        }
        wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
    });
    wss.on('connection', ws => {
        let queue = [], credit = 0;
        let settings = {baud: 1200, dataBits: 8, parity: 'none', stopBits: 1};
        const modem = new Modem(bytes => {
            queue.push(...bytes);
            if (queue.length > 1048576) { modem.close(); ws.close(1009, 'Serial receive queue full'); }
        });
        // The device sends its actual divider-derived rate when connected and
        // whenever TI software writes UART registers. No guessed auto-baud.
        // Keep delivery bursts small for the emulated UART/application FIFO.
        const timer = setInterval(() => {
            const bits = 1 + settings.dataBits + settings.stopBits + (settings.parity === 'none' ? 0 : 1);
            credit = Math.min(16, credit + settings.baud / bits * 0.01 * 0.75);
            const n = Math.min(queue.length, Math.floor(credit));
            if (n && ws.readyState === 1 && ws.bufferedAmount < 65536) {
                ws.send(Buffer.from(queue.splice(0, n))); credit -= n;
            }
            if (modem.socket) {
                if (queue.length > 65536) modem.socket.pause(); else modem.socket.resume();
            }
        }, 10);
        ws.on('message', (data, binary) => {
            if (binary) { modem.input(data); return; }
            try {
                const m = JSON.parse(data);
                if (m.type === 'serial' && Number.isFinite(m.baud) && m.baud >= 100 && m.baud <= 1000000 &&
                    [5,6,7,8].includes(m.dataBits) && [1,2].includes(m.stopBits) &&
                    ['none','even','odd'].includes(m.parity)) {
                    settings = m; modem.configure(m);
                }
            } catch { /* Ignore malformed optional bridge messages. */ }
        });
        ws.on('close', () => { clearInterval(timer); modem.close(); });
        ws.on('error', () => {});
    });
    return {
        server,
        close: () => new Promise(resolve => {
            for (const ws of wss.clients) ws.terminate();
            wss.close(); server.close(resolve);
        })
    };
}

async function startModem(origins, port = 4210) {
    const service = createModemServer(origins);
    try {
        await new Promise((resolve, reject) => {
            service.server.once('error', reject);
            service.server.listen(port, '127.0.0.1', resolve);
        });
        return service;
    } catch (error) {
        await service.close();
        if (error.code !== 'EADDRINUSE') throw error;
        // Reuse a compatible service; never kill an unrelated port owner.
        const health = await fetch(`http://127.0.0.1:${port}/health`, {signal: AbortSignal.timeout(2000)}).then(r => r.json());
        if (health.service !== 'js99er-wifi-modem-1' || !origins.every(o => health.origins.includes(o))) {
            throw new Error(`Port ${port} is occupied by an incompatible modem service.`);
        }
        return {close: async () => {}};
    }
}
module.exports = {createModemServer, startModem};
