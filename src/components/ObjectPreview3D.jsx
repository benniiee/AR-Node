import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { C, RADIUS } from '../uiTokens';
import { disposeTree } from './StairPreview3D';
import { buildScene, person } from './RouteModel3D';
import { treeModel, kindLabel } from '../campusObjects';

// ── 3D preview of one campus object (admin: Trees, benches, sheds and gates) ──
// The object where it stands, among the campus as the 3D views draw it (buildings at their real
// height, walkways, the bridge, the other trees, benches and sheds), with a 1.7 m person beside it
// for scale. Rebuilt whenever its size, shape or spot changes. Drag to rotate, wheel or pinch to zoom.
// Scene axes: x = east, y = up, z = -north (as the other 3D views).

const reduceMotion = () => typeof window !== 'undefined'
    && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Height and width of the object in metres, as drawn (a tree's crown as modelled). */
function sizeOf(o) {
    if (o.kind === 'tree') {
        const m = treeModel(o);
        const reach = Math.max(m.crownR, ...m.puffs.map((p) => Math.hypot(m.lean.e + p.e, m.lean.n + p.n) + p.r));
        return { h: m.crownTop, w: reach * 2 };
    }
    return { h: Number(o.height_m) || 2.5, w: Math.max(Number(o.width_m) || 1, Number(o.length_m) || 1) };
}

export default function ObjectPreview3D({ object, objects = [], buildings = [], pathways = [], bridges = [], height = 230 }) {
    const hostRef = useRef(null);
    const stateRef = useRef(null);
    const size = sizeOf(object);
    const key = JSON.stringify([object, objects.length, buildings.length, pathways.length, bridges.length]);

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
        sun.position.set(-30, 60, 40);
        scene.add(sun);
        const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 3000);
        const group = new THREE.Group();
        scene.add(group);
        const s = { renderer, camera, group, raf: 0, dirty: true, az: 0.7, el: 0.26, dist: 30, target: new THREE.Vector3(), userZoomed: false, pointers: new Map(), pinch: 0 };
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
        const loop = () => {
            s.raf = requestAnimationFrame(loop);
            if (!s.dirty) return;
            s.dirty = false;
            place();
            renderer.render(scene, camera);
        };
        loop();

        const el = renderer.domElement;
        const onDown = (ev) => {
            el.setPointerCapture?.(ev.pointerId);
            s.pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
            el.style.cursor = 'grabbing';
            if (s.pointers.size === 2) {
                const [p, q] = [...s.pointers.values()];
                s.pinch = Math.hypot(p.x - q.x, p.y - q.y);
            }
        };
        const onMove = (ev) => {
            const prev = s.pointers.get(ev.pointerId);
            if (!prev) return;
            const cur = { x: ev.clientX, y: ev.clientY };
            if (s.pointers.size === 2) {
                s.pointers.set(ev.pointerId, cur);
                const [p, q] = [...s.pointers.values()];
                const d = Math.hypot(p.x - q.x, p.y - q.y);
                if (s.pinch > 0 && d > 0) { s.dist = Math.min(600, Math.max(4, s.dist * (s.pinch / d))); s.userZoomed = true; }
                s.pinch = d;
            } else {
                s.az -= (cur.x - prev.x) * 0.01;
                s.el = Math.min(1.45, Math.max(0.05, s.el + (cur.y - prev.y) * 0.008));
                s.pointers.set(ev.pointerId, cur);
            }
            s.dirty = true;
        };
        const onUp = (ev) => {
            s.pointers.delete(ev.pointerId);
            s.pinch = 0;
            if (!s.pointers.size) el.style.cursor = 'grab';
        };
        const onWheel = (ev) => {
            ev.preventDefault();
            s.dist = Math.min(600, Math.max(4, s.dist * (1 + ev.deltaY * 0.001)));
            s.userZoomed = true; s.dirty = true;
        };
        el.addEventListener('pointerdown', onDown);
        el.addEventListener('pointermove', onMove);
        el.addEventListener('pointerup', onUp);
        el.addEventListener('pointercancel', onUp);
        el.addEventListener('wheel', onWheel, { passive: false });
        return () => {
            cancelAnimationFrame(s.raf);
            ro?.disconnect();
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
    }, []);

    // The campus around the object, the object itself (from `objects`, which holds the unsaved changes),
    // a green ring round it, and a person beside it for scale.
    useEffect(() => {
        const s = stateRef.current;
        if (!s) return;
        disposeTree(s.group);
        s.group.clear();
        const origin = { lat: +object.latitude, lng: +object.longitude };
        buildScene(s.group, { route: null, buildings, links: [], pathways, bridges, objects, follow: true, origin });
        const r = Math.max(0.8, size.w / 2) + 0.4;
        const ring = new THREE.Mesh(
            new THREE.RingGeometry(r, r + 0.3, 48),
            new THREE.MeshBasicMaterial({ color: 0x22c55e, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false }),
        );
        ring.rotation.x = -Math.PI / 2;
        ring.position.y = 0.04;
        s.group.add(ring);
        s.group.add(person(new THREE.Vector3(r + 1.2, 0, 0), new THREE.Vector3(0, 0, 1)));
        s.target.set(0, Math.min(size.h * 0.45, 12), 0);
        if (!s.userZoomed) s.dist = Math.max(size.h, size.w) * 1.25 + 7;
        s.dirty = true;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key]);

    // A slow quarter turn on first look, so it reads as 3D.
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
        s.az = 0.7; s.el = 0.26; s.userZoomed = false;
        s.dist = Math.max(size.h, size.w) * 1.25 + 7;
        s.dirty = true;
    };

    const label = kindLabel(object.kind);
    return (
        <div className="obj3d" style={{ height }}>
            <div
                ref={hostRef} className="obj3d-host" role="img"
                aria-label={`3D view of the ${label.toLowerCase()} among the campus buildings, with a person for scale. Drag to rotate.`}
            />
            <button type="button" className="obj3d-reset" onClick={reset}>Reset view</button>
            <span className="obj3d-hint" aria-hidden="true">
                {object.kind === 'tree'
                    ? `Tree: ${Number(object.height_m) || '?'} m tall, ${Number(object.width_m) || '?'} m crown`
                    : `${label}: ${size.h.toFixed(1)} m tall`} · person 1.7 m
            </span>
        </div>
    );
}

export const OBJECT_PREVIEW_CSS = `
    .obj3d { position: relative; border-radius: ${RADIUS + 4}px; overflow: hidden; background: ${C.bar}; border: 1px solid ${C.hairline}; }
    .obj3d-host { position: absolute; inset: 0; }
    .obj3d-host[data-nogl] { display: flex; align-items: center; justify-content: center; }
    .obj3d-host[data-nogl]::after { content: '3D preview needs WebGL'; color: ${C.muted}; font-size: 13px; }
    .obj3d-reset { position: absolute; top: 8px; right: 8px; min-height: 32px; padding: 4px 12px; border-radius: 10px;
        border: 1px solid ${C.hairline}; background: ${C.glass}; color: #fff; font-size: 12px; font-weight: 600; cursor: pointer; }
    .obj3d-reset:focus-visible { outline: 2px solid ${C.focus}; outline-offset: 2px; }
    @media (pointer: coarse) { .obj3d-reset { min-height: 44px; } }
    .obj3d-hint { position: absolute; left: 10px; bottom: 8px; padding: 3px 10px; border-radius: 6px; background: rgba(10,10,12,0.6);
        font-size: 12px; color: #fff; pointer-events: none; }
`;
