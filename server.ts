import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import mc, { Client, type ServerOptions } from "minecraft-protocol";
import { BinaryReplayReader, type ReplayMetadata, type PacketRecord } from "./format";

export interface ReplayPlayerEvents {
    "viewer:join": (client: Client) => void;
    "viewer:leave": (client: Client) => void;
    "viewer:chat": (client: Client, data: any) => void;
    "playback:start": (currentTime: number) => void;
    "playback:pause": (currentTime: number) => void;
    "playback:seek": (fromTime: number, toTime: number) => void;
    "playback:speed": (oldSpeed: number, newSpeed: number) => void;
    "playback:end": () => void;
    "playback:progress": (currentPacket: number, totalPackets: number, currentTime: number) => void;
    "error": (error: Error, context?: string) => void;
    "server:listening": (address: string, port: number) => void;
    "server:error": (error: Error) => void;
    "replay:loaded": (metadata: ReplayMetadata, packetCount: number) => void;
}

declare interface ReplayPlayer {
    on<K extends keyof ReplayPlayerEvents>(event: K, listener: ReplayPlayerEvents[K]): this;
    emit<K extends keyof ReplayPlayerEvents>(event: K, ...args: Parameters<ReplayPlayerEvents[K]>): boolean;
    off<K extends keyof ReplayPlayerEvents>(event: K, listener: ReplayPlayerEvents[K]): this;
    once<K extends keyof ReplayPlayerEvents>(event: K, listener: ReplayPlayerEvents[K]): this;
}

class ReplayPlayer extends EventEmitter {
    _server: mc.Server | null = null;
    private filePath: string;
    private replayServerConfig: ServerOptions;
    private debug: boolean = false;
    private metadata: ReplayMetadata | null = null;
    private packets: PacketRecord[] = [];
    private clients: Map<number, Client> = new Map();

    private playing: boolean = false;
    private currentTime: number = 0;
    private playbackSpeed: number = 1.0;
    private packetIndex: number = 0;
    private startRealTime: number = 0;

    // state tracking for late-joining clients
    private recentPackets: PacketRecord[] = [];
    private maxRecentPackets: number = 1000; // keep last N packets for sync
    private worldState: Map<string, PacketRecord[]> = new Map();
    private activeEntityIds: Set<number> = new Set();
    private chunkMap: Map<string, PacketRecord> = new Map(); // chunk:coords

    constructor(filePath: string, replayServerConfig: ServerOptions, debug: boolean = false) {
        super();
        this.filePath = filePath;
        this.replayServerConfig = replayServerConfig;
        this.debug = debug;
    }

    async initialize(): Promise<void> {
        try {
            if (!fs.existsSync(this.filePath)) {
                const error = new Error("Replay file does not exist");
                this.emit("error", error, "replay_initialization");
                throw error;
            }

            const reader = new BinaryReplayReader(this.filePath);
            reader.open();

            this.metadata = reader.getMetadata();

            if (this.debug) {
                console.log("[Replay] Full metadata:", this.metadata);
                const stats = reader.getStats();

                console.log(`[Replay] Using spawn position from binary file: ${JSON.stringify(this.metadata.spawnPosition)}`);
                console.log(`[Replay] Duration: ${((this.metadata!.endTime || 0) - this.metadata!.startTime) / 1000}s`);

                console.log("\n=== Replay Statistics ===");
                console.log(`File size: ${this.formatBytes(stats.fileSize)}`);
                console.log(`Total packets: ${stats.packetCount}`);
                console.log(`Chat messages: ${stats.chatMessages}`);
                console.log(`Unique players: ${stats.totalPlayers.size}`);

                console.log("\nPacket breakdown:");
                const sortedPackets = Object.entries(stats.byPacketType)
                    .sort((a, b) => b[1].bytes - a[1].bytes);

                for (const [name, data] of sortedPackets) {
                    const percentage = ((data.bytes / stats.fileSize) * 100).toFixed(1);
                    console.log(`  ${name.padEnd(22)} ${data.count.toString().padStart(5)} packets | ${this.formatBytes(data.bytes).padStart(10)} | ${percentage.padStart(5)}%`);
                }

                console.log("========================\n");
                console.log(`[Replay] Loaded ${this.packets.length} packets from binary format`);
            }

            this.packets = reader.readAllSync();
            reader.close();

            this.emit("replay:loaded", this.metadata, this.packets.length);

            if (!this.replayServerConfig.motd) {
                const duration = ((this.metadata.endTime || 0) - (this.metadata.startTime || 0));
                this.replayServerConfig.motd = `§6§lReplay Viewer\n§eDuration: ${formatTime(duration)}`;
            }

            this._server = mc.createServer(this.replayServerConfig);
            this.setupServer();
        } catch (error: any) {
            const err = error instanceof Error ? error : new Error(String(error));
            this.emit("error", err, "replay_initialization");
            throw err;
        }
    }

    private formatBytes(bytes: number): string {
        if (bytes === 0) return "0 B";
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
    }

    private setupServer(): void {
        this._server?.on("login", (client: Client) => {
            this.handleClientLogin(client);
        });

        this._server?.on("listening", () => { // @ts-ignore
            const address = this._server?.socketServer.address();
            if (this.debug) {
                console.log(`[Replay] Server listening on ${address?.address}:${address?.port}`);
            }

            this.emit("server:listening", address?.address, address?.port);
        });

        this._server?.on("error", (error: any) => {
            const err = error instanceof Error ? error : new Error(String(error));
            this.clients.forEach((client) => {
                try {
                    client.end("Server error");
                } catch (e) { }
            });

            this.clients.clear();
            this.emit("server:error", err);
        });
    }

    private handleClientLogin(client: Client): void {
        if (this.debug) {
            console.log(`[Replay] Client connected: ${client.username}`);
        } // @ts-ignore

        this.clients.set(client.id, client); // @ts-ignore
        this.emit("viewer:join", client);

        if (!this.metadata) {
            try {
                client.end("Replay not loaded");
            } catch (error: any) {
                this.emit("error", error instanceof Error ? error : new Error(String(error)), "client_login");
            }

            return;
        }

        try {
            client.write("login", { // @ts-ignore
                entityId: client.id,
                gameMode: 3,
                dimension: 0,
                difficulty: 2,
                maxPlayers: this._server?.maxPlayers,
                levelType: "default",
                reducedDebugInfo: false,
            });

            // minimal packets to complete login and get past "Downloading terrain"
            if (this.metadata.spawnPosition) {
                client.write("spawn_position", {
                    location: this.metadata.spawnPosition,
                });

                client.write("position", {
                    x: this.metadata.spawnPosition.x,
                    y: this.metadata.spawnPosition.y,
                    z: this.metadata.spawnPosition.z,
                    yaw: 0,
                    pitch: 0,
                    flags: 0x00,
                });
            }


            if (this.playing) {
                this.syncClientToCurrentState(client);
            }
        } catch (error: any) {
            this.emit("error", error instanceof Error ? error : new Error(String(error)), "client_login");
            return;
        }

        client.on("chat", (data: any) => {
            this.emit("viewer:chat", client, data);
        });

        client.on("end", () => {
            if (this.debug) {
                console.log(`[Replay] Client disconnected: ${client.username}`);
            } // @ts-ignore

            this.emit("viewer:leave", client); // @ts-ignore
            this.clients.delete(client.id);
        });

        client.on("error", (error: any) => {
            const err = error instanceof Error ? error : new Error(String(error));
            this.emit("error", err, "client_connection"); // @ts-ignore
            this.clients.delete(client.id);
        });
    }

    sendChat(client: Client, message: any): void {
        try {
            client.write("chat", {
                message: JSON.stringify(message),
                position: 0,
            });
        } catch (error: any) {
            this.emit("error", error instanceof Error ? error : new Error(String(error)), "send_chat");
        }
    }

    sendActionBar(client: Client, message: any): void {
        try {
            client.write("chat", {
                message: JSON.stringify(message),
                position: 2,
            });
        } catch (error: any) {
            this.emit("error", error instanceof Error ? error : new Error(String(error)), "send_action_bar");
        }
    }

    broadcastChat(message: any): void {
        for (const client of this.clients.values()) {
            this.sendChat(client, message);
        }
    }

    broadcastActionBar(message: any): void {
        for (const client of this.clients.values()) {
            this.sendActionBar(client, message);
        }
    }

    startPlayback(): void {
        if (this.playing) return;

        this.playing = true;
        this.startRealTime = Date.now() - this.currentTime / this.playbackSpeed;

        if (this.debug) {
            console.log(`[Replay] Starting playback at ${this.currentTime}ms`);
        }

        this.emit("playback:start", this.currentTime);
        this.playbackLoop();
    }

    pausePlayback(): void {
        if (!this.playing) return;

        this.playing = false;
        if (this.debug) {
            console.log(`[Replay] Paused at ${this.currentTime}ms`);
        }

        this.emit("playback:pause", this.currentTime);
    }

    setPlaybackSpeed(speed: number): void {
        const wasPlaying = this.playing;
        if (wasPlaying) {
            this.pausePlayback();
        }

        this.playbackSpeed = Math.max(0.1, Math.min(10, speed));

        if (this.debug) {
            console.log(`[Replay] Speed: ${this.playbackSpeed}x`);
        }

        this.emit("playback:speed", this.playbackSpeed, speed);

        if (wasPlaying) {
            this.startPlayback();
        }
    }

    seekToTime(targetTime: number): void {
        const wasPlaying = this.playing;
        const fromTime = this.currentTime;

        if (wasPlaying) {
            this.pausePlayback();
        }

        // clamp target time to valid range
        const maxTime = (this.metadata?.endTime || 0) - (this.metadata?.startTime || 0);
        targetTime = Math.max(0, Math.min(maxTime, targetTime));

        if (this.debug) {
            console.log(`[Replay] Seeking to ${targetTime}ms`);
        }

        // reset state for seeking
        this.currentTime = targetTime;
        this.recentPackets = [];
        this.worldState.clear();
        this.activeEntityIds.clear();
        this.chunkMap.clear();

        // packet index for the target time and rebuild state
        let newIndex = 0;
        for (let i = 0; i < this.packets.length; i++) {
            if (this.packets[i]!.timestamp > targetTime) {
                newIndex = i;
                break;
            }

            this.trackWorldStatePacket(this.packets[i]!);
        }

        this.packetIndex = newIndex;

        if (this.debug) {
            console.log(`[Replay] Seeked to packet ${newIndex}/${this.packets.length}`);
        }

        this.emit("playback:seek", fromTime, targetTime);

        for (const client of this.clients.values()) {
            this.syncClientToCurrentState(client, true);
        }

        if (wasPlaying) {
            this.startPlayback();
        }
    }

    private playbackLoop(): void {
        if (!this.playing) return;

        const realElapsed = (Date.now() - this.startRealTime) * this.playbackSpeed;
        this.currentTime = realElapsed;

        let packetsProcessed = 0;
        while (this.packetIndex < this.packets.length) {
            const packet = this.packets[this.packetIndex];

            if (packet!.timestamp > this.currentTime) {
                break;
            }

            this.replayPacket(packet!);
            this.packetIndex++;
            packetsProcessed++;
        }

        if (packetsProcessed > 0 && this.packetIndex % 100 === 0) {
            if (this.debug) {
                console.log(`[Replay] Progress: ${this.packetIndex}/${this.packets.length} packets`);
            }

            this.emit("playback:progress", this.packetIndex, this.packets.length, this.currentTime);
        }

        if (this.packetIndex >= this.packets.length) {
            if (this.debug) {
                console.log("[Replay] Playback finished");
            }

            this.playing = false;
            this.emit("playback:end");
            return;
        }

        setImmediate(() => this.playbackLoop());
    }

    private replayPacket(packet: PacketRecord): void {
        // extra tracking for late joiners
        this.recentPackets.push(packet);
        if (this.recentPackets.length > this.maxRecentPackets) {
            this.recentPackets.shift();
        }

        this.trackWorldStatePacket(packet);

        for (const client of this.clients.values()) {
            try {
                client.write(packet.name, packet.data);
            } catch (error: any) {
                const err = error instanceof Error ? error : new Error(String(error));
                if (this.debug) {
                    console.error(`[Replay] Failed packet data:`, packet.data);
                }

                this.emit("error", err, `packet_replay:${packet.name}`);
            }
        }
    }

    private trackWorldStatePacket(packet: PacketRecord): void {
        if (packet.name === "named_entity_spawn" || packet.name === "spawn_entity_living" || packet.name === "spawn_entity") {
            if (packet.data.entityId !== undefined) {
                this.activeEntityIds.add(packet.data.entityId);
            }
        } else if (packet.name === "entity_destroy") {
            if (packet.data.entityIds && Array.isArray(packet.data.entityIds)) {
                for (const id of packet.data.entityIds) {
                    this.activeEntityIds.delete(id);
                }
            }
        }

        // chunks:coords map for quick lookup during sync
        if (packet.name === "map_chunk" && packet.data.x !== undefined && packet.data.z !== undefined) {
            const chunkKey = `${packet.data.x},${packet.data.z}`;
            this.chunkMap.set(chunkKey, packet);
        } else if (packet.name === "map_chunk_bulk") {
            if (!this.worldState.has("map_chunk_bulk")) {
                this.worldState.set("map_chunk_bulk", []);
            }

            const bulkList = this.worldState.get("map_chunk_bulk")!;
            bulkList.push(packet);
        }

        const statePacketTypes = [
            "named_entity_spawn",
            "spawn_entity_living",
            "spawn_entity",
            "player_info"
        ];

        if (statePacketTypes.includes(packet.name)) {
            if (!this.worldState.has(packet.name)) {
                this.worldState.set(packet.name, []);
            }

            const packetList = this.worldState.get(packet.name)!;
            packetList.push(packet);
        }
    }

    syncClientToCurrentState(client: Client, clearEntities: boolean = false): void {
        if (this.debug) {
            console.log(`[Replay] Syncing client ${client.username} to current state (time: ${this.currentTime}ms)`);
        }

        let packetsSent = 0;

        // dimension switch trick -> forces the client to completely clear its world state
        if (clearEntities) {
            try {
                client.write("respawn", {
                    dimension: -1,
                    difficulty: 2,
                    gamemode: 3,
                    levelType: "default"
                });
                packetsSent++;

                client.write("respawn", {
                    dimension: 0,
                    difficulty: 2,
                    gamemode: 3,
                    levelType: "default"
                });
                packetsSent++;

                // resend spawn & player position
                if (this.metadata?.spawnPosition) {
                    client.write("spawn_position", {
                        location: this.metadata.spawnPosition,
                    });
                    packetsSent++;

                    client.write("position", {
                        x: this.metadata.spawnPosition.x,
                        y: this.metadata.spawnPosition.y,
                        z: this.metadata.spawnPosition.z,
                        yaw: 0,
                        pitch: 0,
                        flags: 0x00,
                    });
                    packetsSent++;
                }

                if (this.debug) {
                    console.log(`[Replay] Performed dimension switch for ${client.username}`);
                }
            } catch (error: any) {
                const err = error instanceof Error ? error : new Error(String(error));
                this.emit("error", err, "dimension_switch");
            }
        }

        // chunks first, then entities
        const chunkPackets = Array.from(this.chunkMap.values());
        const chunkBulkPackets = this.worldState.get("map_chunk_bulk") || [];
        const playerInfoPackets = this.worldState.get("player_info") || [];
        const entitySpawnPackets = [
            ...(this.worldState.get("named_entity_spawn") || []),
            ...(this.worldState.get("spawn_entity_living") || []),
            ...(this.worldState.get("spawn_entity") || [])
        ];

        if (this.debug) {
            console.log(`[Replay] Syncing ${chunkPackets.length} individual chunks + ${chunkBulkPackets.length} bulk chunks`);
        }

        for (const packet of [...chunkPackets, ...chunkBulkPackets]) {
            try {
                client.write(packet.name, packet.data);
                packetsSent++;
            } catch (error: any) {
                const err = error instanceof Error ? error : new Error(String(error));
                if (this.debug) {
                    console.error(`[Replay] Error syncing ${packet.name}:`, err.message);
                    console.error(`[Replay] Packet data:`, JSON.stringify(packet.data).substring(0, 500));
                }

                this.emit("error", err, `sync:${packet.name}`);
            }
        }

        for (const packet of playerInfoPackets) {
            try {
                client.write(packet.name, packet.data);
                packetsSent++;
            } catch (error: any) {
                const err = error instanceof Error ? error : new Error(String(error));
                if (this.debug) {
                    console.error(`[Replay] Error syncing ${packet.name}:`, err.message);
                    console.error(`[Replay] Packet data:`, packet.data);
                }

                this.emit("error", err, `sync:${packet.name}`);
            }
        }

        for (const packet of entitySpawnPackets) {
            try {
                client.write(packet.name, packet.data);
                packetsSent++;
            } catch (error: any) {
                const err = error instanceof Error ? error : new Error(String(error));
                if (this.debug) {
                    console.error(`[Replay] Error syncing ${packet.name}:`, err.message);
                    console.error(`[Replay] Packet data:`, JSON.stringify(packet.data).substring(0, 500));
                }

                this.emit("error", err, `sync:${packet.name}`);
            }
        }

        // for late joiners (not during seek), send recent packets
        if (!clearEntities) {
            for (const packet of this.recentPackets) {
                try {
                    client.write(packet.name, packet.data);
                    packetsSent++;
                } catch (error: any) {
                    const err = error instanceof Error ? error : new Error(String(error));
                    if (this.debug) {
                        console.error(`[Replay] Error syncing ${packet.name}:`, err.message);
                        console.error(`[Replay] Packet data:`, JSON.stringify(packet.data).substring(0, 500));
                    }

                    this.emit("error", err, `sync:${packet.name}`);
                }
            }
        }

        if (this.debug) {
            console.log(`[Replay] Sent ${packetsSent} packets (${entitySpawnPackets.length} entity spawns) to sync ${client.username}`);
        }
    }

    close(): void {
        this.pausePlayback();
        for (const client of this.clients.values()) {
            try {
                client.end("Server closing");
            } catch (error: any) { }
        }

        this.clients.clear();

        try {
            this._server?.close();
        } catch (error: any) {
            const err = error instanceof Error ? error : new Error(String(error));
            this.emit("error", err, "server_close");
        }
    }

    getMetadata(): ReplayMetadata | null {
        return this.metadata;
    }

    isPlaying(): boolean {
        return this.playing;
    }

    getCurrentTime(): number {
        return this.currentTime;
    }

    getPlaybackSpeed(): number {
        return this.playbackSpeed;
    }

    getTotalDuration(): number {
        if (!this.metadata) return 0;
        return (this.metadata.endTime || 0) - this.metadata.startTime;
    }

    getConnectedViewers(): Array<{ id: number; username: string; uuid: string }> {
        return Array.from(this.clients.entries()).map(([id, client]) => ({
            id,
            username: client.username,
            uuid: client.uuid
        }));
    }

    getProgress(): { current: number; total: number; percentage: number } {
        return {
            current: this.packetIndex,
            total: this.packets.length,
            percentage: this.packets.length > 0 ? (this.packetIndex / this.packets.length) * 100 : 0
        };
    }
}

function formatTime(ms: number): string {
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) {
        return `${hours}h ${minutes}m ${seconds}s`;
    } else if (minutes > 0) {
        return `${minutes}m ${seconds}s`;
    } else {
        return `${seconds}s`;
    }
}

export { ReplayPlayer };
