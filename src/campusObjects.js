// Campus objects: trees, benches, sheds, gates and parking lots (app/Models/CampusObject.php), placed by an admin
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
    { value: 'parking', label: 'Parking', defaults: { width_m: 16, length_m: 20 } },
];

/** Parking stalls: 2.5 m wide and 5 m deep; a lot this wide or more gets two rows facing a driveway. */
export const STALL_W = 2.5;
export const STALL_D = 5;
export const TWO_ROWS_M = 16;

/** A tree's overall shape (CampusObject::TREE_FORMS). */
export const TREE_FORMS = [
    { value: 'round', label: 'Round (like a mango tree)' },
    { value: 'spreading', label: 'Spreading dome' },
    { value: 'canopy', label: 'Wide shade tree (like an acacia or rain tree)' },
    { value: 'tall', label: 'Tall and narrow' },
    { value: 'palm', label: 'Palm' },
    { value: 'banana', label: 'Banana (clumped stems, big leaves)' },
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
 * round puffs (a palm: fronds from the top of a tall trunk; a wide shade tree: heavy limbs from a short
 * trunk out to clumps of leaves). Same object, same shape. Puffs and limb ends are relative to the trunk's
 * top (`lean`).
 *
 * A banana plant has several stems (`stems`), each with its own big leaves (fronds with an origin `e, n, h`
 * and a `wide` paddle shape). The whole tree is turned by its `rotation_deg` (which way it leans).
 *
 * @returns {{ trunkH: number, trunkR: number, lean: {e:number,n:number}, crownR: number, crownBase: number,
 *   crownTop: number, puffs: Array<{e:number,n:number,u:number,r:number}>,
 *   fronds: Array<{dir:number,len:number,droop:number,e?:number,n?:number,h?:number,wide?:number}>,
 *   limbs: Array<{e:number,n:number,u:number}>, stems: Array<{e:number,n:number,te:number,tn:number,h:number,r:number}> }}
 */
export function treeModel(obj) {
    const m = treeShape(obj);
    const rot = ((Number(obj.rotation_deg) || 0) * Math.PI) / 180;
    if (!rot) return m;
    // Turn every point round the trunk, clockwise as a compass bearing.
    const turn = (p) => ({ ...p, e: p.e * Math.cos(rot) + p.n * Math.sin(rot), n: -p.e * Math.sin(rot) + p.n * Math.cos(rot) });
    return {
        ...m,
        lean: turn(m.lean),
        puffs: m.puffs.map(turn),
        limbs: m.limbs.map(turn),
        stems: m.stems.map((s) => { const top = turn({ e: s.te, n: s.tn }); return { ...turn(s), te: top.e, tn: top.n }; }),
        fronds: m.fronds.map((f) => ({ ...(f.e === undefined ? f : turn(f)), dir: f.dir + (Number(obj.rotation_deg) || 0) })),
    };
}

/**
 * Where a tree's trunk ends (metres up). Palms and shade trees: at their fronds or limbs. A crown of leaf
 * clumps: up into the middle of the clump over the trunk (the first one), so the trunk never stops short of
 * the leaves when the lowest clumps hang off to the side.
 */
export function trunkTopM(m) {
    if (m.fronds.length || m.limbs.length || !m.puffs.length) return m.trunkH;
    return Math.max(m.crownBase + 0.3, m.puffs[0].u);
}

function treeShape(obj) {
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
        return { trunkH, trunkR: 0.16, lean, crownR, crownBase: trunkH - 0.6, crownTop: h, puffs, fronds, limbs: [], stems: [] };
    }
    if (form === 'canopy') return canopyModel(h, w, rand);
    if (form === 'banana') return bananaModel(h, w, rand);
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
    return { trunkH, trunkR: Math.max(0.12, Math.min(0.35, h * 0.03)), lean, crownR, crownBase, crownTop, puffs, fronds, limbs: [], stems: [] };
}

/**
 * A banana plant: two or three stems growing together, the tallest about 80% of its height, each with a
 * fan of big paddle leaves (the younger ones upright, the older ones drooping) out to the crown's width.
 */
function bananaModel(h, w, rand) {
    const crownR = w / 2;
    const stems = [];
    const count = 2 + Math.floor(rand() * 2);
    for (let i = 0; i < count; i += 1) {
        const a = rand() * Math.PI * 2;
        const d = i === 0 ? 0 : 0.45 + rand() * 0.3;
        // The outer stems lean out from the clump, so the plant opens like a V.
        const out = i === 0 ? 0 : 0.5 + rand() * 0.4;
        stems.push({
            e: Math.sin(a) * d, n: Math.cos(a) * d, te: Math.sin(a) * (d + out), tn: Math.cos(a) * (d + out),
            h: h * (i === 0 ? 0.8 : 0.62 + rand() * 0.15), r: 0.14 + rand() * 0.06,
        });
    }
    const fronds = [];
    for (const s of stems) {
        const leaves = 6 + Math.floor(rand() * 3);
        const start = rand() * 360;
        for (let j = 0; j < leaves; j += 1) {
            const len = Math.min(crownR, 2.6) * (0.75 + rand() * 0.3);
            // From upright (negative droop: the leaf rises) to hanging.
            // Each blade also rolls to one side (`tilt`), as banana leaves do, so it shows its face from the side.
            fronds.push({ e: s.te, n: s.tn, h: s.h, dir: start + (j / leaves) * 360 + rand() * 25, len, droop: -0.35 + rand() * 0.95, wide: 0.6 + rand() * 0.2, tilt: (rand() - 0.5) * 1.8 });
        }
    }
    const trunkH = Math.max(...stems.map((s) => s.h));
    const top = Math.max(...fronds.map((f) => f.h - f.droop * f.len));
    return {
        trunkH, trunkR: 0.14, lean: { e: 0, n: 0 }, crownR, crownBase: Math.min(...stems.map((s) => s.h)) - 1,
        crownTop: Math.min(h, top), puffs: [], fronds, limbs: [], stems,
    };
}

/**
 * A big tropical shade tree (acacia, rain tree, narra), as along the WMSU fence: a short, thick trunk that
 * splits into a few heavy limbs, each ending in a clump of leaves; the crown is much wider than it is tall
 * and leans out to one side (over a road or walkway), where its clumps hang lower.
 */
function canopyModel(h, w, rand) {
    const crownR = w / 2;
    const trunkH = h * 0.32;
    const dir = rand() * Math.PI * 2;
    const lean = { e: Math.sin(dir) * h * 0.05, n: Math.cos(dir) * h * 0.05 };
    // The crown's middle sits out over the side it leans to.
    const mid = { e: Math.sin(dir) * crownR * 0.28, n: Math.cos(dir) * crownR * 0.28 };
    const puffs = [];
    const limbs = [];
    // Leaves hang low but never below head height, so people still walk under the tree.
    const clearM = Math.max(2, h * 0.2);
    const clump = (e, n, uWanted, r) => {
        const u = Math.max(uWanted, clearM + r);
        limbs.push({ e, n, u: u - r * 0.3 });
        puffs.push({ e, n, u, r });
        const a = rand() * Math.PI * 2;
        puffs.push({ e: e + Math.sin(a) * r * 0.6, n: n + Math.cos(a) * r * 0.6, u: u + (rand() - 0.3) * r * 0.4, r: r * (0.65 + rand() * 0.15) });
    };
    const count = 5 + Math.floor(rand() * 3);
    for (let i = 0; i < count; i += 1) {
        const ang = dir + (i / count) * Math.PI * 2 + (rand() - 0.5) * 0.6;
        const dist = crownR * (0.4 + rand() * 0.2);
        const r = crownR * 0.36 * (0.85 + rand() * 0.3);
        // Clumps on the leaning side hang lower, like branches reaching out over the road.
        const out = Math.max(0, Math.cos(ang - dir));
        clump(mid.e + Math.sin(ang) * dist, mid.n + Math.cos(ang) * dist, h * (0.6 + (rand() - 0.5) * 0.1) - out * h * 0.14, r);
    }
    // One clump on top, over the middle, so the crown is a dense mass rather than a ring.
    clump(mid.e * 0.6, mid.n * 0.6, h - crownR * 0.3, crownR * 0.4);
    const crownBase = Math.min(...puffs.map((p) => p.u - p.r));
    const crownTop = Math.max(...puffs.map((p) => p.u + p.r));
    return { trunkH, trunkR: Math.max(0.22, Math.min(0.55, h * 0.045)), lean, crownR, crownBase, crownTop, puffs, fronds: [], limbs, stems: [] };
}

/** Point `east`/`north` metres from the object, as {lat, lng}. */
function offset(obj, east, north) {
    const p = fromLocalMeters(Number(obj.latitude), Number(obj.longitude), east, north);
    return { lat: p.latitude, lng: p.longitude };
}

// ── Transform frame (admin editor), like a design tool's: corners, edges and a rotate handle ──

/** The object's own frame: x across its facing, y along it, in metres from its middle. */
export function toObjectFrame(obj, lat, lng) {
    const [e, n] = toLocalMeters(lat, lng, Number(obj.latitude), Number(obj.longitude));
    const rot = ((Number(obj.rotation_deg) || 0) * Math.PI) / 180;
    return { x: e * Math.cos(rot) - n * Math.sin(rot), y: e * Math.sin(rot) + n * Math.cos(rot) };
}

/** Back from the object's frame to {lat, lng}. */
export function fromObjectFrame(obj, x, y) {
    const rot = ((Number(obj.rotation_deg) || 0) * Math.PI) / 180;
    return offset(obj, x * Math.cos(rot) + y * Math.sin(rot), -x * Math.sin(rot) + y * Math.cos(rot));
}

/** A rectangular object's size in metres (width across its facing, length along it), and its limits. */
export function objectSize(obj) {
    const d = OBJECT_KINDS.find((k) => k.value === obj.kind)?.defaults || {};
    // A tree's frame is the square round its crown.
    if (obj.kind === 'tree') {
        const w = num(obj.width_m, d.width_m || 5);
        return { w, l: w, min: 1, max: 40 };
    }
    return {
        w: num(obj.width_m, d.width_m || 1), l: num(obj.length_m, d.length_m || 1),
        min: obj.kind === 'bench' ? 0.3 : 1, max: obj.kind === 'parking' ? 100 : 40,
    };
}

/** The resize handles: four corners and the middle of each edge, as signs along x (across) and y (along). */
export const RESIZE_HANDLES = [
    { sx: -1, sy: -1 }, { sx: 1, sy: -1 }, { sx: 1, sy: 1 }, { sx: -1, sy: 1 },
    { sx: 0, sy: -1 }, { sx: 1, sy: 0 }, { sx: 0, sy: 1 }, { sx: -1, sy: 0 },
];

const round1 = (v) => Math.round(v * 10) / 10;

/**
 * Dragging resize handle (sx, sy) to lat/lng: the opposite corner or edge stays where it is, so the middle
 * moves with the handle; an edge handle changes one side only. Never flips or shrinks below the minimum.
 * @returns {{ width_m: number, length_m: number, latitude: number, longitude: number }}
 */
export function resizeFrom(obj, sx, sy, lat, lng) {
    const { w, l, min, max } = objectSize(obj);
    const p = toObjectFrame(obj, lat, lng);
    const clamp = (v) => Math.min(max, Math.max(min, v));
    const nw = sx ? round1(clamp(sx * p.x + w / 2)) : w;
    const nl = sy ? round1(clamp(sy * p.y + l / 2)) : l;
    // The opposite side stays put: the new middle is half the new size in from it.
    const cx = sx ? -sx * (w / 2) + sx * (nw / 2) : 0;
    const cy = sy ? -sy * (l / 2) + sy * (nl / 2) : 0;
    const c = fromObjectFrame(obj, cx, cy);
    return { width_m: nw, length_m: nl, latitude: c.lat, longitude: c.lng };
}

/** How far behind the back edge the rotate handle sits (metres). */
export const rotateGapM = (l) => Math.max(1.5, l * 0.15);

/** Where the rotate handle is: behind the back edge, as the handle under a box in a design tool. */
export const rotateHandleAt = (obj) => fromObjectFrame(obj, 0, -(objectSize(obj).l / 2 + rotateGapM(objectSize(obj).l)));

/**
 * Dragging the rotate handle to lat/lng: the object turns so its back points at the handle. Whole degrees,
 * snapping to every 45 degrees within 4 degrees (square to the map, or diagonal).
 */
export function rotateTo(obj, lat, lng) {
    const [e, n] = toLocalMeters(lat, lng, Number(obj.latitude), Number(obj.longitude));
    let deg = ((Math.atan2(e, n) * 180) / Math.PI + 180 + 360) % 360;
    const snap = Math.round(deg / 45) * 45;
    if (Math.abs(deg - snap) <= 4) deg = snap % 360;
    return Math.round(deg) % 360;
}

/**
 * Dragging a handle of a tree's crown frame: the trunk stays put and the crown grows evenly, to twice the
 * handle's distance from it along the frame (a corner or an edge alike), 1 to 40 m.
 */
export function crownFromFrame(obj, lat, lng) {
    const p = toObjectFrame(obj, lat, lng);
    return round1(Math.min(40, Math.max(1, 2 * Math.max(Math.abs(p.x), Math.abs(p.y)))));
}

/** How far north of the crown's frame the height handle sits, beyond the tree's own on-screen rise. */
const HEIGHT_HANDLE_GAP_M = 1.5;

/**
 * The tree's height handle: above the crown's frame (north of it) by the tree's height, so dragging it a
 * metre north makes the tree a metre taller, the same feel as resizing the crown.
 */
export function heightHandleAt(obj) {
    const w = num(obj.width_m, 5);
    return offset(obj, 0, w / 2 + HEIGHT_HANDLE_GAP_M + num(obj.height_m, 6));
}

export function heightTo(obj, lat, lng) {
    const [, n] = toLocalMeters(lat, lng, Number(obj.latitude), Number(obj.longitude));
    const w = num(obj.width_m, 5);
    return round1(Math.min(40, Math.max(1, n - w / 2 - HEIGHT_HANDLE_GAP_M)));
}

/** Dragging a tree's crown handle: its crown width is twice the distance from the trunk (1 to 40 m). */
export function crownWidthTo(obj, lat, lng) {
    const [e, n] = toLocalMeters(lat, lng, Number(obj.latitude), Number(obj.longitude));
    return round1(Math.min(40, Math.max(1, 2 * Math.hypot(e, n))));
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
        // Each leaf's tip, round the plant (a banana's from its own stem), as a star.
        const tips = m.fronds.map((f) => {
            const a = (f.dir * Math.PI) / 180;
            const reach = f.len * Math.cos(Math.max(0, f.droop) * 0.8);
            return { e: (f.e ?? m.lean.e) + Math.sin(a) * reach, n: (f.n ?? m.lean.n) + Math.cos(a) * reach };
        }).sort((p, q) => Math.atan2(p.e, p.n) - Math.atan2(q.e, q.n));
        tips.forEach((t, i) => {
            const next = tips[(i + 1) % tips.length];
            pts.push(offset(obj, t.e, t.n));
            pts.push(offset(obj, (t.e + next.e) * 0.3, (t.n + next.n) * 0.3));
        });
        return pts;
    }
    // How far the crown reaches in each direction from the trunk's top, puff by puff, so a lopsided crown
    // (a shade tree leaning over a road) keeps its shape and its shade falls on the right side.
    return Array.from({ length: sides }, (_, i) => {
        const a = (i / sides) * Math.PI * 2;
        const dx = Math.sin(a);
        const dy = Math.cos(a);
        let reach = 0;
        for (const p of m.puffs) {
            const across = Math.abs(p.e * dy - p.n * dx);
            if (across < p.r) reach = Math.max(reach, p.e * dx + p.n * dy + Math.sqrt(p.r * p.r - across * across));
        }
        const r = Math.max(reach, m.trunkR) * (0.9 + rand() * 0.1);
        return offset(obj, m.lean.e + dx * r, m.lean.n + dy * r);
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

/**
 * A parking lot: its outline (width across its facing, length along it), the painted lines between the
 * stalls ([a, b] pairs of {lat, lng}), how many stalls, and where its "P" sign goes.
 * One row of stalls along one side; from TWO_ROWS_M wide, a second row along the other side, with the
 * driveway between them.
 */
export function parkingLayout(obj) {
    const w = num(obj.width_m, 16);
    const l = num(obj.length_m, 20);
    const rot = ((Number(obj.rotation_deg) || 0) * Math.PI) / 180;
    const along = { e: Math.sin(rot), n: Math.cos(rot) };
    const across = { e: Math.cos(rot), n: -Math.sin(rot) };
    const at = (x, y) => offset(obj, across.e * x + along.e * y, across.n * x + along.n * y);
    const depth = Math.min(STALL_D, w / 2);
    const rows = w >= TWO_ROWS_M ? [[-w / 2, -w / 2 + depth], [w / 2 - depth, w / 2]] : [[-w / 2, -w / 2 + depth]];
    const perRow = Math.floor(l / STALL_W);
    const start = -(perRow * STALL_W) / 2;
    const lines = [];
    for (const [x0, x1] of rows) {
        for (let i = 0; i <= perRow; i += 1) {
            const y = start + i * STALL_W;
            lines.push([at(x0, y), at(x1, y)]);
        }
        // The stalls' open end, along the driveway.
        const front = x0 === -w / 2 ? x1 : x0;
        lines.push([at(front, start), at(front, -start)]);
    }
    return { outline: objectRect(obj, w, l), lines, stalls: perRow * rows.length, sign: at(0, 0) };
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
