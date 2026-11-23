// ChimeWorks (32-Bit Edition) — Musical Fixed-Timestep 2D Physics Engine
// Upgrades: 133ms per-part debounce, Y-mapped spatial pitch tuning, non-destructive
// trajectory path tracer (for live aiming previews & trajectory-aware evolution).
// Compile: rustc --edition=2021 --target wasm32-unknown-unknown --crate-type=cdylib -O wasm/physics.rs -o src/physics.wasm

use core::ptr::addr_of_mut;

const WORLD_W: f32 = 160.0;
const WORLD_H: f32 = 160.0;
const DT: f32 = 1.0 / 60.0;
const GRAVITY: f32 = 240.0;
const DROP_RADIUS: f32 = 3.0;
const DROP_TTL: f32 = 300.0;
const MAX_SPEED: f32 = 210.0;
const PART_COOLDOWN_TICKS: f32 = 8.0; // ~133ms at 60 Hz to prevent buzzing/machine-gunning

const MAX_EMITTERS: usize = 6;
const EMITTER_STRIDE: usize = 8; // [active, layer, x, y, angle, speed, rate, muted]

const MAX_PARTS: usize = 32;
const PART_STRIDE: usize = 9; // [active, kind, layer, x, y, angle, size, param, muted]
                              // param < 0.0 => spatial pitch derived from part Y height

const MAX_DROPLETS: usize = 48;
const DROPLET_STRIDE: usize = 8; // [active, layer, x, y, vx, vy, ttl, tp_cd]

const MAX_EVENTS: usize = 512;
const EVENT_STRIDE: usize = 7; // [tick, layer, kind, part_idx, pitch, x_norm, vel]

const MAX_KEYFRAMES: usize = 64;
const KF_MAX_DROPS: usize = 16;
const KF_STRIDE: usize = 1 + KF_MAX_DROPS * 3; // [count, l0, x0, y0, ...]

const METRICS_LEN: usize = 8; // [total, bass, perc, mel, unique_pitches, avg_ioi, ioi_var, bumper_hits]
const BARCODE_LEN: usize = 16;

// Trajectory preview buffer: 3 layers, each [count, x0, y0, x1, y1, ... up to 90 pts]
const TRAJ_LAYERS: usize = 3;
const TRAJ_MAX_PTS: usize = 90;
const TRAJ_LAYER_STRIDE: usize = 1 + TRAJ_MAX_PTS * 2; // 181 f32s per layer
const TRAJ_TOTAL_LEN: usize = TRAJ_LAYERS * TRAJ_LAYER_STRIDE; // 543 f32s

static mut EMITTERS: [f32; MAX_EMITTERS * EMITTER_STRIDE] = [0.0; MAX_EMITTERS * EMITTER_STRIDE];
static mut PARTS: [f32; MAX_PARTS * PART_STRIDE] = [0.0; MAX_PARTS * PART_STRIDE];
static mut PART_COOLDOWN: [f32; MAX_PARTS] = [0.0; MAX_PARTS];
static mut DROPLETS: [f32; MAX_DROPLETS * DROPLET_STRIDE] = [0.0; MAX_DROPLETS * DROPLET_STRIDE];
static mut EVENTS: [f32; MAX_EVENTS * EVENT_STRIDE] = [0.0; MAX_EVENTS * EVENT_STRIDE];
static mut KEYFRAMES: [f32; MAX_KEYFRAMES * KF_STRIDE] = [0.0; MAX_KEYFRAMES * KF_STRIDE];
static mut METRICS: [f32; METRICS_LEN] = [0.0; METRICS_LEN];
static mut BARCODE: [f32; BARCODE_LEN] = [0.0; BARCODE_LEN];
static mut TRAJECTORY: [f32; TRAJ_TOTAL_LEN] = [0.0; TRAJ_TOTAL_LEN];

static mut TICK: u32 = 0;
static mut EVENT_COUNT: u32 = 0;

#[inline]
fn clamp(v: f32, lo: f32, hi: f32) -> f32 {
    if v < lo {
        lo
    } else if v > hi {
        hi
    } else {
        v
    }
}

#[inline]
fn sqrt_f32(x: f32) -> f32 {
    if x <= 0.0 {
        return 0.0;
    }
    x.sqrt()
}

/// Maps vertical Y coordinate (16..144) to scale degree (14 at top -> 0 at bottom).
#[inline]
fn spatial_pitch_from_y(y: f32) -> u32 {
    let norm = 1.0 - clamp((y - 16.0) / 128.0, 0.0, 1.0);
    let idx = (norm * 14.0 + 0.5) as i32;
    clamp(idx as f32, 0.0, 14.0) as u32
}

#[no_mangle]
pub extern "C" fn get_emitters_ptr() -> *mut f32 {
    unsafe { addr_of_mut!(EMITTERS) as *mut f32 }
}

#[no_mangle]
pub extern "C" fn get_parts_ptr() -> *mut f32 {
    unsafe { addr_of_mut!(PARTS) as *mut f32 }
}

#[no_mangle]
pub extern "C" fn get_droplets_ptr() -> *mut f32 {
    unsafe { addr_of_mut!(DROPLETS) as *mut f32 }
}

#[no_mangle]
pub extern "C" fn get_events_ptr() -> *mut f32 {
    unsafe { addr_of_mut!(EVENTS) as *mut f32 }
}

#[no_mangle]
pub extern "C" fn get_keyframes_ptr() -> *mut f32 {
    unsafe { addr_of_mut!(KEYFRAMES) as *mut f32 }
}

#[no_mangle]
pub extern "C" fn get_metrics_ptr() -> *mut f32 {
    unsafe { addr_of_mut!(METRICS) as *mut f32 }
}

#[no_mangle]
pub extern "C" fn get_barcode_ptr() -> *mut f32 {
    unsafe { addr_of_mut!(BARCODE) as *mut f32 }
}

#[no_mangle]
pub extern "C" fn get_trajectory_ptr() -> *mut f32 {
    unsafe { addr_of_mut!(TRAJECTORY) as *mut f32 }
}

#[no_mangle]
pub extern "C" fn reset_world() {
    unsafe {
        let drops = &mut *addr_of_mut!(DROPLETS);
        for v in drops.iter_mut() {
            *v = 0.0;
        }
        let cd = &mut *addr_of_mut!(PART_COOLDOWN);
        for v in cd.iter_mut() {
            *v = 0.0;
        }
        let evs = &mut *addr_of_mut!(EVENTS);
        for v in evs.iter_mut() {
            *v = 0.0;
        }
        let kfs = &mut *addr_of_mut!(KEYFRAMES);
        for v in kfs.iter_mut() {
            *v = 0.0;
        }
        let met = &mut *addr_of_mut!(METRICS);
        for v in met.iter_mut() {
            *v = 0.0;
        }
        let bar = &mut *addr_of_mut!(BARCODE);
        for v in bar.iter_mut() {
            *v = 0.0;
        }
        TICK = 0;
        EVENT_COUNT = 0;
    }
}

#[no_mangle]
pub extern "C" fn clear_config() {
    unsafe {
        let em = &mut *addr_of_mut!(EMITTERS);
        for v in em.iter_mut() {
            *v = 0.0;
        }
        let pa = &mut *addr_of_mut!(PARTS);
        for v in pa.iter_mut() {
            *v = 0.0;
        }
    }
    reset_world();
}

unsafe fn push_event(tick: u32, layer: u32, kind: u32, part_idx: u32, pitch: u32, x: f32, vel: f32) {
    let idx = EVENT_COUNT as usize;
    if idx >= MAX_EVENTS {
        return;
    }
    let evs = &mut *addr_of_mut!(EVENTS);
    let base = idx * EVENT_STRIDE;
    evs[base] = tick as f32;
    evs[base + 1] = layer as f32;
    evs[base + 2] = kind as f32;
    evs[base + 3] = part_idx as f32;
    evs[base + 4] = pitch as f32;
    evs[base + 5] = clamp(x / WORLD_W, 0.0, 1.0);
    evs[base + 6] = clamp(vel / 160.0, 0.2, 1.0);
    EVENT_COUNT += 1;
}

unsafe fn spawn_droplet(layer: f32, x: f32, y: f32, vx: f32, vy: f32) {
    let drops = &mut *addr_of_mut!(DROPLETS);
    for i in 0..MAX_DROPLETS {
        let b = i * DROPLET_STRIDE;
        if drops[b] < 0.5 {
            drops[b] = 1.0;
            drops[b + 1] = layer;
            drops[b + 2] = x;
            drops[b + 3] = y;
            drops[b + 4] = vx;
            drops[b + 5] = vy;
            drops[b + 6] = DROP_TTL;
            drops[b + 7] = 0.0;
            return;
        }
    }
}

unsafe fn find_teleporter_partner(self_idx: usize, layer: i32, param: i32) -> Option<(f32, f32)> {
    let parts = &*addr_of_mut!(PARTS);
    let mut layer_tp_count = 0i32;
    let mut fallback: Option<(f32, f32)> = None;
    for j in 0..MAX_PARTS {
        let pb = j * PART_STRIDE;
        if parts[pb] < 0.5 {
            continue;
        }
        let kind = parts[pb + 1] as i32;
        let p_layer = parts[pb + 2] as i32;
        if kind == 2 && p_layer == layer {
            if j != self_idx {
                if layer_tp_count == param {
                    return Some((parts[pb + 3], parts[pb + 4]));
                }
                if fallback.is_none() {
                    fallback = Some((parts[pb + 3], parts[pb + 4]));
                }
            }
            layer_tp_count += 1;
        }
    }
    fallback
}

/// Core droplet integration & collision step shared by live simulation and trajectory tracing.
unsafe fn integrate_droplets(cur_tick: u32, emit_events: bool) {
    let parts = &*addr_of_mut!(PARTS);
    let cooldowns = &mut *addr_of_mut!(PART_COOLDOWN);
    for cd in cooldowns.iter_mut() {
        if *cd > 0.0 {
            *cd -= 1.0;
        }
    }

    let drops = &mut *addr_of_mut!(DROPLETS);
    for d in 0..MAX_DROPLETS {
        let db = d * DROPLET_STRIDE;
        if drops[db] < 0.5 {
            continue;
        }
        let d_layer = drops[db + 1] as i32;
        let mut x = drops[db + 2];
        let mut y = drops[db + 3];
        let mut vx = drops[db + 4];
        let mut vy = drops[db + 5];
        let ttl = drops[db + 6] - 1.0;
        let mut tp_cd = if drops[db + 7] > 0.0 { drops[db + 7] - 1.0 } else { 0.0 };

        vy += GRAVITY * DT;
        let spd = sqrt_f32(vx * vx + vy * vy);
        if spd > MAX_SPEED {
            let s = MAX_SPEED / spd;
            vx *= s;
            vy *= s;
        }

        x += vx * DT;
        y += vy * DT;

        // Chamber wall bounces (bottom exits cleanly)
        if x < DROP_RADIUS {
            x = DROP_RADIUS;
            vx = vx.abs() * 0.78;
        } else if x > WORLD_W - DROP_RADIUS {
            x = WORLD_W - DROP_RADIUS;
            vx = -vx.abs() * 0.78;
        }
        if y < DROP_RADIUS {
            y = DROP_RADIUS;
            vy = vy.abs() * 0.72;
        }
        if y > WORLD_H + 6.0 || ttl <= 0.0 {
            drops[db] = 0.0;
            continue;
        }

        // Collide only with parts on the same non-colliding layer
        for p in 0..MAX_PARTS {
            let pb = p * PART_STRIDE;
            if parts[pb] < 0.5 {
                continue;
            }
            if (parts[pb + 2] as i32) != d_layer {
                continue;
            }
            let kind = parts[pb + 1] as u32;
            let px = parts[pb + 3];
            let py = parts[pb + 4];
            let pang = parts[pb + 5];
            let psize = parts[pb + 6];
            let raw_param = parts[pb + 7];
            let pmuted = parts[pb + 8] >= 0.5;

            match kind {
                // 0: Ramp (oriented line segment)
                0 => {
                    let cos_a = pang.cos();
                    let sin_a = pang.sin();
                    let dx = x - px;
                    let dy = y - py;
                    let local_x = dx * cos_a + dy * sin_a;
                    let clamped_x = clamp(local_x, -psize, psize);
                    let cx = px + clamped_x * cos_a;
                    let cy = py + clamped_x * sin_a;
                    let rx = x - cx;
                    let ry = y - cy;
                    let dist_sq = rx * rx + ry * ry;
                    let hit_r = DROP_RADIUS + 2.2;
                    if dist_sq < hit_r * hit_r && dist_sq > 1e-6 {
                        let dist = sqrt_f32(dist_sq);
                        let nx = rx / dist;
                        let ny = ry / dist;
                        let vn = vx * nx + vy * ny;
                        if vn < 0.0 {
                            let restitution = 0.86;
                            vx -= (1.0 + restitution) * vn * nx;
                            vy -= (1.0 + restitution) * vn * ny;
                            x = cx + nx * (hit_r + 0.15);
                            y = cy + ny * (hit_r + 0.15);
                        }
                    }
                }
                // 1: Bumper (radial boost + percussive trigger with 133ms debounce)
                1 => {
                    let rx = x - px;
                    let ry = y - py;
                    let dist_sq = rx * rx + ry * ry;
                    let hit_r = DROP_RADIUS + psize;
                    if dist_sq < hit_r * hit_r && dist_sq > 1e-6 {
                        let dist = sqrt_f32(dist_sq);
                        let nx = rx / dist;
                        let ny = ry / dist;
                        let vn = vx * nx + vy * ny;
                        if vn < 0.0 {
                            let impact = -vn;
                            vx -= 2.0 * vn * nx;
                            vy -= 2.0 * vn * ny;
                            let cur_spd = sqrt_f32(vx * vx + vy * vy).max(1e-4);
                            let new_spd = clamp(cur_spd * 1.12, 75.0, MAX_SPEED);
                            vx = vx / cur_spd * new_spd;
                            vy = vy / cur_spd * new_spd;
                            x = px + nx * (hit_r + 0.25);
                            y = py + ny * (hit_r + 0.25);
                            if emit_events && !pmuted && cooldowns[p] <= 0.0 {
                                cooldowns[p] = PART_COOLDOWN_TICKS;
                                let pitch = if raw_param < 0.0 {
                                    spatial_pitch_from_y(py)
                                } else {
                                    raw_param as u32
                                };
                                push_event(cur_tick, d_layer as u32, 1, p as u32, pitch, x, impact);
                            }
                        }
                    }
                }
                // 2: Teleporter (portal pair)
                2 => {
                    if tp_cd <= 0.0 {
                        let rx = x - px;
                        let ry = y - py;
                        let hit_r = DROP_RADIUS + psize;
                        if rx * rx + ry * ry < hit_r * hit_r {
                            if let Some((tx, ty)) = find_teleporter_partner(p, d_layer, raw_param as i32) {
                                x = tx;
                                y = ty;
                                tp_cd = 16.0;
                                if emit_events && !pmuted && cooldowns[p] <= 0.0 {
                                    cooldowns[p] = PART_COOLDOWN_TICKS;
                                    push_event(cur_tick, d_layer as u32, 2, p as u32, 0, tx, 60.0);
                                }
                            }
                        }
                    }
                }
                // 3: Bell (musical note trigger with 133ms debounce & clean bounce)
                3 => {
                    let rx = x - px;
                    let ry = y - py;
                    let dist_sq = rx * rx + ry * ry;
                    let hit_r = DROP_RADIUS + psize;
                    if dist_sq < hit_r * hit_r && dist_sq > 1e-6 {
                        let dist = sqrt_f32(dist_sq);
                        let nx = rx / dist;
                        let ny = ry / dist;
                        let vn = vx * nx + vy * ny;
                        if vn < 0.0 {
                            let impact = -vn;
                            let restitution = 0.84;
                            vx -= (1.0 + restitution) * vn * nx;
                            vy -= (1.0 + restitution) * vn * ny;
                            // Prevent slow droplets from stalling & buzzing on top of a bell
                            if ny < -0.5 && vy > -32.0 {
                                vy = -38.0;
                            }
                            x = px + nx * (hit_r + 0.2);
                            y = py + ny * (hit_r + 0.2);
                            if emit_events && !pmuted && cooldowns[p] <= 0.0 {
                                cooldowns[p] = PART_COOLDOWN_TICKS;
                                let pitch = if raw_param < 0.0 {
                                    spatial_pitch_from_y(py)
                                } else {
                                    raw_param as u32
                                };
                                push_event(cur_tick, d_layer as u32, 3, p as u32, pitch, x, impact);
                            }
                        }
                    }
                }
                _ => {}
            }
        }

        drops[db + 2] = x;
        drops[db + 3] = y;
        drops[db + 4] = vx;
        drops[db + 5] = vy;
        drops[db + 6] = ttl;
        drops[db + 7] = tp_cd;
    }
}

unsafe fn step_one_tick() {
    let cur_tick = TICK;
    let emitters = &*addr_of_mut!(EMITTERS);

    // 1. Emit droplets deterministically
    for i in 0..MAX_EMITTERS {
        let eb = i * EMITTER_STRIDE;
        if emitters[eb] < 0.5 || emitters[eb + 7] >= 0.5 {
            continue;
        }
        let rate = emitters[eb + 6] as u32;
        if rate == 0 {
            continue;
        }
        if cur_tick % rate == 0 {
            let layer = emitters[eb + 1];
            let x = emitters[eb + 2];
            let y = emitters[eb + 3];
            let ang = emitters[eb + 4];
            let spd = emitters[eb + 5];
            spawn_droplet(layer, x, y, ang.cos() * spd, ang.sin() * spd);
        }
    }

    // 2. Integrate droplets & resolve collisions
    integrate_droplets(cur_tick, true);
    TICK = cur_tick + 1;
}

#[no_mangle]
pub extern "C" fn step(n_ticks: u32) -> u32 {
    unsafe {
        EVENT_COUNT = 0;
        for _ in 0..n_ticks {
            step_one_tick();
        }
        EVENT_COUNT
    }
}

/// Non-destructively traces one single-shot droplet flight path per layer (up to 180 ticks)
/// into TRAJECTORY so the UI can draw live aiming arcs and evolution can snap bells onto paths.
#[no_mangle]
pub extern "C" fn trace_trajectories(total_ticks: u32) -> u32 {
    unsafe {
        // Snapshot live state so live playback is never disturbed
        let saved_drops = *addr_of_mut!(DROPLETS);
        let saved_cd = *addr_of_mut!(PART_COOLDOWN);
        let saved_tick = TICK;
        let saved_ev_count = EVENT_COUNT;

        // Clear workspace
        let drops = &mut *addr_of_mut!(DROPLETS);
        for v in drops.iter_mut() {
            *v = 0.0;
        }
        let cd = &mut *addr_of_mut!(PART_COOLDOWN);
        for v in cd.iter_mut() {
            *v = 0.0;
        }
        let traj = &mut *addr_of_mut!(TRAJECTORY);
        for v in traj.iter_mut() {
            *v = 0.0;
        }

        // Spawn 1 probe droplet per active emitter (first emitter per layer 0..2)
        let emitters = &*addr_of_mut!(EMITTERS);
        let mut layer_spawned = [false; TRAJ_LAYERS];
        for i in 0..MAX_EMITTERS {
            let eb = i * EMITTER_STRIDE;
            if emitters[eb] < 0.5 {
                continue;
            }
            let li = emitters[eb + 1] as usize;
            if li < TRAJ_LAYERS && !layer_spawned[li] {
                layer_spawned[li] = true;
                let x = emitters[eb + 2];
                let y = emitters[eb + 3];
                let ang = emitters[eb + 4];
                let spd = emitters[eb + 5];
                spawn_droplet(li as f32, x, y, ang.cos() * spd, ang.sin() * spd);
            }
        }

        let ticks = total_ticks.min((TRAJ_MAX_PTS * 2) as u32);
        let mut counts = [0usize; TRAJ_LAYERS];
        let mut total_pts = 0u32;

        for t in 0..ticks {
            if t % 2 == 0 {
                let d_ref = &*addr_of_mut!(DROPLETS);
                for d in 0..TRAJ_LAYERS {
                    let db = d * DROPLET_STRIDE;
                    if d_ref[db] >= 0.5 {
                        let li = d_ref[db + 1] as usize;
                        if li < TRAJ_LAYERS && counts[li] < TRAJ_MAX_PTS {
                            let idx = li * TRAJ_LAYER_STRIDE + 1 + counts[li] * 2;
                            traj[idx] = d_ref[db + 2];
                            traj[idx + 1] = d_ref[db + 3];
                            counts[li] += 1;
                            total_pts += 1;
                        }
                    }
                }
            }
            integrate_droplets(t, false);
        }

        for li in 0..TRAJ_LAYERS {
            traj[li * TRAJ_LAYER_STRIDE] = counts[li] as f32;
        }

        // Restore live state
        *addr_of_mut!(DROPLETS) = saved_drops;
        *addr_of_mut!(PART_COOLDOWN) = saved_cd;
        TICK = saved_tick;
        EVENT_COUNT = saved_ev_count;

        total_pts
    }
}

unsafe fn record_keyframe(kf_idx: usize) {
    if kf_idx >= MAX_KEYFRAMES {
        return;
    }
    let drops = &*addr_of_mut!(DROPLETS);
    let kfs = &mut *addr_of_mut!(KEYFRAMES);
    let base = kf_idx * KF_STRIDE;
    let mut count = 0usize;
    for d in 0..MAX_DROPLETS {
        let db = d * DROPLET_STRIDE;
        if drops[db] >= 0.5 && count < KF_MAX_DROPS {
            let off = base + 1 + count * 3;
            kfs[off] = drops[db + 1];
            kfs[off + 1] = drops[db + 2];
            kfs[off + 2] = drops[db + 3];
            count += 1;
        }
    }
    kfs[base] = count as f32;
}

#[no_mangle]
pub extern "C" fn rollout(total_ticks: u32, keyframe_stride: u32) -> u32 {
    reset_world();
    let stride = if keyframe_stride == 0 { 4 } else { keyframe_stride };
    unsafe {
        let mut kf_idx = 0usize;
        for t in 0..total_ticks {
            step_one_tick();
            if t % stride == 0 && kf_idx < MAX_KEYFRAMES {
                record_keyframe(kf_idx);
                kf_idx += 1;
            }
        }

        // Compute MAP-Elites metrics & 16-bin rhythm barcode
        let count = EVENT_COUNT as usize;
        let evs = &*addr_of_mut!(EVENTS);
        let bar = &mut *addr_of_mut!(BARCODE);
        let mut bass_ev = 0.0f32;
        let mut perc_ev = 0.0f32;
        let mut mel_ev = 0.0f32;
        let mut bumper_ev = 0.0f32;
        let mut pitch_mask: u32 = 0;
        let mut prev_tick: f32 = -1.0;
        let mut ioi_sum = 0.0f32;
        let mut ioi_sq_sum = 0.0f32;
        let mut ioi_n = 0.0f32;
        let denom = (total_ticks.max(1)) as f32;

        for i in 0..count {
            let b = i * EVENT_STRIDE;
            let tk = evs[b];
            let layer = evs[b + 1] as u32;
            let kind = evs[b + 2] as u32;
            let pitch = (evs[b + 4] as u32) & 31;

            if kind == 3 || kind == 1 {
                match layer {
                    0 => bass_ev += 1.0,
                    1 => perc_ev += 1.0,
                    _ => mel_ev += 1.0,
                }
                if kind == 1 {
                    bumper_ev += 1.0;
                }
                if kind == 3 {
                    pitch_mask |= 1u32 << pitch;
                }
                let bin = ((tk / denom) * (BARCODE_LEN as f32)) as usize;
                let bin_c = if bin >= BARCODE_LEN { BARCODE_LEN - 1 } else { bin };
                bar[bin_c] += 1.0;

                if prev_tick >= 0.0 {
                    let dt = tk - prev_tick;
                    if dt > 0.0 {
                        ioi_sum += dt;
                        ioi_sq_sum += dt * dt;
                        ioi_n += 1.0;
                    }
                }
                prev_tick = tk;
            }
        }

        // Normalize barcode to 0..1
        let mut max_bin = 1.0f32;
        for v in bar.iter() {
            if *v > max_bin {
                max_bin = *v;
            }
        }
        for v in bar.iter_mut() {
            *v /= max_bin;
        }

        let avg_ioi = if ioi_n > 0.0 { ioi_sum / ioi_n } else { denom };
        let ioi_var = if ioi_n > 1.0 {
            (ioi_sq_sum / ioi_n - avg_ioi * avg_ioi).max(0.0)
        } else {
            0.0
        };

        let met = &mut *addr_of_mut!(METRICS);
        met[0] = bass_ev + perc_ev + mel_ev;
        met[1] = bass_ev;
        met[2] = perc_ev;
        met[3] = mel_ev;
        met[4] = pitch_mask.count_ones() as f32;
        met[5] = avg_ioi;
        met[6] = ioi_var;
        met[7] = bumper_ev;

        EVENT_COUNT
    }
}

#[no_mangle]
pub extern "C" fn checksum() -> u32 {
    unsafe {
        let mut h: u32 = 2166136261;
        let evs = &*addr_of_mut!(EVENTS);
        let n = (EVENT_COUNT as usize).min(MAX_EVENTS) * EVENT_STRIDE;
        for i in 0..n {
            let bits = evs[i].to_bits();
            h ^= bits;
            h = h.wrapping_mul(16777619);
        }
        let drops = &*addr_of_mut!(DROPLETS);
        for v in drops.iter() {
            let bits = v.to_bits();
            h ^= bits;
            h = h.wrapping_mul(16777619);
        }
        let met = &*addr_of_mut!(METRICS);
        for v in met.iter() {
            let bits = v.to_bits();
            h ^= bits;
            h = h.wrapping_mul(16777619);
        }
        h
    }
}
