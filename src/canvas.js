// ChimeWorks (32-Bit Edition) — Procedural Double-Resolution Pixel-Art Renderer
// Upgrades: Live dotted trajectory aiming arcs, distinct layer silhouettes
// (Square = BASS, Diamond = PERC, Circle = MEL), floating pitch/drum badges,
// active 4-bar chord indicator, and edge-delete visual cue.

import { getNoteNameForY } from './audio.js';

export const COLORS = {
  bg: '#121016',
  surface: '#3D333A',
  ink: '#F2ECE1',
  accent: '#E5A93C',
  active: '#4CD4A9',
};

const WORLD_SIZE = 160;
const CANVAS_SIZE = 320; // Double-resolution pixel art (2px per physics unit)
const SCALE = CANVAS_SIZE / WORLD_SIZE;
const LAYER_KEYS = ['b', 'p', 'm'];
const LAYER_TAGS = ['BASS', 'PERC', 'MEL'];
const DRUM_NAMES = ['KICK', 'RIM', 'SNARE', 'HAT'];

// Trajectory buffer layout matching wasm/physics.rs
const TRAJ_MAX_PTS = 90;
const TRAJ_LAYER_STRIDE = 1 + TRAJ_MAX_PTS * 2; // 181 f32s per layer

function px(v) {
  return Math.round(v * SCALE);
}

function spatialPitchFromY(y) {
  const norm = 1 - Math.max(0, Math.min(1, (y - 16) / 128));
  return Math.max(0, Math.min(14, Math.floor(norm * 14 + 0.5)));
}

function drawPixelCircle(ctx, cx, cy, r, fill, stroke) {
  ctx.beginPath();
  ctx.arc(Math.round(cx), Math.round(cy), Math.round(r), 0, Math.PI * 2);
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

function drawPixelSquare(ctx, cx, cy, r, fill, stroke) {
  const x = Math.round(cx - r);
  const y = Math.round(cy - r);
  const w = Math.round(r * 2);
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fillRect(x, y, w, w);
  }
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, w, w);
  }
}

function drawPixelDiamond(ctx, cx, cy, r, fill, stroke) {
  const x = Math.round(cx);
  const y = Math.round(cy);
  const rad = Math.round(r * 1.15);
  ctx.beginPath();
  ctx.moveTo(x, y - rad);
  ctx.lineTo(x + rad, y);
  ctx.lineTo(x, y + rad);
  ctx.lineTo(x - rad, y);
  ctx.closePath();
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

function drawLayerShape(ctx, layerIdx, cx, cy, r, fill, stroke) {
  if (layerIdx === 0) {
    drawPixelSquare(ctx, cx, cy, r, fill, stroke);
  } else if (layerIdx === 1) {
    drawPixelDiamond(ctx, cx, cy, r, fill, stroke);
  } else {
    drawPixelCircle(ctx, cx, cy, r, fill, stroke);
  }
}

function drawPinhead(ctx, x, y, color) {
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(x - 3), Math.round(y - 3), 6, 6);
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(Math.round(x - 1), Math.round(y - 1), 2, 2);
}

function drawBadge(ctx, cx, cy, text, bg, fg) {
  ctx.font = 'bold 12px ui-monospace, Menlo, Consolas, monospace';
  const metrics = ctx.measureText(text);
  const padX = 5;
  const bw = Math.ceil(metrics.width) + padX * 2;
  const bh = 18;
  const bx = Math.max(4, Math.min(CANVAS_SIZE - bw - 4, Math.round(cx - bw / 2)));
  const by = Math.max(4, Math.min(CANVAS_SIZE - bh - 4, Math.round(cy - bh / 2)));

  ctx.fillStyle = bg;
  ctx.fillRect(bx, by, bw, bh);
  ctx.fillStyle = fg;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText(text, bx + padX, by + bh / 2 + 1);
}

export function hitTestChamber(canvas, clientX, clientY, genome, selectedPart) {
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;

  // Account for object-fit: contain square aspect
  const side = Math.min(rect.width, rect.height);
  const offX = rect.left + (rect.width - side) * 0.5;
  const offY = rect.top + (rect.height - side) * 0.5;

  const cssX = clientX - offX;
  const cssY = clientY - offY;
  const worldX = (cssX / side) * WORLD_SIZE;
  const worldY = (cssY / side) * WORLD_SIZE;

  // Enforce 44x44 CSS-pixel hit radius (22px half-size)
  const hitRadiusWorld = (22 / side) * WORLD_SIZE;
  // 32px outward rotation arc offset in world units
  const arcOffsetWorld = (32 / side) * WORLD_SIZE;

  // 1. Check rotation handle of currently selected part first
  if (selectedPart) {
    const layer = genome[selectedPart.layerKey];
    const target = selectedPart.isEmitter ? layer.e : layer.p[selectedPart.index];
    if (target) {
      const tx = selectedPart.isEmitter ? target[0] : target[1];
      const ty = selectedPart.isEmitter ? target[1] : target[2];
      const deg = selectedPart.isEmitter ? target[2] : target[3];
      const rad = (deg * Math.PI) / 180;
      const hx = tx + Math.cos(rad) * arcOffsetWorld;
      const hy = ty + Math.sin(rad) * arcOffsetWorld;
      if (Math.hypot(worldX - hx, worldY - hy) <= hitRadiusWorld) {
        return {
          type: 'rotate',
          layerKey: selectedPart.layerKey,
          isEmitter: selectedPart.isEmitter,
          index: selectedPart.index,
          worldX,
          worldY,
        };
      }
    }
  }

  // 2. Check all emitters and parts within 44x44 CSS-pixel radius
  let best = null;
  let bestDist = hitRadiusWorld;

  for (let li = 0; li < 3; li++) {
    const lk = LAYER_KEYS[li];
    const layer = genome[lk];
    const e = layer.e;
    const ed = Math.hypot(worldX - e[0], worldY - e[1]);
    if (ed <= bestDist) {
      bestDist = ed;
      best = { type: 'part', layerKey: lk, isEmitter: true, index: -1, worldX, worldY };
    }
    for (let pi = 0; pi < layer.p.length; pi++) {
      const p = layer.p[pi];
      const pd = Math.hypot(worldX - p[1], worldY - p[2]);
      if (pd <= bestDist) {
        bestDist = pd;
        best = { type: 'part', layerKey: lk, isEmitter: false, index: pi, worldX, worldY };
      }
    }
  }

  return best || { type: 'empty', worldX, worldY };
}

export function clientToWorld(canvas, clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const side = Math.min(rect.width, rect.height);
  const offX = rect.left + (rect.width - side) * 0.5;
  const offY = rect.top + (rect.height - side) * 0.5;
  return {
    x: ((clientX - offX) / side) * WORLD_SIZE,
    y: ((clientY - offY) / side) * WORLD_SIZE,
    side,
  };
}

export function renderChamber(canvas, opts) {
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;

  const {
    genome,
    isIdle,
    isSoloed,
    layerModes,   // { bass, perc, mel } -> 'active' | 'muted' | 'locked'
    activeLayer,  // optional 'b' | 'p' | 'm' highlighted when editing
    droplets,     // live Float32Array (stride 8) or null
    keyframes,    // offline Float32Array (stride 49) or null
    kfFrame,      // integer frame index for idle keyframes
    barcode,      // Float32Array(16) or null
    trajectories, // Float32Array(543) from trace_trajectories or null
    bellFlashes,  // Map<flatPartIdx, remainingFrames>
    selectedPart, // { layerKey, isEmitter, index } or null
    isDragging,   // boolean: true while actively dragging a part
    dragDeleting, // boolean: true when dragged to edge for deletion
    chordName,    // string (e.g., 'Cmaj9') or null
    oscData,      // Uint8Array(128) or null
  } = opts;

  const accentColor = isIdle ? COLORS.ink : COLORS.accent;
  const rect = canvas.getBoundingClientRect();
  const side = Math.max(80, Math.min(rect.width || 320, rect.height || 320));
  const arcOffsetCanvas = (32 / side) * CANVAS_SIZE;

  // Backdrop
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

  // Subtle 32-bit drafting grid
  ctx.fillStyle = 'rgba(242, 236, 225, 0.06)';
  for (let gx = 16; gx < CANVAS_SIZE; gx += 32) {
    ctx.fillRect(gx, 0, 1, CANVAS_SIZE);
  }
  for (let gy = 16; gy < CANVAS_SIZE; gy += 32) {
    ctx.fillRect(0, gy, CANVAS_SIZE, 1);
  }

  // Edge-delete frame cue when dragging a non-emitter part near canvas border
  if (dragDeleting && isSoloed && !isIdle) {
    ctx.strokeStyle = COLORS.accent;
    ctx.lineWidth = 4;
    ctx.setLineDash([6, 6]);
    ctx.strokeRect(4, 4, CANVAS_SIZE - 8, CANVAS_SIZE - 8);
    ctx.setLineDash([]);
    drawBadge(ctx, CANVAS_SIZE / 2, 16, 'RELEASE TO DELETE', COLORS.accent, COLORS.bg);
  }

  const modeArr = [
    layerModes ? layerModes.bass : 'active',
    layerModes ? layerModes.perc : 'active',
    layerModes ? layerModes.mel : 'active',
  ];

  // Live Dotted Trajectory Aiming Arcs (soloed chamber only)
  if (isSoloed && trajectories && trajectories.length >= 3 * TRAJ_LAYER_STRIDE) {
    const focusLayer = selectedPart ? selectedPart.layerKey : activeLayer;
    for (let li = 0; li < 3; li++) {
      if (modeArr[li] === 'muted') continue;
      const base = li * TRAJ_LAYER_STRIDE;
      const count = Math.min(TRAJ_MAX_PTS, Math.floor(trajectories[base]));
      if (count < 2) continue;

      const isFocused = focusLayer === LAYER_KEYS[li];
      ctx.fillStyle = isFocused && !isIdle
        ? 'rgba(229, 169, 60, 0.55)'
        : 'rgba(242, 236, 225, 0.16)';

      const dotSize = isFocused ? 3 : 2;
      for (let i = 0; i < count; i += 2) {
        const tx = px(trajectories[base + 1 + i * 2]);
        const ty = px(trajectories[base + 1 + i * 2 + 1]);
        ctx.fillRect(Math.round(tx - dotSize / 2), Math.round(ty - dotSize / 2), dotSize, dotSize);
      }
    }
  }

  let flatPartIdx = 0;

  // Draw emitters and parts per layer with distinct layer silhouettes
  for (let li = 0; li < 3; li++) {
    const lk = LAYER_KEYS[li];
    const layer = genome[lk];
    const lMode = modeArr[li];
    const layerMuted = lMode === 'muted';
    const layerLocked = lMode === 'locked' && !isIdle;
    const isSelectedLayer = selectedPart && selectedPart.layerKey === lk;

    // Emitter
    const e = layer.e;
    const ex = px(e[0]);
    const ey = px(e[1]);
    const erad = (e[2] * Math.PI) / 180;
    const emMuted = layerMuted || e[5] === 1;
    const emStroke = emMuted ? COLORS.surface : (isSoloed ? accentColor : COLORS.ink);

    drawLayerShape(ctx, li, ex, ey, 7, COLORS.bg, emStroke);

    // Nozzle direction
    ctx.strokeStyle = emStroke;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(ex, ey);
    ctx.lineTo(Math.round(ex + Math.cos(erad) * 13), Math.round(ey + Math.sin(erad) * 13));
    ctx.stroke();

    // Idle state: droplets poised at emitters (strictly --cw-ink)
    if (isIdle && !emMuted) {
      drawLayerShape(ctx, li, ex + Math.cos(erad) * 13, ey + Math.sin(erad) * 13, 3.5, COLORS.ink, null);
    }
    if (layerLocked) {
      drawPinhead(ctx, ex - 8, ey - 8, COLORS.accent);
    }

    // Parts
    for (let pi = 0; pi < layer.p.length; pi++) {
      const p = layer.p[pi];
      const kind = p[0];
      const x = px(p[1]);
      const y = px(p[2]);
      const rad = (p[3] * Math.PI) / 180;
      const size = px(p[4]);
      const pMuted = layerMuted || p[6] === 1;
      const flash = bellFlashes ? (bellFlashes.get(flatPartIdx) || 0) : 0;
      const isThisSelected = isSelectedLayer && !selectedPart.isEmitter && selectedPart.index === pi;

      if (kind === 0) {
        // Ramp with end-caps indicating its layer
        const dx = Math.cos(rad) * size;
        const dy = Math.sin(rad) * size;
        ctx.strokeStyle = pMuted ? COLORS.surface : (isThisSelected && !isIdle ? COLORS.accent : COLORS.ink);
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(Math.round(x - dx), Math.round(y - dy));
        ctx.lineTo(Math.round(x + dx), Math.round(y + dy));
        ctx.stroke();
        // End pins
        ctx.fillStyle = pMuted ? COLORS.surface : accentColor;
        ctx.fillRect(Math.round(x - dx) - 2, Math.round(y - dy) - 2, 4, 4);
        ctx.fillRect(Math.round(x + dx) - 2, Math.round(y + dy) - 2, 4, 4);
      } else if (kind === 1) {
        // Bumper (percussive diamond/layer shape with inner core)
        const isFlashing = flash > 0 && !isIdle;
        const stroke = pMuted ? COLORS.surface : (isFlashing ? COLORS.ink : (isSoloed ? accentColor : COLORS.ink));
        const fill = isFlashing ? COLORS.ink : COLORS.surface;
        drawLayerShape(ctx, li, x, y, size, fill, stroke);
        drawLayerShape(ctx, li, x, y, Math.max(3, size * 0.42), COLORS.bg, null);
      } else if (kind === 2) {
        // Teleporter (nested verdigris frame)
        ctx.strokeStyle = pMuted ? COLORS.surface : (isIdle ? COLORS.ink : COLORS.active);
        ctx.lineWidth = 2;
        ctx.strokeRect(x - size, y - size, size * 2, size * 2);
        ctx.strokeRect(x - Math.round(size * 0.5), y - Math.round(size * 0.5), size, size);
      } else if (kind === 3) {
        // Bell — distinct silhouette per layer + 2-frame #F2ECE1 flash on hit
        const isFlashing = flash > 0 && !isIdle;
        const fill = isFlashing ? COLORS.ink : (pMuted ? COLORS.bg : COLORS.surface);
        const stroke = pMuted ? COLORS.surface : (isFlashing ? COLORS.ink : (isSoloed ? accentColor : COLORS.ink));
        drawLayerShape(ctx, li, x, y, size, fill, stroke);
        if (!pMuted && !isFlashing) {
          ctx.fillStyle = isSoloed ? accentColor : COLORS.ink;
          ctx.fillRect(x - 2, y - 2, 4, 4);
        }
      }

      if (layerLocked) {
        drawPinhead(ctx, x, y - size - 4, COLORS.accent);
      }

      flatPartIdx++;
    }
  }

  // Draw droplets (live physics in soloed chamber, deterministic keyframes in idle offspring)
  if (!isIdle) {
    if (isSoloed && droplets) {
      for (let i = 0; i < 48; i++) {
        const b = i * 8;
        if (droplets[b] < 0.5) continue;
        const dLayer = Math.round(droplets[b + 1]);
        const dx = px(droplets[b + 2]);
        const dy = px(droplets[b + 3]);
        drawLayerShape(ctx, dLayer, dx, dy, 4.5, COLORS.accent, COLORS.bg);
      }
    } else if (!isSoloed && keyframes && keyframes.length >= 49) {
      const f = (kfFrame || 0) % 60;
      const base = f * 49;
      const cnt = Math.min(16, Math.floor(keyframes[base]));
      for (let i = 0; i < cnt; i++) {
        const off = base + 1 + i * 3;
        const dLayer = Math.round(keyframes[off]);
        const dx = px(keyframes[off + 1]);
        const dy = px(keyframes[off + 2]);
        drawLayerShape(ctx, dLayer, dx, dy, 3.5, COLORS.ink, null);
      }
    }
  }

  // Selected part: 32px outward rotation arc + floating pitch/layer badge
  if (selectedPart && isSoloed) {
    const li = LAYER_KEYS.indexOf(selectedPart.layerKey);
    const layer = genome[selectedPart.layerKey];
    const target = selectedPart.isEmitter ? layer.e : layer.p[selectedPart.index];
    if (target) {
      const worldX = selectedPart.isEmitter ? target[0] : target[1];
      const worldY = selectedPart.isEmitter ? target[1] : target[2];
      const tx = px(worldX);
      const ty = px(worldY);
      const deg = selectedPart.isEmitter ? target[2] : target[3];
      const rad = (deg * Math.PI) / 180;
      const r = Math.max(24, arcOffsetCanvas);

      // Show rotation arc for emitters and ramps
      const rotatable = selectedPart.isEmitter || target[0] === 0;
      if (rotatable) {
        ctx.strokeStyle = accentColor;
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.arc(tx, ty, r, rad - 0.9, rad + 0.9);
        ctx.stroke();
        ctx.setLineDash([]);

        const hx = Math.round(tx + Math.cos(rad) * r);
        const hy = Math.round(ty + Math.sin(rad) * r);
        ctx.fillStyle = accentColor;
        ctx.fillRect(hx - 6, hy - 6, 12, 12);
        ctx.fillStyle = COLORS.bg;
        ctx.fillRect(hx - 2, hy - 2, 4, 4);
      } else {
        // Highlight ring for non-rotatable bells/bumpers/teleporters
        ctx.strokeStyle = accentColor;
        ctx.lineWidth = 2;
        ctx.setLineDash([3, 3]);
        drawLayerShape(ctx, li, tx, ty, px(target[4]) + 6, null, accentColor);
        ctx.setLineDash([]);
      }

      // Floating musical label badge (--cw-bg ink on --cw-accent fill)
      let label = LAYER_TAGS[li];
      if (!selectedPart.isEmitter) {
        const kind = target[0];
        if (kind === 3 || kind === 1) {
          if (li === 1) {
            const pIdx = target[5] < 0 ? spatialPitchFromY(worldY) : Math.abs(Math.floor(target[5]));
            label = `PERC ${DRUM_NAMES[pIdx % 4]}`;
          } else {
            const note = getNoteNameForY(worldY, genome.s || 0);
            label = `${LAYER_TAGS[li]} ${note}`;
          }
        } else if (kind === 0) {
          label = `${LAYER_TAGS[li]} RAMP`;
        } else if (kind === 2) {
          label = `${LAYER_TAGS[li]} PORTAL`;
        }
      } else {
        label = `${LAYER_TAGS[li]} EMIT`;
      }

      if (!dragDeleting) {
        const badgeBg = isIdle ? COLORS.ink : COLORS.accent;
        drawBadge(ctx, tx, ty - (isDragging ? 28 : 24), label, badgeBg, COLORS.bg);
      }
    }
  }

  // Active 4-bar chord badge in top-right of soloed chamber while playing
  if (!isIdle && isSoloed && chordName && !dragDeleting) {
    drawBadge(ctx, CANVAS_SIZE - 34, 14, chordName, COLORS.surface, COLORS.ink);
  }

  // Soloed live oscilloscope OR idle offspring 4px static rhythm barcode
  if (!isIdle && isSoloed && oscData) {
    ctx.strokeStyle = COLORS.accent;
    ctx.lineWidth = 2;
    ctx.beginPath();
    const yBase = CANVAS_SIZE - 16;
    const len = oscData.length;
    for (let i = 0; i < len; i++) {
      const x = (i / (len - 1)) * CANVAS_SIZE;
      const v = (oscData[i] - 128) / 128;
      const y = yBase + v * 14;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  } else if (!isSoloed && barcode && barcode.length === 16) {
    // 4px CSS height -> 8px canvas height static rhythm barcode along bottom
    const barH = 8;
    const y0 = CANVAS_SIZE - barH;
    const stepW = CANVAS_SIZE / 16;
    ctx.fillStyle = COLORS.surface;
    ctx.fillRect(0, y0, CANVAS_SIZE, barH);
    for (let i = 0; i < 16; i++) {
      const val = barcode[i];
      if (val > 0.05) {
        ctx.fillStyle = isIdle ? COLORS.ink : (val > 0.65 ? COLORS.accent : COLORS.ink);
        const w = Math.max(2, Math.round((stepW - 4) * Math.min(1, val + 0.25)));
        ctx.fillRect(Math.round(i * stepW + 2), y0 + 1, w, barH - 2);
      }
    }
  }
}

export function renderBreadcrumbThumbnail(canvas, genome) {
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const s = canvas.width / WORLD_SIZE;
  for (const lk of LAYER_KEYS) {
    const layer = genome[lk];
    ctx.fillStyle = COLORS.accent;
    ctx.fillRect(Math.round(layer.e[0] * s), Math.round(layer.e[1] * s), 2, 2);
    ctx.fillStyle = COLORS.ink;
    for (const p of layer.p) {
      ctx.fillRect(Math.round(p[1] * s), Math.round(p[2] * s), 2, 2);
    }
  }
}

export function renderVinylPlatter(canvas, state, spinAngle, encodeProgress, tonearmSpring) {
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  const w = canvas.width;
  const h = canvas.height;
  const cx = w / 2;
  const cy = h / 2;
  const r = w * 0.42;

  ctx.clearRect(0, 0, w, h);

  // Platter disc
  drawPixelCircle(ctx, cx, cy, r, COLORS.bg, COLORS.ink);

  // Spinning groove marker (33 RPM)
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(spinAngle);
  ctx.strokeStyle = COLORS.surface;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.68, 0.2, 2.2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.48, 3.2, 5.2);
  ctx.stroke();
  // Label
  drawPixelCircle(
    ctx,
    0,
    0,
    r * 0.28,
    state === 'complete' ? COLORS.active : (state === 'idle' ? COLORS.ink : COLORS.accent),
    null
  );
  drawPixelCircle(ctx, 0, 0, 3, COLORS.bg, null);
  ctx.restore();

  // 0% -> 100% --cw-active rim progress groove during Encoding MP3 / Complete
  if (state === 'encoding' || state === 'complete') {
    const pct = state === 'complete' ? 1 : Math.max(0, Math.min(1, encodeProgress / 100));
    ctx.strokeStyle = COLORS.active;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(cx, cy, r + 1, -Math.PI / 2, -Math.PI / 2 + pct * Math.PI * 2);
    ctx.stroke();
  }

  // Tonearm with 120ms spring drop animation
  const pivotX = w - 9;
  const pivotY = 10;
  const restAng = Math.PI * 0.52;
  const dropAng = Math.PI * 0.72;
  const armAng = restAng + (dropAng - restAng) * tonearmSpring;
  const armLen = r * 1.15;
  const tipX = Math.round(pivotX + Math.cos(armAng) * armLen);
  const tipY = Math.round(pivotY + Math.sin(armAng) * armLen);

  ctx.strokeStyle = state === 'complete' ? COLORS.active : COLORS.ink;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(pivotX, pivotY);
  ctx.lineTo(tipX, tipY);
  ctx.stroke();

  ctx.fillStyle = COLORS.ink;
  ctx.fillRect(pivotX - 4, pivotY - 4, 8, 8);
  ctx.fillStyle = state === 'complete' ? COLORS.active : COLORS.accent;
  ctx.fillRect(tipX - 3, tipY - 3, 6, 6);
}

export function renderGhostOverlay(canvas, ghost) {
  const ctx = canvas.getContext('2d');
  if (canvas.width !== window.innerWidth || canvas.height !== window.innerHeight) {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!ghost || !ghost.active) return;

  ctx.imageSmoothingEnabled = false;
  // Tethered blueprint line
  ctx.strokeStyle = COLORS.accent;
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  ctx.moveTo(Math.round(ghost.startX), Math.round(ghost.startY));
  ctx.lineTo(Math.round(ghost.x), Math.round(ghost.y));
  ctx.stroke();
  ctx.setLineDash([]);

  // Blueprint ghost box
  const bw = 64;
  const bh = 64;
  const bx = Math.round(ghost.x - bw / 2);
  const by = Math.round(ghost.y - bh / 2);
  ctx.fillStyle = 'rgba(18, 16, 22, 0.85)';
  ctx.fillRect(bx, by, bw, bh);
  ctx.strokeStyle = COLORS.accent;
  ctx.lineWidth = 2;
  ctx.strokeRect(bx, by, bw, bh);

  // Mini blueprint preview
  if (ghost.genome) {
    const s = bw / WORLD_SIZE;
    for (const lk of LAYER_KEYS) {
      const layer = ghost.genome[lk];
      ctx.fillStyle = COLORS.accent;
      ctx.fillRect(Math.round(bx + layer.e[0] * s), Math.round(by + layer.e[1] * s), 3, 3);
      ctx.fillStyle = COLORS.ink;
      for (const p of layer.p) {
        ctx.fillRect(Math.round(bx + p[1] * s), Math.round(by + p[2] * s), 3, 3);
      }
    }
  }
}
