// install:
//   npm install fluent-ffmpeg @ffmpeg-installer/ffmpeg
//   OR ensure ffmpeg is on your system PATH

const fs = require("fs");
const path = require("path");
const ffmpegPath = require("@ffmpeg-installer/ffmpeg").path;
const ffmpeg = require("fluent-ffmpeg");
ffmpeg.setFfmpegPath(ffmpegPath);

function recordSegment({ streamUrl, offsetMs, durationMs, targetDir }) {
  const offsetSec = offsetMs / 1000;
  const durationSec = durationMs / 1000;

  // convert seconds to "HH:MM:SS"
  const fmt = (t) => {
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = (t % 60).toFixed(3);
    return `${h}:${m.toString().padStart(2, "0")}:${s.padStart(6, "0")}`;
  };

  const outName = `rec_from_${fmt(offsetSec)}_dur_${fmt(durationSec)}.mp4`;
  const outPath = path.join(targetDir, outName);

  ffmpeg(streamUrl)
    .seekInput(fmt(offsetSec))
    .duration(fmt(durationSec))
    .outputOptions("-c copy") // fastest—just segment copy
    .save(outPath)
    .on("start", (cmd) => console.log("FFmpeg cmd:", cmd))
    .on("error", (err, stdout, stderr) => {
      console.error("Error:", err);
    })
    .on("end", () => {
      console.log("Segment saved to", outPath);
    });
}

// Example: record from 1:00 for 10:00 into ./recordings
const OFFSET_MINUTES = 0 * 60_000;
const DURATION_MINUTES = 2 * 60_000;

function scheduleRecording({ url, offsetMs, durationMs }) {
  const recordingsDir = path.resolve(__dirname, "recordings");
  fs.mkdirSync(recordingsDir, { recursive: true });
  recordSegment({
    streamUrl: url,
    offsetMs,
    durationMs,
    targetDir: recordingsDir,
  });
}

// To test your 1-min start + 10-min capture:
scheduleRecording({
  // url: "https://real.scalecdn.co/movie/superreal1/superreal1/718790.mkv",
  // url: "https://real.scalecdn.co/live/superreal1/superreal1/694516.ts",
  url: "https://real.rocketdns.info/ts_cdn/superreal1/superreal1/721023",
  offsetMs: OFFSET_MINUTES,
  durationMs: DURATION_MINUTES,
});
