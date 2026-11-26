import React, { useDeferredValue, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { C, RADIUS } from '../uiTokens';
import { disposeTree } from './StairPreview3D';
import { buildScene } from './RouteModel3D';
import { Segmented } from './MapControls';
import { confirmAction } from './ConfirmDialog';
import { buildingHeightM } from '../sunShadow';
import { polygonCentroid } from '../campusGeometry';
import { toLocalMeters } from '../geo';
import {
    appearanceOf, roofColorOf, ROOF_STYLES, FACADES, ROOF_COLORS, WALL_COLORS, ACCENT_COLORS, STYLE_PRESETS, SIGN_MAX, DEFAULT_WALL,
} from '../buildingAppearance';

// ── Building Studio (Phase 1: outside) ──────────────────────────────
// The building's department dresses it like a city-builder game: its roof, walls, the style of its front
// and its entrance, seen live in 3D where it stands among the campus. Undo / redo every change; nothing
// is saved (or seen by students) until Save. Opened from the building's card on the admin map.

const reduceMotion = () => typeof window !== 'undefined'
    && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** The 3D view: the campus as the 3D views draw it, centred on the building being dressed. Drag to turn, wheel or pinch to zoom. */
function StudioView({ building, buildings, pathways, bridges, objects }) {
    const hostRef = useRef(null);
    const stateRef = useRef(null);
    const key = JSON.stringify([building.appearance, building.id, buildings.length, objects.length]);

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
        const s = { renderer, camera, group, raf: 0, dirty: true, az: 0.6, el: 0.32, dist: 60, fit: 60, target: new THREE.Vector3(), pointers: new Map(), pinch: 0 };
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
            s.pointers.delete(ev.pointerId);
            s.pinch = 0;
            if (!s.pointers.size) el.style.cursor = 'grab';
        };
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
        // A slow half turn on first look, so it reads as 3D.
        let frames = reduceMotion() ? 0 : 90;
        const spin = setInterval(() => {
            if (frames-- <= 0 || s.pointers.size) { clearInterval(spin); return; }
            s.az += 0.012;
            s.dirty = true;
        }, 16);
        return () => {
            clearInterval(spin);
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

    useEffect(() => {
        const s = stateRef.current;
        if (!s) return;
        disposeTree(s.group);
        s.group.clear();
        const c = polygonCentroid(building.polygon) || { lat: +building.polygon[0].lat, lng: +building.polygon[0].lng };
        const others = buildings.filter((b) => b.id !== building.id);
        buildScene(s.group, { route: null, buildings: [building, ...others], links: [], pathways, bridges, objects, follow: true, origin: c });
        const h = buildingHeightM(building);
        const reach = Math.max(...building.polygon.map((p) => Math.hypot(...toLocalMeters(+p.lat, +p.lng, c.lat, c.lng))));
        s.target.set(0, h * 0.45, 0);
        const fit = Math.max(reach * 2.1, h * 2.4) + 8;
        if (s.dist === s.fit) s.dist = fit;
        s.fit = fit;
        s.dirty = true;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key]);

    const reset = () => {
        const s = stateRef.current;
        if (!s) return;
        s.az = 0.6; s.el = 0.32; s.dist = s.fit; s.dirty = true;
    };
    return (
        <div className="studio-view">
            <div ref={hostRef} className="studio-host" role="img" aria-label={`3D view of ${building.name} as it will look, among the campus. Drag to turn it.`} />
            <button type="button" className="studio-reset" onClick={reset}>Reset view</button>
            <span className="studio-tip" aria-hidden="true">Drag to turn · scroll or pinch to zoom</span>
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

export default function BuildingStudio({ building, buildings = [], pathways = [], bridges = [], objects = [], onSave, onClose }) {
    const original = appearanceOf(building);
    const [look, setLook] = useState(original);
    const [past, setPast] = useState([]);
    const [future, setFuture] = useState([]);
    const [saving, setSaving] = useState(false);
    // The 3D view follows a step behind while a colour is being dragged, so the panel stays quick.
    const shown = useDeferredValue(look);
    const dirty = JSON.stringify(look) !== JSON.stringify(original);

    const change = (next) => {
        setPast((p) => [...p.slice(-49), look]);
        setFuture([]);
        setLook(next);
    };
    const patch = (section, values) => change({ ...look, [section]: { ...look[section], ...values } });
    const undo = () => {
        if (!past.length) return;
        setFuture((f) => [look, ...f]);
        setLook(past[past.length - 1]);
        setPast((p) => p.slice(0, -1));
    };
    const redo = () => {
        if (!future.length) return;
        setPast((p) => [...p, look]);
        setLook(future[0]);
        setFuture((f) => f.slice(1));
    };
    const close = async () => {
        if (dirty && !(await confirmAction({
            title: 'Leave without saving?', message: 'Your changes to how the building looks are not saved yet.', confirmLabel: 'Leave', tone: 'danger',
        }))) return;
        onClose();
    };
    const save = async () => {
        setSaving(true);
        try { await onSave(look); } finally { setSaving(false); }
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

    const hasDoors = Array.isArray(building.doors) && building.doors.length > 0;
    return (
        <div className="studio" role="dialog" aria-modal="true" aria-labelledby="studio-title">
            <StudioView building={{ ...building, appearance: shown }} buildings={buildings} pathways={pathways} bridges={bridges} objects={objects} />
            <aside className="studio-panel">
                <header className="studio-head">
                    <div>
                        <span className="studio-kicker">Building Studio</span>
                        <h2 id="studio-title">{building.name}</h2>
                    </div>
                    <button type="button" className="studio-x" onClick={close} aria-label="Close the Building Studio">×</button>
                </header>
                <div className="studio-body">
                    <section aria-labelledby="studio-styles">
                        <h3 id="studio-styles">Styles</h3>
                        <div className="studio-presets">
                            {STYLE_PRESETS.map((p) => {
                                const a = appearanceOf({ appearance: p.appearance });
                                return (
                                    <button
                                        key={p.name} type="button" className="studio-preset"
                                        onClick={() => change({ ...a, entrance: { ...a.entrance, sign: look.entrance.sign } })}
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
                        <Segmented label="Roof shape" value={look.roof.style} onChange={(v) => patch('roof', { style: v })} options={ROOF_STYLES} />
                        <Swatches id="studio-roof-color" label="Roof colour" value={look.roof.color} onChange={(v) => patch('roof', { color: v })} options={ROOF_COLORS} none="Map default" />
                    </section>
                    <section aria-labelledby="studio-walls">
                        <h3 id="studio-walls">Walls</h3>
                        <Swatches id="studio-wall-color" label="Wall colour" value={look.walls.color} onChange={(v) => patch('walls', { color: v })} options={WALL_COLORS} none="Map default" />
                        <Swatches id="studio-accent" label="Accent (floor bands, pillars)" value={look.walls.accent} onChange={(v) => patch('walls', { accent: v })} options={ACCENT_COLORS} none="No accent" />
                        <span className="ui-label">Front</span>
                        <Segmented label="Style of its front" value={look.facade} onChange={(v) => change({ ...look, facade: v })} options={FACADES} />
                    </section>
                    <section aria-labelledby="studio-entrance">
                        <h3 id="studio-entrance">Entrance</h3>
                        {!hasDoors && (
                            <p className="ui-hint studio-note">This building has no doors yet. Add them in Edit building → Doors: the canopy, sign and ramp go at its doors.</p>
                        )}
                        <label className="studio-check">
                            <input type="checkbox" checked={look.entrance.canopy} onChange={(e) => patch('entrance', { canopy: e.target.checked })} />
                            <span>Canopy over the doors</span>
                        </label>
                        {look.entrance.canopy && (
                            <Swatches id="studio-canopy" label="Canopy colour" value={look.entrance.color} onChange={(v) => patch('entrance', { color: v || look.entrance.color })} options={ACCENT_COLORS} />
                        )}
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
    .studio-reset { position: absolute; top: 12px; left: 12px; min-height: 36px; padding: 6px 14px; border-radius: 10px; border: 1px solid ${C.hairline};
        background: ${C.glass}; color: #fff; font-size: 13px; font-weight: 600; cursor: pointer; }
    .studio-reset:focus-visible, .studio-x:focus-visible, .studio-preset:focus-visible, .studio-swatch:focus-visible { outline: 2px solid ${C.focus}; outline-offset: 2px; }
    .studio-tip { position: absolute; left: 12px; bottom: 12px; padding: 4px 10px; border-radius: 6px; background: rgba(10,10,12,0.6); color: #fff; font-size: 12px; pointer-events: none; }
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
    @media (pointer: coarse) { .studio-swatch { width: 40px; height: 40px; } .studio-reset { min-height: 44px; } }
    @media (max-width: 820px) {
        .studio { grid-template-columns: 1fr; grid-template-rows: 42vh minmax(0, 1fr); }
        .studio-panel { border-left: 0; border-top: 1px solid ${C.hairline}; }
    }
`;
