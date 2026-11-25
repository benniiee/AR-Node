// Campus objects: trees, benches, sheds and gates (app/Models/CampusObject.php), placed by an admin
// like buildings in a city-builder game. Shared by the 2D map, the 3D views, shade routing and the
// router (a gate is an opening in a wall).
//
// A tree's exact look comes from its `seed`: the same seed always gives the same tree, so the map,
// the 3D views and the shadow agree, and "New look" in the editor just picks another seed.
import { toLocalMeters, fromLocalMeters } from './geo.js';
import { shadowOffsetM } from './sunShadow.js';

/** The kinds the editor offers, with the sizes a new one starts with (metres). */
export const OBJECT_KINDS = [
    { value: 'tree', label: 'Tree', defaults: { height_m: 6, width_m: 5, form: 'round' } },
    { value: 'bench', label: 'Bench', defaults: { length_m: 1.8, width_m: 0.5, height_m: 0.45 } },
    { value: 'shed', label: 'Shed', defaults: { width_m: 3, length_m: 4, height_m: 2.6 } },
    { value: 'gate', label: 'Gate', defaults: { width_m: 3, height_m: 2.2 } },
];

/** A tree's overall shape (CampusObject::TREE_FORMS). */
export const TREE_FORMS = [
    { value: 'round', label: 'Round (like a mango tree)' },
    { value: 'spreading', label: 'Spreading (like an acacia)' },
    { value: 'tall', label: 'Tall and narrow' },
    { value: 'palm', label: 'Palm' },
];

/** A gate dropped within this distance (metres) of a wall sits on it and opens it. */
export const GATE_SNAP_M = 8;

export const kindLabel = (kind) => OBJECT_KINDS.find((k) => k.value === kind)?.label || 'Object';

/** The fields a new object of `kind` starts with (a fresh seed included). */
export function objectDefaults(kind) {
    return { kind, rotation_deg: 0, ...(OBJECT_KINDS.find((k) => k.value === kind)?.defaults || {}), seed: newSeed() };
}

/** A random seed for a new look. */
export const newSeed = () => 1 + Math.floor(Math.random() * 2147483646);

/** A small seeded random generator (mulberry32): same seed, same numbers. */
export function seededRandom(seed) {
    let a = (Number(seed) || 1) >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const num = (v, fallback) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : fallback);

/**
 * A tree's shape in metres around its base (east, north, up): the trunk, and the crown as a cluster of
 * round puffs (a palm: fronds from the top of a tall trunk). Same object, same shape.
 *
 * @returns {{ trunkH: number, trunkR: number, lean: {e:number,n:number}, crownR: number, crownBase: number,
 *   crownTop: number, puffs: Array<{e:number,n:number,u:number,r:number}>, fronds: Array<{dir:number,len:number,droop:number}> }}
 */
export function treeModel(obj) {
    const rand = seededRandom(obj.seed);
    const h = num(obj.height_m, 6);
    const w = num(obj.width_m, 5);
    const form = obj.form || 'round';
    const lean = { e: (rand() - 0.5) * 0.06 * h, n: (rand() - 0.5) * 0.06 * h };
    const puffs = [];
    const fronds = [];
    let trunkH;
    let crownR;
    if (form === 'palm') {
        trunkH = h * 0.92;
        crownR = w / 2;
        const count = 7 + Math.floor(rand() * 3);
        for (let i = 0; i < count; i += 1) {
            fronds.push({ dir: (i / count) * 360 + rand() * 20, len: crownR * (0.75 + rand() * 0.3), droop: 0.35 + rand() * 0.3 });
        }
        return { trunkH, trunkR: 0.16, lean, crownR, crownBase: trunkH - 0.6, crownTop: h, puffs, fronds };
    }
    if (form === 'tall') {
        crownR = Math.min(w / 2, h * 0.18);
        trunkH = h * 0.3;
        const count = 4 + Math.floor(rand() * 2);
        for (let i = 0; i < count; i += 1) {
            const t = i / (count - 1);
            puffs.push({ e: (rand() - 0.5) * crownR * 0.4, n: (rand() - 0.5) * crownR * 0.4, u: trunkH + crownR * 0.7 + t * (h - trunkH - crownR * 1.4), r: crownR * (1 - t * 0.35) * (0.85 + rand() * 0.2) });
        }
    } else {
        const spreading = form === 'spreading';
        crownR = w / 2;
        trunkH = h * (spreading ? 0.55 : 0.4);
        const count = spreading ? 6 + Math.floor(rand() * 3) : 5 + Math.floor(rand() * 3);
        const crownMid = spreading ? h - crownR * 0.35 : trunkH + (h - trunkH) / 2;
        const lump = spreading ? 0.42 : 0.55;
        // One puff in the middle, the rest around it.
        puffs.push({ e: 0, n: 0, u: crownMid, r: crownR * (spreading ? 0.55 : 0.7) });
        for (let i = 1; i < count; i += 1) {
            const ang = (i / (count - 1)) * Math.PI * 2 + rand() * 0.6;
            const dist = crownR * (spreading ? 0.62 : 0.45) * (0.8 + rand() * 0.3);
            puffs.push({
                e: Math.sin(ang) * dist,
                n: Math.cos(ang) * dist,
                u: crownMid + (rand() - 0.5) * (spreading ? 0.5 : 1.2),
                r: crownR * lump * (0.8 + rand() * 0.35),
            });
        }
    }
    const crownBase = Math.min(...puffs.map((p) => p.u - p.r));
    const crownTop = Math.max(...puffs.map((p) => p.u + p.r));
    return { trunkH, trunkR: Math.max(0.12, Math.min(0.35, h * 0.03)), lean, crownR, crownBase, crownTop, puffs, fronds };
}

/** Point `east`/`north` metres from the object, as {lat, lng}. */
function offset(obj, east, north) {
    const p = fromLocalMeters(Number(obj.latitude), Number(obj.longitude), east, north);
    return { lat: p.latitude, lng: p.longitude };
}

/**
 * The crown's outline seen from above, as {lat, lng} points: slightly lumpy (from the seed) so a row of
 * trees does not look stamped. A palm's is the star of its fronds.
 */
export function crownFootprint(obj, sides = 16) {
    const m = treeModel(obj);
    const rand = seededRandom((Number(obj.seed) || 1) + 7);
    if (m.fronds.length) {
        const pts = [];
        m.fronds.forEach((f) => {
            const a = (f.dir * Math.PI) / 180;
            pts.push(offset(obj, m.lean.e + Math.sin(a) * f.len, m.lean.n + Math.cos(a) * f.len));
            const b = a + Math.PI / m.fronds.length;
            pts.push(offset(obj, m.lean.e + Math.sin(b) * f.len * 0.35, m.lean.n + Math.cos(b) * f.len * 0.35));
        });
        return pts;
    }
    const reach = Math.max(...m.puffs.map((p) => Math.hypot(p.e, p.n) + p.r));
    return Array.from({ length: sides }, (_, i) => {
        const a = (i / sides) * Math.PI * 2;
        const r = reach * (0.86 + rand() * 0.16);
        return offset(obj, m.lean.e + Math.sin(a) * r, m.lean.n + Math.cos(a) * r);
    });
}

/** A rotated rectangle `widthM` across and `lengthM` along the object's facing, as {lat, lng} corners. */
export function objectRect(obj, widthM, lengthM) {
    const rot = ((Number(obj.rotation_deg) || 0) * Math.PI) / 180;
    const along = { e: Math.sin(rot), n: Math.cos(rot) };
    const across = { e: Math.cos(rot), n: -Math.sin(rot) };
    const hw = widthM / 2;
    const hl = lengthM / 2;
    return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y]) => offset(obj,
        across.e * hw * x + along.e * hl * y, across.n * hw * x + along.n * hl * y));
}

/** A shed's roof (width across its facing, length along it). */
export const shedRoof = (obj) => objectRect(obj, num(obj.width_m, 3), num(obj.length_m, 4));

/** The two ends of a gate's opening, across its facing (the wall runs along the facing). */
export function gateEnds(obj) {
    const half = num(obj.width_m, 3) / 2;
    const rot = ((Number(obj.rotation_deg) || 0) * Math.PI) / 180;
    return [offset(obj, -Math.sin(rot) * half, -Math.cos(rot) * half), offset(obj, Math.sin(rot) * half, Math.cos(rot) * half)];
}

/**
 * Ground shadows of the trees and sheds for the sun at this moment, as {lat, lng} rings: a crown is
 * a lifted shape, so its shadow is the crown outline moved away from the sun (at the crown's bottom,
 * middle and top); a shed's is its roof moved the same way. Empty when the sun is down.
 */
export function objectShadowRings(objects, sun) {
    const rings = [];
    for (const o of objects || []) {
        if (o.kind === 'tree') {
            const m = treeModel(o);
            const crown = crownFootprint(o);
            for (const h of [m.crownBase, (m.crownBase + m.crownTop) / 2, m.crownTop]) {
                const off = shadowOffsetM(h, sun);
                if (!off) return [];
                rings.push(crown.map((p) => ({ lat: p.lat + off.north / 111320, lng: p.lng + off.east / (111320 * Math.cos((p.lat * Math.PI) / 180)) })));
            }
            // The trunk's shadow, from the foot of the tree to the crown's, so the two read as one tree.
            const foot = shadowOffsetM(m.crownBase, sun);
            const len = Math.hypot(foot.east, foot.north) || 1;
            const side = { e: (-foot.north / len) * m.trunkR, n: (foot.east / len) * m.trunkR };
            rings.push([
                offset(o, side.e, side.n), offset(o, -side.e, -side.n),
                offset(o, -side.e + foot.east, -side.n + foot.north), offset(o, side.e + foot.east, side.n + foot.north),
            ]);
        } else if (o.kind === 'shed') {
            const off = shadowOffsetM(num(o.height_m, 2.6), sun);
            if (!off) return [];
            rings.push(shedRoof(o).map((p) => ({ lat: p.lat + off.north / 111320, lng: p.lng + off.east / (111320 * Math.cos((p.lat * Math.PI) / 180)) })));
        }
    }
    return rings;
}

/** Nearest point on any wall to (lat, lng) within `maxM`: { group, index, t, distM, bearingDeg, lat, lng } or null. */
export function nearestWallPoint(borders, lat, lng, maxM = GATE_SNAP_M) {
    let best = null;
    for (const g of borders || []) {
        const c = g?.coordinates || [];
        for (let i = 1; i < c.length; i += 1) {
            const [ax, ay] = toLocalMeters(+c[i - 1].lat, +c[i - 1].lng, lat, lng);
            const [bx, by] = toLocalMeters(+c[i].lat, +c[i].lng, lat, lng);
            const dx = bx - ax;
            const dy = by - ay;
            const len2 = dx * dx + dy * dy;
            if (len2 < 1e-6) continue;
            const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
            const d = Math.hypot(ax + t * dx, ay + t * dy);
            if (d <= maxM && (!best || d < best.distM)) {
                const p = fromLocalMeters(lat, lng, ax + t * dx, ay + t * dy);
                best = { group: g, index: i, t, distM: d, bearingDeg: ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360, lat: p.latitude, lng: p.longitude, lengthM: Math.sqrt(len2) };
            }
        }
    }
    return best;
}

/** Where a gate dropped at (lat, lng) goes: onto the nearest wall, facing along it; or null when no wall is near. */
export function snapGateToWall(borders, lat, lng) {
    const w = nearestWallPoint(borders, lat, lng);
    return w ? { latitude: w.lat, longitude: w.lng, rotation_deg: Math.round(w.bearingDeg * 10) / 10 } : null;
}

/**
 * The walls with each gate's opening cut out, for the router and the wall drawing: a wall stretch with a
 * gate on it becomes two stretches with a gap the gate's width. Gates not on a wall change nothing.
 * The cut pieces get new group ids (from 50000 up), so their open ends are new turning points.
 */
export function bordersWithGates(borders, objects) {
    const gates = (objects || []).filter((o) => o?.kind === 'gate');
    if (!gates.length || !(borders || []).length) return borders || [];
    // Cuts per wall: { groupId -> [{ index, t0, t1 }] } as fractions of the segment the gate sits on.
    const cuts = new Map();
    for (const g of gates) {
        const w = nearestWallPoint(borders, Number(g.latitude), Number(g.longitude), 2.5);
        if (!w) continue;
        const half = num(g.width_m, 3) / 2 / w.lengthM;
        const list = cuts.get(w.group) || [];
        list.push({ index: w.index, t0: Math.max(0, w.t - half), t1: Math.min(1, w.t + half) });
        cuts.set(w.group, list);
    }
    if (!cuts.size) return borders;
    let nextId = 50000;
    const out = [];
    for (const g of borders) {
        const list = cuts.get(g);
        if (!list) { out.push(g); continue; }
        const c = g.coordinates;
        const lerp = (i, t) => ({ lat: +c[i - 1].lat + (+c[i].lat - +c[i - 1].lat) * t, lng: +c[i - 1].lng + (+c[i].lng - +c[i - 1].lng) * t });
        const pieces = [];
        let cur = [c[0]];
        for (let i = 1; i < c.length; i += 1) {
            const here = list.filter((k) => k.index === i).sort((a, b) => a.t0 - b.t0);
            for (const k of here) {
                if (k.t0 > 0) cur.push(lerp(i, k.t0));
                if (cur.length >= 2) pieces.push(cur);
                cur = k.t1 < 1 ? [lerp(i, k.t1)] : [];
            }
            cur.push(c[i]);
        }
        if (cur.length >= 2) pieces.push(cur);
        pieces.forEach((coords) => { out.push({ ...g, group_id: nextId, coordinates: coords }); nextId += 1; });
    }
    return out;
}
