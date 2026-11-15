import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { C, RADIUS } from '../uiTokens';
import { toLocalMeters, fromLocalMeters } from '../geo';
import { doorFrames, placedDoors, DOOR_HEIGHT_M } from '../doors';
import { makeLabel, disposeTree } from './StairPreview3D';

// ── 3D building preview (Edit building → Doors) ─────────────────────
// The building as a small orbitable model: its walls at their real height,
// one line per floor, a see-through roof, and its doors as green openings.
// Drag to rotate, wheel or pinch to zoom. While `placing`, a tap on a wall
// (not a drag) calls onWallPick({ lat, lng }) with the spot tapped, so a door
// can be put on the wall it belongs to from any angle. Hovering a wall shows
// a see-through preview of the door first (ghost), snapped as it will be.
// Scene axes: x = east, y = up, z = -north (as the staircase preview).

const WALL = 0xd8d3c8;
const WALL_EDGE = 0x55555f;
// The door under the pointer before it is placed: green where it fits,
// amber where it would overlap a door that is already there.
const GHOST_OK = 0x4ade80;
const GHOST_BLOCKED = 0xffb02e;

const reduceMotion = () => typeof window !== 'undefined'
    && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Fill `group` with the building. Returns the orbit target and radius. */
function buildScene(group, { polygon, doors, floors, heightM, highlight }) {
    const ring = (polygon || []).filter((p) => Number.isFinite(+p.lat) && Number.isFinite(+p.lng));
    if (ring.length < 3) return { target: new THREE.Vector3(), radius: 10, ref: null };
    const ref = { lat: ring.reduce((s, p) => s + +p.lat, 0) / ring.length, lng: ring.reduce((s, p) => s + +p.lng, 0) / ring.length };
    const local = (p) => { const [e, n] = toLocalMeters(+p.lat, +p.lng, ref.lat, ref.lng); return { e, n }; };
    const pts = ring.map(local);
    const levels = Math.max(1, Number(floors) || 1);
    const H = Math.max(2, Number(heightM) || levels * 3.2);
    let radius = 4;
    for (const p of pts) radius = Math.max(radius, Math.hypot(p.e, p.n));

    // Ground.
    const ground = new THREE.Mesh(
        new THREE.CircleGeometry(radius * 1.6, 48),
        new THREE.MeshStandardMaterial({ color: 0x23232a, roughness: 1 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.01;
    group.add(ground);

    // Doors first (the walls are cut around them): each one's edge and its
    // span along that edge (0..1).
    const doorH = Math.min(DOOR_HEIGHT_M, H * 0.85);
    const frames = doorFrames(ring, doors);
    const spans = new Map();
    frames.forEach((d, k) => {
        const a = pts[d.edge];
        const b = pts[(d.edge + 1) % pts.length];
        const len2 = (b.e - a.e) ** 2 + (b.n - a.n) ** 2 || 1;
        const t = (p) => { const q = local(p); return ((q.e - a.e) * (b.e - a.e) + (q.n - a.n) * (b.n - a.n)) / len2; };
        const [t0, t1] = [t(d.a), t(d.b)].sort((x, y) => x - y);
        if (!spans.has(d.edge)) spans.set(d.edge, []);
        spans.get(d.edge).push({ t0: Math.max(0, t0), t1: Math.min(1, t1), k });
    });

    // Walls, one set of meshes per outline edge (userData.wall marks them for
    // taps), with a real hole at every door: full height between doors, and
    // only the piece above the door (the lintel) over each opening.
    const wallMat = new THREE.MeshStandardMaterial({ color: WALL, roughness: 0.9, side: THREE.DoubleSide });
    const edgeMat = new THREE.LineBasicMaterial({ color: WALL_EDGE });
    const quad = (a, b, y0, y1, i) => {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute([
            a.e, y0, -a.n, b.e, y0, -b.n, b.e, y1, -b.n,
            a.e, y0, -a.n, b.e, y1, -b.n, a.e, y1, -a.n,
        ], 3));
        geo.computeVertexNormals();
        const wall = new THREE.Mesh(geo, wallMat);
        wall.userData.wall = i;
        group.add(wall);
    };
    for (let i = 0; i < pts.length; i += 1) {
        const a = pts[i];
        const b = pts[(i + 1) % pts.length];
        const at = (t) => ({ e: a.e + (b.e - a.e) * t, n: a.n + (b.n - a.n) * t });
        let from = 0;
        for (const span of (spans.get(i) || []).sort((x, y) => x.t0 - y.t0)) {
            if (span.t0 > from + 1e-4) quad(at(from), at(span.t0), 0, H, i);
            quad(at(span.t0), at(span.t1), doorH, H, i); // above the opening
            from = Math.max(from, span.t1);
        }
        if (from < 1 - 1e-4) quad(at(from), b, 0, H, i);
        // Corner post + one line per floor slab.
        group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(a.e, 0, -a.n), new THREE.Vector3(a.e, H, -a.n)]), edgeMat));
        for (let k = 0; k <= levels; k += 1) {
            const y = (k / levels) * H;
            group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(a.e, y, -a.n), new THREE.Vector3(b.e, y, -b.n)]), edgeMat));
        }
    }

    // See-through roof, so doors on the far side still show from above.
    const shape = new THREE.Shape(pts.map((p) => new THREE.Vector2(p.e, p.n)));
    const roof = new THREE.Mesh(
        new THREE.ShapeGeometry(shape),
        new THREE.MeshStandardMaterial({ color: 0xbfbab0, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false }),
    );
    roof.rotation.x = -Math.PI / 2;
    roof.position.y = H;
    group.add(roof);

    // Each door: the hole in the wall, a faint light-grey pane in it (you see
    // through it into the building), and a black frame (green when selected).
    const bar = (p, q, material) => {
        const dir = new THREE.Vector3().subVectors(q, p);
        const len = Math.max(dir.length(), 0.001);
        const mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, len, 8), material);
        mesh.position.copy(p).addScaledVector(dir, 0.5);
        mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
        return mesh;
    };
    frames.forEach((d, k) => {
        const a = local(d.a);
        const b = local(d.b);
        const lit = highlight === k;
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute([
            a.e, 0, -a.n, b.e, 0, -b.n, b.e, doorH, -b.n,
            a.e, 0, -a.n, b.e, doorH, -b.n, a.e, doorH, -a.n,
        ], 3));
        geo.computeVertexNormals();
        const pane = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
            color: lit ? 0x22c55e : 0xe5e7eb, transparent: true, opacity: lit ? 0.3 : 0.18, side: THREE.DoubleSide, depthWrite: false,
        }));
        pane.userData.door = k; // a tap on it picks this door (to move it)
        group.add(pane);
        const frameMat = new THREE.MeshBasicMaterial({ color: lit ? 0x22c55e : 0x0a0a0c });
        const A0 = new THREE.Vector3(a.e, 0, -a.n);
        const B0 = new THREE.Vector3(b.e, 0, -b.n);
        const A1 = new THREE.Vector3(a.e, doorH, -a.n);
        const B1 = new THREE.Vector3(b.e, doorH, -b.n);
        group.add(bar(A0, A1, frameMat), bar(A1, B1, frameMat), bar(B1, B0, frameMat), bar(A0, B0, frameMat));
        const nx = Math.sin((d.normalDeg * Math.PI) / 180);
        const nz = -Math.cos((d.normalDeg * Math.PI) / 180);
        const label = makeLabel(`Door ${k + 1}`, { bg: lit ? '#22c55e' : '#ffffff', scale: 2.2 });
        const c = local(d.center);
        label.position.set(c.e + nx * 0.8, doorH + 0.8, -c.n + nz * 0.8);
        group.add(label);
    });

    const north = makeLabel('N', { scale: 1.4 });
    north.position.set(0, 0.3, -(radius * 1.35));
    group.add(north);

    return { target: new THREE.Vector3(0, H * 0.4, 0), radius: Math.max(radius, H), ref, doorH };
}

/** A see-through door at `frame` (from doorFrames), in scene coordinates around `ref`. */
function ghostDoor(frame, ref, doorH, blocked) {
    const local = (p) => { const [e, n] = toLocalMeters(+p.lat, +p.lng, ref.lat, ref.lng); return { e, n }; };
    const a = local(frame.a);
    const b = local(frame.b);
    const nx = Math.sin((frame.normalDeg * Math.PI) / 180) * 0.06;
    const nz = -Math.cos((frame.normalDeg * Math.PI) / 180) * 0.06;
    const color = blocked ? GHOST_BLOCKED : GHOST_OK;
    const group = new THREE.Group();
    const pane = new THREE.BufferGeometry();
    pane.setAttribute('position', new THREE.Float32BufferAttribute([
        a.e + nx, 0, -a.n + nz, b.e + nx, 0, -b.n + nz, b.e + nx, doorH, -b.n + nz,
        a.e + nx, 0, -a.n + nz, b.e + nx, doorH, -b.n + nz, a.e + nx, doorH, -a.n + nz,
    ], 3));
    group.add(new THREE.Mesh(pane, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.38, side: THREE.DoubleSide, depthWrite: false })));
    const frameGeo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(a.e + nx, 0, -a.n + nz), new THREE.Vector3(a.e + nx, doorH, -a.n + nz),
        new THREE.Vector3(b.e + nx, doorH, -b.n + nz), new THREE.Vector3(b.e + nx, 0, -b.n + nz),
    ]);
    const outline = new THREE.Line(frameGeo, new THREE.LineDashedMaterial({ color, dashSize: 0.25, gapSize: 0.15, depthTest: false }));
    outline.computeLineDistances();
    outline.renderOrder = 5;
    group.add(outline);
    const label = makeLabel(blocked ? 'Door already here' : 'New door', { bg: blocked ? '#ffb02e' : '#4ade80', scale: blocked ? 3 : 2.2 });
    const c = local(frame.center);
    label.position.set(c.e + nx * 15, doorH + 0.8, -c.n + nz * 15);
    group.add(label);
    return group;
}

export default function BuildingPreview3D({
    polygon, doors, floors, heightM, placing = false, highlight = null, onWallPick, newDoorWidth = null, height = 240,
    // Moving a door: its index (the ghost then skips it when checking for
    // overlaps); onDoorPick(k): a door in the view was tapped.
    movingDoor = null, onDoorPick = null,
}) {
    const hostRef = useRef(null);
    const stateRef = useRef(null);
    const pickRef = useRef({ placing, onWallPick, newDoorWidth, movingDoor, onDoorPick });
    pickRef.current = { placing, onWallPick, newDoorWidth, movingDoor, onDoorPick };
    const key = JSON.stringify([polygon, doors, floors, heightM, highlight]);

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
        scene.add(new THREE.AmbientLight(0xffffff, 0.7));
        const sun = new THREE.DirectionalLight(0xffffff, 0.95);
        sun.position.set(-6, 12, 8);
        scene.add(sun);
        const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 2000);
        const group = new THREE.Group();
        scene.add(group);
        const raycaster = new THREE.Raycaster();

        const s = {
            renderer, scene, camera, group, raf: 0, dirty: true,
            az: 0.6, el: 0.55, dist: 40, target: new THREE.Vector3(), ref: null,
            userZoomed: false, pointers: new Map(), pinch: 0, down: null,
            // Hover preview: the ghost door and the spot it was built for.
            ghost: null, ghostKey: '', polygon: null, doors: null, doorH: DOOR_HEIGHT_M,
        };
        stateRef.current = s;

        const place = () => {
            const ce = Math.cos(s.el);
            camera.position.set(
                s.target.x + s.dist * Math.sin(s.az) * ce,
                s.target.y + s.dist * Math.sin(s.el),
                s.target.z + s.dist * Math.cos(s.az) * ce,
            );
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
        const loop = () => {
            s.raf = requestAnimationFrame(loop);
            if (!s.dirty) return;
            s.dirty = false;
            place();
            renderer.render(scene, camera);
        };
        loop();

        const el = renderer.domElement;
        // The wall spot under the pointer, as a ground point (lat, lng).
        const wallPointAt = (ev) => {
            if (!s.ref) return null;
            const r = el.getBoundingClientRect();
            raycaster.setFromCamera(new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1), camera);
            const hit = raycaster.intersectObjects(group.children.filter((o) => o.userData.wall !== undefined), false)[0];
            if (!hit) return null;
            const p = fromLocalMeters(s.ref.lat, s.ref.lng, hit.point.x, -hit.point.z);
            return { lat: p.latitude, lng: p.longitude };
        };
        const clearGhost = () => {
            if (!s.ghost) return;
            disposeTree(s.ghost);
            scene.remove(s.ghost);
            s.ghost = null; s.ghostKey = '';
            s.dirty = true;
        };
        s.clearGhost = clearGhost;
        // Hovering a wall while placing: show the door that a tap would add.
        const showGhost = (ev) => {
            const at = pickRef.current.placing ? wallPointAt(ev) : null;
            const width = pickRef.current.newDoorWidth;
            const frame = at && s.polygon ? doorFrames(s.polygon, [{ ...at, width_m: width }])[0] : null;
            if (!frame) { clearGhost(); return; }
            const skip = pickRef.current.movingDoor;
            const blocked = placedDoors(s.polygon, s.doors).some((d, i) => i !== skip
                && Math.hypot(...toLocalMeters(d.lat, d.lng, frame.center.lat, frame.center.lng)) < (d.width + frame.width) / 2);
            const key = `${frame.a.lat.toFixed(7)},${frame.a.lng.toFixed(7)},${frame.width},${blocked}`;
            if (key === s.ghostKey) return;
            clearGhost();
            s.ghost = ghostDoor(frame, s.ref, s.doorH, blocked);
            s.ghostKey = key;
            scene.add(s.ghost);
            s.dirty = true;
        };
        // A tap on a door picks it (to move it); a tap on a wall while placing
        // adds or moves the door there.
        const pickWall = (ev) => {
            const { placing: on, onWallPick: pick, onDoorPick: pickDoor } = pickRef.current;
            if (pickDoor) {
                const r = el.getBoundingClientRect();
                raycaster.setFromCamera(new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1), camera);
                const hit = raycaster.intersectObjects(group.children.filter((o) => o.userData.door !== undefined), false)[0];
                if (hit && !(on && pickRef.current.movingDoor !== null)) { pickDoor(hit.object.userData.door); return; }
            }
            if (!on || !pick) return;
            const at = wallPointAt(ev);
            if (at) pick(at);
        };
        const onDown = (ev) => {
            el.setPointerCapture?.(ev.pointerId);
            s.pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
            s.down = s.pointers.size === 1 ? { x: ev.clientX, y: ev.clientY } : null;
            el.style.cursor = 'grabbing';
            if (s.pointers.size === 2) {
                const [p, q] = [...s.pointers.values()];
                s.pinch = Math.hypot(p.x - q.x, p.y - q.y);
            }
        };
        const onMove = (ev) => {
            const prev = s.pointers.get(ev.pointerId);
            if (!prev) {
                el.style.cursor = pickRef.current.placing ? 'crosshair' : 'grab';
                if (ev.pointerType !== 'touch') showGhost(ev);
                return;
            }
            // Rotating: the preview would lag behind the walls; hide it.
            clearGhost();
            const cur = { x: ev.clientX, y: ev.clientY };
            if (s.pointers.size === 2) {
                s.pointers.set(ev.pointerId, cur);
                const [p, q] = [...s.pointers.values()];
                const d = Math.hypot(p.x - q.x, p.y - q.y);
                if (s.pinch > 0 && d > 0) { s.dist = Math.min(400, Math.max(6, s.dist * (s.pinch / d))); s.userZoomed = true; }
                s.pinch = d;
            } else {
                s.az -= (cur.x - prev.x) * 0.01;
                s.el = Math.min(1.45, Math.max(0.08, s.el + (cur.y - prev.y) * 0.008));
                s.pointers.set(ev.pointerId, cur);
            }
            s.dirty = true;
        };
        const onUp = (ev) => {
            const wasTap = s.down && s.pointers.size === 1 && Math.hypot(ev.clientX - s.down.x, ev.clientY - s.down.y) < 6;
            s.pointers.delete(ev.pointerId);
            s.pinch = 0;
            if (s.pointers.size === 0) el.style.cursor = pickRef.current.placing ? 'crosshair' : 'grab';
            if (wasTap) pickWall(ev);
            s.down = null;
        };
        const onLeave = () => clearGhost();
        const onWheel = (ev) => {
            ev.preventDefault();
            s.dist = Math.min(400, Math.max(6, s.dist * (1 + ev.deltaY * 0.001)));
            s.userZoomed = true; s.dirty = true;
        };
        el.addEventListener('pointerdown', onDown);
        el.addEventListener('pointermove', onMove);
        el.addEventListener('pointerup', onUp);
        el.addEventListener('pointercancel', onUp);
        el.addEventListener('wheel', onWheel, { passive: false });
        el.addEventListener('pointerleave', onLeave);

        return () => {
            cancelAnimationFrame(s.raf);
            ro?.disconnect();
            el.removeEventListener('pointerdown', onDown);
            el.removeEventListener('pointermove', onMove);
            el.removeEventListener('pointerup', onUp);
            el.removeEventListener('pointercancel', onUp);
            el.removeEventListener('wheel', onWheel);
            el.removeEventListener('pointerleave', onLeave);
            disposeTree(scene);
            renderer.dispose();
            renderer.forceContextLoss?.();
            if (el.parentNode === host) host.removeChild(el);
            stateRef.current = null;
        };
    }, []);

    useEffect(() => {
        const s = stateRef.current;
        if (!s) return;
        disposeTree(s.group);
        s.group.clear();
        const { target, radius, ref, doorH } = buildScene(s.group, { polygon, doors, floors, heightM, highlight });
        s.target.copy(target);
        s.ref = ref;
        s.polygon = polygon;
        s.doors = doors;
        s.doorH = doorH ?? DOOR_HEIGHT_M;
        // The building changed (e.g. a door was just added): drop the old preview.
        s.clearGhost?.();
        if (!s.userZoomed) s.dist = radius * 2.4 + 4;
        s.dirty = true;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key]);

    // Leaving "Add door" removes the hover preview.
    useEffect(() => {
        if (!placing) stateRef.current?.clearGhost?.();
    }, [placing]);

    // Gentle first look: one slow quarter turn, so it reads as 3D.
    useEffect(() => {
        const s = stateRef.current;
        if (!s || reduceMotion()) return undefined;
        let frames = 60;
        const id = setInterval(() => {
            if (!stateRef.current || frames-- <= 0 || s.pointers.size) { clearInterval(id); return; }
            s.az += 0.01; s.dirty = true;
        }, 16);
        return () => clearInterval(id);
    }, []);

    const reset = () => {
        const s = stateRef.current;
        if (!s) return;
        s.az = 0.6; s.el = 0.55; s.userZoomed = false;
        const { radius } = buildScene(new THREE.Group(), { polygon, doors, floors, heightM });
        s.dist = radius * 2.4 + 4;
        s.dirty = true;
    };

    return (
        <div className="bld3d" style={{ height }}>
            <div
                ref={hostRef} className="bld3d-host" role="img"
                aria-label={`3D view of the building with ${doorFrames(polygon, doors).length} doors. Drag to rotate.`}
            />
            <button type="button" className="bld3d-reset" onClick={reset}>Reset view</button>
            <span className="bld3d-hint" aria-hidden="true">
                {movingDoor !== null ? `Point at a wall, tap to move door ${movingDoor + 1} there`
                    : placing ? 'Point at a wall to preview a door, tap to add it' : 'Tap a door to move it, drag to rotate'}
            </span>
        </div>
    );
}

export const BUILDING_PREVIEW_CSS = `
    .bld3d { position: relative; border-radius: ${RADIUS + 4}px; overflow: hidden; background: ${C.bar}; border: 1px solid ${C.hairline}; }
    .bld3d-host { position: absolute; inset: 0; }
    .bld3d-host[data-nogl] { display: flex; align-items: center; justify-content: center; }
    .bld3d-host[data-nogl]::after { content: '3D preview needs WebGL'; color: ${C.muted}; font-size: 13px; }
    .bld3d-reset { position: absolute; top: 8px; right: 8px; min-height: 32px; padding: 4px 12px; border-radius: 10px;
        border: 1px solid ${C.hairline}; background: ${C.glass}; color: #fff; font-size: 12px; font-weight: 600; cursor: pointer; }
    .bld3d-reset:focus-visible { outline: 2px solid ${C.focus}; outline-offset: 2px; }
    @media (pointer: coarse) { .bld3d-reset { min-height: 44px; } }
    .bld3d-hint { position: absolute; left: 10px; bottom: 8px; padding: 3px 10px; border-radius: 6px; background: rgba(10,10,12,0.6);
        font-size: 12px; color: #fff; pointer-events: none; }
`;
