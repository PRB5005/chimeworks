// ChimeWorks (32-Bit Edition) — Zero-Dependency Fixed-Timestep 2D Physics Engine
// Compile: rustc --edition=2021 --target wasm32-unknown-unknown --crate-type=cdylib -O wasm/physics.rs -o src/physics.wasm

use core::ptr::addr_of_mut;

const WORLD_W: f32 = 160.0;
const WORLD_H: f32 = 160.0;
const DT: f32 = 1.0 / 60.0;
const GRAVITY: f32 = 240.0;
const DROP_RADIUS: f32 = 3.0;
const DROP_TTL: f32 = 300.0;
const MAX_SPEED: f32 = 210.0;

const MAX_EMITTERS: usize = 6;
const EMITTER_STRIDE: usize = 8; // [active, layer, x, y, angle, speed, rate, muted]

const MAX_PARTS: usize = 32;
const PART_STRIDE: usize = 9; // [active, kind, layer, x, y, angle, size, param, muted]

const MAX_DROPLETS: usize = 48;
const DROPLET_STRIDE: usize = 8; // [active, layer, x, y, vx, vy, ttl, tp_cd]

const MAX_EVENTS: usize = 512;
const EVENT_STRIDE: usize = 7; // [tick, layer, kind, part_idx, pitch, x_norm, vel]

const MAX_KEYFRAMES: usize = 64;
const KF_MAX_DROPS: usize = 16;
const KF_STRIDE: usize = 1 + KF_MAX_DROPS * 3; // [count, l0, x0, y0, ...]

const METRICS_LEN: usize = 8; // [total, bass, perc, mel, unique_pitches, avg_ioi, ioi_var, bumper_hits]
const BARCODE_LEN: usize = 16;

static mut EMITTERS: [f32; MAX_EMITTERS * EMITTER_STRIDE] = [0.0; MAX_EMITTERS * EMITTER_STRIDE];
static mut PARTS: [f32; MAX_PARTS * PART_STRIDE] = [0.0; MAX_PARTS * PART_STRIDE];
static mut DROPLETS: [f32; MAX_DROPLETS * DROPLET_STRIDE] = [0.0; MAX_DROPLETS * DROPLET_STRIDE];
static mut EVENTS: [f32; MAX_EVENTS * EVENT_STRIDE] = [0.0; MAX_EVENTS * EVENT_STRIDE];
static mut KEYFRAMES: [f32; MAX_KEYFRAMES * KF_STRIDE] = [0.0; MAX_KEYFRAMES * KF_STRIDE];
static mut METRICS: [f32; METRICS_LEN] = [0.0; METRICS_LEN];
static mut BARCODE: [f32; BARCODE_LEN] = [0.0; BARCODE_LEN];

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
pub extern "C" fn reset_world() {
    unsafe {
        let drops = &mut *addr_of_mut!(DROPLETS);
        for v in drops.iter_mut() {
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
    evs[base + 6] = clamp(vel / 160.0, 0.15, 1.0);
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

unsafe fn step_one_tick() {
    let cur_tick = TICK;
    let emitters = &*addr_of_mut!(EMITTERS);
    let parts = &*addr_of_mut!(PARTS);

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
            let vx = ang.cos() * spd;
            let vy = ang.sin() * spd;
            spawn_droplet(layer, x, y, vx, vy);
        }
    }

    // 2. Integrate droplets & resolve same-layer collisions
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
        let mut ttl = drops[db + 6] - 1.0;
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

        // Chamber side wall bounce (top/sides bounce softly, bottom exits)
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

        // Collide only with parts on the exact same non-colliding layer
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
            let pparam = parts[pb + 7] as i32;
            let pmuted = parts[pb + 8] >= 0.5;

            match kind {
                // 0: Ramp (oriented line segment)
                0 => {
                    let cos_a = pang.cos();
                    let sin_a = pang.sin();
                    let dx = x - px;
                    let dy = y - py;
                    let local_x = dx * cos_a + dy * sin_a;
                    let local_y = -dx * sin_a + dy * cos_a;
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
                            let _ = local_y;
                        }
                    }
                }
                // 1: Bumper (radial boost + percussive trigger)
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
                            let new_spd = clamp(sqrt_f32(vx * vx + vy * vy) * 1.12, 75.0, MAX_SPEED);
                            let cur_spd = sqrt_f32(vx * vx + vy * vy).max(1e-4);
                            vx = vx / cur_spd * new_spd;
                            vy = vy / cur_spd * new_spd;
                            x = px + nx * (hit_r + 0.25);
                            y = py + ny * (hit_r + 0.25);
                            if !pmuted {
                                push_event(cur_tick, d_layer as u32, 1, p as u32, pparam.max(0) as u32, x, impact);
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
                            if let Some((tx, ty)) = find_teleporter_partner(p, d_layer, pparam) {
                                x = tx;
                                y = ty;
                                tp_cd = 16.0;
                                if !pmuted {
                                    push_event(cur_tick, d_layer as u32, 2, p as u32, 0, tx, 60.0);
                                }
                            }
                        }
                    }
                }
                // 3: Bell (musical note trigger + chime bounce)
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
                            let restitution = 0.82;
                            vx -= (1.0 + restitution) * vn * nx;
                            vy -= (1.0 + restitution) * vn * ny;
                            x = px + nx * (hit_r + 0.2);
                            y = py + ny * (hit_r + 0.2);
                            if !pmuted {
                                push_event(cur_tick, d_layer as u32, 3, p as u32, pparam.max(0) as u32, x, impact);
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