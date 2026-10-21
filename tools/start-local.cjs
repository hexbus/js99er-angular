// One local js99er process owns both Angular and the modem. No separate
// bridge launch, terminal commands or WebSocket address are needed in the UI.
const {spawn} = require('node:child_process');
const path = require('node:path');
const {startModem} = require('./wifi-modem.cjs');

async function main(args = process.argv.slice(2)) {
    let port = 4205;
    const angularArgs = [];
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--port') port = Number(args[++i]);
        else if (args[i].startsWith('--port=')) port = Number(args[i].slice(7));
        else angularArgs.push(args[i]);
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid js99er port.');
    const modem = await startModem([...new Set([4205, port].flatMap(p =>
        [`http://127.0.0.1:${p}`, `http://localhost:${p}`]))]);
    // Re-running the launcher while js99er is open should not restart the TI
    // or fail because Angular already owns the selected port.
    let running = false;
    try {
        const response = await fetch(`http://127.0.0.1:${port}/`, {signal: AbortSignal.timeout(1500)});
        running = response.ok && (await response.text()).includes('<js99er></js99er>');
    } catch { /* Normal first launch: Angular is not running yet. */ }
    if (running) {
        console.log(`js99er is already running at http://127.0.0.1:${port}/. Wi-Fi modem is ready.`);
        if (angularArgs.includes('--open')) {
            const url = `http://127.0.0.1:${port}/`;
            const command = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
            const parameters = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
            spawn(command, parameters, {windowsHide: true, stdio: 'ignore'})
                .once('error', () => console.log(`Open ${url} in your browser.`));
        }
        process.once('SIGINT', () => void modem.close());
        process.once('SIGTERM', () => void modem.close());
        return;
    }
    const child = spawn(process.execPath, [require.resolve('@angular/cli/bin/ng.js'), 'serve',
        '--configuration', 'development', '--host', '127.0.0.1', '--port', String(port), ...angularArgs],
        {cwd: path.resolve(__dirname, '..'), stdio: 'inherit', windowsHide: true});
    const stop = () => { child.kill(); void modem.close(); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    child.once('error', async error => { console.error(error.message); await modem.close(); process.exitCode = 1; });
    child.once('exit', async code => { await modem.close(); process.exitCode = code || 0; });
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = {main};
