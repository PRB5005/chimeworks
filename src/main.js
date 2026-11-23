// ChimeWorks (32-Bit Edition) — Master Controller, State Machine & Genome Manager

import { AudioEngine } from './audio.js';
import {
  renderChamber,
  renderBreadcrumbThumbnail,
  renderVinylPlatter,
  renderGhostOverlay,
  hitTestChamber,
  clientToWorld,
} from './canvas.js';

const STORAGE_KEY = 'chimeworks_32bit_state_v1';
const TEMPOS = [0.5, 1.0, 1.5];
const LAYER_KEYS = ['b', 'p', 'm'];
const LAYER_NAMES = ['bass', 'perc', 'mel'];
const IS_MOBILE = window.matchMedia('(pointer: coarse)').matches || /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);

function createSeedGenome() {
  return {
    s: 0, // 0 = Pentatonic, 1 = Lydian
    b: {
      e: [28, 18, 108, 48, 60, 0],
      p: [
        [0, 44, 68, 24, 22, 0, 0],
        [3, 74, 106, 0, 10, 0, 0],
        [3, 110, 128, 0, 10, 4, 0],
      ],
    },
    p: {
      e: [80, 16, 90, 62, 30, 0],
      p: [
        [1, 80, 62, 0, 10, 0, 0],
        [0, 56, 98, 32, 20, 0, 0],
        [3, 106, 118, 0, 9, 2, 0],
      ],
    },
    m: {
      e: [132, 18, 72, 56, 20, 0],
      p: [
        [2, 118, 60, 0, 8, 1, 0],
        [2, 42, 46, 0, 8, 0, 0],
        [3, 56, 92, 0, 9, 7, 0],
        [3, 98, 122, 0, 9, 11, 0],
      ],
    },
  };
}

function cloneGenome(g) {
  return JSON.parse(JSON.stringify(g));
}

function validateGenome(g) {
  if (!g || typeof g !== 'object') return false;
  for (const lk of LAYER_KEYS) {
    if (!g[lk] || !Array.isArray(g[lk].e) || g[lk].e.length < 6 || !Array.isArray(g[lk].p)) return false;
  }
  return JSON.stringify(g).length < 400;
}

function encodeGenomeHash(g) {
  const str = JSON.stringify(g);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeGenomeHash(hash) {
  if (!hash || hash.length < 10) return null;
  try {
    const clean = hash.replace(/^#/, '').replace(/-/g, '+').replace(/_/g, '/');
    const pad = clean.length % 4 === 0 ? '' : '='.repeat(4 - (clean.length % 4));
    const parsed = JSON.parse(atob(clean + pad));
    return validateGenome(parsed) ? parsed : null;
  } catch (_e) {
    return null;
  }
}

// ---------- Application State ----------
const state = {
  mode: 'idle', // 'idle' | 'playing' | 'encoding' | 'complete'
  generation: 0,
  tempoIdx: 1,
  muted: false,
  soloSlot: 'parent', // 'parent' | 0 | 1 | 2 | 3
  layerModes: { bass: 'active', perc: 'active', mel: 'active' }, // 'active' | 'muted' | 'locked'
  parentGenome: createSeedGenome(),
  offspring: [
    { genome: createSeedGenome(), keyframes: null, barcode: null },
    { genome: createSeedGenome(), keyframes: null, barcode: null },
    { genome: createSeedGenome(), keyframes: null, barcode: null },
    { genome: createSeedGenome(), keyframes: null, barcode: null },
  ],
  history: [],
  commissions: { chimes: false, marimba: false, fmBass: false, percussion: false },
  liveDroplets: null,
  bellFlashes: new Map(),
  selectedPart: null,
  encodeProgress: 0,
  pendingMp3Blob: null,
  spinAngle: 0,
  tonearmStartMs: 0,
  tonearmSpring: 0,
  ghost: { active: false, fromSlot: null, genome: null, startX: 0, startY: 0, x: 0, y: 0 },
};

// ---------- DOM References ----------
const el = {
  body: document.body,
  odo: [document.getElementById('odo-0'), document.getElementById('odo-1'), document.getElementById('odo-2')],
  breadcrumbs: document.getElementById('breadcrumbs'),
  tempoDial: document.getElementById('tempo-dial'),
  powerBtn: document.getElementById('power-btn'),
  vinylPlatter: document.getElementById('vinyl-platter'),
  vinylBtn: document.getElementById('vinyl-btn'),
  scaleBtn: document.getElementById('scale-btn'),
  mutateBtn: document.getElementById('mutate-btn'),
  genomeBytes: document.getElementById('genome-bytes'),
  ledBass: document.getElementById('led-bass'),
  ledPerc: document.getElementById('led-perc'),
  ledMel: document.getElementById('led-mel'),
  drawer: document.getElementById('drawer'),
  drawerToggle: document.getElementById('drawer-toggle'),
  commSummary: document.getElementById('commissions-summary'),
  copyUrlBtn: document.getElementById('copy-url-btn'),
  exportBtn: document.getElementById('export-btn'),
  importBtn: document.getElementById('import-btn'),
  importFile: document.getElementById('import-file'),
  ghostOverlay: document.getElementById('ghost-overlay'),
  frames: {
    parent: document.querySelector('.chamber-frame[data-slot="parent"]'),
    0: document.querySelector('.chamber-frame[data-slot="0"]'),
    1: document.querySelector('.chamber-frame[data-slot="1"]'),
    2: document.querySelector('.chamber-frame[data-slot="2"]'),
    3: document.querySelector('.chamber-frame[data-slot="3"]'),
  },
  canvases: {
    parent: document.getElementById('canvas-parent'),
    0: document.getElementById('canvas-off-0'),
    1: document.getElementById('canvas-off-1'),
    2: document.getElementById('canvas-off-2'),
    3: document.getElementById('canvas-off-3'),
  },
};

const audio = new AudioEngine();
const physicsWorker = new Worker('./worker.js');
const mp3Worker = new Worker('./worker.js');

let workerReady = false;
let stepPending = false;
let lastFrameMs = performance.now();
let tickAccumulator = 0;
let kfTick = 0;
let waitingMp3Events = false;

// ---------- Persistence ----------
function saveLocal() {
  try {
    const payload = {
      generation: state.generation,
      tempoIdx: state.tempoIdx,
      layerModes: state.layerModes,
      parentGenome: state.parentGenome,
      history: state.history.slice(-8),
      commissions: state.commissions,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch (_e) {
    // Ignore storage quota errors
  }
}

function loadLocal() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (typeof data.generation === 'number') state.generation = data.generation;
    if (typeof data.tempoIdx === 'number') state.tempoIdx = data.tempoIdx % TEMPOS.length;
    if (data.layerModes) Object.assign(state.layerModes, data.layerModes);
    if (validateGenome(data.parentGenome)) state.parentGenome = data.parentGenome;
    if (Array.isArray(data.history)) state.history = data.history.filter(validateGenome).slice(-8);
    if (data.commissions) Object.assign(state.commissions, data.commissions);
  } catch (_e) {
    // Ignore corrupt localStorage
  }
}

// ---------- UI Sync ----------
function setAppState(nextMode) {
  state.mode = nextMode;
  el.body.dataset.state = nextMode;
  if (nextMode === 'encoding') {
    el.vinylBtn.dataset.mode = 'encoding';
    el.vinylBtn.textContent = `ENCODING ${state.encodeProgress}%`;
    el.vinylBtn.disabled = true;
  } else if (nextMode === 'complete') {
    el.vinylBtn.dataset.mode = 'complete';
    el.vinylBtn.textContent = IS_MOBILE ? 'Save MP3' : 'Pressed';
    el.vinylBtn.disabled = false;
  } else {
    el.vinylBtn.dataset.mode = 'ready';
    el.vinylBtn.textContent = 'Press to Vinyl';
    el.vinylBtn.disabled = false;
  }
}

function updateOdometer() {
  const num = Math.max(0, Math.min(999, state.generation));
  const digits = String(num).padStart(3, '0');
  for (let i = 0; i < 3; i++) {
    const d = Number(digits[i]);
    el.odo[i].style.transform = `translateY(${-d * 22}px)`;
  }
}

function updateBreadcrumbs() {
  el.breadcrumbs.innerHTML = '';
  state.history.forEach((g, idx) => {
    const btn = document.createElement('button');
    btn.className = 'crumb-btn';
    btn.type = 'button';
    btn.setAttribute('aria-label', `Gen ${idx}`);
    const cv = document.createElement('canvas');
    cv.width = 24;
    cv.height = 24;
    renderBreadcrumbThumbnail(cv, g);
    btn.appendChild(cv);
    btn.addEventListener('click', () => {
      state.parentGenome = cloneGenome(g);
      state.soloSlot = 'parent';
      syncAllUI();
      reloadSoloedPhysics();
      requestOffspringRollouts();
      saveLocal();
    });
    el.breadcrumbs.appendChild(btn);
  });
}

function updateCommissions() {
  let done = 0;
  document.querySelectorAll('.comm-item').forEach((node) => {
    const k = node.dataset.comm;
    const isDone = !!state.commissions[k];
    node.classList.toggle('done', isDone);
    if (isDone) done++;
  });
  el.commSummary.textContent = `COMMISSIONS ${done}/4`;
}

function completeCommission(key) {
  if (!state.commissions[key]) {
    state.commissions[key] = true;
    updateCommissions();
    saveLocal();
  }
}

function getSoloGenome() {
  return state.soloSlot === 'parent' ? state.parentGenome : state.offspring[state.soloSlot].genome;
}

function getLayerMutedArr() {
  if (state.soloSlot !== 'parent') return [false, false, false];
  return [
    state.layerModes.bass === 'muted',
    state.layerModes.perc === 'muted',
    state.layerModes.mel === 'muted',
  ];
}

function syncAllUI() {
  updateOdometer();
  updateBreadcrumbs();
  updateCommissions();

  el.tempoDial.textContent = `${TEMPOS[state.tempoIdx]}×`;
  el.powerBtn.classList.toggle('lit', !state.muted && state.mode !== 'idle');
  el.scaleBtn.textContent = state.parentGenome.s === 0 ? 'PENT' : 'LYD';
  el.genomeBytes.textContent = `${JSON.stringify(getSoloGenome()).length}B`;

  el.ledBass.dataset.mode = state.layerModes.bass;
  el.ledPerc.dataset.mode = state.layerModes.perc;
  el.ledMel.dataset.mode = state.layerModes.mel;

  for (const key of ['parent', 0, 1, 2, 3]) {
    el.frames[key].classList.toggle('soloed', String(state.soloSlot) === String(key));
  }
}

// ---------- Worker Coordination ----------
function reloadSoloedPhysics() {
  if (!workerReady) return;
  state.bellFlashes.clear();
  physicsWorker.postMessage({
    type: 'loadLive',
    genome: getSoloGenome(),
    layerMuted: getLayerMutedArr(),
  });
}

function requestOffspringRollouts(keepSlot0 = false) {
  if (!workerReady) return;
  const savedSlot0 = keepSlot0 ? cloneGenome(state.offspring[0].genome) : null;
  physicsWorker.postMessage({
    type: 'evolveOffspring',
    parentGenome: state.parentGenome,
    locks: {
      bass: state.layerModes.bass === 'locked',
      perc: state.layerModes.perc === 'locked',
      mel: state.layerModes.mel === 'locked',
    },
    seed: (Date.now() ^ (state.generation * 2654435761)) >>> 0,
  });
  if (savedSlot0) {
    state._preserveSlot0 = savedSlot0;
  }
}

physicsWorker.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'ready') {
    workerReady = true;
    const hashGenome = decodeGenomeHash(window.location.hash);
    if (hashGenome) {
      // Load shared #hash into offspring chamber 0 without overwriting parent
      state.offspring[0].genome = hashGenome;
      requestOffspringRollouts(true);
    } else {
      requestOffspringRollouts(false);
    }
    reloadSoloedPhysics();
    // Rollout parent barcode too
    physicsWorker.postMessage({
      type: 'rolloutChamber',
      slot: 'parent',
      genome: state.parentGenome,
      layerMuted: getLayerMutedArr(),
    });
    return;
  }

  if (msg.type === 'liveState') {
    stepPending = false;
    state.liveDroplets = msg.droplets;
    if (msg.events.length > 0) {
      const stride = 7;
      const count = msg.events.length / stride;
      for (let i = 0; i < count; i++) {
        const kind = Math.round(msg.events[i * stride + 2]);
        const partIdx = Math.round(msg.events[i * stride + 3]);
        if (kind === 3 || kind === 1) {
          // 2-frame #F2ECE1 flash
          state.bellFlashes.set(partIdx, 2);
        }
      }
      audio.triggerEvents(msg.events, getSoloGenome().s, state.commissions);
    }
    return;
  }

  if (msg.type === 'offspringReady') {
    for (let i = 0; i < 4; i++) {
      state.offspring[i] = msg.offspring[i];
    }
    if (state._preserveSlot0) {
      state.offspring[0].genome = state._preserveSlot0;
      state._preserveSlot0 = null;
      physicsWorker.postMessage({
        type: 'rolloutChamber',
        slot: 0,
        genome: state.offspring[0].genome,
        layerMuted: [false, false, false],
      });
    }
    return;
  }

  if (msg.type === 'chamberRollout') {
    if (msg.slot !== 'parent') {
      state.offspring[msg.slot].keyframes = msg.keyframes;
      state.offspring[msg.slot].barcode = msg.barcode;
    }
    return;
  }

  if (msg.type === 'eventsReady' && waitingMp3Events) {
    waitingMp3Events = false;
    const tempoMul = TEMPOS[state.tempoIdx];
    audio
      .renderOfflineLoop(msg.events, msg.ticks, getSoloGenome().s, tempoMul, state.commissions)
      .then(({ left, right, sampleRate }) => {
        mp3Worker.postMessage(
          { type: 'encodeMp3', left, right, sampleRate, bitrate: 128 },
          [left.buffer, right.buffer]
        );
      })
      .catch(() => {
        setAppState('playing');
      });
  }
};

mp3Worker.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'mp3Progress') {
    state.encodeProgress = msg.progress;
    if (state.mode === 'encoding') {
      el.vinylBtn.textContent = `ENCODING ${msg.progress}%`;
    }
    return;
  }
  if (msg.type === 'mp3Done') {
    const blob = new Blob([msg.buffer], { type: 'audio/mpeg' });
    state.pendingMp3Blob = blob;
    state.tonearmStartMs = performance.now();
    setAppState('complete');
    audio.playNeedleDropAndFifth();

    if (!IS_MOBILE) {
      triggerBlobDownload(blob);
    }
    return;
  }
  if (msg.type === 'error') {
    setAppState('playing');
  }
};

function triggerBlobDownload(blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `chimeworks-gen${String(state.generation).padStart(3, '0')}.mp3`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ---------- First-Tap Unlock ----------
function handleFirstTapUnlock() {
  if (state.mode !== 'idle') return;
  audio.unlock().then(() => {
    audio.setTempo(TEMPOS[state.tempoIdx]);
    setAppState('playing');
    syncAllUI();
    reloadSoloedPhysics();
  });
}

window.addEventListener('pointerdown', handleFirstTapUnlock, { once: true });

// ---------- Top Bar & Parent Controls ----------
el.tempoDial.addEventListener('click', () => {
  state.tempoIdx = (state.tempoIdx + 1) % TEMPOS.length;
  audio.setTempo(TEMPOS[state.tempoIdx]);
  syncAllUI();
  saveLocal();
});

el.powerBtn.addEventListener('click', () => {
  state.muted = !state.muted;
  audio.setMuted(state.muted);
  syncAllUI();
});

el.scaleBtn.addEventListener('click', () => {
  state.parentGenome.s = state.parentGenome.s === 0 ? 1 : 0;
  syncAllUI();
  reloadSoloedPhysics();
  saveLocal();
});

el.mutateBtn.addEventListener('click', () => {
  completeCommission('chimes');
  requestOffspringRollouts(false);
});

function cycleLayerLed(layerName) {
  const cur = state.layerModes[layerName];
  const next = cur === 'active' ? 'muted' : cur === 'muted' ? 'locked' : 'active';
  state.layerModes[layerName] = next;
  if (next === 'locked') {
    completeCommission('marimba');
  }
  syncAllUI();
  reloadSoloedPhysics();
  saveLocal();
}

el.ledBass.addEventListener('click', () => cycleLayerLed('bass'));
el.ledPerc.addEventListener('click', () => cycleLayerLed('perc'));
el.ledMel.addEventListener('click', () => cycleLayerLed('mel'));

el.vinylBtn.addEventListener('click', () => {
  if (state.mode === 'idle' || state.mode === 'encoding') return;
  if (state.mode === 'complete') {
    if (state.pendingMp3Blob) {
      triggerBlobDownload(state.pendingMp3Blob);
    }
    setAppState('playing');
    state.tonearmSpring = 0;
    return;
  }
  // Start Encoding MP3 while live playback continues
  state.encodeProgress = 0;
  state.pendingMp3Blob = null;
  waitingMp3Events = true;
  setAppState('encoding');
  physicsWorker.postMessage({
    type: 'renderEvents',
    genome: getSoloGenome(),
    layerMuted: getLayerMutedArr(),
    ticks: 240,
  });
});

// ---------- Bottom Drawer, Share URL & JSON Export/Import ----------
el.drawerToggle.addEventListener('click', () => {
  const open = el.drawer.classList.toggle('open');
  el.drawerToggle.textContent = open ? 'DRAWER ▼' : 'DRAWER ▲';
});

el.copyUrlBtn.addEventListener('click', async () => {
  const hash = encodeGenomeHash(getSoloGenome());
  const url = `${window.location.origin}${window.location.pathname}#${hash}`;
  window.history.replaceState(null, '', `#${hash}`);
  try {
    await navigator.clipboard.writeText(url);
    el.copyUrlBtn.textContent = 'COPIED';
    setTimeout(() => { el.copyUrlBtn.textContent = 'Copy Share URL'; }, 1200);
  } catch (_e) {
    el.copyUrlBtn.textContent = 'HASH SET';
    setTimeout(() => { el.copyUrlBtn.textContent = 'Copy Share URL'; }, 1200);
  }
});

el.exportBtn.addEventListener('click', () => {
  saveLocal();
  const data = localStorage.getItem(STORAGE_KEY) || '{}';
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `chimeworks-state-gen${String(state.generation).padStart(3, '0')}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
});

el.importBtn.addEventListener('click', () => el.importFile.click());
el.importFile.addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  try {
    const txt = await file.text();
    const parsed = JSON.parse(txt);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed));
    loadLocal();
    syncAllUI();
    reloadSoloedPhysics();
    requestOffspringRollouts(false);
  } catch (_e) {
    // Ignore invalid JSON file
  }
  el.importFile.value = '';
});

// ---------- Interactive Part Tweaking (Parent + Soloed Chamber) ----------
let dragPart = null;
let lastTap = { time: 0, key: '' };

function bindChamberCanvasInteraction(slotKey, canvas) {
  canvas.addEventListener('pointerdown', (e) => {
    if (String(state.soloSlot) !== String(slotKey)) return;
    const genome = getSoloGenome();
    const hit = hitTestChamber(canvas, e.clientX, e.clientY, genome, state.selectedPart);
    if (!hit || hit.type === 'empty') {
      state.selectedPart = null;
      return;
    }

    e.stopPropagation();
    canvas.setPointerCapture(e.pointerId);

    if (hit.type === 'rotate') {
      dragPart = { slotKey, mode: 'rotate', layerKey: hit.layerKey, isEmitter: hit.isEmitter, index: hit.index };
      return;
    }

    const tapKey = `${slotKey}:${hit.layerKey}:${hit.isEmitter}:${hit.index}`;
    const now = performance.now();
    if (now - lastTap.time < 300 && lastTap.key === tapKey) {
      // Double-tap toggles part mute
      const layer = genome[hit.layerKey];
      if (hit.isEmitter) {
        layer.e[5] = layer.e[5] === 1 ? 0 : 1;
      } else {
        layer.p[hit.index][6] = layer.p[hit.index][6] === 1 ? 0 : 1;
      }
      lastTap = { time: 0, key: '' };
      reloadSoloedPhysics();
      saveLocal();
      return;
    }
    lastTap = { time: now, key: tapKey };

    state.selectedPart = { layerKey: hit.layerKey, isEmitter: hit.isEmitter, index: hit.index };
    dragPart = { slotKey, mode: 'move', layerKey: hit.layerKey, isEmitter: hit.isEmitter, index: hit.index };
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!dragPart || String(dragPart.slotKey) !== String(slotKey)) return;
    const genome = getSoloGenome();
    const layer = genome[dragPart.layerKey];
    const target = dragPart.isEmitter ? layer.e : layer.p[dragPart.index];
    if (!target) return;

    const pt = clientToWorld(canvas, e.clientX, e.clientY);
    if (dragPart.mode === 'move') {
      const nx = Math.max(16, Math.min(144, Math.round(pt.x)));
      const ny = Math.max(16, Math.min(144, Math.round(pt.y)));
      if (dragPart.isEmitter) {
        target[0] = nx;
        target[1] = ny;
      } else {
        target[1] = nx;
        target[2] = ny;
      }
    } else if (dragPart.mode === 'rotate') {
      const tx = dragPart.isEmitter ? target[0] : target[1];
      const ty = dragPart.isEmitter ? target[1] : target[2];
      const deg = (Math.round((Math.atan2(pt.y - ty, pt.x - tx) * 180) / Math.PI) + 360) % 360;
      if (dragPart.isEmitter) target[2] = deg;
      else target[3] = deg;
    }
    reloadSoloedPhysics();
  });

  const endDrag = () => {
    if (dragPart && String(dragPart.slotKey) === String(slotKey)) {
      dragPart = null;
      saveLocal();
    }
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
}

bindChamberCanvasInteraction('parent', el.canvases.parent);
for (let i = 0; i < 4; i++) {
  bindChamberCanvasInteraction(i, el.canvases[i]);
}

// ---------- Parent Click to Re-Solo ----------
el.frames.parent.addEventListener('pointerdown', (e) => {
  if (e.target.closest('button')) return;
  if (state.soloSlot !== 'parent') {
    state.soloSlot = 'parent';
    state.selectedPart = null;
    syncAllUI();
    reloadSoloedPhysics();
  }
});

// ---------- Offspring Solo, 2nd-Tap Promote & >8px Blueprint Cross-Pollination ----------
function promoteOffspring(slot) {
  state.history.push(cloneGenome(state.parentGenome));
  if (state.history.length > 8) state.history.shift();
  state.parentGenome = cloneGenome(state.offspring[slot].genome);
  state.generation = (state.generation + 1) % 1000;
  state.soloSlot = 'parent';
  state.selectedPart = null;
  if (state.generation >= 3) {
    completeCommission('percussion');
  }
  syncAllUI();
  reloadSoloedPhysics();
  requestOffspringRollouts(false);
  saveLocal();
}

function crossPollinate(fromSlot, targetSlot) {
  const donor = state.offspring[fromSlot].genome;
  const recipient = targetSlot === 'parent' ? state.parentGenome : state.offspring[targetSlot].genome;

  // Pick an intact unlocked layer to swap from donor into recipient
  const candidates = [];
  for (let i = 0; i < 3; i++) {
    if (targetSlot === 'parent' && state.layerModes[LAYER_NAMES[i]] === 'locked') continue;
    candidates.push(LAYER_KEYS[i]);
  }
  if (candidates.length === 0) return;

  const chosen = candidates[(state.generation + fromSlot) % candidates.length];
  recipient[chosen] = JSON.parse(JSON.stringify(donor[chosen]));

  // Keep <400-byte genome invariant
  while (JSON.stringify(recipient).length >= 400 && recipient[chosen].p.length > 2) {
    recipient[chosen].p.pop();
  }

  completeCommission('fmBass');
  syncAllUI();
  if (String(state.soloSlot) === String(targetSlot)) {
    reloadSoloedPhysics();
  } else if (targetSlot !== 'parent') {
    physicsWorker.postMessage({
      type: 'rolloutChamber',
      slot: targetSlot,
      genome: recipient,
      layerMuted: [false, false, false],
    });
  }
  saveLocal();
}

for (let slot = 0; slot < 4; slot++) {
  const frame = el.frames[slot];
  let downPos = null;
  let dragged = false;

  frame.addEventListener('pointerdown', (e) => {
    if (dragPart) return;
    downPos = { x: e.clientX, y: e.clientY, pointerId: e.pointerId };
    dragged = false;
  });

  window.addEventListener('pointermove', (e) => {
    if (!downPos || e.pointerId !== downPos.pointerId) return;
    const dist = Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y);
    if (!dragged && dist > 8) {
      dragged = true;
      state.ghost = {
        active: true,
        fromSlot: slot,
        genome: state.offspring[slot].genome,
        startX: downPos.x,
        startY: downPos.y,
        x: e.clientX,
        y: e.clientY,
      };
    }
    if (dragged) {
      state.ghost.x = e.clientX;
      state.ghost.y = e.clientY;
      // Highlight drop target
      for (const k of ['parent', 0, 1, 2, 3]) {
        const r = el.frames[k].getBoundingClientRect();
        const over = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
        el.frames[k].classList.toggle('drop-target', over && String(k) !== String(slot));
      }
    }
  });

  window.addEventListener('pointerup', (e) => {
    if (!downPos || e.pointerId !== downPos.pointerId) return;
    const wasDragged = dragged;
    downPos = null;
    dragged = false;

    if (wasDragged) {
      state.ghost.active = false;
      for (const k of ['parent', 0, 1, 2, 3]) {
        el.frames[k].classList.remove('drop-target');
        const r = el.frames[k].getBoundingClientRect();
        if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
          if (String(k) !== String(slot)) {
            crossPollinate(slot, k === 'parent' ? 'parent' : Number(k));
          }
        }
      }
      return;
    }

    // Tap behavior: 1st tap solos (elevates 2px + inset chevron), 2nd tap promotes
    if (state.soloSlot === slot) {
      promoteOffspring(slot);
    } else {
      state.soloSlot = slot;
      state.selectedPart = null;
      syncAllUI();
      reloadSoloedPhysics();
    }
  });
}

// ---------- Main Animation Loop ----------
function loop(now) {
  const dt = Math.min(0.05, (now - lastFrameMs) / 1000);
  lastFrameMs = now;

  // Advance live WASM physics solely in the soloed chamber
  if (state.mode !== 'idle' && workerReady) {
    tickAccumulator += dt * 60 * TEMPOS[state.tempoIdx];
    const ticks = Math.floor(tickAccumulator);
    if (ticks > 0 && !stepPending) {
      tickAccumulator -= ticks;
      stepPending = true;
      physicsWorker.postMessage({ type: 'stepLive', ticks: Math.min(ticks, 4) });
    }
    kfTick = (kfTick + dt * 15 * TEMPOS[state.tempoIdx]) % 60;
  }

  // Spin platter at exact 33 RPM during Encoding MP3
  if (state.mode === 'encoding') {
    state.spinAngle = (state.spinAngle + dt * (33 / 60) * Math.PI * 2) % (Math.PI * 2);
  }

  // 120ms spring tonearm drop on Download Complete
  if (state.mode === 'complete') {
    const elapsed = Math.min(120, now - state.tonearmStartMs);
    const u = elapsed / 120;
    // Underdamped spring settling smoothly at u = 1 (120ms)
    state.tonearmSpring = 1 - Math.exp(-6 * u) * Math.cos(Math.PI * 2.2 * u);
  } else {
    state.tonearmSpring = 0;
  }

  // Render vinyl platter
  renderVinylPlatter(el.vinylPlatter, state.mode, state.spinAngle, state.encodeProgress, state.tonearmSpring);

  // Render Parent + 4 Offspring chambers
  const isIdle = state.mode === 'idle';
  const oscData = isIdle ? null : audio.getOscilloscopeData();

  renderChamber(el.canvases.parent, {
    genome: state.parentGenome,
    isIdle,
    isSoloed: state.soloSlot === 'parent',
    layerModes: state.layerModes,
    droplets: state.soloSlot === 'parent' ? state.liveDroplets : null,
    keyframes: null,
    kfFrame: 0,
    barcode: null,
    bellFlashes: state.soloSlot === 'parent' ? state.bellFlashes : null,
    selectedPart: state.soloSlot === 'parent' ? state.selectedPart : null,
    oscData: state.soloSlot === 'parent' ? oscData : null,
  });

  for (let i = 0; i < 4; i++) {
    const isSoloed = state.soloSlot === i;
    renderChamber(el.canvases[i], {
      genome: state.offspring[i].genome,
      isIdle,
      isSoloed,
      layerModes: null,
      droplets: isSoloed ? state.liveDroplets : null,
      keyframes: isSoloed ? null : state.offspring[i].keyframes,
      kfFrame: Math.floor(kfTick),
      barcode: isSoloed ? null : state.offspring[i].barcode,
      bellFlashes: isSoloed ? state.bellFlashes : null,
      selectedPart: isSoloed ? state.selectedPart : null,
      oscData: isSoloed ? oscData : null,
    });
  }

  // Decrement 2-frame bell flashes
  for (const [k, v] of state.bellFlashes.entries()) {
    if (v <= 1) state.bellFlashes.delete(k);
    else state.bellFlashes.set(k, v - 1);
  }

  // Render blueprint ghost overlay
  renderGhostOverlay(el.ghostOverlay, state.ghost);

  requestAnimationFrame(loop);
}

// ---------- Boot ----------
loadLocal();
syncAllUI();
physicsWorker.postMessage({ type: 'init', wasmUrl: './physics.wasm' });
requestAnimationFrame(loop);