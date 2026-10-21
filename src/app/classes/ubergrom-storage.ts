import {Software} from './software';
import {UberGrom, UberGromImage} from '../emulator/classes/ubergrom';

/** Browser persistence is separate from the emulated chip and its timing. */
export class UberGromStorage {
    private static opening?: Promise<IDBDatabase>;
    private static pending = new Map<string, Promise<void>>();

    private static open(): Promise<IDBDatabase> {
        if (!this.opening) this.opening = new Promise((resolve, reject) => {
            const request = indexedDB.open('js99er-ubergrom', 1);
            request.onupgradeneeded = () => request.result.createObjectStore('cartridges');
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);
        });
        return this.opening;
    }

    static async prepare(software: Software) {
        const image = software.ubergrom;
        if (!image || typeof indexedDB === 'undefined') return;
        if (!image.storageKey) {
            const bytes = new Uint8Array((software.rom?.length ?? 0) + image.flash.length + image.eeprom.length);
            bytes.set(software.rom ?? []);
            bytes.set(image.flash, software.rom?.length ?? 0);
            bytes.set(image.eeprom, bytes.length - image.eeprom.length);
            const hash = await crypto.subtle.digest('SHA-256', bytes);
            image.storageKey = Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
        }
        await this.pending.get(image.storageKey);
        const db = await this.open();
        const saved = await new Promise<UberGromImage | undefined>((resolve, reject) => {
            const tx = db.transaction('cartridges', 'readonly');
            const request = tx.objectStore('cartridges').get(image.storageKey!);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        if (saved) {
            // Validate before using persistent data.
            new UberGrom(saved);
            image.flash = saved.flash;
            image.eeprom = saved.eeprom;
        }
    }

    static save(device: UberGrom): Promise<void> {
        const key = device.storageKey;
        if (!key || typeof indexedDB === 'undefined') return Promise.resolve();
        const snapshot = device.exportImage();
        const operation = this.open().then(db => new Promise<void>((resolve, reject) => {
            const tx = db.transaction('cartridges', 'readwrite');
            tx.objectStore('cartridges').put(snapshot, key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error ?? new Error('UberGROM storage transaction aborted'));
        }));
        this.pending.set(key, operation);
        return operation;
    }
}
