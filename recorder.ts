import fs from "node:fs";
import path from "node:path";
import type { Bot } from "mineflayer";
import { BinaryReplayWriter, BinaryReplayMemoryWriter, type ReplayMetadata, type PacketRecord } from "./format";

export type SaveMode = "file" | "memory" | "stream";

export interface RecordingData {
    metadata: ReplayMetadata;
    buffer: Buffer;
}

export interface ReplayRecorderOptions {
    saveMode?: SaveMode;
    outputPath?: string;
    debug?: boolean;
    onPacket?: (data: Buffer) => void;
}

export class ReplayRecorder {
    private bot: Bot;
    private debug: boolean;
    private recording: boolean = false;
    private startTime: number = 0;
    private outputDir: string;
    private currentReplayId: string = "";
    private saveMode: SaveMode;
    private onPacketCallback?: (data: Buffer) => void;

    private packets: PacketRecord[] = [];
    private binaryWriter?: BinaryReplayWriter | BinaryReplayMemoryWriter;
    private replayMetadata?: ReplayMetadata;
    private spawnPositionSet: boolean = false;
    private botEntitySpawned: boolean = false;

    private capturedPackets = [
        "map_chunk",
        "map_chunk_bulk",
        "block_change",
        "multi_block_change",
        "named_entity_spawn",
        "spawn_entity_living",
        "spawn_entity",
        "entity_velocity",
        "entity_teleport",
        "entity_move_look",
        "rel_entity_move",
        "entity_look",
        "entity_head_rotation",
        "entity_destroy",
        "entity_metadata",
        "chat",
        "update_sign",
        "explosion",
        "entity_equipment",
        "player_abilities",
        "player_info",
    ];

    constructor(bot: Bot, outputDir: string, debug?: boolean);
    constructor(bot: Bot, options: ReplayRecorderOptions);
    constructor(bot: Bot, outputDirOrOptions: string | ReplayRecorderOptions, debug?: boolean) {
        this.bot = bot;

        if (typeof outputDirOrOptions === "string") {
            this.outputDir = outputDirOrOptions;
            this.debug = debug || false;
            this.saveMode = "file";
            this.onPacketCallback = undefined;
        } else {
            const options = outputDirOrOptions;
            this.outputDir = options.outputPath || "./replays";
            this.debug = options.debug || false;
            this.saveMode = options.saveMode || "file";
            this.onPacketCallback = options.onPacket;
        }

        if (this.saveMode === "file" && !fs.existsSync(this.outputDir)) {
            fs.mkdirSync(this.outputDir, { recursive: true });
        }
    }

    startRecording(replayName: string): void {
        if (this.recording) {
            console.warn("[Replay] Already recording!");
            return;
        }

        this.startTime = Date.now();
        this.currentReplayId = replayName;
        this.recording = true;

        this.replayMetadata = {
            spawnPosition: { x: 0, y: 0, z: 0 }, // will be updated on spawn
            startTime: this.startTime,
            endTime: this.startTime, // will be updated on stop
            botUsername: this.bot.username || "unknown",
            mcVersion: this.bot.version || "unknown",
        };

        if (this.saveMode === "file") {
            const replayDir = path.join(this.outputDir, this.currentReplayId);
            if (!fs.existsSync(replayDir)) {
                fs.mkdirSync(replayDir, { recursive: true });
            }

            this.binaryWriter = new BinaryReplayWriter(path.join(replayDir, "replay.bin"));
        } else {
            // memory and stream modes use in-memory writer
            this.binaryWriter = new BinaryReplayMemoryWriter(this.onPacketCallback);
        }

        this.binaryWriter.writeHeader();
        this.attachPacketListener();
        this.attachSpawnListener();

        if (this.debug) {
            console.log(`[Replay] Recording started: ${this.currentReplayId} (mode: ${this.saveMode})`);
        }
    }

    async stopRecording(): Promise<RecordingData | void> {
        if (!this.recording) {
            console.warn("[Replay] Not recording!");
            return;
        }

        this.recording = false;
        this.detachPacketListener();
        this.detachSpawnListener();

        const endTime = Date.now();

        let result: RecordingData | void = undefined;

        if (this.binaryWriter && this.replayMetadata) { // update metadata
            this.replayMetadata.endTime = endTime;

            await this.binaryWriter.close(this.replayMetadata);
            const stats = this.binaryWriter.getStats();
            if (this.debug) {
                console.log(`[Replay] Binary file: ${(stats.bytesWritten / 1024).toFixed(2)} KB, ${stats.packetCount} packets`);
            }

            if (this.saveMode === "memory" && this.binaryWriter instanceof BinaryReplayMemoryWriter) {
                result = {
                    metadata: this.replayMetadata,
                    buffer: this.binaryWriter.getBuffer()
                };
            }

            this.binaryWriter = undefined;
        }

        if (this.debug) {
            console.log(`[Replay] Recording stopped: ${this.currentReplayId}`);
            console.log(`[Replay] Captured ${this.packets.length} packets`);
        }

        this.packets = [];
        this.replayMetadata = undefined;
        this.spawnPositionSet = false;
        this.botEntitySpawned = false;

        return result;
    }

    private attachPacketListener(): void {
        const client = (this.bot as any)._client;
        client.on("packet", this.onPacket);
    }

    private detachPacketListener(): void {
        const client = (this.bot as any)._client;
        client.removeListener("packet", this.onPacket);
    }

    private attachSpawnListener(): void {
        this.bot.once("spawn", this.onSpawn);
    }

    private detachSpawnListener(): void {
        this.bot.removeListener("spawn", this.onSpawn);
    }

    private onSpawn = (): void => {
        if (this.spawnPositionSet || !this.replayMetadata) {
            return;
        }

        const spawnPos = this.bot.entity.position;
        this.replayMetadata.spawnPosition = { x: spawnPos.x, y: spawnPos.y, z: spawnPos.z };
        this.spawnPositionSet = true;

        if (this.debug) {
            console.log(`[Replay] Captured spawn position: ${JSON.stringify(this.replayMetadata.spawnPosition)}`);
        }

        // artificially write a named_entity_spawn packet for the bot itself
        // so it appears as a visible player in the replay
        if (!this.botEntitySpawned && this.bot.entity) {
            const botSpawnPacket: PacketRecord = {
                timestamp: Date.now() - this.startTime,
                name: "named_entity_spawn",
                data: {
                    entityId: this.bot.entity.id,
                    playerUUID: this.bot._client.uuid,
                    x: Math.floor(spawnPos.x * 32),
                    y: Math.floor(spawnPos.y * 32),
                    z: Math.floor(spawnPos.z * 32),
                    yaw: 0,
                    pitch: 0,
                    currentItem: 0,
                    metadata: []
                }
            };

            this.packets.push(botSpawnPacket);
            if (this.binaryWriter) {
                try {
                    this.binaryWriter.writePacket(botSpawnPacket);
                } catch (error) {
                    console.error(`[Replay] Error writing bot spawn packet:`, error);
                }
            }

            this.botEntitySpawned = true;

            if (this.debug) {
                console.log(`[Replay] Artificially wrote bot entity spawn for entity ID: ${this.bot.entity.id}`);
            }
        }
    };

    private onPacket = (data: any, meta: any): void => {
        if (!this.recording) return;

        const packetName = meta.name;
        if (!this.capturedPackets.includes(packetName)) {
            return;
        }

        const record: PacketRecord = {
            timestamp: Date.now() - this.startTime,
            name: packetName,
            data: data,
        };

        this.packets.push(record);
        if (this.binaryWriter) {
            try {
                this.binaryWriter.writePacket(record);
            } catch (error) {
                console.error(`[Replay] Error writing packet ${packetName}:`, error);
            }
        }
    }

    getStats(): { recording: boolean; replayId: string; duration: number; packets: number } {
        return {
            recording: this.recording,
            replayId: this.currentReplayId,
            duration: this.recording ? Date.now() - this.startTime : 0,
            packets: this.packets.length,
        };
    }
}
