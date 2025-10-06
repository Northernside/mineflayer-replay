# mineflayer-replay

A powerful replay system for Mineflayer bots that allows you to record and play back Minecraft sessions. Perfect for debugging, analysis, or creating cinematic recordings of bot behavior.

## Installation

```bash
bun add mineflayer-replay
# or
npm install mineflayer-replay
# or
pnpm add mineflayer-replay
# or
yarn add mineflayer-replay
```

## Quick Start

### Recording a Session

```typescript
import mineflayer from "mineflayer";
import { ReplayRecorder } from "mineflayer-replay";

const bot = mineflayer.createBot({
  host: "localhost",
  username: "recorder_bot",
  version: "1.8.9"
});

// Create recorder with file save mode
const recorder = new ReplayRecorder(bot, {
  saveMode: "file",
  outputPath: "./replays",
  debug: true
});

bot.once("spawn", () => {
  // Start recording with a unique name
  recorder.startRecording("my_session_" + Date.now());

  // Your bot logic here
  bot.chat("I'm being recorded!");
});

// Stop recording on disconnect
bot.on("end", async () => {
  await recorder.stopRecording();
  console.log("Recording saved!");
});
```

### Playing Back a Replay

```typescript
import { ReplayPlayer } from "mineflayer-replay";

const player = new ReplayPlayer(
  "./replays/my_session/replay.bin",
  {
    "online-mode": false,
    port: 25565,
    version: "1.8.9"
  }
);

// Listen for events
player.on("server:listening", (address, port) => {
  console.log(`Replay server listening on ${address}:${port}`);
});

player.on("viewer:join", (client) => {
  console.log(`${client.username} joined the replay`);
  player.sendChat(client, {
    text: "Type !play to start, !help for commands",
    color: "green"
  });
});

// Handle chat commands
player.on("viewer:chat", (client, data) => {
  const message = data.message;

  if (message === "!play") {
    player.startPlayback();
    player.broadcastChat({ text: "▶ Playback started", color: "green" });
  } else if (message === "!pause") {
    player.pausePlayback();
    player.broadcastChat({ text: "⏸ Playback paused", color: "yellow" });
  }
});

// Initialize and start
await player.initialize();
```

## API Reference

### ReplayRecorder

Records Mineflayer bot sessions to replay files.

#### Constructor

```typescript
new ReplayRecorder(bot: Bot, options: ReplayRecorderOptions)
new ReplayRecorder(bot: Bot, outputDir: string, debug?: boolean)
```

**ReplayRecorderOptions:**
- `saveMode`: `"file" | "memory" | "stream"` - How to save the replay
  - `"file"` (default): Saves directly to disk
  - `"memory"`: Stores in memory, returns buffer on stop
  - `"stream"`: Streams chunks via callback
- `outputPath`: `string` - Directory for replay files (default: `"./replays"`)
- `debug`: `boolean` - Enable debug logging (default: `false`)
- `onPacket`: `(data: Buffer) => void` - Callback for stream mode

#### Methods

##### `startRecording(replayName: string): void`
Starts recording packets with the given replay identifier.

```typescript
recorder.startRecording("boss_fight_attempt_1");
```

##### `stopRecording(): Promise<RecordingData | void>`
Stops recording and finalizes the replay file. Returns `RecordingData` in memory mode.

```typescript
const data = await recorder.stopRecording();
if (data) {
  // data.metadata contains replay info
  // data.buffer contains the replay file
}
```

##### `getStats(): { recording: boolean; replayId: string; duration: number; packets: number }`
Returns current recording statistics.

```typescript
const stats = recorder.getStats();
console.log(`Recording ${stats.replayId}: ${stats.duration}ms, ${stats.packets} packets`);
```

#### Captured Packets

The recorder captures these packet types:
- World: `map_chunk`, `map_chunk_bulk`, `block_change`, `multi_block_change`
- Entities: `named_entity_spawn`, `spawn_entity_living`, `spawn_entity`
- Movement: `entity_velocity`, `entity_teleport`, `entity_move_look`, `rel_entity_move`, `entity_look`, `entity_head_rotation`
- Other: `entity_destroy`, `entity_metadata`, `entity_equipment`, `chat`, `update_sign`, `explosion`, `player_abilities`, `player_info`

### ReplayPlayer

Plays back recorded sessions through a Minecraft server.

#### Constructor

```typescript
new ReplayPlayer(
  filePath: string,
  serverConfig: ServerOptions,
  debug?: boolean
)
```

**Parameters:**
- `filePath`: Path to the replay binary file
- `serverConfig`: Minecraft server configuration (from `minecraft-protocol`)
- `debug`: Enable debug logging

#### Methods

##### `initialize(): Promise<void>`
Loads the replay file and starts the Minecraft server.

```typescript
await player.initialize();
```

##### `startPlayback(): void`
Begins playing the replay from the current position.

##### `pausePlayback(): void`
Pauses playback at the current position.

##### `setPlaybackSpeed(speed: number): void`
Sets playback speed (0.1x to 10x).

```typescript
player.setPlaybackSpeed(2.0); // 2x speed
player.setPlaybackSpeed(0.5); // Half speed
```

##### `seekToTime(timeMs: number): void`
Jumps to a specific time in the replay.

```typescript
player.seekToTime(30000); // Seek to 30 seconds
```

##### `sendChat(client: Client, message: any): void`
Sends a chat message to a specific viewer.

```typescript
player.sendChat(client, {
  text: "Welcome! ",
  color: "gold",
  extra: [
    { text: "Use !help", color: "yellow", bold: true }
  ]
});
```

##### `broadcastChat(message: any): void`
Sends a chat message to all connected viewers.

```typescript
player.broadcastChat({ text: "Replay ending soon!", color: "red" });
```

##### `syncClientToCurrentState(client: Client, clearEntities?: boolean): void`
Synchronizes a viewer to the current replay state (useful for late joiners).

##### `close(): void`
Stops playback and closes the server.

#### Getters

```typescript
getMetadata(): ReplayMetadata | null
isPlaying(): boolean
getCurrentTime(): number
getPlaybackSpeed(): number
getTotalDuration(): number
getConnectedViewers(): Array<{ id: number; username: string; uuid: string }>
getProgress(): { current: number; total: number; percentage: number }
```

#### Events

The `ReplayPlayer` extends `EventEmitter` with these events:

```typescript
player.on("viewer:join", (client) => {})
player.on("viewer:leave", (client) => {})
player.on("viewer:chat", (client, data) => {})
player.on("playback:start", (currentTime) => {})
player.on("playback:pause", (currentTime) => {})
player.on("playback:seek", (fromTime, toTime) => {})
player.on("playback:speed", (oldSpeed, newSpeed) => {})
player.on("playback:end", () => {})
player.on("playback:progress", (currentPacket, totalPackets, currentTime) => {})
player.on("error", (error, context) => {})
player.on("server:listening", (address, port) => {})
player.on("server:error", (error) => {})
player.on("replay:loaded", (metadata, packetCount) => {})
```

## Examples

### Basic File Recording

```typescript
import mineflayer from "mineflayer";
import { ReplayRecorder } from "mineflayer-replay";

const bot = mineflayer.createBot({
  host: "localhost",
  username: "my_bot"
});

const recorder = new ReplayRecorder(bot, "./replays");

bot.once("spawn", () => {
  recorder.startRecording("session_" + Date.now());
});

process.on("SIGINT", async () => {
  await recorder.stopRecording();
  process.exit(0);
});
```

### Memory Mode (for custom processing)

```typescript
const recorder = new ReplayRecorder(bot, {
  saveMode: "memory",
  debug: true
});

recorder.startRecording("memory_test");

// Later...
const recordingData = await recorder.stopRecording();
if (recordingData) {
  // Process the buffer
  fs.writeFileSync("custom_path.replay", recordingData.buffer);
  console.log("Metadata:", recordingData.metadata);
}
```

### Streaming Mode (live processing)

```typescript
import fs from "fs";

const fileStream = fs.createWriteStream("live_output.replay");

const recorder = new ReplayRecorder(bot, {
  saveMode: "stream",
  onPacket: (chunk) => {
    // Each chunk is written as it's captured
    fileStream.write(chunk);
  }
});

recorder.startRecording("stream_session");

// Don't forget to close the stream
bot.on("end", async () => {
  await recorder.stopRecording();
  fileStream.end();
});
```

### Interactive Replay Server

```typescript
import { ReplayPlayer } from "mineflayer-replay";

const player = new ReplayPlayer(
  "./replays/my_session/replay.bin",
  { "online-mode": false, port: 25565, version: "1.8.9" },
  true
);

// Command handling
player.on("viewer:chat", (client, data) => {
  const message = data.message;
  const args = message.split(" ");
  const cmd = args[0];

  switch (cmd) {
    case "!play":
      player.startPlayback();
      player.broadcastChat({ text: "Playing", color: "green" });
      break;

    case "!pause":
      player.pausePlayback();
      player.broadcastChat({ text: "Paused", color: "yellow" });
      break;

    case "!speed":
      const speed = parseFloat(args[1]);
      if (speed >= 0.1 && speed <= 10) {
        player.setPlaybackSpeed(speed);
        player.broadcastChat({ text: `Speed: ${speed}x`, color: "aqua" });
      }
      break;

    case "!seek":
      const seconds = parseFloat(args[1]);
      player.seekToTime(seconds * 1000);
      player.broadcastChat({ text: `Seeked to ${seconds}s`, color: "light_purple" });
      break;

    case "!restart":
      player.seekToTime(0);
      player.broadcastChat({ text: "Restarted", color: "gold" });
      break;

    case "!info":
      const metadata = player.getMetadata();
      const duration = player.getTotalDuration() / 1000;
      const current = player.getCurrentTime() / 1000;
      const progress = player.getProgress();

      player.sendChat(client, {
        text: `ℹ Info:\n`,
        color: "yellow",
        extra: [
          { text: `Time: ${current.toFixed(1)}s / ${duration.toFixed(1)}s\n` },
          { text: `Speed: ${player.getPlaybackSpeed()}x\n` },
          { text: `Playing: ${player.isPlaying()}\n` },
          { text: `Progress: ${progress.percentage.toFixed(1)}%` }
        ]
      });
      break;
  }
});

await player.initialize();
```


### Multiple Viewers with Custom Messages

```typescript
const viewers = new Map();

player.on("viewer:join", (client) => {
  viewers.set(client.id, {
    username: client.username,
    joinTime: Date.now()
  });

  player.broadcastChat({
    text: "",
    extra: [
      { text: "→ ", color: "green" },
      { text: client.username, color: "yellow" },
      { text: " joined the replay", color: "white" }
    ]
  });

  player.sendChat(client, {
    text: `Welcome ${client.username}! `,
    color: "gold",
    extra: [
      { text: `${viewers.size}`, color: "aqua", bold: true },
      { text: " viewers online", color: "white" }
    ]
  });
});

player.on("viewer:leave", (client) => {
  viewers.delete(client.id);

  player.broadcastChat({
    text: "",
    extra: [
      { text: "← ", color: "red" },
      { text: client.username, color: "yellow" },
      { text: " left the replay", color: "white" }
    ]
  });
});
```

### Progress Monitoring

```typescript
player.on("playback:progress", (currentPacket, totalPackets, currentTime) => {
  const percentage = (currentPacket / totalPackets * 100).toFixed(1);
  const timeSeconds = (currentTime / 1000).toFixed(1);

  console.log(`⏯ Progress: ${percentage}% (${timeSeconds}s) - ${currentPacket}/${totalPackets} packets`);
});

player.on("playback:end", () => {
  console.log("🏁 Replay finished!");
  player.broadcastChat({
    text: "━━━━━━━━━━━━━━━━━━━━━\nReplay Ended\n━━━━━━━━━━━━━━━━━━━━━",
    color: "gold",
    bold: true
  });
});
```

## File Format

Replays are stored in a custom binary format:

```
┌─────────────────────────────────────┐
│ Header                             │
├─────────────────────────────────────┤
│ Magic: "MCREPLAY" (8 bytes)        │
│ Version: 0x01 (1 byte)             │
├─────────────────────────────────────┤
│ Packets (repeated)                 │
├─────────────────────────────────────┤
│ - Timestamp delta: varint          │
│ - Packet ID: uint8                 │
│ - Data length: uint32              │
│ - Data: msgpack encoded            │
├─────────────────────────────────────┤
│ Metadata                           │
├─────────────────────────────────────┤
│ - Metadata: msgpack encoded        │
│ - Metadata length: uint32          │
└─────────────────────────────────────┘
```


## License

MIT

## Contributing

Contributions welcome! Please open an issue or PR on GitHub.
