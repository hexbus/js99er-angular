import {MemoryView} from './memory-view';
import {MemoryDevice} from '../emulator/interfaces/memory-device';

/** Debugger reads physical storage directly: no GROM address increments,
 * UART dequeues, timer latches, recovery transitions or emulated wait states. */
export class PhysicalMemoryView implements MemoryDevice {
    constructor(private readonly bytes: Uint8Array) {}

    getMemorySize() { return this.bytes.length; }
    getWord(address: number) {
        return ((this.bytes[address] ?? 0) << 8) | (this.bytes[address + 1] ?? 0);
    }
    hexView(start: number, length: number, width: number, anchor: number) {
        return MemoryView.hexView(start, length, width, anchor, address => this.bytes[address]);
    }
}

export function uberHex(value: number, digits = 4): string {
    return '>' + value.toString(16).toUpperCase().padStart(digits, '0');
}

function mappedType(value: number): string {
    const page = value & 15;
    switch (value >> 4) {
        case 0: return page < 2 ? 'RAM' : 'Unmapped (RAM page out of range)';
        case 1: return page < 15 ? 'ATmega Flash' : 'Unmapped (firmware page)';
        case 2: return page === 0 ? 'EEPROM' : 'Unmapped (EEPROM page out of range)';
        case 3: return page === 0 ? 'GPIO' : 'Unmapped (GPIO page out of range)';
        case 4: return page < 4 ? 'ADC' : 'Unmapped (ADC channel out of range)';
        case 5: return page === 0 ? 'Serial UART' : 'Unmapped (UART page out of range)';
        case 6: return 'Flash controller'; // Firmware ignores the low nibble here.
        case 7: return page === 0 ? 'Timer' : 'Unmapped (timer page out of range)';
        default: return 'Unmapped (unknown type)';
    }
}

/** Decode configuration, not live port reads. Recovery/configuration overlays
 * are described separately so a saved mapping is not mistaken for an overlay. */
export function inspectUberGromMappings(eeprom: Uint8Array, base: number) {
    const flagsValid = (eeprom[0] ^ eeprom[1]) === 255;
    const basesEnabled = flagsValid && !!(eeprom[0] & 1);
    const sourceBase = basesEnabled ? base : 0;
    const rows = [3, 4, 5, 6, 7].map(slot => {
        const index = sourceBase * 16 + 2 + slot;
        const value = eeprom[index], check = eeprom[index + 8];
        const valid = (value ^ check) === 255;
        const page = value & 15;
        const lastOffset = base === 15 && slot === 7 ? 0x17ff : 0x1fff;
        const type = valid ? mappedType(value) : 'Unmapped (invalid check byte)';
        let detail = '';
        if (valid && !type.startsWith('Unmapped')) {
            if (type === 'ADC') detail = 'Channel ' + page;
            else if (type === 'RAM' || type === 'ATmega Flash' || type === 'EEPROM') {
                const start = page * 8192;
                const end = type === 'RAM' ? Math.min(start + lastOffset, 0x3bff) :
                    type === 'EEPROM' ? 0x0fff : start + lastOffset;
                detail = 'Page ' + page + ': ' + uberHex(start) + ' - ' + uberHex(end);
                if (end - start < lastOffset) detail += '; rest of slot unmapped';
            } else if (type === 'Flash controller') detail = 'Page bits ignored';
            else detail = 'Page 0';
        }
        return {slot, range: uberHex(slot * 8192) + ' - ' + uberHex(slot * 8192 + lastOffset),
            type, detail, raw: uberHex(value, 2), check: uberHex(check, 2),
            offset: uberHex(index), checkOffset: uberHex(index + 8)};
    });
    return {flagsValid, basesEnabled, sourceBase, rows};
}
