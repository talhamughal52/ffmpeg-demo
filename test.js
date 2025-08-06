const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const ffmpegPath = "ffmpeg"; // Full path if needed
const { v4: uuidv4 } = require("uuid");
const targetDuration = 2 * 60; // total duration in seconds (1h30m)
let totalRecorded = 0;
let attempt = 1;

const streamUrl =
  "https://real.rocketdns.info/ts_cdn/superreal1/superreal1/721023";
const outputDir = "./recordings";
if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);

function recordSegment(remainingDuration) {
  return new Promise((resolve, reject) => {
    const filename = `segment_${uuidv4()}.mp4`;
    const filepath = path.join(outputDir, filename);

    const ffmpeg = spawn(ffmpegPath, [
      "-y",
      "-i",
      streamUrl,
      "-c",
      "copy",
      "-t",
      remainingDuration.toString(),
      filepath,
    ]);

    const startTime = Date.now();

    ffmpeg.stderr.on("data", (data) => {
      console.log(`[FFmpeg Attempt ${attempt}]: ${data}`);
    });

    ffmpeg.on("exit", (code, signal) => {
      const duration = Math.floor((Date.now() - startTime) / 1000);
      console.log(`FFmpeg exited after ${duration} seconds (code: ${code})`);
      if (duration < 5) {
        // stream might be down, retry later
        reject(new Error("Stream down or FFmpeg failed quickly."));
      } else {
        resolve({ duration, filename });
      }
    });

    ffmpeg.on("error", (err) => {
      reject(err);
    });
  });
}

async function startRecording() {
  while (totalRecorded < targetDuration) {
    const remaining = targetDuration - totalRecorded;
    console.log(`Attempt ${attempt}: Recording ${remaining} more seconds...`);
    try {
      const { duration, filename } = await recordSegment(remaining);
      totalRecorded += duration;
      console.log(`Segment saved: ${filename} (${duration}s)`);
    } catch (err) {
      console.warn(`Recording failed: ${err.message}`);
      console.log("Waiting 15 seconds before retrying...");
      await new Promise((r) => setTimeout(r, 15000));
    }
    attempt++;
  }

  console.log("✅ Recording completed successfully.");
}

startRecording();
