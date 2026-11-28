import React, { useDeferredValue, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { C, RADIUS } from '../uiTokens';
import { disposeTree } from './StairPreview3D';
import { buildScene, animateCranes } from './RouteModel3D';
import { confirmAction } from './ConfirmDialog';
import { buildingHeightM } from '../sunShadow';
import { polygonCentroid } from '../campusGeometry';
import { fromLocalMeters, toLocalMeters } from '../geo';
import {
    snapToOutline, placedDoors, doorFrames, doorWidth, DOOR_SNAP_M, DOOR_WIDTH_M, MIN_DOOR_WIDTH_M,
    MAX_DOOR_WIDTH_M, MAX_DOORS, DOOR_HEIGHT_M,
} from '../doors';
import { suggestEntrances } from '../pathfinding';
import {
    appearanceOf, roofColorOf, roofLayers, ROOF_STYLES, ROOF_MATERIALS, FACADES, CANOPY_SHAPES, DOOR_STYLES, FRAME_COLORS,
    ROOF_COLORS, WALL_COLORS, ACCENT_COLORS, STYLE_PRESETS, SIGN_MAX, DEFAULT_WALL,
    ITEM_CATEGORIES, ITEM_CATALOG, ITEM_BY_TYPE, MAX_ITEMS,
} from '../buildingAppearance';
import { buildStudioItemGroup, isRingCCW, itemBaseY, wallFrameForEdge } from './buildingItems3D';

// ── Building Studio (outside) ───────────────────────────────────────
// The building's department dresses it like a city-builder game: its roof shape and material, its walls
// and bands, the style of its front and windows, its doors and canopy, and its decorations — seen live in
// 3D where it stands among the campus. Undo / redo every change; nothing is saved (or seen by students)
// until Save. Opened from the building's card on the admin map.

const reduceMotion = () => typeof window !== 'undefined'
    && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function facingWords(deg) {
    const dirs = ['North', 'North-east', 'East', 'South-east', 'South', 'South-west', 'West', 'North-west'];
    return dirs[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}

/** The 3D view: the campus as the 3D views draw it, centred on the building being dressed. Drag to turn, wheel or pinch to zoom. */
function StudioView({
    building, buildings, pathways, bridges, objects, nodes = [], links = [],
    showInterior = false, onToggleInterior,
    selectedItemIndex = null, placingItem = null, movingItemIndex = null,
    onSelectItem, onPlaceAt, onMoveTo,
    selectedDoorIndex = null, placingDoorMode = false, movingDoorIndex = null, newDoorWidth = DOOR_WIDTH_M,
    onSelectDoor, onPlaceDoorAt, onMoveDoorTo,
}) {
    const hostRef = useRef(null);
    const stateRef = useRef(null);
    const interactRef = useRef({
        placingItem, movingItemIndex, onSelectItem, onPlaceAt, onMoveTo,
        placingDoorMode, movingDoorIndex, newDoorWidth, onSelectDoor, onPlaceDoorAt, onMoveDoorTo,
    });
    interactRef.current = {
        placingItem, movingItemIndex, onSelectItem, onPlaceAt, onMoveTo,
        placingDoorMode, movingDoorIndex, newDoorWidth, onSelectDoor, onPlaceDoorAt, onMoveDoorTo,
    };
    const key = JSON.stringify([building.appearance, building.doors, building.id, buildings.length, objects.length, nodes.length, links.length, selectedItemIndex, selectedDoorIndex, showInterior]);

    useEffect(() => {
        const host = hostRef.current;
        if (!host) return undefined;
        let renderer;
        try {
            renderer = new THREE.WebGLRenderer({ antialias: true });
        } catch {
            host.setAttribute('data-nogl', '1');
            return undefined;
        }
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer.domElement.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;cursor:grab;';
        host.appendChild(renderer.domElement);
        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0xa9bdd0);
        scene.add(new THREE.HemisphereLight(0xffffff, 0x6b7280, 1.15));
        const sun = new THREE.DirectionalLight(0xffffff, 1.6);
        sun.position.set(-40, 70, 50);
        scene.add(sun);
        const ground = new THREE.Mesh(new THREE.CircleGeometry(400, 48), new THREE.MeshStandardMaterial({ color: 0x8c9184, roughness: 1 }));
        ground.rotation.x = -Math.PI / 2;
        ground.position.y = -0.03;
        scene.add(ground);
        const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 3000);
        const group = new THREE.Group();
        scene.add(group);
        const raycaster = new THREE.Raycaster();
        const s = {
            renderer, scene, camera, group, raf: 0, dirty: true, az: 0.6, el: 0.32, dist: 60, fit: 60,
            target: new THREE.Vector3(), pointers: new Map(), pinch: 0, down: null,
            ring: [], ccw: true, height: 3.2, levels: 1, storeyH: 3.2, roofRise: 0, cx: 0, cz: 0,
            originLL: null, polygon: null, doors: [],
            ghost: null, ghostKey: '', keys: new Set(), lastFrame: performance.now(),
        };
        stateRef.current = s;
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
        const loop = (now = performance.now()) => {
            s.raf = requestAnimationFrame(loop);
            const dt = Math.min(0.05, Math.max(0.001, (now - s.lastFrame) / 1000));
            s.lastFrame = now;
            if (s.keys.size > 0) {
                const fwd = (s.keys.has('w') ? 1 : 0) - (s.keys.has('s') ? 1 : 0);
                const strafe = (s.keys.has('d') ? 1 : 0) - (s.keys.has('a') ? 1 : 0);
                const lift = (s.keys.has('e') ? 1 : 0) - (s.keys.has('q') ? 1 : 0);
                if (fwd || strafe || lift) {
                    const speed = (s.keys.has('shift') ? 2.2 : 1) * Math.max(8, s.dist * 0.45) * dt;
                    const fx = -Math.sin(s.az);
                    const fz = -Math.cos(s.az);
                    const rx = Math.cos(s.az);
                    const rz = -Math.sin(s.az);
                    s.target.x = Math.max(-200, Math.min(200, s.target.x + (fx * fwd + rx * strafe) * speed));
                    s.target.z = Math.max(-200, Math.min(200, s.target.z + (fz * fwd + rz * strafe) * speed));
                    s.target.y = Math.max(0, Math.min(100, s.target.y + lift * speed * 0.65));
                    s.dirty = true;
                }
            }
            if (!reduceMotion() && animateCranes(s.group, now / 1000)) {
                s.dirty = true;
            }
            if (!s.dirty) return;
            s.dirty = false;
            place();
            renderer.render(scene, camera);
        };
        loop();
        const el = renderer.domElement;

        const clearGhost = () => {
            if (!s.ghost) return;
            disposeTree(s.ghost);
            scene.remove(s.ghost);
            s.ghost = null;
            s.ghostKey = '';
            s.dirty = true;
        };
        s.clearGhost = clearGhost;

        const hitSpotAt = (ev, itemTemplate) => {
            const spec = itemTemplate ? ITEM_BY_TYPE[itemTemplate.type] : null;
            if (!spec || !s.ring.length) return null;
            const r = el.getBoundingClientRect();
            raycaster.setFromCamera(new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1), camera);
            if (spec.placement === 'roof') {
                const roofs = [];
                group.traverse((o) => { if (o.isMesh && o.userData.studioRoof) roofs.push(o); });
                const hit = raycaster.intersectObjects(roofs, false)[0];
                if (!hit) return null;
                return {
                    placement: 'roof',
                    edge: 0,
                    t: 0.5,
                    floor: 0,
                    y_offset: 0,
                    rx: Math.round((hit.point.x - s.cx) * 100) / 100,
                    rz: Math.round((hit.point.z - s.cz) * 100) / 100,
                };
            }
            const walls = [];
            group.traverse((o) => { if (o.isMesh && o.userData.studioWallEdge !== undefined) walls.push(o); });
            const hit = raycaster.intersectObjects(walls, false)[0];
            if (!hit) return null;
            const edge = hit.object.userData.studioWallEdge;
            const frame = wallFrameForEdge(s.ring, edge, s.ccw);
            if (!frame) return null;
            const proj = ((hit.point.x - frame.a.x) * frame.tx + (hit.point.z - frame.a.z) * frame.tz) / frame.len;
            const t = Math.max(0.03, Math.min(0.97, Math.round(proj * 1000) / 1000));
            const hitY = Math.max(0, hit.point.y);
            const floor = Math.max(0, Math.min(s.levels - 1, Math.floor(hitY / s.storeyH)));
            const floorGrounded = ['door_glass', 'door_wood', 'door_sliding', 'steps', 'ramp', 'planter', 'kiosk', 'bench', 'pillar_square', 'pillar_round'].includes(spec.type);
            let y_offset = 0;
            if (!floorGrounded) {
                const itemH = itemTemplate.height_m || spec.defaultHeight;
                const defaultBase = itemBaseY({ ...itemTemplate, floor, y_offset: 0 }, s.storeyH, s.height, s.roofRise);
                const targetBase = Math.max(0, Math.min(s.height - itemH * 0.25, hitY - itemH / 2));
                y_offset = Math.round((targetBase - defaultBase) * 100) / 100;
            }
            return { placement: 'wall', edge, t, floor, y_offset, rx: 0, rz: 0, frame };
        };

        const doorSpotAt = (ev) => {
            if (!s.originLL || !s.polygon) return null;
            const r = el.getBoundingClientRect();
            raycaster.setFromCamera(new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1), camera);
            const walls = [];
            group.traverse((o) => { if (o.isMesh && o.userData.studioWallEdge !== undefined) walls.push(o); });
            const hit = raycaster.intersectObjects(walls, false)[0];
            if (!hit) return null;
            const p = fromLocalMeters(s.originLL.lat, s.originLL.lng, hit.point.x, -hit.point.z);
            return { lat: p.latitude, lng: p.longitude };
        };

        const showGhost = (ev) => {
            const { placingItem: pItem, placingDoorMode: pDoor, movingDoorIndex: mDoor, newDoorWidth: dWidth } = interactRef.current;
            if (pDoor || mDoor !== null) {
                const at = doorSpotAt(ev);
                const activeW = mDoor !== null && s.doors?.[mDoor] ? doorWidth(s.doors[mDoor]) : dWidth;
                const frame = at && s.polygon ? doorFrames(s.polygon, [{ ...at, width_m: activeW }])[0] : null;
                if (!frame) { clearGhost(); return; }
                const blocked = placedDoors(s.polygon, s.doors).some((d, i) => i !== mDoor
                    && Math.hypot(...toLocalMeters(d.lat, d.lng, frame.center.lat, frame.center.lng)) < (d.width + frame.width) / 2);
                const gk = `door:${frame.a.lat.toFixed(7)},${frame.a.lng.toFixed(7)},${frame.width},${blocked}`;
                if (gk === s.ghostKey) return;
                clearGhost();
                const [ax, az] = toLocalMeters(frame.a.lat, frame.a.lng, s.originLL.lat, s.originLL.lng);
                const [bx, bz] = toLocalMeters(frame.b.lat, frame.b.lng, s.originLL.lat, s.originLL.lng);
                const len = Math.hypot(bx - ax, -(bz - az)) || 1;
                const rad = (frame.normalDeg * Math.PI) / 180;
                const nx = Math.sin(rad);
                const nz = -Math.cos(rad);
                const cx = (ax + bx) / 2;
                const cz = (-az - bz) / 2;
                const ghost = new THREE.Mesh(
                    new THREE.BoxGeometry(len, DOOR_HEIGHT_M, 0.2),
                    new THREE.MeshBasicMaterial({ color: blocked ? 0xef4444 : 0x4ade80, transparent: true, opacity: 0.5, depthWrite: false }),
                );
                ghost.position.set(cx + nx * 0.08, DOOR_HEIGHT_M / 2, cz + nz * 0.08);
                ghost.rotation.y = Math.atan2(nx, nz);
                s.ghost = ghost;
                s.ghostKey = gk;
                scene.add(ghost);
                s.dirty = true;
                return;
            }
            if (!pItem) { clearGhost(); return; }
            const spot = hitSpotAt(ev, pItem);
            if (!spot) { clearGhost(); return; }
            const gk = `${pItem.type}:${spot.edge}:${spot.t}:${spot.floor}:${spot.y_offset}:${spot.rx}:${spot.rz}`;
            if (gk === s.ghostKey) return;
            clearGhost();
            const preview = { ...pItem, ...spot };
            const ghost = buildStudioItemGroup(preview, { ghost: true });
            const baseY = itemBaseY(preview, s.storeyH, s.height, s.roofRise);
            if (spot.placement === 'roof') {
                ghost.position.set(s.cx + spot.rx, baseY, s.cz + spot.rz);
            } else {
                const along = spot.t * spot.frame.len;
                ghost.position.set(spot.frame.a.x + spot.frame.tx * along, baseY, spot.frame.a.z + spot.frame.tz * along);
                ghost.rotation.y = spot.frame.rotY;
            }
            s.ghost = ghost;
            s.ghostKey = gk;
            scene.add(ghost);
            s.dirty = true;
        };

        const handleTap = (ev) => {
            const {
                placingItem: pItem, movingItemIndex: mIdx, onSelectItem: selectFn, onPlaceAt: placeFn, onMoveTo: moveFn,
                placingDoorMode: pDoor, movingDoorIndex: mDoor, onSelectDoor: selectDoorFn, onPlaceDoorAt: placeDoorFn, onMoveDoorTo: moveDoorFn,
            } = interactRef.current;
            if (pDoor || mDoor !== null) {
                const at = doorSpotAt(ev);
                if (at) {
                    if (mDoor !== null && moveDoorFn) moveDoorFn(mDoor, at.lat, at.lng);
                    else if (placeDoorFn) placeDoorFn(at.lat, at.lng);
                    return;
                }
            }
            if (pItem) {
                const spot = hitSpotAt(ev, pItem);
                if (spot) {
                    const clean = { edge: spot.edge, t: spot.t, floor: spot.floor, y_offset: spot.y_offset, rx: spot.rx, rz: spot.rz };
                    if (mIdx !== null && moveFn) moveFn(mIdx, clean);
                    else if (placeFn) placeFn(clean);
                    return;
                }
            }
            const r = el.getBoundingClientRect();
            raycaster.setFromCamera(new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1), camera);
            if (selectDoorFn) {
                const doorMeshes = [];
                group.traverse((o) => { if (o.isMesh && o.userData.studioDoorIndex !== undefined) doorMeshes.push(o); });
                const doorHit = raycaster.intersectObjects(doorMeshes, false)[0];
                if (doorHit) { selectDoorFn(doorHit.object.userData.studioDoorIndex); return; }
            }
            if (!selectFn) return;
            const itemMeshes = [];
            group.traverse((o) => { if (o.isMesh && o.userData.studioItemIndex !== undefined) itemMeshes.push(o); });
            const hit = raycaster.intersectObjects(itemMeshes, false)[0];
            if (hit) selectFn(hit.object.userData.studioItemIndex);
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
                el.style.cursor = interactRef.current.placingItem ? 'crosshair' : 'grab';
                if (ev.pointerType !== 'touch') showGhost(ev);
                return;
            }
            clearGhost();
            const cur = { x: ev.clientX, y: ev.clientY };
            if (s.pointers.size === 2) {
                s.pointers.set(ev.pointerId, cur);
                const [p, q] = [...s.pointers.values()];
                const d = Math.hypot(p.x - q.x, p.y - q.y);
                if (s.pinch > 0 && d > 0) s.dist = Math.min(400, Math.max(6, s.dist * (s.pinch / d)));
                s.pinch = d;
            } else {
                s.az -= (cur.x - prev.x) * 0.01;
                s.el = Math.min(1.45, Math.max(0.04, s.el + (cur.y - prev.y) * 0.008));
                s.pointers.set(ev.pointerId, cur);
            }
            s.dirty = true;
        };
        const onUp = (ev) => {
            const wasTap = s.down && s.pointers.size === 1 && Math.hypot(ev.clientX - s.down.x, ev.clientY - s.down.y) < 6;
            s.pointers.delete(ev.pointerId);
            s.pinch = 0;
            if (!s.pointers.size) el.style.cursor = interactRef.current.placingItem ? 'crosshair' : 'grab';
            if (wasTap) handleTap(ev);
            s.down = null;
        };
        const onLeave = () => clearGhost();
        const onWheel = (ev) => {
            ev.preventDefault();
            s.dist = Math.min(400, Math.max(6, s.dist * (1 + ev.deltaY * 0.001)));
            s.dirty = true;
        };
        el.addEventListener('pointerdown', onDown);
        el.addEventListener('pointermove', onMove);
        el.addEventListener('pointerup', onUp);
        el.addEventListener('pointercancel', onUp);
        el.addEventListener('wheel', onWheel, { passive: false });
        el.addEventListener('pointerleave', onLeave);
        const onKeyDown = (ev) => {
            const tag = ev.target?.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || ev.ctrlKey || ev.metaKey || ev.altKey) return;
            const k = ev.key.toLowerCase();
            if (k === 'w' || k === 'a' || k === 's' || k === 'd' || k === 'q' || k === 'e' || k === 'shift') {
                s.keys.add(k);
            }
        };
        const onKeyUp = (ev) => { s.keys.delete(ev.key.toLowerCase()); };
        const onWindowBlur = () => { s.keys.clear(); };
        window.addEventListener('keydown', onKeyDown);
        window.addEventListener('keyup', onKeyUp);
        window.addEventListener('blur', onWindowBlur);
        // A slow half turn on first look, so it reads as 3D.
        let frames = reduceMotion() ? 0 : 90;
        const spin = setInterval(() => {
            if (frames-- <= 0 || s.pointers.size || s.keys.size) { clearInterval(spin); return; }
            s.az += 0.012;
            s.dirty = true;
        }, 16);
        return () => {
            clearInterval(spin);
            cancelAnimationFrame(s.raf);
            ro?.disconnect();
            window.removeEventListener('keydown', onKeyDown);
            window.removeEventListener('keyup', onKeyUp);
            window.removeEventListener('blur', onWindowBlur);
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
        const c = polygonCentroid(building.polygon) || { lat: +building.polygon[0].lat, lng: +building.polygon[0].lng };
        const others = buildings.filter((b) => b.id !== building.id);
        buildScene(s.group, {
            route: null,
            buildings: [building, ...others],
            links,
            nodes,
            pathways,
            bridges,
            objects,
            follow: true,
            origin: c,
            studio: { buildingId: building.id, selectedItemIndex, selectedDoorIndex, showInterior },
        });
        const h = buildingHeightM(building);
        const levels = Math.max(1, Number(building.floors) || Math.round(h / 3.2) || 1);
        const ring = building.polygon.map((p) => {
            const [e, n] = toLocalMeters(+p.lat, +p.lng, c.lat, c.lng);
            return { x: e, z: -n };
        });
        const { rise } = roofLayers(ring.map((p) => ({ x: p.x, y: -p.z })), building.appearance?.roof?.style || 'flat');
        s.ring = ring;
        s.ccw = isRingCCW(ring);
        s.height = h;
        s.levels = levels;
        s.storeyH = h / levels;
        s.roofRise = rise;
        s.cx = ring.reduce((sum, p) => sum + p.x, 0) / Math.max(1, ring.length);
        s.cz = ring.reduce((sum, p) => sum + p.z, 0) / Math.max(1, ring.length);
        s.originLL = c;
        s.polygon = building.polygon;
        s.doors = building.doors || [];
        s.clearGhost?.();
        const reach = Math.max(...building.polygon.map((p) => Math.hypot(...toLocalMeters(+p.lat, +p.lng, c.lat, c.lng))));
        s.target.set(0, h * 0.45, 0);
        const fit = Math.max(reach * 2.1, h * 2.4) + 8;
        if (s.dist === s.fit) s.dist = fit;
        s.fit = fit;
        s.dirty = true;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key]);

    useEffect(() => {
        if (!placingItem && !placingDoorMode && movingDoorIndex === null) stateRef.current?.clearGhost?.();
    }, [placingItem, placingDoorMode, movingDoorIndex]);

    const reset = () => {
        const s = stateRef.current;
        if (!s) return;
        s.az = 0.6; s.el = 0.32; s.dist = s.fit; s.target.set(0, s.height * 0.45, 0); s.dirty = true;
    };
    return (
        <div className="studio-view">
            <div ref={hostRef} className="studio-host" role="img" aria-label={`3D view of ${building.name} as it will look, among the campus. Drag to turn it.`} />
            <div className="studio-view-actions">
                <button type="button" className="studio-reset" onClick={reset}>Reset view</button>
                {onToggleInterior && (
                    <button
                        type="button"
                        className={`studio-reset${showInterior ? ' is-on' : ''}`}
                        aria-pressed={showInterior}
                        onClick={onToggleInterior}
                        title="See floors, staircases, rooms, and doors inside the building"
                    >
                        {showInterior ? 'Inside view: On' : 'Inside view'}
                    </button>
                )}
            </div>
            <span className="studio-tip" aria-hidden="true">
                {placingDoorMode || movingDoorIndex !== null
                    ? (movingDoorIndex !== null ? 'Tap a wall to move door · WASD move · drag to turn' : 'Tap a wall to place a door · WASD move · drag to turn')
                    : placingItem
                        ? (movingItemIndex !== null ? 'Tap a wall or roof to move · WASD move · drag to turn' : 'Tap a wall or roof to place · WASD move · drag to turn')
                        : 'WASD move · Q/E up/down · drag to turn · scroll to zoom'}
            </span>
        </div>
    );
}

/** A wrapping row of style choices (a radio group): the longer lists that do not fit a slider. */
function Chips({ label, value, onChange, options }) {
    return (
        <div className="studio-field">
            <span className="ui-label">{label}</span>
            <div className="studio-chips" role="radiogroup" aria-label={label}>
                {options.map((o) => (
                    <button key={o.value} type="button" role="radio" aria-checked={value === o.value} onClick={() => onChange(o.value)}>
                        {o.label}
                    </button>
                ))}
            </div>
        </div>
    );
}

/** A row of colour swatches (a radio group), optionally "none" and any colour. */
function Swatches({ id, label, value, onChange, options, none = null, custom = true }) {
    return (
        <div className="studio-field">
            <span className="ui-label" id={id}>{label}</span>
            <div className="studio-swatches" role="radiogroup" aria-labelledby={id}>
                {none && (
                    <button type="button" role="radio" aria-checked={value === null} className="studio-swatch is-none" title={none} aria-label={none} onClick={() => onChange(null)} />
                )}
                {options.map((o) => (
                    <button
                        key={o.value} type="button" role="radio" aria-checked={value === o.value} className="studio-swatch"
                        style={{ '--sw': o.value }} title={o.label} aria-label={o.label} onClick={() => onChange(o.value)}
                    />
                ))}
                {custom && (
                    <label className="studio-swatch is-custom" title="Any colour" style={{ '--sw': value && !options.some((o) => o.value === value) ? value : 'transparent' }}>
                        <input type="color" value={value || '#888888'} onChange={(e) => onChange(e.target.value)} aria-label={`${label}: any colour`} />
                    </label>
                )}
            </div>
        </div>
    );
}

/** Floating 3D miniature preview when hovering or focusing an item in the Place items catalog. */
function ItemHoverPreview({ hovered }) {
    const hostRef = useRef(null);
    const threeRef = useRef(null);

    useEffect(() => {
        const host = hostRef.current;
        if (!host) return undefined;
        let renderer;
        try {
            renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        } catch {
            return undefined;
        }
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer.setSize(140, 108, false);
        renderer.domElement.style.cssText = 'display:block;width:140px;height:108px;';
        host.appendChild(renderer.domElement);

        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0x1c212b);
        scene.add(new THREE.HemisphereLight(0xffffff, 0x6b7280, 1.3));
        const sun = new THREE.DirectionalLight(0xffffff, 1.4);
        sun.position.set(4, 7, 8);
        scene.add(sun);

        const camera = new THREE.PerspectiveCamera(36, 140 / 108, 0.05, 100);
        const group = new THREE.Group();
        scene.add(group);

        threeRef.current = { renderer, scene, camera, group };
        return () => {
            disposeTree(scene);
            renderer.dispose();
            renderer.forceContextLoss?.();
            if (renderer.domElement.parentNode === host) host.removeChild(renderer.domElement);
            threeRef.current = null;
        };
    }, []);

    useEffect(() => {
        const t = threeRef.current;
        if (!t || !hovered?.item) return;
        disposeTree(t.group);
        t.group.clear();

        const item = hovered.item;
        const mesh = buildStudioItemGroup({
            type: item.type,
            width_m: item.defaultWidth,
            height_m: item.defaultHeight,
            depth_m: item.defaultDepth,
            color: null,
            accent: null,
            awning: Boolean(item.hasAwning),
            label: item.hasLabel ? 'PREVIEW' : '',
        });
        t.group.add(mesh);

        // Subtle backing plate for wall-mounted items so depth & frames read clearly.
        if (item.placement === 'wall') {
            const backW = Math.max(1.2, item.defaultWidth * 1.15);
            const backH = Math.max(1.2, item.defaultHeight * 1.15);
            const back = new THREE.Mesh(
                new THREE.PlaneGeometry(backW, backH),
                new THREE.MeshStandardMaterial({ color: 0x3b4252, roughness: 0.95 }),
            );
            back.position.set(0, item.defaultHeight * 0.5, -0.02);
            t.group.add(back);
        }

        const box = new THREE.Box3().setFromObject(mesh);
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z, 0.8);
        const dist = maxDim * 1.85;
        const az = 0.45;
        const el = 0.25;
        t.camera.position.set(
            center.x + dist * Math.sin(az) * Math.cos(el),
            center.y + dist * Math.sin(el),
            center.z + dist * Math.cos(az) * Math.cos(el),
        );
        t.camera.lookAt(center);
        t.renderer.render(t.scene, t.camera);
    }, [hovered]);

    const visible = Boolean(hovered?.item);
    const top = visible
        ? Math.max(12, Math.min((typeof window !== 'undefined' ? window.innerHeight : 700) - 168, hovered.top - 48))
        : 12;
    return (
        <div className="studio-hover-preview" style={{ top, display: visible ? 'flex' : 'none' }} aria-hidden="true">
            <div ref={hostRef} className="studio-hover-canvas" />
            <div className="studio-hover-meta">
                <strong>{hovered?.item?.label || ''}</strong>
                <span>{hovered?.item ? `${hovered.item.defaultWidth.toFixed(1)} × ${hovered.item.defaultHeight.toFixed(1)} m` : ''}</span>
            </div>
        </div>
    );
}

/** Numeric stepper for width/height in metres. */
function SizeStepper({ label, value, min, max, step = 0.2, onChange }) {
    const clamp = (v) => Math.round(Math.min(max, Math.max(min, v)) * 100) / 100;
    return (
        <div className="studio-stepper-row">
            <span className="studio-stepper-label">{label}</span>
            <div className="studio-stepper" role="group" aria-label={label}>
                <button type="button" onClick={() => onChange(clamp(value - step))} disabled={value <= min} aria-label={`Decrease ${label}`}>−</button>
                <span>{Number(value).toFixed(1)} m</span>
                <button type="button" onClick={() => onChange(clamp(value + step))} disabled={value >= max} aria-label={`Increase ${label}`}>+</button>
            </div>
        </div>
    );
}

export default function BuildingStudio({
    building, buildings = [], pathways = [], bridges = [], objects = [],
    nodes = [], links = [], canManageDoors = false, onSave, onClose,
}) {
    const original = appearanceOf(building);
    const originalDoors = (Array.isArray(building.doors) ? building.doors : [])
        .filter((d) => d && Number.isFinite(+d.lat) && Number.isFinite(+d.lng))
        .map((d) => ({ lat: +d.lat, lng: +d.lng, width_m: doorWidth(d) }));
    const [draft, setDraft] = useState({ look: original, doors: originalDoors });
    const [past, setPast] = useState([]);
    const [future, setFuture] = useState([]);
    const [saving, setSaving] = useState(false);
    const [tab, setTab] = useState('general'); // 'general' | 'items' | 'doors'
    const [catFilter, setCatFilter] = useState('all');
    const [placingType, setPlacingType] = useState(null);
    const [selectedItemIndex, setSelectedItemIndex] = useState(null);
    const [movingItemIndex, setMovingItemIndex] = useState(null);
    const [hoveredCatalog, setHoveredCatalog] = useState(null);
    // Door management state (for the assigned department account).
    const [placingDoor, setPlacingDoor] = useState(false);
    const [movingDoor, setMovingDoor] = useState(null);
    const [newDoorWidth, setNewDoorWidth] = useState(DOOR_WIDTH_M);
    const [doorNote, setDoorNote] = useState(null);
    const [showInterior, setShowInterior] = useState(false);

    const look = draft.look;
    const doors = draft.doors;
    // The 3D view follows a step behind while a colour is being dragged, so the panel stays quick.
    const shown = useDeferredValue(look);
    const dirty = JSON.stringify(draft) !== JSON.stringify({ look: original, doors: originalDoors });

    const commit = (nextDraft) => {
        setPast((p) => [...p.slice(-49), draft]);
        setFuture([]);
        setDraft(nextDraft);
    };
    const change = (nextLook) => commit({ look: nextLook, doors });
    const setDoors = (nextDoorsOrFn) => {
        const nextDoors = typeof nextDoorsOrFn === 'function' ? nextDoorsOrFn(doors) : nextDoorsOrFn;
        commit({ look, doors: nextDoors });
    };
    const patch = (section, values) => change({ ...look, [section]: { ...look[section], ...values } });
    const undo = () => {
        if (!past.length) return;
        setFuture((f) => [draft, ...f]);
        setDraft(past[past.length - 1]);
        setPast((p) => p.slice(0, -1));
    };
    const redo = () => {
        if (!future.length) return;
        setPast((p) => [...p, draft]);
        setDraft(future[0]);
        setFuture((f) => f.slice(1));
    };
    const close = async () => {
        if (dirty && !(await confirmAction({
            title: 'Leave without saving?', message: 'Your changes to the building are not saved yet.', confirmLabel: 'Leave', tone: 'danger',
        }))) return;
        onClose();
    };
    const save = async () => {
        setSaving(true);
        try { await onSave(look, doors); } finally { setSaving(false); }
    };

    const points = Array.isArray(building.polygon) ? building.polygon : [];
    const frames = points.length >= 3 ? doorFrames(points, doors) : [];

    const addDoorAt = (lat, lng) => {
        const s = snapToOutline(points, lat, lng);
        if (!s || s.distM > DOOR_SNAP_M) { setDoorNote('Tap on or right next to the building wall.'); return; }
        const placed = placedDoors(points, doors);
        if (placed.length >= MAX_DOORS) { setDoorNote(`A building can have up to ${MAX_DOORS} doors.`); return; }
        const crowded = placed.some((d) => Math.hypot(...toLocalMeters(d.lat, d.lng, s.lat, s.lng)) < (d.width + newDoorWidth) / 2);
        if (crowded) { setDoorNote('There is a door there already.'); return; }
        setDoorNote(null);
        setDoors((prev) => [...prev, { lat: s.lat, lng: s.lng, width_m: newDoorWidth }]);
    };
    const setDoorWidthAt = (k, width) => setDoors((prev) => prev.map((p, i) => (i === k ? { ...p, width_m: width } : p)));
    const fitsDoor = (k, s, width) => !placedDoors(points, doors).some((d, i) => i !== k
        && Math.hypot(...toLocalMeters(d.lat, d.lng, s.lat, s.lng)) < (d.width + width) / 2);
    const moveDoorTo = (k, lat, lng) => {
        const s = snapToOutline(points, lat, lng);
        if (!s || s.distM > DOOR_SNAP_M) { setDoorNote('Tap on or right next to the building wall.'); return false; }
        if (!fitsDoor(k, s, doorWidth(doors[k]))) { setDoorNote('That spot overlaps another door.'); return false; }
        setDoorNote(null);
        setDoors((prev) => prev.map((p, i) => (i === k ? { ...p, lat: s.lat, lng: s.lng } : p)));
        setMovingDoor(null);
        return true;
    };
    const slideDoor = (k, metres) => {
        const f = frames[k];
        if (!f) return;
        const [ae, an] = toLocalMeters(f.a.lat, f.a.lng, f.center.lat, f.center.lng);
        const [be, bn] = toLocalMeters(f.b.lat, f.b.lng, f.center.lat, f.center.lng);
        const len = Math.hypot(be - ae, bn - an) || 1;
        const p = fromLocalMeters(f.center.lat, f.center.lng, ((be - ae) / len) * metres, ((bn - an) / len) * metres);
        moveDoorTo(k, p.latitude, p.longitude);
    };
    const toggleDoorMove = (k) => {
        setPlacingDoor(false);
        setPlacingType(null);
        setMovingItemIndex(null);
        setDoorNote(null);
        setMovingDoor((m) => (m === k ? null : k));
    };
    const findEntrances = () => {
        const borders = buildings.filter((b) => b.id !== building.id && Array.isArray(b.polygon) && b.polygon.length >= 3);
        const found = suggestEntrances(points, nodes, { floor: 0, links, walls: borders });
        const placed = placedDoors(points, doors);
        const add = [];
        for (const s of found) {
            const taken = [...placed, ...add.map((a) => ({ ...a, width: newDoorWidth }))]
                .some((d) => Math.hypot(...toLocalMeters(d.lat, d.lng, s.lat, s.lng)) < (d.width + newDoorWidth) / 2);
            if (!taken && placed.length + add.length < MAX_DOORS) add.push(s);
        }
        setPlacingDoor(false);
        setMovingDoor(null);
        if (add.length) {
            setDoors((prev) => [...prev, ...add.map((s) => ({ lat: s.lat, lng: s.lng, width_m: newDoorWidth }))]);
            setDoorNote(`Added ${add.length} ${add.length === 1 ? 'door' : 'doors'} where paths come in. Check them, then Save.`);
        } else {
            setDoorNote(found.length
                ? 'Every path that comes in already has a door.'
                : 'No path crosses the outline yet. Lay route nodes up to the building first, or add doors by hand.');
        }
    };
    const removeDoor = (k) => {
        setDoors((prev) => prev.filter((_, i) => i !== k));
        setDoorNote(null);
        setMovingDoor(null);
    };
    const selectDoorFrom3D = (idx) => {
        if (!canManageDoors) return;
        setTab('doors');
        setPlacingType(null);
        setMovingItemIndex(null);
        setSelectedItemIndex(null);
        toggleDoorMove(idx);
    };

    const items = look.items || [];
    const activeSelectedIndex = selectedItemIndex !== null && items[selectedItemIndex] ? selectedItemIndex : null;
    const activeMovingIndex = movingItemIndex !== null && items[movingItemIndex] ? movingItemIndex : null;
    const selectedItem = activeSelectedIndex !== null ? items[activeSelectedIndex] : null;
    const selectedSpec = selectedItem ? ITEM_BY_TYPE[selectedItem.type] : null;
    const maxFloor = Math.max(0, (Number(building.floors) || 1) - 1);

    const placingTemplate = placingType && ITEM_BY_TYPE[placingType]
        ? {
            type: placingType,
            width_m: ITEM_BY_TYPE[placingType].defaultWidth,
            height_m: ITEM_BY_TYPE[placingType].defaultHeight,
            depth_m: ITEM_BY_TYPE[placingType].defaultDepth,
            color: null,
            accent: null,
            awning: false,
            label: '',
        }
        : (activeMovingIndex !== null ? items[activeMovingIndex] : null);

    const updateItem = (idx, values) => {
        const nextItems = items.map((it, i) => (i === idx ? { ...it, ...values } : it));
        change({ ...look, items: nextItems });
    };

    const placeItemAt = (spot) => {
        const spec = ITEM_BY_TYPE[placingType];
        if (!spec || items.length >= MAX_ITEMS) return;
        const nextItem = {
            id: `it_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
            type: spec.type,
            edge: spot.edge,
            t: spot.t,
            floor: spot.floor,
            y_offset: spot.y_offset || 0,
            rx: spot.rx,
            rz: spot.rz,
            width_m: spec.defaultWidth,
            height_m: spec.defaultHeight,
            depth_m: spec.defaultDepth,
            color: null,
            accent: null,
            awning: false,
            label: '',
        };
        const nextItems = [...items, nextItem];
        change({ ...look, items: nextItems });
        setSelectedItemIndex(nextItems.length - 1);
    };

    const moveItemTo = (idx, spot) => {
        updateItem(idx, { edge: spot.edge, t: spot.t, floor: spot.floor, y_offset: spot.y_offset || 0, rx: spot.rx, rz: spot.rz });
        setMovingItemIndex(null);
    };

    const slideItem = (idx, deltaM) => {
        const it = items[idx];
        const poly = building.polygon || [];
        if (!it || poly.length < 3) return;
        const a = poly[it.edge % poly.length];
        const b = poly[(it.edge + 1) % poly.length];
        const [ax, ay] = toLocalMeters(+a.lat, +a.lng, +poly[0].lat, +poly[0].lng);
        const [bx, by] = toLocalMeters(+b.lat, +b.lng, +poly[0].lat, +poly[0].lng);
        const len = Math.hypot(bx - ax, by - ay) || 1;
        const nextT = Math.max(0.02, Math.min(0.98, Math.round(((it.t ?? 0.5) + deltaM / len) * 1000) / 1000));
        updateItem(idx, { t: nextT });
    };

    const duplicateItem = (idx) => {
        const it = items[idx];
        if (!it || items.length >= MAX_ITEMS) return;
        const copy = {
            ...it,
            id: `it_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
            t: Math.min(0.96, (it.t ?? 0.5) + 0.08),
            rx: (it.rx || 0) + 1.5,
        };
        const nextItems = [...items, copy];
        change({ ...look, items: nextItems });
        setSelectedItemIndex(nextItems.length - 1);
        setMovingItemIndex(null);
        setPlacingType(null);
    };

    const removeItem = (idx) => {
        const nextItems = items.filter((_, i) => i !== idx);
        change({ ...look, items: nextItems });
        setSelectedItemIndex(null);
        setMovingItemIndex(null);
    };

    const selectItemFrom3D = (idx) => {
        setTab('items');
        setPlacingType(null);
        setMovingItemIndex(null);
        setSelectedItemIndex(idx);
    };

    const signStartRef = useRef(null);
    // Ctrl+Z / Ctrl+Y (or Shift+Ctrl+Z) undo and redo; Escape leaves.
    const keysRef = useRef(null);
    keysRef.current = { undo, redo, close };
    useEffect(() => {
        const onKey = (e) => {
            if (e.target?.tagName === 'INPUT' && e.target.type === 'text') return;
            const mod = e.ctrlKey || e.metaKey;
            if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); (e.shiftKey ? keysRef.current.redo : keysRef.current.undo)(); }
            else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); keysRef.current.redo(); }
            else if (e.key === 'Escape') keysRef.current.close();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);

    const hasDoors = doors.length > 0;
    const filteredCatalog = catFilter === 'all' ? ITEM_CATALOG : ITEM_CATALOG.filter((it) => it.category === catFilter);

    return (
        <div className="studio" role="dialog" aria-modal="true" aria-labelledby="studio-title">
            <StudioView
                building={{ ...building, appearance: shown, doors }}
                buildings={buildings}
                pathways={pathways}
                bridges={bridges}
                objects={objects}
                nodes={nodes}
                links={links}
                showInterior={showInterior}
                onToggleInterior={() => setShowInterior((v) => !v)}
                selectedItemIndex={activeSelectedIndex}
                placingItem={placingTemplate}
                movingItemIndex={activeMovingIndex}
                onSelectItem={selectItemFrom3D}
                onPlaceAt={placeItemAt}
                onMoveTo={moveItemTo}
                selectedDoorIndex={movingDoor}
                placingDoorMode={canManageDoors && placingDoor}
                movingDoorIndex={canManageDoors ? movingDoor : null}
                newDoorWidth={newDoorWidth}
                onSelectDoor={selectDoorFrom3D}
                onPlaceDoorAt={addDoorAt}
                onMoveDoorTo={moveDoorTo}
            />
            <ItemHoverPreview hovered={tab === 'items' ? hoveredCatalog : null} />
            <aside className="studio-panel">
                <header className="studio-head">
                    <div>
                        <span className="studio-kicker">Building Studio</span>
                        <h2 id="studio-title">{building.name}</h2>
                    </div>
                    <button type="button" className="studio-x" onClick={close} aria-label="Close the Building Studio">×</button>
                </header>
                <div className={`studio-tabs${canManageDoors ? ' has-3' : ''}`} role="tablist" aria-label="Studio editing mode">
                    <button
                        type="button" role="tab" aria-selected={tab === 'general'}
                        onClick={() => { setTab('general'); setPlacingType(null); setMovingItemIndex(null); setPlacingDoor(false); setMovingDoor(null); }}
                    >
                        General style
                    </button>
                    <button
                        type="button" role="tab" aria-selected={tab === 'items'}
                        onClick={() => { setTab('items'); setPlacingDoor(false); setMovingDoor(null); }}
                    >
                        Place items{items.length ? ` (${items.length})` : ''}
                    </button>
                    {canManageDoors && (
                        <button
                            type="button" role="tab" aria-selected={tab === 'doors'}
                            onClick={() => { setTab('doors'); setPlacingType(null); setMovingItemIndex(null); setSelectedItemIndex(null); }}
                        >
                            Doors{doors.length ? ` (${doors.length})` : ''}
                        </button>
                    )}
                </div>
                <div className="studio-body">
                    {tab === 'doors' && canManageDoors ? (
                        <>
                            <section aria-labelledby="studio-manage-doors">
                                <h3 id="studio-manage-doors">Manage doors</h3>
                                <SizeStepper
                                    label="New door width"
                                    value={newDoorWidth}
                                    min={MIN_DOOR_WIDTH_M}
                                    max={MAX_DOOR_WIDTH_M}
                                    onChange={setNewDoorWidth}
                                />
                                <div className="studio-item-actions">
                                    <button
                                        type="button"
                                        className={`ui-btn ui-btn-sm ${placingDoor ? 'ui-btn-primary' : 'ui-btn-secondary'}`}
                                        aria-pressed={placingDoor}
                                        onClick={() => { setMovingDoor(null); setPlacingDoor((v) => !v); setDoorNote(null); }}
                                    >
                                        {placingDoor ? 'Done adding doors' : 'Add door'}
                                    </button>
                                    <button type="button" className="ui-btn ui-btn-secondary ui-btn-sm" onClick={findEntrances}>
                                        Find entrances
                                    </button>
                                </div>
                                <p className="ui-hint" style={{ margin: 0 }} role="status">
                                    {doorNote || (movingDoor !== null
                                        ? `Moving Door ${movingDoor + 1}: tap a wall in the 3D view, or slide it below.`
                                        : placingDoor
                                            ? 'Tap any ground-floor wall in the 3D view to add a door.'
                                            : 'Tap a door in 3D, or press Move, to reposition it. Find entrances adds doors where paths meet the building.')}
                                </p>
                            </section>
                            <section aria-labelledby="studio-door-list">
                                <h3 id="studio-door-list">Doors ({frames.length}/{MAX_DOORS})</h3>
                                {frames.length === 0 ? (
                                    <p className="ui-hint" style={{ margin: 0 }}>
                                        No doors yet. Routes can enter this building from any side until you add one.
                                    </p>
                                ) : (
                                    <ul className="studio-placed">
                                        {frames.map((d, k) => (
                                            <li key={`${d.center.lat}-${d.center.lng}-${k}`} className={movingDoor === k ? 'is-selected' : ''} style={{ flexDirection: 'column', alignItems: 'stretch', padding: 8, gap: 6 }}>
                                                <div className="studio-item-head">
                                                    <div>
                                                        <strong style={{ fontSize: 13, color: '#fff' }}>Door {k + 1}{k === 0 ? ' (Main)' : ''}</strong>
                                                        <div className="studio-item-meta">Faces {facingWords(d.normalDeg)}</div>
                                                    </div>
                                                    <div className="studio-item-actions">
                                                        <button
                                                            type="button"
                                                            className={`studio-mini-btn${movingDoor === k ? ' is-on' : ''}`}
                                                            onClick={() => toggleDoorMove(k)}
                                                        >
                                                            {movingDoor === k ? 'Done' : 'Move'}
                                                        </button>
                                                        <button type="button" className="studio-mini-btn is-danger" onClick={() => removeDoor(k)}>Remove</button>
                                                    </div>
                                                </div>
                                                <SizeStepper
                                                    label="Width"
                                                    value={doorWidth(doors[k])}
                                                    min={MIN_DOOR_WIDTH_M}
                                                    max={MAX_DOOR_WIDTH_M}
                                                    onChange={(w) => setDoorWidthAt(k, w)}
                                                />
                                                {movingDoor === k && (
                                                    <div className="studio-stepper-row">
                                                        <span className="studio-stepper-label">Slide along wall</span>
                                                        <div className="studio-stepper">
                                                            <button type="button" onClick={() => slideDoor(k, -0.25)} aria-label="Slide back 25 centimetres">‹</button>
                                                            <span>0.25 m</span>
                                                            <button type="button" onClick={() => slideDoor(k, 0.25)} aria-label="Slide forward 25 centimetres">›</button>
                                                        </div>
                                                    </div>
                                                )}
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </section>
                        </>
                    ) : tab === 'general' ? (
                        <>
                            <section aria-labelledby="studio-styles">
                                <h3 id="studio-styles">Styles</h3>
                                <div className="studio-presets">
                                    {STYLE_PRESETS.map((p) => {
                                        const a = appearanceOf({ appearance: p.appearance });
                                        return (
                                            <button
                                                key={p.name} type="button" className="studio-preset"
                                                onClick={() => change({ ...a, items, entrance: { ...a.entrance, sign: look.entrance.sign } })}
                                            >
                                                <span className="studio-preset-art" aria-hidden="true">
                                                    <span style={{ background: roofColorOf(a) }} />
                                                    <span style={{ background: a.walls.color || DEFAULT_WALL, borderBottom: `4px solid ${a.walls.accent || 'transparent'}` }} />
                                                </span>
                                                <span className="studio-preset-name">{p.name}</span>
                                                <span className="studio-preset-hint">{p.hint}</span>
                                            </button>
                                        );
                                    })}
                                </div>
                            </section>
                    <section aria-labelledby="studio-roof">
                        <h3 id="studio-roof">Roof</h3>
                        <Chips label="Roof shape" value={look.roof.style} onChange={(v) => patch('roof', { style: v })} options={ROOF_STYLES} />
                        <Chips label="Roof material" value={look.roof.material} onChange={(v) => patch('roof', { material: v })} options={ROOF_MATERIALS} />
                        <Swatches id="studio-roof-color" label="Roof colour" value={look.roof.color} onChange={(v) => patch('roof', { color: v })} options={ROOF_COLORS} none="Map default" />
                    </section>
                    <section aria-labelledby="studio-walls">
                        <h3 id="studio-walls">Walls &amp; front</h3>
                        <Swatches id="studio-wall-color" label="Wall colour" value={look.walls.color} onChange={(v) => patch('walls', { color: v })} options={WALL_COLORS} none="Map default" />
                        <Swatches id="studio-accent" label="Accent (floor lines, pillars)" value={look.walls.accent} onChange={(v) => patch('walls', { accent: v })} options={ACCENT_COLORS} none="No accent" />
                        <Swatches id="studio-band" label="Band along the foot of each wall" value={look.walls.band} onChange={(v) => patch('walls', { band: v })} options={ACCENT_COLORS} none="Same as accent" />
                        <Chips label="Front" value={look.facade} onChange={(v) => change({ ...look, facade: v })} options={FACADES} />
                        {(look.facade === 'windows' || look.facade === 'arches' || look.facade === 'pillars') && (
                            <>
                                <Swatches id="studio-frame" label="Window frame colour" value={look.windows.frame} onChange={(v) => patch('windows', { frame: v })} options={FRAME_COLORS} none="Map default" />
                                <label className="studio-check">
                                    <input type="checkbox" checked={look.windows.awning} onChange={(e) => patch('windows', { awning: e.target.checked })} />
                                    <span>Concrete eyebrow over each window</span>
                                </label>
                            </>
                        )}
                    </section>
                    <section aria-labelledby="studio-entrance">
                        <h3 id="studio-entrance">Doors &amp; entrance</h3>
                        {!hasDoors && (
                            <p className="ui-hint studio-note">This building has no doors yet. Add them in Edit building → Doors: the doors, canopy, sign and ramp go here.</p>
                        )}
                        <Chips label="Door style" value={look.entrance.door} onChange={(v) => patch('entrance', { door: v })} options={DOOR_STYLES} />
                        <Swatches id="studio-door" label="Door colour" value={look.entrance.doorColor} onChange={(v) => patch('entrance', { doorColor: v })} options={ACCENT_COLORS} none="Style default" />
                        <label className="studio-check">
                            <input type="checkbox" checked={look.entrance.canopy} onChange={(e) => patch('entrance', { canopy: e.target.checked })} />
                            <span>Canopy over the doors</span>
                        </label>
                        {look.entrance.canopy && (
                            <>
                                <Chips label="Canopy shape" value={look.entrance.canopyShape} onChange={(v) => patch('entrance', { canopyShape: v })} options={CANOPY_SHAPES} />
                                <Swatches id="studio-canopy" label="Canopy colour" value={look.entrance.color} onChange={(v) => patch('entrance', { color: v || look.entrance.color })} options={ACCENT_COLORS} />
                            </>
                        )}
                        <label className="studio-check">
                            <input type="checkbox" checked={look.entrance.steps} onChange={(e) => patch('entrance', { steps: e.target.checked })} />
                            <span>Steps up to the doors</span>
                        </label>
                        <div className="studio-field">
                            <label className="ui-label" htmlFor="studio-sign">Sign over the main entrance</label>
                            <input
                                id="studio-sign" className="ui-input" maxLength={SIGN_MAX} value={look.entrance.sign}
                                placeholder={`e.g. ${String(building.name || '').toUpperCase()}`}
                                // Typing is one step for undo: the look before it is kept when the field is left.
                                onFocus={() => { signStartRef.current = look; }}
                                onChange={(e) => setLook({ ...look, entrance: { ...look.entrance, sign: e.target.value } })}
                                onBlur={() => {
                                    const before = signStartRef.current;
                                    if (before && before.entrance.sign !== look.entrance.sign) { setPast((h) => [...h.slice(-49), before]); setFuture([]); }
                                }}
                            />
                        </div>
                        <label className="studio-check">
                            <input type="checkbox" checked={look.entrance.ramp} onChange={(e) => patch('entrance', { ramp: e.target.checked })} />
                            <span>Wheelchair ramp at the main entrance</span>
                        </label>
                    </section>
                    <section aria-labelledby="studio-decor">
                        <h3 id="studio-decor">Decorations</h3>
                        <label className="studio-check">
                            <input type="checkbox" checked={look.decor.planters} onChange={(e) => patch('decor', { planters: e.target.checked })} />
                            <span>Planter boxes beside the doors</span>
                        </label>
                        <label className="studio-check">
                            <input type="checkbox" checked={look.decor.ac} onChange={(e) => patch('decor', { ac: e.target.checked })} />
                            <span>Wall air-con units</span>
                        </label>
                        <label className="studio-check">
                            <input type="checkbox" checked={look.decor.tank} onChange={(e) => patch('decor', { tank: e.target.checked })} />
                            <span>Water tank on the roof</span>
                        </label>
                        <label className="studio-check">
                            <input type="checkbox" checked={look.decor.bunting} onChange={(e) => patch('decor', { bunting: e.target.checked })} />
                            <span>Flags across the front</span>
                        </label>
                    </section>
                        </>
                    ) : (
                        <>
                            {selectedItem && selectedSpec && (
                                <section className="studio-inspector" aria-labelledby="studio-selected-item">
                                    <div className="studio-item-head">
                                        <div>
                                            <h3 id="studio-selected-item">{selectedSpec.label}</h3>
                                            <span className="studio-item-meta">
                                                {selectedSpec.placement === 'roof'
                                                    ? 'Roof placement'
                                                    : `Wall ${(selectedItem.edge || 0) + 1} · Floor ${(selectedItem.floor || 0) + 1}`}
                                            </span>
                                        </div>
                                        <button type="button" className="studio-mini-btn" onClick={() => { setSelectedItemIndex(null); setMovingItemIndex(null); }}>Done</button>
                                    </div>
                                    <div className="studio-item-actions">
                                        <button
                                            type="button"
                                            className={`studio-mini-btn${activeMovingIndex === activeSelectedIndex ? ' is-on' : ''}`}
                                            onClick={() => {
                                                setPlacingType(null);
                                                setMovingItemIndex(activeMovingIndex === activeSelectedIndex ? null : activeSelectedIndex);
                                            }}
                                        >
                                            {activeMovingIndex === activeSelectedIndex ? 'Tap 3D wall…' : 'Move'}
                                        </button>
                                        <button type="button" className="studio-mini-btn" onClick={() => duplicateItem(activeSelectedIndex)} disabled={items.length >= MAX_ITEMS}>Duplicate</button>
                                        <button type="button" className="studio-mini-btn is-danger" onClick={() => removeItem(activeSelectedIndex)}>Remove</button>
                                    </div>
                                    {selectedSpec.placement === 'wall' && (
                                        <div className="studio-pos-controls">
                                            <div className="studio-stepper-row">
                                                <span className="studio-stepper-label">Slide along wall</span>
                                                <div className="studio-stepper">
                                                    <button type="button" onClick={() => slideItem(activeSelectedIndex, -0.25)} aria-label="Slide left 25 centimetres">‹</button>
                                                    <span>{Math.round((selectedItem.t ?? 0.5) * 100)}%</span>
                                                    <button type="button" onClick={() => slideItem(activeSelectedIndex, 0.25)} aria-label="Slide right 25 centimetres">›</button>
                                                </div>
                                            </div>
                                            <div className="studio-stepper-row">
                                                <span className="studio-stepper-label">Vertical height</span>
                                                <div className="studio-stepper">
                                                    <button
                                                        type="button"
                                                        onClick={() => updateItem(activeSelectedIndex, { y_offset: Math.round(Math.max(-10, (selectedItem.y_offset || 0) - 0.2) * 100) / 100 })}
                                                        aria-label="Move down 20 centimetres"
                                                    >
                                                        ↓
                                                    </button>
                                                    <span>{(selectedItem.y_offset || 0) >= 0 ? '+' : ''}{(selectedItem.y_offset || 0).toFixed(1)} m</span>
                                                    <button
                                                        type="button"
                                                        onClick={() => updateItem(activeSelectedIndex, { y_offset: Math.round(Math.min(50, (selectedItem.y_offset || 0) + 0.2) * 100) / 100 })}
                                                        aria-label="Move up 20 centimetres"
                                                    >
                                                        ↑
                                                    </button>
                                                </div>
                                            </div>
                                            {maxFloor > 0 && (
                                                <div className="studio-stepper-row">
                                                    <span className="studio-stepper-label">Floor</span>
                                                    <div className="studio-stepper">
                                                        <button type="button" onClick={() => updateItem(activeSelectedIndex, { floor: Math.max(0, (selectedItem.floor || 0) - 1) })} disabled={(selectedItem.floor || 0) <= 0}>−</button>
                                                        <span>Floor {(selectedItem.floor || 0) + 1}</span>
                                                        <button type="button" onClick={() => updateItem(activeSelectedIndex, { floor: Math.min(maxFloor, (selectedItem.floor || 0) + 1) })} disabled={(selectedItem.floor || 0) >= maxFloor}>+</button>
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    )}
                                    <SizeStepper
                                        label="Width" value={selectedItem.width_m} min={selectedSpec.minWidth} max={selectedSpec.maxWidth}
                                        onChange={(w) => updateItem(activeSelectedIndex, { width_m: w })}
                                    />
                                    <SizeStepper
                                        label="Height" value={selectedItem.height_m} min={selectedSpec.minHeight} max={selectedSpec.maxHeight}
                                        onChange={(h) => updateItem(activeSelectedIndex, { height_m: h })}
                                    />
                                    {selectedSpec.hasAwning && (
                                        <label className="studio-check">
                                            <input type="checkbox" checked={Boolean(selectedItem.awning)} onChange={(e) => updateItem(activeSelectedIndex, { awning: e.target.checked })} />
                                            <span>Concrete eyebrow awning</span>
                                        </label>
                                    )}
                                    {selectedSpec.hasLabel && (
                                        <div className="studio-field">
                                            <label className="ui-label" htmlFor="studio-item-label">Sign / banner text</label>
                                            <input
                                                id="studio-item-label" className="ui-input" maxLength={SIGN_MAX}
                                                value={selectedItem.label || ''}
                                                placeholder="e.g. COLLEGE OF MEDICINE"
                                                onChange={(e) => updateItem(activeSelectedIndex, { label: e.target.value })}
                                            />
                                        </div>
                                    )}
                                    <Swatches id="studio-item-color" label="Primary colour" value={selectedItem.color} onChange={(c) => updateItem(activeSelectedIndex, { color: c })} options={[...WALL_COLORS, ...ACCENT_COLORS].slice(0, 6)} none="Item default" />
                                    <Swatches id="studio-item-accent" label="Frame / accent colour" value={selectedItem.accent} onChange={(c) => updateItem(activeSelectedIndex, { accent: c })} options={FRAME_COLORS} none="Item default" />
                                </section>
                            )}

                            <section aria-labelledby="studio-catalog">
                                <div className="studio-item-head">
                                    <h3 id="studio-catalog">Add item</h3>
                                    {placingType && (
                                        <button type="button" className="studio-mini-btn is-on" onClick={() => setPlacingType(null)}>Stop placing</button>
                                    )}
                                </div>
                                <p className="ui-hint" style={{ margin: 0 }}>
                                    {placingType
                                        ? `Tap any ${ITEM_BY_TYPE[placingType]?.placement === 'roof' ? 'roof' : 'wall'} in the 3D view to place a ${ITEM_BY_TYPE[placingType]?.label}.`
                                        : 'Pick an item below, then tap on the 3D building to place it. Tap any placed item in 3D to resize or move it.'}
                                </p>
                                <div className="studio-chips" role="radiogroup" aria-label="Item category">
                                    <button type="button" role="radio" aria-checked={catFilter === 'all'} onClick={() => setCatFilter('all')}>All</button>
                                    {ITEM_CATEGORIES.map((cat) => (
                                        <button key={cat.value} type="button" role="radio" aria-checked={catFilter === cat.value} onClick={() => setCatFilter(cat.value)}>
                                            {cat.label}
                                        </button>
                                    ))}
                                </div>
                                <div className="studio-catalog-grid" onMouseLeave={() => setHoveredCatalog(null)}>
                                    {filteredCatalog.map((item) => {
                                        const active = placingType === item.type;
                                        const showPreview = (e) => setHoveredCatalog({ item, top: e.currentTarget.getBoundingClientRect().top });
                                        return (
                                            <button
                                                key={item.type} type="button"
                                                className={`studio-catalog-btn${active ? ' is-active' : ''}`}
                                                aria-pressed={active}
                                                disabled={items.length >= MAX_ITEMS && !active}
                                                onMouseEnter={showPreview}
                                                onFocus={showPreview}
                                                onBlur={() => setHoveredCatalog((prev) => (prev?.item?.type === item.type ? null : prev))}
                                                onClick={() => {
                                                    setMovingItemIndex(null);
                                                    setPlacingType(active ? null : item.type);
                                                }}
                                            >
                                                <span className="studio-catalog-name">{item.label}</span>
                                                <span className="studio-catalog-size">{item.defaultWidth.toFixed(1)}×{item.defaultHeight.toFixed(1)}m</span>
                                            </button>
                                        );
                                    })}
                                </div>
                            </section>

                            <section aria-labelledby="studio-placed-list">
                                <h3 id="studio-placed-list">Placed items ({items.length}/{MAX_ITEMS})</h3>
                                {items.length === 0 ? (
                                    <p className="ui-hint" style={{ margin: 0 }}>No individual items placed yet.</p>
                                ) : (
                                    <ul className="studio-placed">
                                        {items.map((it, idx) => {
                                            const spec = ITEM_BY_TYPE[it.type];
                                            const isSel = activeSelectedIndex === idx;
                                            return (
                                                <li key={it.id} className={isSel ? 'is-selected' : ''}>
                                                    <button
                                                        type="button" className="studio-placed-pick"
                                                        onClick={() => { setPlacingType(null); setMovingItemIndex(null); setSelectedItemIndex(isSel ? null : idx); }}
                                                    >
                                                        <span>{spec?.label || it.type}{it.label ? ` — ${it.label}` : ''}</span>
                                                        <small>
                                                            {spec?.placement === 'roof' ? 'Roof' : `W${(it.edge || 0) + 1} · F${(it.floor || 0) + 1}`} · {Number(it.width_m).toFixed(1)}×{Number(it.height_m).toFixed(1)}m
                                                        </small>
                                                    </button>
                                                    <button type="button" className="studio-mini-btn is-danger" onClick={() => removeItem(idx)} aria-label={`Remove ${spec?.label || 'item'}`}>×</button>
                                                </li>
                                            );
                                        })}
                                    </ul>
                                )}
                            </section>
                        </>
                    )}
                </div>
                <footer className="studio-foot">
                    <div className="studio-history">
                        <button type="button" className="ui-btn ui-btn-secondary ui-btn-sm" onClick={undo} disabled={!past.length} title="Undo (Ctrl+Z)">Undo</button>
                        <button type="button" className="ui-btn ui-btn-secondary ui-btn-sm" onClick={redo} disabled={!future.length} title="Redo (Ctrl+Y)">Redo</button>
                        <button type="button" className="ui-btn ui-btn-secondary ui-btn-sm" onClick={() => change(appearanceOf({}))} title="Back to the plain look">Plain</button>
                    </div>
                    <div className="studio-actions">
                        <button type="button" className="ui-btn ui-btn-secondary" onClick={close}>Cancel</button>
                        <button type="button" className="ui-btn ui-btn-primary" onClick={save} disabled={!dirty || saving}>{saving ? 'Saving…' : 'Save'}</button>
                    </div>
                </footer>
            </aside>
        </div>
    );
}

export const STUDIO_CSS = `
    .studio { position: fixed; inset: 0; z-index: 4000; display: grid; grid-template-columns: minmax(0, 1fr) 380px; background: ${C.page}; }
    .studio-view { position: relative; min-height: 0; }
    .studio-host { position: absolute; inset: 0; }
    .studio-host[data-nogl] { display: flex; align-items: center; justify-content: center; }
    .studio-host[data-nogl]::after { content: 'The Building Studio needs WebGL'; color: ${C.muted}; font-size: 14px; }
    .studio-view-actions { position: absolute; top: 12px; left: 12px; display: flex; gap: 8px; flex-wrap: wrap; z-index: 2; }
    .studio-reset { position: relative; min-height: 36px; padding: 6px 14px; border-radius: 10px; border: 1px solid ${C.hairline};
        background: ${C.glass}; color: #fff; font-size: 13px; font-weight: 600; cursor: pointer; }
    .studio-reset.is-on { background: rgba(22, 101, 52, 0.92); border-color: ${C.brand}; color: #dcfce7; }
    .studio-reset:focus-visible, .studio-x:focus-visible, .studio-preset:focus-visible, .studio-swatch:focus-visible { outline: 2px solid ${C.focus}; outline-offset: 2px; }
    .studio-tip { position: absolute; left: 12px; bottom: 12px; max-width: calc(100% - 24px); padding: 4px 10px; border-radius: 6px; background: rgba(10,10,12,0.6); color: #fff; font-size: 12px; pointer-events: none; }
    .studio-panel { display: flex; flex-direction: column; min-height: 0; background: ${C.bar}; border-left: 1px solid ${C.hairline}; }
    .studio-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 16px 18px 12px; border-bottom: 1px solid ${C.hairline}; }
    .studio-kicker { font-size: 12px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: ${C.accent}; }
    .studio-head h2 { margin: 2px 0 0; font-size: 18px; color: #fff; line-height: 1.25; }
    .studio-x { flex: none; width: 40px; height: 40px; border-radius: 10px; border: 1px solid ${C.hairline}; background: ${C.surface}; color: #fff; font-size: 22px; line-height: 1; cursor: pointer; }
    .studio-body { flex: 1; overflow-y: auto; padding: 6px 18px 18px; display: flex; flex-direction: column; gap: 6px; }
    .studio-body section { display: flex; flex-direction: column; gap: 10px; padding: 12px 0 14px; border-bottom: 1px solid ${C.hairline}; }
    .studio-body section:last-child { border-bottom: 0; }
    .studio-body h3 { margin: 0; font-size: 14px; color: #fff; }
    .studio-field { display: flex; flex-direction: column; gap: 6px; }
    .studio-presets { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .studio-preset { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; padding: 8px; border-radius: ${RADIUS}px; border: 1px solid ${C.border};
        background: ${C.surface}; color: #fff; text-align: left; cursor: pointer; }
    .studio-preset:hover { background: ${C.surfaceHover}; }
    .studio-preset-art { display: flex; flex-direction: column; width: 100%; height: 34px; border-radius: 6px; overflow: hidden; }
    .studio-preset-art span:first-child { flex: 0 0 12px; }
    .studio-preset-art span:last-child { flex: 1; }
    .studio-preset-name { font-size: 13px; font-weight: 600; line-height: 1.25; }
    .studio-preset-hint { font-size: 12px; color: ${C.muted}; }
    .studio-chips { display: flex; flex-wrap: wrap; gap: 6px; }
    .studio-chips button { min-height: 34px; padding: 6px 12px; border-radius: 999px; border: 1px solid ${C.border}; background: ${C.surface};
        color: #fff; font-size: 13px; cursor: pointer; }
    .studio-chips button:hover { background: ${C.surfaceHover}; }
    .studio-chips button[aria-checked="true"] { border-color: ${C.accent}; background: ${C.surfaceHover}; box-shadow: inset 0 0 0 1px ${C.accent}; font-weight: 600; }
    .studio-chips button:focus-visible { outline: 2px solid ${C.focus}; outline-offset: 2px; }
    .studio-swatches { display: flex; flex-wrap: wrap; gap: 8px; }
    .studio-swatch { position: relative; width: 32px; height: 32px; border-radius: 50%; border: 2px solid rgba(255,255,255,0.25); background: var(--sw); cursor: pointer; padding: 0; }
    .studio-swatch[aria-checked="true"] { border-color: #fff; box-shadow: 0 0 0 2px ${C.accent}; }
    .studio-swatch.is-none { background: repeating-linear-gradient(45deg, #3a3a44 0 4px, #24242b 4px 8px); }
    .studio-swatch.is-custom { background: conic-gradient(#ef4444, #f59e0b, #22c55e, #3b82f6, #a855f7, #ef4444); overflow: hidden; }
    .studio-swatch.is-custom::after { content: ''; position: absolute; inset: 7px; border-radius: 50%; background: var(--sw); }
    .studio-swatch.is-custom input { position: absolute; inset: 0; opacity: 0; cursor: pointer; width: 100%; height: 100%; }
    .studio-check { display: flex; align-items: center; gap: 10px; color: #fff; font-size: 14px; cursor: pointer; min-height: 32px; }
    .studio-check input { width: 18px; height: 18px; }
    .studio-note { margin: 0; color: ${C.warning}; }
    .studio-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 12px 18px; border-top: 1px solid ${C.hairline}; flex-wrap: wrap; }
    .studio-history, .studio-actions { display: flex; gap: 8px; }
    .studio-tabs { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; padding: 10px 18px; border-bottom: 1px solid ${C.hairline}; }
    .studio-tabs.has-3 { grid-template-columns: repeat(3, 1fr); }
    .studio-tabs button { min-height: 36px; border-radius: 8px; border: 1px solid ${C.border}; background: ${C.surface}; color: ${C.muted}; font-size: 13px; font-weight: 600; cursor: pointer; }
    .studio-tabs button[aria-selected="true"] { border-color: ${C.accent}; background: ${C.surfaceHover}; color: #fff; }
    .studio-catalog-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
    .studio-catalog-btn { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; padding: 8px 10px; border-radius: 8px; border: 1px solid ${C.border}; background: ${C.surface}; color: #fff; text-align: left; cursor: pointer; }
    .studio-catalog-btn:hover { background: ${C.surfaceHover}; }
    .studio-catalog-btn.is-active { border-color: ${C.accent}; background: ${C.surfaceHover}; box-shadow: inset 0 0 0 1px ${C.accent}; }
    .studio-catalog-name { font-size: 13px; font-weight: 600; }
    .studio-catalog-size { font-size: 11px; color: ${C.muted}; }
    .studio-inspector { background: rgba(255,255,255,0.03); border: 1px solid ${C.border}; border-radius: ${RADIUS}px; padding: 12px !important; margin-top: 8px; }
    .studio-item-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .studio-item-meta { font-size: 12px; color: ${C.muted}; }
    .studio-item-actions { display: flex; gap: 6px; flex-wrap: wrap; }
    .studio-mini-btn { min-height: 30px; padding: 4px 10px; border-radius: 6px; border: 1px solid ${C.border}; background: ${C.surface}; color: #fff; font-size: 12px; font-weight: 600; cursor: pointer; }
    .studio-mini-btn:hover { background: ${C.surfaceHover}; }
    .studio-mini-btn.is-on { border-color: ${C.accent}; background: ${C.accent}; color: #fff; }
    .studio-mini-btn.is-danger { color: #fca5a5; }
    .studio-pos-controls { display: flex; flex-direction: column; gap: 6px; }
    .studio-stepper-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .studio-stepper-label { font-size: 13px; color: #e5e5ea; }
    .studio-stepper { display: inline-flex; align-items: center; gap: 6px; background: ${C.surface}; border: 1px solid ${C.border}; border-radius: 8px; padding: 2px; }
    .studio-stepper button { width: 28px; height: 28px; border: 0; border-radius: 6px; background: transparent; color: #fff; font-size: 15px; cursor: pointer; }
    .studio-stepper button:hover:not(:disabled) { background: ${C.surfaceHover}; }
    .studio-stepper button:disabled { opacity: 0.35; cursor: default; }
    .studio-stepper span { min-width: 54px; text-align: center; font-size: 12px; font-weight: 600; color: #fff; }
    .studio-placed { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
    .studio-placed li { display: flex; align-items: center; gap: 6px; border: 1px solid ${C.border}; border-radius: 8px; padding: 4px 6px; background: ${C.surface}; }
    .studio-placed li.is-selected { border-color: ${C.accent}; background: ${C.surfaceHover}; }
    .studio-placed-pick { flex: 1; display: flex; flex-direction: column; align-items: flex-start; gap: 2px; border: 0; background: transparent; color: #fff; text-align: left; cursor: pointer; padding: 4px; }
    .studio-placed-pick span { font-size: 13px; font-weight: 600; }
    .studio-placed-pick small { font-size: 11px; color: ${C.muted}; }
    .studio-hover-preview { position: fixed; right: 392px; z-index: 4010; width: 156px; padding: 8px; border-radius: ${RADIUS}px;
        background: ${C.bar}; border: 1px solid ${C.border}; box-shadow: 0 10px 28px rgba(0,0,0,0.45); pointer-events: none; display: flex; flex-direction: column; gap: 6px; }
    .studio-hover-canvas { width: 140px; height: 108px; border-radius: 6px; overflow: hidden; background: #1c212b; }
    .studio-hover-meta { display: flex; flex-direction: column; gap: 1px; }
    .studio-hover-meta strong { font-size: 12px; color: #fff; line-height: 1.2; }
    .studio-hover-meta span { font-size: 11px; color: ${C.muted}; }
    @media (pointer: coarse) { .studio-swatch { width: 40px; height: 40px; } .studio-reset { min-height: 44px; } }
    @media (max-width: 820px) {
        .studio { grid-template-columns: 1fr; grid-template-rows: 42vh minmax(0, 1fr); }
        .studio-panel { border-left: 0; border-top: 1px solid ${C.hairline}; }
        .studio-hover-preview { display: none; }
    }
`;
