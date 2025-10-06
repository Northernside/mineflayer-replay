import fs from "node:fs";
import mineflayer from "mineflayer";
import { ReplayRecorder } from "../recorder";

const bot = mineflayer.createBot({
    host: process.env.MC_HOST || "laby.net",
    username: process.env.MC_USERNAME || "",
    auth: "microsoft",
    version: "1.8.9",
});

const fileStream = fs.createWriteStream("output.replay");

const recorder = new ReplayRecorder(bot, {
  saveMode: "stream",
  onPacket: (chunk) => {
    fileStream.write(chunk);
  },
  debug: true,
});

recorder.startRecording("hehehehhehe");

bot.once("spawn", () => {
    console.log(`Joined as ${bot.username}`);

    setInterval(() => {
        const stats = recorder.getStats();
        if (stats.recording) {
            console.log(`[Replay Stats] Duration: ${Math.floor(stats.duration / 1000)}s | Packets: ${stats.packets}`);
        }
    }, 5000);
});

bot.on("kicked", async (reason) => {
    console.log("Kicked:", reason);
    await recorder.stopRecording();
    fileStream.end();
});

bot.on("error", async (error) => {
    console.log("Error:", error);
    await recorder.stopRecording();
    fileStream.end();
});

process.on("SIGINT", async () => {
    console.log("\n[Replay] Shutting down gracefully...");
    if (recorder.getStats().recording) {
        await recorder.stopRecording();
    }

    // important: wait for the file to be fully written before exiting
    fileStream.end(() => {
        process.exit(0);
    });
});