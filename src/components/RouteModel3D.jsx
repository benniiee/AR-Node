import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { C, RADIUS } from '../uiTokens';
import { toLocalMeters, fromLocalMeters } from '../geo';
import { floorOf, floorAria } from '../floors';
import { buildingHeightM } from '../sunShadow';
import { doorFrames, DOOR_HEIGHT_M } from '../doors';
import { planFromLink, stairTreads, walkLine, footprint } from '../stairGeometry';
import { makeLabel, disposeTree } from './StairPreview3D';
import { pointInPolygon, bridgeDeckHeightM, pathwayWidthM } from '../campusGeometry';
import { convexHull, clipToConvex, cutStairwells } from '../planarGeometry';
import { treeModel, seededRandom, shedRoof, gateEnds, objectRect } from '../campusObjects';

// ── The route in 3D (/map → "Route in 3D") ───────────────────────────
// For a student who wants a closer look than the 2.5D map gives: the
// building(s) the route goes into, cut at the highest floor it uses, see-
// through walls, a slab per floor on the route, its doors, the staircase as
// real steps, and the route itself as a tube that climbs those steps, from
// the start point to the destination pin. Drag to orbit, pinch / wheel to zoom.
// Scene axes: x = east, y = up, z = -north (as the other 3D previews).

// Navigation blue (uiTokens C.route), with white chevrons riding on it towards the destination.
const ROUTE = 0x1f6feb;
const ROUTE_CHEVRON = 0xffffff;
/** One chevron every this many metres along the 3D route. */
const CHEVRON_EVERY_M = 6;
const ROUTE_EDGE = 0x16161b;
const GO = 0x22c55e;
const STAIR = 0xffb02e;
// Bridges: a teal deck and roof (the campus footbridge's colour), apart from the grey buildings.
// The campus footbridge as built: cream concrete (parapet walls, pillars, stair walls), a black-and-
// white striped band along the deck's edge, and a corrugated gable roof (grey-green on top, brown
// underneath) on thin dark-red posts, over the deck and down over the stairs.
const BRIDGE_DECK = 0xb9b2a3;
const BRIDGE_CONCRETE = 0xe6dabd;
const BRIDGE_ROOF_TOP = 0x8d9f96;
const BRIDGE_ROOF_UNDER = 0x6b4834;
const BRIDGE_POST = 0x7a2c20;
const BRIDGE_LINE = 0x6f6552;
const DECK_SLAB_M = 0.7;
const ROOF_OVERHANG_M = 0.5;
const ROOF_RIDGE_M = 0.7;
const ROOF_POST_EVERY_M = 3;

/** A repeating canvas pattern for the bridge (null outside a browser: the plain colour is used). */
function patternTexture(width, height, paint) {
    if (typeof document === 'undefined') return null;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    paint(canvas.getContext('2d'));
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
}

/** The deck edge's diagonal black-and-white stripes: one tile is 1 m (4 stripes). */
const stripeTexture = () => patternTexture(64, 16, (g) => {
    g.fillStyle = '#1d1d1f';
    g.fillRect(0, 0, 64, 16);
    g.fillStyle = '#ece6d6';
    for (let x = -16; x < 80; x += 16) {
        g.beginPath();
        g.moveTo(x, 16);
        g.lineTo(x + 6, 16);
        g.lineTo(x + 14, 0);
        g.lineTo(x + 8, 0);
        g.closePath();
        g.fill();
    }
});

/** Corrugated roofing: light and dark ribs; one tile is 0.5 m along the bridge. */
const ribTexture = () => patternTexture(16, 4, (g) => {
    g.fillStyle = '#9fb1a8';
    g.fillRect(0, 0, 16, 4);
    g.fillStyle = '#76887f';
    g.fillRect(0, 0, 4, 4);
    g.fillRect(8, 0, 4, 4);
});
const RAIL_M = 1.05;
const ROOF_CLEAR_M = 2.6;

/**
 * A person at real size (about 1.7 m), standing on the ground at `foot` and
 * facing `heading` (a direction on the ground): legs, body, arms and head, in
 * the route's white. Real proportions: legs ~0.85 m, body ~0.6 m, head ~0.23 m.
 */
export function person(foot, heading) {
    const body = new THREE.Group();
    const skin = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 });
    const shade = new THREE.MeshStandardMaterial({ color: 0xd4d4d8, roughness: 0.7 });
    // Everything above the feet sits in `torso`, so a walk can bob it; legs and
    // arms hang from pivots at the hips and shoulders, so they can swing.
    const torso = new THREE.Group();
    body.add(torso);
    const part = (parent, geo, mat, x, y, z) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); parent.add(m); return m; };
    const pivot = (x, y) => { const g = new THREE.Group(); g.position.set(x, y, 0); torso.add(g); return g; };
    // Legs (hip at 0.88 m).
    const legL = pivot(-0.1, 0.88);
    const legR = pivot(0.1, 0.88);
    part(legL, new THREE.CapsuleGeometry(0.075, 0.72, 4, 10), shade, 0, -0.44, 0);
    part(legR, new THREE.CapsuleGeometry(0.075, 0.72, 4, 10), shade, 0, -0.44, 0);
    // Body (shoulders at ~1.45 m).
    part(torso, new THREE.CapsuleGeometry(0.17, 0.42, 4, 12), skin, 0, 1.15, 0).scale.set(1, 1, 0.62);
    // Arms, hanging slightly out from the shoulders (~1.38 m).
    const armL = pivot(-0.24, 1.38);
    const armR = pivot(0.24, 1.38);
    part(armL, new THREE.CapsuleGeometry(0.055, 0.56, 4, 10), skin, -0.01, -0.28, 0).rotation.z = -0.12;
    part(armR, new THREE.CapsuleGeometry(0.055, 0.56, 4, 10), skin, 0.01, -0.28, 0).rotation.z = 0.12;
    // Neck and head (top of head at ~1.72 m).
    part(torso, new THREE.CylinderGeometry(0.045, 0.05, 0.08, 10), skin, 0, 1.49, 0);
    part(torso, new THREE.SphereGeometry(0.115, 18, 14), skin, 0, 1.6, 0);
    body.userData.rig = { torso, legL, legR, armL, armR };
    // A soft ring on the ground, so the person is easy to find from afar.
    const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.42, 0.62, 40),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.03;
    body.add(ring);
    body.position.set(foot.x, foot.y, foot.z);
    if (heading && heading.lengthSq() > 1e-6) body.rotation.y = Math.atan2(heading.x, heading.z);
    return body;
}

/** A label that keeps the same size on screen at any distance. */
function screenLabel(text, opts = {}, size = 0.05) {
    const label = makeLabel(text, opts);
    label.material.sizeAttenuation = false;
    // `size` = the pill's height on screen; width follows the text (and the shadow margin around it).
    const h = size * label.userData.heightFactor;
    label.scale.set(h * label.userData.aspect, h, 1);
    return label;
}

/**
 * Build the scene into `group`. Returns the orbit target, a radius, and the
 * lat/lng to scene mapping (`xz`) with the route's points, for the follow view.
 * follow: the live 3D view walks a person along instead of the fixed one at the
 * start, and draws the roads and walkways (`pathways`) on the ground.
 * origin: {lat, lng} to centre the scene on when there is no route (the campus object preview).
 */
export function buildScene(group, { route, buildings, links, pathways = [], bridges = [], objects = [], nodes = [], follow = false, origin = null }) {
    const path = route?.path || [];
    const byId = new Map((buildings || []).map((b) => [b.id, b]));
    const inside = new Map();
    for (const p of path) {
        if (p.building_id == null || !byId.has(p.building_id)) continue;
        if (!inside.has(p.building_id)) inside.set(p.building_id, new Set());
        inside.get(p.building_id).add(Math.max(0, floorOf(p)));
    }
    const focus = byId.get([...inside.keys()][0]) || null;
    const originLL = focus?.polygon?.length
        ? { lat: focus.polygon.reduce((s, p) => s + +p.lat, 0) / focus.polygon.length, lng: focus.polygon.reduce((s, p) => s + +p.lng, 0) / focus.polygon.length }
        : (path.length ? { lat: path[path.length - 1].latitude, lng: path[path.length - 1].longitude } : origin);
    if (!originLL) return { target: new THREE.Vector3(), radius: 20 };
    const xz = (lat, lng) => { const [e, n] = toLocalMeters(+lat, +lng, originLL.lat, originLL.lng); return { x: e, z: -n }; };
    const storey = (b) => buildingHeightM(b) / Math.max(1, Number(b.floors) || 1);
    // A raised route node outside every building is on a bridge deck: at the deck's height.
    const deckOf = (p) => (bridges || []).find((br) => Number(br.deck_floor) === floorOf(p)
        && Array.isArray(br.polygon) && pointInPolygon(+p.latitude, +p.longitude, br.polygon));
    // Any other raised node outside a building: its measured elevation, else 3.2 m a floor.
    const yOf = (p) => {
        const b = p.building_id != null ? byId.get(p.building_id) : null;
        if (b) return Math.max(0, floorOf(p)) * storey(b);
        if (floorOf(p) <= 0) return 0;
        const deck = deckOf(p);
        if (deck) return bridgeDeckHeightM(deck);
        return Number(p.elevation) > 0.5 ? Number(p.elevation) : floorOf(p) * 3.2;
    };

    let radius = 12;
    // Roads and walkways on the ground (follow view): flat strips a little lighter than the ground, with a
    // round disc at every point so corners and ends are rounded (square strip ends stuck out at corners).
    // Roads sit a hair under walkways, so where the two meet they never flicker into each other.
    if (follow) {
        const roadMat = new THREE.MeshStandardMaterial({ color: 0x3a3b42, roughness: 1 });
        const walkMat = new THREE.MeshStandardMaterial({ color: 0x4a4b52, roughness: 1 });
        for (const pw of pathways || []) {
            const pts = (pw.coordinates || []).map((c) => xz(c.lat, c.lng));
            const width = pathwayWidthM(pw.kind, pw.width_m);
            const mat = pw.kind === 'road' ? roadMat : walkMat;
            const y = pw.kind === 'road' ? 0.005 : 0.009;
            for (let i = 1; i < pts.length; i += 1) {
                const a = pts[i - 1];
                const b = pts[i];
                const len = Math.hypot(b.x - a.x, b.z - a.z);
                if (len < 0.1) continue;
                const strip = new THREE.Mesh(new THREE.BoxGeometry(width, 0.02, len), mat);
                strip.position.set((a.x + b.x) / 2, y, (a.z + b.z) / 2);
                strip.rotation.y = Math.atan2(b.x - a.x, b.z - a.z);
                group.add(strip);
            }
            const disc = new THREE.CylinderGeometry(width / 2, width / 2, 0.02, 32);
            for (const p of pts) {
                const joint = new THREE.Mesh(disc, mat);
                joint.position.set(p.x, y, p.z);
                group.add(joint);
            }
        }
    }
    // Ground.
    const ground = new THREE.Mesh(new THREE.CircleGeometry(400, 64), new THREE.MeshStandardMaterial({ color: follow ? 0x2c2e35 : 0x1f2024, roughness: 1 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.02;
    group.add(ground);

    // Buildings on the route: up to the ceiling of their highest route floor.
    for (const [id, floorSet] of inside) {
        const b = byId.get(id);
        const ring = (b.polygon || []).map((p) => xz(p.lat, p.lng));
        if (ring.length < 3) continue;
        for (const p of ring) radius = Math.max(radius, Math.hypot(p.x, p.z));
        const used = [...floorSet].sort((a, c) => a - c);
        const h = storey(b);
        const ceiling = (used[used.length - 1] + 1) * h;
        const wallMat = new THREE.MeshStandardMaterial({ color: 0xd8d3c8, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false });
        const edgeMat = new THREE.LineBasicMaterial({ color: 0xbdb8ae, transparent: true, opacity: 0.8 });
        // Doors are holes in the walls (as in the Manage doors view): each
        // door's span along its wall, 0..1.
        const doorH = Math.min(DOOR_HEIGHT_M, h * 0.85);
        const frames = doorFrames(b.polygon, b.doors);
        const spans = new Map();
        for (const d of frames) {
            const a = ring[d.edge];
            const c = ring[(d.edge + 1) % ring.length];
            const len2 = (c.x - a.x) ** 2 + (c.z - a.z) ** 2 || 1;
            const t = (ll) => { const q = xz(ll.lat, ll.lng); return ((q.x - a.x) * (c.x - a.x) + (q.z - a.z) * (c.z - a.z)) / len2; };
            const [t0, t1] = [t(d.a), t(d.b)].sort((x, y) => x - y);
            if (!spans.has(d.edge)) spans.set(d.edge, []);
            spans.get(d.edge).push([Math.max(0, t0), Math.min(1, t1)]);
        }
        const quad = (p, q, y0, y1) => {
            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.Float32BufferAttribute([
                p.x, y0, p.z, q.x, y0, q.z, q.x, y1, q.z, p.x, y0, p.z, q.x, y1, q.z, p.x, y1, p.z,
            ], 3));
            geo.computeVertexNormals();
            group.add(new THREE.Mesh(geo, wallMat));
        };
        for (let i = 0; i < ring.length; i += 1) {
            const a = ring[i];
            const c = ring[(i + 1) % ring.length];
            const at = (t) => ({ x: a.x + (c.x - a.x) * t, z: a.z + (c.z - a.z) * t });
            let from = 0;
            for (const [t0, t1] of (spans.get(i) || []).sort((x, y) => x[0] - y[0])) {
                if (t0 > from + 1e-4) quad(at(from), at(t0), 0, ceiling);
                quad(at(t0), at(t1), doorH, ceiling); // only the wall above the opening
                from = Math.max(from, t1);
            }
            if (from < 1 - 1e-4) quad(at(from), c, 0, ceiling);
            group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(a.x, 0, a.z), new THREE.Vector3(a.x, ceiling, a.z)]), edgeMat));
            group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(a.x, ceiling, a.z), new THREE.Vector3(c.x, ceiling, c.z)]), edgeMat));
        }
        // A slab per route floor, about 15 cm thick so each floor reads as a
        // real floor at its height. Its edge is outlined: green on the
        // destination's floor, white on the others (the ground floor keeps a
        // darker green base).
        const shape = new THREE.Shape(ring.map((p) => new THREE.Vector2(p.x, -p.z)));
        const dest = path[path.length - 1];
        const destFloor = dest && dest.building_id === id ? Math.max(0, floorOf(dest)) : null;
        for (const f of used) {
            const isDest = f === destFloor && f > 0;
            const label = screenLabel(isDest ? `${floorAria(f)}, destination` : floorAria(f), isDest ? { bg: '#4ade80', fg: '#05230f' } : {}, isDest ? 0.05 : 0.042);
            label.position.set(ring[0].x, f * h + 0.9, ring[0].z);
            group.add(label);

            if (f === 0) {
                // Ground floor: a thin dark-green base.
                const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.05, bevelEnabled: false });
                geo.rotateX(-Math.PI / 2);
                const base = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x2f6b46, transparent: true, opacity: 0.6, depthWrite: false }));
                base.position.y = 0.01;
                group.add(base);
                const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 25), new THREE.LineBasicMaterial({ color: 0x9fd9b4 }));
                edges.position.y = 0.01;
                group.add(edges);
                continue;
            }

            // An upper floor: a solid-looking slab, 30 cm thick, with a bright
            // top and a darker edge band, so it reads as a raised floor at its
            // height. Light green on the destination's floor, pale grey on
            // others. Partly see-through so the route below still shows.
            const SLAB = 0.3;
            const geo = new THREE.ExtrudeGeometry(shape, { depth: SLAB, bevelEnabled: false });
            geo.rotateX(-Math.PI / 2);
            const top = new THREE.MeshStandardMaterial({
                color: isDest ? 0xbbf7d0 : 0xe5e7eb, roughness: 0.8, transparent: true, opacity: 0.72,
            });
            const side = new THREE.MeshStandardMaterial({ color: isDest ? 0x15803d : 0x6b7280, roughness: 0.9, transparent: true, opacity: 0.92 });
            const slab = new THREE.Mesh(geo, [top, side]);
            slab.position.y = f * h - SLAB;
            slab.renderOrder = 2;
            group.add(slab);
            const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 25), new THREE.LineBasicMaterial({ color: isDest ? 0x4ade80 : 0xffffff }));
            edges.position.y = slab.position.y;
            edges.renderOrder = 3;
            group.add(edges);

            // Its shadow on the floor below: the strongest cue for "above".
            const shadow = new THREE.Mesh(new THREE.ShapeGeometry(shape), new THREE.MeshBasicMaterial({
                color: 0x000000, transparent: true, opacity: 0.22, depthWrite: false,
            }));
            shadow.rotation.x = -Math.PI / 2;
            shadow.position.y = (f - 1) * h + 0.07;
            group.add(shadow);

            // Height lines: dashed, from each corner of the slab down to the ground.
            for (const p of ring) {
                const line = new THREE.Line(
                    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(p.x, 0.02, p.z), new THREE.Vector3(p.x, f * h - SLAB, p.z)]),
                    new THREE.LineDashedMaterial({ color: isDest ? 0x86efac : 0xffffff, dashSize: 0.35, gapSize: 0.25, transparent: true, opacity: 0.55 }),
                );
                line.computeLineDistances();
                group.add(line);
            }
        }
        const name = screenLabel(b.short_name || b.name, { bg: '#16161b', fg: '#ffffff', icon: 'building', border: 'rgba(255, 255, 255, 0.28)' }, 0.05);
        const cx = ring.reduce((s, p) => s + p.x, 0) / ring.length;
        const cz = ring.reduce((s, p) => s + p.z, 0) / ring.length;
        name.position.set(cx, ceiling + 2, cz);
        group.add(name);
        // Each door: just the opening, with a faint light-grey pane in it.
        for (const d of frames) {
            const a = xz(d.a.lat, d.a.lng);
            const c = xz(d.b.lat, d.b.lng);
            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.Float32BufferAttribute([
                a.x, 0, a.z, c.x, 0, c.z, c.x, doorH, c.z, a.x, 0, a.z, c.x, doorH, c.z, a.x, doorH, a.z,
            ], 3));
            group.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xe5e7eb, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false })));
        }
    }

    // Every other building on campus, for a sense of where you are: plain
    // solid blocks at their real height with a small name, quieter than the
    // route's own building (planned ones are not built yet, so not drawn).
    const blockMat = new THREE.MeshStandardMaterial({ color: 0xb9b6ae, roughness: 0.95 });
    const blockEdge = new THREE.LineBasicMaterial({ color: 0x6b6b72, transparent: true, opacity: 0.7 });
    for (const b of buildings || []) {
        if (inside.has(b.id) || b.status === 'planned' || !Array.isArray(b.polygon) || b.polygon.length < 3) continue;
        const ring = b.polygon.map((p) => xz(p.lat, p.lng));
        const height = buildingHeightM(b);
        const body = new THREE.ExtrudeGeometry(new THREE.Shape(ring.map((p) => new THREE.Vector2(p.x, -p.z))), { depth: height, bevelEnabled: false });
        body.rotateX(-Math.PI / 2);
        group.add(new THREE.Mesh(body, blockMat));
        group.add(new THREE.LineSegments(new THREE.EdgesGeometry(body, 25), blockEdge));
        const cx = ring.reduce((sum, p) => sum + p.x, 0) / ring.length;
        const cz = ring.reduce((sum, p) => sum + p.z, 0) / ring.length;
        const tag = screenLabel(b.short_name || b.name, { bg: '#26262c', fg: '#e5e5ea', icon: 'building', border: 'rgba(255, 255, 255, 0.18)' }, 0.034);
        tag.position.set(cx, height + 1.5, cz);
        group.add(tag);
    }

    // Bridges and other connectors, drawn like the campus footbridge: the deck at its height on square
    // concrete pillars, a striped band along its edge, solid concrete parapets along its long sides (the
    // short ends stay open: that is where people walk on), and a gable roof on posts when it has one.
    // Planned ones are not built yet, so not drawn.
    const deckTop = new THREE.MeshStandardMaterial({ color: BRIDGE_DECK, roughness: 0.9 });
    const concreteMat = new THREE.MeshStandardMaterial({ color: BRIDGE_CONCRETE, roughness: 0.95, side: THREE.DoubleSide });
    const stripes = stripeTexture();
    const fasciaMat = new THREE.MeshStandardMaterial({ color: stripes ? 0xffffff : 0x2a2a2e, map: stripes, roughness: 0.9, side: THREE.DoubleSide });
    const ribs = ribTexture();
    // See-through from above, so a route on the deck still shows in the overhead 3D view.
    const roofTopMat = new THREE.MeshStandardMaterial({ color: ribs ? 0xffffff : BRIDGE_ROOF_TOP, map: ribs, roughness: 0.55, metalness: 0.2, side: THREE.FrontSide, transparent: true, opacity: 0.55, depthWrite: false });
    const roofUnderMat = new THREE.MeshStandardMaterial({ color: BRIDGE_ROOF_UNDER, roughness: 0.8, side: THREE.BackSide });
    const postMat = new THREE.MeshStandardMaterial({ color: BRIDGE_POST, roughness: 0.7 });
    const bridgeEdge = new THREE.LineBasicMaterial({ color: BRIDGE_LINE });
    /** One flat quad (two triangles) from four scene points, with optional [u, v] per corner. */
    const quad = (pts, mat, uv = null) => {
        const g = new THREE.BufferGeometry();
        const [a, b, c, d] = pts;
        g.setAttribute('position', new THREE.Float32BufferAttribute([a, b, c, a, c, d].flatMap((p) => [p.x, p.y, p.z]), 3));
        if (uv) {
            const [ua, ub, uc, ud] = uv;
            g.setAttribute('uv', new THREE.Float32BufferAttribute([...ua, ...ub, ...uc, ...ua, ...uc, ...ud], 2));
        }
        g.computeVertexNormals();
        group.add(new THREE.Mesh(g, mat));
    };
    /** A thin square post from y0 to y1. */
    const post = (x, z, y0, y1, size = 0.1, mat = postMat) => {
        if (y1 - y0 < 0.05) return;
        const m = new THREE.Mesh(new THREE.BoxGeometry(size, y1 - y0, size), mat);
        m.position.set(x, (y0 + y1) / 2, z);
        group.add(m);
    };
    /** A roof on posts: its top (ribbed) and its brown underside, from four scene corners. */
    const roofPanel = (pts, ribLengthM) => {
        let corners = pts;
        let uv = [[0, 0], [ribLengthM / 0.5, 0], [ribLengthM / 0.5, 1], [0, 1]];
        // Wind the panel so its front faces up: the ribbed top is seen from above, the brown underside from below.
        const [a, b, c] = pts;
        const up = (b.z - a.z) * (c.x - a.x) - (b.x - a.x) * (c.z - a.z);
        if (up < 0) {
            corners = [pts[0], pts[3], pts[2], pts[1]];
            uv = [uv[0], uv[3], uv[2], uv[1]];
        }
        quad(corners, roofTopMat, uv);
        quad(corners, roofUnderMat);
    };
    // Stairs that come up under a deck: the part of the deck over their steps is a stairwell,
    // cut out of the deck (outlined) so the steps below are seen through the opening.
    const stairHoles = new Map();
    if (bridges?.length) {
        const nodeById = new Map([...(nodes || []), ...path].filter((n) => n?.id != null).map((n) => [n.id, n]));
        for (const l of links || []) {
            const a = nodeById.get(l.node_a_id);
            const b = nodeById.get(l.node_b_id);
            const deck = a && b ? deckOf(a) || deckOf(b) : null;
            if (!deck) continue;
            const { plan, bottom } = planFromLink(l, a, b);
            const base = xz(bottom.latitude, bottom.longitude);
            // One opening per flight and landing (an L-shaped staircase's whole hull would cut the deck across).
            const deckRing = deck.polygon.map((p) => xz(p.lat, p.lng));
            const holes = footprint(plan)
                .map((f) => convexHull(f.ring.map(([e, n]) => ({ x: base.x + e, z: base.z - n }))))
                .filter((hole) => clipToConvex(deckRing, hole).length >= 3);
            stairHoles.set(deck.id, [...(stairHoles.get(deck.id) || []), ...holes]);
        }
    }
    const wellEdge = new THREE.LineBasicMaterial({ color: STAIR });
    const wallMat = concreteMat;
    const underMat = new THREE.MeshStandardMaterial({ color: BRIDGE_CONCRETE, roughness: 0.95, side: THREE.BackSide });
    const doorPane = new THREE.MeshBasicMaterial({ color: 0xe5e7eb, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false });
    const doorEdge = new THREE.LineBasicMaterial({ color: 0xffffff });
    for (const br of bridges || []) {
        if (br.status === 'planned' || !Array.isArray(br.polygon) || br.polygon.length < 3) continue;
        const ring = br.polygon.map((p) => xz(p.lat, p.lng));
        for (const p of ring) radius = Math.max(radius, Math.hypot(p.x, p.z));
        const h = bridgeDeckHeightM(br);
        const slab = Math.min(DECK_SLAB_M, Math.max(0.05, h));
        const y0 = Math.max(0, h - slab);
        // The deck's top and underside: triangulated first, so each stairwell is cut out of convex
        // triangles (exact, no slivers), then laid flat. Walls are built only where the deck really ends.
        const tris = THREE.ShapeUtils.triangulateShape(ring.map((p) => new THREE.Vector2(p.x, p.z)), []).map((t) => t.map((i) => ring[i]));
        const { pieces, outline, wellEdges } = cutStairwells(ring, stairHoles.get(br.id) || [], tris);
        for (const piece of pieces) {
            const face = new THREE.ShapeGeometry(new THREE.Shape(piece.map((p) => new THREE.Vector2(p.x, -p.z))));
            face.rotateX(-Math.PI / 2);
            const top = new THREE.Mesh(face, deckTop);
            top.position.y = h;
            group.add(top);
            const under = new THREE.Mesh(face, underMat);
            under.position.y = y0;
            group.add(under);
        }
        const wall = (a, c, mat = wallMat) => {
            const g = new THREE.BufferGeometry();
            g.setAttribute('position', new THREE.Float32BufferAttribute([
                a.x, y0, a.z, c.x, y0, c.z, c.x, h, c.z, a.x, y0, a.z, c.x, h, c.z, a.x, h, a.z,
            ], 3));
            g.computeVertexNormals();
            group.add(new THREE.Mesh(g, mat));
        };
        const edgeLine = (a, c, y, mat) => group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(a.x, y, a.z), new THREE.Vector3(c.x, y, c.z)]), mat));
        // The outline, open where a stairwell reaches the deck's edge: the striped band along its edge.
        for (const [a, c] of outline) {
            const len = Math.hypot(c.x - a.x, c.z - a.z);
            quad([{ x: a.x, y: y0, z: a.z }, { x: c.x, y: y0, z: c.z }, { x: c.x, y: h, z: c.z }, { x: a.x, y: h, z: a.z }], fasciaMat, [[0, 0], [len, 0], [len, 1], [0, 1]]);
            edgeLine(a, c, h, bridgeEdge);
            edgeLine(a, c, y0, bridgeEdge);
        }
        // Each stairwell's own edge where it runs over the deck: a wall into the opening, outlined in amber.
        for (const [p, q] of wellEdges) {
            wall(p, q);
            edgeLine(p, q, h + 0.02, wellEdge);
        }
        // Long sides: the edges running along the deck's walking line.
        const line = (br.centre_line || []).map((p) => xz(p.lat, p.lng));
        const axis = line.length >= 2 ? new THREE.Vector2(line[1].x - line[0].x, line[1].z - line[0].z).normalize() : null;
        for (let i = 0; i < ring.length; i += 1) {
            const a = ring[i];
            const c = ring[(i + 1) % ring.length];
            const dir = new THREE.Vector2(c.x - a.x, c.z - a.z);
            if (dir.length() < 0.2 || (axis && Math.abs(dir.normalize().dot(axis)) < 0.7)) continue;
            // A solid concrete parapet, as on the real bridge (not a see-through railing).
            quad([{ x: a.x, y: h, z: a.z }, { x: c.x, y: h, z: c.z }, { x: c.x, y: h + RAIL_M, z: c.z }, { x: a.x, y: h + RAIL_M, z: a.z }], concreteMat);
            group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(a.x, h + RAIL_M, a.z), new THREE.Vector3(c.x, h + RAIL_M, c.z)]), bridgeEdge));
        }
        // Each entrance: on the ground under the deck's edge (where people walk in to the stairs),
        // a door-high opening framed in white with a faint pane. A deck on the ground has it on the deck.
        const doorBase = h - slab >= 1.5 ? 0 : h;
        const doorTop = h - slab >= 1.5 ? Math.min(DOOR_HEIGHT_M, h - slab) : h + DOOR_HEIGHT_M;
        for (const d of doorFrames(br.polygon, br.doors)) {
            const a = xz(d.a.lat, d.a.lng);
            const c = xz(d.b.lat, d.b.lng);
            const [y0, top] = [doorBase, doorTop];
            const pane = new THREE.BufferGeometry();
            pane.setAttribute('position', new THREE.Float32BufferAttribute([
                a.x, y0, a.z, c.x, y0, c.z, c.x, top, c.z, a.x, y0, a.z, c.x, top, c.z, a.x, top, a.z,
            ], 3));
            group.add(new THREE.Mesh(pane, doorPane));
            group.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints([
                new THREE.Vector3(a.x, y0 + 0.02, a.z), new THREE.Vector3(a.x, top, a.z), new THREE.Vector3(c.x, top, c.z), new THREE.Vector3(c.x, y0 + 0.02, c.z),
            ]), doorEdge));
        }
        // Square concrete pillars under a raised deck.
        if (h > 0.6) {
            for (const p of ring) post(p.x, p.z, 0, h - slab, 0.6, concreteMat);
        }
        // The roof: a gable along the bridge (ribs running down to the eaves) on thin posts standing on
        // the parapets every few metres.
        if (br.roofed) {
            let dir = axis ? { x: axis.x, z: axis.y } : null;
            if (!dir) {
                let longest = 0;
                for (let i = 0; i < ring.length; i += 1) {
                    const a = ring[i];
                    const c = ring[(i + 1) % ring.length];
                    const len = Math.hypot(c.x - a.x, c.z - a.z);
                    if (len > longest) { longest = len; dir = { x: (c.x - a.x) / len, z: (c.z - a.z) / len }; }
                }
            }
            const across = { x: -dir.z, z: dir.x };
            const sOf = (p) => p.x * dir.x + p.z * dir.z;
            const tOf = (p) => p.x * across.x + p.z * across.z;
            const s0 = Math.min(...ring.map(sOf)) - ROOF_OVERHANG_M;
            const s1 = Math.max(...ring.map(sOf)) + ROOF_OVERHANG_M;
            const tMin = Math.min(...ring.map(tOf));
            const tMax = Math.max(...ring.map(tOf));
            const tMid = (tMin + tMax) / 2;
            const at = (s, t, y) => ({ x: dir.x * s + across.x * t, y, z: dir.z * s + across.z * t });
            const eave = h + ROOF_CLEAR_M;
            const ridge = eave + ROOF_RIDGE_M;
            const len = s1 - s0;
            roofPanel([at(s0, tMin - ROOF_OVERHANG_M, eave), at(s1, tMin - ROOF_OVERHANG_M, eave), at(s1, tMid, ridge), at(s0, tMid, ridge)], len);
            roofPanel([at(s1, tMax + ROOF_OVERHANG_M, eave), at(s0, tMax + ROOF_OVERHANG_M, eave), at(s0, tMid, ridge), at(s1, tMid, ridge)], len);
            const span = len - 2 * ROOF_OVERHANG_M;
            const count = Math.max(1, Math.ceil(span / ROOF_POST_EVERY_M));
            for (let k = 0; k <= count; k += 1) {
                const s = s0 + ROOF_OVERHANG_M + (span * k) / count;
                for (const t of [tMin, tMax]) {
                    const p = at(s, t, 0);
                    post(p.x, p.z, h, eave);
                }
            }
        }
        const cx = ring.reduce((sum, p) => sum + p.x, 0) / ring.length;
        const cz = ring.reduce((sum, p) => sum + p.z, 0) / ring.length;
        const tag = screenLabel(br.short_name || br.name, { bg: '#2e2a22', fg: '#f3ead6', border: 'rgba(230, 218, 189, 0.6)' }, 0.036);
        tag.position.set(cx, h + (br.roofed ? ROOF_CLEAR_M + ROOF_RIDGE_M + 1.2 : RAIL_M + 1.2), cz);
        group.add(tag);
    }

    // Trees, benches, sheds and gates (campus objects), each from the same shape as the 2D map.
    if (objects?.length) {
        const trunkMat = new THREE.MeshStandardMaterial({ color: 0x6b4a2e, roughness: 0.95 });
        const leafMats = [0x3f7d3a, 0x467f36, 0x3b7442, 0x4d8a3c, 0x38703a].map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.9, flatShading: true }));
        const woodMat = new THREE.MeshStandardMaterial({ color: 0x8b5a2b, roughness: 0.85 });
        const shedMat = new THREE.MeshStandardMaterial({ color: 0x8d9f96, roughness: 0.6, metalness: 0.2, side: THREE.DoubleSide });
        const postMat3 = new THREE.MeshStandardMaterial({ color: 0x5b5f63, roughness: 0.7 });
        const pillarMat = new THREE.MeshStandardMaterial({ color: 0xe6dabd, roughness: 0.95 });
        const box = (w, h, d, mat, x, y, z, rotY = 0) => {
            const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
            m.position.set(x, y, z);
            m.rotation.y = rotY;
            group.add(m);
            return m;
        };
        for (const o of objects) {
            if (!Number.isFinite(+o.latitude) || !Number.isFinite(+o.longitude)) continue;
            const base = xz(o.latitude, o.longitude);
            const rotY = -((Number(o.rotation_deg) || 0) * Math.PI) / 180;
            if (o.kind === 'tree') {
                const m = treeModel(o);
                const leaf = leafMats[Math.floor(seededRandom((Number(o.seed) || 1) + 3)() * leafMats.length)];
                const topU = m.fronds.length || m.limbs.length ? m.trunkH : m.crownBase + 0.3;
                const trunk = new THREE.Mesh(new THREE.CylinderGeometry(m.trunkR * 0.7, m.trunkR, topU, 8), trunkMat);
                trunk.position.set(base.x + m.lean.e / 2, topU / 2, base.z - m.lean.n / 2);
                trunk.rotation.z = -Math.atan2(m.lean.e, topU);
                trunk.rotation.x = Math.atan2(-m.lean.n, topU) * -1;
                group.add(trunk);
                if (m.fronds.length) {
                    for (const f of m.fronds) {
                        const a = (f.dir * Math.PI) / 180;
                        const frond = new THREE.Mesh(new THREE.ConeGeometry(0.4, f.len, 4), leaf);
                        // Lay each frond out from the top, drooping towards its tip.
                        frond.position.set(base.x + m.lean.e + Math.sin(a) * f.len * 0.45, m.trunkH - f.droop * f.len * 0.4, base.z - m.lean.n - Math.cos(a) * f.len * 0.45);
                        frond.rotation.order = 'YXZ';
                        frond.rotation.y = -a;
                        frond.rotation.x = Math.PI / 2 + f.droop * 0.8;
                        frond.scale.set(1, 1, 0.25);
                        group.add(frond);
                    }
                } else {
                    // A shade tree's limbs: tapered branches from the top of the trunk out to each clump.
                    const top = new THREE.Vector3(base.x + m.lean.e, m.trunkH, base.z - m.lean.n);
                    for (const l of m.limbs) {
                        const d = new THREE.Vector3(base.x + m.lean.e + l.e, l.u, base.z - m.lean.n - l.n).sub(top);
                        const len = d.length();
                        const limb = new THREE.Mesh(new THREE.CylinderGeometry(m.trunkR * 0.25, m.trunkR * 0.55, len, 6), trunkMat);
                        limb.position.copy(top).addScaledVector(d, 0.5);
                        limb.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
                        group.add(limb);
                    }
                    for (const p of m.puffs) {
                        const puff = new THREE.Mesh(new THREE.IcosahedronGeometry(p.r, 1), leaf);
                        puff.position.set(base.x + m.lean.e + p.e, p.u, base.z - m.lean.n - p.n);
                        // Shade trees' clumps are flat layers of leaves; other crowns are rounder.
                        puff.scale.y = m.limbs.length ? 0.6 : 0.85;
                        group.add(puff);
                    }
                }
            } else if (o.kind === 'bench') {
                const len = Number(o.length_m) || 1.8;
                const wid = Number(o.width_m) || 0.5;
                const seat = Number(o.height_m) || 0.45;
                const piv = new THREE.Group();
                piv.position.set(base.x, 0, base.z);
                piv.rotation.y = rotY;
                const seatMesh = new THREE.Mesh(new THREE.BoxGeometry(wid, 0.06, len), woodMat);
                seatMesh.position.y = seat;
                piv.add(seatMesh);
                for (const s of [-1, 1]) {
                    const leg = new THREE.Mesh(new THREE.BoxGeometry(wid * 0.9, seat, 0.08), woodMat);
                    leg.position.set(0, seat / 2, s * (len / 2 - 0.15));
                    piv.add(leg);
                }
                group.add(piv);
            } else if (o.kind === 'shed') {
                const roofY = Number(o.height_m) || 2.6;
                const corners = shedRoof(o).map((p) => xz(p.lat, p.lng));
                for (const c of corners) box(0.1, roofY, 0.1, postMat3, c.x, roofY / 2, c.z);
                const roofGeo = new THREE.BufferGeometry();
                const [a, b, c2, d] = corners;
                roofGeo.setAttribute('position', new THREE.Float32BufferAttribute([a, b, c2, a, c2, d].flatMap((q) => [q.x, roofY, q.z]), 3));
                roofGeo.computeVertexNormals();
                group.add(new THREE.Mesh(roofGeo, shedMat));
                // A bench under the roof, along its length.
                const inner = objectRect(o, 0.45, (Number(o.length_m) || 4) * 0.7).map((p) => xz(p.lat, p.lng));
                const cx = inner.reduce((s, q) => s + q.x, 0) / 4;
                const cz = inner.reduce((s, q) => s + q.z, 0) / 4;
                box(0.45, 0.06, (Number(o.length_m) || 4) * 0.7, woodMat, cx, 0.45, cz, rotY);
            } else if (o.kind === 'gate') {
                const h = Number(o.height_m) || 2.2;
                for (const p of gateEnds(o)) {
                    const c = xz(p.lat, p.lng);
                    box(0.5, h, 0.5, pillarMat, c.x, h / 2, c.z, rotY);
                    box(0.62, 0.12, 0.62, pillarMat, c.x, h + 0.06, c.z, rotY);
                }
            }
        }
    }

    // The route as one polyline in 3D; floor changes climb the stairs.
    const linkFor = (a, b) => (links || []).find((l) => (l.node_a_id === a.id && l.node_b_id === b.id) || (l.node_a_id === b.id && l.node_b_id === a.id));
    const stepMat = new THREE.MeshStandardMaterial({ color: STAIR, roughness: 0.8 });
    const drawnLinks = new Set();
    /** The steps of one staircase, scaled to the real heights of its two ends (yOf). */
    const drawSteps = (plan, bottom, top, mat = stepMat) => {
        const y0 = yOf(bottom);
        const y1 = yOf(top);
        const base = xz(bottom.latitude, bottom.longitude);
        for (const t of stairTreads(plan)) {
            const s = new THREE.Shape(t.ring.map(([e, n]) => new THREE.Vector2(base.x + e, -(base.z - n))));
            const geo = new THREE.ExtrudeGeometry(s, { depth: 0.12, bevelEnabled: false });
            geo.rotateX(-Math.PI / 2);
            const mesh = new THREE.Mesh(geo, mat);
            mesh.position.y = y0 + (plan.rise > 0 ? t.u / plan.rise : 0) * (y1 - y0) - 0.12;
            group.add(mesh);
        }
    };
    /** Is the scene point (x, z) under the deck outline ring? */
    const underRing = (x, z, ring) => {
        let inside = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
            const a = ring[i];
            const b = ring[j];
            if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
        }
        return inside;
    };
    /** A footbridge's staircase as built: solid concrete side walls, and (outside the deck) a roof sloping with it. */
    const dressBridgeStairs = (plan, bottom, top, deck) => {
        const y0 = yOf(bottom);
        const y1 = yOf(top);
        const yAt = (u) => y0 + (plan.rise > 0 ? u / plan.rise : 0) * (y1 - y0);
        const base = xz(bottom.latitude, bottom.longitude);
        const at = (e, n, y) => ({ x: base.x + e, y, z: base.z - n });
        const deckRing = deck.polygon.map((p) => xz(p.lat, p.lng));
        const roofed = (e, n) => deck.roofed && !underRing(base.x + e, base.z - n, deckRing);
        const hw = plan.widthM / 2;
        const rings = footprint(plan);
        plan.segments.forEach((s, i) => {
            if (s.kind === 'landing') {
                const ring = rings[i].ring;
                const lift = yAt(s.center.u);
                ring.forEach(([e, n], k) => {
                    const [e2, n2] = ring[(k + 1) % ring.length];
                    quad([at(e, n, y0), at(e2, n2, y0), at(e2, n2, lift), at(e, n, lift)], concreteMat);
                });
                if (roofed(s.center.e, s.center.n)) {
                    const roofY = lift + ROOF_CLEAR_M;
                    roofPanel(ring.map(([e, n]) => at(e, n, roofY)), s.depth);
                    for (const [e, n] of ring) post(at(e, n, 0).x, at(e, n, 0).z, lift, roofY);
                }
                return;
            }
            const side = { e: Math.sin(((s.yawDeg + 90) * Math.PI) / 180), n: Math.cos(((s.yawDeg + 90) * Math.PI) / 180) };
            const edge = (p, k, w) => ({ e: p.e + side.e * w * k, n: p.n + side.n * w * k });
            for (const k of [-1, 1]) {
                const a = edge(s.from, k, hw);
                const b = edge(s.to, k, hw);
                quad([at(a.e, a.n, y0), at(b.e, b.n, y0), at(b.e, b.n, yAt(s.to.u) + RAIL_M), at(a.e, a.n, yAt(s.from.u) + RAIL_M)], concreteMat);
            }
            if (roofed((s.from.e + s.to.e) / 2, (s.from.n + s.to.n) / 2)) {
                const w = hw + ROOF_OVERHANG_M / 2;
                const [a, b, c, d] = [edge(s.from, -1, w), edge(s.to, -1, w), edge(s.to, 1, w), edge(s.from, 1, w)];
                const roofFrom = yAt(s.from.u) + ROOF_CLEAR_M;
                const roofTo = yAt(s.to.u) + ROOF_CLEAR_M;
                roofPanel([at(a.e, a.n, roofFrom), at(b.e, b.n, roofTo), at(c.e, c.n, roofTo), at(d.e, d.n, roofFrom)], s.run);
                for (const k of [-1, 1]) {
                    for (const [p, u] of [[s.from, s.from.u], [s.to, s.to.u]]) {
                        const q = edge(p, k, hw);
                        const foot = at(q.e, q.n, 0);
                        post(foot.x, foot.z, yAt(u) + RAIL_M, yAt(u) + ROOF_CLEAR_M);
                    }
                }
            }
        });
    };
    const concreteStep = new THREE.MeshStandardMaterial({ color: BRIDGE_DECK, roughness: 0.9 });
    const pts = [];
    const push = (v) => { const last = pts[pts.length - 1]; if (!last || last.distanceTo(v) > 0.05) pts.push(v); };
    // Follow view: the user's start point is not part of the fixed ribbon. The
    // view draws its own live piece from where you are now to the next stop, so
    // the route never stays behind at the spot where it was first worked out.
    const stops = new Map();
    path.forEach((p, i) => {
        if (follow && p.type === 'user') return;
        const here = xz(p.latitude, p.longitude);
        if (p.id != null) stops.set(String(p.id), { x: here.x, y: yOf(p) + 0.25, z: here.z, floor: Math.max(0, floorOf(p)) });
        const prev = path[i - 1];
        if (prev && prev.type !== 'user' && p.type !== 'user' && floorOf(prev) !== floorOf(p)) {
            const link = linkFor(prev, p) || {};
            if (link.id != null) drawnLinks.add(link.id);
            const { plan, bottom, top } = planFromLink(link, prev, p);
            const y0 = yOf(bottom);
            const y1 = yOf(top);
            const base = xz(bottom.latitude, bottom.longitude);
            const climb = walkLine(plan).map((q) => new THREE.Vector3(base.x + q.e, y0 + (plan.rise > 0 ? q.u / plan.rise : 0) * (y1 - y0) + 0.25, base.z - q.n));
            (bottom === prev ? climb : climb.reverse()).forEach(push);
            drawSteps(plan, bottom, top);
            const deck = deckOf(prev) || deckOf(p);
            if (deck) dressBridgeStairs(plan, bottom, top, deck);
        }
        push(new THREE.Vector3(here.x, yOf(p) + 0.25, here.z));
    });
    // Every staircase up to a bridge deck, on the route or not: a bridge is seen with its stairs.
    if (bridges?.length && nodes?.length) {
        const nodeById = new Map(nodes.map((n) => [n.id, n]));
        for (const l of links || []) {
            if (drawnLinks.has(l.id)) continue;
            const a = nodeById.get(l.node_a_id);
            const b = nodeById.get(l.node_b_id);
            const deck = a && b ? deckOf(a) || deckOf(b) : null;
            if (!deck) continue;
            const { plan, bottom, top } = planFromLink(l, a, b);
            // Not on the route: plain concrete steps (the route's own stairs stay amber).
            drawSteps(plan, bottom, top, concreteStep);
            dressBridgeStairs(plan, bottom, top, deck);
        }
    }
    if (pts.length >= 2) {
        // Each turn rounded off with a short curve (up to 1 m each side), so the ribbon bends smoothly
        // instead of kinking: a tube pinches and twists at a sharp corner.
        const curve = new THREE.CurvePath();
        let at = pts[0];
        for (let i = 1; i < pts.length - 1; i += 1) {
            const p = pts[i];
            const back = pts[i - 1].clone().sub(p);
            const ahead = pts[i + 1].clone().sub(p);
            const r = Math.min(1, back.length() / 2, ahead.length() / 2);
            back.normalize();
            ahead.normalize();
            if (r < 0.05 || back.dot(ahead) < -0.999) {
                if (at.distanceTo(p) > 1e-3) curve.add(new THREE.LineCurve3(at, p));
                at = p;
                continue;
            }
            const enter = p.clone().addScaledVector(back, r);
            const leave = p.clone().addScaledVector(ahead, r);
            if (at.distanceTo(enter) > 1e-3) curve.add(new THREE.LineCurve3(at, enter));
            curve.add(new THREE.QuadraticBezierCurve3(enter, p, leave));
            at = leave;
        }
        curve.add(new THREE.LineCurve3(at, pts[pts.length - 1]));
        const segs = Math.min(4000, pts.length * 16);
        // Blue route with a thin dark edge: the edge tube shows only its back
        // faces, so it outlines the blue tube instead of covering it.
        group.add(new THREE.Mesh(new THREE.TubeGeometry(curve, segs, 0.3, 10, false), new THREE.MeshBasicMaterial({ color: ROUTE_EDGE, side: THREE.BackSide })));
        group.add(new THREE.Mesh(new THREE.TubeGeometry(curve, segs, 0.22, 10, false), new THREE.MeshBasicMaterial({ color: ROUTE })));
        // White chevrons lying on top of the tube, pointing towards the destination: a notched arrowhead
        // built pointing along +Z, so lookAt() aims it along the route.
        const chevGeo = new THREE.BufferGeometry();
        chevGeo.setAttribute('position', new THREE.Float32BufferAttribute([
            0, 0, 0.55, 0.42, 0, -0.2, 0, 0, 0.05,
            0, 0, 0.55, 0, 0, 0.05, -0.42, 0, -0.2,
        ], 3));
        chevGeo.computeVertexNormals();
        const chevMat = new THREE.MeshBasicMaterial({ color: ROUTE_CHEVRON, side: THREE.DoubleSide });
        const routeLen = curve.getLength();
        for (let m = CHEVRON_EVERY_M / 2; m < routeLen - 1; m += CHEVRON_EVERY_M) {
            const t = m / routeLen;
            const p = curve.getPointAt(t);
            const tan = curve.getTangentAt(t);
            const chev = new THREE.Mesh(chevGeo, chevMat);
            chev.position.set(p.x, p.y + 0.24, p.z);
            chev.lookAt(p.x + tan.x, p.y + 0.24 + tan.y, p.z + tan.z);
            group.add(chev);
        }
        // Start and destination.
        // You: a person at the start, facing the way the route goes (the
        // follow view moves its own person with you instead).
        if (!follow) {
            const foot = new THREE.Vector3(pts[0].x, pts[0].y - 0.25, pts[0].z);
            const ahead = new THREE.Vector3().subVectors(pts[1], pts[0]).setY(0);
            group.add(person(foot, ahead));
        }
    }
    // The destination pin (also for a one-stop route in the follow view, which
    // has no fixed ribbon: its whole route is the live piece from you).
    if (pts.length >= 1) {
        const end = pts[pts.length - 1];
        const pin = new THREE.Mesh(new THREE.ConeGeometry(0.55, 1.4, 20), new THREE.MeshBasicMaterial({ color: GO }));
        pin.rotation.x = Math.PI;
        pin.position.set(end.x, end.y + 1.1, end.z);
        group.add(pin);
        const head = new THREE.Mesh(new THREE.SphereGeometry(0.55, 20, 14), new THREE.MeshBasicMaterial({ color: GO }));
        head.position.set(end.x, end.y + 1.9, end.z);
        group.add(head);
        const dest = path[path.length - 1];
        if (dest?.name) {
            const label = screenLabel(dest.name, { bg: '#22c55e', fg: '#05230f', icon: 'pin', border: '#ffffff' }, 0.05);
            label.position.set(end.x, end.y + 3.1, end.z);
            group.add(label);
        }
    }

    // Scene position back to latitude / longitude (the follow view's test walk).
    const toLatLng = (x, z) => fromLocalMeters(originLL.lat, originLL.lng, x, -z);
    return { target: new THREE.Vector3(0, 3, 0), radius, xz, toLatLng, routePts: pts, stops };
}

export default function RouteModel3D({ route, buildings, links, bridges = [], objects = [], nodes = [], height = 420 }) {
    const hostRef = useRef(null);
    const stateRef = useRef(null);

    useEffect(() => {
        const host = hostRef.current;
        if (!host) return undefined;
        let renderer;
        try {
            renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        } catch {
            host.setAttribute('data-nogl', '1');
            return undefined;
        }
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer.domElement.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;cursor:grab;';
        host.appendChild(renderer.domElement);
        const scene = new THREE.Scene();
        scene.add(new THREE.AmbientLight(0xffffff, 0.75));
        const sun = new THREE.DirectionalLight(0xffffff, 0.9);
        sun.position.set(-20, 40, 25);
        scene.add(sun);
        const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 3000);
        const group = new THREE.Group();
        scene.add(group);
        const s = {
            raf: 0, dirty: true, az: 0.5, el: 0.62, dist: 60, target: new THREE.Vector3(), pointers: new Map(), pinch: 0, base: 60,
            // Free roam: keys held (W A S D / arrows, Shift = faster) and the
            // phone joystick ({ x, y } in -1..1, y up = forward).
            keys: new Set(), joy: { x: 0, y: 0 }, last: 0, home: new THREE.Vector3(),
        };
        stateRef.current = s;
        const built = buildScene(group, { route, buildings, links, bridges, objects, nodes });
        s.target.copy(built.target);
        s.home.copy(built.target);
        s.base = built.radius * 2.6 + 10;
        s.dist = s.base;

        const place = () => {
            const ce = Math.cos(s.el);
            camera.position.set(s.target.x + s.dist * Math.sin(s.az) * ce, s.target.y + s.dist * Math.sin(s.el), s.target.z + s.dist * Math.cos(s.az) * ce);
            camera.lookAt(s.target);
        };
        const resize = () => {
            renderer.setSize(Math.max(1, host.clientWidth), Math.max(1, host.clientHeight), false);
            camera.aspect = Math.max(1, host.clientWidth) / Math.max(1, host.clientHeight);
            camera.updateProjectionMatrix();
            s.dirty = true;
        };
        const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
        ro?.observe(host);
        resize();
        // Walk the view around: forward is where the camera looks, on the ground.
        const roam = (dt) => {
            let fwd = s.joy.y;
            let side = s.joy.x;
            if (s.keys.has('w') || s.keys.has('arrowup')) fwd += 1;
            if (s.keys.has('s') || s.keys.has('arrowdown')) fwd -= 1;
            if (s.keys.has('d') || s.keys.has('arrowright')) side += 1;
            if (s.keys.has('a') || s.keys.has('arrowleft')) side -= 1;
            if (!fwd && !side) return;
            const speed = Math.max(4, s.dist * 0.6) * (s.keys.has('shift') ? 2.5 : 1) * dt;
            const f = new THREE.Vector3(-Math.sin(s.az), 0, -Math.cos(s.az));
            const r = new THREE.Vector3(Math.cos(s.az), 0, -Math.sin(s.az));
            s.target.addScaledVector(f, fwd * speed).addScaledVector(r, side * speed);
            s.dirty = true;
        };
        const loop = (now = 0) => {
            s.raf = requestAnimationFrame(loop);
            const dt = s.last ? Math.min(0.05, (now - s.last) / 1000) : 0;
            s.last = now;
            roam(dt);
            if (!s.dirty) return;
            s.dirty = false;
            place();
            renderer.render(scene, camera);
        };
        loop();
        const MOVE_KEYS = new Set(['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'shift']);
        const typing = (ev) => /^(INPUT|TEXTAREA|SELECT)$/.test(ev.target?.tagName || '');
        const onKeyDown = (ev) => {
            const k = ev.key.toLowerCase();
            if (!MOVE_KEYS.has(k) || typing(ev)) return;
            if (k !== 'shift') ev.preventDefault();
            s.keys.add(k);
        };
        const onKeyUp = (ev) => s.keys.delete(ev.key.toLowerCase());
        const onBlur = () => s.keys.clear();
        window.addEventListener('keydown', onKeyDown);
        window.addEventListener('keyup', onKeyUp);
        window.addEventListener('blur', onBlur);

        const el = renderer.domElement;
        const onDown = (ev) => {
            el.setPointerCapture?.(ev.pointerId);
            s.pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
            el.style.cursor = 'grabbing';
            if (s.pointers.size === 2) { const [p, q] = [...s.pointers.values()]; s.pinch = Math.hypot(p.x - q.x, p.y - q.y); }
        };
        const onMove = (ev) => {
            const prev = s.pointers.get(ev.pointerId);
            if (!prev) return;
            const cur = { x: ev.clientX, y: ev.clientY };
            if (s.pointers.size === 2) {
                s.pointers.set(ev.pointerId, cur);
                const [p, q] = [...s.pointers.values()];
                const d = Math.hypot(p.x - q.x, p.y - q.y);
                if (s.pinch > 0 && d > 0) s.dist = Math.min(1500, Math.max(8, s.dist * (s.pinch / d)));
                s.pinch = d;
            } else {
                s.az -= (cur.x - prev.x) * 0.01;
                s.el = Math.min(1.45, Math.max(0.08, s.el + (cur.y - prev.y) * 0.008));
                s.pointers.set(ev.pointerId, cur);
            }
            s.dirty = true;
        };
        const onUp = (ev) => { s.pointers.delete(ev.pointerId); s.pinch = 0; if (!s.pointers.size) el.style.cursor = 'grab'; };
        const onWheel = (ev) => { ev.preventDefault(); s.dist = Math.min(1500, Math.max(8, s.dist * (1 + ev.deltaY * 0.001))); s.dirty = true; };
        el.addEventListener('pointerdown', onDown);
        el.addEventListener('pointermove', onMove);
        el.addEventListener('pointerup', onUp);
        el.addEventListener('pointercancel', onUp);
        el.addEventListener('wheel', onWheel, { passive: false });
        return () => {
            cancelAnimationFrame(s.raf);
            ro?.disconnect();
            window.removeEventListener('keydown', onKeyDown);
            window.removeEventListener('keyup', onKeyUp);
            window.removeEventListener('blur', onBlur);
            el.removeEventListener('pointerdown', onDown);
            el.removeEventListener('pointermove', onMove);
            el.removeEventListener('pointerup', onUp);
            el.removeEventListener('pointercancel', onUp);
            el.removeEventListener('wheel', onWheel);
            disposeTree(scene);
            renderer.dispose();
            renderer.forceContextLoss?.();
            if (el.parentNode === host) host.removeChild(el);
            stateRef.current = null;
        };
        // The dialog is re-opened for a new route, so building once is enough.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const reset = () => {
        const s = stateRef.current;
        if (!s) return;
        s.az = 0.5; s.el = 0.62; s.dist = s.base; s.target.copy(s.home); s.dirty = true;
    };

    // Phones: a joystick moves the view (desktop: W A S D).
    const [touch] = useState(() => typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches);
    const joyRef = useRef(null);
    const [knob, setKnob] = useState({ x: 0, y: 0 });
    const joyMove = (ev) => {
        const box = joyRef.current?.getBoundingClientRect();
        const s = stateRef.current;
        if (!box || !s) return;
        const r = box.width / 2;
        let x = (ev.clientX - (box.left + r)) / r;
        let y = (ev.clientY - (box.top + r)) / r;
        const len = Math.hypot(x, y);
        if (len > 1) { x /= len; y /= len; }
        s.joy = { x, y: -y };
        setKnob({ x, y });
    };
    const joyEnd = () => {
        const s = stateRef.current;
        if (s) s.joy = { x: 0, y: 0 };
        setKnob({ x: 0, y: 0 });
    };

    return (
        <div className="route3d" style={{ height }}>
            <div ref={hostRef} className="route3d-host" role="img" aria-label="3D view of the route through the building. Drag to rotate." />
            <button type="button" className="route3d-reset" onClick={reset}>Reset view</button>
            {touch ? (
                <>
                    <span className="route3d-hint" aria-hidden="true">Joystick to move, drag to rotate, pinch to zoom</span>
                    <div
                        ref={joyRef} className="route3d-joy" role="slider" aria-label="Move around the model"
                        aria-valuetext={knob.x || knob.y ? 'Moving' : 'Still'}
                        onPointerDown={(e) => { e.currentTarget.setPointerCapture?.(e.pointerId); joyMove(e); }}
                        onPointerMove={(e) => { if (e.buttons || e.pointerType === 'touch') joyMove(e); }}
                        onPointerUp={joyEnd} onPointerCancel={joyEnd}
                    >
                        <span className="route3d-joy-knob" style={{ transform: `translate(${knob.x * 34}px, ${knob.y * 34}px)` }} />
                    </div>
                </>
            ) : (
                <span className="route3d-keys" aria-label="Move with W A S D or the arrow keys, Shift to go faster. Drag to rotate, scroll to zoom.">
                    <span className="route3d-keycaps" aria-hidden="true">
                        <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd>
                    </span>
                    <span>to move, <kbd>Shift</kbd> faster</span>
                    <span className="route3d-keys-sep" aria-hidden="true" />
                    <span>Drag to rotate, scroll to zoom</span>
                </span>
            )}
        </div>
    );
}

export const ROUTE_MODEL_CSS = `
    .route3d { position: relative; border-radius: ${RADIUS + 4}px; overflow: hidden; background: ${C.bar}; border: 1px solid ${C.hairline}; }
    .route3d-host { position: absolute; inset: 0; }
    .route3d-host[data-nogl] { display: flex; align-items: center; justify-content: center; }
    .route3d-host[data-nogl]::after { content: '3D view needs WebGL'; color: ${C.muted}; font-size: 13px; }
    .route3d-reset { position: absolute; top: 8px; right: 8px; min-height: 44px; padding: 4px 14px; border-radius: 10px;
        border: 1px solid ${C.hairline}; background: ${C.glass}; color: #fff; font-size: 13px; font-weight: 600; cursor: pointer; }
    .route3d-reset:focus-visible { outline: 2px solid ${C.focus}; outline-offset: 2px; }
    /* Top-left, wrapping before the Reset view button (it ran under it on phones). */
    .route3d-hint { position: absolute; left: 8px; top: 8px; max-width: calc(100% - 140px); padding: 4px 12px; border-radius: 6px;
        background: rgba(10,10,12,0.65); font-size: 12px; line-height: 1.35; color: #fff; pointer-events: none; }
    /* Desktop controls tip: key caps, bottom-left. */
    .route3d-keys { position: absolute; left: 10px; bottom: 10px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
        max-width: calc(100% - 20px); padding: 6px 12px 6px 8px; border-radius: 12px; background: rgba(10,10,12,0.72);
        border: 1px solid ${C.hairline}; font-size: 12px; color: rgba(255,255,255,0.85); pointer-events: none; }
    .route3d-keycaps { display: inline-flex; gap: 3px; }
    .route3d-keys kbd { display: inline-grid; place-items: center; min-width: 24px; height: 24px; padding: 0 5px; border-radius: 6px;
        background: #26262c; border: 1px solid rgba(255,255,255,0.2); border-bottom-width: 2px; color: #fff;
        font: 700 12px/1 ${'system-ui, sans-serif'}; }
    .route3d-keys-sep { width: 1px; height: 14px; background: rgba(255,255,255,0.2); }
    /* Phone joystick, bottom-left. */
    .route3d-joy { position: absolute; left: 16px; bottom: 16px; width: 104px; height: 104px; border-radius: 50%; touch-action: none;
        background: rgba(10,10,12,0.55); border: 1px solid rgba(255,255,255,0.22); display: grid; place-items: center;
        -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px); }
    .route3d-joy-knob { width: 44px; height: 44px; border-radius: 50%; background: #fff; box-shadow: 0 2px 10px rgba(0,0,0,0.45);
        transition: transform 80ms linear; pointer-events: none; }
`;
