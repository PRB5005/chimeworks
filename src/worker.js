// ChimeWorks (32-Bit Edition) — WASM Physics, Speculative MAP-Elites & Off-Thread MP3 Worker
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

let wasm = null;
let lameLoaded = false;
let rngState = 0x1337c0de;

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
    emitters[eb + 6] = Math.max(8, e[4]);
    emitters[eb + 7] = (layerMuted[li] || e[5] === 1) ? 1.0 : 0.0;

    for (let pi = 0; pi < layer.p.length && partCursor < 32; pi++) {
      const p = layer.p[pi];
      const pb = partCursor * PART_STRIDE;
      parts[pb] = 1.0;
      parts[pb + 1] = p[0]; // kind
      parts[pb + 2] = li;   // layer
      parts[pb + 3] = p[1]; // x
      parts[pb + 4] = p[2]; // y
      parts[pb + 5] = (p[3] * Math.PI) / 180; // angle
      parts[pb + 6] = p[4]; // size
      parts[pb + 7] = p[5]; // param
      parts[pb + 8] = (layerMuted[li] || p[6] === 1) ? 1.0 : 0.0;
      partCursor++;
    }
  }
}

function mutateGenome(parent, locks, intensity = 1) {
  const g = cloneGenome(parent);
  if (rand() < 0.12) g.s = g.s === 0 ? 1 : 0;

  const lockArr = [!!locks.bass, !!locks.perc, !!locks.mel];

  for (let li = 0; li < 3; li++) {
    if (lockArr[li]) continue;
    const lk = LAYER_KEYS[li];
    const layer = g[lk];

    // Mutate emitter angle/rate/position
    if (rand() < 0.65) {
      layer.e[0] = clampInt(layer.e[0] + randInt(-16, 16) * intensity, 20, 140);
      layer.e[2] = (layer.e[2] + randInt(-28, 28) * intensity + 360) % 360;
    }
    if (rand() < 0.55) {
      const rates = li === 0 ? [30, 40, 48, 60, 72] : li === 1 ? [15, 20, 24, 30, 36] : [16, 20, 24, 32, 40];
      layer.e[4] = rates[randInt(0, rates.length - 1)];
    }

    // Mutate existing parts
    for (let pi = 0; pi < layer.p.length; pi++) {
      const p = layer.p[pi];
      if (rand() < 0.6) {
        p[1] = clampInt(p[1] + randInt(-18, 18) * intensity, 18, 142);
        p[2] = clampInt(p[2] + randInt(-16, 16) * intensity, 34, 142);
      }
      if (p[0] === 0 && rand() < 0.7) {
        p[3] = (p[3] + randInt(-30, 30) + 360) % 360;
      }
      if (p[0] === 3 && rand() < 0.65) {
        p[5] = randInt(0, 14);
      }
    }

    // Occasionally swap a part kind while keeping <400 byte genome budget
    if (rand() < 0.25 && layer.p.length > 0) {
      const idx = randInt(0, layer.p.length - 1);
      const kind = li === 1 ? (rand() < 0.6 ? 1 : 3) : (rand() < 0.45 ? 0 : 3);
      layer.p[idx][0] = kind;
      layer.p[idx][4] = kind === 0 ? randInt(16, 24) : randInt(8, 11);
      if (kind === 3) layer.p[idx][5] = randInt(0, 14);
    }
  }

  // Enforce strict <400-byte JSON genome limit
  while (JSON.stringify(g).length >= 400) {
    for (const lk of LAYER_KEYS) {
      if (g[lk].p.length > 2) {
        g[lk].p.pop();
        break;
      }
    }
  }
  return g;
}

function scoreNiche(niche, m) {
  // m = [total, bass, perc, mel, unique_pitches, avg_ioi, ioi_var, bumper_hits]
  const [total, bass, perc, mel, uniq, avgIoi, ioiVar, bumpers] = m;
  if (total < 1) return -1e6;
  switch (niche) {
    case 0: // Sparse Ambient: low-moderate density, wide IOI, melodic bells
      return (total >= 3 && total <= 14 ? 40 : -Math.abs(total - 8) * 3) + avgIoi * 0.9 + mel * 2.2 - perc * 0.8;
    case 1: // Fast Polyrhythmic: high density, multi-layer balance, rhythmic variance
      return total * 1.4 + Math.min(bass, perc, mel) * 6.0 + Math.sqrt(ioiVar) * 1.5 - avgIoi * 0.4;
    case 2: // Percussive: dominant perc + bumper impacts
      return perc * 4.5 + bumpers * 5.0 + total * 0.5;
    case 3: // Melodic: highest melodic note count & pitch diversity
      return mel * 3.8 + uniq * 9.0 + bass * 1.2;
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
      writeGenomeToWasm(msg.genome, msg.layerMuted);
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
      self.postMessage(
        { type: 'chamberRollout', slot: msg.slot, keyframes: res.keyframes, barcode: res.barcode, eventCount: res.eventCount },
        [res.keyframes.buffer, res.barcode.buffer]
      );
      return;
    }

    if (msg.type === 'evolveOffspring') {
      rngState = (msg.seed >>> 0) || 0x1337c0de;
      const best = [null, null, null, null];
      const candidates = 24;

      for (let c = 0; c < candidates; c++) {
        const cand = mutateGenome(msg.parentGenome, msg.locks, c < 12 ? 1 : 1.5);
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

      // Transfer unique buffers cleanly
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
      self.postMessage({ type: 'eventsReady', events, ticks }, [events.buffer]);
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err && err.message ? err.message : err) });
  }
};