// ChimeWorks (32-Bit Edition) — Musical Web Audio Synthesis & Offline Renderer
// Upgrades: 16th-note groove quantization, 4-bar chord progression engine, warm
// kalimba/sub-bass/acoustic-perc voices, duplicate-slot anti-stacking, and
// procedural stereo studio reverb (zero external audio files).

const BASE_BPM = 112;
const BASE_MIDI = 48; // C3
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// 4-bar chord progressions per scale mode (each bar provides a 15-note consonant melodic ladder + bass root)
const PROGRESSIONS = [
  // 0: Pentatonic — Cmaj9 -> Am9 -> Fmaj9 -> G6
  [
    { name: 'Cmaj9', bass: [0, 7, 12, 4],  mel: [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24, 26, 28, 31, 33] },
    { name: 'Am9',   bass: [-3, 4, 9, 0],  mel: [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24, 26, 28, 31, 33] },
    { name: 'Fmaj9', bass: [-7, 0, 5, -3], mel: [0, 2, 5, 7, 9, 12, 14, 17, 19, 21, 24, 26, 29, 31, 33] },
    { name: 'G6',    bass: [-5, 2, 7, -1], mel: [2, 4, 7, 9, 11, 14, 16, 19, 21, 23, 26, 28, 31, 33, 35] },
  ],
  // 1: Lydian — Cmaj7#11 -> D/C -> Bm7 -> Em9
  [
    { name: 'Cmaj7#11', bass: [0, 7, 12, 6],  mel: [0, 2, 4, 6, 7, 11, 12, 14, 16, 18, 19, 23, 24, 26, 28] },
    { name: 'D/C',      bass: [0, 2, 9, 6],   mel: [2, 4, 6, 9, 11, 14, 16, 18, 21, 23, 26, 28, 30, 33, 35] },
    { name: 'Bm7',      bass: [-1, 6, 11, 2], mel: [2, 4, 6, 9, 11, 14, 16, 18, 21, 23, 26, 28, 30, 33, 35] },
    { name: 'Em9',      bass: [4, 11, 16, 7], mel: [0, 2, 4, 7, 11, 12, 14, 16, 19, 23, 24, 26, 28, 31, 35] },
  ],
];

function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/**
 * Helper for canvas.js to display the musical note name for a given Y coordinate (16..144).
 */
export function getNoteNameForY(y, scaleIdx = 0) {
  const norm = 1 - Math.max(0, Math.min(1, (y - 16) / 128));
  const idx = Math.max(0, Math.min(14, Math.round(norm * 14)));
  const prog = PROGRESSIONS[scaleIdx % PROGRESSIONS.length][0];
  const midi = BASE_MIDI + 12 + prog.mel[idx];
  const octave = Math.floor(midi / 12) - 1;
  return `${NOTE_NAMES[midi % 12]}${octave}`;
}

function createPeriodicWaves(ctx) {
  // Warm celesta / glass chime (soft upper partials, zero harsh aliasing)
  const chimeReal = new Float32Array([0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const chimeImag = new Float32Array([0, 1.0, 0.16, 0.28, 0.05, 0.12, 0.03, 0.06, 0.02]);

  // Woody kalimba / marimba fundamental + warm 4th harmonic
  const marimbaReal = new Float32Array([0, 0, 0, 0, 0, 0]);
  const marimbaImag = new Float32Array([0, 1.0, 0.12, 0.05, 0.22, 0.02]);

  // Lush analog-leaning bass wavetable
  const bassReal = new Float32Array([0, 0, 0, 0, 0, 0, 0]);
  const bassImag = new Float32Array([0, 1.0, 0.52, 0.22, 0.11, 0.05, 0.02]);

  return {
    chime: ctx.createPeriodicWave(chimeReal, chimeImag, { disableNormalization: false }),
    marimba: ctx.createPeriodicWave(marimbaReal, marimbaImag, { disableNormalization: false }),
    fmBass: ctx.createPeriodicWave(bassReal, bassImag, { disableNormalization: false }),
  };
}

function createNoiseBuffers(ctx) {
  const sr = ctx.sampleRate;

  // Deterministic PRNG for bit-consistent PCM buffers & reverb IR
  let seed = 0x51a7c3d1;
  const rand = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return ((seed >>> 0) / 0xffffffff) * 2 - 1;
  };

  // 30ms first-tap unlock noise click
  const clickLen = Math.max(1, Math.floor(sr * 0.03));
  const clickBuf = ctx.createBuffer(1, clickLen, sr);
  const cd = clickBuf.getChannelData(0);
  for (let i = 0; i < clickLen; i++) {
    cd[i] = rand() * Math.pow(1 - i / clickLen, 2.2);
  }

  // 80ms vinyl needle drop thump + warm crackle
  const needleLen = Math.max(1, Math.floor(sr * 0.08));
  const needleBuf = ctx.createBuffer(1, needleLen, sr);
  const nd = needleBuf.getChannelData(0);
  for (let i = 0; i < needleLen; i++) {
    const t = i / sr;
    const thump = Math.sin(2 * Math.PI * (95 - t * 480) * t) * Math.exp(-t * 48);
    const crackle = (Math.abs(rand()) > 0.88 ? rand() * 0.65 : rand() * 0.16) * Math.exp(-t * 22);
    nd[i] = thump * 0.75 + crackle * 0.48;
  }

  // 110ms soft brushed percussion noise
  const percLen = Math.max(1, Math.floor(sr * 0.11));
  const percBuf = ctx.createBuffer(1, percLen, sr);
  const pd = percBuf.getChannelData(0);
  for (let i = 0; i < percLen; i++) {
    pd[i] = rand() * Math.pow(1 - i / percLen, 2.6);
  }

  // 1.4s warm procedural stereo studio reverb impulse response (one-pole damped)
  const revLen = Math.floor(sr * 1.4);
  const reverbBuf = ctx.createBuffer(2, revLen, sr);
  for (let ch = 0; ch < 2; ch++) {
    const data = reverbBuf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < revLen; i++) {
      const t = i / revLen;
      const env = Math.pow(1 - t, 3.4) * (i < 400 ? i / 400 : 1);
      const white = rand();
      lp = lp * 0.72 + white * 0.28; // warm room damping
      data[i] = lp * env * 0.65;
    }
  }

  return { clickBuf, needleBuf, percBuf, reverbBuf };
}

function buildMasterBus(ctx, reverbBuf, withAnalyser) {
  const masterGain = ctx.createGain();
  masterGain.gain.value = 0.78;

  // Warm master high-shelf rolloff so chimes stay silky
  const masterTone = ctx.createBiquadFilter();
  masterTone.type = 'lowpass';
  masterTone.frequency.value = 11500;
  masterTone.Q.value = 0.5;

  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -12;
  comp.knee.value = 16;
  comp.ratio.value = 3.5;
  comp.attack.value = 0.005;
  comp.release.value = 0.14;

  // Shared dotted-8th DelayNode + BiquadFilterNode bus
  const delayIn = ctx.createGain();
  delayIn.gain.value = 0.26;

  const delay = ctx.createDelay(1.0);
  delay.delayTime.value = (60 / BASE_BPM) * 0.75; // musical dotted 8th

  const delayFilter = ctx.createBiquadFilter();
  delayFilter.type = 'lowpass';
  delayFilter.frequency.value = 2100;
  delayFilter.Q.value = 0.7;

  const delayFeedback = ctx.createGain();
  delayFeedback.gain.value = 0.30;

  delayIn.connect(delay);
  delay.connect(delayFilter);
  delayFilter.connect(delayFeedback);
  delayFeedback.connect(delay);
  delayFilter.connect(masterGain);

  // Shared procedural stereo ConvolverNode reverb bus
  const reverbIn = ctx.createGain();
  reverbIn.gain.value = 0.28;
  const convolver = ctx.createConvolver();
  convolver.buffer = reverbBuf;
  reverbIn.connect(convolver);
  convolver.connect(masterGain);

  masterGain.connect(masterTone);
  masterTone.connect(comp);

  let analyser = null;
  if (withAnalyser) {
    analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.68;
    comp.connect(analyser);
    analyser.connect(ctx.destination);
  } else {
    comp.connect(ctx.destination);
  }

  return { masterGain, delayIn, delay, reverbIn, analyser };
}

function quantizeTime(rawTime, tempoMul) {
  const bpm = BASE_BPM * tempoMul;
  const stepSec = 60 / (bpm * 4); // 16th-note grid
  const stepIndex = Math.ceil((rawTime + 0.004) / stepSec);
  // Subtle musical swing (+12% on odd 16th-notes)
  const swing = (stepIndex & 1) === 1 ? stepSec * 0.12 : 0;
  const when = stepIndex * stepSec + swing;
  const chordIdx = Math.floor(stepIndex / 16) % 4; // 1 chord per 16-step bar
  return { when, stepIndex, chordIdx };
}

function scheduleVoice(ctx, bus, waves, buffers, ev, scaleIdx, when, chordIdx, unlocked) {
  const prog = PROGRESSIONS[scaleIdx % PROGRESSIONS.length];
  const chord = prog[chordIdx % prog.length];
  const pitchIdx = Math.abs(Math.floor(ev.pitch)) % 15;
  const vel = Math.max(0.2, Math.min(1.0, ev.vel || 0.7));
  const panVal = Math.max(-0.82, Math.min(0.82, (ev.xNorm * 2 - 1) * 0.78));

  const panner = ctx.createStereoPanner();
  panner.pan.setValueAtTime(panVal, when);
  panner.connect(bus.masterGain);

  // Route melodic voices generously into delay + studio reverb
  if (ev.layer === 2) {
    const dSend = ctx.createGain();
    dSend.gain.setValueAtTime(0.36, when);
    panner.connect(dSend).connect(bus.delayIn);

    const rSend = ctx.createGain();
    rSend.gain.setValueAtTime(0.42, when);
    panner.connect(rSend).connect(bus.reverbIn);
  } else if (ev.layer === 1) {
    const rSend = ctx.createGain();
    rSend.gain.setValueAtTime(0.14, when);
    panner.connect(rSend).connect(bus.reverbIn);
  } else {
    const rSend = ctx.createGain();
    rSend.gain.setValueAtTime(0.10, when);
    panner.connect(rSend).connect(bus.reverbIn);
  }

  if (ev.kind === 2) {
    // Teleporter soft harmonic shimmer (tuned to current chord root + octave)
    const freq = midiToFreq(BASE_MIDI + 24 + chord.bass[0]);
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, when);
    osc.frequency.exponentialRampToValueAtTime(freq * 1.5, when + 0.08);
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(0.045 * vel, when + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.12);
    osc.connect(g).connect(panner);
    osc.start(when);
    osc.stop(when + 0.13);
    return;
  }

  if (ev.layer === 0) {
    // BASS LAYER: Warm sub-sine + filtered harmonic body following the 4-bar chord root
    const bassSemi = chord.bass[pitchIdx % chord.bass.length];
    const freq = midiToFreq(BASE_MIDI - 12 + bassSemi);

    // Pure sub foundation
    const sub = ctx.createOscillator();
    const subG = ctx.createGain();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(freq, when);
    subG.gain.setValueAtTime(0.0001, when);
    subG.gain.linearRampToValueAtTime(0.24 * vel, when + 0.012);
    subG.gain.exponentialRampToValueAtTime(0.0001, when + 0.58);
    sub.connect(subG).connect(panner);
    sub.start(when);
    sub.stop(when + 0.6);

    // Warm overtone body
    const body = ctx.createOscillator();
    const lp = ctx.createBiquadFilter();
    const bodyG = ctx.createGain();
    body.setPeriodicWave(unlocked.fmBass ? waves.fmBass : waves.marimba);
    body.frequency.setValueAtTime(freq, when);

    if (unlocked.fmBass) {
      const mod = ctx.createOscillator();
      const modG = ctx.createGain();
      mod.type = 'sine';
      mod.frequency.setValueAtTime(freq * 2, when);
      modG.gain.setValueAtTime(freq * 0.75 * vel, when);
      modG.gain.exponentialRampToValueAtTime(0.01, when + 0.18);
      mod.connect(modG).connect(body.frequency);
      mod.start(when);
      mod.stop(when + 0.45);
    }

    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(unlocked.fmBass ? 680 : 420, when);
    lp.frequency.exponentialRampToValueAtTime(140, when + 0.36);

    bodyG.gain.setValueAtTime(0.0001, when);
    bodyG.gain.linearRampToValueAtTime(0.18 * vel, when + 0.01);
    bodyG.gain.exponentialRampToValueAtTime(0.0001, when + 0.48);

    body.connect(lp).connect(bodyG).connect(panner);
    body.start(when);
    body.stop(when + 0.5);
  } else if (ev.layer === 1 || ev.kind === 1) {
    // PERC LAYER: 4-piece acoustic-electronic kit (Kick, Woodblock, Brushed Snare, Soft Shaker)
    const drumType = pitchIdx % 4;

    if (drumType === 0) {
      // Warm punchy kick
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(132, when);
      osc.frequency.exponentialRampToValueAtTime(46, when + 0.09);
      g.gain.setValueAtTime(0.0001, when);
      g.gain.linearRampToValueAtTime(0.32 * vel, when + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, when + 0.18);
      osc.connect(g).connect(panner);
      osc.start(when);
      osc.stop(when + 0.2);
    } else if (drumType === 1) {
      // Tuned wooden rim / clave
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'triangle';
      const tone = unlocked.percussion ? 680 + (pitchIdx % 3) * 110 : 540;
      osc.frequency.setValueAtTime(tone * 1.15, when);
      osc.frequency.exponentialRampToValueAtTime(tone, when + 0.025);
      g.gain.setValueAtTime(0.0001, when);
      g.gain.linearRampToValueAtTime(0.18 * vel, when + 0.003);
      g.gain.exponentialRampToValueAtTime(0.0001, when + 0.075);
      osc.connect(g).connect(panner);
      osc.start(when);
      osc.stop(when + 0.085);
    } else if (drumType === 2) {
      // Soft brushed snare
      const src = ctx.createBufferSource();
      src.buffer = buffers.percBuf;
      const hp = ctx.createBiquadFilter();
      hp.type = 'bandpass';
      hp.frequency.setValueAtTime(unlocked.percussion ? 2200 : 1700, when);
      hp.Q.setValueAtTime(0.9, when);
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(0.0001, when);
      ng.gain.linearRampToValueAtTime(0.18 * vel, when + 0.004);
      ng.gain.exponentialRampToValueAtTime(0.0001, when + 0.10);
      src.connect(hp).connect(ng).connect(panner);
      src.start(when);
      src.stop(when + 0.11);

      const body = ctx.createOscillator();
      const bg = ctx.createGain();
      body.type = 'triangle';
      body.frequency.setValueAtTime(215, when);
      body.frequency.exponentialRampToValueAtTime(125, when + 0.06);
      bg.gain.setValueAtTime(0.12 * vel, when);
      bg.gain.exponentialRampToValueAtTime(0.0001, when + 0.08);
      body.connect(bg).connect(panner);
      body.start(when);
      body.stop(when + 0.09);
    } else {
      // Crisp soft shaker / closed hi-hat
      const src = ctx.createBufferSource();
      src.buffer = buffers.percBuf;
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.setValueAtTime(6800, when);
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(0.0001, when);
      ng.gain.linearRampToValueAtTime(0.11 * vel, when + 0.003);
      ng.gain.exponentialRampToValueAtTime(0.0001, when + 0.045);
      src.connect(hp).connect(ng).connect(panner);
      src.start(when);
      src.stop(when + 0.055);
    }
  } else {
    // MEL LAYER: Warm kalimba / celesta locked to current 4-bar chord voicing
    const semi = chord.mel[pitchIdx];
    const freq = midiToFreq(BASE_MIDI + 12 + semi);

    const osc = ctx.createOscillator();
    const lp = ctx.createBiquadFilter();
    const g = ctx.createGain();

    if (unlocked.marimba && pitchIdx % 2 === 0) {
      osc.setPeriodicWave(waves.marimba);
    } else if (unlocked.chimes) {
      osc.setPeriodicWave(waves.chime);
    } else {
      osc.type = 'sine';
    }

    osc.frequency.setValueAtTime(freq, when);

    // Gentle low-pass pluck envelope removes digital harshness
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(Math.min(5200, freq * 5), when);
    lp.frequency.exponentialRampToValueAtTime(Math.max(700, freq * 1.4), when + 0.45);

    const decay = unlocked.chimes ? 0.72 : 0.48;
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(0.16 * vel, when + 0.006); // soft 6ms attack
    g.gain.exponentialRampToValueAtTime(0.0001, when + decay);

    osc.connect(lp).connect(g).connect(panner);
    osc.start(when);
    osc.stop(when + decay + 0.04);
  }
}

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.bus = null;
    this.waves = null;
    this.buffers = null;
    this.muted = false;
    this.tempoMul = 1.0;
    this.oscData = new Uint8Array(128);
    this.recentSlots = new Map(); // prevents phase-stacking duplicate hits on the same quantized step
  }

  ensureContext() {
    if (this.ctx) return this.ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();
    this.waves = createPeriodicWaves(this.ctx);
    this.buffers = createNoiseBuffers(this.ctx);
    this.bus = buildMasterBus(this.ctx, this.buffers.reverbBuf, true);
    return this.ctx;
  }

  async unlock() {
    const ctx = this.ensureContext();
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }
    this.playUnlockClick();
  }

  playUnlockClick() {
    if (!this.ctx || !this.buffers) return;
    const now = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffers.clickBuf; // exact 30ms filtered white-noise click
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(1850, now);
    bp.Q.setValueAtTime(1.8, now);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.30, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.03);
    src.connect(bp).connect(g).connect(this.bus.masterGain);
    src.start(now);
    src.stop(now + 0.032);
  }

  playNeedleDropAndFifth() {
    if (!this.ctx || !this.buffers) return;
    const now = this.ctx.currentTime;

    // 80ms needle drop
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffers.needleBuf;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(3200, now);
    const ng = this.ctx.createGain();
    ng.gain.setValueAtTime(0.42, now);
    src.connect(lp).connect(ng).connect(this.bus.masterGain);
    src.start(now);
    src.stop(now + 0.082);

    // Fifth chime (C5 + G5)
    const freqs = [523.25, 783.99];
    freqs.forEach((f, idx) => {
      const t0 = now + 0.075 + idx * 0.02;
      const osc = this.ctx.createOscillator();
      osc.setPeriodicWave(this.waves.chime);
      osc.frequency.setValueAtTime(f, t0);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(0.16, t0 + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.78);
      osc.connect(g).connect(this.bus.masterGain);
      osc.start(t0);
      osc.stop(t0 + 0.8);
    });
  }

  setMuted(muted) {
    this.muted = muted;
    if (this.bus && this.ctx) {
      this.bus.masterGain.gain.setTargetAtTime(muted ? 0.0 : 0.78, this.ctx.currentTime, 0.015);
    }
  }

  setTempo(tempoMul) {
    this.tempoMul = tempoMul;
    if (this.bus && this.ctx) {
      const dotted8th = (60 / (BASE_BPM * tempoMul)) * 0.75;
      const dt = Math.max(0.14, Math.min(0.65, dotted8th));
      this.bus.delay.delayTime.setTargetAtTime(dt, this.ctx.currentTime, 0.03);
    }
  }

  getCurrentChordName(scaleIdx = 0) {
    if (!this.ctx) return PROGRESSIONS[scaleIdx % PROGRESSIONS.length][0].name;
    const { chordIdx } = quantizeTime(this.ctx.currentTime, this.tempoMul);
    return PROGRESSIONS[scaleIdx % PROGRESSIONS.length][chordIdx].name;
  }

  triggerEvents(eventsArr, scaleIdx, unlocked) {
    if (!this.ctx || this.ctx.state !== 'running' || this.muted) return;
    const now = this.ctx.currentTime;
    const { when, stepIndex, chordIdx } = quantizeTime(now, this.tempoMul);

    // Prune old anti-stacking keys occasionally
    if (this.recentSlots.size > 64) {
      for (const [k, s] of this.recentSlots.entries()) {
        if (s < stepIndex - 2) this.recentSlots.delete(k);
      }
    }

    const stride = 7;
    const count = Math.floor(eventsArr.length / stride);
    for (let i = 0; i < count; i++) {
      const b = i * stride;
      const ev = {
        tick: eventsArr[b],
        layer: Math.round(eventsArr[b + 1]),
        kind: Math.round(eventsArr[b + 2]),
        partIdx: Math.round(eventsArr[b + 3]),
        pitch: Math.round(eventsArr[b + 4]),
        xNorm: eventsArr[b + 5],
        vel: eventsArr[b + 6],
      };

      const dedupKey = `${ev.layer}:${ev.pitch}:${stepIndex}`;
      if (this.recentSlots.has(dedupKey)) continue;
      this.recentSlots.set(dedupKey, stepIndex);

      scheduleVoice(this.ctx, this.bus, this.waves, this.buffers, ev, scaleIdx, when, chordIdx, unlocked);
    }
  }

  getOscilloscopeData() {
    if (!this.bus || !this.bus.analyser) {
      this.oscData.fill(128);
      return this.oscData;
    }
    this.bus.analyser.getByteTimeDomainData(this.oscData);
    return this.oscData;
  }

  async renderOfflineLoop(eventsArr, totalTicks, scaleIdx, tempoMul, unlocked) {
    const sampleRate = 44100;
    const loopSec = (totalTicks / 60) / tempoMul;
    const renderLoops = 2; // 2 seamless loops + reverb tail
    const totalSec = loopSec * renderLoops + 1.4;
    const totalFrames = Math.ceil(sampleRate * totalSec);

    const offline = new OfflineAudioContext(2, totalFrames, sampleRate);
    const waves = createPeriodicWaves(offline);
    const buffers = createNoiseBuffers(offline);
    const bus = buildMasterBus(offline, buffers.reverbBuf, false);
    const dotted8th = (60 / (BASE_BPM * tempoMul)) * 0.75;
    bus.delay.delayTime.value = Math.max(0.14, Math.min(0.65, dotted8th));

    const stride = 7;
    const count = Math.floor(eventsArr.length / stride);
    const seen = new Set();

    for (let rep = 0; rep < renderLoops; rep++) {
      const offsetSec = rep * loopSec;
      for (let i = 0; i < count; i++) {
        const b = i * stride;
        const ev = {
          tick: eventsArr[b],
          layer: Math.round(eventsArr[b + 1]),
          kind: Math.round(eventsArr[b + 2]),
          partIdx: Math.round(eventsArr[b + 3]),
          pitch: Math.round(eventsArr[b + 4]),
          xNorm: eventsArr[b + 5],
          vel: eventsArr[b + 6],
        };
        const rawWhen = offsetSec + (ev.tick / 60) / tempoMul + 0.02;
        const { when, stepIndex, chordIdx } = quantizeTime(rawWhen, tempoMul);
        const key = `${ev.layer}:${ev.pitch}:${stepIndex}`;
        if (seen.has(key)) continue;
        seen.add(key);

        if (when < totalSec - 0.2) {
          scheduleVoice(offline, bus, waves, buffers, ev, scaleIdx, when, chordIdx, unlocked);
        }
      }
    }

    const rendered = await offline.startRendering();
    const left = new Float32Array(rendered.getChannelData(0));
    const right = new Float32Array(rendered.getChannelData(1));
    return { left, right, sampleRate };
  }
}
