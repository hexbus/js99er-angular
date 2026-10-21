/** Host-side connections; no TI software or device-specific network protocol. */
export interface UberGromSerialSettings {
    baud: number;
    dataBits: number;
    parity: 'none' | 'even' | 'odd';
    stopBits: number;
}

export interface UberGromConnection {
    transmit?(byte: number): void;
    configureSerial?(settings: UberGromSerialSettings): void;
    readADC?(channel: number): number;
    /** Return driven input bits. Undefined pins use the emulated pull-ups. */
    readGPIO?(): {value: number; driven: number};
    writeGPIO?(value: number, direction: number): void;
    close?(): void;
}
