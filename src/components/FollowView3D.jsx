import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { C } from '../uiTokens';
import { buildScene, person } from './RouteModel3D';
import { disposeTree } from './StairPreview3D';

// ── 3D follow view (the 3D screen's "3D" mode) ───────────────────────
// A game-style view between the camera and the flat map: the campus in 3D
// (solid buildings, roads, the route as a white ribbon, the destination pin)
// with you as a walking figure, seen from behind and above at about 45
// degrees. The figure moves with your GPS position and the view turns with
// the way the phone faces, so what is ahead of you is up the screen.
// Drag sideways to look around (it swings back behind you after a few
// seconds); pinch or scroll to zoom.
//
// `getPose()` is read every frame and returns { lat, lng, headingDeg|null }.
// The scene is rebuilt only when the route's stops or the buildings change.
//
// Test walk (`testWalk`): for trying it off campus. GPS is ignored; you start at
// the route's first stop (or where you are, if you are near the route) and walk
// with the on-screen joystick or W A S D / the arrow keys (Shift: faster). The
// figure faces the way it walks and the view swings in behind it. Every move is
// reported through `onTestMove(lat, lng)` so the guidance and route follow.

const FOLLOW_DIST = 11; // metres from you to the camera
const PITCH = 0.5; // ~29 degrees down: low behind you, the figure in clear view
const LOOK_AHEAD = 7; // metres ahead of you the view centres on
const WALK_SPEED = 1.4; // m/s of a normal walk: full stride at this speed
const STRIDE = 1.5; // metres per full step cycle (two steps)
/** Shadows are drawn within this many metres of you. */
const SHADOW_REACH_M = 70;
const SNAP_BACK_MS = 5000; // a manual turn swings back behind you after this
const TEST_WALK_MS = 1.6; // test walk: walking pace at full joystick (m/s)
const TEST_RUN_FACTOR = 2.5; // Shift on a keyboard
const TEST_NEAR_ROUTE_M = 60; // nearer than this to the first stop: start where you are
const MOVE_KEYS = new Set(['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'shift']);

// Pointer capture can throw (a touch that already ended): never let it break input.
const capture = (el, id) => { try { el?.setPointerCapture?.(id); } catch { /* pointer gone */ } };

const shortestTurn = (from, to) => {
    let d = (to - from) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return d;
};

export default function FollowView3D({
    route, buildings, links, pathways, bridges = [], nodes = [], getPose, routeKey, floor = 0,
    testWalk = false, onTestMove = null, joyBottom = 120,
}) {
    const hostRef = useRef(null);
    const sceneRef = useRef(null);
    // The latest route, floor and test-walk state, read by the frame loop without rebuilding the scene.
    const liveRef = useRef({ route, floor, testWalk, onTestMove });
    liveRef.current = { route, floor, testWalk, onTestMove };

    // Renderer, camera and the frame loop: made once.
    useEffect(() => {
        const host = hostRef.current;
        if (!host) return undefined;
        let renderer;
        try {
            renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
        } catch {
            host.setAttribute('data-nogl', '1');
            return undefined;
        }
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer.setClearColor(0x14151a, 1);
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        renderer.domElement.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;';
        host.appendChild(renderer.domElement);

        const scene = new THREE.Scene();
        // Distance haze, so the far campus fades instead of ending at an edge.
        scene.fog = new THREE.Fog(0x14151a, 90, 320);
        // Soft light from the sky, a darker bounce from the ground, and one sun that casts shadows:
        // walls facing away from it go darker, so buildings read as solid shapes, not flat grey.
        scene.add(new THREE.HemisphereLight(0xdfe7ff, 0x2a2b31, 1.1));
        const sun = new THREE.DirectionalLight(0xfff4e0, 1.7);
        sun.castShadow = true;
        sun.shadow.mapSize.set(1024, 1024);
        // The shadow box follows you (see the frame loop): sharp nearby, none wasted on the far campus.
        Object.assign(sun.shadow.camera, { left: -SHADOW_REACH_M, right: SHADOW_REACH_M, top: SHADOW_REACH_M, bottom: -SHADOW_REACH_M, near: 1, far: 260 });
        sun.shadow.bias = -0.0004;
        sun.shadow.normalBias = 0.06;
        scene.add(sun, sun.target);
        const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 2000);
        const world = new THREE.Group();
        scene.add(world);
        const me = person(new THREE.Vector3(), new THREE.Vector3(0, 0, -1));
        me.traverse((o) => { if (o.isMesh && o.material.isMeshStandardMaterial) o.castShadow = true; });
        scene.add(me);
        // The live piece of route from you to the next stop (same white ribbon
        // with a dark edge as the rest), re-aimed every frame as you walk.
        const leadEdge = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 1, 10, 1, true), new THREE.MeshBasicMaterial({ color: 0x16161b, side: THREE.BackSide }));
        const leadCore = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 1, 10, 1, true), new THREE.MeshBasicMaterial({ color: 0xffffff }));
        const lead = new THREE.Group();
        lead.add(leadEdge, leadCore);
        lead.visible = false;
        scene.add(lead);
        const UP = new THREE.Vector3(0, 1, 0);
        const from = new THREE.Vector3();
        const to = new THREE.Vector3();

        const s = {
            world, me, xz: null, routePts: [], stops: new Map(), raf: 0,
            pos: null, yaw: 0, viewYaw: null, manualAt: 0, manualYaw: 0, zoom: 1,
            // Walk cycle: phase of the stride and how much of a walk (0 = standing).
            phase: 0, walk: 0, speed: 0,
            pointers: new Map(), pinch: 0,
            // Test walk: joystick ({x, y} in -1..1, y up = forward), keys held,
            // the walked position as lat/lng (kept across scene rebuilds), and
            // when it was last reported.
            joy: { x: 0, y: 0 }, keys: new Set(), toLatLng: null, testLL: null, testOn: false, reportedAt: 0,
        };
        sceneRef.current = s;

        const resize = () => {
            const w = Math.max(1, host.clientWidth);
            const h = Math.max(1, host.clientHeight);
            renderer.setSize(w, h, false);
            camera.aspect = w / h;
            camera.updateProjectionMatrix();
        };
        const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
        ro?.observe(host);
        resize();

        // Height under you: the ground, or on an upper floor the height of the
        // nearest stop ON THAT FLOOR (never a stop on another floor nearby).
        const groundY = (p) => {
            const f = liveRef.current.floor || 0;
            if (f <= 0) return 0;
            let best = null;
            let bestD = 40;
            for (const q of s.stops.values()) {
                if (q.floor !== f) continue;
                const d = Math.hypot(q.x - p.x, q.z - p.z);
                if (d < bestD) { bestD = d; best = q; }
            }
            return best ? Math.max(0, best.y - 0.25) : 0;
        };
        // The next stop of the CURRENT route: the first one after "you".
        const nextStop = () => {
            const path = liveRef.current.route?.path || [];
            for (const q of path) {
                if (q.type === 'user' || q.id == null) continue;
                return s.stops.get(String(q.id)) || null;
            }
            return null;
        };

        let last = 0;
        const loop = (now = 0) => {
            s.raf = requestAnimationFrame(loop);
            const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
            last = now;
            const live = liveRef.current;
            if (live.testWalk && !s.testOn) {
                // Start of a test walk: from where you are if you are near the
                // route, otherwise at its first stop (friends off campus).
                s.testOn = true;
                const first = nextStop();
                const far = !s.pos || (first && Math.hypot(s.pos.x - first.x, s.pos.z - first.z) > TEST_NEAR_ROUTE_M);
                if (s.pos && far && first) {
                    s.pos = new THREE.Vector3(first.x, Math.max(0, first.y - 0.25), first.z);
                    s.viewYaw = null;
                }
            } else if (!live.testWalk && s.testOn) {
                s.testOn = false;
                s.testLL = null;
                s.joy = { x: 0, y: 0 };
                s.keys.clear();
            }
            // Walking from the first frame (a computer opens 3D mode walking): the scene and route may not be
            // ready yet, so keep trying until you can be placed, at your position if it is known.
            if (live.testWalk && !s.pos && s.xz) {
                const here = getPose?.();
                const first = nextStop();
                if (here && Number.isFinite(here.lat) && Number.isFinite(here.lng)) {
                    const t = s.xz(here.lat, here.lng);
                    s.pos = new THREE.Vector3(t.x, 0, t.z);
                    s.pos.y = groundY(s.pos);
                    if (Number.isFinite(here.headingDeg)) s.yaw = -here.headingDeg * Math.PI / 180;
                } else if (first) {
                    s.pos = new THREE.Vector3(first.x, Math.max(0, first.y - 0.25), first.z);
                }
            }
            const pose = live.testWalk ? null : getPose?.();
            if (live.testWalk && s.pos) {
                // Walk relative to the view: up = away from the camera.
                let fwd = s.joy.y;
                let side = s.joy.x;
                if (s.keys.has('w') || s.keys.has('arrowup')) fwd += 1;
                if (s.keys.has('s') || s.keys.has('arrowdown')) fwd -= 1;
                if (s.keys.has('d') || s.keys.has('arrowright')) side += 1;
                if (s.keys.has('a') || s.keys.has('arrowleft')) side -= 1;
                const mag = Math.min(1, Math.hypot(fwd, side));
                const vy = s.viewYaw ?? s.yaw;
                // Forward and right on the ground for the current view.
                const fx = -Math.sin(vy); const fz = -Math.cos(vy);
                const rx = Math.cos(vy); const rz = -Math.sin(vy);
                let mx = fx * fwd + rx * side;
                let mz = fz * fwd + rz * side;
                const len = Math.hypot(mx, mz);
                const pace = TEST_WALK_MS * (s.keys.has('shift') ? TEST_RUN_FACTOR : 1);
                if (len > 0.05) {
                    mx /= len; mz /= len;
                    const step = pace * mag * dt;
                    s.pos.x += mx * step;
                    s.pos.z += mz * step;
                    s.pos.y = groundY(s.pos);
                    // Face the way you walk.
                    const want = Math.atan2(-mx, -mz);
                    s.yaw += shortestTurn(s.yaw, want) * (1 - Math.exp(-dt * 8));
                }
                const v = len > 0.05 ? pace * mag : 0;
                s.speed += (v - s.speed) * (1 - Math.exp(-dt * 8));
                if (s.toLatLng) {
                    const ll = s.toLatLng(s.pos.x, s.pos.z);
                    s.testLL = { lat: ll.latitude, lng: ll.longitude };
                    // Report a few times a second (the route and guidance follow).
                    if (now - s.reportedAt > 150) {
                        s.reportedAt = now;
                        // With the figure's facing (compass degrees; yaw = -heading, as for the GPS pose below).
                        const facingDeg = ((((-s.yaw * 180) / Math.PI) % 360) + 360) % 360;
                        live.onTestMove?.(s.testLL.lat, s.testLL.lng, facingDeg);
                    }
                }
            } else if (s.xz && pose && Number.isFinite(pose.lat) && Number.isFinite(pose.lng)) {
                const t = s.xz(pose.lat, pose.lng);
                const target = new THREE.Vector3(t.x, 0, t.z);
                target.y = groundY(target);
                // Glide to each new fix instead of jumping; the glide's speed drives the walk.
                if (!s.pos) s.pos = target.clone();
                else {
                    const before = s.pos.clone();
                    s.pos.lerp(target, 1 - Math.exp(-dt * 6));
                    const moved = Math.hypot(s.pos.x - before.x, s.pos.z - before.z);
                    if (dt > 0) s.speed += (moved / dt - s.speed) * (1 - Math.exp(-dt * 4));
                }
                if (Number.isFinite(pose.headingDeg)) {
                    // Compass 0 = north = -z; the figure faces its heading.
                    const want = -pose.headingDeg * Math.PI / 180;
                    s.yaw += shortestTurn(s.yaw, want) * (1 - Math.exp(-dt * 5));
                }
            }
            // The live piece of route: from your feet to the next stop.
            const next = s.pos ? nextStop() : null;
            if (next) {
                from.set(s.pos.x, s.pos.y + 0.25, s.pos.z);
                to.set(next.x, next.y, next.z);
                const len = from.distanceTo(to);
                lead.visible = len > 0.3;
                if (lead.visible) {
                    lead.position.copy(from).add(to).multiplyScalar(0.5);
                    lead.scale.set(1, len, 1);
                    lead.quaternion.setFromUnitVectors(UP, to.clone().sub(from).normalize());
                }
            } else {
                lead.visible = false;
            }
            if (s.pos) {
                s.me.position.copy(s.pos);
                sun.position.set(s.pos.x - 45, 90, s.pos.z + 55);
                sun.target.position.copy(s.pos);
                s.me.rotation.y = s.yaw + Math.PI;
                // Walk animation: legs and arms swing in turn, the body bobs, all
                // scaled by speed (standing still eases back to rest; GPS jitter
                // under 0.2 m/s does not count as walking).
                const want = Math.min(1, Math.max(0, (s.speed - 0.2) / (WALK_SPEED - 0.2)));
                s.walk += (want - s.walk) * (1 - Math.exp(-dt * 5));
                s.phase += (Math.max(s.speed, 0.6 * s.walk) / STRIDE) * Math.PI * 2 * dt;
                const rig = s.me.userData.rig;
                if (rig) {
                    const swing = Math.sin(s.phase) * 0.55 * s.walk;
                    rig.legL.rotation.x = swing;
                    rig.legR.rotation.x = -swing;
                    rig.armL.rotation.x = -swing * 0.8;
                    rig.armR.rotation.x = swing * 0.8;
                    rig.torso.position.y = Math.abs(Math.cos(s.phase)) * 0.05 * s.walk;
                    rig.torso.rotation.y = Math.sin(s.phase) * 0.06 * s.walk;
                }
                // The view follows your heading, or your own drag for a few seconds.
                const manual = now - s.manualAt < SNAP_BACK_MS;
                const wantView = manual ? s.manualYaw : s.yaw;
                if (s.viewYaw === null) s.viewYaw = wantView;
                s.viewYaw += shortestTurn(s.viewYaw, wantView) * (1 - Math.exp(-dt * (manual ? 12 : 3)));
                const dist = FOLLOW_DIST * s.zoom;
                const back = new THREE.Vector3(Math.sin(s.viewYaw), 0, Math.cos(s.viewYaw));
                camera.position.set(
                    s.pos.x + back.x * dist * Math.cos(PITCH),
                    s.pos.y + dist * Math.sin(PITCH) + 1,
                    s.pos.z + back.z * dist * Math.cos(PITCH),
                );
                // Look a little ahead of you, so more of the way forward is on screen.
                camera.lookAt(s.pos.x - back.x * LOOK_AHEAD, s.pos.y, s.pos.z - back.z * LOOK_AHEAD);
            }
            renderer.render(scene, camera);
        };
        loop();

        const el = renderer.domElement;
        const onDown = (ev) => {
            capture(el, ev.pointerId);
            s.pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
            if (s.pointers.size === 2) { const [p, q] = [...s.pointers.values()]; s.pinch = Math.hypot(p.x - q.x, p.y - q.y); }
        };
        const onMove = (ev) => {
            const prev = s.pointers.get(ev.pointerId);
            if (!prev) return;
            const cur = { x: ev.clientX, y: ev.clientY };
            s.pointers.set(ev.pointerId, cur);
            if (s.pointers.size === 2) {
                const [p, q] = [...s.pointers.values()];
                const d = Math.hypot(p.x - q.x, p.y - q.y);
                if (s.pinch > 0 && d > 0) s.zoom = Math.min(4, Math.max(0.4, s.zoom * (s.pinch / d)));
                s.pinch = d;
                return;
            }
            if (s.manualAt === 0 || performance.now() - s.manualAt > SNAP_BACK_MS) s.manualYaw = s.viewYaw ?? s.yaw;
            s.manualYaw -= (cur.x - prev.x) * 0.008;
            s.manualAt = performance.now();
        };
        const onUp = (ev) => { s.pointers.delete(ev.pointerId); s.pinch = 0; };
        const onWheel = (ev) => { ev.preventDefault(); s.zoom = Math.min(4, Math.max(0.4, s.zoom * (1 + ev.deltaY * 0.001))); };
        el.addEventListener('pointerdown', onDown);
        el.addEventListener('pointermove', onMove);
        el.addEventListener('pointerup', onUp);
        el.addEventListener('pointercancel', onUp);
        el.addEventListener('wheel', onWheel, { passive: false });
        const typing = (ev) => /^(INPUT|TEXTAREA|SELECT)$/.test(ev.target?.tagName || '');
        const onKeyDown = (ev) => {
            const k = ev.key.toLowerCase();
            if (!liveRef.current.testWalk || !MOVE_KEYS.has(k) || typing(ev)) return;
            if (k !== 'shift') ev.preventDefault();
            s.keys.add(k);
        };
        const onKeyUp = (ev) => s.keys.delete(ev.key.toLowerCase());
        const onBlur = () => s.keys.clear();
        window.addEventListener('keydown', onKeyDown);
        window.addEventListener('keyup', onKeyUp);
        window.addEventListener('blur', onBlur);

        return () => {
            cancelAnimationFrame(s.raf);
            ro?.disconnect();
            el.removeEventListener('pointerdown', onDown);
            el.removeEventListener('pointermove', onMove);
            el.removeEventListener('pointerup', onUp);
            el.removeEventListener('pointercancel', onUp);
            el.removeEventListener('wheel', onWheel);
            window.removeEventListener('keydown', onKeyDown);
            window.removeEventListener('keyup', onKeyUp);
            window.removeEventListener('blur', onBlur);
            disposeTree(scene);
            renderer.dispose();
            renderer.forceContextLoss?.();
            if (el.parentNode === host) host.removeChild(el);
            sceneRef.current = null;
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // The campus and the route: rebuilt when the stops or the buildings change
    // (not on every GPS fix: the figure moves on its own).
    useEffect(() => {
        const s = sceneRef.current;
        if (!s) return;
        disposeTree(s.world);
        s.world.clear();
        const built = buildScene(s.world, { route, buildings, links, pathways, bridges, nodes, follow: true });
        // Solid things cast and catch shadows; the ground and see-through walls only catch them.
        s.world.traverse((o) => {
            if (!o.isMesh || !o.material.isMeshStandardMaterial) return;
            o.receiveShadow = true;
            o.castShadow = !o.material.transparent && o.geometry.type !== 'CircleGeometry';
        });
        s.xz = built.xz || null;
        s.toLatLng = built.toLatLng || null;
        s.routePts = built.routePts || [];
        s.stops = built.stops || new Map();
        if (s.testOn && s.testLL && s.xz) {
            // Test walk: stay exactly where you walked to in the new scene.
            const t = s.xz(s.testLL.lat, s.testLL.lng);
            s.pos = new THREE.Vector3(t.x, 0, t.z);
        } else {
            // A new origin: start again from the next fix.
            s.pos = null;
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [routeKey, buildings, bridges]);

    // Test walk joystick (touch and mouse): push the knob the way to walk.
    const joyRef = useRef(null);
    const [knob, setKnob] = useState({ x: 0, y: 0 });
    const joyMove = (ev) => {
        const box = joyRef.current?.getBoundingClientRect();
        const s = sceneRef.current;
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
        const s = sceneRef.current;
        if (s) s.joy = { x: 0, y: 0 };
        setKnob({ x: 0, y: 0 });
    };

    return (
        <div style={{ position: 'absolute', inset: 0 }}>
            <style>{FOLLOW_CSS}</style>
            <div
                ref={hostRef}
                className="ar-follow3d"
                role="img"
                aria-label="3D view of the campus around you and your route. Drag to look around, pinch to zoom."
                style={{ position: 'absolute', inset: 0, background: '#14151a', color: C.muted }}
            />
            {testWalk && (
                <div
                    ref={joyRef} className="fv-joy" role="slider" aria-label="Test walk: push to walk"
                    aria-valuetext={knob.x || knob.y ? 'Walking' : 'Standing'}
                    style={{ bottom: joyBottom }}
                    onPointerDown={(e) => { e.stopPropagation(); capture(e.currentTarget, e.pointerId); joyMove(e); }}
                    onPointerMove={(e) => { if (e.buttons || e.pointerType === 'touch') joyMove(e); }}
                    onPointerUp={joyEnd} onPointerCancel={joyEnd} onLostPointerCapture={joyEnd}
                >
                    <span className="fv-joy-knob" style={{ transform: `translate(${knob.x * 34}px, ${knob.y * 34}px)` }} />
                </div>
            )}
        </div>
    );
}

const FOLLOW_CSS = `
    /* Test walk joystick: bottom-left, above the guidance card and the dock. */
    .fv-joy { position: absolute; z-index: 4; left: max(16px, env(safe-area-inset-left)); width: 112px; height: 112px;
        border-radius: 50%; touch-action: none; display: grid; place-items: center;
        background: rgba(10, 10, 12, 0.55); border: 1px solid rgba(255, 255, 255, 0.22);
        -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px); cursor: grab; }
    .fv-joy-knob { width: 46px; height: 46px; border-radius: 50%; background: #fff; box-shadow: 0 2px 10px rgba(0, 0, 0, 0.45);
        transition: transform 80ms linear; pointer-events: none; }
    @media (prefers-reduced-motion: reduce) { .fv-joy-knob { transition: none; } }
`;
