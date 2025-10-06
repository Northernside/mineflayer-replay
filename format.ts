import fs from "node:fs";
import { Packr, Unpackr } from "msgpackr";
import { mapToObject } from "./utils";
import { decodeVarint, encodeVarint } from "./varint";
import { deserializeData, serializeData } from "./chunk";

/**
 * Format:
 * - Magic: "MCREPLAY" (8 bytes)
 * - Version: 0x01 (1 byte)
 * - Packets (repeated):
 *   - Timestamp delta: varint (1-5 bytes, relative to previous)
 *   - Packet ID: uint8 (1 byte)
 *   - Data length: uint32 (4 bytes)
 *   - Data: msgpack encoded
 * - Metadata: msgpack encoded
 *   - spawnPosition: {x: int, y: int, z: int}
 *   - startTime: int (unix timestamp ms)
 *   - endTime: int (unix timestamp ms)
 *   - botUsername: string
 *   - mcVersion: string
 * - Metadata length: uint32 (4 bytes)
 */

const MAGIC = "MCREPLAY";
const VERSION = 0x01;

const packer = new Packr({
    useRecords: false,
    structuredClone: true,
    bundleStrings: true
});

const unpacker = new Unpackr({
    useRecords: false,
    structuredClone: true
});

const PACKET_IDS: Record<string, number> = {
    "map_chunk": 1,
    "map_chunk_bulk": 2,
    "block_change": 3,
    "multi_block_change": 4,
    "named_entity_spawn": 5,
    "spawn_entity_living": 6,
    "spawn_entity": 7,
    "entity_velocity": 8,
    "entity_teleport": 9,
    "entity_move_look": 10,
    "rel_entity_move": 11,
    "entity_look": 12,
    "entity_head_rotation": 13,
    "entity_destroy": 14,
    "chat": 15,
    "player_info": 16,
    "update_sign": 17,
    "explosion": 18,
    "entity_equipment": 19,
    "player_abilities": 20,
    "entity_metadata": 21,
};

const ID_TO_PACKET: Record<number, string> = Object.fromEntries(
    Object.entries(PACKET_IDS).map(([name, id]) => [id, name])
);

export interface ReplayMetadata {
    spawnPosition: { x: number; y: number; z: number };
    startTime: number;
    endTime: number;
    botUsername: string;
    mcVersion: string;
}

export interface PacketRecord {
    timestamp: number;
    name: string;
    data: any;
}

export interface ReplayWriter {
    writeHeader(): void;
    writePacket(record: PacketRecord): void;
    close(metadata: ReplayMetadata): Promise<void>;
    getStats(): { bytesWritten: number; packetCount: number };
}

export class BinaryReplayWriter implements ReplayWriter {
    private stream: fs.WriteStream;
    private filePath: string;
    private bytesWritten: number = 0;
    private packetCount: number = 0;
    private headerWritten: boolean = false;
    private lastTimestamp: number = 0;

    constructor(filePath: string) {
        this.filePath = filePath;
        this.stream = fs.createWriteStream(filePath);
    }

    writeHeader(): void {
        if (this.headerWritten) {
            throw new Error("Header already written");
        }

        const magicBuf = Buffer.from(MAGIC, "ascii");
        this.stream.write(magicBuf);
        this.bytesWritten += 8;

        const versionBuf = Buffer.allocUnsafe(1);
        versionBuf.writeUInt8(VERSION, 0);
        this.stream.write(versionBuf);
        this.bytesWritten += 1;

        this.headerWritten = true;
    }

    /**
     * A written packet is composed of:
     * - Timestamp delta: varint (1-5 bytes)
     * - Packet ID: uint8 (1 byte)
     * - Data length: uint32 (4 bytes)
     * - Data: msgpack encoded
     *
     * Timestamps are stored as deltas from the previous packet.
     * For the first packet, the delta is from 0.
     */
    writePacket(record: PacketRecord): void {
        if (!this.headerWritten) {
            throw new Error("Must write header before packets");
        }

        const packetId = PACKET_IDS[record.name];
        if (packetId === undefined) {
            throw new Error(`Unknown packet name: ${record.name}`);
        }

        const delta = record.timestamp - this.lastTimestamp;
        this.lastTimestamp = record.timestamp;

        const timestampBuf = encodeVarint(delta);
        this.stream.write(timestampBuf);
        this.bytesWritten += timestampBuf.length;

        const packetIdBuf = Buffer.allocUnsafe(1);
        packetIdBuf.writeUInt8(packetId, 0);
        this.stream.write(packetIdBuf);
        this.bytesWritten += 1;

        const serialized = serializeData(record.data);
        const dataBuf = packer.encode(serialized);
        const dataLengthBuf = Buffer.allocUnsafe(4);
        dataLengthBuf.writeUInt32LE(dataBuf.length, 0);
        this.stream.write(dataLengthBuf);
        this.stream.write(dataBuf);
        this.bytesWritten += 4 + dataBuf.length;

        this.packetCount++;
    }

    async close(metadata: ReplayMetadata): Promise<void> {
        // write metadata at the end before closing
        const metadataBuf = packer.encode(metadata);
        const metadataLengthBuf = Buffer.allocUnsafe(4);
        metadataLengthBuf.writeUInt32LE(metadataBuf.length, 0);

        this.stream.write(metadataBuf);
        this.stream.write(metadataLengthBuf);
        this.bytesWritten += 4 + metadataBuf.length;

        return new Promise((resolve, reject) => {
            this.stream.end((err: Error): void => {
                if (err) reject(err);
                else resolve();
            });
        });
    }

    getStats(): { bytesWritten: number; packetCount: number } {
        return {
            bytesWritten: this.bytesWritten,
            packetCount: this.packetCount
        };
    };
}

export class BinaryReplayMemoryWriter implements ReplayWriter {
    private buffers: Buffer[] = [];
    private bytesWritten: number = 0;
    private packetCount: number = 0;
    private headerWritten: boolean = false;
    private lastTimestamp: number = 0;
    private onPacketCallback?: (data: Buffer) => void;

    constructor(onPacketCallback?: (data: Buffer) => void) {
        this.onPacketCallback = onPacketCallback;
    }

    private write(buffer: Buffer): void {
        this.buffers.push(buffer);
        this.bytesWritten += buffer.length;

        // stream mode: emit each chunk immediately
        if (this.onPacketCallback) {
            this.onPacketCallback(buffer);
        }
    }

    writeHeader(): void {
        if (this.headerWritten) {
            throw new Error("Header already written");
        }

        const magicBuf = Buffer.from(MAGIC, "ascii");
        this.write(magicBuf);

        const versionBuf = Buffer.allocUnsafe(1);
        versionBuf.writeUInt8(VERSION, 0);
        this.write(versionBuf);

        this.headerWritten = true;
    }

    writePacket(record: PacketRecord): void {
        if (!this.headerWritten) {
            throw new Error("Must write header before packets");
        }

        const packetId = PACKET_IDS[record.name];
        if (packetId === undefined) {
            throw new Error(`Unknown packet name: ${record.name}`);
        }

        const delta = record.timestamp - this.lastTimestamp;
        this.lastTimestamp = record.timestamp;

        const timestampBuf = encodeVarint(delta);
        this.write(timestampBuf);

        const packetIdBuf = Buffer.allocUnsafe(1);
        packetIdBuf.writeUInt8(packetId, 0);
        this.write(packetIdBuf);

        const serialized = serializeData(record.data);
        const dataBuf = packer.encode(serialized);
        const dataLengthBuf = Buffer.allocUnsafe(4);
        dataLengthBuf.writeUInt32LE(dataBuf.length, 0);
        this.write(dataLengthBuf);
        this.write(dataBuf);

        this.packetCount++;
    }

    async close(metadata: ReplayMetadata): Promise<void> {
        const metadataBuf = packer.encode(metadata);
        const metadataLengthBuf = Buffer.allocUnsafe(4);
        metadataLengthBuf.writeUInt32LE(metadataBuf.length, 0);

        this.write(metadataBuf);
        this.write(metadataLengthBuf);
    }

    getBuffer(): Buffer {
        return Buffer.concat(this.buffers);
    }

    getStats(): { bytesWritten: number; packetCount: number } {
        return {
            bytesWritten: this.bytesWritten,
            packetCount: this.packetCount
        };
    }
}

export class BinaryReplayReader {
    private filePath: string;
    private fd: number | null = null;
    private metadata: ReplayMetadata | null = null;
    private dataStartOffset: number = 0;
    private dataEndOffset: number = 0;

    constructor(filePath: string) {
        this.filePath = filePath;
    }

    open(): void {
        if (this.fd !== null) return;
        this.fd = fs.openSync(this.filePath, "r");
        this.readHeader();
        this.readMetadata();
    }

    private readHeader(): void {
        if (this.fd === null) throw new Error("File not opened");
        let pos = 0;

        const magicBuf = Buffer.allocUnsafe(8);
        fs.readSync(this.fd, magicBuf, 0, 8, pos);
        pos += 8;

        const magic = magicBuf.toString("ascii");
        if (magic !== MAGIC) {
            throw new Error(`Invalid replay file - bad magic: ${magic}`);
        }

        const versionBuf = Buffer.allocUnsafe(1);
        fs.readSync(this.fd, versionBuf, 0, 1, pos);
        pos += 1;

        const version = versionBuf.readUInt8(0);
        if (version !== VERSION) {
            throw new Error(`Unsupported replay file version: ${version} (expected ${VERSION})`);
        }

        // packets start immediately after header
        this.dataStartOffset = pos;
    }

    private readMetadata(): void {
        if (this.fd === null) throw new Error("File not opened");
        if (this.metadata !== null) return; // already read

        // metadata at end
        const fileSize = fs.fstatSync(this.fd).size;

        // len last 4 bytes of the file
        const metadataLengthBuf = Buffer.allocUnsafe(4);
        fs.readSync(this.fd, metadataLengthBuf, 0, 4, fileSize - 4);
        const metadataLength = metadataLengthBuf.readUInt32LE(0);

        const metadataBuf = Buffer.allocUnsafe(metadataLength);
        fs.readSync(this.fd, metadataBuf, 0, metadataLength, fileSize - 4 - metadataLength);

        this.metadata = mapToObject(unpacker.decode(metadataBuf));

        // calc where packet data ends (before metadata)
        this.dataEndOffset = fileSize - 4 - metadataLength;
    }

    getMetadata(): ReplayMetadata {
        if (this.metadata === null) {
            throw new Error("Header not read");
        }

        return this.metadata;
    }

    *readPackets(): Generator<PacketRecord> {
        if (this.fd === null) throw new Error("File not opened");

        let position = this.dataStartOffset;
        let currentTimestamp = 0;

        // pre-allocate 64kB buffer
        const readBuf = Buffer.allocUnsafe(64 * 1024);

        while (position < this.dataEndOffset) {
            // timestamp delta (fck varint)
            const varintBuf = Buffer.allocUnsafe(5);
            let varintRead = fs.readSync(this.fd, varintBuf, 0, 5, position);
            if (varintRead === 0) break;

            const { value: delta, bytesRead: varintBytes } = decodeVarint(varintBuf, 0);
            position += varintBytes;
            currentTimestamp += delta;

            const packetIdBuf = Buffer.allocUnsafe(1);
            fs.readSync(this.fd, packetIdBuf, 0, 1, position);
            position += 1;

            const packetId = packetIdBuf.readUInt8(0);
            const name = ID_TO_PACKET[packetId];
            if (!name) {
                throw new Error(`Unknown packet ID: ${packetId} at offset ${position - 1}`);
            }

            const dataLengthBuf = Buffer.allocUnsafe(4);
            fs.readSync(this.fd, dataLengthBuf, 0, 4, position);
            position += 4;

            const dataLength = dataLengthBuf.readUInt32LE(0);
            const dataBuf = dataLength <= readBuf.length ? readBuf.subarray(0, dataLength)
                : Buffer.allocUnsafe(dataLength); // increase for larger packets

            fs.readSync(this.fd, dataBuf, 0, dataLength, position);
            position += dataLength;

            const data = deserializeData(unpacker.decode(dataBuf.subarray(0, dataLength)));

            yield {
                timestamp: currentTimestamp,
                name,
                data
            };
        }
    }

    readAllSync(): PacketRecord[] {
        const packets: PacketRecord[] = [];
        for (const packet of this.readPackets()) {
            packets.push(packet);
        }

        return packets;
    }

    getStats(): {
        fileSize: number;
        packetCount: number;
        byPacketType: Record<string, { count: number; bytes: number }>;
        totalPlayers: Set<string>;
        chatMessages: number;
    } {
        if (this.fd === null) throw new Error("File not opened");

        const fileSize = fs.fstatSync(this.fd).size;
        const byPacketType: Record<string, { count: number; bytes: number }> = {};
        const totalPlayers = new Set<string>();
        let chatMessages = 0;
        let packetCount = 0;

        let position = this.dataStartOffset;
        let currentTimestamp = 0;
        const readBuf = Buffer.allocUnsafe(64 * 1024);

        while (position < this.dataEndOffset) {
            const packetStartPos = position;

            const varintBuf = Buffer.allocUnsafe(5);
            let varintRead = fs.readSync(this.fd, varintBuf, 0, 5, position);
            if (varintRead === 0) break;

            const { value: delta, bytesRead: varintBytes } = decodeVarint(varintBuf, 0);
            position += varintBytes;
            currentTimestamp += delta;

            const packetIdBuf = Buffer.allocUnsafe(1);
            fs.readSync(this.fd, packetIdBuf, 0, 1, position);
            position += 1;

            const packetId = packetIdBuf.readUInt8(0);
            const name = ID_TO_PACKET[packetId];
            if (!name) break;

            const dataLengthBuf = Buffer.allocUnsafe(4);
            fs.readSync(this.fd, dataLengthBuf, 0, 4, position);
            position += 4;

            const dataLength = dataLengthBuf.readUInt32LE(0);

            const dataBuf = dataLength <= readBuf.length
                ? readBuf.subarray(0, dataLength)
                : Buffer.allocUnsafe(dataLength);
            fs.readSync(this.fd, dataBuf, 0, dataLength, position);
            position += dataLength;

            const packetBytes = position - packetStartPos;

            if (!byPacketType[name]) {
                byPacketType[name] = { count: 0, bytes: 0 };
            }

            byPacketType[name].count++;
            byPacketType[name].bytes += packetBytes;
            packetCount++;

            if (name === "chat") {
                chatMessages++;
            } else if (name === "named_entity_spawn" || name === "player_info") {
                try {
                    const data = unpacker.decode(dataBuf.subarray(0, dataLength));
                    if (data.playerName) totalPlayers.add(data.playerName);
                    if (data.data && Array.isArray(data.data)) {
                        data.data.forEach((p: any) => {
                            if (p.name) totalPlayers.add(p.name);
                        });
                    }
                } catch (e) {
                    throw new Error(`Failed to decode ${name} packet at offset ${packetStartPos}: ${e}`);
                }
            }
        }

        return {
            fileSize,
            packetCount,
            byPacketType,
            totalPlayers,
            chatMessages
        };
    }

    close(): void {
        if (this.fd !== null) {
            fs.closeSync(this.fd);
            this.fd = null;
        }
    }
}
