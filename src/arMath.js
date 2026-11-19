// Shared AR math helpers (used by both the compass fallback and WebXR views).
//
// Frames: ENU meters (x = east, y = up, z = -north when mapped into
// Three.js as (east, up, -north)). Bearings are degrees clockwise from north.
import * as THREE from 'three';
import { metersPerDegree } from './geo.js';

export function bearingAndDistance(userLat, userLng, nodeLat, nodeLng) {
    // WGS84 degree lengths (latitude and longitude differ — see geo.js).
    const { mLat, mLng } = metersPerDegree(userLat);
    const east = (nodeLng - userLng) * mLng;
    const north = (nodeLat - userLat) * mLat;
    const dist = Math.sqrt(east * east + north * north);
    const bearing = ((Math.atan2(east, north) * 180) / Math.PI + 360) % 360;

    return { dist, bearing };
}

export const norm180 = (d) => ((d + 540) % 360) - 180;

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Share of the remaining gap to close this frame for exponential easing with
 * time constant `tau` seconds. Depends on real elapsed time only, so the motion
 * is the same at 30, 60, 120 or 144 frames a second.
 */
export const easeK = (dt, tau) => (tau > 0 && dt > 0 ? 1 - Math.exp(-dt / tau) : 1);

/** Orientation slerp rate (1/s) while holding still: filters sensor noise. */
export const ORIENT_RATE_MIN = 18;
/** Orientation slerp rate (1/s) while turning: the nodes stay on the camera picture. */
export const ORIENT_RATE_MAX = 72;
/**
 * Adaptive orientation smoothing rate for a pose `lagDeg` degrees behind the
 * sensor: under ~1 degree (noise) it is ORIENT_RATE_MIN, by ~8 degrees (a real
 * turn) it reaches ORIENT_RATE_MAX. Used as slerp(target, 1 - exp(-rate * dt)).
 */
export const orientRate = (lagDeg) => clamp(ORIENT_RATE_MIN + (lagDeg - 1) * 7.7, ORIENT_RATE_MIN, ORIENT_RATE_MAX);

const _zee = new THREE.Vector3(0, 0, 1);
const _euler = new THREE.Euler();
const _q0 = new THREE.Quaternion();
const _q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5)); // -PI/2 around X

/**
 * Converts device orientation angles (alpha, beta, gamma in degrees)
 * to a Three.js camera quaternion matching the ENU coordinate system
 * (+X = East, +Y = Up, -Z = North).
 *
 * @param {number} alphaDeg - rotation around Z axis [0, 360) (0 = North)
 * @param {number} betaDeg  - rotation around X axis [-180, 180) (pitch, 90 = upright)
 * @param {number} gammaDeg - rotation around Y axis [-90, 90) (roll)
 * @param {number} [screenOrientationDeg=0] - screen orientation angle
 * @returns {THREE.Quaternion|null}
 */
export function deviceOrientationToQuaternion(alphaDeg, betaDeg, gammaDeg, screenOrientationDeg = 0) {
    if (!Number.isFinite(alphaDeg) || !Number.isFinite(betaDeg) || !Number.isFinite(gammaDeg)) {
        return null;
    }
    const alpha = (alphaDeg * Math.PI) / 180;
    const beta = (betaDeg * Math.PI) / 180;
    const gamma = (gammaDeg * Math.PI) / 180;
    const orient = ((screenOrientationDeg || 0) * Math.PI) / 180;

    const q = new THREE.Quaternion();
    _euler.set(beta, alpha, -gamma, 'YXZ');
    q.setFromEuler(_euler);
    q.multiply(_q1); // Camera looks out back of device, not top
    if (orient !== 0) {
        q.multiply(_q0.setFromAxisAngle(_zee, -orient));
    }
    return q;
}

const _yup = new THREE.Vector3(0, 1, 0);
const _fwdScratch = new THREE.Vector3();
// Sensor world (x East, y North, z Up) → three.js world (x East, y Up, z −North).
const _qWorldToThree = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5)); // −90° about X

/**
 * Camera quaternion from the Generic Sensor API's AbsoluteOrientationSensor
 * ([x, y, z, w], device → world with z Up). Unlike a heading + pitch pair this
 * keeps ROLL, so the horizon stays level against the video. The device frame
 * (x right, y top, z out of the screen) already equals the camera frame, so
 * only the world axes need converting.
 */
export function genericSensorToCameraQuaternion(raw, screenAngleDeg = 0) {
    if (!raw || raw.length !== 4) return null;
    for (let i = 0; i < 4; i += 1) if (!Number.isFinite(raw[i])) return null;
    const q = new THREE.Quaternion(raw[0], raw[1], raw[2], raw[3]);
    q.premultiply(_qWorldToThree);
    const orient = ((screenAngleDeg || 0) * Math.PI) / 180;
    if (orient !== 0) q.multiply(_q0.setFromAxisAngle(_zee, -orient));
    return q;
}

/** Compass azimuth (deg clockwise from north, 0..360) the camera quaternion faces. */
export function azimuthDegOfQuaternion(q) {
    _fwdScratch.set(0, 0, -1).applyQuaternion(q);
    return (((Math.atan2(_fwdScratch.x, -_fwdScratch.z) * 180) / Math.PI) + 360) % 360;
}

/**
 * Rotate the camera about world-up so its azimuth increases by `offsetDeg`
 * (in place). Used to cancel a compass error: offset = true − sensed azimuth.
 */
export function applyYawOffset(q, offsetDeg) {
    if (!offsetDeg || !Number.isFinite(offsetDeg)) return q;
    _q0.setFromAxisAngle(_yup, (-offsetDeg * Math.PI) / 180);
    q.premultiply(_q0);
    return q;
}

/**
 * Computes East-North-Up (ENU) offset in Three.js coordinates
 * (+X = East, +Y = Up, -Z = North) from an anchor GPS position.
 * Accepts either {latitude, longitude, elevation} objects or raw numbers.
 *
 * @param {Object|number} anchor - {latitude, longitude, elevation} or anchorLat
 * @param {Object|number} point  - {latitude, longitude, elevation} or pointLat
 * @returns {{ x: number, y: number, z: number, dist: number, bearing: number }}
 */
export function anchorENU(anchor, point) {
    const aLat = typeof anchor === 'object' && anchor !== null ? (anchor.latitude ?? anchor.lat) : Number(arguments[0]);
    const aLng = typeof anchor === 'object' && anchor !== null ? (anchor.longitude ?? anchor.lng) : Number(arguments[1]);
    const pLat = typeof point === 'object' && point !== null ? (point.latitude ?? point.lat) : Number(arguments[2]);
    const pLng = typeof point === 'object' && point !== null ? (point.longitude ?? point.lng) : Number(arguments[3]);
    const aElev = typeof anchor === 'object' && anchor !== null ? (anchor.elevation ?? 0) : Number(arguments[4] ?? 0);
    const pElev = typeof point === 'object' && point !== null ? (point.elevation ?? 0) : Number(arguments[5] ?? 0);

    const { dist, bearing } = bearingAndDistance(aLat, aLng, pLat, pLng);
    const rad = (bearing * Math.PI) / 180;

    return {
        x: Math.sin(rad) * dist,
        y: clamp((Number.isFinite(pElev) ? pElev : 0) - (Number.isFinite(aElev) ? aElev : 0), -3, 3),
        z: -Math.cos(rad) * dist,
        dist,
        bearing,
    };
}


/**
 * Inverse of `anchorENU`: world metres back to GPS coordinates.
 *
 * Undoes the flat-earth projection that `bearingAndDistance` / `anchorENU`
 * apply, so a walked camera position can be reported as a latitude and
 * longitude. That is what lets desktop free-roam reuse every existing HUD
 * distance, arrival check, closest-node search and the YOU line unchanged:
 * they all keep taking a plain {latitude, longitude} user fix.
 *
 * @param {number} anchorLat - anchor latitude (degrees)
 * @param {number} anchorLng - anchor longitude (degrees)
 * @param {number} x - world east offset (metres)
 * @param {number} z - world south offset (metres, i.e. −north)
 * @param {number} [elevation=0] - metres, written through untouched
 * @returns {{ latitude: number, longitude: number, elevation: number }}
 */
export function enuToLatLon(anchorLat, anchorLng, x, z, elevation = 0) {
    const north = -z;
    const { mLat, mLng } = metersPerDegree(anchorLat);

    return {
        latitude: anchorLat + north / mLat,
        longitude: anchorLng + (mLng === 0 ? 0 : x / mLng),
        elevation: Number.isFinite(elevation) ? elevation : 0,
    };
}


// YOU header builder (shared by both AR views): coords, accuracy, nearest
// network node, live camera yaw/pitch. Returns '' with no fix. Callers
// write it through only when changed, so updates are instant yet cheap.
export function buildYouText(user, nodes, motion) {
    if (!user) return '';
    let nearName = '-';
    let nearDist = Infinity;
    for (const n of nodes || []) {
        if (n.latitude === undefined || n.longitude === undefined) continue;
        const r = bearingAndDistance(user.latitude, user.longitude, n.latitude, n.longitude);
        if (r.dist < nearDist) {
            nearDist = r.dist;
            nearName = n.name || (n.type === 'route' ? `route ${n.id}` : n.type);
        }
    }
    const m = motion || {};
    const yawTxt = m.yaw === null || m.yaw === undefined ? '-' : `${Math.round(m.yaw)}°`;
    const pitchTxt = m.pitch === null || m.pitch === undefined ? '-' : `${Math.round(m.pitch)}°`;
    return `YOU ${user.latitude.toFixed(5)}, ${user.longitude.toFixed(5)}`
        + ` · ±${user.accuracy ? `${Math.round(user.accuracy)}` : '-'} m`
        + ` · near ${nearName}${nearDist === Infinity ? '' : ` (${nearDist.toFixed(0)} m)`}`
        + (user.source === 'pin' ? ' · TEST PIN (frozen)' : '')
        + `\nCAM yaw ${yawTxt} · pitch ${pitchTxt}`;
}

// ── Shared AR route styling ──────────────────────────────────────────
// Matches the 2D admin map: route nodes grey. Waypoint spheres are NEVER blue:
// a blue dot means "you are here".
export const ROUTE_COLOR = 0x95a5a6;
export const MAX_ROUTE_SPHERES = 10;

export const SPHERE_SIZE_REF_DIST = 12;
export const SPHERE_SIZE_MIN = 0.25;
export const SPHERE_SIZE_MAX = 1.5;

// Apparent-size compensation: world size proportional to distance so dots
// read the same on screen up close or far (clamped sane at both ends).
export function responsiveScale(distM) {
    if (!Number.isFinite(distM)) return 1;
    return Math.min(SPHERE_SIZE_MAX, Math.max(SPHERE_SIZE_MIN, distM / SPHERE_SIZE_REF_DIST));
}

// ── Sphere pool (individual meshes, shared geometry + material) ───────
// Max 10 nodes — instanced draw calls are slower at this count due to
// full matrix-buffer re-upload overhead. Individual meshes let Three.js
// dirty-flag only what actually changed each frame.
// ── Sphere pool (individual meshes, per-slot materials for fading) ───
// Max 10 nodes — instanced draw calls are slower at this count due to
// full matrix-buffer re-upload overhead. Individual meshes let Three.js
// dirty-flag only what actually changed each frame.
//
// Fading: every slot owns its own inner/outer materials so opacity can
// animate per node. When Dijkstra re-anchors and a stop leaves the route,
// the caller dims its slot instead of hiding it — the node lingers as a dim
// ghost at its real position rather than popping out, and fades back to full
// when it reconnects. `tick(dt)` eases every slot toward its target with an
// ease-in-out cubic, both directions.
//
// Ghost legibility: a uniform 80 % fade erases the grey fill on a dark feed
// while the white rim survives, which reads as a broken node (hollow ring,
// no inside). So the ghost eases the two layers apart — fill settles at ~35 %
// (still clearly a dot), rim at ~15 % (hairline). Every ring on screen keeps
// its grey inside; only fully live vs dimmed varies.
const POOL_INNER_OPACITY = 0.92;
const POOL_OUTER_OPACITY = 0.95;
// Ghost survivors, as a fraction of the full opacities above.
const POOL_GHOST_FILL = 0.38;
const POOL_GHOST_RIM = 0.16;
const POOL_FADE_SECONDS = 0.45;

function easeInOutCubic(x) {
    const t = Math.min(1, Math.max(0, x));
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export function createSpherePool(count, innerRadius, innerColor, outlineColor, segments = 12, outlineScale = 1.25) {
    const outlineRadius = innerRadius * outlineScale;
    const innerGeo = new THREE.SphereGeometry(innerRadius, segments, segments);
    const outerGeo = new THREE.SphereGeometry(outlineRadius, segments, segments);

    const group = new THREE.Group();
    const meshes = [];
    const innerMats = [];
    const outerMats = [];
    // fade: 0 = invisible, 1 = full (drives hidden <-> shown).
    // ghostMix: 0 = live, 1 = fully ghosted (dims the result on top).
    // wantGhost: where ghostMix is easing toward.
    const fade = [];
    const target = [];
    const ghostMix = [];
    const wantGhost = [];
    const placed = [];
    for (let i = 0; i < count; i += 1) {
        const innerMat = new THREE.MeshBasicMaterial({ color: innerColor, transparent: true, opacity: 0 });
        // The outline shell must never write depth: it is transparent overlay
        // like everything else in the scene, and a depth-writing shell can
        // swallow the fill of a nearby marker during transparent sorting,
        // leaving a hollow ring with no grey inside.
        const outerMat = new THREE.MeshBasicMaterial({ color: outlineColor, side: THREE.BackSide, transparent: true, opacity: 0, depthWrite: false });
        const g = new THREE.Group();
        g.add(new THREE.Mesh(innerGeo, innerMat));
        g.add(new THREE.Mesh(outerGeo, outerMat));
        g.visible = false;
        group.add(g);
        meshes.push(g);
        innerMats.push(innerMat);
        outerMats.push(outerMat);
        fade.push(0);
        target.push(0);
        ghostMix.push(0);
        wantGhost.push(false);
        placed.push(false);
    }

    const applyOpacity = (i) => {
        const e = easeInOutCubic(fade[i]);
        innerMats[i].opacity = POOL_INNER_OPACITY * e * (1 - ghostMix[i] * (1 - POOL_GHOST_FILL));
        outerMats[i].opacity = POOL_OUTER_OPACITY * e * (1 - ghostMix[i] * (1 - POOL_GHOST_RIM));
    };

    return {
        group,
        setSlot(i, x, y, z, s = 1) {
            const m = meshes[i];
            m.position.set(x, y, z);
            m.scale.setScalar(s);
            m.visible = true;
            placed[i] = true;
            // Full opacity target — a reconnecting ghost eases back up in tick.
            // A brand-new slot starts from 0, so first paint fades in too.
            target[i] = 1;
            wantGhost[i] = false;
        },
        // Off-route stop: keep it drawn as a dim ghost instead of hiding it
        // outright. No-op on never-placed slots so the pool origin never
        // sprouts a blob.
        dimSlot(i) {
            if (!placed[i]) return;
            meshes[i].visible = true;
            wantGhost[i] = true;
        },
        // Fully dismiss: eases to invisible, then visible = false in tick.
        hideSlot(i) {
            if (!placed[i]) {
                meshes[i].visible = false;
                return;
            }
            target[i] = 0;
            wantGhost[i] = false;
        },
        // True once the slot holds nothing drawable (never placed, or its
        // fade-out finished) — safe to recycle for a new node.
        isSlotFree(i) {
            return !placed[i];
        },
        // Advance every in-flight fade. Must be called once per frame.
        tick(dt) {
            const step = Number.isFinite(dt) && dt > 0 ? dt / POOL_FADE_SECONDS : 0;
            if (step <= 0) return;
            for (let i = 0; i < count; i += 1) {
                if (!placed[i]) continue;
                let dirty = false;
                if (fade[i] !== target[i]) {
                    fade[i] += Math.sign(target[i] - fade[i]) * Math.min(Math.abs(target[i] - fade[i]), step);
                    dirty = true;
                }
                const want = wantGhost[i] ? 1 : 0;
                if (ghostMix[i] !== want) {
                    ghostMix[i] += Math.sign(want - ghostMix[i]) * Math.min(Math.abs(want - ghostMix[i]), step);
                    dirty = true;
                }
                if (dirty) applyOpacity(i);
                if (target[i] === 0 && fade[i] <= 0) {
                    fade[i] = 0;
                    applyOpacity(i);
                    meshes[i].visible = false;
                    placed[i] = false;
                }
            }
        },
        // scaleFn unused — kept for API compat; callers pass null
        updateScales() {},
        getPosition(i) { return meshes[i].position; },
        dispose() {
            innerGeo.dispose(); outerGeo.dispose();
            for (let i = 0; i < count; i += 1) {
                innerMats[i].dispose();
                outerMats[i].dispose();
            }
        },
    };
}

// Split remaining path stops (from idx to the end) into plain grey route
// mids plus the green destination (last node, only when it's a location).
export function splitRemaining(path, idx, maxMids = MAX_ROUTE_SPHERES) {
    const remaining = path.slice(idx);
    if (remaining.length === 0) return { mids: [], dest: null };
    const last = remaining[remaining.length - 1];
    const isDest = last.type === 'location';
    const mids = (isDest ? remaining.slice(0, -1) : remaining).slice(0, maxMids);

    return { mids, dest: isDest ? last : null };
}

// Text pill sprite for the destination label (canvas texture, always faces
// the camera, drawn on top). Caller owns disposal (texture + material).
export function createLabelSprite(text, bg = 'rgba(214,27,27,0.92)') {
    const fontPx = 44;
    const pad = 22;
    const font = `700 ${fontPx}px -apple-system, 'Segoe UI', sans-serif`;
    const meas = document.createElement('canvas').getContext('2d');
    meas.font = font;
    const w = Math.ceil(meas.measureText(text).width) + pad * 2;
    const h = fontPx + pad * 2;
    const canvas = document.createElement('canvas');
    const scale = 2; // crisp on hidpi
    canvas.width = w * scale;
    canvas.height = h * scale;
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);
    // Rounded pill (manual arcs — no roundRect dependency).
    const r = h / 2;
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.moveTo(r, 0);
    ctx.lineTo(w - r, 0);
    ctx.arc(w - r, r, r, -Math.PI / 2, Math.PI / 2);
    ctx.lineTo(r, h);
    ctx.arc(r, r, r, Math.PI / 2, (Math.PI * 3) / 2);
    ctx.closePath();
    ctx.fill();
    ctx.font = font;
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, pad, h / 2 + 2);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
    const sprite = new THREE.Sprite(mat);
    const worldH = 1.1;
    sprite.scale.set((worldH * w) / h, worldH, 1);
    sprite.renderOrder = 999;

    return sprite;
}
