// ChimeWorks (32-Bit Edition) — WASM Physics, Trajectory-Aware MAP-Elites & Off-Thread MP3 Worker
// Upgrades: Live trajectory streaming on every edit, trajectory-aware mutation (snaps bells/bumpers
// directly onto traced droplet paths with spatial pitch tuning), live-config preservation across
// background rollouts, and off-thread 128 kbps MP3 encoding via lame.min.js.
/* global importScripts, lamejs */

const LAYER_KEYS = ['b', 'p', 'm'];
const EMITTER_STRIDE = 8;
const PART_STRIDE = 9;
const DROPLET_STRIDE = 8;
const MAX_DROPLETS = 48;
const EVENT_STRIDE = 7;
const KF_LEN = 64 * 49;
const BARCODE_LEN = 16;
const METRICS_LEN = 8;

// Trajectory layout matching wasm/physics.rs (3 layers * (1 count + 90 * 2 coords))
const TRAJ_MAX_PTS = 90;
const TRAJ_LAYER_STRIDE = 1 + TRAJ_MAX_PTS * 2; // 181
const TRAJ_TOTAL_LEN = 3 * TRAJ_LAYER_STRIDE;   // 543

// Musical emitter tick intervals (clean rhythmic ratios at 60 Hz)
const LAYER_RATES = [
  [36, 48, 60, 72, 96], // BASS: slow harmonic anchors
  [18, 24, 30, 36, 48], // PERC: steady pulse & syncopation
  [16, 20, 24, 32, 40], // MEL: flowing arpeggios & chimes
];

let wasm = null;
let lameLoaded = false;
let rngState = 0x1337c0de;

// Keep a copy of the currently soloed live chamber so background rollouts never hijack live playback
let liveConfig = null;

function rand() {
  rngState ^= rngState << 13;
  rngState ^= rngState >>> 17;
  rngState ^= rngState << 5;
  return (rngState >>> 0) / 0xffffffff;
}

function randInt(lo, hi) {
  return lo + Math.floor(rand() * (hi - lo + 1));
}

function clampInt(v, lo, hi) {
  return Math.max(lo, Math.min(hi, Math.round(v)));
}

function cloneGenome(g) {
  return JSON.parse(JSON.stringify(g));
}

function writeGenomeToWasm(genome, layerMuted = [false, false, false]) {
  wasm.clear_config();
  const mem = wasm.memory.buffer;
  const emitters = new Float32Array(mem, wasm.get_emitters_ptr(), 6 * EMITTER_STRIDE);
  const parts = new Float32Array(mem, wasm.get_parts_ptr(), 32 * PART_STRIDE);

  let partCursor = 0;

  for (let li = 0; li < 3; li++) {
    const lk = LAYER_KEYS[li];
    const layer = genome[lk];
    const e = layer.e;
    const eb = li * EMITTER_STRIDE;
    emitters[eb] = 1.0;
    emitters[eb + 1] = li;
    emitters[eb + 2] = e[0];
    emitters[eb + 3] = e[1];
    emitters[eb + 4] = (e[2] * Math.PI) / 180;
    emitters[eb + 5] = e[3];
    emitters[eb + 6] = Math.max(10, e[4]);
    emitters[eb + 7] = (layerMuted[li] || e[5] === 1) ? 1.0 : 0.0;

    for (let pi = 0; pi < layer.p.length && partCursor < 32; pi++) {
      const p = layer.p[pi];
      const pb = partCursor * PART_STRIDE;
      parts[pb] = 1.0;
      parts[pb + 1] = p[0]; // kind (0=ramp, 1=bumper, 2=teleporter, 3=bell)
      parts[pb + 2] = li;   // layer
      parts[pb + 3] = p[1]; // x
      parts[pb + 4] = p[2]; // y
      parts[pb + 5] = (p[3] * Math.PI) / 180; // angle
      parts[pb + 6] = p[4]; // size
      parts[pb + 7] = p[5]; // param (< 0 => spatial pitch from Y height)
      parts[pb + 8] = (layerMuted[li] || p[6] === 1) ? 1.0 : 0.0;
      partCursor++;
    }
  }
}

function restoreLiveConfig() {
  if (liveConfig && wasm) {
    writeGenomeToWasm(liveConfig.genome, liveConfig.layerMuted);
  }
}

function traceTrajectoriesCopy(ticks = 180) {
  wasm.trace_trajectories(ticks);
  const mem = wasm.memory.buffer;
  return new Float32Array(new Float32Array(mem, wasm.get_trajectory_ptr(), TRAJ_TOTAL_LEN));
}

function sampleTrajectoryPoint(traj, layerIdx, minFrac, maxFrac) {
  const base = layerIdx * TRAJ_LAYER_STRIDE;
  const count = Math.min(TRAJ_MAX_PTS, Math.floor(traj[base]));
  if (count < 4) return null;
  const lo = clampInt(count * minFrac, 2, count - 1);
  const hi = clampInt(count * maxFrac, lo, count - 1);
  const pick = randInt(lo, hi);
  const x = traj[base + 1 + pick * 2];
  const y = traj[base + 1 + pick * 2 + 1];
  return {
    x: clampInt(x, 18, 142),
    y: clampInt(y, 26, 142),
  };
}

/**
 * Trajectory-aware musical mutation:
 * 1. Adjusts musical rhythm subdivisions and emitter aim on unlocked layers.
 * 2. Traces the resulting physics paths in WASM.
 * 3. Snaps bells/bumpers directly onto valid trajectory points so every mutation plays real notes.
 */
function mutateGenomeTrajectoryAware(parent, locks, intensity = 1) {
  const g = cloneGenome(parent);
  if (rand() < 0.15) g.s = g.s === 0 ? 1 : 0;

  const lockArr = [!!locks.bass, !!locks.perc, !!locks.mel];

  // Pass 1: Mutate emitters & ramp angles on unlocked layers
  for (let li = 0; li < 3; li++) {
    if (lockArr[li]) continue;
    const lk = LAYER_KEYS[li];
    const layer = g[lk];

    if (rand() < 0.65) {
      layer.e[2] = clampInt(layer.e[2] + randInt(-20, 20) * intensity, 15, 165);
    }
    if (rand() < 0.45) {
      layer.e[3] = clampInt(layer.e[3] + randInt(-10, 10) * intensity, 40, 105);
    }
    if (rand() < 0.6) {
      const rates = LAYER_RATES[li];
      layer.e[4] = rates[randInt(0, rates.length - 1)];
    }

    for (let pi = 0; pi < layer.p.length; pi++) {
      const p = layer.p[pi];
      if (p[0] === 0 && rand() < 0.65) {
        p[3] = (p[3] + randInt(-24, 24) + 360) % 360;
      }
    }
  }

  // Pass 2: Trace the live droplet arcs for this candidate, then snap bells/bumpers onto the path
  writeGenomeToWasm(g, [false, false, false]);
  const traj = traceTrajectoriesCopy(180);

  for (let li = 0; li < 3; li++) {
    if (lockArr[li]) continue;
    const lk = LAYER_KEYS[li];
    const layer = g[lk];
    const nParts = layer.p.length;

    for (let pi = 0; pi < nParts; pi++) {
      const p = layer.p[pi];
      const kind = p[0];
      if (kind === 2) continue; // Keep teleporter pairs stable unless nudged gently

      if (rand() < 0.7) {
        // Partition trajectory into sequential windows so parts form a melodic cascade
        const winLo = 0.12 + (pi / Math.max(1, nParts)) * 0.68;
        const winHi = Math.min(0.92, winLo + 0.22);
        const pt = sampleTrajectoryPoint(traj, li, winLo, winHi);
        if (pt) {
          p[1] = clampInt(pt.x + randInt(-4, 4), 18, 142);
          p[2] = clampInt(pt.y + randInt(-3, 3), 28, 142);
        }
      }

      // Use spatial Y-height pitch (-1) so visual height always matches musical pitch
      if (kind === 3 || kind === 1) {
        p[5] = -1;
      }
    }

    // Occasionally evolve a part type (e.g. ramp <-> bell/bumper) while staying musical
    if (rand() < 0.22 && nParts > 0) {
      const idx = randInt(0, nParts - 1);
      if (layer.p[idx][0] !== 2) {
        const nextKind = li === 1 ? (rand() < 0.7 ? 1 : 3) : (rand() < 0.28 ? 0 : 3);
        layer.p[idx][0] = nextKind;
        layer.p[idx][4] = nextKind === 0 ? randInt(16, 22) : randInt(8, 10);
        layer.p[idx][5] = nextKind === 0 ? 0 : -1;
      }
    }
  }

  // Enforce strict <400-byte JSON genome budget
  while (JSON.stringify(g).length >= 400) {
    let trimmed = false;
    for (const lk of LAYER_KEYS) {
      if (g[lk].p.length > 2) {
        g[lk].p.pop();
        trimmed = true;
        break;
      }
    }
    if (!trimmed) break;
  }
  return g;
}

function scoreNiche(niche, m) {
  // m = [total, bass, perc, mel, unique_pitches, avg_ioi, ioi_var, bumper_hits]
  const [total, bass, perc, mel, uniq, avgIoi, ioiVar, bumpers] = m;
  if (total < 2) return -1e6;
  switch (niche) {
    case 0: // Sparse Ambient: spacious IOI, gentle density, melodic bells
      return (total >= 4 && total <= 14 ? 45 : -Math.abs(total - 9) * 3) + avgIoi * 1.1 + mel * 2.4 - perc * 0.6;
    case 1: // Fast Polyrhythmic: balanced multi-layer density & groove variance
      return total * 1.3 + Math.min(bass, perc, mel) * 7.5 + Math.sqrt(ioiVar) * 1.6 - avgIoi * 0.35;
    case 2: // Percussive: strong perc + bumper hits
      return perc * 4.5 + bumpers * 5.2 + bass * 1.5;
    case 3: // Melodic: richest melodic note count & pitch diversity
      return mel * 4.0 + uniq * 9.5 + bass * 1.5;
    default:
      return total;
  }
}

function runRolloutCopy(genome, layerMuted = [false, false, false], totalTicks = 240) {
  writeGenomeToWasm(genome, layerMuted);
  const eventCount = wasm.rollout(totalTicks, 4);
  const mem = wasm.memory.buffer;
  const keyframes = new Float32Array(new Float32Array(mem, wasm.get_keyframes_ptr(), KF_LEN));
  const barcode = new Float32Array(new Float32Array(mem, wasm.get_barcode_ptr(), BARCODE_LEN));
  const metrics = new Float32Array(new Float32Array(mem, wasm.get_metrics_ptr(), METRICS_LEN));
  return { eventCount, keyframes, barcode, metrics };
}

function ensureLameLoaded() {
  if (lameLoaded) return;
  try {
    importScripts('../vendor/lame.min.js');
    lameLoaded = true;
  } catch (_err) {
    importScripts('./vendor/lame.min.js');
    lameLoaded = true;
  }
}

function encodeMp3OffThread(leftF32, rightF32, sampleRate, bitrate) {
  ensureLameLoaded();
  const encoder = new lamejs.Mp3Encoder(2, sampleRate, bitrate || 128);
  const len = leftF32.length;
  const leftI16 = new Int16Array(len);
  const rightI16 = new Int16Array(len);

  for (let i = 0; i < len; i++) {
    const l = Math.max(-1, Math.min(1, leftF32[i]));
    const r = Math.max(-1, Math.min(1, rightF32[i]));
    leftI16[i] = l < 0 ? l * 0x8000 : l * 0x7fff;
    rightI16[i] = r < 0 ? r * 0x8000 : r * 0x7fff;
  }

  const chunkSize = 1152;
  const mp3Chunks = [];
  let totalBytes = 0;
  let lastPct = -1;

  for (let i = 0; i < len; i += chunkSize) {
    const lSlice = leftI16.subarray(i, Math.min(i + chunkSize, len));
    const rSlice = rightI16.subarray(i, Math.min(i + chunkSize, len));
    const buf = encoder.encodeBuffer(lSlice, rSlice);
    if (buf.length > 0) {
      const copy = new Uint8Array(buf);
      mp3Chunks.push(copy);
      totalBytes += copy.length;
    }
    const pct = Math.min(99, Math.floor((i / len) * 100));
    if (pct !== lastPct) {
      lastPct = pct;
      self.postMessage({ type: 'mp3Progress', progress: pct });
    }
  }

  const tail = encoder.flush();
  if (tail.length > 0) {
    const copy = new Uint8Array(tail);
    mp3Chunks.push(copy);
    totalBytes += copy.length;
  }

  const out = new Uint8Array(totalBytes);
  let offset = 0;
  for (const c of mp3Chunks) {
    out.set(c, offset);
    offset += c.length;
  }

  self.postMessage({ type: 'mp3Progress', progress: 100 });
  self.postMessage({ type: 'mp3Done', buffer: out.buffer }, [out.buffer]);
}

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'init') {
      const resp = await fetch(msg.wasmUrl);
      const bytes = await resp.arrayBuffer();
      const { instance } = await WebAssembly.instantiate(bytes, {});
      wasm = instance.exports;
      self.postMessage({ type: 'ready' });
      return;
    }

    if (msg.type === 'encodeMp3') {
      encodeMp3OffThread(msg.left, msg.right, msg.sampleRate || 44100, msg.bitrate || 128);
      return;
    }

    if (!wasm) return;

    if (msg.type === 'loadLive') {
      liveConfig = {
        genome: cloneGenome(msg.genome),
        layerMuted: msg.layerMuted || [false, false, false],
      };
      writeGenomeToWasm(liveConfig.genome, liveConfig.layerMuted);
      const trajectories = traceTrajectoriesCopy(180);
      self.postMessage({ type: 'trajectories', trajectories }, [trajectories.buffer]);
      return;
    }

    if (msg.type === 'traceLive') {
      const trajectories = traceTrajectoriesCopy(180);
      self.postMessage({ type: 'trajectories', trajectories }, [trajectories.buffer]);
      return;
    }

    if (msg.type === 'stepLive') {
      const evCount = wasm.step(msg.ticks || 1);
      const mem = wasm.memory.buffer;
      const droplets = new Float32Array(new Float32Array(mem, wasm.get_droplets_ptr(), MAX_DROPLETS * DROPLET_STRIDE));
      const events = new Float32Array(new Float32Array(mem, wasm.get_events_ptr(), evCount * EVENT_STRIDE));
      self.postMessage({ type: 'liveState', droplets, events }, [droplets.buffer, events.buffer]);
      return;
    }

    if (msg.type === 'rolloutChamber') {
      const res = runRolloutCopy(msg.genome, msg.layerMuted, 240);
      restoreLiveConfig();
      self.postMessage(
        {
          type: 'chamberRollout',
          slot: msg.slot,
          keyframes: res.keyframes,
          barcode: res.barcode,
          eventCount: res.eventCount,
        },
        [res.keyframes.buffer, res.barcode.buffer]
      );
      return;
    }

    if (msg.type === 'evolveOffspring') {
      rngState = (msg.seed >>> 0) || 0x1337c0de;
      const best = [null, null, null, null];
      const candidates = 20;

      for (let c = 0; c < candidates; c++) {
        const cand = mutateGenomeTrajectoryAware(msg.parentGenome, msg.locks, c < 10 ? 1 : 1.4);
        const res = runRolloutCopy(cand, [false, false, false], 240);
        for (let n = 0; n < 4; n++) {
          const sc = scoreNiche(n, res.metrics);
          if (!best[n] || sc > best[n].score) {
            best[n] = {
              niche: n,
              score: sc,
              genome: cand,
              keyframes: res.keyframes,
              barcode: res.barcode,
              metrics: res.metrics,
            };
          }
        }
      }

      restoreLiveConfig();

      const transfer = [];
      const seen = new Set();
      const offspring = best.map((item) => {
        let kf = item.keyframes;
        let bc = item.barcode;
        if (seen.has(kf.buffer)) kf = new Float32Array(kf);
        if (seen.has(bc.buffer)) bc = new Float32Array(bc);
        seen.add(kf.buffer);
        seen.add(bc.buffer);
        transfer.push(kf.buffer, bc.buffer);
        return { niche: item.niche, genome: item.genome, keyframes: kf, barcode: bc };
      });

      self.postMessage({ type: 'offspringReady', offspring }, transfer);
      return;
    }

    if (msg.type === 'renderEvents') {
      const ticks = msg.ticks || 240;
      writeGenomeToWasm(msg.genome, msg.layerMuted);
      const evCount = wasm.rollout(ticks, 4);
      const mem = wasm.memory.buffer;
      const events = new Float32Array(new Float32Array(mem, wasm.get_events_ptr(), evCount * EVENT_STRIDE));
      restoreLiveConfig();
      self.postMessage({ type: 'eventsReady', events, ticks }, [events.buffer]);
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err && err.message ? err.message : err) });
  }
};
