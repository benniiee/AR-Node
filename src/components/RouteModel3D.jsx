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
import { treeModel, trunkTopM, seededRandom, shedRoof, gateEnds, objectRect, parkingLayout } from '../campusObjects';
import { appearanceOf, roofLayers, roofColorOf, DEFAULT_WALL, DEFAULT_DOOR, BAY_M } from '../buildingAppearance';
import { drawStudioItems } from './buildingItems3D';

// ── The route in 3D (/map → "Route in 3D") ───────────────────────────
// For a student who wants a closer look than the 2.5D map gives: the
// building(s) the route goes into, cut at the highest floor it uses, see-
// through walls, a slab per floor on the route, its doors, the staircase as
// real steps, and the route itself as a tube that climbs those steps, from
// the start point to the destination pin. Drag to orbit, pinch / wheel to zoom.
// Scene axes: x = east, y = up, z = -north (as the other 3D previews).

// Navigation blue (uiTokens C.route), with white chevrons riding on it towards the destination.
export const ROUTE = 0x1f6feb;
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

/**
 * Concrete hollow blocks (CHB) laid in running bond: 0.4 x 0.2 m blocks with grey mortar joints. One tile is
 * 0.8 m across and 1 m high (two blocks by five courses).
 */
const hollowBlockTexture = () => patternTexture(128, 160, (g) => {
    g.fillStyle = '#8a857c';
    g.fillRect(0, 0, 128, 160);
    const rand = seededRandom(11);
    for (let row = 0; row < 5; row += 1) {
        const shift = row % 2 ? 32 : 0;
        for (let col = -1; col < 3; col += 1) {
            const tone = 172 + Math.floor(rand() * 18);
            g.fillStyle = `rgb(${tone}, ${tone - 4}, ${tone - 12})`;
            g.fillRect(col * 64 + shift + 2, row * 32 + 2, 60, 28);
        }
    }
});

const CRANE_YELLOW = 0xf2b705;
const SCAFFOLD_STEEL = 0x8b9198;
const SCAFFOLD_PLANK = 0x9a7446;
const SITE_CONCRETE = 0xa9a59d;

/**
 * Thin bars from point to point, all in one draw call (scaffolding and crane lattices have hundreds).
 * `segments`: [[a, b], ...] scene points.
 */
function addBars(into, segments, size, material) {
    if (!segments.length) return;
    const bars = new THREE.InstancedMesh(new THREE.BoxGeometry(size, 1, size), material, segments.length);
    const up = new THREE.Vector3(0, 1, 0);
    const dir = new THREE.Vector3();
    const mid = new THREE.Vector3();
    const turn = new THREE.Quaternion();
    const stretch = new THREE.Vector3();
    const place = new THREE.Matrix4();
    segments.forEach(([a, b], i) => {
        dir.subVectors(b, a);
        stretch.set(1, Math.max(0.01, dir.length()), 1);
        turn.setFromUnitVectors(up, dir.normalize());
        mid.addVectors(a, b).multiplyScalar(0.5);
        bars.setMatrixAt(i, place.compose(mid, turn, stretch));
    });
    into.add(bars);
}

/**
 * A building under construction: its concrete frame (a slab at every floor, columns, the top storey still
 * open), hollow-block walls going up (the lower floors done, the top one part way), scaffolding round it,
 * a tower crane beside its longest side swinging over it, and pallets of hollow blocks on the ground.
 * How far along it is comes from `seed` (the building's id), so it looks the same every time.
 * `ring`: its outline in scene coordinates ({x, z}), `height` its finished height (m).
 */
export function drawConstructionSite(into, ring, height, floors, seed) {
    const rand = seededRandom((Number(seed) || 1) * 7 + 3);
    const levels = Math.max(1, Number(floors) || 1);
    const storeyH = height / levels;
    const V = (x, y, z) => new THREE.Vector3(x, y, z);
    const concrete = new THREE.MeshStandardMaterial({ color: SITE_CONCRETE, roughness: 0.95 });
    const blocks = hollowBlockTexture();
    const blockWall = new THREE.MeshStandardMaterial({ color: blocks ? 0xffffff : 0xb3ada2, map: blocks, roughness: 0.95, side: THREE.DoubleSide });
    const steel = new THREE.MeshStandardMaterial({ color: SCAFFOLD_STEEL, roughness: 0.5, metalness: 0.4 });
    const plank = new THREE.MeshStandardMaterial({ color: SCAFFOLD_PLANK, roughness: 0.9 });
    const yellow = new THREE.MeshStandardMaterial({ color: CRANE_YELLOW, roughness: 0.6, metalness: 0.2 });

    // Which way round the outline goes, so "outward" is known for every side.
    let area2 = 0;
    ring.forEach((p, i) => { const q = ring[(i + 1) % ring.length]; area2 += p.x * q.z - q.x * p.z; });
    const out = area2 > 0 ? 1 : -1;
    const sides = ring.map((a, i) => {
        const b = ring[(i + 1) % ring.length];
        const len = Math.hypot(b.x - a.x, b.z - a.z);
        const d = { x: (b.x - a.x) / (len || 1), z: (b.z - a.z) / (len || 1) };
        return { a, b, len, d, n: { x: d.z * out, z: -d.x * out } };
    }).filter((side) => side.len > 0.3);
    if (!sides.length) return;

    // Floor slabs (the roof is not cast yet: the top storey is an open frame).
    const outline = new THREE.Shape(ring.map((p) => new THREE.Vector2(p.x, -p.z)));
    for (let k = 1; k < levels; k += 1) {
        const slab = new THREE.ExtrudeGeometry(outline, { depth: 0.2, bevelEnabled: false });
        slab.rotateX(-Math.PI / 2);
        const mesh = new THREE.Mesh(slab, concrete);
        mesh.position.y = k * storeyH - 0.2;
        into.add(mesh);
    }
    // Columns at the corners and every 4-5 m along each side, up past the top storey (bare, not roofed yet).
    const columns = [];
    for (const side of sides) {
        const bays = Math.max(1, Math.round(side.len / 4.5));
        for (let i = 0; i < bays; i += 1) {
            const t = i / bays;
            const x = side.a.x + (side.b.x - side.a.x) * t;
            const z = side.a.z + (side.b.z - side.a.z) * t;
            columns.push([V(x, 0, z), V(x, height + 0.6, z)]);
        }
    }
    addBars(into, columns, 0.35, concrete);

    // Hollow-block walls: full on the lower floors, part way up the top storey (less on some sides).
    const wallTop = (levels - 1) * storeyH + storeyH * (0.3 + rand() * 0.35);
    for (const side of sides) {
        const top = Math.max(0.6, wallTop - (rand() < 0.4 ? rand() * storeyH * 0.6 : 0));
        const g = new THREE.BufferGeometry();
        // Just outside the slab edges (the face of the wall), so the two never flicker.
        const a = { x: side.a.x + side.n.x * 0.1, z: side.a.z + side.n.z * 0.1 };
        const b = { x: side.b.x + side.n.x * 0.1, z: side.b.z + side.n.z * 0.1 };
        g.setAttribute('position', new THREE.Float32BufferAttribute([a.x, 0, a.z, b.x, 0, b.z, b.x, top, b.z, a.x, 0, a.z, b.x, top, b.z, a.x, top, a.z], 3));
        const u = side.len / 0.8;
        g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, u, 0, u, top, 0, 0, u, top, 0, top], 2));
        g.computeVertexNormals();
        into.add(new THREE.Mesh(g, blockWall));
    }

    // Scaffolding round the outside: two rows of standards, ledgers and planks every 2 m, cross braces.
    const lift = 2;
    const scaffTop = Math.min(height + 1, wallTop + 1.5);
    const standards = [];
    const ledgers = [];
    const braces = [];
    const boards = [];
    for (const side of sides) {
        const off = (m, t) => ({ x: side.a.x + side.d.x * t + side.n.x * m, z: side.a.z + side.d.z * t + side.n.z * m });
        const bays = Math.max(1, Math.round(side.len / 2.2));
        for (let i = 0; i <= bays; i += 1) {
            const t = (i / bays) * side.len;
            for (const m of [0.4, 1.3]) {
                const p = off(m, t);
                standards.push([V(p.x, 0, p.z), V(p.x, scaffTop, p.z)]);
            }
            for (let y = lift; y <= scaffTop + 0.01; y += lift) {
                const p = off(0.4, t);
                const q = off(1.3, t);
                ledgers.push([V(p.x, y, p.z), V(q.x, y, q.z)]);
            }
        }
        for (let y = lift; y <= scaffTop + 0.01; y += lift) {
            for (const m of [0.4, 1.3]) {
                const p = off(m, 0);
                const q = off(m, side.len);
                ledgers.push([V(p.x, y, p.z), V(q.x, y, q.z)]);
            }
            // The planks people walk on, between the two rows.
            const p = off(0.85, 0);
            const q = off(0.85, side.len);
            boards.push({ a: V(p.x, y + 0.04, p.z), b: V(q.x, y + 0.04, q.z) });
        }
        // Zig-zag braces on the outer face.
        for (let i = 0; i < bays; i += 1) {
            const t0 = (i / bays) * side.len;
            const t1 = ((i + 1) / bays) * side.len;
            for (let y = 0; y + lift <= scaffTop + 0.01; y += lift) {
                const flip = (i + Math.round(y / lift)) % 2;
                const p = off(1.3, flip ? t0 : t1);
                const q = off(1.3, flip ? t1 : t0);
                braces.push([V(p.x, y, p.z), V(q.x, y + lift, q.z)]);
            }
        }
    }
    addBars(into, standards, 0.06, steel);
    addBars(into, ledgers, 0.05, steel);
    addBars(into, braces, 0.04, steel);
    for (const { a, b } of boards) {
        const board = new THREE.Mesh(new THREE.BoxGeometry(0.75, 0.05, a.distanceTo(b)), plank);
        board.position.addVectors(a, b).multiplyScalar(0.5);
        board.lookAt(b.x, board.position.y, b.z);
        into.add(board);
    }

    // The tower crane, beside the longest side, its jib swung out over the building.
    const long = sides.reduce((best, side) => (side.len > best.len ? side : best), sides[0]);
    const crane = new THREE.Group();
    const along = 0.25 + rand() * 0.5;
    crane.position.set(
        long.a.x + long.d.x * long.len * along + long.n.x * 5,
        0,
        long.a.z + long.d.z * long.len * along + long.n.z * 5,
    );
    const baseYaw = Math.atan2(long.n.z, -long.n.x) + (rand() - 0.5) * 1.2;
    into.add(crane);
    const mastH = height + 9;
    const w = 0.85;
    const darkSteel = new THREE.MeshStandardMaterial({ color: 0x262930, roughness: 0.55, metalness: 0.45 });
    const glassMat = new THREE.MeshStandardMaterial({ color: 0x1e3a4c, roughness: 0.15, metalness: 0.55 });
    const beaconMat = new THREE.MeshStandardMaterial({ color: 0xff2a2a, emissive: 0xff1a1a, emissiveIntensity: 0.9, roughness: 0.3 });

    // Heavy concrete foundation pad + base anchor struts.
    const pad = new THREE.Mesh(new THREE.BoxGeometry(3.6, 0.55, 3.6), concrete);
    pad.position.y = 0.275;
    crane.add(pad);
    const collar = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.22, 2.1), darkSteel);
    collar.position.y = 0.62;
    crane.add(collar);

    const mastChords = [];
    const mastBraces = [];
    const corners = [[-w, -w], [w, -w], [w, w], [-w, w]];
    for (const [x, z] of corners) {
        mastChords.push([V(x, 0.6, z), V(x, mastH, z)]);
        mastBraces.push([V(x * 1.75, 0.55, z * 1.75), V(x, 2.2, z)]);
    }
    for (let y = 0.6; y < mastH - 0.1; y += 1.6) {
        const yNext = Math.min(mastH, y + 1.6);
        corners.forEach(([x, z], i) => {
            const [x2, z2] = corners[(i + 1) % 4];
            mastBraces.push(
                [V(x, y, z), V(x2, y, z2)],
                [V(x, y, z), V(x2, yNext, z2)],
                [V(x2, y, z2), V(x, yNext, z)],
            );
        });
    }
    addBars(crane, mastChords, 0.14, yellow);
    addBars(crane, mastBraces, 0.085, yellow);

    // Slewing upper assembly (turntable, cat-head, jib, counter-jib, cab, trolley, hoist) rotates smoothly around the mast.
    const slew = new THREE.Group();
    slew.rotation.y = baseYaw;
    crane.add(slew);

    // Slewing ring + machinery deck + safety handrails.
    const slewRing = new THREE.Mesh(new THREE.CylinderGeometry(1.12, 1.12, 0.42, 16), darkSteel);
    slewRing.position.y = mastH - 0.05;
    slew.add(slewRing);
    const slewDeck = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.18, 2.3), yellow);
    slewDeck.position.y = mastH + 0.22;
    slew.add(slewDeck);

    const jibLattice = [];
    const jibThin = [];
    const extent = Math.max(...ring.map((p) => Math.hypot(p.x - crane.position.x, p.z - crane.position.z)));
    const jibL = Math.min(45, Math.max(14, extent * 0.85));
    const backL = Math.max(6.5, jibL * 0.32);
    const jibY = mastH + 0.38;

    // Main jib & counter-jib bottom chords + top chords (deep triangular Warren/Pratt truss).
    const jibW = 0.6;
    const jibH0 = 1.55;
    const jibHTip = 0.92;
    const jibHBack = 0.78;
    for (const z of [-jibW, jibW]) jibLattice.push([V(-backL, jibY, z), V(jibL, jibY, z)]);
    jibLattice.push([V(0, jibY + jibH0, 0), V(jibL, jibY + jibHTip, 0)]);
    jibLattice.push([V(0, jibY + jibH0, 0), V(-backL, jibY + jibHBack, 0)]);
    for (let x = 0; x < jibL - 0.05; x += 1.15) {
        const x2 = Math.min(jibL, x + 1.15);
        const xm = (x + x2) * 0.5;
        const t1 = jibY + jibH0 - ((jibH0 - jibHTip) * x) / jibL;
        const tm = jibY + jibH0 - ((jibH0 - jibHTip) * xm) / jibL;
        for (const z of [-jibW, jibW]) {
            jibThin.push([V(x, jibY, z), V(x, t1, 0)], [V(x, jibY, z), V(xm, tm, 0)], [V(xm, tm, 0), V(x2, jibY, z)]);
        }
        jibThin.push([V(x, jibY, -jibW), V(x, jibY, jibW)], [V(x, jibY, -jibW), V(x2, jibY, jibW)]);
    }
    jibThin.push(
        [V(jibL, jibY, -jibW), V(jibL, jibY, jibW)],
        [V(jibL, jibY, -jibW), V(jibL, jibY + jibHTip, 0)],
        [V(jibL, jibY, jibW), V(jibL, jibY + jibHTip, 0)],
    );

    // Counter-jib cross-bracing.
    for (let x = 0; x < backL - 0.05; x += 1.15) {
        const x2 = Math.min(backL, x + 1.15);
        const xm = (x + x2) * 0.5;
        const t1 = jibY + jibH0 - ((jibH0 - jibHBack) * x) / backL;
        const tm = jibY + jibH0 - ((jibH0 - jibHBack) * xm) / backL;
        for (const z of [-jibW, jibW]) {
            jibThin.push([V(-x, jibY, z), V(-x, t1, 0)], [V(-x, jibY, z), V(-xm, tm, 0)], [V(-xm, tm, 0), V(-x2, jibY, z)]);
        }
        jibThin.push([V(-x, jibY, -jibW), V(-x, jibY, jibW)]);
    }
    jibThin.push([V(-backL, jibY, -jibW), V(-backL, jibY, jibW)]);

    // 4-legged A-frame tower head (cat-head) + pendant tie rods + safety rails.
    const headY = mastH + 5.2;
    for (const [cx, cz] of [[-0.75, -jibW], [0.75, -jibW], [0.75, jibW], [-0.75, jibW]]) {
        jibLattice.push([V(cx, jibY, cz), V(0, headY, 0)]);
    }
    const f1 = jibL * 0.42;
    const f2 = jibL * 0.78;
    const b1 = backL * 0.55;
    jibThin.push(
        [V(0, headY, 0), V(f1, jibY + jibH0 - ((jibH0 - jibHTip) * f1) / jibL, 0)],
        [V(0, headY, 0), V(f2, jibY + jibH0 - ((jibH0 - jibHTip) * f2) / jibL, 0)],
        [V(0, headY, 0), V(-b1, jibY + jibH0 - ((jibH0 - jibHBack) * b1) / backL, 0)],
        [V(0, headY, 0), V(-backL, jibY + jibHBack, 0)],
    );
    // Safety handrail along the slewing deck.
    for (const z of [-1.1, 1.1]) {
        jibThin.push([V(-1.15, mastH + 1.05, z), V(1.15, mastH + 1.05, z)]);
        for (const x of [-1.15, 0, 1.15]) jibThin.push([V(x, mastH + 0.3, z), V(x, mastH + 1.05, z)]);
    }
    addBars(slew, jibLattice, 0.13, yellow);
    addBars(slew, jibThin, 0.075, yellow);

    // Red aviation warning light at the top of the cat-head.
    const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.18, 10, 8), beaconMat);
    beacon.position.set(0, headY + 0.16, 0);
    slew.add(beacon);

    // Operator cab with wrap-around tinted glass windows and roof cap.
    const cabGroup = new THREE.Group();
    cabGroup.position.set(0.75, mastH - 0.55, 1.32);
    const cabBody = new THREE.Mesh(new THREE.BoxGeometry(1.45, 1.55, 1.25), new THREE.MeshStandardMaterial({ color: 0xe9e4d6, roughness: 0.45 }));
    const cabGlass = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.75, 1.3), glassMat);
    cabGlass.position.y = 0.18;
    const cabRoof = new THREE.Mesh(new THREE.BoxGeometry(1.58, 0.14, 1.38), yellow);
    cabRoof.position.y = 0.82;
    cabGroup.add(cabBody, cabGlass, cabRoof);
    slew.add(cabGroup);

    // Hoist winch machinery housing + segmented concrete counterweight blocks.
    const winch = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.05, 1.1), darkSteel);
    winch.position.set(-2.1, jibY + 0.55, 0);
    slew.add(winch);
    for (let i = 0; i < 3; i += 1) {
        const block = new THREE.Mesh(new THREE.BoxGeometry(0.62, 1.65, 1.45), concrete);
        block.position.set(-backL + 0.85 + i * 0.7, jibY - 0.52, 0);
        slew.add(block);
    }

    // Trolley + dual hoist cables + hook block + hanging pallet of hollow blocks, animated along the jib.
    const reach = jibL * (0.45 + rand() * 0.4);
    const hookY = Math.max(2, height * (0.4 + rand() * 0.5));
    const trolleyGroup = new THREE.Group();
    trolleyGroup.position.set(reach, 0, 0);
    slew.add(trolleyGroup);
    const trolley = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.34, 1.22), yellow);
    trolley.position.set(0, jibY - 0.14, 0);
    trolleyGroup.add(trolley);
    for (const [wx, wz] of [[-0.42, -0.55], [0.42, -0.55], [-0.42, 0.55], [0.42, 0.55]]) {
        const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.12, 8), darkSteel);
        wheel.rotation.x = Math.PI / 2;
        wheel.position.set(wx, jibY - 0.02, wz);
        trolleyGroup.add(wheel);
    }
    const cableMat = new THREE.MeshStandardMaterial({ color: 0x222226, metalness: 0.4 });
    const cable = new THREE.Group();
    for (const cz of [-0.1, 0.1]) {
        const lineMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, 1, 6), cableMat);
        lineMesh.position.z = cz;
        cable.add(lineMesh);
    }
    const cableLen = Math.max(0.5, jibY - 0.15 - (hookY + 1.35));
    cable.scale.y = cableLen;
    cable.position.set(0, jibY - 0.15 - cableLen / 2, 0);
    trolleyGroup.add(cable);

    const blockMat = new THREE.MeshStandardMaterial({ color: blocks ? 0xffffff : 0xb3ada2, map: blocks, roughness: 0.95 });
    const makePallet = (withHook = false) => {
        const g = new THREE.Group();
        const stack = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.8, 1), blockMat);
        stack.position.set(0, 0.52, 0);
        const base = new THREE.Mesh(new THREE.BoxGeometry(1.25, 0.12, 1.05), plank);
        base.position.set(0, 0.06, 0);
        g.add(stack, base);
        if (withHook) {
            const hookBody = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.34, 0.28), yellow);
            hookBody.position.set(0, 1.34, 0);
            const hookTip = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.18, 6), darkSteel);
            hookTip.position.set(0, 1.1, 0);
            g.add(hookBody, hookTip);
            addBars(g, [
                [V(0, 1.06, 0), V(-0.56, 0.9, -0.46)],
                [V(0, 1.06, 0), V(0.56, 0.9, -0.46)],
                [V(0, 1.06, 0), V(0.56, 0.9, 0.46)],
                [V(0, 1.06, 0), V(-0.56, 0.9, 0.46)],
            ], 0.02, cableMat);
        }
        return g;
    };
    const load = makePallet(true);
    load.position.set(0, hookY, 0);
    trolleyGroup.add(load);

    // Register for gentle real-time slewing, trolley travel, and hoisting.
    if (!into.userData.cranes) into.userData.cranes = [];
    into.userData.cranes.push({
        slew,
        trolleyGroup,
        cable,
        load,
        baseYaw,
        jibY,
        phase: rand() * Math.PI * 2,
        reachMin: jibL * 0.35,
        reachMax: jibL * 0.88,
        hookMin: Math.max(1.8, height * 0.3),
        hookMax: Math.max(2.6, Math.min(jibY - 2.8, height * 0.92)),
    });

    // Pallets of blocks waiting on the ground by the crane.
    const piles = 3 + Math.floor(rand() * 3);
    for (let i = 0; i < piles; i += 1) {
        const groundPallet = makePallet(false);
        groundPallet.position.set(-3 - (i % 3) * 1.5, 0, 2.6 + Math.floor(i / 3) * 1.3);
        crane.add(groundPallet);
    }
}

/**
 * Gently animates all under-construction tower cranes in `root` (slewing jib, gliding trolley,
 * and hoisting load). Safe to call every frame.
 */
export function animateCranes(root, timeSec) {
    const cranes = root?.userData?.cranes;
    if (!Array.isArray(cranes) || !cranes.length) return false;
    for (const c of cranes) {
        const t = timeSec + c.phase;
        c.slew.rotation.y = c.baseYaw + Math.sin(t * 0.22) * 0.48;
        const reachMix = 0.5 + 0.5 * Math.sin(t * 0.31 + 1.1);
        c.trolleyGroup.position.x = c.reachMin + (c.reachMax - c.reachMin) * reachMix;
        const hookMix = 0.5 + 0.5 * Math.sin(t * 0.45 + 2.3);
        const hy = c.hookMin + (c.hookMax - c.hookMin) * hookMix;
        c.load.position.y = hy;
        const cableLen = Math.max(0.5, c.jibY - 0.15 - (hy + 1.35));
        c.cable.scale.y = cableLen;
        c.cable.position.y = c.jibY - 0.15 - cableLen / 2;
    }
    return true;
}

/** A #rrggbb colour darkened by a share `k` (0..1), as a CSS colour for canvas painting. */
const darker = (hex, k) => `#${new THREE.Color(hex).multiplyScalar(1 - k).getHexString()}`;

/**
 * The front of a building as a repeating tile (one bay, one storey): its wall colour, the floor band at
 * the foot of each storey (the accent colour when there is one), and its windows with grilles, an open
 * arched walkway behind a low wall, or windows between full-height pillars.
 */
function facadeTexture(look) {
    const wall = look.walls.color || DEFAULT_WALL;
    const accent = look.walls.accent;
    const band = look.walls.band || accent;
    const frame = look.windows?.frame || '#2b3440';
    const awning = Boolean(look.windows?.awning);
    return patternTexture(128, 128, (g) => {
        g.fillStyle = wall;
        g.fillRect(0, 0, 128, 128);
        // The storey band along the foot: the accent, or the department's band colour.
        g.fillStyle = band || darker(wall, 0.18);
        g.fillRect(0, band ? 112 : 119, 128, band ? 16 : 9);
        if (look.facade === 'none') {
            return;
        }
        if (look.facade === 'arches' || look.facade === 'balcony') {
            g.fillStyle = '#3b3631';
            g.beginPath();
            g.moveTo(14, 119);
            g.lineTo(14, 64);
            g.arc(64, 64, 50, Math.PI, 0);
            g.lineTo(114, 119);
            g.closePath();
            g.fill();
            if (look.facade === 'balcony') {
                // An open gallery: the walkway's ceiling, a low parapet with a rail, no glazing.
                g.fillStyle = darker(wall, 0.35);
                g.fillRect(14, 40, 100, 14);
                g.fillStyle = wall;
                g.fillRect(14, 93, 100, 26);
                g.fillStyle = accent || darker(wall, 0.3);
                g.fillRect(14, 89, 100, 5);
                g.strokeStyle = darker(wall, 0.1);
                g.lineWidth = 3;
                g.beginPath();
                g.moveTo(14, 70);
                g.lineTo(114, 70);
                g.stroke();
            } else {
                // The low wall of the walkway and its rail.
                g.fillStyle = wall;
                g.fillRect(14, 93, 100, 26);
                g.fillStyle = accent || darker(wall, 0.3);
                g.fillRect(14, 89, 100, 5);
            }
        } else if (look.facade === 'glass') {
            // A curtain wall: glazing bay to bay with slim mullions and a spandrel below.
            g.fillStyle = '#31424f';
            g.fillRect(6, 20, 116, 74);
            g.strokeStyle = 'rgba(232, 240, 246, 0.55)';
            g.lineWidth = 2;
            g.beginPath();
            for (const x of [6, 45, 83, 122]) { g.moveTo(x, 20); g.lineTo(x, 94); }
            g.moveTo(6, 57);
            g.lineTo(122, 57);
            g.stroke();
            g.fillStyle = darker(wall, 0.22);
            g.fillRect(6, 94, 116, 12);
        } else if (look.facade === 'louvres') {
            // Wooden slats across the opening: the louvre screens of the older blocks.
            g.fillStyle = darker(wall, 0.55);
            g.fillRect(20, 34, 88, 62);
            g.fillStyle = '#8a6a44';
            for (let y = 36; y < 94; y += 6) g.fillRect(22, y, 84, 3);
        } else {
            g.fillStyle = frame;
            g.fillRect(24, 36, 80, 56);
            g.fillStyle = '#2b3440';
            g.fillRect(28, 40, 72, 48);
            g.strokeStyle = 'rgba(225, 230, 235, 0.6)';
            g.lineWidth = 2;
            g.beginPath();
            for (const x of [52, 76]) { g.moveTo(x, 40); g.lineTo(x, 88); }
            g.moveTo(28, 64);
            g.lineTo(100, 64);
            g.stroke();
            g.fillStyle = darker(wall, 0.14);
            g.fillRect(22, 92, 84, 5);
            if (look.facade === 'pillars') {
                g.fillStyle = accent || darker(wall, 0.16);
                g.fillRect(0, 0, 14, 128);
            }
        }
        if (awning) {
            // The concrete eyebrow over each window: two bands, lit top and shadowed underside.
            g.fillStyle = '#efece4';
            g.fillRect(16, 24, 96, 8);
            g.fillStyle = '#c9c4b8';
            g.fillRect(16, 32, 96, 4);
        }
    });
}

/**
 * The roof's surface texture: corrugated ribs, clay-tile rows or staggered shingles, in the roof's own
 * colour. Concrete (or a flat roof) has none: it is the plain coloured face.
 */
function roofTexture(look) {
    const base = roofColorOf(look);
    const material = look.roof?.material || 'metal';
    if (material === 'concrete') return null;
    return patternTexture(64, 64, (g) => {
        g.fillStyle = base;
        g.fillRect(0, 0, 64, 64);
        if (material === 'metal') {
            for (let x = 0; x < 64; x += 8) {
                g.fillStyle = 'rgba(255, 255, 255, 0.22)';
                g.fillRect(x, 0, 2, 64);
                g.fillStyle = 'rgba(0, 0, 0, 0.16)';
                g.fillRect(x + 4, 0, 2, 64);
            }
        } else if (material === 'tile') {
            g.strokeStyle = 'rgba(0, 0, 0, 0.22)';
            g.lineWidth = 2;
            for (let y = 0; y < 64; y += 16) {
                g.beginPath();
                g.moveTo(0, y);
                g.lineTo(64, y);
                g.stroke();
                for (let x = ((y / 16) % 2) * 8; x < 64; x += 16) {
                    g.beginPath();
                    g.moveTo(x, y);
                    g.lineTo(x, y + 16);
                    g.stroke();
                }
            }
        } else {
            g.fillStyle = 'rgba(0, 0, 0, 0.18)';
            for (let y = 0; y < 64; y += 10) {
                for (let x = ((y / 10) % 2) * 10; x < 64; x += 20) g.fillRect(x, y, 18, 2);
            }
        }
    });
}

/** The sign over an entrance: dark letters on a light board with a coloured edge. Returns its texture and width (m). */
function signTexture(text, edge) {
    if (typeof document === 'undefined') return null;
    const canvas = document.createElement('canvas');
    const g = canvas.getContext('2d');
    const font = 'bold 72px system-ui, -apple-system, "Segoe UI", sans-serif';
    g.font = font;
    const w = Math.min(2048, Math.ceil(g.measureText(text).width) + 80);
    canvas.width = w;
    canvas.height = 112;
    g.fillStyle = edge;
    g.fillRect(0, 0, w, 112);
    g.fillStyle = '#f8f6f0';
    g.fillRect(6, 6, w - 12, 100);
    g.fillStyle = '#1f2937';
    g.font = font;
    g.textBaseline = 'middle';
    g.textAlign = 'center';
    g.fillText(text, w / 2, 60);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    return { tex, widthM: Math.min(14, (w / 112) * 0.7) };
}

/**
 * A building's outside as it looks (Building Studio): walls painted with its front (windows, arches or
 * pillars, one tile a bay and a storey), its roof (flat, sloped or curved, in its colour), and at its
 * doors a canopy, the sign over the main entrance and a ramp up to it when it has them.
 * `ring`: the outline in scene coordinates ({x, z}); `doors`: [{a, b, normalDeg}] in scene coordinates.
 * Returns the height of the top of the roof.
 */
export function drawBuildingExterior(into, { ring, height, floors, look, doors = [], studio = null }) {
    const levels = Math.max(1, Number(floors) || Math.round(height / 3.2) || 1);
    const storeyH = height / levels;
    const xray = Boolean(studio?.showInterior);
    // Walls: one mesh, every side a quad with the front tile repeated along it and up it.
    const facade = facadeTexture(look);
    const wallMat = new THREE.MeshStandardMaterial({
        color: facade ? 0xffffff : (look.walls.color || DEFAULT_WALL),
        map: facade,
        roughness: 0.9,
        side: THREE.DoubleSide,
        ...(xray ? { transparent: true, opacity: 0.2, depthWrite: false } : {}),
    });
    if (studio) {
        // Cut real doorway openings into the studio walls so glass doors and interiors are visible through them,
        // while keeping one mesh per wall edge for raycasting (studioWallEdge).
        const doorH = Math.min(DOOR_HEIGHT_M, height * 0.85);
        const spans = new Map();
        for (const d of doors) {
            if (d.edge == null || !ring[d.edge]) continue;
            const a = ring[d.edge];
            const b = ring[(d.edge + 1) % ring.length];
            const ex = b.x - a.x;
            const ez = b.z - a.z;
            const len2 = ex * ex + ez * ez;
            if (!(len2 > 1e-6)) continue;
            const tA = Math.max(0, Math.min(1, ((d.a.x - a.x) * ex + (d.a.z - a.z) * ez) / len2));
            const tB = Math.max(0, Math.min(1, ((d.b.x - a.x) * ex + (d.b.z - a.z) * ez) / len2));
            if (!spans.has(d.edge)) spans.set(d.edge, []);
            spans.get(d.edge).push([Math.min(tA, tB), Math.max(tA, tB)]);
        }
        ring.forEach((a, i) => {
            const b = ring[(i + 1) % ring.length];
            const edgeLen = Math.hypot(b.x - a.x, b.z - a.z);
            const uMax = edgeLen / BAY_M;
            const vMax = height / storeyH;
            const vDoor = doorH / storeyH;
            const pos = [];
            const uv = [];
            const pushSeg = (t0, t1, y0, y1, v0, v1) => {
                if (t1 - t0 < 1e-4 || y1 - y0 < 1e-4) return;
                const x0 = a.x + (b.x - a.x) * t0;
                const z0 = a.z + (b.z - a.z) * t0;
                const x1 = a.x + (b.x - a.x) * t1;
                const z1 = a.z + (b.z - a.z) * t1;
                const u0 = t0 * uMax;
                const u1 = t1 * uMax;
                pos.push(x0, y0, z0, x1, y0, z1, x1, y1, z1, x0, y0, z0, x1, y1, z1, x0, y1, z0);
                uv.push(u0, v0, u1, v0, u1, v1, u0, v0, u1, v1, u0, v1);
            };
            let from = 0;
            for (const [t0, t1] of (spans.get(i) || []).sort((x, y) => x[0] - y[0])) {
                pushSeg(from, t0, 0, height, 0, vMax);
                pushSeg(t0, t1, doorH, height, vDoor, vMax);
                from = Math.max(from, t1);
            }
            pushSeg(from, 1, 0, height, 0, vMax);
            if (pos.length) {
                const wg = new THREE.BufferGeometry();
                wg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
                wg.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
                wg.computeVertexNormals();
                const wm = new THREE.Mesh(wg, wallMat);
                wm.userData.studioWallEdge = i;
                if (xray) wm.renderOrder = 4;
                into.add(wm);
            }
        });
        if (xray) {
            const shellEdge = new THREE.LineBasicMaterial({ color: 0xe2e8f0, transparent: true, opacity: 0.65 });
            ring.forEach((a, i) => {
                const b = ring[(i + 1) % ring.length];
                into.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([
                    new THREE.Vector3(a.x, 0, a.z), new THREE.Vector3(a.x, height, a.z),
                ]), shellEdge));
                into.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([
                    new THREE.Vector3(a.x, height, a.z), new THREE.Vector3(b.x, height, b.z),
                ]), shellEdge));
            });
        }
    } else {
        const pos = [];
        const uv = [];
        ring.forEach((a, i) => {
            const b = ring[(i + 1) % ring.length];
            const u = Math.hypot(b.x - a.x, b.z - a.z) / BAY_M;
            const v = height / storeyH;
            pos.push(a.x, 0, a.z, b.x, 0, b.z, b.x, height, b.z, a.x, 0, a.z, b.x, height, b.z, a.x, height, a.z);
            uv.push(0, 0, u, 0, u, v, 0, 0, u, v, 0, v);
        });
        const walls = new THREE.BufferGeometry();
        walls.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        walls.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
        walls.computeVertexNormals();
        into.add(new THREE.Mesh(walls, wallMat));
    }

    // Roof: the rings from the eave to the top (src/buildingAppearance.js), joined side by side, and the top.
    const { rings, rise } = roofLayers(ring.map((p) => ({ x: p.x, y: -p.z })), look.roof.style);
    // Its surface: ribs, tile rows or shingles when it is not plain concrete (Building Studio).
    const sheet = roofTexture(look);
    const roofMat = new THREE.MeshStandardMaterial({
        color: sheet ? 0xffffff : roofColorOf(look), map: sheet, roughness: 0.7, metalness: look.roof?.material === 'metal' ? 0.25 : 0.1,
        flatShading: true, side: THREE.DoubleSide,
        ...(xray ? { transparent: true, opacity: 0.2, depthWrite: false } : {}),
    });
    const faces = [];
    const uvs = [];
    const put = (q, h) => {
        faces.push(q.x, height + h, -q.y);
        // The roof's own metres, so the pattern repeats at a real scale on any building.
        uvs.push(q.x / 1.5, q.y / 1.5);
    };
    for (let k = 0; k + 1 < rings.length; k += 1) {
        const A = rings[k];
        const B = rings[k + 1];
        const n = A.pts.length;
        for (let i = 0; i < n; i += 1) {
            const a0 = A.pts[i];
            const a1 = A.pts[(i + 1) % n];
            const b0 = B.pts[i];
            const b1 = B.pts[(i + 1) % n];
            put(a0, A.h); put(a1, A.h); put(b1, B.h);
            put(a0, A.h); put(b1, B.h); put(b0, B.h);
        }
    }
    if (faces.length) {
        const slopes = new THREE.BufferGeometry();
        slopes.setAttribute('position', new THREE.Float32BufferAttribute(faces, 3));
        slopes.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
        slopes.computeVertexNormals();
        into.add(new THREE.Mesh(slopes, roofMat));
    }
    const last = rings[rings.length - 1];
    const top = new THREE.ShapeGeometry(new THREE.Shape(last.pts.map((q) => new THREE.Vector2(q.x, q.y))));
    top.rotateX(-Math.PI / 2);
    const cap = new THREE.Mesh(top, roofMat);
    cap.position.y = height + last.h + 0.02;
    if (studio) cap.userData.studioRoof = true;
    into.add(cap);

    // The entrance: a canopy over every door, the sign and a ramp at the main one (the first).
    const entrance = look.entrance;
    const canopyMat = new THREE.MeshStandardMaterial({ color: entrance.color, roughness: 0.6 });
    const concrete = new THREE.MeshStandardMaterial({ color: 0xb9b5ac, roughness: 0.95 });
    const steel = new THREE.MeshStandardMaterial({ color: 0xc9ccd1, roughness: 0.4, metalness: 0.6 });
    // The doors themselves: glass, timber, sliding, double wood, arched, steel or roll-up (Building Studio).
    const defaultDoorHex = entrance.door === 'wood' || entrance.door === 'double_wood'
        ? '#6b4a2f'
        : entrance.door === 'sliding'
            ? '#26404f'
            : entrance.door === 'steel'
                ? '#6f757c'
                : entrance.door === 'roll_up'
                    ? '#9aa3a8'
                    : DEFAULT_DOOR;
    const doorColor = entrance.doorColor || defaultDoorHex;
    const isGlazedDoor = entrance.door === 'glass' || entrance.door === 'sliding' || entrance.door === 'arched';
    const doorMat = new THREE.MeshStandardMaterial({
        color: doorColor,
        roughness: isGlazedDoor ? 0.28 : (entrance.door === 'steel' || entrance.door === 'roll_up' ? 0.45 : 0.8),
        metalness: entrance.door === 'wood' || entrance.door === 'double_wood' ? 0.05 : (entrance.door === 'steel' || entrance.door === 'roll_up' ? 0.45 : 0.25),
        side: THREE.DoubleSide,
        ...(studio && isGlazedDoor ? { transparent: true, opacity: 0.34, depthWrite: false } : {}),
    });
    doors.forEach((door, i) => {
        const len = Math.hypot(door.b.x - door.a.x, door.b.z - door.a.z) || 1;
        const d = { x: (door.b.x - door.a.x) / len, z: (door.b.z - door.a.z) / len };
        const rad = (door.normalDeg * Math.PI) / 180;
        const n = { x: Math.sin(rad), z: -Math.cos(rad) };
        const c = { x: (door.a.x + door.b.x) / 2, z: (door.a.z + door.b.z) / 2 };
        const turn = Math.atan2(-d.z, d.x);
        const canopyY = DOOR_HEIGHT_M + 0.45;
        // The doorway itself, sitting in the wall opening (or slightly proud on solid exterior).
        const doorway = new THREE.Mesh(new THREE.PlaneGeometry(len, DOOR_HEIGHT_M), doorMat);
        const offsetOut = studio ? 0.01 : 0.04;
        doorway.position.set(c.x + n.x * offsetOut, DOOR_HEIGHT_M / 2, c.z + n.z * offsetOut);
        doorway.lookAt(doorway.position.x + n.x, doorway.position.y, doorway.position.z + n.z);
        if (studio) {
            doorway.userData.studioDoorIndex = i;
        }
        into.add(doorway);
        if (studio && studio.selectedDoorIndex === i) {
            const selBox = new THREE.Mesh(
                new THREE.BoxGeometry(len + 0.16, DOOR_HEIGHT_M + 0.12, 0.22),
                new THREE.MeshBasicMaterial({ color: 0x38bdf8, wireframe: true }),
            );
            selBox.position.set(c.x + n.x * 0.1, DOOR_HEIGHT_M / 2, c.z + n.z * 0.1);
            selBox.rotation.y = turn;
            into.add(selBox);
        }
        if (entrance.door === 'roll_up') {
            const hood = new THREE.Mesh(new THREE.BoxGeometry(len + 0.12, 0.26, 0.24), new THREE.MeshStandardMaterial({ color: 0x4b5563, roughness: 0.6 }));
            hood.position.set(c.x + n.x * 0.12, DOOR_HEIGHT_M - 0.12, c.z + n.z * 0.12);
            hood.rotation.y = turn;
            into.add(hood);
        } else {
            // The meeting stile between the leaves, and pull handles / details per style.
            const stile = new THREE.Mesh(new THREE.BoxGeometry(0.07, DOOR_HEIGHT_M * 0.92, 0.05), steel);
            stile.position.set(c.x + n.x * 0.1, DOOR_HEIGHT_M * 0.48, c.z + n.z * 0.1);
            stile.rotation.y = turn;
            into.add(stile);
            if (entrance.door === 'sliding' || entrance.door === 'double_wood') {
                for (const side of [-1, 1]) {
                    const pull = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.7, 0.05), steel);
                    pull.position.set(c.x + n.x * 0.14 + d.x * 0.22 * side, 1.05, c.z + n.z * 0.14 + d.z * 0.22 * side);
                    into.add(pull);
                }
            }
            if (entrance.door === 'arched') {
                const archBar = new THREE.Mesh(new THREE.BoxGeometry(len + 0.1, 0.12, 0.14), concrete);
                archBar.position.set(c.x + n.x * 0.08, DOOR_HEIGHT_M + 0.06, c.z + n.z * 0.08);
                archBar.rotation.y = turn;
                into.add(archBar);
            }
        }
        if (entrance.steps) {
            // Two shallow steps up to the threshold, as most of the campus blocks have.
            for (let s = 0; s < 2; s += 1) {
                const step = new THREE.Mesh(new THREE.BoxGeometry(len + 1.0, 0.16, 0.5), concrete);
                step.position.set(c.x + n.x * (1.0 + s * 0.5), 0.08 + (1 - s) * 0.16, c.z + n.z * (1.0 + s * 0.5));
                step.rotation.y = turn;
                into.add(step);
            }
        }
        if (entrance.canopy) {
            const w = len + 1.4;
            if (entrance.canopyShape === 'curved') {
                // A shallow arch: four panels stepping down from the wall to the outer edge.
                const panels = 4;
                for (let s = 0; s < panels; s += 1) {
                    const t = (s + 0.5) / panels;
                    const panel = new THREE.Mesh(new THREE.BoxGeometry(w, 0.1, 1.7 / panels + 0.03), canopyMat);
                    panel.position.set(c.x + n.x * (0.15 + t * 1.4), canopyY + 0.22 * Math.sin(Math.PI * t) - 0.06, c.z + n.z * (0.15 + t * 1.4));
                    panel.rotation.y = turn;
                    panel.rotation.x = -Math.cos(Math.PI * t) * 0.22;
                    into.add(panel);
                }
            } else {
                const roof = new THREE.Mesh(new THREE.BoxGeometry(w, 0.14, 1.7), canopyMat);
                roof.position.set(c.x + n.x * 0.85, canopyY, c.z + n.z * 0.85);
                roof.rotation.y = turn;
                into.add(roof);
            }
            addBars(into, [-1, 1].map((side) => {
                const x = c.x + n.x * 1.55 + d.x * side * (w / 2 - 0.12);
                const z = c.z + n.z * 1.55 + d.z * side * (w / 2 - 0.12);
                return [new THREE.Vector3(x, 0, z), new THREE.Vector3(x, canopyY, z)];
            }), 0.1, canopyMat);
        }
        if (i > 0) return;
        const text = entrance.sign.trim();
        const sign = text ? signTexture(text, look.walls.accent || entrance.color) : null;
        if (sign) {
            const board = new THREE.Mesh(new THREE.PlaneGeometry(sign.widthM, 0.7), new THREE.MeshBasicMaterial({ map: sign.tex }));
            const out = entrance.canopy ? 1.72 : 0.06;
            board.position.set(c.x + n.x * out, entrance.canopy ? canopyY + 0.45 : DOOR_HEIGHT_M + 0.75, c.z + n.z * out);
            board.lookAt(board.position.x + n.x, board.position.y, board.position.z + n.z);
            into.add(board);
        }
        if (entrance.ramp) {
            // A landing at the door and a ramp along the wall up to it, with a handrail on the open side.
            const landing = new THREE.Mesh(new THREE.BoxGeometry(len + 0.6, 0.3, 1.5), concrete);
            landing.position.set(c.x + n.x * 0.75, 0.15, c.z + n.z * 0.75);
            landing.rotation.y = turn;
            into.add(landing);
            const from = new THREE.Vector3(c.x + d.x * (len / 2 + 4.3) + n.x * 0.75, 0.02, c.z + d.z * (len / 2 + 4.3) + n.z * 0.75);
            const to = new THREE.Vector3(c.x + d.x * (len / 2 + 0.3) + n.x * 0.75, 0.3, c.z + d.z * (len / 2 + 0.3) + n.z * 0.75);
            const slope = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.08, from.distanceTo(to)), concrete);
            slope.position.copy(from).add(to).multiplyScalar(0.5);
            slope.lookAt(to);
            into.add(slope);
            const rail = (v) => new THREE.Vector3(v.x + n.x * 0.6, v.y + 0.9, v.z + n.z * 0.6);
            const foot = (v) => new THREE.Vector3(v.x + n.x * 0.6, v.y, v.z + n.z * 0.6);
            addBars(into, [[rail(from), rail(to)], [foot(from), rail(from)], [foot(to), rail(to)]], 0.05, steel);
        }
    });

    // ── Decorations (Building Studio) ────────────────────────────────
    // Dressed along the wall of the main door, so they read from the front the map looks at.
    const decor = look.decor;
    const front = doors[0];
    if (front && (decor.planters || decor.ac || decor.bunting)) {
        const len = Math.hypot(front.b.x - front.a.x, front.b.z - front.a.z) || 1;
        const d = { x: (front.b.x - front.a.x) / len, z: (front.b.z - front.a.z) / len };
        const rad = (front.normalDeg * Math.PI) / 180;
        const n = { x: Math.sin(rad), z: -Math.cos(rad) };
        const c = { x: (front.a.x + front.b.x) / 2, z: (front.a.z + front.b.z) / 2 };
        const turn = Math.atan2(-d.z, d.x);
        // A point `along` metres sideways and `out` metres in front of the wall's middle.
        const at = (along, out) => ({ x: c.x + d.x * along + n.x * out, z: c.z + d.z * along + n.z * out });
        if (decor.planters) {
            const pot = new THREE.MeshStandardMaterial({ color: 0xc9c4b8, roughness: 0.9 });
            const leaf = new THREE.MeshStandardMaterial({ color: 0x4f7a3a, roughness: 0.95 });
            for (const side of [-1, 1]) {
                const p = at(side * (len / 2 + 1.1), 0.85);
                const box = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.45, 0.6), pot);
                box.position.set(p.x, 0.22, p.z);
                box.rotation.y = turn;
                into.add(box);
                const bush = new THREE.Mesh(new THREE.SphereGeometry(0.55, 8, 6), leaf);
                bush.scale.set(1.4, 0.8, 0.9);
                bush.position.set(p.x, 0.75, p.z);
                into.add(bush);
            }
        }
        if (decor.ac) {
            const unit = new THREE.MeshStandardMaterial({ color: 0xdadde0, roughness: 0.6, metalness: 0.3 });
            const vents = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.7 });
            for (const side of [-1, 1]) {
                const p = at(side * (len / 2 + 2.1), 0.3);
                const box = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.6, 0.42), unit);
                box.position.set(p.x, 2.55, p.z);
                box.rotation.y = turn;
                into.add(box);
                const grille = new THREE.Mesh(new THREE.BoxGeometry(0.74, 0.34, 0.03), vents);
                grille.position.set(p.x + n.x * 0.22, 2.55, p.z + n.z * 0.22);
                grille.rotation.y = turn + Math.PI / 2;
                into.add(grille);
            }
        }
        if (decor.bunting) {
            // Flags strung across the front, as the campus is dressed for college week.
            const drop = DOOR_HEIGHT_M + 1.6;
            const span = len + 2.6;
            const cord = new THREE.Mesh(new THREE.BoxGeometry(span, 0.03, 0.03), steel);
            cord.position.set(c.x + n.x * 0.55, drop, c.z + n.z * 0.55);
            cord.rotation.y = turn;
            into.add(cord);
            const colors = [0xb3262e, 0x2f6fb3, 0xf2c94c, 0x2f9e5f];
            const flags = Math.max(4, Math.round(span / 1.1));
            for (let i = 0; i < flags; i += 1) {
                const p = at((i + 0.5) / flags * span - span / 2, 0.57);
                const flag = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.38), new THREE.MeshStandardMaterial({
                    color: colors[i % colors.length], side: THREE.DoubleSide, roughness: 0.9,
                }));
                flag.position.set(p.x, drop - 0.22, p.z);
                flag.rotation.y = Math.atan2(n.x, n.z);
                into.add(flag);
            }
        }
    }
    if (decor.tank && ring.length) {
        // A steel water tank on the roof, on a low frame: on nearly every block in the photos.
        const cx = ring.reduce((s, p) => s + p.x, 0) / ring.length;
        const cz = ring.reduce((s, p) => s + p.z, 0) / ring.length;
        const stand = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.24, 1.8), steel);
        stand.position.set(cx, height + rise + 0.12, cz);
        into.add(stand);
        const tank = new THREE.Mesh(new THREE.CylinderGeometry(0.92, 0.92, 1.7, 14), new THREE.MeshStandardMaterial({
            color: 0x9aa3a8, roughness: 0.5, metalness: 0.4,
        }));
        tank.position.set(cx, height + rise + 1.1, cz);
        into.add(tank);
    }
    drawStudioItems(into, {
        ring,
        height,
        floors,
        look,
        selectedIndex: studio ? studio.selectedItemIndex : null,
        pickable: Boolean(studio),
    });
    return height + rise;
}

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
 * School uniforms for a student's own figure (users.gender): a white short-sleeved polo with dark
 * slacks, or a white blouse with long red pants. Anyone else (visitors, guests, no gender set) keeps the
 * plain white figure.
 */
const UNIFORMS = {
    male: { skin: 0xd2a27c, top: 0xf8fafc, legs: 0x1f2a44, hair: 0x2a1d16, longHair: false },
    female: { skin: 0xd2a27c, top: 0xf8fafc, legs: 0xa3192b, hair: 0x2a1d16, longHair: true },
};

/**
 * A person at real size (about 1.7 m), standing on the ground at `foot` and
 * facing `heading` (a direction on the ground): legs, body, arms and head.
 * Real proportions: legs ~0.85 m, body ~0.6 m, head ~0.23 m. `look`: 'male' or
 * 'female' dresses it in the school uniform (UNIFORMS); otherwise it is plain white.
 * The figure faces its local +z.
 */
export function person(foot, heading, look = null) {
    const uniform = UNIFORMS[look] || null;
    const mat = (color, roughness = 0.65) => new THREE.MeshStandardMaterial({ color, roughness });
    const skin = mat(uniform ? uniform.skin : 0xffffff, 0.6);
    const top = uniform ? mat(uniform.top) : skin;
    const legMat = uniform ? mat(uniform.legs, 0.8) : mat(0xd4d4d8, 0.7);
    const body = new THREE.Group();
    // Everything above the feet sits in `torso`, so a walk can bob it; legs and
    // arms hang from pivots at the hips and shoulders, so they can swing.
    const torso = new THREE.Group();
    body.add(torso);
    const part = (parent, geo, material, x, y, z) => { const m = new THREE.Mesh(geo, material); m.position.set(x, y, z); parent.add(m); return m; };
    const pivot = (x, y) => { const g = new THREE.Group(); g.position.set(x, y, 0); torso.add(g); return g; };
    // Legs (hip at 0.88 m); in uniform, dark shoes pointing forward.
    const legL = pivot(-0.1, 0.88);
    const legR = pivot(0.1, 0.88);
    for (const leg of [legL, legR]) {
        part(leg, new THREE.CapsuleGeometry(0.075, 0.72, 4, 10), legMat, 0, -0.44, 0);
        if (uniform) part(leg, new THREE.BoxGeometry(0.1, 0.06, 0.2), mat(0x18181b, 0.5), 0, -0.85, 0.035);
    }
    // Body (shoulders at ~1.45 m).
    part(torso, new THREE.CapsuleGeometry(0.17, 0.42, 4, 12), top, 0, 1.15, 0).scale.set(1, 1, 0.62);
    if (uniform) {
        // The pants up to the waist (over the bottom of the shirt) and a belt where it is tucked in.
        part(torso, new THREE.CylinderGeometry(0.174, 0.165, 0.2, 18), legMat, 0, 0.8, 0).scale.set(1, 1, 0.64);
        part(torso, new THREE.CylinderGeometry(0.178, 0.178, 0.05, 18), mat(0x18181b, 0.5), 0, 0.91, 0).scale.set(1, 1, 0.66);
    }
    // Arms, hanging slightly out from the shoulders (~1.38 m); in uniform, short white sleeves.
    const armL = pivot(-0.24, 1.38);
    const armR = pivot(0.24, 1.38);
    for (const [arm, side] of [[armL, -1], [armR, 1]]) {
        part(arm, new THREE.CapsuleGeometry(0.055, 0.56, 4, 10), skin, side * 0.01, -0.28, 0).rotation.z = side * 0.12;
        if (uniform) part(arm, new THREE.CapsuleGeometry(0.07, 0.14, 4, 10), top, side * 0.002, -0.06, 0).rotation.z = side * 0.12;
    }
    // Neck and head (top of head at ~1.72 m).
    part(torso, new THREE.CylinderGeometry(0.045, 0.05, 0.08, 10), skin, 0, 1.49, 0);
    part(torso, new THREE.SphereGeometry(0.115, 18, 14), skin, 0, 1.6, 0);
    if (uniform) {
        // Hair: a cap over the top and back of the head; long hair falls down the back.
        const hair = mat(uniform.hair, 0.9);
        part(torso, new THREE.SphereGeometry(0.123, 18, 10, 0, Math.PI * 2, 0, Math.PI * 0.52), hair, 0, 1.605, -0.012);
        if (uniform.longHair) part(torso, new THREE.CapsuleGeometry(0.095, 0.2, 4, 10), hair, 0, 1.47, -0.07).scale.set(1.1, 1, 0.55);
    }
    body.userData.rig = { torso, legL, legR, armL, armR };
    body.userData.look = uniform ? look : null;
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
 * look: the signed-in student's gender, for the uniform on the figure at the start (person).
 */
export function buildScene(group, { route, buildings, links, pathways = [], bridges = [], objects = [], nodes = [], follow = false, origin = null, look = null, studio = null }) {
    group.userData.cranes = [];
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

    // Every other building on campus, for a sense of where you are: solid at its real height as its
    // department dressed it (Building Studio), with a small name (planned ones are not built yet, so not drawn).
    for (const b of buildings || []) {
        if (inside.has(b.id) || b.status === 'planned' || !Array.isArray(b.polygon) || b.polygon.length < 3) continue;
        const ring = b.polygon.map((p) => xz(p.lat, p.lng));
        const height = buildingHeightM(b);
        if (b.status === 'under_construction') {
            // Being built: a frame with hollow-block walls going up, scaffolding and a tower crane.
            drawConstructionSite(group, ring, height, b.floors, b.id);
        }
        // Its outside as its department dressed it (Building Studio), or the plain look with windows.
        const roofTop = b.status === 'under_construction' ? height : drawBuildingExterior(group, {
            ring, height, floors: b.floors, look: appearanceOf(b),
            doors: doorFrames(b.polygon, b.doors).map((d) => ({ a: xz(d.a.lat, d.a.lng), b: xz(d.b.lat, d.b.lng), normalDeg: d.normalDeg, edge: d.edge })),
            studio: studio && b.id === studio.buildingId ? studio : null,
        });
        const cx = ring.reduce((sum, p) => sum + p.x, 0) / ring.length;
        const cz = ring.reduce((sum, p) => sum + p.z, 0) / ring.length;
        const tag = screenLabel(b.short_name || b.name, { bg: '#26262c', fg: '#e5e5ea', icon: 'building', border: 'rgba(255, 255, 255, 0.18)' }, 0.034);
        tag.position.set(cx, roofTop + 1.5, cz);
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
        const bananaStemMat = new THREE.MeshStandardMaterial({ color: 0xa9b356, roughness: 0.9 });
        const bananaLeafMat = new THREE.MeshStandardMaterial({ color: 0x7cb342, roughness: 0.8, side: THREE.DoubleSide });
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
                const topU = trunkTopM(m);
                if (m.stems.length) {
                    // A banana plant: its clumped yellow-green stems.
                    for (const s of m.stems) {
                        // From its foot to its top, which the outer stems lean out to.
                        const foot = new THREE.Vector3(base.x + s.e, 0, base.z - s.n);
                        const d = new THREE.Vector3(base.x + s.te, s.h, base.z - s.tn).sub(foot);
                        const stem = new THREE.Mesh(new THREE.CylinderGeometry(s.r * 0.75, s.r, d.length(), 8), bananaStemMat);
                        stem.position.copy(foot).addScaledVector(d, 0.5);
                        stem.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
                        group.add(stem);
                    }
                } else {
                    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(m.trunkR * 0.7, m.trunkR, topU, 8), trunkMat);
                    trunk.position.set(base.x + m.lean.e / 2, topU / 2, base.z - m.lean.n / 2);
                    trunk.rotation.z = -Math.atan2(m.lean.e, topU);
                    trunk.rotation.x = Math.atan2(-m.lean.n, topU) * -1;
                    group.add(trunk);
                }
                if (m.fronds.length) {
                    for (const f of m.fronds) {
                        const a = (f.dir * Math.PI) / 180;
                        // A palm frond is a flattened cone; a banana leaf a flat paddle.
                        const frond = f.wide
                            ? new THREE.Mesh(new THREE.SphereGeometry(1, 12, 6), bananaLeafMat)
                            : new THREE.Mesh(new THREE.ConeGeometry(0.4, f.len, 4), leaf);
                        const oe = f.e ?? m.lean.e;
                        const on = f.n ?? m.lean.n;
                        const oh = f.h ?? m.trunkH;
                        // Lay each frond out from the top, drooping (or rising) towards its tip.
                        frond.position.set(base.x + oe + Math.sin(a) * f.len * 0.45, oh - f.droop * f.len * 0.4, base.z - on - Math.cos(a) * f.len * 0.45);
                        frond.rotation.order = 'YXZ';
                        frond.rotation.y = -a;
                        frond.rotation.x = Math.PI / 2 + f.droop * 0.8;
                        if (f.wide) { frond.scale.set(f.wide / 2, f.len / 2, 0.04); frond.rotation.z = f.tilt || 0; }
                        else frond.scale.set(1, 1, 0.25);
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
            } else if (o.kind === 'parking') {
                // Asphalt a little above the ground, with the stall lines painted on it.
                const lot = parkingLayout(o);
                const shape = new THREE.Shape(lot.outline.map((p) => { const q = xz(p.lat, p.lng); return new THREE.Vector2(q.x, -q.z); }));
                const pad = new THREE.Mesh(new THREE.ShapeGeometry(shape), new THREE.MeshStandardMaterial({ color: 0x3f4047, roughness: 1 }));
                pad.rotation.x = -Math.PI / 2;
                pad.position.y = 0.015;
                group.add(pad);
                const pts = [];
                for (const [a, b] of lot.lines) {
                    const p = xz(a.lat, a.lng);
                    const q = xz(b.lat, b.lng);
                    pts.push(new THREE.Vector3(p.x, 0.03, p.z), new THREE.Vector3(q.x, 0.03, q.z));
                }
                group.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0xf4f4f5 })));
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
    // The route's points (up and down its staircases) and its stops, for a path. The first time, its
    // staircases are drawn too (amber); later redraws of the line alone (redrawRoute) leave them.
    const routePoints = (routePath, withStairs) => {
        const pts = [];
        const push = (v) => { const last = pts[pts.length - 1]; if (!last || last.distanceTo(v) > 0.05) pts.push(v); };
        // Follow view: the user's start point is not part of the fixed ribbon. The
        // view draws its own live piece from where you are now to the next stop, so
        // the route never stays behind at the spot where it was first worked out.
        const stops = new Map();
        routePath.forEach((p, i) => {
            if (follow && p.type === 'user') return;
            const here = xz(p.latitude, p.longitude);
            if (p.id != null) stops.set(String(p.id), { x: here.x, y: yOf(p) + 0.25, z: here.z, floor: Math.max(0, floorOf(p)) });
            const prev = routePath[i - 1];
            if (prev && prev.type !== 'user' && p.type !== 'user' && floorOf(prev) !== floorOf(p)) {
                const link = linkFor(prev, p) || {};
                if (link.id != null) drawnLinks.add(link.id);
                const { plan, bottom, top } = planFromLink(link, prev, p);
                const y0 = yOf(bottom);
                const y1 = yOf(top);
                const base = xz(bottom.latitude, bottom.longitude);
                const climb = walkLine(plan).map((q) => new THREE.Vector3(base.x + q.e, y0 + (plan.rise > 0 ? q.u / plan.rise : 0) * (y1 - y0) + 0.25, base.z - q.n));
                (bottom === prev ? climb : climb.reverse()).forEach(push);
                if (withStairs) {
                    drawSteps(plan, bottom, top);
                    const deck = deckOf(prev) || deckOf(p);
                    if (deck) dressBridgeStairs(plan, bottom, top, deck);
                }
            }
            push(new THREE.Vector3(here.x, yOf(p) + 0.25, here.z));
        });
        return { pts, stops };
    };
    const { pts, stops } = routePoints(path, true);
    // Building Studio interior: always render floors, door thresholds, staircases, corridors, and rooms
    // inside the studio building so flying inside or looking through glass doors/X-ray shows the real interior.
    if (studio?.buildingId != null && byId.has(studio.buildingId)) {
        const sb = byId.get(studio.buildingId);
        const sRing = (sb.polygon || []).map((p) => xz(p.lat, p.lng));
        if (sRing.length >= 3) {
            const levels = Math.max(1, Number(sb.floors) || Math.round(buildingHeightM(sb) / 3.2) || 1);
            const h = storey(sb);
            const shape = new THREE.Shape(sRing.map((p) => new THREE.Vector2(p.x, -p.z)));
            const SLAB = 0.24;
            for (let f = 0; f < levels; f += 1) {
                const label = screenLabel(floorAria(f), f === 0 ? { bg: '#166534', fg: '#dcfce7' } : {}, 0.038);
                label.position.set(sRing[0].x, f * h + 0.85, sRing[0].z);
                group.add(label);
                if (f === 0) {
                    const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.05, bevelEnabled: false });
                    geo.rotateX(-Math.PI / 2);
                    const base = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x2f6b46, transparent: true, opacity: 0.55, depthWrite: false }));
                    base.position.y = 0.02;
                    group.add(base);
                    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 25), new THREE.LineBasicMaterial({ color: 0x9fd9b4 }));
                    edges.position.y = 0.02;
                    group.add(edges);
                    continue;
                }
                const geo = new THREE.ExtrudeGeometry(shape, { depth: SLAB, bevelEnabled: false });
                geo.rotateX(-Math.PI / 2);
                const top = new THREE.MeshStandardMaterial({ color: 0xe5e7eb, roughness: 0.8, transparent: true, opacity: 0.56 });
                const side = new THREE.MeshStandardMaterial({ color: 0x6b7280, roughness: 0.9, transparent: true, opacity: 0.85 });
                const slab = new THREE.Mesh(geo, [top, side]);
                slab.position.y = f * h - SLAB;
                slab.renderOrder = 2;
                group.add(slab);
                const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 25), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8 }));
                edges.position.y = slab.position.y;
                edges.renderOrder = 3;
                group.add(edges);
            }
            // Door threshold highlights on ground floor.
            const doorH = Math.min(DOOR_HEIGHT_M, h * 0.85);
            for (const d of doorFrames(sb.polygon, sb.doors)) {
                const a = xz(d.a.lat, d.a.lng);
                const c = xz(d.b.lat, d.b.lng);
                const dg = new THREE.BufferGeometry();
                dg.setAttribute('position', new THREE.Float32BufferAttribute([
                    a.x, 0.02, a.z, c.x, 0.02, c.z, c.x, doorH, c.z, a.x, 0.02, a.z, c.x, doorH, c.z, a.x, doorH, a.z,
                ], 3));
                group.add(new THREE.Mesh(dg, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.08, side: THREE.DoubleSide, depthWrite: false })));
            }
            // Indoor staircases & corridor links + rooms/nodes.
            const sNodeById = new Map((nodes || []).map((n) => [n.id, n]));
            const corridorMat = new THREE.LineBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.8 });
            for (const l of links || []) {
                const a = sNodeById.get(l.node_a_id);
                const b = sNodeById.get(l.node_b_id);
                if (!a || !b || a.building_id !== sb.id || b.building_id !== sb.id) continue;
                if (l.kind === 'stairs' || floorOf(a) !== floorOf(b)) {
                    const { plan, bottom, top } = planFromLink(l, a, b);
                    drawSteps(plan, bottom, top);
                } else {
                    const pa = xz(a.latitude, a.longitude);
                    const pb = xz(b.latitude, b.longitude);
                    group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([
                        new THREE.Vector3(pa.x, yOf(a) + 0.08, pa.z),
                        new THREE.Vector3(pb.x, yOf(b) + 0.08, pb.z),
                    ]), corridorMat));
                }
            }
            const roomDiscMat = new THREE.MeshStandardMaterial({ color: 0x22c55e, roughness: 0.5 });
            const routeDiscMat = new THREE.MeshStandardMaterial({ color: 0x38bdf8, roughness: 0.5 });
            for (const n of nodes || []) {
                if (n.building_id !== sb.id) continue;
                const p = xz(n.latitude, n.longitude);
                const py = yOf(n);
                const isRoom = n.type === 'location';
                const disc = new THREE.Mesh(new THREE.CylinderGeometry(isRoom ? 0.34 : 0.2, isRoom ? 0.34 : 0.2, 0.08, 14), isRoom ? roomDiscMat : routeDiscMat);
                disc.position.set(p.x, py + 0.06, p.z);
                group.add(disc);
                if (isRoom && n.name) {
                    const tag = screenLabel(n.name, { bg: '#16161b', fg: '#ffffff', icon: 'pin', border: 'rgba(74, 222, 128, 0.7)' }, 0.036);
                    tag.position.set(p.x, py + 1.05, p.z);
                    group.add(tag);
                }
            }
        }
    }
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
    // The route line (blue tube, chevrons, the destination pin) in its own group, so the follow view can
    // redraw it alone as you walk instead of rebuilding the whole campus.
    const routeGroup = new THREE.Group();
    group.add(routeGroup);
    const drawRibbon = (into, pts, routePath) => {
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
            into.add(new THREE.Mesh(new THREE.TubeGeometry(curve, segs, 0.3, 10, false), new THREE.MeshBasicMaterial({ color: ROUTE_EDGE, side: THREE.BackSide })));
            into.add(new THREE.Mesh(new THREE.TubeGeometry(curve, segs, 0.22, 10, false), new THREE.MeshBasicMaterial({ color: ROUTE })));
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
                into.add(chev);
            }
            // Start and destination.
            // You: a person at the start, facing the way the route goes (the
            // follow view moves its own person with you instead).
            if (!follow) {
                const foot = new THREE.Vector3(pts[0].x, pts[0].y - 0.25, pts[0].z);
                const ahead = new THREE.Vector3().subVectors(pts[1], pts[0]).setY(0);
                into.add(person(foot, ahead, look));
            }
        }
        // The destination pin (also for a one-stop route in the follow view, which
        // has no fixed ribbon: its whole route is the live piece from you).
        if (pts.length >= 1) {
            const end = pts[pts.length - 1];
            const pin = new THREE.Mesh(new THREE.ConeGeometry(0.55, 1.4, 20), new THREE.MeshBasicMaterial({ color: GO }));
            pin.rotation.x = Math.PI;
            pin.position.set(end.x, end.y + 1.1, end.z);
            into.add(pin);
            const head = new THREE.Mesh(new THREE.SphereGeometry(0.55, 20, 14), new THREE.MeshBasicMaterial({ color: GO }));
            head.position.set(end.x, end.y + 1.9, end.z);
            into.add(head);
            const dest = routePath[routePath.length - 1];
            if (dest?.name) {
                const label = screenLabel(dest.name, { bg: '#22c55e', fg: '#05230f', icon: 'pin', border: '#ffffff' }, 0.05);
                label.position.set(end.x, end.y + 3.1, end.z);
                into.add(label);
            }
        }
    };
    drawRibbon(routeGroup, pts, path);

    // Scene position back to latitude / longitude (the follow view's test walk).
    const toLatLng = (x, z) => fromLocalMeters(originLL.lat, originLL.lng, x, -z);
    // A new route on the same campus (the follow view as you walk): only the line is redrawn.
    const redrawRoute = (routePath) => {
        disposeTree(routeGroup);
        routeGroup.clear();
        const next = routePoints(routePath || [], false);
        drawRibbon(routeGroup, next.pts, routePath || []);
        return next;
    };
    return { target: new THREE.Vector3(0, 3, 0), radius, xz, toLatLng, routePts: pts, stops, redrawRoute };
}

export default function RouteModel3D({ route, buildings, links, bridges = [], objects = [], nodes = [], height = 420, look = null }) {
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
        const built = buildScene(group, { route, buildings, links, bridges, objects, nodes, look });
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
        const reduceMotion = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        const loop = (now = 0) => {
            s.raf = requestAnimationFrame(loop);
            const dt = s.last ? Math.min(0.05, (now - s.last) / 1000) : 0;
            s.last = now;
            roam(dt);
            if (!reduceMotion && animateCranes(s.group, now / 1000)) {
                s.dirty = true;
            }
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
