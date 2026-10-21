import {DiskImage} from './disk-image';
import {DiskError} from './disk';

/** Level-2 disk access uses raw sectors, including record headers and padding. */
export class DirectFileAccess {
    static find(image: DiskImage, name: string) {
        const bytes = image.getBinaryImage();
        for (let i = 0; i < 127; i++) {
            const fd = ((bytes[256 + i * 2] << 8) | bytes[257 + i * 2]) * 256;
            if (!fd || fd + 256 > bytes.length) continue;
            if (String.fromCharCode(...bytes.subarray(fd, fd + 10)).trim() === name) {
                const count = (bytes[fd + 14] << 8) | bytes[fd + 15];
                const sectors = image.getSectorsAllocatedToFile(fd + 28, bytes, count);
                return {bytes, fd, sectors, count};
            }
        }
        return null;
    }

    // The eight parameter bytes match the TIFILES header at offsets 8..15:
    // sector count, flags, records/sector, EOF, record length, little-endian count.
    static create(image: DiskImage, name: string, info: Uint8Array): number {
        const original = image.getBinaryImage();
        if (original[16] === 0x50) return DiskError.WRITE_PROTECTED;
        const old = this.find(image, name);
        if (old && (original[old.fd + 12] & 8)) return DiskError.WRITE_PROTECTED;
        const count = (info[0] << 8) | info[1];
        const auSize = image.getSectorsPerAllocationUnit();
        const cluster = image.getSectorsPerCluster();
        const total = (original[10] << 8) | original[11];
        const bytes = original.slice(); // Commit only after allocation succeeds.
        const allocated = (au: number) => !!(bytes[0x38 + (au >> 3)] & (1 << (au & 7)));
        const mark = (au: number, used: boolean) => {
            if (used) bytes[0x38 + (au >> 3)] |= 1 << (au & 7);
            else bytes[0x38 + (au >> 3)] &= ~(1 << (au & 7));
        };
        if (old) for (const s of old.sectors) mark(Math.floor(s / auSize), false);
        const directory: number[] = [];
        for (let i = 0; i < 127; i++) {
            const sector = (bytes[256 + i * 2] << 8) | bytes[257 + i * 2];
            if (sector) directory.push(sector);
        }
        if (!old && directory.length >= 127) return DiskError.OUT_OF_SPACE;
        const take = () => {
            for (let au = Math.ceil(2 / auSize); au < Math.floor(total / auSize); au++) {
                if (!allocated(au)) { mark(au, true); return au * auSize; }
            }
            return -1;
        };
        const fdSector = old ? old.fd / 256 : take();
        if (fdSector < 0) return DiskError.OUT_OF_SPACE;
        const sectors: number[] = [];
        while (sectors.length < count) {
            const start = take();
            if (start < 0) return DiskError.OUT_OF_SPACE;
            for (let j = 0; j < auSize && sectors.length < count; j++) sectors.push(start + j);
        }
        const fd = fdSector * 256;
        bytes.fill(0, fd, fd + 256);
        for (let i = 0; i < 10; i++) bytes[fd + i] = i < name.length ? name.charCodeAt(i) : 32;
        bytes.set(info.subarray(2, 4), fd + 12);
        bytes.set(info.subarray(0, 2), fd + 14);
        bytes.set(info.subarray(4, 8), fd + 16);
        let entry = 0;
        for (let i = 0; i < sectors.length;) {
            const start = sectors[i];
            let end = i;
            while (end + 1 < sectors.length && sectors[end + 1] === sectors[end] + 1) end++;
            if (entry >= 76 || start % cluster || end > 4095) return DiskError.OUT_OF_SPACE;
            const addr = fd + 28 + entry++ * 3, unit = start / cluster;
            bytes[addr] = unit & 255;
            bytes[addr + 1] = ((end & 15) << 4) | ((unit >> 8) & 15);
            bytes[addr + 2] = end >> 4;
            i = end + 1;
        }
        for (const s of sectors) bytes.fill(0, s * 256, (s + 1) * 256);
        if (!old) directory.push(fdSector);
        directory.sort((a, b) => {
            const an = String.fromCharCode(...bytes.subarray(a * 256, a * 256 + 10));
            const bn = String.fromCharCode(...bytes.subarray(b * 256, b * 256 + 10));
            return an < bn ? -1 : an > bn ? 1 : 0;
        });
        bytes.fill(0, 256, 512);
        directory.forEach((s, i) => {bytes[256 + i * 2] = s >> 8; bytes[257 + i * 2] = s & 255;});
        image.loadBinaryImage(bytes);
        return 0;
    }
}
