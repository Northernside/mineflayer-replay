import { ReplayPlayer } from "../server";

const replayPath = process.argv[2] || "./output.replay";
const port = parseInt(process.argv[3] ?? "25565");

const player = new ReplayPlayer(replayPath, { "online-mode": false, port, version: "1.8.9" }, false);

const viewers = new Map();

player.on("viewer:join", (client) => { // @ts-ignore
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
        text: `Welcome ${client.username}/ `,
        color: "gold",
        extra: [
            { text: `${viewers.size}`, color: "aqua", bold: true },
            { text: " viewers online", color: "white" }
        ]
    });
});

player.on("viewer:leave", (client) => { // @ts-ignore
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

setInterval(() => {
    const currentTime = player.getCurrentTime();
    const totalDuration = player.getTotalDuration();
    const progress = player.getProgress();
    const percentage = progress.percentage.toFixed(1);

    // 00:00:00.00 / 00:00:00 (0.0%)
    const currentH = Math.floor(currentTime / 3600000);
    const currentM = Math.floor((currentTime % 3600000) / 60000);
    const currentS = Math.floor((currentTime % 60000) / 1000);
    const currentMS = Math.floor((currentTime % 1000) / 10);

    const totalH = Math.floor(totalDuration / 3600000);
    const totalM = Math.floor((totalDuration % 3600000) / 60000);
    const totalS = Math.floor((totalDuration % 60000) / 1000);
    const totalMS = Math.floor((totalDuration % 1000) / 10);

    const timeString = `${currentH.toString().padStart(2, "0")}:${currentM.toString().padStart(2, "0")}:${currentS.toString().padStart(2, "0")}.${currentMS.toString().padStart(2, "0")} / ${totalH.toString().padStart(2, "0")}:${totalM.toString().padStart(2, "0")}:${totalS.toString().padStart(2, "0")}.${totalMS.toString().padStart(2, "0")}`;
    player.broadcastActionBar({
        text: `${timeString} (${percentage}%)`,
        color: "gold"
    });
}, 100);

player.on("playback:end", () => {
    player.broadcastChat({
        text: "━━━━━━━━━━━━━━━━━━━━━\nReplay Ended\n━━━━━━━━━━━━━━━━━━━━━",
        color: "gold",
        bold: true
    });
});

player.on("viewer:chat", (client, data) => {
    const message = data.message;
    const args = message.split(" ");
    const cmd = args[0];

    if (!cmd.startsWith("/")) {
        player.broadcastChat({
            text: "",
            color: "white",
            extra: [
                { text: `${client.username} `, color: "red" },
                { text: "» ", color: "gray" },
                { text: message, color: "white" }
            ]
        });
    }

    switch (cmd) {
        case "/play":
            player.startPlayback();
            player.broadcastChat({ text: "▶ Playing", color: "green" });
            break;

        case "/pause":
            player.pausePlayback();
            player.broadcastChat({ text: "⏸ Paused", color: "yellow" });
            break;

        case "/speed":
            const speed = parseFloat(args[1]);
            if (speed >= 0.1 && speed <= 10) {
                player.setPlaybackSpeed(speed);
                player.broadcastChat({ text: `Speed: ${speed}x`, color: "aqua" });
            }
            break;

        case "/seek":
            const seconds = parseFloat(args[1]);
            player.seekToTime(seconds * 1000);
            player.broadcastChat({ text: `Seeked to ${seconds}s`, color: "light_purple" });
            break;

        case "/restart":
            player.seekToTime(0);
            player.broadcastChat({ text: "Restarted", color: "gold" });
            break;

        case "/info":
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
        
        case "/viewers":
            let viewerList = "";
            viewers.forEach((viewer) => {
                const timeConnected = ((Date.now() - viewer.joinTime) / 1000).toFixed(1);
                viewerList += `\n- ${viewer.username} (${timeConnected}s)`;
            });
            player.sendChat(client, {
                text: `👥 Viewers (${viewers.size}):${viewerList}`,
                color: "aqua"
            });
            break;
        
        case "/gamemode":
        case "/gm":
            const mode = args[1];
            if (["0", "1", "2", "3", "survival", "creative", "adventure", "spectator"].includes(mode)) {
                client.write("game_state_change", { reason: 3, gameMode: ["survival", "creative", "adventure", "spectator"].indexOf(mode) >= 0 ? ["survival", "creative", "adventure", "spectator"].indexOf(mode) : parseInt(mode) });
                player.sendChat(client, { text: `Set game mode to ${mode}`, color: "green" });
            } else {
                player.sendChat(client, { text: "Usage: /gamemode <0-3|survival|creative|adventure|spectator>", color: "red" });
            }
            break;

        case "/help":
            player.sendChat(client, {
                text: "📜 Commands:\n",
                color: "gold",
                extra: [
                    { text: "/play - Start playback\n", color: "white" },
                    { text: "/pause - Pause playback\n", color: "white" },
                    { text: "/speed <0.1-10> - Set playback speed\n", color: "white" },
                    { text: "/seek <seconds> - Seek to time\n", color: "white" },
                    { text: "/restart - Restart playback\n", color: "white" },
                    { text: "/info - Show playback info\n", color: "white" },
                    { text: "/viewers - List connected viewers\n", color: "white" },
                    { text: "/help - Show this help message", color: "white" }
                ]
            });
            break;
    }
});


player.on("replay:loaded", (metadata, packetCount) => {
    const duration = ((metadata.endTime || 0) - (metadata.startTime || 0));
    console.log(`[Replay] Loaded ${packetCount} packets (${formatTime(duration)})`);
});

player.initialize().catch((error) => {
    console.error("[Replay] Failed to initialize:", error);
    process.exit(1);
});

process.on("SIGINT", () => {
    console.log("\n[Replay] Shutting down...");
    player.close();
    process.exit(0);
});

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