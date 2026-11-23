// ChimeWorks (32-Bit Edition) — Procedural Web Audio Synthesis & Offline Renderer

const SCALES = [
  // 0: Pentatonic (C major / A minor pentatonic across 3 octaves)
  [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24, 26, 28, 31, 33],
  // 1: Lydian (C Lydian across 2+ octaves)
  [0, 2, 4, 6, 7, 9, 11, 12, 14, 16, 18, 19, 21, 23, 24],
];

const BASE_MIDI = 48; // C3

function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function createPeriodicWaves(ctx) {
  // Chime harmonic spectrum (inharmonic-leaning bell partials approximated cleanly)
  const chimeReal = new Float32Array([0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const chimeImag = new Float32Array([0, 1.0, 0.22, 0.42, 0.08, 0.25, 0.05, 0.14, 0.06]);

  // Marimba wooden fundamental + 4th harmonic
  const marimbaReal = new Float32Array([0, 0, 0, 0, 0, 0]);
  const marimbaImag = new Float32Array([0, 1.0, 0.06, 0.08, 0.34, 0.02]);

  // Warm FM-style bass wavetable
  const bassReal = new Float32Array([0, 0, 0, 0, 0, 0, 0]);
  const bassImag = new Float32Array([0, 1.0, 0.48, 0.24, 0.12, 0.06, 0.03]);

  return {
    chime: ctx.createPeriodicWave(chimeReal, chimeImag, { disableNormalization: false }),
    marimba: ctx.createPeriodicWave(marimbaReal, marimbaImag, { disableNormalization: false }),
    fmBass: ctx.createPeriodicWave(bassReal, bassImag, { disableNormalization: false }),
  };
}

function createNoiseBuffers(ctx) {
  const sr = ctx.sampleRate;

  // Deterministic PRNG for reproducible PCM buffers
  let seed = 0x51a7c3d1;
  const rand = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return ((seed >>> 0) / 0xffffffff) * 2 - 1;
  };

  // 30ms unlock click noise
  const clickLen = Math.max(1, Math.floor(sr * 0.03));
  const clickBuf = ctx.createBuffer(1, clickLen, sr);
  const cd = clickBuf.getChannelData(0);
  for (let i = 0; i < clickLen; i++) {
    const env = Math.pow(1 - i / clickLen, 2.2);
    cd[i] = rand() * env;
  }

  // 80ms vinyl needle drop thump + surface crackle
  const needleLen = Math.max(1, Math.floor(sr * 0.08));
  const needleBuf = ctx.createBuffer(1, needleLen, sr);
  const nd = needleBuf.getChannelData(0);
  for (let i = 0; i < needleLen; i++) {
    const t = i / sr;
    const thump = Math.sin(2 * Math.PI * (95 - t * 480) * t) * Math.exp(-t * 48);
    const crackle = (Math.abs(rand()) > 0.88 ? rand() * 0.7 : rand() * 0.18) * Math.exp(-t * 22);
    nd[i] = (thump * 0.75 + crackle * 0.5);
  }

  // 90ms percussive burst
  const percLen = Math.max(1, Math.floor(sr * 0.09));
  const percBuf = ctx.createBuffer(1, percLen, sr);
  const pd = percBuf.getChannelData(0);
  for (let i = 0; i < percLen; i++) {
    pd[i] = rand() * Math.pow(1 - i / percLen, 3.0);
  }

  return { clickBuf, needleBuf, percBuf };
}

function buildMasterBus(ctx, withAnalyser) {
  const masterGain = ctx.createGain();
  masterGain.gain.value = 0.82;

  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -10;
  comp.knee.value = 12;
  comp.ratio.value = 4;
  comp.attack.value = 0.004;
  comp.release.value = 0.12;

  // Shared DelayNode + BiquadFilterNode bus
  const delayIn = ctx.createGain();
  delayIn.gain.value = 0.32;

  const delay = ctx.createDelay(1.0);
  delay.delayTime.value = 0.28;

  const delayFilter = ctx.createBiquadFilter();
  delayFilter.type = 'lowpass';
  delayFilter.frequency.value = 2400;
  delayFilter.Q.value = 0.8;

  const delayFeedback = ctx.createGain();
  delayFeedback.gain.value = 0.34;

  delayIn.connect(delay);
  delay.connect(delayFilter);
  delayFilter.connect(delayFeedback);
  delayFeedback.connect(delay);
  delayFilter.connect(masterGain);

  masterGain.connect(comp);

  let analyser = null;
  if (withAnalyser) {
    analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.65;
    comp.connect(analyser);
    analyser.connect(ctx.destination);
  } else {
    comp.connect(ctx.destination);
  }

  return { masterGain, delayIn, delay, analyser };
}

function scheduleVoice(ctx, bus, waves, buffers, ev, scaleIdx, when, unlocked) {
  const scale = SCALES[scaleIdx % SCALES.length];
  const noteIdx = Math.abs(Math.floor(ev.pitch)) % scale.length;
  const semi = scale[noteIdx];
  const vel = Math.max(0.15, Math.min(1.0, ev.vel || 0.7));
  const panVal = Math.max(-0.88, Math.min(0.88, (ev.xNorm * 2 - 1) * 0.85));

  const panner = ctx.createStereoPanner();
  panner.pan.setValueAtTime(panVal, when);
  panner.connect(bus.masterGain);

  // Route melodic & chime voices generously to shared delay bus
  const wetSend = ctx.createGain();
  wetSend.gain.setValueAtTime(ev.layer === 2 ? 0.45 : ev.layer === 1 ? 0.22 : 0.14, when);
  panner.connect(wetSend);
  wetSend.connect(bus.delayIn);

  if (ev.kind === 2) {
    // Teleporter subtle harmonic blip
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(660, when);
    osc.frequency.exponentialRampToValueAtTime(1320, when + 0.06);
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(0.06 * vel, when + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.08);
    osc.connect(g).connect(panner);
    osc.start(when);
    osc.stop(when + 0.09);
    return;
  }

  if (ev.layer === 0) {
    // BASS LAYER
    const freq = midiToFreq(BASE_MIDI - 12 + (semi % 12));
    const osc = ctx.createOscillator();
    const g = ctx.createGain();

    if (unlocked.fmBass) {
      osc.setPeriodicWave(waves.fmBass);
      const mod = ctx.createOscillator();
      const modGain = ctx.createGain();
      mod.type = 'sine';
      mod.frequency.setValueAtTime(freq * 2, when);
      modGain.gain.setValueAtTime(freq * 1.4 * vel, when);
      modGain.gain.exponentialRampToValueAtTime(0.01, when + 0.22);
      mod.connect(modGain).connect(osc.frequency);
      mod.start(when);
      mod.stop(when + 0.45);
    } else {
      osc.type = 'triangle';
    }

    osc.frequency.setValueAtTime(freq, when);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(unlocked.fmBass ? 920 : 540, when);
    lp.frequency.exponentialRampToValueAtTime(160, when + 0.38);

    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(0.32 * vel, when + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.46);

    osc.connect(lp).connect(g).connect(panner);
    osc.start(when);
    osc.stop(when + 0.48);
  } else if (ev.layer === 1 || ev.kind === 1) {
    // PERC LAYER / BUMPER
    const src = ctx.createBufferSource();
    src.buffer = buffers.percBuf;

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(ev.kind === 1 ? 1600 + (noteIdx % 5) * 320 : 2800, when);
    bp.Q.setValueAtTime(unlocked.percussion ? 2.4 : 1.4, when);

    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.24 * vel, when);
    ng.gain.exponentialRampToValueAtTime(0.0001, when + 0.085);
    src.connect(bp).connect(ng).connect(panner);
    src.start(when);
    src.stop(when + 0.09);

    // Pitched body knock
    const osc = ctx.createOscillator();
    const og = ctx.createGain();
    osc.type = 'triangle';
    const baseF = unlocked.percussion ? 190 + (noteIdx % 4) * 55 : 145;
    osc.frequency.setValueAtTime(baseF * 1.6, when);
    osc.frequency.exponentialRampToValueAtTime(baseF * 0.55, when + 0.075);
    og.gain.setValueAtTime(0.22 * vel, when);
    og.gain.exponentialRampToValueAtTime(0.0001, when + 0.095);
    osc.connect(og).connect(panner);
    osc.start(when);
    osc.stop(when + 0.1);
  } else {
    // MEL LAYER (Chimes / Marimba)
    const freq = midiToFreq(BASE_MIDI + 12 + semi);
    const osc = ctx.createOscillator();
    const g = ctx.createGain();

    if (unlocked.marimba && noteIdx % 2 === 0) {
      osc.setPeriodicWave(waves.marimba);
    } else if (unlocked.chimes) {
      osc.setPeriodicWave(waves.chime);
    } else {
      osc.type = 'sine';
    }

    osc.frequency.setValueAtTime(freq, when);
    const decay = unlocked.chimes ? 0.62 : 0.42;
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(0.20 * vel, when + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, when + decay);

    osc.connect(g).connect(panner);
    osc.start(when);
    osc.stop(when + decay + 0.03);
  }
}

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.bus = null;
    this.waves = null;
    this.buffers = null;
    this.muted = false;
    this.oscData = new Uint8Array(128);
  }

  ensureContext() {
    if (this.ctx) return this.ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();
    this.waves = createPeriodicWaves(this.ctx);
    this.buffers = createNoiseBuffers(this.ctx);
    this.bus = buildMasterBus(this.ctx, true);
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
    g.gain.setValueAtTime(0.32, now);
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
    ng.gain.setValueAtTime(0.45, now);
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
      g.gain.linearRampToValueAtTime(0.18, t0 + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.72);
      osc.connect(g).connect(this.bus.masterGain);
      osc.start(t0);
      osc.stop(t0 + 0.75);
    });
  }

  setMuted(muted) {
    this.muted = muted;
    if (this.bus && this.ctx) {
      this.bus.masterGain.gain.setTargetAtTime(muted ? 0.0 : 0.82, this.ctx.currentTime, 0.015);
    }
  }

  setTempo(tempoMul) {
    if (this.bus && this.ctx) {
      const dt = Math.max(0.12, Math.min(0.6, 0.28 / tempoMul));
      this.bus.delay.delayTime.setTargetAtTime(dt, this.ctx.currentTime, 0.03);
    }
  }

  triggerEvents(eventsArr, scaleIdx, unlocked) {
    if (!this.ctx || this.ctx.state !== 'running' || this.muted) return;
    const now = this.ctx.currentTime;
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
      scheduleVoice(this.ctx, this.bus, this.waves, this.buffers, ev, scaleIdx, now + 0.005, unlocked);
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
    const renderLoops = 2; // 2 seamless loops + tail
    const totalSec = loopSec * renderLoops + 0.75;
    const totalFrames = Math.ceil(sampleRate * totalSec);

    const offline = new OfflineAudioContext(2, totalFrames, sampleRate);
    const waves = createPeriodicWaves(offline);
    const buffers = createNoiseBuffers(offline);
    const bus = buildMasterBus(offline, false);
    bus.delay.delayTime.value = Math.max(0.12, Math.min(0.6, 0.28 / tempoMul));

    const stride = 7;
    const count = Math.floor(eventsArr.length / stride);

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
        const when = offsetSec + (ev.tick / 60) / tempoMul + 0.02;
        if (when < totalSec - 0.1) {
          scheduleVoice(offline, bus, waves, buffers, ev, scaleIdx, when, unlocked);
        }
      }
    }

    const rendered = await offline.startRendering();
    // Copy channels into transferable Float32Arrays
    const left = new Float32Array(rendered.getChannelData(0));
    const right = new Float32Array(rendered.getChannelData(1));
    return { left, right, sampleRate };
  }
}