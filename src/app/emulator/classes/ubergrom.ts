import {Stateful} from '../interfaces/stateful';
import {UberGromConnection, UberGromSerialSettings} from '../interfaces/ubergrom-connection';

export interface UberGromImage {
    flash: Uint8Array;
    eeprom: Uint8Array;
    writeProtected?: boolean;
    storageKey?: string;
}

/**
 * Independent model of the production ATmega1284P UberGROM interface.
 * Hardware/interface references: tursilion/ubergrom and hexbus/ubergrom.
 * This models the TI-visible devices, not AVR instruction execution.
 * RAM and address-port waits are calibrated to the recorded UGBENCH workload;
 * they are approximate, not AVR instruction or electrical bus simulation.
 * EEPROM/ADC/Flash delays below are nominal device delays.
 */
export class UberGrom implements Stateful {
    readonly flash: Uint8Array;
    readonly eeprom: Uint8Array;
    readonly ram = new Uint8Array(15 * 1024);
    readonly storageKey?: string;
    writeProtected: boolean;
    onPersistentChange?: () => void;
    private connection?: UberGromConnection;
    private address = 0;
    private unlock = 1;
    private elapsedCycles = 0;
    private lastCPUTime = 0;
    private timerHigh = 0;
    // Released firmware initializes DDRD=40, PORTD=03, DDRC=02,
    // PORTC=B0. Thus GPIO0 starts as an output and GPIO2/3 have pull-ups,
    // despite the older interface document describing all pins as inputs.
    private gpioDirection = 1;
    private gpioOutput = 12;
    private adcFirst = true;
    private flashBank = 0;
    private flashPage = 0;
    private flashLatch = 0;
    private flashStatus = 0;
    private flashReadable = true;
    private pageBuffer = new Uint8Array(256).fill(255);
    private serialFormat = 0x23;
    private baudDivisor = 8;
    private pendingBaudLow = 8;
    private rx: number[] = [];
    private tx: number[] = [];
    private rxErrors = 0;
    private transmitCycles = 0;
    private waitCycles = 0;
    // The AVR boot section is supplied by the cartridge owner. Only this
    // identified released layout is interpreted; no recovery ROM is bundled.
    private recoveryAvailable = false;
    private recoveryState = 0;

    constructor(image: UberGromImage) {
        if (![120 * 1024, 128 * 1024].includes(image.flash.length) || image.eeprom.length !== 4096) {
            throw new Error('UberGROM needs 120 or 128 KiB of ATmega Flash and 4 KiB of EEPROM.');
        }
        this.flash = new Uint8Array(128 * 1024).fill(255);
        this.flash.set(image.flash);
        this.eeprom = image.eeprom.slice();
        this.writeProtected = !!image.writeProtected;
        this.storageKey = image.storageKey;
        let firmwareId = 0x811c9dc5;
        for (const byte of this.flash.subarray(0x1e000)) {
            firmwareId = Math.imul(firmwareId ^ byte, 0x01000193) >>> 0;
        }
        // FNV-1a of the released 8 KiB firmware section (SHA-256 documented
        // in docs/ubergrom.md). Application Flash and EEPROM are independent.
        this.recoveryAvailable = firmwareId === 0x44ea90c7;
        this.recoveryState = this.recoveryAvailable ? 0xff : 0;
        // Firmware initializes only a completely erased EEPROM.
        if (this.eeprom.every(v => v === 255)) {
            for (const [at, value] of [[0, 0], [1, 255], [5, 0x11], [13, 0xee], [6, 0x12], [14, 0xed]]) {
                this.eeprom[at] = value;
            }
        }
    }

    setConnection(connection?: UberGromConnection) {
        this.connection?.close?.();
        this.connection = connection;
        connection?.configureSerial?.(this.serialSettings());
        connection?.writeGPIO?.(this.gpioOutput, this.gpioDirection);
    }

    receiveSerial(bytes: Uint8Array, errors = 0) {
        for (const byte of bytes) {
            if (this.rx.length < 255) this.rx.push(byte & ((1 << this.serialSettings().dataBits) - 1));
            else this.rxErrors |= 0x20;
        }
        this.rxErrors |= errors & 0x70;
    }

    serialSettings(): UberGromSerialSettings {
        const parity = (this.serialFormat >> 2) & 3;
        return {
            baud: 8000000 / ((this.serialFormat & 0x20 ? 8 : 16) * (this.baudDivisor + 1)),
            dataBits: 5 + (this.serialFormat & 3),
            parity: parity === 2 ? 'even' : parity === 3 ? 'odd' : 'none',
            stopBits: this.serialFormat & 0x10 ? 2 : 1
        };
    }

    /** Set the same UART registers TI software can write; later TI writes still apply. */
    configureSerial(settings: UberGromSerialSettings) {
        if (!Number.isFinite(settings.baud) || settings.baud < 8000000 / (16 * 4096) ||
            settings.baud > 1000000 || ![5, 6, 7, 8].includes(settings.dataBits) ||
            !['none', 'even', 'odd'].includes(settings.parity) || ![1, 2].includes(settings.stopBits)) {
            throw new Error('Choose 123–1,000,000 baud, 5–8 data bits, none/even/odd parity, and 1 or 2 stop bits.');
        }
        // An 8 MHz AVR uses an integer 12-bit divider. Pick the closest rate,
        // considering both normal and double-speed clocking, and show the result.
        const choices = [16, 8].map(scale => {
            const divisor = Math.max(0, Math.min(4095, Math.round(8000000 / (scale * settings.baud)) - 1));
            return {scale, divisor, error: Math.abs(8000000 / (scale * (divisor + 1)) - settings.baud)};
        }).sort((a, b) => a.error - b.error);
        const selected = choices[0];
        const parity = settings.parity === 'even' ? 8 : settings.parity === 'odd' ? 12 : 0;
        this.writeSerial(0x21, settings.dataBits - 5 | parity |
            (settings.stopBits === 2 ? 16 : 0) | (selected.scale === 8 ? 32 : 0));
        this.writeSerial(0x22, selected.divisor & 255);
        this.writeSerial(0x23, selected.divisor >> 8);
    }

    /** CPU cycles, not wall time: paused emulation cannot transmit or tick. */
    advanceCycles(cycles: number) {
        this.elapsedCycles += cycles;
        if (!this.tx.length) return;
        const s = this.serialSettings();
        const perByte = 3000000 * (1 + s.dataBits + s.stopBits + (s.parity === 'none' ? 0 : 1)) / s.baud;
        this.transmitCycles += cycles;
        while (this.tx.length && this.transmitCycles >= perByte) {
            this.transmitCycles -= perByte;
            this.connection?.transmit?.(this.tx.shift()! & ((1 << s.dataBits) - 1));
        }
        if (!this.tx.length) this.transmitCycles = 0;
    }

    syncClock(cpuCycles: number) {
        if (cpuCycles >= this.lastCPUTime) this.advanceCycles(cpuCycles - this.lastCPUTime);
        this.lastCPUTime = cpuCycles;
    }

    resetAddress() {
        // A console reset is not a cartridge power cycle.
        this.address = 0;
        this.lastCPUTime = 0;
    }

    takeWaitCycles(): number {
        const cycles = this.waitCycles;
        this.waitCycles = 0;
        return cycles;
    }

    getAddress() { return this.address; }

    /** Extra 3 MHz CPU cycles beyond Memory's existing GROM port overhead.
     * The 2026-09-24 Corcomp UGBENCH run supports about 102 extra cycles per
     * RAM read, 90 per RAM write and 15 per address access. See the measured
     * totals and limitations in docs/ubergrom.md. Other device waits retain
     * their own models; this must not slow Gigacart or ordinary GROM carts.
     */
    getAccessWaitCycles(port: number, write: boolean): number {
        if (port & 2) return 15;
        const map = this.mapping((port >> 2) & 15, this.address);
        return map >= 0 && map < 0x10 ? (write ? 90 : 102) : 0;
    }

    canUseRecovery(): boolean {
        return this.recoveryAvailable && !(this.flags() & 2);
    }

    isRecoveryActive(): boolean {
        return this.canUseRecovery() && this.recoveryState === 1;
    }

    // Explicit debugger override of the power-up choice. The next console
    // reset enters the supplied recovery GPL; EEPROM configuration is intact.
    selectRecovery(enabled: boolean) {
        if (this.canUseRecovery()) this.recoveryState = enabled ? 1 : 0;
    }

    recoveryStatus(): string {
        if (!this.recoveryAvailable) return 'Unavailable: this image has no recognized recovery firmware';
        if (this.flags() & 2) return 'Disabled in EEPROM';
        if (this.recoveryState === 1) return 'Active: Easy Bug and Run Program File';
        return this.recoveryState ? 'Waiting for the power-up Space check' : 'Normal cartridge selected at power-up';
    }

    readPort(port: number): number | undefined {
        if (port & 2) {
            // Real console GROM supplies address reads. UberGROM only observes
            // the destructive address cycle; it does not drive the bus.
            this.address = (this.address & 255) * 257;
            return undefined;
        }
        const value = this.readMapped((port >> 2) & 15, this.address);
        this.increment();
        return value === undefined ? undefined : value << 8;
    }

    writePort(port: number, word: number) {
        const byte = (word >> 8) & 255;
        if (port & 2) this.address = ((this.address << 8) | byte) & 65535;
        else {
            this.writeMapped((port >> 2) & 15, this.address, byte);
            this.increment();
        }
    }

    private flags() {
        return (this.eeprom[0] ^ this.eeprom[1]) === 255 ? this.eeprom[0] : 0;
    }

    private increment() {
        // Match released firmware's counter behavior, including its 14-bit
        // increment mask when rollover is disabled (not normal GROM prefetch).
        if ((this.flags() & 4) && this.address >= 0x6000 && this.address !== 0xffff) this.address++;
        else this.address = (this.address & 0xe000) | ((this.address + 1) & 0x3fff);
    }

    private mapping(base: number, address: number): number {
        if (address < 0x6000) return -1;
        if (base === 15 && address >= 0xf800) return 0x100;
        if (this.recoveryState) {
            // Disabling recovery is latched until cartridge power-up. Console
            // reset alone does not restart the AVR or re-run its Space check.
            if (this.flags() & 2) this.recoveryState = 0;
            else if (((this.recoveryState & 0x80) && base === 0 && address >= 0xe000) ||
                (this.recoveryState === 1 && base < 2 && address >= 0x6000 && address < 0x8000)) {
                return 0x101;
            }
        }
        const index = (this.flags() & 1 ? base * 16 : 0) + 2 + (address >> 13);
        return (this.eeprom[index] ^ this.eeprom[index + 8]) === 255 ? this.eeprom[index] : -1;
    }

    private readMapped(base: number, address: number): number | undefined {
        const map = this.mapping(base, address), offset = address & 8191, page = map & 15;
        if (map === 0x100) return this.eeprom[address - 0xf800];
        if (map === 0x101) {
            // Let the console execute the supplied GPL keyboard test. Observing
            // its taken path selects recovery, without bypassing the TI keyboard.
            const at = address >= 0xe000 ? 0x1e08c + address - 0xe000 :
                address >= 0x70a0 ? 0x1ee6e + address - 0x70a0 : 0x1e0ae + address - 0x6000;
            const value = this.flash[0x10000 | (at & 0xffff)];
            if (this.recoveryState === 0xff) {
                if (address === 0xe019) this.recoveryState = 0x81;
                else if (address === 0xe01a) this.recoveryState = 0x80;
            } else if ((this.recoveryState & 0x80) && address === 0xe00d) {
                this.recoveryState &= 1;
            }
            return value;
        }
        if (map < 0) return undefined;
        switch (map >> 4) {
            case 0: return this.ram[page * 8192 + offset];
            case 1: return page < 15 && this.flashReadable ? this.flash[page * 8192 + offset] : undefined;
            case 2: return page === 0 ? this.eeprom[offset] : undefined;
            case 3: {
                if (page) return undefined;
                if (offset < 0x20) return 0;
                if (offset === 0x20) return this.gpioDirection;
                const input = this.connection?.readGPIO?.() ?? {value: 0, driven: 0};
                const pins = (input.value & input.driven) | (this.gpioOutput & ~input.driven);
                return ((this.gpioOutput & this.gpioDirection) | (pins & ~this.gpioDirection)) & 15;
            }
            case 4:
                if (page >= 4) return undefined;
                if (offset < 0x20) return 0;
                // Released ADC handler performs a settling conversion followed
                // by the returned conversion (ADCSRA C6: 8 MHz / 64).
                this.waitCycles += this.adcFirst ? 912 : 624;
                this.adcFirst = false;
                return Math.max(0, Math.min(255, Math.round(this.connection?.readADC?.(page) ?? 0)));
            case 5: return page === 0 ? this.readSerial(offset) : undefined;
            case 6:
                if (offset < 256) return 0;
                if (offset === 0x100) return this.flashPage;
                if (offset === 0x103) return this.writeProtected ? 2 : this.flashStatus;
                if (offset === 0x104) return this.flashBank;
                return undefined;
            case 7:
                if (page) return undefined;
                if (offset < 0x20) return 0;
                if (offset & 1) return this.timerHigh;
                const timer = Math.floor(this.elapsedCycles / 384) & 65535;
                this.timerHigh = timer >> 8;
                return timer & 255;
        }
        return undefined;
    }

    private writeMapped(base: number, address: number, value: number) {
        const map = this.mapping(base, address), offset = address & 8191, page = map & 15;
        if (map === 0x100 || map === 0x20) {
            if (map === 0x100 && address === 0xffff) {
                const expected = this.unlock === 1 ? 0x55 : this.unlock === 0x55 ? 0xaa : 0x5a;
                this.unlock = value === expected ? value : 1;
                return;
            }
            const at = map === 0x100 ? address - 0xf800 : offset;
            if (at >= 4096) return;
            if (this.unlock !== 0x5a) { this.unlock = 1; return; }
            if (this.writeProtected && at < 0x102) return;
            this.eeprom[at] = value;
            this.waitCycles += 10200; // firmware holds READY during nominal 3.4 ms write
            this.onPersistentChange?.();
            return;
        }
        if (map < 0) return;
        switch (map >> 4) {
            case 0: {
                const at = page * 8192 + offset;
                if (at < this.ram.length) this.ram[at] = value;
                break;
            }
            case 3:
                if (page || offset < 0x20) break;
                if (offset === 0x20) this.gpioDirection = value & 15;
                else this.gpioOutput = value & 15;
                this.connection?.writeGPIO?.(this.gpioOutput, this.gpioDirection);
                break;
            case 5: if (!page) this.writeSerial(offset, value); break;
            case 6: this.writeFlash(offset, value); break;
        }
    }

    private readSerial(offset: number): number | undefined {
        if (offset < 0x20) return 0;
        if (offset >= 0x1000) return this.rx.shift() ?? 0;
        switch (offset) {
            case 0x20: {
                const status = (this.rx.length ? 1 : 0) | (this.tx.length < 255 ? 2 : 0) |
                    (this.tx.length ? 0 : 4) | this.rxErrors;
                this.rxErrors = 0;
                return status;
            }
            case 0x21: return this.serialFormat;
            case 0x22: return this.baudDivisor & 255;
            case 0x23: return this.baudDivisor >> 8;
            case 0x24: return this.rx.length;
            case 0x25: return 255 - this.tx.length;
        }
        return undefined;
    }

    private writeSerial(offset: number, value: number) {
        if (offset >= 0x100 && offset < 0x1000) {
            if (this.tx.length < 255) this.tx.push(value);
        } else if (offset === 0x21) {
            this.serialFormat = value & 0x3f;
            this.connection?.configureSerial?.(this.serialSettings());
        } else if (offset === 0x22) this.pendingBaudLow = value;
        else if (offset === 0x23) {
            this.baudDivisor = ((value & 15) << 8) | this.pendingBaudLow;
            this.connection?.configureSerial?.(this.serialSettings());
        }
    }

    private writeFlash(offset: number, value: number) {
        if (this.writeProtected) { this.flashStatus = 2; return; }
        if (offset < 256) {
            if (offset & 1) {
                this.pageBuffer[offset - 1] = this.flashLatch;
                this.pageBuffer[offset] = value;
            } else this.flashLatch = value;
        } else if (offset === 0x100) this.flashPage = value;
        else if (offset === 0x101) { this.flashLatch = value; this.flashStatus = 0; }
        else if (offset === 0x104) {
            if (value < 15) this.flashBank = value;
            else this.flashStatus = 3;
        } else if (offset === 0x102) {
            const at = this.flashBank * 8192 + this.flashPage * 256;
            if ((value ^ this.flashLatch) !== 255 || at + 256 > 120 * 1024 ||
                ![0x31, 0xd2].includes(this.flashLatch)) { this.flashStatus = 3; return; }
            if (this.flashLatch === 0x31) {
                this.flash.fill(255, at, at + 256);
                this.flashReadable = false;
            } else {
                for (let i = 0; i < 256; i++) this.flash[at + i] &= this.pageBuffer[i];
                this.pageBuffer.fill(255);
                this.flashReadable = true;
            }
            this.flashStatus = 0;
            this.waitCycles += 13500; // nominal 4.5 ms SPM; not measured board timing
            this.onPersistentChange?.();
        } else this.flashStatus = 3;
    }

    exportImage(): UberGromImage {
        return {flash: this.flash.slice(), eeprom: this.eeprom.slice(), writeProtected: this.writeProtected, storageKey: this.storageKey};
    }

    getState(): any {
        return {...this.exportImage(), ram: this.ram.slice(), address: this.address, unlock: this.unlock,
            elapsedCycles: this.elapsedCycles, lastCPUTime: this.lastCPUTime, timerHigh: this.timerHigh,
            gpioDirection: this.gpioDirection, gpioOutput: this.gpioOutput, adcFirst: this.adcFirst,
            flashBank: this.flashBank, flashPage: this.flashPage, flashLatch: this.flashLatch,
            flashStatus: this.flashStatus, flashReadable: this.flashReadable, pageBuffer: this.pageBuffer.slice(),
            serialFormat: this.serialFormat, baudDivisor: this.baudDivisor, pendingBaudLow: this.pendingBaudLow,
            rx: [...this.rx], tx: [...this.tx], rxErrors: this.rxErrors, transmitCycles: this.transmitCycles,
            waitCycles: this.waitCycles, recoveryState: this.recoveryState};
    }

    restoreState(s: any) {
        this.flash.set(s.flash); this.eeprom.set(s.eeprom); this.ram.set(s.ram);
        this.pageBuffer.set(s.pageBuffer);
        for (const key of ['address', 'unlock', 'elapsedCycles', 'lastCPUTime', 'timerHigh',
            'gpioDirection', 'gpioOutput', 'adcFirst', 'flashBank', 'flashPage', 'flashLatch',
            'flashStatus', 'flashReadable', 'serialFormat', 'baudDivisor', 'pendingBaudLow',
            'rxErrors', 'transmitCycles', 'waitCycles', 'writeProtected'] as const) {
            (this as any)[key] = s[key];
        }
        this.rx = [...s.rx]; this.tx = [...s.tx];
        // Older snapshots predate recovery support; retain their original
        // ordinary mappings rather than inject a startup hook mid-execution.
        this.recoveryState = this.recoveryAvailable ? (s.recoveryState ?? 0) : 0;
        // External endpoints cannot be rewound with an emulator snapshot.
        this.setConnection();
    }
}
