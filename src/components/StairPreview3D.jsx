import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { C, RADIUS } from '../uiTokens';

// ── 3D staircase preview ─────────────────────────────────────────────
// Draws a staircase plan (see stairGeometry.js → planStairs) as a small
// orbitable 3D scene: solid steps, flat landings, the walking line with one
// arrow, a floor at each end (labelled), and a compass ring where the
// direction is being set.
//
// Drag to rotate, wheel or pinch to zoom, "Reset view" to start over.
// Scene axes: x = east, y = up, z = -north (north points into the screen).

// Steps in the staircase amber used on the map; white walking line; floors
// grey (start) and green (arrive).
const STEP = 0xffb02e;
const STEP_LIGHT = 0xffc65c;
const EDGE = 0x7a4500;

const reduceMotion = () => typeof window !== 'undefined'
    && window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Small glyphs drawn in front of a label's text: a building (building names) or a map pin (the destination).
function drawIcon(g, kind, x, cy, size, color) {
    g.save();
    g.fillStyle = color;
    g.strokeStyle = color;
    if (kind === 'building') {
        const w = size * 0.78; const h = size * 0.86;
        const left = x + (size - w) / 2; const top = cy - h / 2;
        g.fillRect(left, top, w, h);
        // Windows (3 x 3) and a door cut out of the block.
        g.globalCompositeOperation = 'destination-out';
        const cw = w / 7; const ch = h / 9;
        for (let r = 0; r < 3; r += 1) {
            for (let c = 0; c < 3; c += 1) g.fillRect(left + cw * (1 + c * 2), top + ch * (1 + r * 2), cw, ch);
        }
        g.fillRect(left + w / 2 - cw * 0.75, top + h - ch * 1.6, cw * 1.5, ch * 1.6);
    } else if (kind === 'pin') {
        const r = size * 0.32;
        const px = x + size / 2; const py = cy - size * 0.12;
        g.beginPath();
        g.arc(px, py, r, Math.PI * 0.85, Math.PI * 2.15);
        g.lineTo(px, cy + size * 0.48);
        g.closePath();
        g.fill();
        g.globalCompositeOperation = 'destination-out';
        g.beginPath(); g.arc(px, py, r * 0.42, 0, Math.PI * 2); g.fill();
    }
    g.restore();
}

/**
 * A text label for the 3D views (stairs, route, follow view): a rounded pill with a soft shadow, an
 * optional border and an optional icon ('building' | 'pin'). Its width fits the text. `scale` is the
 * width a short label gets (the pill is scale/4 tall); sprite.userData.aspect and .heightFactor let a
 * screen-sized label keep the pill's true proportions (RouteModel3D screenLabel).
 */
export function makeLabel(text, { bg = '#ffffff', fg = '#0a0a0c', scale = 1.7, icon = null, border = null } = {}) {
    const k = 2;                       // drawn at double resolution: crisp text on phones
    const H = 72 * k;                  // pill height
    const pad = 26 * k; const gap = 12 * k; const iconSize = 36 * k; const margin = 14 * k;
    const font = `700 ${32 * k}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    const measure = document.createElement('canvas').getContext('2d');
    measure.font = font;
    const textW = Math.ceil(measure.measureText(String(text)).width);
    const pillW = Math.max(H * 1.6, pad * 2 + textW + (icon ? iconSize + gap : 0));

    const canvas = document.createElement('canvas');
    canvas.width = pillW + margin * 2;
    canvas.height = H + margin * 2;
    const g = canvas.getContext('2d');
    const x0 = margin; const y0 = margin * 0.7; // a little more room below for the shadow
    const r = H / 2;
    const pill = () => {
        g.beginPath();
        g.moveTo(x0 + r, y0); g.lineTo(x0 + pillW - r, y0);
        g.arc(x0 + pillW - r, y0 + r, r, -Math.PI / 2, Math.PI / 2);
        g.lineTo(x0 + r, y0 + H);
        g.arc(x0 + r, y0 + r, r, Math.PI / 2, Math.PI * 1.5);
        g.closePath();
    };
    // Soft drop shadow lifts the label off the scene behind it.
    g.save();
    g.shadowColor = 'rgba(0, 0, 0, 0.45)';
    g.shadowBlur = 10 * k;
    g.shadowOffsetY = 3 * k;
    g.fillStyle = bg;
    pill();
    g.fill();
    g.restore();
    if (border) {
        g.lineWidth = 3 * k;
        g.strokeStyle = border;
        pill();
        g.stroke();
    }
    let tx = x0 + pillW / 2;
    if (icon) {
        const contentW = iconSize + gap + textW;
        const ix = x0 + (pillW - contentW) / 2;
        drawIcon(g, icon, ix, y0 + H / 2, iconSize, fg);
        tx = ix + iconSize + gap + textW / 2;
    }
    g.fillStyle = fg;
    g.font = font;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(String(text), tx, y0 + H / 2 + 2 * k);

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    // No fog or tone mapping: a label keeps its real colours at any distance.
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, fog: false, toneMapped: false });
    const sprite = new THREE.Sprite(mat);
    const heightFactor = canvas.height / H;
    const aspect = canvas.width / canvas.height;
    const pillH = scale * 0.25;
    sprite.scale.set(pillH * heightFactor * aspect, pillH * heightFactor, 1);
    sprite.userData.aspect = aspect;
    sprite.userData.heightFactor = heightFactor;
    sprite.renderOrder = 10;
    return sprite;
}

const toScene = (p) => new THREE.Vector3(p.e, p.u, -p.n);
const yawToTheta = (yawDeg) => Math.PI - (yawDeg * Math.PI) / 180;

function tube(a, b, radius, material) {
    const dir = new THREE.Vector3().subVectors(b, a);
    const len = Math.max(dir.length(), 0.001);
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, len, 6), material);
    mesh.position.copy(a).addScaledVector(dir, 0.5);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    return mesh;
}

export function disposeTree(root) {
    root.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
            const mats = Array.isArray(o.material) ? o.material : [o.material];
            mats.forEach((m) => { if (m.map) m.map.dispose(); m.dispose(); });
        }
    });
}

/** Fill `group` with the 3D staircase. Returns the point the camera orbits and its radius.
 *  Kept plain on purpose: the steps (same amber as on the map), the walking
 *  line over them with one arrow for the direction, and a floor at each end
 *  labelled with its real name. The compass (N) only where the direction is
 *  being set (the admin's staircase editor). */
function buildScene(group, plan, direction, { lowerLabel = 'Lower floor', upperLabel = 'Upper floor', compass = true } = {}) {
    const down = direction === 'down';
    const stepMat = new THREE.MeshLambertMaterial({ color: STEP });
    const landMat = new THREE.MeshLambertMaterial({ color: STEP_LIGHT });
    const edgeMat = new THREE.LineBasicMaterial({ color: EDGE, transparent: true, opacity: 0.6 });
    const lineMat = new THREE.MeshBasicMaterial({ color: 0xffffff });

    for (const seg of plan.segments) {
        if (seg.kind === 'flight') {
            const theta = yawToTheta(seg.yawDeg);
            const dirE = Math.sin((seg.yawDeg * Math.PI) / 180);
            const dirN = Math.cos((seg.yawDeg * Math.PI) / 180);
            const depth = seg.run / seg.steps;
            for (let i = 0; i < seg.steps; i += 1) {
                const top = seg.from.u + (seg.rise * (i + 1)) / seg.steps;
                const h = Math.max(0.06, top);
                const geo = new THREE.BoxGeometry(plan.widthM, h, depth * 0.98);
                const t = (i + 0.5) / seg.steps;
                const box = new THREE.Mesh(geo, stepMat);
                box.position.set(seg.from.e + dirE * seg.run * t, h / 2, -(seg.from.n + dirN * seg.run * t));
                box.rotation.y = theta;
                group.add(box);
                const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), edgeMat);
                edges.position.copy(box.position); edges.rotation.y = theta;
                group.add(edges);
            }
        } else {
            const h = Math.max(0.14, seg.center.u);
            const geo = new THREE.BoxGeometry(seg.width, h, seg.depth);
            const box = new THREE.Mesh(geo, landMat);
            box.position.set(seg.center.e, h / 2, -seg.center.n);
            box.rotation.y = yawToTheta(seg.yawDeg);
            group.add(box);
            const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), edgeMat);
            edges.position.copy(box.position); edges.rotation.y = box.rotation.y;
            group.add(edges);
        }
    }

    // The walking line, just above the steps, with one arrow at its far end.
    const pts = [new THREE.Vector3(0, 0.12, 0)];
    for (const seg of plan.segments) {
        if (seg.kind === 'flight') { pts.push(toScene(seg.from).add(new THREE.Vector3(0, 0.12, 0))); pts.push(toScene(seg.to).add(new THREE.Vector3(0, 0.12, 0))); }
        else pts.push(toScene(seg.center).add(new THREE.Vector3(0, 0.12, 0)));
    }
    if (down) pts.reverse();
    for (let i = 1; i < pts.length; i += 1) {
        if (pts[i].distanceTo(pts[i - 1]) > 0.01) group.add(tube(pts[i - 1], pts[i], 0.06, lineMat));
    }
    const tip = pts[pts.length - 1];
    const prev = pts[pts.length - 2] || tip;
    const dir = new THREE.Vector3().subVectors(tip, prev).normalize();
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.55, 16), lineMat);
    cone.position.copy(tip).addScaledVector(dir, 0.2);
    cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    group.add(cone);

    // A floor at each end: grey where you start, green where you arrive.
    const first = plan.segments.find((x) => x.kind === 'flight');
    const last = [...plan.segments].reverse().find((x) => x.kind === 'flight');
    const fwd = (yawDeg, d) => ({ e: Math.sin((yawDeg * Math.PI) / 180) * d, n: Math.cos((yawDeg * Math.PI) / 180) * d });
    const pad = (centre, yawDeg, y, arriving) => {
        const geo = new THREE.BoxGeometry(plan.widthM + 1.6, 0.05, 2.4);
        const m = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({
            color: arriving ? 0x22c55e : 0x8a8f98, transparent: true, opacity: arriving ? 0.6 : 0.5,
        }));
        m.position.set(centre.e, y - 0.025, -centre.n);
        m.rotation.y = yawToTheta(yawDeg);
        group.add(m);
        return m.position;
    };
    const behind = fwd(first.yawDeg, -1.4);
    const ahead = fwd(last.yawDeg, 1.4);
    const lowPos = pad({ e: first.from.e + behind.e, n: first.from.n + behind.n }, first.yawDeg, 0, down);
    const highPos = pad({ e: last.to.e + ahead.e, n: last.to.n + ahead.n }, last.yawDeg, plan.rise, !down);
    const low = makeLabel(lowerLabel, { bg: down ? '#4ade80' : '#ffffff', scale: 1.9 });
    low.position.set(lowPos.x, 0.6, lowPos.z);
    const high = makeLabel(upperLabel, { bg: down ? '#ffffff' : '#4ade80', scale: 1.9 });
    high.position.set(highPos.x, plan.rise + 0.6, highPos.z);
    group.add(low, high);

    const b = plan.bounds;
    const cx = (b.minE + b.maxE) / 2;
    const cn = (b.minN + b.maxN) / 2;
    const radius = Math.max(3.2, Math.hypot(b.maxE - b.minE, b.maxN - b.minN) / 2 + 1.2);
    if (compass) {
        const ring = new THREE.Mesh(
            new THREE.RingGeometry(radius - 0.03, radius, 64),
            new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.2, side: THREE.DoubleSide }),
        );
        ring.rotation.x = -Math.PI / 2;
        ring.position.set(cx, -0.02, -cn);
        group.add(ring);
        const north = makeLabel('N', { bg: '#ffffff', scale: 0.9 });
        north.position.set(cx, 0.35, -(cn + radius));
        group.add(north);
    }

    return {
        target: new THREE.Vector3(cx, plan.rise / 2, -cn),
        radius: Math.max(radius, plan.rise) + 1,
    };
}

export default function StairPreview3D({
    plan, direction = 'up', height = 210, autoRotate = false, ariaLabel, className = '',
    lowerLabel = 'Lower floor', upperLabel = 'Upper floor', compass = true,
}) {
    const hostRef = useRef(null);
    const stateRef = useRef(null);
    const key = JSON.stringify([plan.yawDeg, plan.rise, plan.flights, plan.landingM, direction, lowerLabel, upperLabel, compass]);

    // one renderer for the life of the component
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
        sun.position.set(4, 9, 6);
        scene.add(sun);
        const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);
        const group = new THREE.Group();
        scene.add(group);

        const s = {
            renderer, scene, camera, group,
            az: 0.55, el: 0.7, dist: 10, target: new THREE.Vector3(),
            userZoomed: false, spin: autoRotate && !reduceMotion(), raf: 0, dirty: true, dragging: false,
            pointers: new Map(), pinch: 0,
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
        s.place = place;

        const resize = () => {
            const w = Math.max(1, host.clientWidth);
            const h = Math.max(1, host.clientHeight);
            renderer.setSize(w, h, false);
            camera.aspect = w / h;
            camera.updateProjectionMatrix();
            s.dirty = true;
        };
        const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
        ro?.observe(host);
        resize();

        const loop = () => {
            s.raf = requestAnimationFrame(loop);
            if (s.spin && !s.dragging) { s.az += 0.004; s.dirty = true; }
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
            s.dragging = true; s.spin = false;
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
                if (s.pinch > 0 && d > 0) { s.dist = Math.min(40, Math.max(3, s.dist * (s.pinch / d))); s.userZoomed = true; }
                s.pinch = d;
            } else {
                s.az -= (cur.x - prev.x) * 0.01;
                s.el = Math.min(1.45, Math.max(0.12, s.el + (cur.y - prev.y) * 0.008));
                s.pointers.set(ev.pointerId, cur);
            }
            s.dirty = true;
        };
        const onUp = (ev) => {
            s.pointers.delete(ev.pointerId);
            s.pinch = 0;
            if (s.pointers.size === 0) { s.dragging = false; el.style.cursor = 'grab'; }
        };
        const onWheel = (ev) => {
            ev.preventDefault();
            s.dist = Math.min(40, Math.max(3, s.dist * (1 + ev.deltaY * 0.001)));
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
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // rebuild the geometry only when the staircase actually changed
    useEffect(() => {
        const s = stateRef.current;
        if (!s) return;
        disposeTree(s.group);
        s.group.clear();
        const { target, radius } = buildScene(s.group, plan, direction, { lowerLabel, upperLabel, compass });
        s.target.copy(target);
        if (!s.userZoomed) s.dist = radius * 2.3 + 2;
        s.dirty = true;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key]);

    const reset = () => {
        const s = stateRef.current;
        if (!s) return;
        s.az = 0.55; s.el = 0.7; s.userZoomed = false;
        const { radius } = { radius: Math.max(3.2, plan.rise) + 1 };
        s.dist = radius * 2.3 + 2;
        s.dirty = true;
    };

    return (
        <div className={`stair3d ${className}`} style={{ height }}>
            <div ref={hostRef} className="stair3d-host" role="img" aria-label={ariaLabel || 'Interactive 3D view of the staircase. Drag to rotate.'} />
            <button type="button" className="stair3d-reset" onClick={reset}>Reset view</button>
            <span className="stair3d-hint" aria-hidden="true">Drag to rotate · pinch to zoom</span>
        </div>
    );
}

export const STAIR_PREVIEW_CSS = `
    .stair3d { position: relative; border-radius: ${RADIUS + 4}px; overflow: hidden;
        background: ${C.bar}; border: 1px solid ${C.hairline}; }
    .stair3d-host { position: absolute; inset: 0; }
    .stair3d-host[data-nogl] { display: flex; align-items: center; justify-content: center; }
    .stair3d-host[data-nogl]::after { content: '3D preview needs WebGL'; color: ${C.muted}; font-size: 13px; }
    .stair3d-reset { position: absolute; top: 8px; right: 8px; min-height: 44px; padding: 4px 14px; border-radius: 10px;
        border: 1px solid ${C.hairline}; background: ${C.glass}; color: #fff; font-size: 12px; font-weight: 600; cursor: pointer; }
    .stair3d-hint { position: absolute; left: 10px; bottom: 8px; font-size: 12px; color: ${C.muted}; pointer-events: none; }
`;
