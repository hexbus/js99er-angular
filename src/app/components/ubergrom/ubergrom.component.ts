import {ChangeDetectorRef, Component, OnDestroy, OnInit} from '@angular/core';
import {firstValueFrom, interval, Subscription} from 'rxjs';
import {BlobWriter, Uint8ArrayReader, TextReader, ZipWriter} from '@zip.js/zip.js';
import {saveAs} from 'file-saver';
import {Console} from '../../emulator/interfaces/console';
import {inspectUberGromMappings, uberHex} from '../../classes/ubergrom-inspector';
import {UberGrom} from '../../emulator/classes/ubergrom';
import {UberGromWebSocket} from '../../emulator/classes/ubergrom-websocket';
import {EventDispatcherService} from '../../services/event-dispatcher.service';
import {CommandDispatcherService} from '../../services/command-dispatcher.service';
import {ConsoleEventType} from '../../classes/console-event';
import {ModuleService} from '../../services/module.service';
import {UberGromSerialSettings} from '../../emulator/interfaces/ubergrom-connection';

@Component({
    selector: 'ubergrom',
    standalone: false,
    templateUrl: './ubergrom.component.html',
    styleUrls: ['./ubergrom.component.css']
})
export class UberGromComponent implements OnInit, OnDestroy {
    device?: UberGrom;
    mappingBase = 0;
    readonly mappingBases = Array.from({length: 16}, (_, base) => base);
    readonly hex = uberHex;

    mappings() {
        return this.device ? inspectUberGromMappings(this.device.eeprom, this.mappingBase) : undefined;
    }

    mode = 'terminal';
    endpoint = 'ws://localhost:9902/ubergrom';
    // The local launcher owns this service. Never connect a public website to
    // a local TCP gateway implicitly; hosted deployments need their own service.
    readonly wifiModemAvailable = location.protocol === 'http:' &&
        ['localhost', '127.0.0.1'].includes(location.hostname);
    wifiModem = false;
    status = 'Disconnected';
    text = '';
    output = '';
    lineEnding = '\r';
    serial: UberGromSerialSettings = {baud: 19200, dataBits: 8, parity: 'none', stopBits: 1};
    adc = [0, 0, 0, 0];
    gpioInput = 0;
    gpioOutput = 0;
    gpioDirection = 0;
    private console?: Console;
    private subscription?: Subscription;
    creatingBlank = false;
    blankStatus = '';

    constructor(private events: EventDispatcherService, private commands: CommandDispatcherService,
                private changeDetector: ChangeDetectorRef, private modules: ModuleService) {}

    ngOnInit() {
        try { this.wifiModem = this.wifiModemAvailable && localStorage.getItem('ubergrom-wifi-modem') === 'true'; }
        catch { /* Storage may be disabled; the checkbox still works. */ }
        this.subscription = this.events.subscribe(event => {
            if (event.type === ConsoleEventType.READY) this.console = event.data;
            if ([ConsoleEventType.READY, ConsoleEventType.CARTRIDGE_CHANGED, ConsoleEventType.STATE_RESTORED].includes(event.type)) {
                this.device?.setConnection();
                this.device = this.console?.getMemory().getCartridge()?.getUberGrom();
                this.status = 'Disconnected';
                this.output = '';
                if (this.wifiModem) {
                    this.connect();
                } else if (event.type !== ConsoleEventType.STATE_RESTORED) {
                    this.mode = 'terminal';
                    this.connectLocal();
                }
            }
        });
        // CPU execution runs outside Angular; refresh actual registers and
        // incoming terminal text without change detection on every UART byte.
        this.subscription.add(interval(250).subscribe(() => this.changeDetector.markForCheck()));
    }

    connectLocal() {
        const loopback = this.mode === 'loopback';
        this.device?.setConnection({
            transmit: byte => {
                if (loopback) this.device?.receiveSerial(new Uint8Array([byte]));
                this.output = (this.output + String.fromCharCode(byte)).slice(-8192);
            },
            readADC: channel => Number(this.adc[channel]),
            readGPIO: () => ({value: Number(this.gpioInput), driven: 15}),
            writeGPIO: (value, direction) => { this.gpioOutput = value; this.gpioDirection = direction; }
        });
        this.status = this.device ? 'Local connection' : 'No UberGROM loaded';
    }

    connect() {
        if (!this.wifiModem && this.mode !== 'websocket') { this.connectLocal(); return; }
        if (!this.device) return;
        try {
            const device = this.device;
            const modem = this.wifiModem;
            const endpoint = modem ? 'ws://127.0.0.1:4210/modem' : this.endpoint;
            device.setConnection(new UberGromWebSocket(endpoint, bytes => device.receiveSerial(bytes),
                text => {
                    if (modem && text === 'Disconnected' && this.status.startsWith('Wi-Fi modem unavailable')) return;
                    this.status = modem && text === 'Connection failed'
                        ? 'Wi-Fi modem unavailable. Start this local build with Start-js99er.bat.' : text;
                }));
            this.status = 'Connecting';
        } catch (error) { this.status = String(error); }
    }

    setWifiModem(enabled: boolean) {
        this.wifiModem = enabled && this.wifiModemAvailable;
        try { localStorage.setItem('ubergrom-wifi-modem', String(this.wifiModem)); }
        catch { /* Remembering the choice is optional. */ }
        this.connect(); // Replaces the old connection, hanging up any active call.
    }

    disconnect() {
        this.device?.setConnection();
        this.status = 'Disconnected';
    }

    send() {
        this.device?.receiveSerial(Uint8Array.from(this.text + this.lineEnding, c => c.charCodeAt(0) & 255));
        this.text = '';
    }

    rawGPIO(value: number) {
        const bits = (Number(value) || 0) & 15;
        return ">" + bits.toString(16).toUpperCase().padStart(2, "0") + " · %" + bits.toString(2).padStart(4, "0");
    }

    onSerialSettingsToggle(event: Event) {
        // Opening the editor starts from the live UART, without changing it.
        if ((event.target as HTMLDetailsElement).open) this.useCurrentSerial();
    }

    useCurrentSerial() {
        if (this.device) this.serial = this.device.serialSettings();
    }

    applySerial() {
        try {
            this.device?.configureSerial(this.serial);
            this.status = 'UART settings applied. TI software can change them again.';
        } catch (error) { this.status = String(error); }
    }

    async blank() {
        if (this.creatingBlank) return;
        this.creatingBlank = true;
        this.blankStatus = '';
        try {
            // Blank means unprogrammed cartridge space, not an erased AVR:
            // preserve the original recovery firmware supplied in this template.
            const software = await firstValueFrom(this.modules.loadModuleFromURL('software/ubergrom-blank.zip'));
            const image = software.ubergrom;
            if (!image || software.rom?.length ||
                !image.flash.subarray(0, 0x1e000).every(byte => byte === 255) ||
                !image.eeprom.every(byte => byte === 255) || !new UberGrom(image).canUseRecovery()) {
                throw new Error('The blank template must contain empty user memory and recognized recovery firmware.');
            }
            // Never resume data saved under the template or a previous blank board.
            image.storageKey = 'blank-' + crypto.randomUUID();
            this.commands.loadSoftware(software);
            this.blankStatus = 'Blank UberGROM created with recovery. Hold Space during startup, or select Use recovery mode and press Reset.';
        } catch (error) {
            // Keep the current cartridge intact if the template cannot be loaded.
            this.blankStatus = 'Could not create blank UberGROM: ' + error;
        } finally {
            this.creatingBlank = false;
            this.changeDetector.markForCheck();
        }
    }

    async export() {
        if (!this.device) return;
        try {
            const writer = new ZipWriter(new BlobWriter('application/zip'));
            const image = this.device.exportImage();
            const manifest: any = {format: 'js99er-ubergrom-1', name: 'UberGROM export',
                flash: 'flash.bin', eeprom: 'eeprom.bin', writeProtected: image.writeProtected};
            const rom = this.console?.getMemory().getCartridge()?.getState().cartImage;
            if (rom?.length) {
                manifest.rom = 'rom.bin';
                await writer.add('rom.bin', new Uint8ArrayReader(rom));
            }
            await writer.add('flash.bin', new Uint8ArrayReader(image.flash));
            await writer.add('eeprom.bin', new Uint8ArrayReader(image.eeprom));
            await writer.add('ubergrom.json', new TextReader(JSON.stringify(manifest, null, 2)));
            saveAs(await writer.close(), 'ubergrom.zip');
            this.status = 'Exported current Flash and EEPROM';
        } catch (error) { this.status = 'Export failed: ' + error; }
    }

    ngOnDestroy() { this.subscription?.unsubscribe(); this.disconnect(); }
}
