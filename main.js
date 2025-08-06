const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const { URL } = require("url");

class ResilientStreamRecorder {
  constructor(streamUrl, outputDir = "./recordings") {
    this.streamUrl = streamUrl;
    this.outputDir = outputDir;
    this.recordings = [];
    this.totalDurationMs = 0;
    this.recordedDurationMs = 0;
    this.isRecording = false;
    this.isMonitoring = false;
    this.currentProcess = null;
    this.startTime = null;
    this.sessionId = Date.now();
    this.streamMonitorInterval = null;
    this.quickCheckInterval = null;

    // Stream availability tracking
    this.lastSuccessfulCheck = null;
    this.consecutiveFailures = 0;
    this.isStreamAvailable = false;

    // Ensure output directory exists
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
  }

  // Quick stream availability checker
  async checkStreamAvailability() {
    return new Promise((resolve) => {
      const url = new URL(this.streamUrl);
      const client = url.protocol === "https:" ? https : http;

      const timeout = setTimeout(() => {
        resolve(false);
      }, 3000); // 3 second timeout

      const req = client.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname + url.search,
          method: "HEAD", // Just check headers, don't download content
          timeout: 3000,
        },
        (res) => {
          clearTimeout(timeout);
          const isAvailable = res.statusCode === 200 || res.statusCode === 206;
          resolve(isAvailable);
        }
      );

      req.on("error", () => {
        clearTimeout(timeout);
        resolve(false);
      });

      req.on("timeout", () => {
        clearTimeout(timeout);
        req.destroy();
        resolve(false);
      });

      req.end();
    });
  }

  // Advanced stream monitor with multiple strategies
  async startStreamMonitoring() {
    if (this.isMonitoring) return;

    this.isMonitoring = true;
    console.log("Starting stream availability monitoring...");

    // Strategy 1: Quick checks every 2 seconds when stream is down
    this.quickCheckInterval = setInterval(async () => {
      if (this.isRecording) return; // Don't check while recording

      const isAvailable = await this.checkStreamAvailability();
      const wasAvailable = this.isStreamAvailable;
      this.isStreamAvailable = isAvailable;

      if (isAvailable) {
        this.consecutiveFailures = 0;
        this.lastSuccessfulCheck = Date.now();

        // Stream just came back online!
        if (!wasAvailable) {
          console.log("🟢 Stream is back online! Resuming recording...");
          this.resumeRecording();
        }
      } else {
        this.consecutiveFailures++;
        if (wasAvailable) {
          console.log("🔴 Stream went offline, waiting for it to return...");
        }
      }
    }, 2000); // Check every 2 seconds

    // Strategy 2: Continuous connection monitoring (for faster detection)
    this.startContinuousMonitoring();
  }

  // Continuous monitoring using a persistent connection attempt
  startContinuousMonitoring() {
    if (!this.isMonitoring || this.isRecording) return;

    // Use ffprobe to continuously monitor stream
    const probeProcess = spawn("ffprobe", [
      "-v",
      "quiet",
      "-print_format",
      "json",
      "-show_streams",
      "-timeout",
      "5000000", // 5 second timeout
      this.streamUrl,
    ]);

    probeProcess.on("close", (code) => {
      if (code === 0 && !this.isStreamAvailable) {
        // ffprobe succeeded, stream might be back
        console.log("📡 ffprobe detected stream activity, verifying...");
        this.checkStreamAvailability().then((isAvailable) => {
          if (isAvailable && !this.isRecording) {
            console.log(
              "🟢 Stream confirmed online via ffprobe! Resuming recording..."
            );
            this.isStreamAvailable = true;
            this.resumeRecording();
          }
        });
      }

      // Restart continuous monitoring if we're still monitoring and not recording
      setTimeout(() => {
        if (this.isMonitoring && !this.isRecording) {
          this.startContinuousMonitoring();
        }
      }, 1000);
    });

    probeProcess.on("error", () => {
      // Restart monitoring after a short delay
      setTimeout(() => {
        if (this.isMonitoring && !this.isRecording) {
          this.startContinuousMonitoring();
        }
      }, 2000);
    });
  }

  stopStreamMonitoring() {
    this.isMonitoring = false;
    if (this.quickCheckInterval) {
      clearInterval(this.quickCheckInterval);
      this.quickCheckInterval = null;
    }
    console.log("Stream monitoring stopped");
  }

  async startRecording(durationMinutes, finalOutputName = null) {
    this.totalDurationMs = durationMinutes * 60 * 1000;
    this.recordedDurationMs = 0;
    this.recordings = [];
    this.startTime = Date.now();

    const finalOutput = finalOutputName || `recording_${this.sessionId}.mp4`;

    console.log(`Starting recording session for ${durationMinutes} minutes`);
    console.log(`Final output will be: ${finalOutput}`);

    // Initial stream check
    const isInitiallyAvailable = await this.checkStreamAvailability();
    this.isStreamAvailable = isInitiallyAvailable;

    if (isInitiallyAvailable) {
      await this.recordSegment();
    } else {
      console.log("Stream not initially available, starting monitoring...");
      this.startStreamMonitoring();
    }

    // Wait for recording to complete
    return new Promise((resolve, reject) => {
      const checkCompletion = () => {
        if (
          this.recordedDurationMs >= this.totalDurationMs &&
          !this.isRecording
        ) {
          this.stopStreamMonitoring();
          this.mergeRecordings(finalOutput)
            .then(() => resolve(finalOutput))
            .catch(reject);
        } else {
          setTimeout(checkCompletion, 1000);
        }
      };
      checkCompletion();
    });
  }

  async resumeRecording() {
    if (this.isRecording) return; // Already recording
    if (this.recordedDurationMs >= this.totalDurationMs) return; // Already complete

    console.log("Resuming recording...");
    this.stopStreamMonitoring(); // Stop monitoring while recording
    await this.recordSegment();
  }

  async recordSegment() {
    if (this.recordedDurationMs >= this.totalDurationMs) {
      console.log("Recording complete!");
      return;
    }

    const remainingMs = this.totalDurationMs - this.recordedDurationMs;
    const segmentIndex = this.recordings.length;
    const segmentFile = path.join(
      this.outputDir,
      `segment_${this.sessionId}_${segmentIndex}.mp4`
    );

    console.log(
      `Starting segment ${segmentIndex}, remaining duration: ${Math.ceil(
        remainingMs / 1000
      )}s`
    );

    this.isRecording = true;
    const segmentStartTime = Date.now();

    return new Promise((resolve) => {
      // FFmpeg command with better error detection
      const ffmpegArgs = [
        "-i",
        this.streamUrl,
        "-c",
        "copy",
        "-avoid_negative_ts",
        "make_zero",
        "-fflags",
        "+genpts",
        "-reconnect",
        "1", // Enable reconnection
        "-reconnect_at_eof",
        "1", // Reconnect at EOF
        "-reconnect_streamed",
        "1", // Reconnect for streamed content
        "-reconnect_delay_max",
        "2", // Max 2 seconds between reconnects
        "-t",
        Math.ceil(remainingMs / 1000).toString(),
        "-y",
        segmentFile,
      ];

      console.log(`FFmpeg command: ffmpeg ${ffmpegArgs.join(" ")}`);

      this.currentProcess = spawn("ffmpeg", ffmpegArgs);

      let stderr = "";
      let lastProgressTime = Date.now();

      this.currentProcess.stderr.on("data", (data) => {
        stderr += data.toString();
        const dataStr = data.toString();

        // Enhanced progress tracking
        if (dataStr.includes("time=")) {
          lastProgressTime = Date.now();
          const timeMatch = dataStr.match(/time=(\d{2}):(\d{2}):(\d{2})/);
          if (timeMatch) {
            const [, hours, minutes, seconds] = timeMatch;
            const currentDuration =
              (parseInt(hours) * 3600 +
                parseInt(minutes) * 60 +
                parseInt(seconds)) *
              1000;
            console.log(
              `Segment ${segmentIndex} progress: ${Math.floor(
                currentDuration / 1000
              )}s`
            );
          }
        }

        // Detect specific errors that indicate stream issues
        if (
          dataStr.includes("403") ||
          dataStr.includes("Connection refused") ||
          dataStr.includes("Server returned 4") ||
          dataStr.includes("HTTP error 403")
        ) {
          console.log("🔴 Detected stream access error (403/connection issue)");
        }
      });

      this.currentProcess.on("close", (code) => {
        this.isRecording = false;
        const segmentDuration = Date.now() - segmentStartTime;

        console.log(
          `Segment ${segmentIndex} ended with code ${code}, duration: ${Math.floor(
            segmentDuration / 1000
          )}s`
        );

        if (code === 0 && fs.existsSync(segmentFile)) {
          // Successful recording
          this.recordings.push({
            file: segmentFile,
            duration: segmentDuration,
            index: segmentIndex,
          });
          this.recordedDurationMs += segmentDuration;
          console.log(`✅ Segment ${segmentIndex} completed successfully`);

          // Continue recording if more time needed
          if (this.recordedDurationMs < this.totalDurationMs) {
            setTimeout(() => this.recordSegment().then(resolve), 100);
          } else {
            resolve();
          }
        } else {
          // Recording failed
          console.log(
            `❌ Segment ${segmentIndex} failed. Starting stream monitoring...`
          );

          // Clean up failed file
          if (fs.existsSync(segmentFile)) {
            fs.unlinkSync(segmentFile);
          }

          // Start monitoring for stream return
          this.isStreamAvailable = false;
          this.startStreamMonitoring();
          resolve();
        }
      });

      this.currentProcess.on("error", (error) => {
        console.error(`FFmpeg error:`, error);
        this.isRecording = false;

        // Start monitoring for stream return
        this.isStreamAvailable = false;
        this.startStreamMonitoring();
        resolve();
      });
    });
  }

  async mergeRecordings(finalOutputName) {
    if (this.recordings.length === 0) {
      throw new Error("No recordings to merge");
    }

    if (this.recordings.length === 1) {
      const finalPath = path.join(this.outputDir, finalOutputName);
      fs.renameSync(this.recordings[0].file, finalPath);
      console.log(`Single segment recording moved to: ${finalPath}`);
      return finalPath;
    }

    const finalPath = path.join(this.outputDir, finalOutputName);
    const concatFile = path.join(
      this.outputDir,
      `concat_${this.sessionId}.txt`
    );

    const concatContent = this.recordings
      .sort((a, b) => a.index - b.index)
      .map((recording) => `file '${path.resolve(recording.file)}'`)
      .join("\n");

    fs.writeFileSync(concatFile, concatContent);

    console.log(
      `Merging ${this.recordings.length} segments into: ${finalOutputName}`
    );

    return new Promise((resolve, reject) => {
      const mergeArgs = [
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        concatFile,
        "-c",
        "copy",
        "-y",
        finalPath,
      ];

      const mergeProcess = spawn("ffmpeg", mergeArgs);

      mergeProcess.on("close", (code) => {
        fs.unlinkSync(concatFile);
        this.recordings.forEach((recording) => {
          if (fs.existsSync(recording.file)) {
            fs.unlinkSync(recording.file);
          }
        });

        if (code === 0) {
          console.log(`🎉 Successfully merged recordings to: ${finalPath}`);
          resolve(finalPath);
        } else {
          reject(new Error(`Merge failed with code ${code}`));
        }
      });

      mergeProcess.on("error", reject);
    });
  }

  stop() {
    console.log("Stopping recorder...");
    this.stopStreamMonitoring();
    if (this.currentProcess) {
      this.currentProcess.kill("SIGTERM");
      this.isRecording = false;
    }
  }

  getStatus() {
    return {
      isRecording: this.isRecording,
      isMonitoring: this.isMonitoring,
      isStreamAvailable: this.isStreamAvailable,
      recordedDuration: Math.floor(this.recordedDurationMs / 1000),
      totalDuration: Math.floor(this.totalDurationMs / 1000),
      progress: Math.floor(
        (this.recordedDurationMs / this.totalDurationMs) * 100
      ),
      segmentsRecorded: this.recordings.length,
      consecutiveFailures: this.consecutiveFailures,
    };
  }
}

// Usage example with enhanced monitoring
async function main() {
  const streamUrl =
    "https://real.rocketdns.info/ts_cdn/superreal1/superreal1/721023";
  const recorder = new ResilientStreamRecorder(streamUrl, "./recordings");

  // Enhanced status monitoring
  const statusInterval = setInterval(() => {
    const status = recorder.getStatus();
    const statusIcon = status.isRecording
      ? "🔴"
      : status.isMonitoring
      ? "👁️"
      : "⭕";
    const streamIcon = status.isStreamAvailable ? "🟢" : "🔴";

    console.log(
      `${statusIcon} Recording: ${status.progress}% | ${streamIcon} Stream: ${
        status.isStreamAvailable ? "Online" : "Offline"
      } | Segments: ${status.segmentsRecorded}`
    );

    if (!status.isRecording && !status.isMonitoring && status.progress >= 100) {
      clearInterval(statusInterval);
    }
  }, 5000);

  try {
    const finalFile = await recorder.startRecording(
      2,
      "my_stream_recording.mp4"
    );
    console.log(`🎉 Recording completed: ${finalFile}`);
    clearInterval(statusInterval);
  } catch (error) {
    console.error("❌ Recording failed:", error);
    clearInterval(statusInterval);
  }
}

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\n⏹️ Shutting down recorder...");
  process.exit(0);
});

module.exports = ResilientStreamRecorder;

// Uncomment to run
main();
