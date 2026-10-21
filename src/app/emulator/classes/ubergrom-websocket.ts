import {UberGromConnection, UberGromSerialSettings} from '../interfaces/ubergrom-connection';

/**
 * Optional host bridge. Binary messages carry UART bytes; JSON messages carry
 * pin values and configuration. This transport does not implement UberHDX,
 * TIPI or FujiNet protocols: a companion service implements those separately.
 */
export class UberGromWebSocket implements UberGromConnection {
    private socket: WebSocket;
    private settings?: UberGromSerialSettings;
    private adc = [0, 0, 0, 0];
    private gpio = {value: 0, driven: 0};
    private outputs = {value: 0, direction: 0};

    constructor(url: string, receive: (bytes: Uint8Array) => void, status: (text: string) => void) {
        const parsed = new URL(url);
        if (!['ws:', 'wss:'].includes(parsed.protocol)) throw new Error('Use a ws:// or wss:// bridge address.');
        this.socket = new WebSocket(url);
        this.socket.binaryType = 'arraybuffer';
        this.socket.onopen = () => {
            status('Connected');
            this.send({type: 'hello', protocol: 'js99er-ubergrom-1'});
            if (this.settings) this.configureSerial(this.settings);
            this.writeGPIO(this.outputs.value, this.outputs.direction);
        };
        this.socket.onclose = () => status('Disconnected');
        this.socket.onerror = () => status('Connection failed');
        this.socket.onmessage = event => {
            if (event.data instanceof ArrayBuffer) {
                if (event.data.byteLength <= 65536) receive(new Uint8Array(event.data));
                return;
            }
            if (typeof event.data !== 'string' || event.data.length > 4096) return;
            try {
                const data = JSON.parse(event.data);
                if (data.type === 'adc' && Number.isInteger(data.channel) && data.channel >= 0 &&
                    data.channel < 4 && Number.isInteger(data.value) && data.value >= 0 && data.value <= 255) {
                    this.adc[data.channel] = data.value;
                } else if (data.type === 'gpio' && Number.isInteger(data.value) && Number.isInteger(data.driven)) {
                    this.gpio = {value: data.value & 15, driven: data.driven & 15};
                }
            } catch { status('Ignored invalid bridge message'); }
        };
    }
    private send(message: object) {
        if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
    }
    configureSerial(settings: UberGromSerialSettings) {
        this.settings = settings;
        this.send({type: 'serial', ...settings});
    }
    transmit(byte: number) {
        if (this.socket.readyState === WebSocket.OPEN) this.socket.send(new Uint8Array([byte]));
    }
    readADC(channel: number) { return this.adc[channel]; }
    readGPIO() { return this.gpio; }
    writeGPIO(value: number, direction: number) {
        this.outputs = {value, direction};
        this.send({type: 'gpio', ...this.outputs});
    }
    close() {
        this.socket.onmessage = null;
        this.socket.onopen = null;
        this.socket.onclose = null;
        this.socket.onerror = null;
        this.socket.close();
    }
}
