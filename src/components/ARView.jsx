import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import L from 'leaflet';
import { createDestinationPinIcon } from '../mapIcons';
import { SmoothPoint, SmoothAngle, createPovIcon, paintPovRotation } from '../povMotion';
import { APP_TAG } from '../mobileApi';
import { createTileLayer, campusLatLngBounds, lockToCampus, CAMPUS_CENTER, CAMPUS_MAP_LOCK, GPS_HIDDEN_LAYERS, GPS_FLAVOR, ROUTE_CASING } from '../campusMap';
import { drawBuildings, drawPathways, bindLabelZoom } from '../campusLayers';
import { sunPosition, STOREY_M } from '../sunShadow';
import FollowView3D from './FollowView3D';
import { useSatelliteLayer } from '../useSatellite';
import { createBuildingLayer, AR_GROUND_Y } from '../arBuildings';
import {
    bearingAndDistance, norm180, clamp, buildYouText, easeK, orientRate,
    ROUTE_COLOR, MAX_ROUTE_SPHERES, splitRemaining,
    responsiveScale, createSpherePool,
    anchorENU, deviceOrientationToQuaternion, enuToLatLon,
    genericSensorToCameraQuaternion, azimuthDegOfQuaternion, applyYawOffset,
} from '../arMath';
// The line-connection visual (glowing tube + marching chevrons + destination
// hologram + pulse halo), recoloured black/white/green.
// This is now the only thing that draws the route connector — the pixel-width
// Line2 ribbon that used to run underneath it has been dropped.
import {
    createHoloPath, createDestinationPin, createGroundRoad,
    trimPathStart, HOLO, HOLO_MIN_START,
} from '../holoRibbon';
import { createNavArrowPool, nodeArrowFade } from '../navArrow';
// Heading maths lives in one module shared with the 2D screen's POV cone so
// the two views can never disagree about which way the phone points.
import { headingFromOrientationEvent as toHeading, headingAccuracyFromEvent, createCompassWatcher } from '../heading';
import { effectiveVerticalFov, getLongSideFovDeg } from '../cameraFov';
import { createOffscreenArrow } from '../offscreenArrow';
import { buildWallSegments, isOccluded } from '../wallOcclusion';
// Design tokens lifted from the 2D screen (MobileNav) — the 3D view must
// look and feel like the same product.
import { C, RADIUS, TYPE, FONT_STACK, TAP, btnBase, HUD_CSS, PANEL_RADIUS, PILL, ELEVATION, INTERACTION_CSS } from '../uiTokens';
// Floor helpers shared with the 2D map so both views agree on what "floor 0"
// means and how a missing value is treated.
import { floorAria, floorOf, floorTag } from '../floors';
import { planStairs, landingTurns, turnPhrase } from '../stairGeometry';
import { formatDistance, formatWalkTime, guidanceFor } from '../routeFormat';
import { createVoiceGuide, hush, say, speechAvailable } from '../voiceGuidance';
import { advanceAlongRoute } from '../routeProgress';

/** Off-screen cue stays hidden while the stop's node arrow is below this fade (0..1). */
const OFFARROW_NEAR_FADE = 0.5;

// ── Docked 2D mini-map ──────────────────────────────────────────────
// Responsive heights: the old fixed 230px strip ate ~40% of a phone screen
// once the guidance card stacked above it. Phones get a compact strip
// capped to ~22% of viewport height; tablets/desktops keep the full strip.
// Card chrome (padding + header + gap) adds ~52px on top of the viewport.
const MINI_MAP_H_DESKTOP = 210;
const MINI_MAP_H_TABLET = 150;
const MINI_MAP_H_PHONE = 128;
const MINI_CHROME = 52;
/** Height the bottom-centre control dock takes (button row + gap), so panels sit above it. */
const DOCK_LIFT = 64;
/** Floor of the stage's bottom safe area, shared by the dock and the panels above it. */
const SAFE_BOTTOM = 'max(8px, env(safe-area-inset-bottom))';
const responsiveMiniMapHeight = () => {
    if (typeof window === 'undefined') return MINI_MAP_H_DESKTOP;
    const w = window.innerWidth || 400;
    const h = window.innerHeight || 700;
    const base = w <= 480 ? MINI_MAP_H_PHONE : w <= 900 ? MINI_MAP_H_TABLET : MINI_MAP_H_DESKTOP;
    // Never let the strip alone exceed ~24% of viewport height.
    return Math.max(96, Math.min(base, Math.floor(h * 0.24)));
};

// Mini-map markers mirror the main 2D screen: white "you" dot with a white
// halo, green destination pin. divIcons only, so Leaflet's bundler image fix
// is never needed here.
const MINI_USER_ICON = L.divIcon({
    className: '',
    html: `<div style="width:14px;height:14px;border-radius:50%;background:#fff;border:2px solid #fff;box-shadow:0 0 0 3px rgba(34, 197, 94,0.42),0 2px 8px rgba(0,0,0,0.6);"></div>`,
    iconSize: [14, 14],
    iconAnchor: [7, 7],
});
const MINI_DEST_ICON = createDestinationPinIcon(C.go, 14);
// POV wedge: the same ~70° field-of-view cone the main 2D screen lays over
// the you-are-here dot (map never rotates — north stays up). The rotation
// lives on the inner element so it never fights Leaflet's own transform.
// Centre-anchored at (48,48) so it pivots exactly on the user's position.
const MINI_POV_ICON = createPovIcon();
// Relative-direction arrow: an up-arrow pinned on the user dot, rotated by
// the signed angle from the camera facing to the nearest node (0° = ahead).
// White chevron in a white ring so it reads over dark tiles at any zoom.
const MINI_DIR_ICON = L.divIcon({
    className: '',
    html: '<div class="dir-rot" style="width:34px;height:34px;transform:rotate(0deg);transition:transform 0.2s linear;pointer-events:none;">'
        + '<svg width="34" height="34" viewBox="0 0 34 34" aria-hidden="true">'
        + '<circle cx="17" cy="17" r="13" fill="rgba(12,12,16,0.85)" stroke="#ffffff" stroke-width="2"/>'
        + '<path d="M17 8 L23 19 L17 16 L11 19 Z" fill="#fff"/>'
        + '</svg></div>',
    iconSize: [34, 34],
    iconAnchor: [17, 17],
});

// ── Marker sizing / placement ───────────────────────────────────────
// Dots render at a constant screen size (responsiveScale) times this radius,
// so shrinking the radius shrinks every dot equally. The destination stays a
// little bigger than the route dots so "the end" still reads at a glance.
const NODE_RADIUS = 0.4;
/** Radius of the 3D destination pin head (world metres). */
const DEST_RADIUS = 0.6;
// Eye-height offset: markers are drawn below the camera's eye line so they
// sit under the horizon instead of floating dead-centre of the view.
const NODE_Y_DROP = -1.3;
/** The AR road starts this far ahead of the camera (metres): just beyond your feet. */
const ROAD_START_M = 1;

// ── Staircases in 3D ─────────────────────────────────────────────────
// A staircase joins two nodes on DIFFERENT floors, and the walker only ever
// sees one floor's nodes, so the incline between them used to exist only as
// a number. This draws it: a flight of steps leaving (or arriving at) the
// stair node, tilted by the admin's angle, with a flat reference line, an arc
// and a degree label at its low end so the slope can be read at a glance.
// Stairs that bend (L-shaped, U-shaped switchbacks, long stairs with a rest
// landing) are drawn as every flight plus the flat landing between them and a
// floor arrow on each landing that says which way to turn, all oriented by the
// staircase's yaw (see stairGeometry.js).
const STAIR_COLOR = 0xffb02e;
const STAIR_WIDTH_M = 1.4;
const STAIR_RISER_M = 0.18;

function makeStairLabel(text) {
    const canvas = document.createElement('canvas');
    canvas.width = 320; canvas.height = 80;
    const g = canvas.getContext('2d');
    g.fillStyle = '#ffb02e';
    const r = 40;
    g.beginPath();
    g.moveTo(r, 4); g.lineTo(320 - r, 4); g.arc(320 - r, 40, 36, -Math.PI / 2, Math.PI / 2);
    g.lineTo(r, 76); g.arc(r, 40, 36, Math.PI / 2, Math.PI * 1.5); g.closePath();
    g.fill();
    g.fillStyle = '#1a1200';
    g.font = '700 34px system-ui, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(text, 160, 42);
    const tex = new THREE.CanvasTexture(canvas);
    // Depth-tested so a building wall in front hides it (arBuildings occluders).
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: true, depthWrite: false, fog: false });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(2.6, 0.65, 1);
    sprite.renderOrder = 5;
    return sprite;
}

function tubeBetween(a, b, radius, material) {
    const dir = new THREE.Vector3().subVectors(b, a);
    const len = dir.length();
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, Math.max(len, 0.001), 6), material);
    mesh.position.copy(a).addScaledVector(dir, 0.5);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    return mesh;
}

function createStairViz() {
    const group = new THREE.Group();
    group.visible = false;
    let lastKey = '';

    const clear = () => {
        group.traverse((o) => {
            if (o.geometry) o.geometry.dispose();
            if (o.material) {
                if (o.material.map) o.material.map.dispose();
                o.material.dispose();
            }
        });
        group.clear();
    };

    /** flight: { x, y, z, dx, dz, run, dy, angle, label } — starts at (x,y,z),
     *  runs `run` metres along the horizontal unit vector (dx,dz) and rises
     *  `dy` metres (negative = descends). */
    const addFlight = (f) => {
        const d = new THREE.Vector3(f.dx, 0, f.dz).normalize();
        const side = new THREE.Vector3(-d.z, 0, d.x);
        const p0 = new THREE.Vector3(f.x, f.y, f.z);
        const p1 = new THREE.Vector3(f.x + d.x * f.run, f.y + f.dy, f.z + d.z * f.run);
        const baseY = Math.min(p0.y, p1.y);
        const rise = Math.abs(f.dy);
        const n = Math.max(3, Math.round(rise / STAIR_RISER_M));
        const depth = f.run / n;
        const theta = Math.atan2(d.x, d.z);

        const fillMat = new THREE.MeshBasicMaterial({ color: STAIR_COLOR, transparent: true, opacity: 0.2, depthWrite: false });
        const edgeMat = new THREE.LineBasicMaterial({ color: STAIR_COLOR, transparent: true, opacity: 0.95 });
        for (let i = 0; i < n; i += 1) {
            const tread = p0.y + (f.dy * (i + 1)) / n;
            const h = Math.max(0.05, tread - baseY);
            const geo = new THREE.BoxGeometry(STAIR_WIDTH_M, h, depth * 0.96);
            const box = new THREE.Mesh(geo, fillMat);
            const t = (i + 0.5) / n;
            box.position.set(p0.x + d.x * f.run * t, baseY + h / 2, p0.z + d.z * f.run * t);
            box.rotation.y = theta;
            box.renderOrder = 2;
            group.add(box);
            const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), edgeMat);
            edges.position.copy(box.position);
            edges.rotation.y = theta;
            edges.renderOrder = 3;
            group.add(edges);
        }

        // Two rails along the slope itself: the line whose tilt IS the angle.
        const railMat = new THREE.MeshBasicMaterial({ color: STAIR_COLOR, fog: false });
        for (const sgn of [-1, 1]) {
            const off = side.clone().multiplyScalar((sgn * STAIR_WIDTH_M) / 2);
            const rail = tubeBetween(p0.clone().add(off), p1.clone().add(off), 0.045, railMat);
            rail.renderOrder = 4;
            group.add(rail);
        }

        if (f.gauge === false) return;
        // Angle gauge at the LOW end: flat reference line + arc + label.
        const lowIsStart = f.dy >= 0;
        const low = lowIsStart ? p0 : p1;
        const h = lowIsStart ? d.clone() : d.clone().negate();
        const refLen = Math.min(2.4, Math.max(1.2, f.run * 0.6));
        const refMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7, fog: false });
        group.add(tubeBetween(low, low.clone().addScaledVector(h, refLen), 0.025, refMat));
        const a = (f.angle * Math.PI) / 180;
        const arcR = refLen * 0.75;
        const pts = [];
        for (let k = 0; k <= 16; k += 1) {
            const t = (a * k) / 16;
            pts.push(low.clone().addScaledVector(h, arcR * Math.cos(t)).add(new THREE.Vector3(0, arcR * Math.sin(t), 0)));
        }
        const arc = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 24, 0.04, 6, false),
            new THREE.MeshBasicMaterial({ color: STAIR_COLOR, fog: false }));
        arc.renderOrder = 4;
        group.add(arc);

        const label = makeStairLabel(f.label);
        const mid = a / 2;
        label.position.copy(low)
            .addScaledVector(h, (arcR + 0.9) * Math.cos(mid))
            .add(new THREE.Vector3(0, (arcR + 0.9) * Math.sin(mid) + 0.3, 0));
        group.add(label);
    };

    /** landing: { kind:'landing', x, y, z (centre), yawDeg, depth, width, arrow:{dx,dz}, label }
     *  A flat slab between two flights plus a floor arrow showing where to go next. */
    const addLanding = (l) => {
        const theta = Math.PI - (l.yawDeg * Math.PI) / 180;
        const fillMat = new THREE.MeshBasicMaterial({ color: STAIR_COLOR, transparent: true, opacity: 0.32, depthWrite: false });
        const edgeMat = new THREE.LineBasicMaterial({ color: STAIR_COLOR, transparent: true, opacity: 0.95 });
        const geo = new THREE.BoxGeometry(l.width, 0.12, l.depth);
        const slab = new THREE.Mesh(geo, fillMat);
        slab.position.set(l.x, l.y - 0.06, l.z);
        slab.rotation.y = theta;
        slab.renderOrder = 2;
        group.add(slab);
        const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), edgeMat);
        edges.position.copy(slab.position);
        edges.rotation.y = theta;
        edges.renderOrder = 3;
        group.add(edges);

        // Turn arrow lying flat on the landing, pointing the way you walk next.
        const shape = new THREE.Shape();
        const pts = [[0, 0.5], [0.45, -0.05], [0.15, -0.05], [0.15, -0.5], [-0.15, -0.5], [-0.15, -0.05], [-0.45, -0.05]];
        pts.forEach(([x, y], i) => (i === 0 ? shape.moveTo(x * 0.9, y * 0.9) : shape.lineTo(x * 0.9, y * 0.9)));
        shape.closePath();
        const arrow = new THREE.Mesh(
            new THREE.ShapeGeometry(shape),
            new THREE.MeshBasicMaterial({ color: STAIR_COLOR, transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthWrite: false, fog: false }),
        );
        arrow.rotation.x = -Math.PI / 2;
        arrow.renderOrder = 4;
        const pivot = new THREE.Group();
        pivot.add(arrow);
        pivot.position.set(l.x, l.y + 0.03, l.z);
        pivot.rotation.y = Math.atan2(-l.arrow.dx, -l.arrow.dz);
        group.add(pivot);

        if (l.label) {
            const label = makeStairLabel(l.label);
            label.scale.set(2.1, 0.52, 1);
            label.position.set(l.x, l.y + 1.1, l.z);
            group.add(label);
        }
    };

    return {
        group,
        /** Rebuild only when the flights actually changed. */
        sync(flights, key) {
            if (key === lastKey) return;
            lastKey = key;
            clear();
            flights.forEach((f) => (f.kind === 'landing' ? addLanding(f) : addFlight(f)));
            group.visible = flights.length > 0;
        },
        dispose() { clear(); },
    };
}
// Paint order for what draws the route: dust (-5) → tube (-4) → chevrons and
// pin (-3) → node markers (0). Set by holoRibbon itself.

// ── Camera smoothing (time-based: the same feel at every frame rate) ──
/** GPS position easing time constant (s): hides jitter, no visible lag. */
const POS_EASE_TAU = 0.04;

// ── Free-roam movement ──────────────────────────────────────────────
// Desktop uses WASD + mouse look; touch screens and phone-sized windows use
// one-finger drag look (walking is WASD wherever a keyboard exists). The walked camera is still converted back into a
// latitude/longitude fix each frame, so route/HUD/minimap state stays aligned.
//
// Demo/presentation tuning: brisk walk, a much faster sprint, and a lift so
// a presenter can pull back and show the whole constellation at once.
const FREE_ROAM_WALK = 3.0; // m/s — brisk walking pace
const FREE_ROAM_SPRINT = 12.0; // m/s — hold Shift to cover the campus
const FREE_ROAM_LIFT = 4.0; // m/s — Space rises, C drops
const FREE_ROAM_LOOK = 0.0022; // radians of yaw/pitch per pixel of mouse
const FREE_ROAM_PITCH_MAX = Math.PI / 3; // ±60° — enough to find the dots, never flips
const FREE_ROAM_HEIGHT_MAX = 60; // m — keeps the camera inside the far plane's comfort zone
// Eye level is y = 0 and the route markers sit at NODE_Y_DROP (-1.3), so the
// floor has to be just under the markers — otherwise C can never take the
// camera down to the line it is supposed to inspect.
const FREE_ROAM_HEIGHT_MIN = -2;
// Scratch rotation for the free-roam path. Module-scope so the render loop
// never allocates.
const _freeEuler = new THREE.Euler();

// Compact "which keys are currently down" for the debug heartbeat — the one
// input state a screenshot of the scene cannot reveal.
const keysHeld = (k) => {
    const s = `${k.w ? 'W' : ''}${k.a ? 'A' : ''}${k.s ? 'S' : ''}${k.d ? 'D' : ''}`
        + `${k.space ? '␣' : ''}${k.c ? 'C' : ''}${k.shift ? '⇧' : ''}`;
    return s || 'none';
};

// 3D view — back to basics.
//
// Kept: the live GPS fix of the current user, and the math that turns node
// coordinates into world positions (drawn as dots over the camera feed).
//
// Deliberately NOT here any more: compass calibration, heading bias,
// hold-still settle gates, first-sample validation (GPS smoothing and walkway
// snapping now live upstream, in MobileNav's GpsPipeline),
// route/guide ribbons, destination cards, always-on HUD panels and the
// WebXR path. Every value the sensors and the Geolocation API hand us is
// used exactly as reported, so what you see can be compared 1:1 with the
// 2D map. All chrome reuses the 2D screen's tokens (uiTokens.js) so the two screens stay visually
// identical — reach for an existing pattern before inventing a new one.
export default function ARView({
    nodes, borders, route, userLocation, floor, floors, onFloorChange, onExit, onWalkedPosition,
    // Labelled buildings + pathways for the mini-map, and "CCS · Floor 2 of 4"
    // for the destination (both from /map; optional so older callers work).
    buildings = [], pathways = [], destPlace = '',
    // Bridge decks for the 3D follow view (from /map).
    bridges = [],
    // Staircase links, for the steps in the 3D follow view.
    links = [],
    // Satellite settings owned by /map (same device setting); null = no control.
    satellite = null,
}) {
    /* ── Shared button interaction styles (.mbtn from the 2D screen) ──
       Plus the HUD language shared with the 2D screen (HUD_CSS): glass
       panels, wide-tracked telemetry labels and the green glow accent. */
    const arBtnStyle = `
        .ar-btn {
            ${btnBase}
            cursor: pointer;
        }
        .ar-btn:hover { filter: brightness(1.12); }
        .ar-btn:active { transform: scale(${TAP.activeScale}); }
        .ar-btn:focus-visible { outline: ${TAP.focusOutline}; outline-offset: 2px; }
        .ar-btn:disabled { opacity: ${TAP.disabledOpacity}; cursor: not-allowed; transform: none !important; }
        .ar-btn-primary {
            background: ${C.primary}; color: ${C.white}; border: none;
        }
        .ar-btn-primary:hover { background: ${C.primaryHover}; }
        .ar-btn-primary:active { background: ${C.primaryPress}; }
        .ar-btn-ghost {
            background: rgba(255, 255, 255, 0.06); color: ${C.white};
            border: 1px solid rgba(255, 255, 255, 0.14);
            backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
        }
        .ar-btn-ghost:hover { background: rgba(255, 255, 255, 0.12); }
        .ar-btn-warn { background: ${C.primary}; color: ${C.white}; border: none; }
        .ar-btn-warn:hover { background: ${C.primaryHover}; }

        /* Floating glass HUD card (top bar, ☰ sheet, bottom card). */
        .ar-panel {
            background: ${C.glass};
            -webkit-backdrop-filter: blur(18px) saturate(140%);
            backdrop-filter: blur(18px) saturate(140%);
            border: 1px solid rgba(255, 255, 255, 0.08);
            border-radius: ${PANEL_RADIUS}px;
            box-shadow: ${ELEVATION.overlay};
        }
        /* Top card: one row. Menu, where you are going (name, then building and
           floor in quiet type), the floor switch at the end. */
        .ar-dest { font-size: ${TYPE.sub}; font-weight: 700; line-height: 1.3; color: ${C.white}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .ar-dest-sub { margin-top: 1px; font-size: ${TYPE.desc}; line-height: 1.3; color: ${C.muted}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .ar-dest-text { flex: 1 1 140px; min-width: 0; }
        /* Floor switch: the same segmented control as Camera | Map. */
        .ar-floor-seg { flex: none; margin-left: auto; }
        .ar-floor-seg > button { min-width: 40px; min-height: 40px; padding: 0 10px; font-size: 13px; font-weight: 800; font-variant-numeric: tabular-nums; }
        /* Guidance card: the turn as an arrow, the instruction, one quiet line of numbers. */
        .ar-step { display: flex; align-items: center; gap: 12px; }
        .ar-step-icon { flex: none; width: 36px; height: 36px; display: grid; place-items: center; color: ${C.white}; }
        .ar-step-icon svg { transition: transform 0.25s var(--ease-out, ease); }
        .ar-step-icon .ar-step-check { display: none; }
        .ar-step-icon[data-state="arrived"] .ar-step-arrow { display: none; }
        .ar-step-icon[data-state="arrived"] .ar-step-check { display: block; color: ${C.accent}; }
        .ar-step-icon[data-state="none"] { display: none; }
        .ar-step-text { min-width: 0; flex: 1; }
        .ar-guide-stats {
            display: flex; flex-wrap: wrap; gap: 2px 14px; margin-top: 8px; padding-top: 8px;
            border-top: 1px solid rgba(255,255,255,0.08);
            font-size: ${TYPE.desc}; line-height: 1.4; color: ${C.muted}; font-variant-numeric: tabular-nums;
        }
        .ar-guide-stats b { color: ${C.white}; font-weight: 700; }
        /* Spoken directions on/off: a quiet pill at the end of the numbers row. */
        .ar-voice-btn {
            margin-left: auto; display: inline-flex; align-items: center; gap: 6px; min-height: ${TAP.minHeight};
            padding: 0 12px; border-radius: ${PILL}px; border: 1px solid rgba(255,255,255,0.14); background: transparent;
            color: ${C.muted}; font: inherit; font-size: ${TYPE.desc}; font-weight: 700; cursor: pointer;
        }
        .ar-voice-btn:hover { color: ${C.white}; background: rgba(255,255,255,0.06); }
        .ar-voice-btn:focus-visible { outline: ${TAP.focusOutline}; outline-offset: 2px; }
        .ar-voice-btn.is-on { color: ${C.white}; border-color: ${C.accent}; }
        .ar-guide-stats { align-items: center; }
        @media (prefers-reduced-motion: reduce) { .ar-step-icon svg { transition: none; } }
        .ar-route { display: flex; gap: 10px; align-items: baseline; margin-top: 1px; font-size: ${TYPE.desc}; color: ${C.muted}; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; }
        .ar-route > span:last-child { overflow: hidden; text-overflow: ellipsis; min-width: 0; }
        .ar-route b { color: ${C.white}; font-weight: 700; }
        /* Nearest-stop chip: the distance is the value, the turn is the label.
           Two aligned spans read as one unit and never rely on a dot separator. */
        .ar-guide-chip { display: flex; align-items: center; gap: 8px; min-height: 36px; padding: 0 16px; }
        .ar-guide-dist {
            font-size: 15px; font-weight: 700; color: ${C.white};
            font-variant-numeric: tabular-nums; white-space: nowrap;
        }
        .ar-guide-turn {
            font-size: ${TYPE.desc}; font-weight: 800; letter-spacing: 0.08em;
            text-transform: uppercase; color: ${C.muted}; white-space: nowrap;
        }
        /* Floor picker inside the top card: same chip language as the 2D
           map's elevator panel, one size down to fit the HUD. */
        .ar-floor-row { display: flex; align-items: center; gap: 4px; margin-top: 7px; overflow-x: auto; scrollbar-width: none; }
        .ar-floor-row::-webkit-scrollbar { display: none; }
        .ar-floor-label { flex: none; margin-right: 4px; font-size: ${TYPE.desc}; font-weight: 700; letter-spacing: 0.02em; color: ${C.muted}; }
        .ar-stair-hint { display: flex; align-items: center; gap: 8px; margin-top: 8px; padding-top: 8px; border-top: 1px solid rgba(255,255,255,0.08); font-size: 13px; font-weight: 600; color: ${C.text}; pointer-events: none; }
        .ar-stair-arrow { display: inline-block; flex: none; font-size: 18px; line-height: 1; color: ${C.warning}; }
        .ar-floor-chip {
            flex: 0 0 auto; min-width: ${TAP.minHeight}; height: ${TAP.minHeight}; padding: 0 10px;
            display: grid; place-items: center;
            border-radius: 8px; border: 1px solid transparent;
            background: rgba(255, 255, 255, 0.05); color: ${C.muted};
            font-family: inherit; font-size: 12px; font-weight: 800;
            font-variant-numeric: tabular-nums; letter-spacing: 0.02em;
            cursor: pointer; touch-action: manipulation;
            transition: color 160ms ease, background-color 160ms ease, border-color 160ms ease;
        }
        .ar-floor-chip:hover { color: ${C.white}; background: rgba(255, 255, 255, 0.10); }
        .ar-floor-chip:active { transform: scale(${TAP.activeScale}); }
        .ar-floor-chip:focus-visible { outline: ${TAP.focusOutline}; outline-offset: 2px; }
        .ar-floor-chip.is-active { color: ${C.white}; background: ${C.primary}; border-color: rgba(74, 222, 128, 0.75); }
        .ar-spin { width: 14px; height: 14px; flex: none; border-radius: 50%; border: 2px solid rgba(255, 255, 255, 0.35); border-top-color: #fff; animation: ar-spin 0.7s linear infinite; }
        @keyframes ar-spin { to { transform: rotate(360deg); } }
        /* Sheet row: a .mbtn stretched to the sheet width, label left / state right. */
        .ar-menu-row {
            width: 100%; padding: 11px 12px; border-radius: ${RADIUS + 2}px;
            border: 1px solid rgba(255, 255, 255, 0.09); background: rgba(255, 255, 255, 0.05);
            color: ${C.white};
            font-size: ${TYPE.sub}; font-weight: 600; text-align: left;
            display: flex; align-items: center; justify-content: space-between; gap: 8px;
        }
        .ar-menu-row:hover { background: rgba(255, 255, 255, 0.10); }
        /* A row that is switched ON lights up the way an active chip does. */
        .ar-menu-row[aria-pressed="true"] {
            background: rgba(34, 197, 94, 0.16);
            border-color: rgba(34, 197, 94, 0.55);
        }
        /* Big mono readout under a telemetry label (bottom card). */
        .ar-readout {
            font-family: ${FONT_STACK};
            font-variant-numeric: tabular-nums;
            font-weight: 700; color: ${C.accent};
        }
        /* Mount transitions: sheets and cards ease in on open (transform and
           opacity only — GPU-cheap). Closes unmount instantly; the entry
           motion carries the feedback. */
        @keyframes ar-in {
            from { opacity: 0; transform: translateY(-10px) scale(0.98); }
            to { opacity: 1; transform: none; }
        }
        .anim-in { animation: ar-in 0.28s cubic-bezier(0.16, 1, 0.3, 1); }

        .ar-dest-place { color: ${C.muted}; font-weight: 600; }

        /* Guidance card: the instruction is the headline, numbers sit under it. */
        .ar-instr { min-height: 52px; }
        .ar-instr-main { font-size: ${TYPE.title}; font-weight: 800; letter-spacing: -0.01em; line-height: 1.2; color: ${C.white}; text-wrap: balance; }
        .ar-instr-sub { margin-top: 3px; font-size: ${TYPE.sub}; line-height: 1.4; color: ${C.text}; min-height: 20px; }
        .ar-guide-rule { height: 1px; margin: 10px 0 9px; background: rgba(255,255,255,0.10); }
        .ar-guidance.is-short .ar-guide-stats { margin-top: 4px; padding-top: 0; border-top: 0; }
        /* Portrait: the guidance card spans the bottom, so the map credit (a licence
           requirement) sits under the zoom buttons instead of beneath the card. */
        .ar-miniwrap.credit-top .leaflet-bottom.leaflet-right {
            top: calc(var(--ar-map-top, 84px) + 96px); bottom: auto; right: auto; left: max(10px, env(safe-area-inset-left)); margin-bottom: 0;
        }
        /* Phone on its side: the guidance sits bottom-right, so the map credit moves bottom-left. */
        @media (max-height: 520px) and (orientation: landscape) {
            .ar-miniwrap.is-full .leaflet-bottom.leaflet-right { right: auto; left: 0; }
        }
        .ar-guidance.is-short .ar-instr-main { font-size: 17px; }
        .ar-guidance.is-short .ar-instr-sub { min-height: 0; }
        .ar-guide-metrics { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
        .ar-guide-value { font-size: ${TYPE.lead}; line-height: 1.2; min-height: 20px; }
        .ar-guide-note { font-size: ${TYPE.desc}; color: ${C.muted}; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .ar-tech { margin-top: 10px; padding-top: 8px; border-top: 1px dashed rgba(255,255,255,0.14); }
        .ar-tech-lines { font-size: ${TYPE.desc}; line-height: 1.45; color: ${C.muted}; white-space: pre-line; font-variant-numeric: tabular-nums; }
        .ar-tech-lines + .ar-tech-lines { margin-top: 6px; }

        .ar-dock-exit { color: ${C.danger}; }

        /* Arrival card: rises over the view; the mark draws itself once. */
        .ar-arrive {
            position: absolute; inset: 0; z-index: 9; display: flex; align-items: flex-end; justify-content: center;
            padding: 16px 12px max(20px, env(safe-area-inset-bottom)); background: rgba(6, 6, 8, 0.42);
            animation: ar-fade var(--dur-base, 260ms) var(--ease-out, ease) both;
        }
        .ar-arrive-card {
            width: min(380px, 100%); padding: 22px 18px 16px; text-align: center; color: ${C.white};
            animation: ar-arrive-in var(--dur-slow, 420ms) var(--ease-out, ease) 60ms both;
        }
        .ar-arrive-mark { width: 52px; height: 52px; color: ${C.accent}; }
        .ar-arrive-mark circle { stroke-dasharray: 140; stroke-dashoffset: 140; animation: ar-draw 0.6s var(--ease-out, ease) 0.2s forwards; }
        .ar-arrive-mark path { stroke-dasharray: 40; stroke-dashoffset: 40; animation: ar-draw 0.4s var(--ease-out, ease) 0.6s forwards; }
        .ar-arrive-title { margin: 8px 0 0; font-size: ${TYPE.title}; font-weight: 800; letter-spacing: -0.01em; }
        .ar-arrive-place { margin: 4px 0 0; font-size: ${TYPE.sub}; color: ${C.text}; }
        .ar-arrive-actions { display: flex; gap: 8px; margin-top: 16px; }
        .ar-arrive-btn { flex: 1; min-height: 48px; border-radius: ${PILL}px; font-size: ${TYPE.sub}; font-weight: 700; }
        @keyframes ar-arrive-in { from { opacity: 0; transform: translateY(24px) scale(0.97); } }
        @keyframes ar-draw { to { stroke-dashoffset: 0; } }
        @media (prefers-reduced-motion: reduce) {
            .ar-arrive, .ar-arrive-card { animation: none; }
            .ar-arrive-mark circle, .ar-arrive-mark path { animation: none; stroke-dashoffset: 0; }
        }

        /* Notices over the camera: same shape as the /map notices, status
           colour language for the tone, sliding in from the top bar. */
        .ar-notice {
            position: absolute; z-index: 3; left: 10px;
            display: flex; flex-direction: column; gap: 8px;
            padding: 10px 12px; border-radius: ${PANEL_RADIUS}px;
            font-size: ${TYPE.sub}; line-height: 1.45;
            -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px);
            animation: ar-notice-in 0.26s cubic-bezier(0.16, 1, 0.3, 1) both;
        }
        .ar-notice.is-attention { background: rgba(43, 28, 6, 0.9); color: ${C.warning}; border: 1px solid rgba(255, 159, 26, 0.55); }
        .ar-notice.is-error { background: rgba(43, 10, 14, 0.94); color: ${C.danger}; border: 1px solid rgba(255, 35, 56, 0.55); }
        .ar-notice-btn { align-self: flex-start; min-height: ${TAP.minHeight}; padding: 0 18px; border-radius: ${PILL}px; font-size: ${TYPE.sub}; font-weight: 700; }
        @keyframes ar-notice-in { from { opacity: 0; transform: translateY(-8px); } }

        /* Free-roam look hint and crosshair. */
        .ar-look-hint {
            position: absolute; z-index: 3; left: 50%; top: 50%; transform: translate(-50%, -50%);
            pointer-events: none; max-width: min(320px, calc(100vw - 40px));
            padding: 10px 14px; border-radius: ${RADIUS}px; background: rgba(0,0,0,0.62);
            color: ${C.white}; font-size: ${TYPE.sub}; font-weight: 600; text-align: center;
            animation: ar-fade 0.3s ease both;
        }
        .ar-look-hint small { display: block; margin-top: 3px; font-size: ${TYPE.desc}; font-weight: 400; color: ${C.muted}; }
        .ar-crosshair {
            position: absolute; left: 50%; top: 50%; width: 14px; height: 14px; margin: -7px 0 0 -7px;
            border-radius: 50%; border: 2px solid ${C.white}; box-shadow: 0 0 3px rgba(0,0,0,0.8); pointer-events: none;
        }

        /* Start card: what this is, where it goes, how to walk safely, go. */
        .ar-start {
            position: absolute; z-index: 4; inset: 0; display: flex; align-items: center; justify-content: center;
            padding: 24px 16px max(24px, env(safe-area-inset-bottom)); background: rgba(6,6,8,0.96);
            animation: ar-fade 0.3s ease both;
        }
        .ar-start-card {
            width: 100%; max-width: 360px; padding: 22px 18px 18px; color: ${C.white}; text-align: center;
            animation: ar-in 0.42s cubic-bezier(0.16, 1, 0.3, 1) 0.05s both;
        }
        .ar-start-title { margin: 0; font-size: ${TYPE.title}; font-weight: 800; letter-spacing: -0.01em; line-height: 1.2; text-wrap: balance; }
        .ar-start-place { margin-top: 4px; font-size: ${TYPE.sub}; color: ${C.text}; }
        .ar-start-summary { margin: 6px 0 14px; font-size: ${TYPE.sub}; color: ${C.accent}; }
        /* Tips: a bare icon in the text colour, no dots. */
        .ar-start-tips { margin: 0 0 16px; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 8px; text-align: left; }
        .ar-start-tips li {
            display: flex; gap: 10px; align-items: flex-start; padding: 10px 12px; border-radius: ${RADIUS}px;
            background: rgba(255,255,255,0.04); border: 1px solid ${C.hairline};
            font-size: 13px; line-height: 1.45; color: ${C.muted};
        }
        .ar-start-tips li svg { flex: none; margin-top: 1px; color: ${C.text}; }
        .ar-start-tips b { color: ${C.text}; font-weight: 600; }
        /* Error: the alert is the message, so it may carry a soft tint; only the
           icon and the title take the danger shade, the steps stay neutral (§2.5). */
        .ar-start-error {
            margin: 2px 0 14px; padding: 12px 14px; border-radius: ${RADIUS}px; text-align: left;
            background: rgba(255, 85, 102, 0.08); border: 1px solid rgba(255, 85, 102, 0.28);
        }
        .ar-start-error-title { display: flex; align-items: center; gap: 8px; margin: 0; font-size: ${TYPE.sub}; font-weight: 700; color: ${C.danger}; }
        .ar-start-error-title svg { flex: none; }
        .ar-start-error-body { margin: 4px 0 0; font-size: 13px; line-height: 1.5; color: ${C.text}; }
        .ar-start-steps { margin: 8px 0 0; padding-left: 20px; font-size: 13px; line-height: 1.5; color: ${C.text}; }
        .ar-start-steps li + li { margin-top: 2px; }
        .ar-start-actions { display: flex; flex-direction: column; gap: 8px; }
        .ar-start-btn {
            width: 100%; display: inline-flex; align-items: center; justify-content: center; gap: 8px;
            min-height: 48px; padding: 0 22px; border-radius: ${PILL}px; font-size: ${TYPE.sub}; font-weight: 700;
        }
        .ar-start-btn.is-secondary { min-height: ${TAP.minHeight}; font-weight: 600; }
        .ar-start-btn.is-secondary small { font-size: ${TYPE.desc}; font-weight: 500; color: ${C.muted}; }
        /* The way out is the quiet option: text style, still a full touch target. */
        .ar-start-btn.is-tertiary {
            min-height: ${TAP.minHeight}; background: transparent; border: 0; color: ${C.muted}; font-weight: 600;
            -webkit-backdrop-filter: none; backdrop-filter: none;
        }
        .ar-start-btn.is-tertiary:hover { color: ${C.white}; background: rgba(255,255,255,0.06); }
        .ar-start-build { margin-top: 10px; font-size: 11px; color: ${C.muted}; opacity: 0.7; }
        @keyframes ar-fade { from { opacity: 0; } }
        @media (prefers-reduced-motion: reduce) {
            .ar-notice, .ar-look-hint, .ar-start, .ar-start-card { animation: none; }
        }
        /* AR stage-in: the full 3D takeover arrives as one scene change. */
        @keyframes ar-stage-in {
            from { opacity: 0; transform: scale(1.14); }
            to { opacity: 1; transform: none; }
        }
        .ar-stage { animation: ar-stage-in 0.7s cubic-bezier(0.16, 1, 0.3, 1); }
        @media (prefers-reduced-motion: reduce) {
            .anim-in, .ar-stage, .ar-spin { animation: none; }
        }
        /* Docked 2D mini-map: Leaflet paints its own panes inside the card,
           so only the chrome needs theming to match the HUD. */
        .ar-minimap.leaflet-container { background: ${C.page}; font: inherit; }
        .ar-dock .ar-mode { flex: 1 1 auto; min-width: 0; max-width: 240px; }
        .ar-dock .ar-mode > button { min-height: 40px; padding: 0 12px; font-size: ${TYPE.sub}; }
        .ar-map-sat {
            position: absolute; z-index: 500; right: max(10px, env(safe-area-inset-right));
            top: var(--ar-map-top, 84px); min-height: 40px; padding: 0 14px;
            /* Solid, not see-through: it sits on the light map, not on a dark panel. */
            background: ${C.bar} !important; border-color: ${C.border} !important; box-shadow: ${ELEVATION.float};
        }
        .ar-minimap .leaflet-bar a {
            width: 30px !important; height: 30px !important; line-height: 30px !important;
            background: ${C.glass} !important; color: #fff !important;
            border-bottom-color: rgba(255, 255, 255, 0.14) !important;
        }
        .ar-minimap .leaflet-control-attribution {
            background: rgba(12, 12, 16, 0.72) !important;
            color: ${C.muted} !important; font-size: 12px !important;
        }
        .ar-minimap .leaflet-control-attribution a { color: ${C.accent} !important; }
        @media (max-width: 760px) {
            .ar-minimap .leaflet-bar a { width: 36px !important; height: 36px !important; line-height: 36px !important; font-size: 16px !important; }
            .ar-minimap .leaflet-control-zoom { margin-top: 6px !important; margin-left: 6px !important; }
            .ar-minimap .leaflet-control-attribution { font-size: 12px !important; padding: 1px 5px !important; }
        }
        /* ── Responsive HUD: phones keep the camera dominant ── */
        .ar-topbar { display: flex; gap: 10px; align-items: center; }
        .ar-menu-btn { display: inline-flex; align-items: center; gap: 7px; padding: 8px 14px; border-radius: 10px; font-size: ${TYPE.sub}; line-height: 1.4; font-weight: 700; flex: none; }
        .ar-mini-head { display: flex; align-items: center; gap: 8px; padding: 2px 2px 8px; }
        .ar-mini-title { flex: 1; min-width: 0; font-size: ${TYPE.desc}; font-weight: 800; letter-spacing: 0.1em; text-transform: uppercase; color: ${C.muted}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .ar-mini-toggle { flex: none; min-height: ${TAP.minHeight}; padding: 0 12px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.14); background: rgba(255,255,255,0.06); color: ${C.white}; font-size: ${TYPE.desc}; font-weight: 700; cursor: pointer; touch-action: manipulation; }
        .ar-mini-toggle:active { transform: scale(0.96); }
        /* Test walk toggle (3D mode): top right, under the top card. */
        .ar-test-walk { position: absolute; z-index: 5; right: max(10px, env(safe-area-inset-right)); padding: 0 14px;
            background: ${C.bar}; border-color: ${C.border}; box-shadow: ${ELEVATION.float}; }
        .ar-test-walk.is-on { border-color: rgba(255, 176, 46, 0.6); color: #ffd9a0; }
        @media (max-width: 480px) {
            .ar-topbar { gap: 8px; }
            .ar-menu-btn { justify-content: center; width: ${TAP.minHeight}; min-height: ${TAP.minHeight}; padding: 0 !important; }
            .ar-menu-btn svg { width: 18px; height: 18px; }
            .ar-menu-label { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
            .ar-dest { font-size: 13px !important; }
            .ar-route { font-size: ${TYPE.desc} !important; }
            .ar-menu-row { min-height: 44px; padding: 10px 12px !important; }
            .ar-instr { min-height: 0; }
            .ar-instr-main { font-size: 18px; }
            .ar-instr-sub { margin-top: 1px; font-size: ${TYPE.desc}; min-height: 16px; }
            .ar-step-icon { width: 30px; height: 30px; }
        }
        /* Bottom-centre dock: the always-reachable controls (details, mini-map,
           camera <-> map swap). Sits at the thumb, panels stack above it. */
        .ar-dock {
            position: absolute; z-index: 6; left: 0; right: 0; margin: 0 auto;
            width: max-content; max-width: calc(100% - 16px);
            bottom: ${SAFE_BOTTOM};
            display: flex; gap: 4px; padding: 5px;
        }
        .ar-dock-btn {
            display: inline-flex; align-items: center; justify-content: center; gap: 7px;
            min-height: ${TAP.minHeight}; padding: 0 14px; border-radius: ${PILL}px;
            background: transparent; color: ${C.muted};
            font-size: 13px; font-weight: 700; white-space: nowrap;
            border: 1px solid transparent;
        }
        .ar-dock-btn svg { flex: none; }
        .ar-dock-btn:hover { color: ${C.white}; background: rgba(255, 255, 255, 0.07); }
        .ar-dock-btn[aria-pressed="true"] {
            color: ${C.white}; background: rgba(74, 222, 128, 0.14);
            border-color: rgba(74, 222, 128, 0.5);
        }
        @media (max-width: 380px) { .ar-dock-btn { padding: 0 10px; gap: 5px; font-size: 12px; } }
        /* Four buttons on a narrow phone: words only, so every label fits. */
        /* Narrow phones: Details and Exit as icons (44 px), so the three views fit. */
        @media (max-width: 420px) {
            .ar-dock-btn { min-width: ${TAP.minHeight}; padding: 0 !important; justify-content: center; }
            .ar-dock-btn .ar-dock-label { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
            .ar-dock-btn svg { width: 18px; height: 18px; }
        }
        /* Wide screens: the dock sits under the left column instead of floating mid-screen. */
        .ar-dock.is-wide { left: 10px; right: auto; margin: 0; }
        /* Compass align: a compact two-line button at the right end of the top bar. */
        /* Camera layer: full-bleed normally, a corner preview while the map is the main view. */
        .ar-cam-layer { transition: transform 0.35s var(--ease-out), border-radius 0.35s var(--ease-out), box-shadow 0.35s var(--ease-out); }
        .ar-pip-hit {
            position: absolute; inset: 0; z-index: 10; width: 100%; height: 100%;
            background: transparent; border: 0; padding: 0; cursor: pointer;
            -webkit-tap-highlight-color: transparent;
        }
        /* Map as the main view: keep Leaflet's controls clear of the HUD and the dock. */
        .ar-miniwrap.is-full { max-height: none !important; }
        .ar-miniwrap.is-full .leaflet-top { margin-top: var(--ar-map-top, 80px); }
        .ar-miniwrap.is-full .leaflet-bottom { margin-bottom: calc(${SAFE_BOTTOM} + ${DOCK_LIFT}px); }
        /* Short landscape: HUD becomes side-docked so the camera keeps height. */
        @media (max-height: 520px) and (orientation: landscape) {
            .ar-guidance { max-height: 52dvh !important; }
            .ar-miniwrap { max-height: 46dvh !important; }
        }
    `;
    const videoRef = useRef(null);
    const mountRef = useRef(null);
    const hudRef = useRef(null);
    const youRef = useRef(null);
    const youCacheRef = useRef('');
    // Closest-node indicator in the bottom bar: label is static JSX, the value
    // and the node name are written straight from the render loop (cached, so
    // no React render per frame).
    const closestRef = useRef(null);
    const closestNodeRef = useRef(null);
    const closestCacheRef = useRef('');
    // Plain-language guidance (written by the render loop, like the refs above).
    const instrRef = useRef(null);
    const instrSubRef = useRef(null);
    const stopCountRef = useRef(null);
    const guideCacheRef = useRef('');
    const arrivedRef = useRef(false);
    // The floor the student is on, for the frame loop: a stop (and the
    // destination) only counts as reached on its own floor, so standing on
    // the ground floor under a floor-2 room never means "arrived".
    const onFloorRef = useRef(floor);
    onFloorRef.current = floor;
    const streamRef = useRef(null);
    const camOverlayRef = useRef(null);
    const rootRef = useRef(null);

    // ── Desktop free-roam state ──────────────────────────────────────
    // Held in refs, not state: they are written by DOM listeners at input
    // rate (every keystroke, every mouse pixel) and read by the render
    // loop. React must never re-render on either.
    const keysRef = useRef({ w: false, a: false, s: false, d: false, c: false, space: false, shift: false });
    const touchLookRef = useRef(null);
    // The "Drag to look around" hint goes away after the first drag.
    const [dragged, setDragged] = useState(false);
    // Yaw/pitch in radians, YXZ Euler — same convention as the sensor path's
    // fallback: yaw 0 = north, positive yaw turns right/east. Note the sign
    // relationship used throughout: compass azimuth = −yaw.
    const lookRef = useRef({ yaw: 0, pitch: 0 });
    // Walked position in the anchor ENU frame. Seeded from the GPS fix on
    // the first free-roam frame, so toggling it on never teleports.
    const freePosRef = useRef({ x: 0, z: 0, seeded: false });
    // The transparent layer that captures clicks for pointer lock.
    const lookLayerRef = useRef(null);
    // Last walked fix handed to the parent, and when. Lets the reporter
    // throttle instead of asking for a Dijkstra recompute every frame.
    const walkedReportRef = useRef({ lat: null, lng: null, at: 0 });
    // Held in a ref so the render loop (which keeps the closure from the
    // render that started it) always calls the parent's *current* handler.
    const onWalkedPositionRef = useRef(onWalkedPosition);
    onWalkedPositionRef.current = onWalkedPosition;

    // Hand the walked position up to the parent, which re-runs Dijkstra
    // from it. Without this the route stays pinned to the fix the session
    // started with, so a presenter who walks to the destination is still
    // shown a path leading back across campus.
    //
    // Throttled by distance: 2 m is far coarser than GPS jitter, yet fine
    // enough that the drawn path never looks stuck while walking (worst
    // case, ~6 recomputes/s at sprint speed).
    const reportWalked = (lat, lng, force = false) => {
        const cb = onWalkedPositionRef.current;
        if (typeof cb !== 'function') return;
        const r = walkedReportRef.current;
        const valid = Number.isFinite(lat) && Number.isFinite(lng);
        if (!force && valid && Number.isFinite(r.lat) && Number.isFinite(r.lng)) {
            if (bearingAndDistance(r.lat, r.lng, lat, lng).dist < 2) return;
        }
        r.lat = valid ? lat : null;
        r.lng = valid ? lng : null;
        r.at = performance.now();
        cb(valid ? { latitude: lat, longitude: lng } : null);
    };

    // Per-frame numbers handed to the render loop.
    const statsRef = useRef({
        fps: 0, totalFrames: 0, errors: 0,
        camX: 0, camY: 0, camZ: 0, camYaw: null, camPitch: null,
        aspect: 0, fov: 60, quatSource: 'none',
        drawn: 0, pool: 0, destVisible: false,
        calls: 0, tris: 0, lastFrameAt: 0, ctxLost: false, tubePts: 0,
    });
    const rendererRef = useRef(null);
    // Video-track settings reported by the browser (resolution/fps/facing).
    const trackSettingsRef = useRef(null);
    // Orientation-event liveness: how many arrived and when the last one did.
    const orientEventsRef = useRef(0);
    const lastOrientAtRef = useRef(0);
    // Last time a USABLE HEADING was ingested — distinct from lastOrientAtRef,
    // which only means "an event arrived". This device fires events with
    // alpha === null forever, so events keep arriving while heading never
    // improves; without a separate clock the 6 s generic-sensor gate (which
    // watches event silence) never opens and the one API that could deliver
    // a heading is never attempted.
    const lastHeadingAtRef = useRef(0);
    // One-shot capture of the FIRST orientation event, verbatim. "14 events,
    // no heading" and "14 events, all fields null" produced the same HUD line,
    // so the raw payload is the only thing that tells them apart. Only the
    // first is kept — the payload shape never changes within a session.
    const firstOrientPayloadRef = useRef(null);
    // navigator.permissions state for the three sensor permissions, probed
    // once on mount. Android Chrome has no JS permission prompt for
    // deviceorientation, so a denial made earlier (in site settings) is
    // invisible from the page — this is the only way to read it back.
    const sensorPermRef = useRef('probing…');
    // Only events that actually fed the camera count as "the view moved".
    // The stall watchdog watches this, not the raw event count, so a stream
    // that fires but is gated out (e.g. absolute-seen cutover) still trips it.
    const lastRotAtRef = useRef(0);
    // Currently attached listener pair (null = detached), plus watchdog state.
    const orientHandlersRef = useRef(null);
    const orientAttachAtRef = useRef(0);
    const orientRearmAtRef = useRef(0);
    const orientRearmGapRef = useRef(3000);
    // Classic deviceorientation events only (the generic fallback reports
    // through orientEventsRef too, but it must not mask a dead classic stream).
    const classicEventsRef = useRef(0);
    // Generic Sensor API fallback (AbsoluteOrientationSensor) — a separate
    // code path with a separate permission model, tried only once the classic
    // stream has gone a full 6 s without delivering a single event.
    const genericSensorRef = useRef(null);
    // idle → running | error (retry from a gesture) | unsupported (never)
    const genericStateRef = useRef('idle');
    const genericNotBeforeRef = useRef(performance.now() + 6000);
    const genericReadingsLoggedRef = useRef(0);
    // Latest raw AbsoluteOrientationSensor quaternion ([x,y,z,w] + timestamp).
    // Kept whole so the camera keeps ROLL when the classic stream has no alpha.
    const genericQuatRef = useRef(null);
    // When the classic stream last carried usable β/γ — the generic sensor
    // only writes pitch while this is stale, so two sources never fight.
    const lastClassicAxesAtRef = useRef(0);
    // Compass error correction: offset (deg) = true azimuth − sensed azimuth,
    // added to every sensor-driven camera pose. sensorAzRef is the azimuth the
    // sensors reported BEFORE the offset (null when yaw is synthesised).
    const yawOffsetRef = useRef(0);
    const sensorAzRef = useRef(null);
    // Latest RELATIVE (gyro-only, no magnetometer) orientation event, and the
    // state of the filter that estimates the north offset between the two.
    const relOrientRef = useRef(null);
    const fuseRef = useRef({ delta: null, raw: null, state: 'off', devT: 0, age: 0, lastT: 0 });
    // Recent snapped positions → displacement-based walking course.
    const posHistRef = useRef([]);
    const courseInfoRef = useRef({ course: null, speed: null, src: 'none' });
    // Last GPS-course correction, for the heartbeat log.
    const lastCourseFixRef = useRef({ t: 0, step: 0, course: null, speed: null });
    // Set when the absolute stream first takes over, so the camera re-snaps
    // instead of slerping from the arbitrary relative-frame yaw.
    const resnapYawRef = useRef(false);
    // window.focus() retries while the page sits unfocused — the one state
    // we have measured with ev=0 and no timer-based way out of it.
    const focusAttemptAtRef = useRef(0);
    const focusAttemptCountRef = useRef(0);
    // When the CURRENT `userLocation` prop object arrived — the GPS fix
    // cadence, measured independently of React so the heartbeat log can
    // say "last fix 4200 ms ago" without waiting for a render.
    const lastUserRef = useRef(null);
    const lastUserAtRef = useRef(0);

    // Session anchor for the ENU world (+X = East, +Y = Up, -Z = North).
    // Set once from the first fix of this session; nodes AND camera are
    // expressed relative to it, so the whole scene stays rigid.
    const anchorRef = useRef(null);
    // Raw 3D device orientation, straight from the sensor — unfiltered.
    const deviceOrientationRef = useRef(null);
    // Latest sensor/route data for the render loop (refs, not state).
    const dataRef = useRef({ heading: null, route: null, user: null, targetIdx: 1, destKey: null });

    dataRef.current.route = route;
    dataRef.current.nodes = nodes;
    dataRef.current.borders = borders;
    // Labelled buildings: invisible occluders plus names and doors in the 3D view (arBuildings.js).
    dataRef.current.buildings = buildings;
    // The render loop is long-lived, so the selected floor must travel by ref:
    // assigning it here makes a floor tap visible on the very next frame
    // without remounting the scene (which would lose the camera/session).
    dataRef.current.floor = Number.isFinite(floor) ? floor : null;
    // Same floor filter for text readouts that name the nearest point, so the
    // "near …" line can never report a node that is not on screen.
    dataRef.current.floorNodes = Number.isFinite(floor)
        ? (nodes || []).filter((n) => floorOf(n) === floor)
        : (nodes || []);
    // The fix arrives already Kalman-smoothed and snapped to the walkway by
    // MobileNav's GpsPipeline (raw coords ride along as rawLatitude/rawLongitude).
    dataRef.current.user = userLocation;
    if (userLocation && userLocation !== lastUserRef.current) {
        lastUserRef.current = userLocation;
        lastUserAtRef.current = performance.now();
    }
    if (userLocation && Number.isFinite(userLocation.latitude) && Number.isFinite(userLocation.longitude) && !anchorRef.current) {
        anchorRef.current = {
            latitude: userLocation.latitude,
            longitude: userLocation.longitude,
            elevation: Number.isFinite(userLocation.elevation) ? userLocation.elevation : 0,
        };
    }

    const [started, setStarted] = useState(false);
    const [cameraPending, setCameraPending] = useState(false);
    const [needsTapToPlay, setNeedsTapToPlay] = useState(false);
    const [camError, setCamError] = useState(null);
    const [orientStatus, setOrientStatus] = useState('waiting');
    const [compassBlocked, setCompassBlocked] = useState(false);
    const [isBrave, setIsBrave] = useState(false);
    // WebGL context loss: banner + tap-to-rebuild (fresh renderer context).
    const [ctxLost, setCtxLost] = useState(false);
    // Compass confidence (iOS reports ± degrees; elsewhere it stays unknown
    // and no warning is shown). State only changes when the bucket changes.
    const [compassWarn, setCompassWarn] = useState(null);
    const compassWatcherRef = useRef(null);
    if (compassWatcherRef.current === null) compassWatcherRef.current = createCompassWatcher();
    const [glNonce, setGlNonce] = useState(0);
    const [menuOpen, setMenuOpen] = useState(false);
    useEffect(() => {
        if (!menuOpen) return undefined;
        const onKey = (e) => { if (e.key === 'Escape') setMenuOpen(false); };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [menuOpen]);
    // Bottom-sheet options, both toggled from the menu and both off by
    // default: the first launch is the bare camera feed.
    // The guidance card is the main reading surface now, so it starts open.
    const [showGuidance, setShowGuidance] = useState(true);
    // Arrival card: { name } once the destination is reached, null otherwise.
    const [arrived, setArrived] = useState(null);
    // Coordinates, camera angles and the raw stop list: for field tests only.
    const [techDetails, setTechDetails] = useState(() => {
        try { return localStorage.getItem('arTechDetails') === '1'; } catch { return false; }
    });
    useEffect(() => { try { localStorage.setItem('arTechDetails', techDetails ? '1' : '0'); } catch { /* private mode */ } }, [techDetails]);
    // Spoken directions (voiceGuidance.js): off until switched on, remembered on this device. The render
    // loop feeds voiceRef the current guidance; lastGuideRef keeps it so switching on can say it at once.
    const canSpeak = speechAvailable();
    const [voiceOn, setVoiceOn] = useState(() => {
        try { return canSpeak && localStorage.getItem('arVoice') === '1'; } catch { return false; }
    });
    const voiceRef = useRef(null);
    const lastGuideRef = useRef(null);
    useEffect(() => {
        try { localStorage.setItem('arVoice', voiceOn ? '1' : '0'); } catch { /* private mode */ }
        if (voiceOn && !voiceRef.current) voiceRef.current = createVoiceGuide(say);
        if (!voiceOn) { voiceRef.current = null; hush(); }
    }, [voiceOn]);
    useEffect(() => hush, []);
    const toggleVoice = () => {
        const next = !voiceOn;
        setVoiceOn(next);
        // Speak inside the tap itself: iPhones only allow speech that starts from a user gesture.
        if (next && lastGuideRef.current) {
            const guide = createVoiceGuide(say);
            voiceRef.current = guide;
            guide.repeat(lastGuideRef.current, performance.now());
        }
    };
    const [showMiniMap, setShowMiniMap] = useState(false);
    // Camera <-> map swap: when true the map fills the stage and the camera
    // (or the free-roam 3D scene) shrinks into a corner preview.
    const [swapped, setSwapped] = useState(false);
    const mapMain = swapped && showMiniMap;
    // Camera | Map: the two full-screen modes of the 3D view (the old docked mini-map strip
    // made both too small on phones). Map keeps the camera as a corner preview to tap back.
    // 3D: the game-style follow view (FollowView3D), between the camera and the flat map.
    const [followMain, setFollowMain] = useState(
        () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(pointer: fine)').matches,
    );
    // Read by the render loop: while the 3D follow view covers the screen the AR
    // scene still updates (guidance, distances) but is not drawn, so the phone
    // renders one 3D scene per frame, not two.
    const followMainRef = useRef(false);
    followMainRef.current = followMain;
    // Test walk (3D mode only): walk with a joystick / W A S D instead of GPS, so
    // people off campus can try the movement. `testPosRef` holds the walked fix
    // the render loop uses as "you" (guidance, distances, the route).
    const [followTest, setFollowTest] = useState(false);
    // True while the 3D mode walks instead of following the GPS (set below, once freeRoam is known).
    const followTestRef = useRef(false);
    const testPosRef = useRef(null);
    // headingDeg: which way the walking figure faces (compass degrees), for "turn left / right".
    const onTestMove = (lat, lng, headingDeg = null) => { testPosRef.current = { latitude: lat, longitude: lng, headingDeg }; };
    const setViewMode = (mode) => {
        setFollowMain(mode === 'follow');
        if (mode !== 'follow') setFollowTest(false);
        if (mode === 'map') {
            setShowMiniMap(true);
            setMiniCollapsed(false);
            setSwapped(true);
        } else {
            setShowMiniMap(false);
            setSwapped(false);
        }
    };
    // Mini-map collapsed = header strip only (map unmounted, zero height).
    // Lets a phone keep route context one tap away without losing the camera.
    const [miniCollapsed, setMiniCollapsed] = useState(false);
    // Live viewport so the strip height + stacking lift stay proportional on
    // phones, tablets, rotation and split-screen — not fixed px.
    const [viewport, setViewport] = useState(() => ({
        w: typeof window !== 'undefined' ? window.innerWidth : 400,
        h: typeof window !== 'undefined' ? window.innerHeight : 700,
    }));
    useEffect(() => {
        const onResize = () => setViewport({ w: window.innerWidth, h: window.innerHeight });
        window.addEventListener('resize', onResize, { passive: true });
        window.addEventListener('orientationchange', onResize, { passive: true });
        return () => {
            window.removeEventListener('resize', onResize);
            window.removeEventListener('orientationchange', onResize);
        };
    }, []);
    const isPhone = viewport.w <= 480;
    const isCompact = viewport.w <= 760;
    const isShortLandscape = viewport.h <= 520 && viewport.w > viewport.h;
    // Wide screens: text HUD in one left column, mini-map in the right column,
    // so the middle of the view (the camera) stays clear.
    const isWide = viewport.w >= 900 && !isShortLandscape;
    // Effective strip height: responsive base, capped to viewport, zero when collapsed.
    const miniH = miniCollapsed ? 0 : responsiveMiniMapHeight();
    const miniLift = miniCollapsed ? 52 : miniH + MINI_CHROME;
    // Mini-map Leaflet instance + layers. Refs, not state: Leaflet mutates
    // its own DOM and must never trigger a React render.
    const miniMapRef = useRef(null);
    const miniMapObj = useRef(null);
    // True while the mini-map's Leaflet map exists (the satellite layer attaches then).
    const [miniReady, setMiniReady] = useState(false);
    useSatelliteLayer(() => miniMapObj.current, satellite || { active: false, opacity: 100 }, miniReady);
    const miniUserRef = useRef(null);
    const miniAccRef = useRef(null);
    const miniRouteGlowRef = useRef(null);
    const miniRouteRef = useRef(null);
    const miniDestRef = useRef(null);
    // POV wedge (absolute camera heading) + relative-direction arrow
    // (signed angle from camera facing to the nearest node). Both ride on
    // the user dot and are rotated straight in the DOM — no React renders.
    const miniPovRef = useRef(null);
    const miniDirRef = useRef(null);
    // Continuous (unwrapped) angles for the two markers above. Writing a raw
    // 0..360 heading straight to CSS makes 359°→1° animate the long way round
    // (the wedge appears to snap to the opposite side when crossing north).
    // These refs keep the displayed angle continuous across the wrap.
    const miniDirAngleRef = useRef(null);
    // Heading pill in the mini-map header (same "123° NE" readout as the
    // mobile page). Written by the ticker below, never via React state.
    const miniHdgRef = useRef(null);
    // 3D distance banner (nearest node vs camera angle). Same ref-written
    // pattern as the closest-stop readout: the render loop updates the DOM
    // directly so guidance stays at frame rate without re-rendering React.
    const dirBannerRef = useRef(null);
    // The guidance card's turn arrow (written by the render loop).
    const instrIconRef = useRef(null);
    // Height of the top card, so the chip and the map's controls sit right under it.
    const topCardRef = useRef(null);
    const [topCardH, setTopCardH] = useState(70);
    const [guideEl, setGuideEl] = useState(null);
    const [guideH, setGuideH] = useState(140);
    useEffect(() => {
        if (!guideEl || typeof ResizeObserver === 'undefined') return undefined;
        const ro = new ResizeObserver(([entry]) => setGuideH(Math.round(entry.target.getBoundingClientRect().height)));
        ro.observe(guideEl);
        return () => ro.disconnect();
    }, [guideEl]);
    useEffect(() => {
        const el = topCardRef.current;
        if (!el || typeof ResizeObserver === 'undefined') return undefined;
        const ro = new ResizeObserver(([entry]) => setTopCardH(Math.round(entry.target.getBoundingClientRect().height)));
        ro.observe(el);
        return () => ro.disconnect();
    }, []);
    const dirTextRef = useRef(null);
    const dirTurnRef = useRef(null);
    const dirCacheRef = useRef('');
    // A small, throttled bridge from the 3D render loop to Leaflet. Free-roam
    // movement is simulated locally, so it must not wait for a GPS prop change
    // (or trigger React state updates) before the mini-map follows it.
    const miniWalkSyncRef = useRef({ latitude: null, longitude: null, at: 0 });
    // Eased motion for the mini-map. ONE SmoothPoint carries the dot, the
    // wedge, the arrow and the accuracy ring together (and keeps the map
    // centred under them), so a new fix glides in instead of snapping, and
    // the layers can never drift apart mid-glide. The wedge heading is eased
    // by a SmoothAngle that also unwraps across north.
    const miniFollowRef = useRef(null);
    const miniSpinRef = useRef(null);
    if (miniFollowRef.current === null) {
        miniFollowRef.current = new SmoothPoint({
            tau: 0.12,
            onUpdate: (lat, lng) => {
                const ll = [lat, lng];
                miniUserRef.current?.setLatLng(ll);
                miniAccRef.current?.setLatLng(ll);
                miniPovRef.current?.setLatLng(ll);
                miniDirRef.current?.setLatLng(ll);
                // Keep the map centred under the DRAWN dot (not the target),
                // otherwise the dot would wobble against screen centre while
                // it eases.
                const map = miniMapObj.current;
                if (map) map.setView(ll, map.getZoom(), { animate: false });
            },
        });
    }
    if (miniSpinRef.current === null) {
        miniSpinRef.current = new SmoothAngle({
            tau: 0.08,
            onUpdate: (deg) => paintPovRotation(miniPovRef.current, deg),
        });
    }
    useEffect(() => () => {
        miniFollowRef.current?.destroy();
        miniSpinRef.current?.destroy();
    }, []);
    const syncMiniMapFix = (fix, force = false) => {
        const map = miniMapObj.current;
        if (!map || !fix || !Number.isFinite(fix.latitude) || !Number.isFinite(fix.longitude)) return;

        const now = performance.now();
        const prev = miniWalkSyncRef.current;
        const moved = Number.isFinite(prev.latitude) && Number.isFinite(prev.longitude)
            ? bearingAndDistance(prev.latitude, prev.longitude, fix.latitude, fix.longitude).dist
            : Infinity;
        // Sample up to 20 times/second while walking (the follower below
        // interpolates between samples every frame), and sooner when the
        // marker has moved a meaningful distance. This keeps the dot fluid
        // without doing a Leaflet layout pass on every Three.js frame.
        if (!force && moved < 0.25 && now - prev.at < 50) return;

        const ll = [fix.latitude, fix.longitude];
        const follow = miniFollowRef.current;
        if (miniUserRef.current) {
            follow.moveTo(ll[0], ll[1]);
        } else {
            miniUserRef.current = L.marker(ll, {
                icon: MINI_USER_ICON, zIndexOffset: 1000, interactive: false,
            }).addTo(map);
            // First draw (or the map was rebuilt): place, don't glide.
            follow.snapTo(ll[0], ll[1]);
        }
        // Anything created below starts where the dot is DRAWN.
        const here = follow.current ? [follow.current.lat, follow.current.lng] : ll;

        // Virtual positions have no GPS accuracy radius. Remove any old circle
        // during free-roam so a stale GPS uncertainty ring cannot trail the dot.
        if (fix.source === 'freeroam' || !Number.isFinite(fix.accuracy) || fix.accuracy <= 0) {
            if (miniAccRef.current) {
                map.removeLayer(miniAccRef.current);
                miniAccRef.current = null;
            }
        } else if (miniAccRef.current) {
            miniAccRef.current.setRadius(fix.accuracy);
        } else {
            miniAccRef.current = L.circle(here, {
                radius: fix.accuracy, color: ROUTE_CASING, weight: 1, opacity: 0.5,
                fillColor: ROUTE_CASING, fillOpacity: 0.08, interactive: false,
            }).addTo(map);
        }

        // The map recentre and the wedge/arrow positions are applied by the
        // follower every frame (no Leaflet animation under a moving dot —
        // that adds lag and makes the marker trail the 3D camera). Wedge
        // rotation is applied by the heading ticker below.
        prev.latitude = fix.latitude;
        prev.longitude = fix.longitude;
        prev.at = now;
    };
    // Desktop free-roam. Auto-on wherever the primary pointer is a mouse or
    // trackpad — i.e. exactly the laptops a presentation is given from — and
    // always overridable from the ☰ menu, because a tablet paired with a
    // keyboard reports `(pointer: fine)` too.
    const [freeRoam, setFreeRoam] = useState(
        () => typeof window !== 'undefined'
            && typeof window.matchMedia === 'function'
            && window.matchMedia('(pointer: fine)').matches,
    );
    const [touchInput] = useState(() => {
        if (typeof window === 'undefined') return false;
        const touchPoints = typeof navigator !== 'undefined' ? (navigator.maxTouchPoints || 0) : 0;
        return touchPoints > 0 || ('ontouchstart' in window)
            || (typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches);
    });
    // Device emulation in browser devtools does not always enable touch APIs.
    // Also use the live viewport width as a responsive fallback so a narrow
    // mobile-sized preview uses drag-to-look without requiring a
    // physical phone or DevTools' separate touch-emulation toggle.
    // Which way you face, in compass degrees (null without a heading yet): the
    // free-roam look, else the eased compass, else the raw heading.
    const headingNowDeg = () => {
        if (freeRoamRef.current) {
            const yaw = lookRef.current.yaw;
            return Number.isFinite(yaw) ? ((-yaw * 180) / Math.PI % 360 + 360) % 360 : null;
        }
        if (Number.isFinite(motionRef.current.yaw)) return ((motionRef.current.yaw % 360) + 360) % 360;
        const h = dataRef.current.heading;
        return Number.isFinite(h) ? ((h % 360) + 360) % 360 : null;
    };
    const getFollowPose = () => {
        const u = dataRef.current.user;
        return u ? { lat: Number(u.latitude), lng: Number(u.longitude), headingDeg: headingNowDeg() } : null;
    };
    // The map's buildings, drawn solid (lifted roofs, sun-shaded walls) like the 2D map.
    const miniBuildingsRef = useRef(null);
    const drawMiniBuildings = () => {
        const layer = miniBuildingsRef.current;
        if (!layer) return;
        drawBuildings(layer, dataRef.current.buildings || [], {
            theme: GPS_FLAVOR, extrude: true,
            sun: sunPosition(new Date(), CAMPUS_CENTER[0], CAMPUS_CENTER[1]),
        });
    };
    const [compactViewport, setCompactViewport] = useState(() =>
        typeof window !== 'undefined'
        && typeof window.matchMedia === 'function'
        && window.matchMedia('(max-width: 760px)').matches,
    );
    useEffect(() => {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
        const media = window.matchMedia('(max-width: 760px)');
        const update = () => setCompactViewport(media.matches);
        update();
        window.addEventListener('resize', update, { passive: true });
        window.addEventListener('orientationchange', update, { passive: true });
        if (media.addEventListener) media.addEventListener('change', update);
        else media.addListener(update);
        return () => {
            window.removeEventListener('resize', update);
            window.removeEventListener('orientationchange', update);
            if (media.removeEventListener) media.removeEventListener('change', update);
            else media.removeListener(update);
        };
    }, []);
    // Touch screens and phone-sized windows look around by dragging instead of
    // pointer lock; walking stays on WASD wherever a keyboard exists.
    const dragLook = touchInput || compactViewport;
    const dragLookRef = useRef(dragLook);
    dragLookRef.current = dragLook;

    // Loop-facing mirror. Written during render, the same way route/nodes
    // are mirrored into dataRef just above.
    const freeRoamRef = useRef(freeRoam);
    freeRoamRef.current = freeRoam;
    // On a computer (desktop free-roam: mouse and keyboard) the 3D mode walks with W A S D straight
    // away; the Test walk button is only for phones, where walking replaces the GPS.
    const testWalkOn = followMain && (followTest || freeRoam);
    followTestRef.current = testWalkOn;
    useEffect(() => {
        if (testWalkOn) return;
        // Leaving the test walk (or 3D mode): back to the real GPS position.
        if (testPosRef.current) {
            testPosRef.current = null;
            reportWalked(null, null, true);
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [testWalkOn]);
    useEffect(() => {
        if (freeRoam) return;
        const keys = keysRef.current;
        keys.w = keys.a = keys.s = keys.d = keys.c = keys.space = keys.shift = false;
        touchLookRef.current = null;
    }, [freeRoam]);
    // When the viewport crosses the desktop/mobile breakpoint, discard any
    // held input from the previous control mode so movement cannot get stuck.
    useEffect(() => {
        const keys = keysRef.current;
        keys.w = keys.a = keys.s = keys.d = keys.c = keys.space = keys.shift = false;
        touchLookRef.current = null;
        // If a desktop pointer lock is active when the viewport becomes
        // mobile-sized, release it so drag-to-look can take over cleanly.
        if (dragLook && typeof document !== 'undefined' && document.pointerLockElement) {
            try { document.exitPointerLock(); } catch { /* no-op */ }
        }
    }, [dragLook]);
    // Drives the crosshair and the "click to look" hint only — the render
    // loop reads document.pointerLockElement directly so it can never see a
    // stale boolean.
    const [pointerLocked, setPointerLocked] = useState(false);

    // Local diagnostic trail: sessionStorage only, never uploaded and never shown.
    // Readable from a remote debugger (sessionStorage 'ar-cam-log') when a phone misbehaves.
    const camLogRef = useRef([]);
    const log = (msg) => {
        const ts = new Date().toLocaleTimeString();
        camLogRef.current = [...camLogRef.current.slice(-299), `[${ts}] ${msg}`];
        try { sessionStorage.setItem('ar-cam-log', JSON.stringify(camLogRef.current)); } catch { /* private mode */ }
    };

    // Crash forensics: trap page-level errors into the same local log.
    useEffect(() => {
        const onErr = (e) => {
            const msg = e?.message || e?.reason?.message || String(e);
            log(`PAGE ERROR: ${msg}`.slice(0, 200));
        };
        window.addEventListener('error', onErr);
        window.addEventListener('unhandledrejection', onErr);
        try {
            const saved = sessionStorage.getItem('ar-cam-log');
            if (saved) {
                const arr = JSON.parse(saved);
                if (Array.isArray(arr) && arr.length) {
                    camLogRef.current = arr.slice(-299);
                }
            }
        } catch { /* ignore */ }
        log(`ARView mounted (route ${route && route.node_count ? `${route.node_count - 1} stops` : 'none'} · gps ${userLocation ? 'fix' : 'none'} · secure=${window.isSecureContext} · videoEl=${!!videoRef.current} · build=${APP_TAG})`);
        // Full UA on its own line: the first line truncates at 60 chars, which
        // is exactly where the browser identity sits, and we need to know
        // which engine is gating the sensors.
        log(`UA ${navigator.userAgent} · focus=${document.hasFocus()} · visibility=${document.visibilityState}`);
        return () => {
            window.removeEventListener('error', onErr);
            window.removeEventListener('unhandledrejection', onErr);
            streamRef.current?.getTracks().forEach((t) => t.stop());
            streamRef.current = null;
            if (videoRef.current) {
                videoRef.current.srcObject = null;
            }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Brave Shields blocks motion sensors by default — detect it so the
    // menu can say exactly what to toggle.
    useEffect(() => {
        let cancelled = false;
        try {
            const probe = navigator.brave?.isBrave?.();
            if (probe && typeof probe.then === 'function') {
                probe.then((v) => { if (!cancelled) setIsBrave(!!v); }).catch(() => {});
            }
        } catch {
            // Not Brave (or detection blocked) — nothing to do.
        }

        return () => { cancelled = true; };
    }, []);

    const hasCompassPrompt = typeof DeviceOrientationEvent !== 'undefined'
        && typeof DeviceOrientationEvent.requestPermission === 'function';

    // Latest pitch/roll mirror for the HUD text and the heading fallback.
    const motionRef = useRef({ yaw: null, pitch: null, roll: null, betaRaw: null });

    // Single compass convention: heading normalized to [-180, 180),
    // 0° = north. No filter, no bias — the raw reading is the value.
    const ingestHeading = (rawIn) => {
        if (rawIn === null || rawIn === undefined || !Number.isFinite(rawIn)) return;
        dataRef.current.heading = norm180(rawIn);
        lastHeadingAtRef.current = performance.now();
        setOrientStatus((s) => (s === 'live' ? s : 'live'));
    };

    // Orientation-event liveness (debug panel): counted for every event,
    // including ones we deliberately ignore.
    const noteOrientEvent = () => {
        orientEventsRef.current += 1;
        lastOrientAtRef.current = performance.now();
    };

    // Shared per-event bookkeeping: full 3D orientation for the render loop.
    const trackOrientEvent = (e) => {
        // Fresh data reached the camera → the stream is healthy, so relax
        // the watchdog back to its base silence budget.
        lastRotAtRef.current = performance.now();
        if (Number.isFinite(e.beta) && Number.isFinite(e.gamma)) lastClassicAxesAtRef.current = performance.now();
        orientRearmGapRef.current = 3000;
        deviceOrientationRef.current = {
            alpha: e.alpha,
            beta: e.beta,
            gamma: e.gamma,
            webkitCompassHeading: e.webkitCompassHeading ?? null,
            t: performance.now(),
        };
        const compassRes = compassWatcherRef.current.update(headingAccuracyFromEvent(e));
        if (compassRes.changed) setCompassWarn(compassRes.warning);
        const m = motionRef.current;
        m.betaRaw = e.beta ?? null;
        m.pitch = e.beta === null || e.beta === undefined ? null : clamp(Number(e.beta), -89, 89);
        m.roll = e.gamma ?? null;
        // NOTE: m.yaw is owned by the render loop (camera azimuth, clockwise).
        // This used to write the RAW alpha here (counter-clockwise, i.e. the
        // mirror image about north), so the 2D cone — which samples m.yaw —
        // flipped between the true azimuth and its mirror at the event rate.
        if (e.alpha !== null && e.alpha !== undefined) m.alphaRaw = norm180(Number(e.alpha));
    };

    // Compass listeners (attached on mount so values warm up before Start).
    // 'deviceorientationabsolute' feeds the heading once it shows up;
    // plain 'deviceorientation' only bootstraps devices that never fire it.
    // Until 'absolute' is confirmed, a frame cutover would flip yaw 180°.
    const absoluteSeenRef = useRef(false);

    // Chrome/Android stops delivering deviceorientation after the first few
    // events and only hands them over again when the listener pair is
    // re-attached (observed: ev=0→4 at attach, then 26 s of silence until the
    // next tap re-registered the sensor). So attachment is a function, not a
    // one-off effect: everything that can stall calls rearmOrientation().
    const attachOrientation = () => {
        if (orientHandlersRef.current) return false;

        // Any axis the render loop can actually use. β/γ come from the
        // accelerometer + gyroscope and arrive even when α (magnetometer yaw)
        // is null — which is precisely what this device delivers: 16 events,
        // every one rejected. Both handlers used to bail out before
        // trackOrientEvent() when no heading could be derived, so
        // deviceOrientationRef stayed null, the camera saw no tilt at all,
        // and lastRotAtRef never moved — which made the watchdog re-arm the
        // same useless listener pair over and over.
        const hasAxes = (e) => Number.isFinite(e?.alpha) || Number.isFinite(e?.beta)
            || Number.isFinite(e?.gamma) || Number.isFinite(e?.webkitCompassHeading);

        // Record the first payload we ever see, exactly as Chrome hands it
        // over. Deliberately does not touch noteOrientEvent (called below), so
        // it cannot skew the event count this is meant to explain.
        const noteFirst = (e, kind) => {
            if (firstOrientPayloadRef.current !== null) return;
            let keys = '?';
            try { keys = Object.keys(e ?? {}).join(',') || '(none)'; } catch { keys = '(unreadable)'; }
            const val = (v) => (v === null ? 'null' : v === undefined ? 'undefined'
                : typeof v === 'number' ? (Number.isFinite(v) ? v.toFixed(1) : String(v)) : typeof v);
            firstOrientPayloadRef.current = { kind, keys, a: val(e?.alpha), b: val(e?.beta), g: val(e?.gamma), w: val(e?.webkitCompassHeading) };
            log(`first orient event [${kind}] type=${e?.constructor?.name ?? '?'} `
                + `α=${val(e?.alpha)} β=${val(e?.beta)} γ=${val(e?.gamma)} webkitCompassHeading=${val(e?.webkitCompassHeading)} `
                + `ownKeys=${keys} → hasAxes=${hasAxes(e)}`);
        };

        const onAbsolute = (e) => {
            noteOrientEvent();
            noteFirst(e, 'absolute');
            classicEventsRef.current += 1;
            const usableOrientation = hasAxes(e);
            if (usableOrientation) {
                // Lock the active pose to the absolute stream as soon as that
                // stream carries any orientation data. Do not wait for a
                // compass heading: beta/gamma-only absolute events must not be
                // overwritten by a relative stream with a different north frame.
                if (!absoluteSeenRef.current) resnapYawRef.current = true;
                absoluteSeenRef.current = true;
                trackOrientEvent(e);
            }
            const heading = toHeading(e);
            if (heading === null || Number.isNaN(heading)) {
                // A previous relative heading is not valid once an absolute
                // stream takes ownership but has no yaw of its own. Let the
                // existing GPS-route aim fallback handle yaw until absolute
                // heading data arrives, while retaining absolute tilt data.
                if (usableOrientation && dataRef.current.sensorSource === 'relative-fallback') {
                    dataRef.current.heading = null;
                    dataRef.current.sensorSource = 'absolute-tilt-only';
                    setOrientStatus('waiting');
                }
                return;
            }
            absoluteSeenRef.current = true;
            ingestHeading(heading);
            dataRef.current.sensorSource = 'absolute';
        };

        const onRelative = (e) => {
            noteOrientEvent();
            noteFirst(e, 'relative');
            // Keep this diagnostic only. Once an absolute reading exists,
            // relative sensor values may use a different north reference and
            // must never overwrite the pose currently driving the 3D camera.
            dataRef.current.headingRelDebug = toHeading(e);
            if (Number.isFinite(e.alpha) && Number.isFinite(e.beta) && Number.isFinite(e.gamma)) {
                relOrientRef.current = { alpha: e.alpha, beta: e.beta, gamma: e.gamma, t: performance.now() };
            }
            if (absoluteSeenRef.current) return;
            if (hasAxes(e)) trackOrientEvent(e);
            // Bootstrap only: some devices never fire 'absolute' at all.
            const heading = toHeading(e);
            if (heading === null || Number.isNaN(heading)) return;
            ingestHeading(heading);
            dataRef.current.sensorSource = 'relative-fallback';
        };

        window.addEventListener('deviceorientationabsolute', onAbsolute, true);
        window.addEventListener('deviceorientation', onRelative, true);
        orientHandlersRef.current = { onAbsolute, onRelative };
        orientAttachAtRef.current = performance.now();
        return true;
    };

    const detachOrientation = () => {
        const h = orientHandlersRef.current;
        if (!h) return;
        window.removeEventListener('deviceorientationabsolute', h.onAbsolute, true);
        window.removeEventListener('deviceorientation', h.onRelative, true);
        orientHandlersRef.current = null;
    };

    // A fresh pair always produces an initial sample within ~1 s (that is the
    // ev=0→4 burst at mount), so re-attaching is what un-freezes the camera.
    // absoluteSeenRef is deliberately NOT reset: flipping back to the relative
    // stream mid-session would rotate yaw by up to 180°.
    const rearmOrientation = (why) => {
        detachOrientation();
        attachOrientation();
        orientRearmAtRef.current = performance.now();
        log(`compass listeners re-armed (${why}) · ev=${orientEventsRef.current}`);
    };

    // Silent for longer than the current budget → the stream has stalled, not
    // merely paused because the phone is still. Back the budget off if the
    // re-arm does not bring data back, so a hopeless device does not churn.
    const checkOrientStall = () => {
        const now = performance.now();
        const sinceRot = now - lastRotAtRef.current;
        if (sinceRot < orientRearmGapRef.current) return;
        if (now - orientRearmAtRef.current < 3000) return;
        if (now - orientAttachAtRef.current < 4000) return; // let the first attach settle
        const everFed = lastRotAtRef.current > 0;
        orientRearmGapRef.current = Math.min(orientRearmGapRef.current * 2, 20000);
        rearmOrientation(everFed
            ? `no camera data for ${Math.round(sinceRot)}ms`
            : `no sensor data after ${Math.round(sinceRot)}ms`);
    };

    // ── Generic Sensor API fallback ───────────────────────────────────
    // v9 log, first thing every time: `orient ev=0` for 26 s — listeners
    // attached, permission GRANTED, two timer re-arms — and the stream only
    // started the instant the page got focus. A re-attach from a timer cannot
    // restart it, so when the classic stream has never produced an event we
    // switch to AbsoluteOrientationSensor, which is a different API with a
    // different permission model, and feed the same heading + β fallback the
    // render loop already understands.
    const stopGenericSensor = () => {
        const s = genericSensorRef.current;
        genericSensorRef.current = null;
        if (s) {
            try { s.stop(); } catch { /* already stopped */ }
        }
    };

    const startGenericSensor = () => {
        // 'error' is deliberately restartable — but only from a gesture (see
        // the pointerdown handler), so a permanent denial cannot spam a fresh
        // attempt and a fresh log line once a second from the heartbeat.
        if (genericStateRef.current !== 'idle' && genericStateRef.current !== 'error') return;
        stopGenericSensor(); // clear a half-dead previous attempt before retrying
        if (typeof AbsoluteOrientationSensor === 'undefined') {
            genericStateRef.current = 'unsupported';
            log('generic sensor: AbsoluteOrientationSensor not in this browser — classic stream is the only option');
            return;
        }
        genericStateRef.current = 'starting';
        try {
            const sensor = new AbsoluteOrientationSensor({ frequency: 60 });
            const fwd = new THREE.Vector3();
            const q = new THREE.Quaternion();
            sensor.addEventListener('reading', () => {
                const raw = sensor.quaternion; // [x, y, z, w]
                if (!raw || raw.length !== 4) return;
                // Device frame: x right, y top, z out of the screen — so the
                // rear camera looks along −z. World frame: x East, y North,
                // z Up. Rotating −z gives the direction the view points.
                q.set(raw[0], raw[1], raw[2], raw[3]);
                fwd.set(0, 0, -1).applyQuaternion(q);
                const heading = norm180((Math.atan2(fwd.x, fwd.y) * 180) / Math.PI);
                // World frame is z = UP, so pitch comes from fwd.z. (It used
                // to read fwd.y — the NORTH component — which made pitch depend
                // on the compass heading.)
                const pitchDeg = (Math.asin(clamp(fwd.z, -1, 1)) * 180) / Math.PI;
                noteOrientEvent();
                lastRotAtRef.current = performance.now();
                orientRearmGapRef.current = 3000;
                ingestHeading(heading);
                // Only claim the source label while the classic stream is
                // genuinely silent — once it wakes, 'absolute' must win or the
                // 60 Hz generic readings would hide it in every heartbeat.
                if (classicEventsRef.current === 0) {
                    dataRef.current.sensorSource = 'generic (AbsoluteOrientationSensor)';
                }
                // The render loop derives camera pitch as (β − 90)°, and
                // deviceorientation reports β = 90 upright / 0 flat, which is
                // exactly 90 + camera pitch.
                genericQuatRef.current = { raw: [raw[0], raw[1], raw[2], raw[3]], t: performance.now() };
                // Single writer: only drive pitch while the classic stream is silent.
                if (performance.now() - lastClassicAxesAtRef.current > 1000) {
                    motionRef.current.betaRaw = 90 + pitchDeg;
                }
                if (genericReadingsLoggedRef.current < 3) {
                    genericReadingsLoggedRef.current += 1;
                    log(`generic sensor #${genericReadingsLoggedRef.current} → heading ${heading.toFixed(1)}° pitch ${pitchDeg.toFixed(1)}° (fwd ${fwd.x.toFixed(2)},${fwd.y.toFixed(2)},${fwd.z.toFixed(2)}) — compare with the classic stream's heading once it wakes`);
                }
            });
            sensor.addEventListener('error', (e) => {
                const name = e?.error?.name ?? e?.message ?? 'unknown';
                genericStateRef.current = 'error';
                stopGenericSensor();
                log(`generic sensor: error — ${name} (will retry on the next touch)`);
            });
            // Register the sensor before starting it so an error raised from
            // inside start() can still find it and tear it down.
            genericSensorRef.current = sensor;
            sensor.start();
            // If that error already fired, the handler has moved us to
            // 'error' — do not clobber it with 'running' and strand a dead
            // sensor that no retry will ever clean up.
            if (genericStateRef.current !== 'starting') return;
            genericStateRef.current = 'running';
            log('generic sensor: started (AbsoluteOrientationSensor) — feeding heading while deviceorientation stays silent');
        } catch (err) {
            genericStateRef.current = 'error';
            log(`generic sensor: could not start — ${err.name}: ${err.message} (will retry on the next touch)`);
        }
    };

    useEffect(() => () => stopGenericSensor(), []);

    // Read the sensor + camera permission states back from the page. Android
    // Chrome has NO JS prompt for deviceorientation — a denial made earlier in
    // site settings is invisible from the code, and the only symptom is events
    // whose every field is null. This is the one signal that tells "denied"
    // apart from "no magnetometer on this device".
    useEffect(() => {
        const probe = [
            ['acc', 'accelerometer'],
            ['gyro', 'gyroscope'],
            ['mag', 'magnetometer'],
            ['cam', 'camera'],
        ];
        if (typeof navigator.permissions?.query !== 'function') {
            sensorPermRef.current = 'permissions API unavailable';

            return;
        }
        Promise.all(probe.map(([tag, name]) => navigator.permissions.query({ name })
            .then((s) => `${tag}:${s.state}`)
            .catch(() => `${tag}:n/a`)))
            .then((parts) => { sensorPermRef.current = parts.join(' '); })
            .catch(() => { sensorPermRef.current = 'probe failed'; });
    }, []);

    useEffect(() => {
        absoluteSeenRef.current = false;
        attachOrientation();
        return () => detachOrientation();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // React defers useEffect to a later task, but the render that mounts this
    // view runs inside the tap that opened the 3D screen. Registering the
    // listeners here as well (idempotent — attachOrientation() refuses to run
    // twice) keeps the first attach in the same task as a real user gesture,
    // which is the one context where gesture-gated browsers hand sensors over.
    if (!orientHandlersRef.current) attachOrientation();

    // Restarting the stream is what unsticks the camera — but a re-attach from
    // a plain timer is not the same thing as one from a real gesture (Chrome
    // may only hand sensors over while the page has activation), and your log
    // showed the freeze starting right as getUserMedia opened. So arm the
    // re-attach at every moment that is interactive, not just on the
    // watchdog's schedule. The guards make it a no-op while the stream is
    // healthy, so it never churns listeners during normal use.
    const maybeRearmIfQuiet = (why) => {
        const now = performance.now();
        const quiet = now - lastRotAtRef.current;
        if (quiet < 1500) return;
        if (now - orientAttachAtRef.current < 1500) return;
        rearmOrientation(`${why} after ${Math.round(quiet)}ms quiet`);
    };

    useEffect(() => {
        const onPointer = () => {
            // A gesture is the one context where a failed sensor start can be
            // retried (permission prompts need activation).
            if (genericStateRef.current === 'error') startGenericSensor();
            // If the classic stream has never produced an event, give it one
            // more chance even while the generic fallback keeps the camera
            // alive — a touch is the only thing that has ever restarted it on
            // this device, and it carries full 3-axis data.
            if (classicEventsRef.current === 0
                && orientHandlersRef.current
                && performance.now() - orientRearmAtRef.current > 2000) {
                rearmOrientation('touch — classic stream still silent');
                return;
            }
            maybeRearmIfQuiet('screen touched');
        };
        const onFocus = () => {
            log(`window focus GAINED (hasFocus=${document.hasFocus()})`);
            maybeRearmIfQuiet('page focused');
        };
        const onBlur = () => {
            // The v9 log recovered on exactly this event, so record who let
            // go of the window and when — an unfocused page never said so.
            log('window focus LOST — browsers suspend sensors until focus returns');
        };
        const onVisible = () => {
            log(`visibility → ${document.visibilityState}`);
            if (!document.hidden) maybeRearmIfQuiet('page visible');
        };
        window.addEventListener('pointerdown', onPointer, true);
        window.addEventListener('touchstart', onPointer, true);
        window.addEventListener('focus', onFocus);
        window.addEventListener('blur', onBlur);
        window.addEventListener('pageshow', onFocus);
        document.addEventListener('visibilitychange', onVisible);
        return () => {
            window.removeEventListener('pointerdown', onPointer, true);
            window.removeEventListener('touchstart', onPointer, true);
            window.removeEventListener('focus', onFocus);
            window.removeEventListener('blur', onBlur);
            window.removeEventListener('pageshow', onFocus);
            document.removeEventListener('visibilitychange', onVisible);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // ── Desktop free-roam input: WASD + mouse look ────────────────────
    // Attached for the whole session on window/document rather than on the
    // Three canvas, because that canvas is pointer-events:none (the video
    // underneath stays tappable on phones). The freeRoam flag gates only
    // what the handlers mutate, so the listeners cost nothing on mobile.
    useEffect(() => {
        const keys = keysRef.current;

        // Returns true for keys this feature owns, so the caller can decide
        // whether to swallow the default (scrolling on Space, for instance).
        const trackKey = (e, down) => {
            if (!freeRoamRef.current || followTestRef.current) return false;
            switch (e.code) {
                case 'KeyW': case 'ArrowUp': keys.w = down; break;
                case 'KeyA': case 'ArrowLeft': keys.a = down; break;
                case 'KeyS': case 'ArrowDown': keys.s = down; break;
                case 'KeyD': case 'ArrowRight': keys.d = down; break;
                case 'KeyC': keys.c = down; break;
                case 'Space': keys.space = down; break;
                case 'ShiftLeft': case 'ShiftRight': keys.shift = down; break;
                default: return false;
            }
            return true;
        };
        const onKeyDown = (e) => {
            if (e.repeat) return;
            if (trackKey(e, true)) e.preventDefault();
        };
        const onKeyUp = (e) => {
            if (trackKey(e, false)) e.preventDefault();
        };
        // Losing focus with a key held is the classic "walks forever after
        // alt-tab" bug — clear everything the moment the window goes away.
        const clearKeys = () => {
            keys.w = keys.a = keys.s = keys.d = keys.c = keys.space = keys.shift = false;
            touchLookRef.current = null;
        };

        const isLocked = () => document.pointerLockElement === lookLayerRef.current;
        const onLockChange = () => {
            const locked = isLocked();
            setPointerLocked(locked);
            if (!locked) clearKeys();
        };
        const onLockError = () => {
            setPointerLocked(false);
            log('pointer lock refused — click the view to try again');
        };
        const onLookMove = (e) => {
            if (!isLocked()) return;
            const look = lookRef.current;
            // Right/down move the camera the way the crosshair implies:
            // mouse-right turns east (compass azimuth up, so −yaw).
            look.yaw -= e.movementX * FREE_ROAM_LOOK;
            look.pitch -= e.movementY * FREE_ROAM_LOOK;
            // Wrap yaw — a long session must not bleed float precision.
            if (look.yaw > Math.PI) look.yaw -= Math.PI * 2;
            else if (look.yaw < -Math.PI) look.yaw += Math.PI * 2;
            look.pitch = clamp(look.pitch, -FREE_ROAM_PITCH_MAX, FREE_ROAM_PITCH_MAX);
        };

        window.addEventListener('keydown', onKeyDown);
        window.addEventListener('keyup', onKeyUp);
        window.addEventListener('blur', clearKeys);
        window.addEventListener('mousemove', onLookMove);
        document.addEventListener('pointerlockchange', onLockChange);
        document.addEventListener('pointerlockerror', onLockError);
        return () => {
            window.removeEventListener('keydown', onKeyDown);
            window.removeEventListener('keyup', onKeyUp);
            window.removeEventListener('blur', clearKeys);
            window.removeEventListener('mousemove', onLookMove);
            document.removeEventListener('pointerlockchange', onLockChange);
            document.removeEventListener('pointerlockerror', onLockError);
            clearKeys();
            if (document.pointerLockElement === lookLayerRef.current) document.exitPointerLock();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Closing the 3D view must not leave the parent holding a virtual fix —
    // otherwise the 2D map and the route stay frozen at wherever the
    // presenter last walked to.
    useEffect(() => () => {
        if (typeof onWalkedPositionRef.current === 'function') onWalkedPositionRef.current(null);
    }, []);

    // Three.js scene + render loop: camera feed background + node dots.
    useEffect(() => {
        if (!started || !mountRef.current) return undefined;
        const mount = mountRef.current;
        const width = mount.clientWidth || window.innerWidth;
        const height = mount.clientHeight || window.innerHeight;

        const scene = new THREE.Scene();
        // Far plane 5000 (not 1000): a single bad GPS jump can teleport
        // the camera kilometres out — with 1000 everything past it clips
        // and all nodes vanish until fixes recover.
        const camera = new THREE.PerspectiveCamera(60, width / height, 0.1, 5000);
        // The camera must be in the scene graph for camera-space children to
        // render. The off-screen pointer is one: a 3D arrow that orbits the
        // view and aims at the nearest stop while it is out of frame.
        scene.add(camera);
        const offArrow = createOffscreenArrow();
        // World-frame wall segments, rebuilt only when the borders or the
        // scene anchor change (never per frame).
        let wallCache = { borders: null, anchorKey: '', segs: [] };
        camera.add(offArrow.group);
        // antialias:false — halves GPU memory on old iPhones (camera +
        // antialiased WebGL together can get the tab killed by the OS).
        let renderer;
        try {
            renderer = new THREE.WebGLRenderer({ alpha: true, antialias: false });
        } catch (err) {
            log(`WebGL unavailable — running video-only: ${err.name || err.message}`);
            return undefined;
        }
        renderer.setSize(width, height);
        // Cap pixel ratio at 1.5 — the single biggest GPU win on mobile.
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
        renderer.setClearColor(0x000000, 0); // transparent: video shows through
        renderer.setClearAlpha(0);
        renderer.domElement.style.background = 'transparent';
        renderer.domElement.style.position = 'absolute';
        renderer.domElement.style.inset = '0';
        renderer.domElement.style.pointerEvents = 'none';
        renderer.domElement.addEventListener('webglcontextlost', (e) => {
            e.preventDefault();
            log('WebGL context LOST — 3D frozen, video should still show');
            statsRef.current.ctxLost = true;
            setCtxLost(true);
        });
        renderer.domElement.addEventListener('webglcontextrestored', () => {
            log('WebGL context restored');
            statsRef.current.ctxLost = false;
            setCtxLost(false);
        });
        rendererRef.current = renderer;
        mount.appendChild(renderer.domElement);

        // ── Lighting ──────────────────────────────────────────────────
        // The marker dots are MeshBasic (unlit), so these exist purely for
        // the Phong materials on the route tube and the destination pin —
        // without them the glow would render as flat black. Neutral, matching
        // the reference's two-light rig recoloured to this palette.
        scene.add(new THREE.AmbientLight(0x5a2028, 1.5));
        const keyLight = new THREE.DirectionalLight(0xffffff, 1.7);
        keyLight.position.set(30, 50, 20);
        scene.add(keyLight);
        const fillLight = new THREE.DirectionalLight(0xe8eefc, 0.9);
        fillLight.position.set(-30, 30, -30);
        scene.add(fillLight);
        // Distance haze so far markers sink into the feed instead of floating
        // over it. Low density: the route must stay readable hundreds of metres out.
        scene.fog = new THREE.FogExp2(HOLO.fog, 0.0025);

        const group = new THREE.Group();
        scene.add(group);
        // Sphere pool: one mesh per route node (2 draw calls each: fill + outline).
        const initialPathLen = dataRef.current.route && dataRef.current.route.path ? dataRef.current.route.path.length : 0;
        const poolSize = Math.min(64, Math.max(MAX_ROUTE_SPHERES, initialPathLen));
        const spherePool = createSpherePool(poolSize, NODE_RADIUS, ROUTE_COLOR, 0xffffff, 12);
        group.add(spherePool.group);
        // Destination hologram: solid 3D pin + ground ripple (replaces the
        // plain sphere, keeping the same position/visible/scale API).
        const destPin = createDestinationPin({ headRadius: DEST_RADIUS });
        group.add(destPin.group);
        // Line connection: glowing tube + marching chevrons along the route.
        const holoPath = createHoloPath();
        group.add(holoPath.group);
        // The route as a road on the ground with chevrons painted on it (the 3D view's route in the camera).
        const road = createGroundRoad();
        group.add(road.group);
        // Campus buildings: invisible occluders (hide what is behind their walls),
        // door markers and names, same world frame as the route. Rebuilt only when buildings or the anchor change.
        const buildingLayer = createBuildingLayer();
        group.add(buildingLayer.group);
        // Height of the current floor above the ground: the camera is at eye
        // height on THIS floor, the buildings are modelled from the ground.
        const floorLiftM = () => Math.max(0, Number(dataRef.current.floor) || 0) * STOREY_M;
        const drawBuildingsFrame = () => {
            if (!anchorRef.current) return;
            buildingLayer.sync(dataRef.current.buildings, anchorRef.current);
            buildingLayer.group.position.y = -floorLiftM();
            buildingLayer.tick(camera);
        };
        // Inclined staircases between floors, drawn at the admin's angle.
        const stairViz = createStairViz();
        group.add(stairViz.group);
        // Spheres stay in the pool as invisible position anchors only.
        spherePool.group.visible = false;
        // One arrow on every route node, each pointing at the node it connects to.
        const nodeArrows = createNavArrowPool(poolSize);
        group.add(nodeArrows.group);
        // Spheres stay in the pool as invisible position anchors only.
        spherePool.group.visible = false;
        // (The pixel-width Line2 route ribbon that used to sit here as a
        // second, dashed copy of the path has been removed — the tube above is
        // the connector now, so the route is drawn exactly once.)

        // Match the three.js FOV to what the user actually sees: the camera's
        // real stream shape + the object-fit:cover crop (see cameraFov.js).
        // Without this a fixed 60° makes dots slide against the scene as the
        // phone turns. Re-run whenever the stream or the screen shape changes.
        const applyFov = () => {
            const v = videoRef.current;
            const ts = trackSettingsRef.current;
            let vw = v && v.videoWidth;
            let vh = v && v.videoHeight;
            const cw = mount.clientWidth || window.innerWidth;
            const ch = mount.clientHeight || window.innerHeight;
            if (!(vw > 0 && vh > 0) && ts && ts.width > 0 && ts.height > 0) {
                // Track settings are often reported in sensor-landscape terms;
                // the picture is shown upright, so match the screen's orientation.
                vw = ts.width;
                vh = ts.height;
                if ((ch > cw) !== (vh > vw)) [vw, vh] = [vh, vw];
            }
            const fov = effectiveVerticalFov({
                videoW: vw, videoH: vh, containerW: cw, containerH: ch,
                longSideFovDeg: getLongSideFovDeg(),
            });
            if (fov === null || Math.abs(fov - camera.fov) < 0.05) return;
            camera.fov = fov;
            camera.updateProjectionMatrix();
            log(`camera FOV → ${fov.toFixed(1)}° vertical (video ${vw}x${vh}, view ${cw}x${ch})`);
        };
        const onResize = () => {
            const w = mount.clientWidth || window.innerWidth;
            const h = mount.clientHeight || window.innerHeight;
            camera.aspect = w / h;
            camera.updateProjectionMatrix();
            renderer.setSize(w, h);
            applyFov();
        };
        window.addEventListener('resize', onResize);
        window.addEventListener('orientationchange', onResize);
        const fovVideo = videoRef.current;
        if (fovVideo) {
            fovVideo.addEventListener('loadedmetadata', applyFov);
            fovVideo.addEventListener('resize', applyFov);
        }
        applyFov();

        let raf = 0;
        let camInit = false;
        let yawSnapped = false;
        // Learn the compass error from the GPS course while walking.
        // Disable with localStorage.arAutoYaw = "0".
        const gyroFuseEnabled = (() => {
            try { return window.localStorage.getItem('arGyroFuse') !== '0'; } catch { return true; }
        })();
        const autoYawEnabled = (() => {
            try { return window.localStorage.getItem('arAutoYaw') !== '0'; } catch { return true; }
        })();
        // Previous frame's free-roam flag, so leaving free-roam can snap the
        // camera back onto the GPS fix instead of gliding in from wherever
        // the keyboard last stopped (potentially hundreds of metres away).
        let wasFreeRoam = false;
        let lastFrameTime = performance.now();
        const _camFwd = new THREE.Vector3();
        const _camUp = new THREE.Vector3();
        let frameErrCount = 0;
        let frameErrLast = '';
        let frameErrLastT = 0;
        // FPS bookkeeping for the debug panel.
        let fpsFrames = 0;
        let fpsWindowStart = performance.now();
        // Tube rebuild bookkeeping: forced after every bake, otherwise
        // only when the walker has moved far enough to matter (> 0.3 m).
        let tubeDirty = true;
        let tubeHeadX = 0;
        let tubeHeadZ = 0;
        const clock = new THREE.Clock();
        // Scratch vectors for the off-screen pointer (project once per
        // frame — never allocate inside the loop).
        const offProj = new THREE.Vector3();
        const offCam = new THREE.Vector3();
        // Marker slots keyed by node id, not by route position: Dijkstra
        // re-anchors as the walker moves, and positional slots would shift
        // every node onto a new marker. Stable ids let a stop keep its mesh —
        // dropped stops dim to ghosts in place (see dimSlot), reconnecting
        // stops fade back up on the same mesh. midSlots maps mids[k] to its
        // pool slot for the per-frame loops below; ghostSlots are dimmed
        // slots awaiting reuse, oldest first.
        const slotNode = new Array(poolSize).fill(null);
        const ghostSlots = [];
        let midSlots = [];
        const midKey = (p) => String(p.id ?? p.type);
        // Previous bake's live route ids.
        let prevActiveIds = new Set();
        let prevBakeDest = null;

        const hideAllNodes = () => {
            // Route lost entirely: markers just go away, no burst effect.
            prevActiveIds = new Set();
            prevBakeDest = null;
            for (let k = 0; k < poolSize; k += 1) spherePool.hideSlot(k);
            for (let s = 0; s < poolSize; s += 1) slotNode[s] = null;
            ghostSlots.length = 0;
            midSlots = [];
            destPin.group.visible = false;
            holoPath.setPoints([]);
            road.setPoints([]);
            tubeDirty = true;
            statsRef.current.tubePts = 0;
        };

        const render = () => {
            raf = requestAnimationFrame(render);
            // Loop liveness + FPS for the debug panel — counted even while
            // waiting for a route/GPS fix, so "is the loop dead?" is answerable.
            const loopNow = performance.now();
            // Real seconds since the last frame, the same at 30, 60, 90, 120 or 144 Hz:
            // every easing below scales by it, none counts frames.
            const dt = Math.max(0.001, Math.min(0.25, (loopNow - lastFrameTime) / 1000));
            lastFrameTime = loopNow;
            fpsFrames += 1;
            if (loopNow - fpsWindowStart > 500) {
                statsRef.current.fps = (fpsFrames * 1000) / (loopNow - fpsWindowStart);
                fpsFrames = 0;
                fpsWindowStart = loopNow;
            }
            statsRef.current.totalFrames += 1;
            statsRef.current.lastFrameAt = loopNow;
            try {
                const data = dataRef.current;

                // ── Free-roam: the walked camera IS the user ──────────
                // Translate the walked world position back into a GPS fix
                // before anything below reads it. That single substitution
                // is what makes free-roam a first-class citizen rather than
                // a camera hack: arrival detection, per-node distances, the
                // closest-node search, the YOU header and the 2D map all
                // keep consuming an ordinary {latitude, longitude} user.
                if (freeRoamRef.current && freePosRef.current.seeded && anchorRef.current) {
                    const a = anchorRef.current;
                    const fp = freePosRef.current;
                    const ll = enuToLatLon(a.latitude, a.longitude, fp.x, fp.z);
                    data.user = {
                        latitude: ll.latitude,
                        longitude: ll.longitude,
                        elevation: Number.isFinite(a.elevation) ? a.elevation : 0,
                        accuracy: 0,
                        source: 'freeroam',
                    };
                    // `userLocation` remains the real GPS fix so normal tracking
                    // can resume when free-roam ends. The minimap gets its own
                    // low-cost Leaflet update from this live virtual fix instead.
                    syncMiniMapFix(data.user);
                }
                // Test walk in the 3D view: the walked position replaces GPS for
                // everything below (guidance, arrival, distances), and the parent
                // re-routes from it, as it does for free roam.
                if (followTestRef.current && testPosRef.current) {
                    const tp = testPosRef.current;
                    data.user = {
                        latitude: tp.latitude, longitude: tp.longitude,
                        elevation: 0, accuracy: 0, source: 'test',
                    };
                    reportWalked(tp.latitude, tp.longitude);
                }

                const heading = data.heading;
                const rt = data.route;
                const user = data.user;
                const userValid = !!user && Number.isFinite(user.latitude) && Number.isFinite(user.longitude);
                if (!rt || !rt.path || rt.path.length === 0 || !userValid) {
                    hideAllNodes();
                    stairViz.sync([], '');
                    statsRef.current.drawn = 0;
                    statsRef.current.destVisible = false;
                    // Keep marker fades animating while there is no route, so
                    // dismissals ease out instead of freezing mid-fade.
                    spherePool.tick(dt);
                    if (hudRef.current) {
                        hudRef.current.textContent = userValid ? 'Waiting for route…' : 'Waiting for GPS fix…';
                    }
                    const waitKey = userValid ? 'wait-route' : 'wait-gps';
                    if (guideCacheRef.current !== waitKey) {
                        guideCacheRef.current = waitKey;
                        if (instrRef.current) instrRef.current.textContent = userValid ? 'Waiting for a route' : 'Finding your position';
                        if (instrSubRef.current) instrSubRef.current.textContent = userValid ? 'Pick a destination on the map.' : 'Hold the phone up with a clear view of the sky.';
                        if (stopCountRef.current) stopCountRef.current.textContent = '-';
                    }
                    if (closestCacheRef.current !== '|') {
                        closestCacheRef.current = '|';
                        if (closestRef.current) closestRef.current.textContent = '-';
                        if (closestNodeRef.current) closestNodeRef.current.textContent = '';
                    }
                    if (dirCacheRef.current !== 'hidden') {
                        dirCacheRef.current = 'hidden';
                        if (dirBannerRef.current) dirBannerRef.current.style.display = 'none';
                    }
                    offArrow.setVisible(false);
                    drawBuildingsFrame();
                    if (!followMainRef.current) renderer.render(scene, camera);
                    return;
                }

                const t = clock.getElapsedTime();
                const nowMs = performance.now();
                const path = rt.path;
                // Floor filter for everything the walker sees: route markers,
                // the destination pin and the nearest-stop guidance. Routing
                // itself still uses the full node list (floor-aware
                // connectivity is not modelled), but a stop on another floor
                // is never drawn. Index 0 is the `__user__` pseudo node and is
                // always kept so `splitRemaining(path, 1, …)` still skips it.
                const floorLevel = Number.isFinite(data.floor) ? data.floor : null;
                const onFloor = floorLevel === null
                    ? () => true
                    : (p) => floorOf(p) === floorLevel;
                const floorPath = floorLevel === null
                    ? path
                    : path.filter((p, i) => i === 0 || onFloor(p));

                // Monotonic target pointer with hysteresis: walk forward past
                // reached stops (8 m) but never step back, so GPS jitter around
                // the threshold can't flap the HUD between nodes.
                const destId = path.length ? String(path[path.length - 1].id ?? path[path.length - 1].type) : '';
                if (data.destKey !== destId) {
                    data.destKey = destId;
                    data.targetIdx = 1;
                    if (arrivedRef.current) {
                        arrivedRef.current = false;
                        setArrived(null);
                        if (voiceRef.current) voiceRef.current = createVoiceGuide(say); // a new route: speak again
                    }
                }
                // A re-route (it re-runs from where you are every few metres)
                // is a new list of stops starting at YOU: count from its first
                // stop again. Keeping the old number skipped the nearest stops
                // and pointed at one far down the new route.
                if (data.pathKey !== path) {
                    data.pathKey = path;
                    data.targetIdx = 1;
                }
                let idx = data.targetIdx || 1;
                if (idx < 1) idx = 1;
                if (idx > path.length - 1) idx = path.length - 1;

                const lines = [];
                // Stops (and the destination) count as reached only on the
                // student's floor (routeProgress.js): under a floor-2 room on
                // the ground floor is not "arrived".
                const hereFloor = Number.isFinite(onFloorRef.current) ? onFloorRef.current : null;
                const step = advanceAlongRoute(path, idx, user, hereFloor,
                    (u, p) => bearingAndDistance(u.latitude, u.longitude, p.latitude, p.longitude).dist);
                if (step.arrived) lines.push('Arrived');
                idx = step.idx;
                data.targetIdx = idx;

                // Free-roam supplies its own orientation, so neither the
                // "waiting for sensor" nor the "sensor quiet" warning is
                // meaningful — showing them would just read as a fault.
                const freeRoam = freeRoamRef.current;
                // Switched off: force a re-snap onto the fix rather than
                // easing back from a walked position, and tell the parent to
                // forget the virtual fix so the route re-anchors to GPS.
                if (wasFreeRoam && !freeRoam) {
                    camInit = false;
                    reportWalked(null, null, true);
                }
                wasFreeRoam = freeRoam;
                const preview = !freeRoam && (heading === null || heading === undefined);
                if (preview) {
                    // Say WHY, not merely that it is waiting: "no events at all"
                    // and "events arrived but none carried a heading" are
                    // different faults and the old "Waiting for…" line showed
                    // for both. The raw axis values decide the fix — alpha null
                    // with live beta/gamma means the magnetometer yaw is gone
                    // while tilt is fine, all three null means the sensors never
                    // cleared the permission gate.
                    const ev = orientEventsRef.current;
                    const o = deviceOrientationRef.current;
                    const r = (v) => (Number.isFinite(v) ? Math.round(v) : '-');
                    const ax = o
                        ? `a=${r(o.alpha)} b=${r(o.beta)} g=${r(o.gamma)}`
                        : 'a/b/g = -';
                    const gs = genericStateRef.current;
                    lines.push(ev > 0
                        ? `No compass: ${ev} event(s), none carried a heading (${ax}). ${gs === 'running' ? 'Trying AbsoluteOrientationSensor…' : 'Facing the route.'}`
                        : `No orientation sensor events (${ax}). Allow motion sensors, then tap to retry.`);
                    // The permission states are what decide the fix: a "denied"
                    // here means Chrome will never re-prompt and the fix is in
                    // site settings, not in this code.
                    lines.push(`Sensors: ${sensorPermRef.current}`);
                } else if (!freeRoam && lastRotAtRef.current) {
                    const quiet = performance.now() - lastRotAtRef.current;
                    if (quiet > 1500) {
                        lines.push(`Sensor quiet ${Math.round(quiet / 1000)}s. Recovering…`);
                    }
                }

                const { mids, dest } = splitRemaining(floorPath, 1, poolSize);
                const destNode = floorPath[floorPath.length - 1];

                // Ensure source origin anchor exists (first GPS fix)
                if (!anchorRef.current) {
                    anchorRef.current = {
                        latitude: user.latitude,
                        longitude: user.longitude,
                        elevation: Number.isFinite(user.elevation) ? user.elevation : 0,
                    };
                }
                const anchor = anchorRef.current;

                // One stable ENU frame is shared by every visual and the camera.
                // Rebase the whole scene only if that session anchor changes;
                // do not move the markers into a live-GPS frame while other
                // renderer state (camera easing, line effects and free-roam) is
                // still expressed in the original frame.
                const anchorPosKey = `${anchor.latitude.toFixed(6)},${anchor.longitude.toFixed(6)}`;
                const coordinateKey = (p) => {
                    const lat = Number(p?.latitude ?? p?.lat);
                    const lng = Number(p?.longitude ?? p?.lng);
                    const elev = Number.isFinite(Number(p?.elevation)) ? Number(p.elevation) : 0;
                    return `${String(p?.id ?? p?.type)}@${lat.toFixed(6)},${lng.toFixed(6)},${elev.toFixed(1)}`;
                };
                const nodeKey = mids.map(coordinateKey).join(',') + '|' + coordinateKey(destNode);
                const bakeKey = `${anchorPosKey}|${destId}|${nodeKey}`;
                if (data.worldAnchorKey !== bakeKey) {
                    const anchorChanged = data.worldAnchorPos !== anchorPosKey;
                    data.worldAnchorPos = anchorPosKey;
                    data.worldAnchorKey = bakeKey;
                    // Heights are RELATIVE to the first route stop's authored
                    // elevation. GPS altitude is deliberately not used: it is
                    // metres off and on a different datum from the elevations
                    // typed into the admin map, and clamping that mismatch to
                    // ±3 m sank or floated the whole line off the road.
                    const refNode = floorPath[1];
                    const baseElev = Number.isFinite(refNode?.elevation) ? refNode.elevation : 0;
                    data.elevBase = baseElev;

                    // True-scale placement: no distance clamping — a node that
                    // is 400 m away is drawn 400 m away, exactly like the 2D map.
                    // NODE_Y_DROP keeps every marker under the eye line.
                    // Slots are claimed by node id: a stop that Dijkstra drops
                    // keeps its mesh and dims to a ghost in place, and a stop
                    // that rejoins fades back up on the same mesh.
                    const newIds = new Set(mids.map(midKey));
                    for (let s = 0; s < poolSize; s += 1) {
                        if (slotNode[s] !== null && !newIds.has(slotNode[s])) {
                            spherePool.dimSlot(s);
                            if (!ghostSlots.includes(s)) ghostSlots.push(s);
                            slotNode[s] = null;
                        }
                    }
                    midSlots = [];
                    mids.forEach((p, k) => {
                        const id = midKey(p);
                        let s = -1;
                        for (let q = 0; q < poolSize; q += 1) {
                            if (slotNode[q] === id) { s = q; break; }
                        }
                        if (s < 0) {
                            // Truly free slot first, oldest ghost next, any
                            // unassigned (fading-out) slot as a last resort.
                            for (let q = 0; q < poolSize; q += 1) {
                                if (slotNode[q] === null && spherePool.isSlotFree(q)) { s = q; break; }
                            }
                            if (s < 0 && ghostSlots.length > 0) s = ghostSlots.shift();
                            if (s < 0) {
                                for (let q = 0; q < poolSize; q += 1) {
                                    if (slotNode[q] === null) { s = q; break; }
                                }
                            }
                            if (s < 0) return; // pool exhausted; skip this stop
                            const gi = ghostSlots.indexOf(s);
                            if (gi >= 0) ghostSlots.splice(gi, 1);
                            slotNode[s] = id;
                        }
                        const o = anchorENU(anchor, p);
                        const pe = Number.isFinite(p.elevation) ? p.elevation : 0;
                        spherePool.setSlot(s, o.x, clamp(pe - baseElev, -3, 3) + NODE_Y_DROP, o.z, 1);
                        midSlots[k] = s;
                    });
                    spherePool.updateScales();

                    prevActiveIds = newIds;

                    const destO = anchorENU(anchor, destNode);
                    const de = Number.isFinite(destNode.elevation) ? destNode.elevation : 0;
                    destPin.group.position.set(destO.x, clamp(de - baseElev, -3, 3) + NODE_Y_DROP, destO.z);
                    destPin.group.visible = !!dest;
                    prevBakeDest = String(destNode.id ?? destNode.type);
                    tubeDirty = true; // route shape changed → rebuild the tube

                    // Only a moved anchor re-snaps the camera; a node-set
                    // change must not jump the view.
                    if (anchorChanged) camInit = false;
                }

                // (GPS-altitude rebake removed — see the bake above.)

                // ── Staircases on this floor ─────────────────────────
                // Each stair the route takes touches this floor at one end:
                // the foot (leaving) or the landing (arriving). Draw the
                // flight from that node toward the other floor's node, tilted
                // by the link's angle and rising by the real elevation gap.
                {
                    const flights = [];
                    const stairList = Array.isArray(rt.stairs) ? rt.stairs : [];
                    if (floorLevel !== null && stairList.length) {
                        const baseE = Number.isFinite(data.elevBase) ? data.elevBase : 0;
                        const yOf = (n) => clamp((Number.isFinite(n.elevation) ? n.elevation : 0) - baseE, -3, 3) + NODE_Y_DROP;
                        for (const st of stairList) {
                            const fromN = path[st.from_index];
                            const toN = path[st.to_index];
                            if (!fromN || !toN) continue;
                            const leaving = st.from_floor === floorLevel;
                            const arriving = st.to_floor === floorLevel;
                            if (!leaving && !arriving) continue;
                            const here = leaving ? fromN : toN;
                            const other = leaving ? toN : fromN;
                            const oh = anchorENU(anchor, here);
                            const ot = anchorENU(anchor, other);
                            // Is the node on THIS floor the foot (lower) or the head (upper) of the stairs?
                            const hereIsBottom = leaving === (st.direction === 'up');
                            let dx = ot.x - oh.x;
                            let dz = ot.z - oh.z;
                            if (Math.hypot(dx, dz) < 0.3) {
                                // Nodes stacked on top of each other: the flight
                                // continues the way the route was already heading
                                // (leaving) or lies behind the landing (arriving).
                                // Both are "away from the neighbouring stop".
                                const nb = leaving ? path[st.from_index - 1] : path[st.to_index + 1];
                                if (nb && Number.isFinite(nb.latitude)) {
                                    const on = anchorENU(anchor, nb);
                                    dx = oh.x - on.x;
                                    dz = oh.z - on.z;
                                }
                            }
                            if (Math.hypot(dx, dz) < 0.05) { dx = 0; dz = -1; }

                            // Direction (yaw) of the first flight walking UP. The admin's value
                            // wins; otherwise the nodes' own bearing; for stacked nodes with
                            // nothing stored, the route's heading (as before).
                            const stored = st.yaw_source === 'set' || st.yaw_source === 'nodes';
                            const awayYaw = ((Math.atan2(hereIsBottom ? dx : -dx, hereIsBottom ? -dz : dz) * 180) / Math.PI + 360) % 360;
                            const yawDeg = stored && Number.isFinite(st.yaw_deg) ? st.yaw_deg : awayYaw;

                            const plan = planStairs({
                                rise: Number.isFinite(st.rise_m) ? st.rise_m : 3,
                                yawDeg,
                                flights: st.flights,
                                angleDeg: st.angle_deg,
                                landingM: st.landing_m,
                            });
                            // Anchor the plan on this floor's node: the foot of the stairs when
                            // we are leaving upward / arriving from above, the head otherwise.
                            const baseY = yOf(here);
                            const origin = hereIsBottom
                                ? { x: oh.x, y: baseY, z: oh.z }
                                : { x: oh.x - plan.end.e, y: baseY - plan.end.u, z: oh.z + plan.end.n };
                            const P = (p) => ({ x: origin.x + p.e, y: origin.y + p.u, z: origin.z - p.n });

                            const flightSegs = plan.segments.filter((sg) => sg.kind === 'flight');
                            const gaugeIndex = hereIsBottom ? 0 : flightSegs.length - 1;
                            const turns = landingTurns(st.direction, plan.flights);
                            const angleLabel = Math.round(st.angle_deg || 45);
                            for (const sg of plan.segments) {
                                if (sg.kind === 'flight') {
                                    const q = P(sg.from);
                                    const yr = (sg.yawDeg * Math.PI) / 180;
                                    flights.push({
                                        x: q.x, y: q.y, z: q.z, dx: Math.sin(yr), dz: -Math.cos(yr),
                                        run: sg.run, dy: sg.rise, angle: sg.angle_deg,
                                        gauge: sg.index === gaugeIndex,
                                        label: leaving
                                            ? `Stairs ${st.direction} \u00b7 ${angleLabel}\u00b0`
                                            : `From floor ${floorTag(st.from_floor)} \u00b7 ${angleLabel}\u00b0`,
                                    });
                                } else {
                                    // Next place to walk to, in the order this route walks it.
                                    const up = st.direction === 'up';
                                    const nextSeg = up ? flightSegs[sg.index + 1] : flightSegs[sg.index];
                                    const target = nextSeg ? (up ? nextSeg.from : nextSeg.to) : sg.center;
                                    let ae = target.e - sg.center.e;
                                    let an = target.n - sg.center.n;
                                    if (Math.hypot(ae, an) < 0.05) {
                                        const yr = (sg.yawDeg * Math.PI) / 180;
                                        ae = up ? Math.sin(yr) : -Math.sin(yr);
                                        an = up ? Math.cos(yr) : -Math.cos(yr);
                                    }
                                    const c = P(sg.center);
                                    const t = turns[sg.index] ?? 0;
                                    flights.push({
                                        kind: 'landing', x: c.x, y: c.y, z: c.z, yawDeg: sg.yawDeg,
                                        depth: sg.depth, width: sg.width,
                                        arrow: { dx: ae, dz: -an },
                                        label: Math.abs(t) < 20 ? 'Landing' : turnPhrase(t).replace(/^./, (ch) => ch.toUpperCase()),
                                    });
                                }
                            }
                        }
                    }
                    const r2 = (k, v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v);
                    const stairKey = `${floorLevel}|${anchorPosKey}|${data.elevBase}|` + flights
                        .map((f) => JSON.stringify(f, r2))
                        .join('|');
                    stairViz.sync(flights, stairKey);
                }

                // Frame time first: both the walk integration below and the
                // sensor smoothing further down need the same timestep, so it
                // is taken once, before either branch runs.

                // ---- Position: GPS fix, or the free-roam keyboard ----
                const userENU = anchorENU(anchor, user);

                if (freeRoam) {
                    const fp = freePosRef.current;
                    let justSeeded = false;
                    if (!fp.seeded) {
                        // Resume exactly where the fix left off and adopt the
                        // camera's current look direction, so enabling
                        // free-roam mid-walk neither teleports nor spins.
                        fp.x = Number.isFinite(userENU.x) ? userENU.x : 0;
                        fp.z = Number.isFinite(userENU.z) ? userENU.z : 0;
                        fp.seeded = true;
                        justSeeded = true;
                        const seededFwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
                        lookRef.current.pitch = Math.asin(clamp(seededFwd.y, -1, 1));
                        // Forward is (−sin yaw, ·, −cos yaw), so the compass
                        // azimuth atan2(fwd.x, −fwd.z) equals −yaw.
                        lookRef.current.yaw = -Math.atan2(seededFwd.x, -seededFwd.z);
                    }

                    const look = lookRef.current;
                    const keys = keysRef.current;

                    // WASD travels on the ground plane relative to the look
                    // yaw. Pitch deliberately does not tilt the travel
                    // direction — looking up must not make you fly, the
                    // way it would with a pure camera-forward vector.
                    const sinY = Math.sin(look.yaw);
                    const cosY = Math.cos(look.yaw);
                    const forward = (keys.w ? 1 : 0) - (keys.s ? 1 : 0);
                    const strafe = (keys.d ? 1 : 0) - (keys.a ? 1 : 0);
                    const moveX = (-sinY * forward) + (cosY * strafe);
                    const moveZ = (-cosY * forward) - (sinY * strafe);
                    const mag = Math.hypot(moveX, moveZ);
                    if (mag > 0) {
                        // Diagonals stay normalized; Shift runs.
                        const pace = keys.shift ? FREE_ROAM_SPRINT : FREE_ROAM_WALK;
                        const step = (pace * dt * Math.min(1, mag)) / mag;
                        camera.position.x += moveX * step;
                        camera.position.z += moveZ * step;
                    }
                    // Space lifts and C drops: a presenter can pull back to
                    // see the whole route constellation, then settle back down
                    // to the line again. Clamped so a held key cannot fly away
                    // or sink through the world.
                    if (keys.space) camera.position.y += FREE_ROAM_LIFT * dt;
                    if (keys.c) camera.position.y -= FREE_ROAM_LIFT * dt;
                    camera.position.y = clamp(
                        Number.isFinite(camera.position.y) ? camera.position.y : 0,
                        FREE_ROAM_HEIGHT_MIN, FREE_ROAM_HEIGHT_MAX,
                    );

                    fp.x = camera.position.x;
                    fp.z = camera.position.z;

                    // `user` was rewritten to the walked fix at the top of
                    // this frame, so it is exactly what the parent needs to
                    // re-anchor the route. Forced on the seeding frame so the
                    // parent is in sync even if the route was computed before
                    // the last GPS fix arrived.
                    reportWalked(user.latitude, user.longitude, justSeeded);
                } else {
                    const targetCamX = userENU.x;
                    const targetCamZ = userENU.z;

                    if (!camInit) {
                        if (Number.isFinite(targetCamX) && Number.isFinite(targetCamZ)) {
                            camera.position.set(targetCamX, 0, targetCamZ);
                        }
                        camInit = true;
                    } else if (Number.isFinite(targetCamX) && Number.isFinite(targetCamZ)) {
                        // Short easing only — hides GPS jitter without lagging
                        // behind the position the 2D map shows. Time-based, so
                        // it settles equally fast at any frame rate.
                        const kPos = easeK(dt, POS_EASE_TAU);
                        camera.position.x += (targetCamX - camera.position.x) * kPos;
                        camera.position.z += (targetCamZ - camera.position.z) * kPos;
                        camera.position.y = 0;
                    }
                }

                // ---- Orientation: free-roam mouse, or the sensors ----
                let targetQuat = null;
                let quatSource = 'none';

                if (freeRoam) {
                    const look = lookRef.current;
                    // Direct write, no slerp: mouse look has to feel welded
                    // to the hand, and any easing here reads as input lag.
                    // The sensor path below still smooths, because jittery
                    // compass data is worth filtering.
                    camera.quaternion.setFromEuler(_freeEuler.set(look.pitch, look.yaw, 0, 'YXZ'));
                    yawSnapped = true;
                    quatSource = 'free-roam mouse look';
                } else {
                    if (resnapYawRef.current) { resnapYawRef.current = false; yawSnapped = false; }
                    const orient = deviceOrientationRef.current;
                    const screenAngle = window.screen?.orientation?.angle ?? window.orientation ?? 0;
                    const haveTilt = !!orient && Number.isFinite(orient.beta) && Number.isFinite(orient.gamma);
                    // true when the yaw comes from a real compass/sensor (so the
                    // compass-error offset applies); false when it is synthesised.
                    let sensorYawKind = false;

                    // (a0) GYRO-FUSED POSE (Android, both streams alive).
                    // The relative stream is gyro-driven: smooth and immune to
                    // magnetic interference, but its α has an arbitrary north.
                    // The absolute stream has the right north but jitters and
                    // gets bent by steel/wiring. Both share the same β/γ, so
                    // they differ only by a yaw constant Δ = α_abs − α_rel.
                    // We average Δ slowly while the two agree, and HOLD it when
                    // the compass suddenly disagrees with the gyro (disturbance),
                    // so the pose follows the gyro instead of the bent compass.
                    // Disable with localStorage.arGyroFuse = "0".
                    if (gyroFuseEnabled && orient && orient.webkitCompassHeading == null
                        && Number.isFinite(orient.alpha) && haveTilt) {
                        const rel = relOrientRef.current;
                        const F = fuseRef.current;
                        if (rel && nowMs - rel.t < 400) {
                            if (nowMs - orient.t < 500) {
                                const dRaw = norm180(orient.alpha - rel.alpha);
                                F.raw = dRaw;
                                const fdt = F.lastT ? Math.min(0.1, (nowMs - F.lastT) / 1000) : dt;
                                F.lastT = nowMs;
                                if (F.delta === null) { F.delta = dRaw; F.age = 0; F.devT = 0; }
                                F.age += fdt;
                                const err = norm180(dRaw - F.delta);
                                if (F.age < 3 || Math.abs(err) <= 5) {
                                    // Agreeing (or still settling): average the noise out.
                                    const tau = F.age < 3 ? 0.4 : 2.5;
                                    F.delta = norm180(F.delta + err * (1 - Math.exp(-fdt / tau)));
                                    F.devT = 0;
                                    F.state = F.age < 3 ? 'settling' : 'locked';
                                } else {
                                    // Compass disagrees with the gyro by >5°: hold the
                                    // gyro yaw. If it persists >3 s treat it as real
                                    // (compass re-converged) and follow at ≤1.5°/s.
                                    F.devT += fdt;
                                    if (F.devT > 3) {
                                        F.delta = norm180(F.delta + clamp(err, -1.5 * fdt, 1.5 * fdt));
                                        F.state = 'adopting';
                                    } else {
                                        F.state = 'holding';
                                    }
                                }
                            }
                            if (F.delta !== null) {
                                const effAlpha = (((rel.alpha + F.delta) % 360) + 360) % 360;
                                const q = deviceOrientationToQuaternion(effAlpha, rel.beta, rel.gamma, screenAngle);
                                if (q) {
                                    targetQuat = q;
                                    quatSource = `gyro-fused α (${F.state})`;
                                    sensorYawKind = true;
                                }
                            }
                        } else {
                            F.state = 'no relative stream';
                        }
                    }

                    // (a) classic stream with a yaw: full α/β/γ pose.
                    if (!targetQuat && haveTilt) {
                        let effAlpha = null;
                        let src = 'deviceorientation α/β/γ';
                        if (orient.webkitCompassHeading != null && Number.isFinite(orient.webkitCompassHeading)) {
                            effAlpha = (360 - orient.webkitCompassHeading) % 360;
                            src = 'webkitCompassHeading → α + β/γ';
                        } else if (orient.alpha != null && Number.isFinite(orient.alpha)) {
                            effAlpha = orient.alpha;
                        }
                        if (effAlpha != null) {
                            const q = deviceOrientationToQuaternion(effAlpha, orient.beta, orient.gamma, screenAngle);
                            if (q) {
                                targetQuat = q;
                                quatSource = src;
                                sensorYawKind = true;
                            }
                        }
                    }

                    // (b) AbsoluteOrientationSensor: a full quaternion, so roll
                    // is kept (the old path reduced it to heading + pitch).
                    if (!targetQuat) {
                        const gq = genericQuatRef.current;
                        if (gq && nowMs - gq.t < 500) {
                            const q = genericSensorToCameraQuaternion(gq.raw, screenAngle);
                            if (q) {
                                targetQuat = q;
                                quatSource = 'AbsoluteOrientationSensor (full quaternion)';
                                sensorYawKind = true;
                            }
                        }
                    }

                    // (c) compass heading + β/γ: α is missing but tilt is
                    // streaming, so keep roll instead of forcing it to zero.
                    if (!targetQuat && haveTilt && heading !== null && Number.isFinite(heading)) {
                        const effAlpha = (((360 - heading) % 360) + 360) % 360;
                        const q = deviceOrientationToQuaternion(effAlpha, orient.beta, orient.gamma, screenAngle);
                        if (q) {
                            targetQuat = q;
                            quatSource = 'compass heading + β/γ (no α)';
                            sensorYawKind = true;
                        }
                    }

                    // (d) heading + β only (no γ anywhere).
                    if (!targetQuat && heading !== null && Number.isFinite(heading)) {
                        const yawRad = (-heading * Math.PI) / 180;
                        const betaDeg = motionRef.current.betaRaw ?? 90;
                        const pitchRad = clamp((betaDeg - 90) * (Math.PI / 180), -Math.PI / 3, Math.PI / 3);
                        const fallbackEuler = new THREE.Euler(pitchRad, yawRad, 0, 'YXZ');
                        targetQuat = new THREE.Quaternion().setFromEuler(fallbackEuler);
                        quatSource = 'compass heading + β (fallback, no roll)';
                        sensorYawKind = true;
                    }

                    // Last resort — no compass AT ALL (no deviceorientation event
                    // ever carried a usable α, e.g. motion sensors blocked or an
                    // insecure origin). Without this the quaternion stays at
                    // identity, so the camera stares along −Z (north) forever:
                    // the markers are baked and drawn correctly but sit behind
                    // the camera, which reads exactly as "the nodes are missing".
                    // Facing the next stop instead keeps the whole point of the
                    // screen — the route — in view until a real heading arrives,
                    // at which point the normal slerp above takes over.
                    if (!targetQuat && path.length > 1) {
                        const baseElev = Number.isFinite(data.elevBase) ? data.elevBase : 0;
                        const pick = () => {
                            for (let pass = 0; pass < 2; pass += 1) {
                                const from = pass === 0 ? Math.max(1, idx) : 1;
                                for (let i = from; i < path.length; i += 1) {
                                    const p = path[i];
                                    if (!p) continue;
                                    const o = anchorENU(anchor, p);
                                    const dx = o.x - camera.position.x;
                                    const dz = o.z - camera.position.z;
                                    if (dx * dx + dz * dz <= 2.25) continue;   // < 1.5 m: too close to aim at
                                    const pe = Number.isFinite(p.elevation) ? p.elevation : 0;
                                    const dy = clamp(pe - baseElev, -3, 3) + NODE_Y_DROP - camera.position.y;
                                    return { dx, dy, dz };
                                }
                            }
                            return null;
                        };
                        const aim = pick();
                        if (aim) {
                            const horiz = Math.hypot(aim.dx, aim.dz);
                            // Yaw must come from the route — the sensor gave us
                            // no α — but PITCH should follow the phone, not the
                            // waypoint. β/γ are accelerometer + gyroscope and
                            // arrive fine; it is only the magnetometer yaw that
                            // is missing. Taking the aim's pitch too would leave
                            // the view frozen even though tilt was streaming.
                            const betaDeg = motionRef.current.betaRaw;
                            const hasTilt = betaDeg !== null && Number.isFinite(betaDeg);
                            const pitchRad = hasTilt
                                ? clamp((betaDeg - 90) * (Math.PI / 180), -Math.PI / 3, Math.PI / 3)
                                : Math.atan2(aim.dy, horiz);
                            const aimEuler = new THREE.Euler(
                                pitchRad,
                                Math.atan2(-aim.dx, -aim.dz),
                                0,
                                'YXZ',
                            );
                            const rollDeg = motionRef.current.roll;
                            if (hasTilt && Number.isFinite(rollDeg)) {
                                // α = the aimed yaw; β/γ from the phone, so roll is kept.
                                const aimAlpha = ((Math.atan2(-aim.dx, -aim.dz) * 180) / Math.PI + 360) % 360;
                                targetQuat = deviceOrientationToQuaternion(aimAlpha, betaDeg, rollDeg, screenAngle)
                                    || new THREE.Quaternion().setFromEuler(aimEuler);
                            } else {
                                targetQuat = new THREE.Quaternion().setFromEuler(aimEuler);
                            }
                            quatSource = hasTilt ? 'route yaw + sensor β/γ (no α)' : 'route aim (no compass)';
                        }
                    }

                    // ── Compass-error correction ─────────────────────────
                    if (targetQuat && sensorYawKind) {
                        const az = azimuthDegOfQuaternion(targetQuat);
                        sensorAzRef.current = az;
                        applyYawOffset(targetQuat, yawOffsetRef.current);
                        // While walking, the GPS course is the truth about
                        // where "forward" is. Nudge the offset toward it, but
                        // only when the phone points roughly along the walk
                        // (±50°) and is not tilted far up/down, and never by
                        // more than 4° per fix, so a glance sideways is ignored.
                        if (autoYawEnabled && user !== data.courseUser) {
                            data.courseUser = user;
                            // Walking course from the SNAPPED positions (they follow
                            // the route edge, so this is far steadier than the raw
                            // GPS course, and it works wherever positions update).
                            const hist = posHistRef.current;
                            hist.push({ t: nowMs, lat: user.latitude, lng: user.longitude });
                            while (hist.length && nowMs - hist[0].t > 8000) hist.shift();
                            let course = null; let speed = null; let csrc = 'none';
                            if (hist.length >= 2) {
                                const h0 = hist.find((x) => nowMs - x.t <= 6000) || hist[0];
                                const dd = bearingAndDistance(h0.lat, h0.lng, user.latitude, user.longitude);
                                const dts = (nowMs - h0.t) / 1000;
                                const sp = dts > 0 ? dd.dist / dts : 0;
                                // ≥2.5 m of progress, at a walking pace (a teleport
                                // or a jittering fix is neither).
                                if (dd.dist >= 2.5 && sp >= 0.5 && sp <= 3.5) {
                                    course = dd.bearing; speed = sp; csrc = 'snapped displacement';
                                }
                            }
                            if (course === null && user.source === 'gps' && Number.isFinite(user.speed)
                                && user.speed >= 1.2 && Number.isFinite(user.course)) {
                                course = user.course; speed = user.speed; csrc = 'gps course';
                            }
                            courseInfoRef.current = { course, speed, src: csrc };
                            const lastPitch = motionRef.current.pitch;
                            if (course !== null && (!Number.isFinite(lastPitch) || Math.abs(lastPitch) < 50)) {
                                const wantOff = norm180(course - az);
                                const diff = norm180(wantOff - yawOffsetRef.current);
                                if (Math.abs(diff) < 50) {
                                    const step = clamp(diff * 0.15, -4, 4);
                                    yawOffsetRef.current = norm180(yawOffsetRef.current + step);
                                    applyYawOffset(targetQuat, step);
                                    lastCourseFixRef.current = { t: nowMs, step, course, speed };
                                }
                            }
                        }
                        if (Math.abs(yawOffsetRef.current) >= 0.5) {
                            quatSource = `${quatSource} · yaw offset ${Math.round(yawOffsetRef.current)}°`;
                        }
                    } else {
                        sensorAzRef.current = null;
                    }

                    if (targetQuat) {
                        if (!yawSnapped) {
                            camera.quaternion.copy(targetQuat);
                            yawSnapped = true;
                        } else {
                            // Rate grows with how far the pose is behind the sensor:
                            // under ~1 degree (noise) it is 18/s, by ~8 degrees (a turn)
                            // it reaches 72/s. Time-based, so frame rate does not matter.
                            const lagDeg = (camera.quaternion.angleTo(targetQuat) * 180) / Math.PI;
                            camera.quaternion.slerp(targetQuat, easeK(dt, 1 / orientRate(lagDeg)));
                        }
                    }
                }

                // Camera forward azimuth & pitch for the HUD / YOU header.
                // Reused scratch vectors: no new objects per frame (no GC hitches at 120 Hz).
                const fwd = _camFwd.set(0, 0, -1).applyQuaternion(camera.quaternion);
                const camYaw = norm180((Math.atan2(fwd.x, -fwd.z) * 180) / Math.PI);
                const camPitch = (Math.asin(clamp(fwd.y, -1, 1)) * 180) / Math.PI;
                // Heading for the 2D cone. The forward vector's azimuth becomes
                // ill-conditioned when the phone looks steeply down (the
                // horizontal part shrinks toward zero), so add the phone's
                // top-edge direction, which points the same way when looking
                // down (and the opposite way when looking up). In a numeric
                // test with ±12° roll the error at −65° pitch fell from ~14°
                // to ~5°, and at −85° from ~51° to ~6°.
                const upv = _camUp.set(0, 1, 0).applyQuaternion(camera.quaternion);
                const kUp = -clamp(fwd.y * 4, -1, 1);
                const coneYaw = norm180((Math.atan2(fwd.x + kUp * upv.x, -(fwd.z + kUp * upv.z)) * 180) / Math.PI);
                motionRef.current.yaw = coneYaw;
                motionRef.current.pitch = camPitch;

                // Apparent-size scaling so dots stay readable at any distance.
                mids.forEach((p, k) => {
                    const s = midSlots[k];
                    if (s === undefined || s < 0) return;
                    const pos = spherePool.getPosition(s);
                    const dx = pos.x - camera.position.x;
                    const dz = pos.z - camera.position.z;
                    const dist = Math.sqrt(dx * dx + dz * dz);
                    const pulse = k === 0 ? 1 + 0.15 * Math.sin(t * 3) : 1;
                    spherePool.setSlot(s, pos.x, pos.y, pos.z, responsiveScale(dist) * pulse);
                });
                spherePool.updateScales();

                // Walls: anything whose sight line from the camera crosses a
                // border polyline is on the far side of a wall and not drawn.
                const wallAnchor = anchorRef.current;
                if (wallAnchor) {
                    const wallKey = `${wallAnchor.latitude.toFixed(6)},${wallAnchor.longitude.toFixed(6)}`;
                    if (wallCache.borders !== data.borders || wallCache.anchorKey !== wallKey) {
                        wallCache = { borders: data.borders, anchorKey: wallKey, segs: buildWallSegments(data.borders, wallAnchor) };
                    }
                }
                // Buildings block sight too (their walls, with door gaps, up to the roof line).
                const buildingSegs = buildingLayer.segments;
                const behindWall = (x, z, y) => {
                    const cx = camera.position.x;
                    const cz = camera.position.z;
                    return isOccluded(cx, cz, x, z, wallCache.segs)
                        || isOccluded(cx, cz, x, z, buildingSegs, camera.position.y + floorLiftM(), y + floorLiftM());
                };

                const shown = [];
                mids.forEach((p, k) => {
                    const s = midSlots[k];
                    if (s === undefined || s < 0) return;
                    const r = bearingAndDistance(user.latitude, user.longitude, p.latitude, p.longitude);
                    shown.push({ node: p, pos: spherePool.getPosition(s), dist: r.dist });
                });

                // Destination beacon (light beam + finish flag) — sized to a
                // constant screen size exactly like the marker it replaced.
                if (dest) {
                    destPin.group.visible = !behindWall(destPin.group.position.x, destPin.group.position.z, destPin.group.position.y);
                    destPin.group.scale.setScalar(responsiveScale(camera.position.distanceTo(destPin.group.position)));
                    const rd = bearingAndDistance(user.latitude, user.longitude, dest.latitude, dest.longitude);
                    shown.push({ node: dest, pos: destPin.group.position, dist: rd.dist });
                } else {
                    destPin.group.visible = false;
                }

                // ── Route connector: live user → every stop → destination ──
                // Same node list as the 2D polyline that appears when a
                // destination is given, drawn here as the glowing tube. Rebuilt
                // only when the route changes or the walker has moved more than
                // 0.3 m, so it costs a few updates a second instead of one per
                // frame.
                // Ground under the walker = the first stop's drawn height.
                // (It used to be GPS-altitude-minus-anchor, clamped ±3 m: noisy
                // altitude lifted the route head and the pulse ring above eye
                // level or sank them below the markers.)
                let groundY = NODE_Y_DROP;
                for (let k = 0; k < mids.length; k += 1) {
                    const s0 = midSlots[k];
                    if (s0 !== undefined && s0 >= 0) { groundY = spherePool.getPosition(s0).y; break; }
                }
                const headX = camera.position.x;
                const headZ = camera.position.z;
                if (tubeDirty || Math.hypot(headX - tubeHeadX, headZ - tubeHeadZ) > 0.3) {
                    tubeDirty = false;
                    tubeHeadX = headX;
                    tubeHeadZ = headZ;
                    const routePts = [{ x: headX, y: groundY, z: headZ }];
                    for (let k = 0; k < mids.length; k += 1) {
                        const s = midSlots[k];
                        if (s === undefined || s < 0) continue;
                        const np = spherePool.getPosition(s);
                        routePts.push({ x: np.x, y: np.y, z: np.z });
                    }
                    if (destPin.group.visible) {
                        routePts.push({
                            x: destPin.group.position.x,
                            y: destPin.group.position.y,
                            z: destPin.group.position.z,
                        });
                    }
                    // The glowing tube is world-scale, so it starts a couple of
                    // metres ahead of the camera instead of wrapping the viewer.
                    // trimPathStart returns [] once the whole route is shorter
                    // than that — i.e. on arrival — which hides it cleanly.
                    const holoPts = trimPathStart(routePts, HOLO_MIN_START);
                    // Tube replaced by the ground road - keep it hidden.
                    holoPath.setPoints([]);
                    // The road: from a metre ahead of you (under the phone, not under your feet), on the
                    // ground: the markers' height dropped to the ground plane (AR_GROUND_Y).
                    const roadPts = trimPathStart(routePts, ROAD_START_M)
                        .map((q) => ({ x: q.x, y: q.y + (AR_GROUND_Y - NODE_Y_DROP) + 0.02, z: q.z }));
                    road.setPoints(roadPts);
                    statsRef.current.tubePts = holoPts.length >= 2 ? holoPts.length : 0;
                }

                // Chevrons, the pin hologram and the ground halo animate on
                // time, never on route changes (the rebuild above only fires
                // after 0.3 m walked). Marker fades tick here too, so
                // ghosting in/out eases over ~0.45 s.
                spherePool.tick(dt);
                holoPath.tick(t, dt);
                road.tick(t, dt);
                // The road's painted chevrons show the way now: no floating arrow over each stop.
                nodeArrows.update([], t, camera, behindWall);
                destPin.tick(t, camera);

                if (shown.length > 0) {
                    const advNode = path[idx];
                    let nextSi = shown.findIndex((s) => s.node === advNode);
                    if (nextSi < 0) nextSi = 0;
                    const isDestNode = (s) => dest !== null && s.node === dest;
                    const lineFor = (si) => {
                        const s = shown[si];
                        const tag = si === nextSi ? (isDestNode(s) ? 'DEST' : 'NEXT') : (isDestNode(s) ? 'DEST' : `#${si + 1}`);
                        let arrow = '';
                        if (si === nextSi && !preview && s.node) {
                            const b = bearingAndDistance(user.latitude, user.longitude, s.node.latitude, s.node.longitude);
                            const rel = norm180(b.bearing - camYaw);
                            arrow = Math.abs(rel) < 25 ? ' · ahead' : rel > 0 ? ' · right' : ' · left';
                        }
                        return `${tag} ${s.node.name || s.node.type} · ${s.dist.toFixed(0)} m${arrow}`;
                    };
                    if (shown.length <= 5) {
                        for (let si = 0; si < shown.length; si += 1) lines.push(lineFor(si));
                    } else {
                        lines.push(lineFor(nextSi));
                        lines.push(`… +${shown.length - 2} more …`);
                        const lastSi = shown.length - 1;
                        if (lastSi !== nextSi) lines.push(lineFor(lastSi));
                    }
                }
                if (!path[idx]) lines.push('Arrived');

                // ── Plain guidance: turn, distance, what is left ───────────
                {
                    const target = path[idx];
                    const last = path[path.length - 1];
                    const arrivedNow = lines.includes('Arrived');
                    if (target && Number.isFinite(target.latitude)) {
                        const leg = bearingAndDistance(user.latitude, user.longitude, target.latitude, target.longitude);
                        // Left / right from where you face: the walking figure in the 3D mode's test walk,
                        // else the camera (phone compass, or the mouse look on a computer).
                        const walkerDeg = followTestRef.current ? testPosRef.current?.headingDeg : null;
                        const facing = Number.isFinite(walkerDeg) ? walkerDeg : (!preview && Number.isFinite(camYaw) ? camYaw : null);
                        const relDeg = facing === null ? null : norm180(leg.bearing - (((facing % 360) + 360) % 360));
                        let remaining = leg.dist;
                        for (let k = idx; k < path.length - 1; k += 1) {
                            remaining += bearingAndDistance(path[k].latitude, path[k].longitude, path[k + 1].latitude, path[k + 1].longitude).dist;
                        }
                        const g = guidanceFor({
                            relDeg: relDeg === null ? null : Math.round(relDeg / 5) * 5,
                            distM: leg.dist, isLast: idx === path.length - 1, destName: last?.name || '', arrived: arrivedNow,
                        });
                        lastGuideRef.current = g;
                        voiceRef.current?.update(g, performance.now());
                        const remainTxt = arrivedNow ? '0 m' : formatDistance(remaining);
                        const etaTxt = arrivedNow ? 'You are there' : formatWalkTime(remaining);
                        const stopTxt = `${Math.min(idx, path.length - 1)} of ${path.length - 1}`;
                        // The arrow turns in 15-degree steps (no DOM write every frame).
                        const arrowDeg = relDeg === null ? null : Math.round(relDeg / 15) * 15;
                        const key = `${g.main}|${g.sub}|${remainTxt}|${etaTxt}|${stopTxt}|${arrowDeg}`;
                        if (key !== guideCacheRef.current) {
                            guideCacheRef.current = key;
                            const icon = instrIconRef.current;
                            if (icon) {
                                icon.dataset.state = arrivedNow ? 'arrived' : arrowDeg === null ? 'none' : 'turn';
                                const arrow = icon.querySelector('.ar-step-arrow');
                                if (arrow && arrowDeg !== null) arrow.style.transform = `rotate(${arrowDeg}deg)`;
                            }
                            if (instrRef.current) instrRef.current.textContent = g.main;
                            if (instrSubRef.current) instrSubRef.current.textContent = g.sub;
                            if (closestRef.current) closestRef.current.textContent = remainTxt;
                            if (closestNodeRef.current) closestNodeRef.current.textContent = etaTxt;
                            if (stopCountRef.current) stopCountRef.current.textContent = stopTxt;
                        }
                    }
                    // Arrival: one React update per trip, never one per frame.
                    if (arrivedNow && !arrivedRef.current) {
                        arrivedRef.current = true;
                        setArrived({ name: last?.name || 'your destination' });
                        voiceRef.current?.arrive(last?.name);
                        try { navigator.vibrate?.([40, 60, 40]); } catch { /* optional */ }
                    }
                }

                let hudText = lines.join('\n');
                if ((user.accuracy ?? 0) > 75) hudText += `\nGPS ±${Math.round(user.accuracy)} m. Placement approximate`;
                // Control legend lives in the HUD, not only in the ☰ sheet:
                // users need to know the active movement controls at a glance.
                // Pointer lock is read straight from the DOM rather than from
                // React state, so this line can never lag a click.
                if (freeRoam) {
                    const lockedNow = document.pointerLockElement === lookLayerRef.current;
                    if (dragLookRef.current) {
                        hudText += '\nFree roam · drag to look around · WASD walk';
                    } else {
                        hudText += lockedNow
                            ? '\nFree roam · WASD walk · mouse look · Shift run · Space/C height · Esc releases'
                            : '\nFree roam · click the view to capture the mouse, then WASD + mouse';
                    }
                }
                if (hudRef.current) hudRef.current.textContent = hudText;

                // ── 3D direction banner: nearest node vs camera angle ──
                // Signed angle from where the camera faces (camYaw) to the
                // nearest remaining stop. The arrow rotates by that angle
                // (0° = straight ahead); the text names the turn.
                // dirBest/dirBestDist are shared with the off-screen pointer
                // below so both cues track the same stop.
                let dirBest = -1;
                let dirBestDist = Infinity;
                let dirBestBearing = 0;
                if (floorPath.length > 1) {
                    for (let k = 1; k < floorPath.length; k += 1) {
                        const p = floorPath[k];
                        if (!Number.isFinite(p.latitude) || !Number.isFinite(p.longitude)) continue;
                        const rr = bearingAndDistance(user.latitude, user.longitude, p.latitude, p.longitude);
                        if (rr.dist < dirBestDist) {
                            dirBestDist = rr.dist;
                            dirBest = k;
                            dirBestBearing = rr.bearing;
                        }
                    }
                    if (dirBest > 0 && Number.isFinite(camYaw)) {
                        const target = floorPath[dirBest];
                        const b = bearingAndDistance(user.latitude, user.longitude, target.latitude, target.longitude);
                        // camYaw is norm180 (−180..180); bearings are 0..360.
                        const cam360 = ((camYaw % 360) + 360) % 360;
                        const rel = norm180(b.bearing - cam360);
                        const abs = Math.abs(rel);
                        const turn = abs < 25 ? 'ahead'
                            : abs > 155 ? 'behind you'
                            : rel > 0 ? 'right' : 'left';
                        const distTxt = dirBestDist < 10 ? dirBestDist.toFixed(1) : String(Math.round(dirBestDist));
                        // Distance and turn only: the stop name is often a
                        // generic "route", which adds noise without helping.
                        const key = `${distTxt}|${turn}`;
                        if (key !== dirCacheRef.current) {
                            dirCacheRef.current = key;
                            if (dirTextRef.current) dirTextRef.current.textContent = `${distTxt} m`;
                            if (dirTurnRef.current) dirTurnRef.current.textContent = turn;
                        }
                        if (dirBannerRef.current && dirBannerRef.current.style.display === 'none') {
                            dirBannerRef.current.style.display = '';
                        }
                    } else if (dirBannerRef.current && dirBannerRef.current.style.display !== 'none') {
                        dirBannerRef.current.style.display = 'none';
                        dirCacheRef.current = '';
                    }
                } else if (dirBannerRef.current && dirBannerRef.current.style.display !== 'none') {
                    dirBannerRef.current.style.display = 'none';
                    dirCacheRef.current = '';
                }

                // ── Off-screen pointer: nearest stop vs camera FOV ──
                // Projects the same nearest stop into the camera. While it
                // sits outside the visible frustum, the 3D arrow sits at the
                // centre of the view and points toward it (0° = straight up)
                // — no label, no DOM. Hidden the moment the marker itself is
                // on screen.
                //
                // Angle source: a stop in front is aimed at its actual screen
                // position (aspect included, or a wide window squeezes the cue
                // toward vertical). A stop behind the camera projects
                // mirrored, so the horizontal bearing relative to the camera
                // is used there instead — which also points straight down when
                // the stop is directly behind.
                if (dirBest > 0 && Number.isFinite(camYaw)) {
                    const target = floorPath[dirBest];
                    const entry = shown.find((s) => s.node === target);
                    if (entry) {
                        camera.updateMatrixWorld();
                        offProj.set(entry.pos.x, entry.pos.y, entry.pos.z).project(camera);
                        offCam.set(entry.pos.x, entry.pos.y, entry.pos.z).applyMatrix4(camera.matrixWorldInverse);
                        const behind = offCam.z > 0;
                        const sx = offProj.x;
                        const sy = offProj.y;
                        // Close to the stop: its own arrow has faded out (see
                        // nodeArrowFade), and the stop projects below/outside the
                        // frustum because we are standing on it. That is not
                        // "lost", so never draw the turn cue here. Uses the same
                        // fade curve as the node arrows (hidden below ~half fade).
                        const nearStop = nodeArrowFade(
                            Math.hypot(entry.pos.x - camera.position.x, entry.pos.z - camera.position.z),
                        ) < OFFARROW_NEAR_FADE;
                        const outOfView = !nearStop
                            && (behind || Math.abs(sx) > 0.9 || Math.abs(sy) > 0.85);
                        if (outOfView) {
                            const cam360 = ((camYaw % 360) + 360) % 360;
                            const bearingRel = norm180(dirBestBearing - cam360);
                            // Screen angle clockwise from up: right = +90°.
                            const ang = behind
                                ? bearingRel
                                : (Math.atan2(sx * camera.aspect, sy) * 180) / Math.PI;
                            offArrow.setAngle(ang);
                            offArrow.setVisible(true);
                        } else {
                            offArrow.setVisible(false);
                        }
                    } else {
                        offArrow.setVisible(false);
                    }
                } else {
                    offArrow.setVisible(false);
                }

                // YOU header: instant — recomputed every frame, written only on change.
                const youText = buildYouText(user, data.floorNodes || data.nodes, motionRef.current);
                if (youText !== youCacheRef.current) {
                    youCacheRef.current = youText;
                    if (youRef.current) youRef.current.textContent = youText;
                }

                // Hand this frame's inputs to the debug panel.
                const st = statsRef.current;
                st.camX = camera.position.x;
                st.camY = camera.position.y;
                st.camZ = camera.position.z;
                st.camYaw = camYaw;
                st.camPitch = camPitch;
                st.aspect = camera.aspect;
                st.fov = camera.fov;
                st.quatSource = quatSource;
                st.drawn = mids.length;
                st.pool = poolSize;
                st.destVisible = destPin.group.visible;

                drawBuildingsFrame();
                if (!followMainRef.current) renderer.render(scene, camera);
                // Read AFTER render(): three resets info.render at the start of
                // each render() call, so these are this frame's counts.
                st.calls = renderer.info.render.calls;
                st.tris = renderer.info.render.triangles;
                // First-frame proof-of-life: distinguishes "loop dead" from
                // "loop alive but black" without needing a debug panel open.
                if (!data.firstFrameLogged) {
                    data.firstFrameLogged = true;
                    log(`First frame ✓ (${mids.length} route nodes, dest ${destPin.group.visible ? 'shown' : 'hidden'}, cam ${camera.position.x.toFixed(1)},${camera.position.z.toFixed(1)} yaw ${camYaw.toFixed(1)}° pitch ${camPitch.toFixed(1)}°)`);
                }
            } catch (err) {
                const msg = err && err.message ? err.message : String(err);
                const nowMs = performance.now();
                frameErrCount += 1;
                statsRef.current.errors = frameErrCount;
                if (msg !== frameErrLast || nowMs - frameErrLastT > 5000) {
                    frameErrLast = msg;
                    frameErrLastT = nowMs;
                    log(`FRAME ERROR x${frameErrCount}: ${msg}`.slice(0, 200));
                }
            }
        };

        // Reset per-session world state so a re-open never inherits the
        // previous session's anchor frame or pointer.
        dataRef.current.worldAnchorKey = null;
        dataRef.current.worldAnchorPos = null;
        dataRef.current.elevBase = null;
        dataRef.current.firstFrameLogged = false;
        dataRef.current.destKey = null;
        dataRef.current.targetIdx = 1;

        render();

        return () => {
            cancelAnimationFrame(raf);
            window.removeEventListener('resize', onResize);
            window.removeEventListener('orientationchange', onResize);
            if (fovVideo) {
                fovVideo.removeEventListener('loadedmetadata', applyFov);
                fovVideo.removeEventListener('resize', applyFov);
            }
            spherePool.dispose();
            destPin.dispose();
            holoPath.dispose();
            road.dispose();
            buildingLayer.dispose();
            stairViz.dispose();
            nodeArrows.dispose();
            dataRef.current.worldAnchorKey = null;
            dataRef.current.worldAnchorPos = null;
            dataRef.current.elevBase = null;
            offArrow.dispose();
            renderer.dispose();
            if (rendererRef.current === renderer) rendererRef.current = null;
            if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
        };
    }, [started, glNonce]);

    // Compass permission is best-effort: denial must not block the camera.
    // True directions appear automatically once a heading arrives.
    const requestCompass = async () => {
        try {
            if (hasCompassPrompt) {
                const res = await DeviceOrientationEvent.requestPermission();
                setCompassBlocked(res !== 'granted');
                if (res === 'granted') {
                    // Re-register under the fresh permission: listeners
                    // attached before the prompt may never receive events.
                    rearmOrientation('compass permission granted');
                }
                return res === 'granted';
            }
        } catch {
            setCompassBlocked(true);
            return false;
        }
        // No prompt API on this browser (typical Android): listeners are
        // already attached, so headings either flow on their own or the
        // sensor is unavailable. Re-attach anyway if it has gone quiet —
        // this runs from the Start button / Compass-row tap, i.e. in a
        // real gesture, which is the one context that reliably restarts it.
        maybeRearmIfQuiet('compass requested');
        return false;
    };

    // Classic camera pipeline (getUserMedia + Three.js canvas overlay).
    const startFallbackCamera = async () => {
        log('startFallbackCamera called');
        if (!navigator.mediaDevices?.getUserMedia) {
            log('FAIL: navigator.mediaDevices.getUserMedia not available');
            setCamError({
                title: 'The camera needs a secure link',
                body: 'Browsers only allow the camera on pages opened with https://.',
                steps: ['Open the app from its https:// address', 'Tap Try again'],
            });
            return;
        }
        const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
            || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
        log(`iOS detected: ${isIOS} · UA: ${navigator.userAgent.slice(0, 60)}`);
        try {
            log('Calling getUserMedia — iOS will show permission dialog…');
            // CRITICAL (iOS): Force-hide the overlay via the DOM *synchronously*
            // so the native permission dialog is not trapped behind it.
            // React state is async — setCameraPending(true) won't re-render
            // until the current task yields, by which time iOS has already
            // spawned the dialog behind the opaque overlay.
            if (camOverlayRef.current) {
                camOverlayRef.current.style.display = 'none';
            }
            setCameraPending(true);
            let stream;
            try {
                stream = await navigator.mediaDevices.getUserMedia({
                    video: { facingMode: { ideal: 'environment' } },
                    audio: false,
                });
            } catch (e) {
                // A denial is not a constraint problem. Retrying fires a SECOND
                // getUserMedia while the first is still refused, and Chrome
                // answers that by auto-denying the retry without prompting — so
                // the genuine reason never surfaces and we report a bare
                // NotAllowedError. Only retry the case this fallback exists for:
                // the rear-camera constraint could not be satisfied.
                if (e?.name === 'NotAllowedError' || e?.name === 'SecurityError') throw e;
                log(`getUserMedia with environment failed (${e?.name}: ${e?.message}) — retrying with any camera…`);
                stream = await navigator.mediaDevices.getUserMedia({
                    video: true,
                    audio: false,
                });
            }
            log(`getUserMedia OK — tracks: ${stream.getTracks().length}, video tracks: ${stream.getVideoTracks().length}`);
            streamRef.current = stream;
            // Video-track settings (resolution / frame rate / facing) are an
            // input to the debug panel — captured once per stream.
            try {
                const track = stream.getVideoTracks()[0];
                trackSettingsRef.current = track && typeof track.getSettings === 'function' ? track.getSettings() : null;
                const ts = trackSettingsRef.current;
                log(`track settings: ${ts ? `${ts.width}x${ts.height} @${ts.frameRate ?? '?'}fps facing=${ts.facingMode ?? '?'}` : 'unavailable'}`);
            } catch {
                trackSettingsRef.current = null;
            }

            if (videoRef.current) {
                const v = videoRef.current;
                // iOS hardening: properties (not just JSX attrs) must be set before play().
                v.muted = true;
                v.defaultMuted = true;
                v.playsInline = true;
                v.autoplay = true;
                try { v.disablePictureInPicture = true; } catch { /* older iOS */ }
                v.setAttribute('playsinline', '');
                v.setAttribute('webkit-playsinline', '');
                v.setAttribute('muted', '');
                // One-frame-then-black forensics: log every state transition.
                const ev = (name) => () => log(`video event: ${name} rs=${v.readyState} paused=${v.paused} ${v.videoWidth}x${v.videoHeight} t=${v.currentTime.toFixed(2)}`);
                v.onplaying = ev('playing');
                v.onpause = ev('pause');
                v.onended = ev('ended');
                v.onwaiting = ev('waiting');
                v.onstalled = ev('stalled');
                v.onsuspend = ev('suspend');
                v.onemptied = ev('emptied');
                v.onerror = () => log(`video event: error rs=${v.readyState} err=${v.error ? v.error.code : '?'}`);
                // NOTE: never call v.load() on a MediaStream source — on Safari
                // it aborts the attachment (single `emptied` event, rs stuck
                // at 0, play() hangs forever). Just set srcObject + play().
                v.srcObject = stream;
                log('srcObject attached — calling play() (6s timeout)…');
                // iOS stalls play() forever (waiting/suspend, rs=0) once the tap
                // gesture decays — never await it unbounded or the UI hangs
                // on the permission banner with a dark screen.
                const playP = v.play();
                const timeoutP = new Promise((_, rej) => setTimeout(() => rej(new DOMException('play() timed out after 6s', 'TimeoutError')), 6000));
                try {
                    await Promise.race([playP, timeoutP]);
                } catch (e) {
                    log(`play() stalled: ${e.name}: ${e.message} — showing TAP TO PLAY`);
                    // Leave the pending play() promise alone; if it resolves
                    // late it just starts the video under us.
                    playP.then(() => {
                        log('late play() resolved');
                        setNeedsTapToPlay(false);
                        setCameraPending(false);
                        setStarted(true);
                    }).catch(() => {});
                    // Stay OUT of started mode: keeps the menu mounted and
                    // avoids booting WebGL on a dead video (which on old
                    // iPhones can take the whole tab down with it).
                    setCameraPending(false);
                    setNeedsTapToPlay(true);
                    log('waiting for user tap to finish video start…');
                    return;
                }
                log(`play() resolved — readyState: ${v.readyState}, paused: ${v.paused}, video: ${v.videoWidth}×${v.videoHeight}`);
            } else {
                log('FAIL: videoRef.current is null');
            }

            // CRITICAL: Update both React states in the same synchronous
            // block so React batches them into ONE re-render.
            // If setCameraPending(false) runs alone (before setStarted),
            // React re-renders with started=false → video gets display:none
            // → iOS kills the stream → black screen.
            setCameraPending(false);
            setStarted(true);
            log('setStarted(true) — React re-render scheduled');
        } catch (err) {
            setCameraPending(false);
            setNeedsTapToPlay(false);
            if (camOverlayRef.current) {
                camOverlayRef.current.style.display = '';
            }
            log(`FAIL: ${err.name}: ${err.message}`);
            // Clean up: stop tracks and reset state so the UI isn't stuck.
            streamRef.current?.getTracks().forEach((t) => t.stop());
            streamRef.current = null;
            setStarted(false);
            if (err.name === 'NotAllowedError') {
                // Chrome will not re-prompt once a permission has been denied,
                // so "allow and retry" is not something the page can do — the
                // stored denial has to be cleared first. Point at the exact
                // control, and mention motion sensors while we're there: this
                // view needs both, and a denied sensor permission looks like
                // "14 events, every field null".
                // The browser will not ask again by itself, so say where the switch is.
                const isAndroid = /Android/i.test(navigator.userAgent);
                setCamError({
                    title: 'Camera access is off',
                    body: 'The 3D view shows the arrows over your camera. Allow the camera for this site, then try again.',
                    steps: isIOS
                        ? ['Open Settings, then Safari, then Camera', 'Choose Allow', 'Come back here and tap Reload page']
                        : isAndroid
                            ? ['Tap the icon left of the address bar', 'Open Permissions and turn Camera on', 'Tap Try again']
                            : ['Click the camera or lock icon in the address bar', 'Allow the camera for this site', 'Click Try again'],
                    // Safari only picks up a changed setting on a fresh load.
                    reload: isIOS,
                });
            } else if (err.name === 'NotFoundError' || err.name === 'OverconstrainedError') {
                setCamError({ title: 'No camera found', body: 'This device has no camera the browser can use. You can still follow the route in 3D.' });
            } else if (err.name === 'NotReadableError' || err.name === 'AbortError') {
                setCamError({
                    title: 'The camera is busy',
                    body: 'Another app or tab is using the camera.',
                    steps: ['Close the other app or tab', 'Tap Try again'],
                });
            } else {
                setCamError({ title: "The camera didn't start", body: `Try again, or continue without it. (${err.name || 'Error'})` });
            }
        }
    };

    // A denied camera must not block the 3D view. The feed is only the
    // backdrop — the nodes, route and heading are the thing under test, and
    // gating all of it on getUserMedia meant one stored denial made the whole
    // screen untestable (and the browser refuses to re-prompt, so the user
    // could not even get back in).
    // Set while the person chose to go on without the camera, so the effect
    // that re-opens the feed (below) does not try again, fail and bounce them
    // back to the start card. Cleared when they ask for the camera again.
    const noCameraRef = useRef(false);
    const startWithoutCamera = () => {
        log('continuing into 3D view WITHOUT a camera feed — backdrop will be solid');
        noCameraRef.current = true;
        setCameraPending(false);
        setNeedsTapToPlay(false);
        setStarted(true);
    };

    // Starts the camera and asks for compass access (best-effort).
    const startCamera = async () => {
        noCameraRef.current = false;
        setCamError(null);
        setNeedsTapToPlay(false);
        // Free-roam flies a black stage: the webcam feed is meaningless
        // behind a desktop walkthrough, so skip the permission prompt and
        // the stream entirely and boot straight into the 3D scene.
        if (freeRoamRef.current) {
            anchorRef.current = null;
            dataRef.current.worldAnchorKey = null;
            dataRef.current.worldAnchorPos = null;
            setCameraPending(false);
            setStarted(true);
            log('free-roam stage — camera skipped, black background');
            return;
        }
        anchorRef.current = null;
        dataRef.current.worldAnchorKey = null;
        dataRef.current.worldAnchorPos = null;
        // Compass FIRST, before the getUserMedia await. This runs in the task
        // the user's tap scheduled, so transient activation is still live —
        // and on browsers that ship DeviceOrientationEvent.requestPermission
        // the grant only counts when the request is made with activation
        // present. Asking seconds later (the old placement, after the camera
        // opened) lands outside it.
        const compass = requestCompass();
        await startFallbackCamera();
        // getUserMedia is exactly where your log's orientation freeze began
        // (ev=0→4 flowing, then dead from the moment the camera opened), so
        // restart the sensor stream once the camera is actually up rather
        // than waiting for the watchdog or for a tap.
        maybeRearmIfQuiet('camera started');
        compass.then((ok) => log(`Compass result: ${ok ? 'granted' : 'denied/unavailable'}`));
    };

    // Auto-start camera immediately when the 3D View mounts from the user's tap gesture
    useEffect(() => {
        startCamera();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Free-roam owns the camera hardware: entering it releases the feed
    // (black stage), leaving it re-opens the feed. An effect — not the menu
    // handler — so the video element has already re-painted visible before a
    // restart touches it. (Hiding a live video kills the stream on iOS, and
    // there is no stream left to kill here: tracks stop first, always.)
    useEffect(() => {
        if (!started) return;
        if (freeRoamRef.current) {
            if (streamRef.current) {
                streamRef.current.getTracks().forEach((t) => t.stop());
                streamRef.current = null;
            }
            if (videoRef.current) videoRef.current.srcObject = null;
            log('free-roam on — camera released, black stage');
        } else if (!streamRef.current && !noCameraRef.current) {
            log('free-roam off — reopening camera');
            startFallbackCamera();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [freeRoam, started]);

    // Fresh user gesture that finishes a stalled iOS video start.
    const resumeVideoPlay = async () => {
        const v = videoRef.current;
        if (!v) { log('TAP TO PLAY: videoRef is null'); return; }
        log('TAP TO PLAY tapped — calling play() in gesture…');
        try {
            await v.play();
            log(`tap play() resolved — rs=${v.readyState} paused=${v.paused} ${v.videoWidth}x${v.videoHeight} t=${v.currentTime.toFixed(2)}`);
            setNeedsTapToPlay(false);
            setCameraPending(false);
            setStarted(true);
        } catch (err) {
            log(`tap play() failed: ${err.name}: ${err.message}`);
        }
    };

    // Leaving: the view is still mounted while the exit overlay fades in, and must not fall back to its start card.
    const [exiting, setExiting] = useState(false);
    const stopAll = () => {
        setExiting(true);
        // Release the mouse before unmounting, or the next screen inherits a
        // locked pointer with nothing left to unlock it.
        if (document.pointerLockElement) document.exitPointerLock();
        setPointerLocked(false);
        setCameraPending(false);
        setNeedsTapToPlay(false);
        setStarted(false);
        anchorRef.current = null;
        dataRef.current.worldAnchorKey = null;
        dataRef.current.worldAnchorPos = null;
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        // Clear the video srcObject so iOS fully releases the camera.
        if (videoRef.current) {
            videoRef.current.srcObject = null;
        }
        onExit();
    };

    // ── Shared UI strings (same wording/format as the 2D screen) ─────
    // Header: active destination, exactly as the 2D header's select shows it.
    const destNode = route && route.path && route.path.length ? route.path[route.path.length - 1] : null;
    const destLabel = destNode ? (destNode.name || `Location ${destNode.id}`) : '3D view';
    // Floor picker state. `hasFloorRow` also drives the direction banner's
    // top offset, so the two cards never overlap when the row is absent.
    // A lone chip ("G") with nothing to switch to is noise, so the picker only
    // appears when there is actually more than one floor to choose from.
    const hasFloorRow = Array.isArray(floors) && floors.length > 1;
    // "CCS · Floor 2" without the building's floor count ("of 3"), which next to
    // the floor switch read as a contradiction.
    const destWhere = String(destPlace || '').replace(/\s+of\s+\d+$/, '');
    // Corner-preview scale for the camera layer while the map is the main view:
    // about a third of the width on phones, capped on large screens.
    // Map mode's corner camera preview: small, so the map really gets the screen.
    const pipScale = Math.max(0.14, Math.min(0.26, (isPhone ? viewport.w * 0.22 : Math.min(200, viewport.w * 0.18)) / viewport.w));
    // The map's buildings, (re)drawn once the map exists and when they change.
    useEffect(() => {
        drawMiniBuildings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [miniReady, buildings]);

    // The map changes size when it swaps with the camera; Leaflet must re-measure.
    useEffect(() => {
        if (!showMiniMap) return undefined;
        const ids = [60, 420].map((ms) => window.setTimeout(() => {
            try { miniMapObj.current?.invalidateSize?.(); } catch { /* not ready */ }
        }, ms));
        return () => ids.forEach((id) => window.clearTimeout(id));
    }, [mapMain, showMiniMap]);

    // Footer: route summary in the 2D footer's format (`812 m · 6 pts`).
    const routeStopCount = route ? route.node_count : 0;
    const routeStopsLabel = `${routeStopCount} ${routeStopCount === 1 ? 'stop' : 'stops'}`;
    // The route leaves this floor by a staircase: a hint with its incline.
    const stairHint = route?.stairs?.find((st) => st.from_floor === floor) || null;
    const routeSummary = route ? `${formatDistance(route.total_distance_meters)} · ${formatWalkTime(route.total_distance_meters)} · ${routeStopsLabel}` : 'No route yet';

    // ── Docked 2D mini-map: Leaflet lifecycle ─────────────────────────
    // Created once the card mounts (showMiniMap && started), torn down when
    // it unmounts. Same dark tiles, campus lock and gesture rules as the
    // main 2D screen; zoom left free (17–19) so the strip can show context.
    useEffect(() => {
        if (!showMiniMap || !started || !miniMapRef.current || miniMapObj.current) return undefined;
        const map = L.map(miniMapRef.current, {
            zoomControl: true,
            minZoom: 17,
            maxZoom: 19,
            maxBounds: campusLatLngBounds(),
            maxBoundsViscosity: 1.0,
            ...CAMPUS_MAP_LOCK,
        });
        createTileLayer({ flavor: GPS_FLAVOR, hiddenLayers: GPS_HIDDEN_LAYERS }).addTo(map);
        // The base map's own buildings and roads are hidden on the GPS maps, so
        // the campus's labelled buildings and pathways are what give the
        // mini-map its landmarks (same drawing as /map, display only).
        drawPathways(L.layerGroup().addTo(map), pathways, { theme: GPS_FLAVOR });
        miniBuildingsRef.current = L.layerGroup().addTo(map);
        bindLabelZoom(map);
        const walkedFix = freeRoamRef.current && dataRef.current.user?.source === 'freeroam'
            ? dataRef.current.user
            : null;
        const fix = walkedFix || userLocation;
        if (fix && Number.isFinite(fix.latitude) && Number.isFinite(fix.longitude)) {
            map.setView([fix.latitude, fix.longitude], 18);
        } else {
            map.setView(CAMPUS_CENTER, 18);
        }
        // Same campus lock as the 2D maps (the strip zooms 17 to 19).
        lockToCampus(map, { minZoom: 17 });
        miniMapObj.current = map;
        setMiniReady(true);
        return () => {
            map.remove();
            miniMapObj.current = null;
            setMiniReady(false);
            miniUserRef.current = null;
            miniAccRef.current = null;
            miniRouteGlowRef.current = null;
            miniRouteRef.current = null;
            miniDestRef.current = null;
            miniPovRef.current = null;
            miniDirRef.current = null;
            miniBuildingsRef.current = null;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [showMiniMap, started]);

    // Keep the Leaflet viewport in sync with the responsive strip height
    // (rotation, split-screen, collapse/expand). Without this the tiles keep
    // the old size and the strip shows grey gutters.
    useEffect(() => {
        if (!showMiniMap || miniCollapsed || !miniMapObj.current) return undefined;
        const id = window.setTimeout(() => {
            try { miniMapObj.current?.invalidateSize?.(); } catch { /* not ready */ }
        }, 120);
        return () => window.clearTimeout(id);
    }, [showMiniMap, miniCollapsed, miniH, viewport.w, viewport.h]);

    // ── Docked 2D mini-map: live data ─────────────────────────────────
    // Follows the GPS fix Google-Maps-style (map recenters under the dot)
    // and redraws the route + destination from the live route prop. Driven
    // by props, not the render loop: fixes arrive at ~1 Hz, so direct
    // Leaflet mutation costs nothing and needs no React state.
    useEffect(() => {
        const map = miniMapObj.current;
        if (!map || !showMiniMap) return;
        // While free-roaming, use the same virtual fix that the Three.js loop
        // is currently rendering; otherwise restore the live GPS fix. This is
        // important when the mini-map is opened mid-walk or free-roam is exited.
        const walkedFix = freeRoam && dataRef.current.user?.source === 'freeroam'
            ? dataRef.current.user
            : null;
        const fix = walkedFix || userLocation;
        if (fix && Number.isFinite(fix.latitude) && Number.isFinite(fix.longitude)) {
            syncMiniMapFix(fix, true);
        }
        const path = route && Array.isArray(route.path) ? route.path : null;
        if (path && path.length >= 2) {
            const latlngs = path.map((p) => [p.latitude, p.longitude]);
            if (miniRouteGlowRef.current) {
                miniRouteGlowRef.current.setLatLngs(latlngs);
            } else {
                miniRouteGlowRef.current = L.polyline(latlngs, {
                    color: ROUTE_CASING, weight: 8, opacity: 0.85, lineJoin: 'round', lineCap: 'round', interactive: false,
                }).addTo(map);
            }
            if (miniRouteRef.current) {
                miniRouteRef.current.setLatLngs(latlngs);
            } else {
                miniRouteRef.current = L.polyline(latlngs, {
                    color: C.route, weight: 4, opacity: 0.95, lineJoin: 'round', lineCap: 'round', interactive: false,
                }).addTo(map);
            }
            const dest = latlngs[latlngs.length - 1];
            if (miniDestRef.current) {
                miniDestRef.current.setLatLng(dest);
            } else {
                miniDestRef.current = L.marker(dest, { icon: MINI_DEST_ICON, zIndexOffset: 900, interactive: false }).addTo(map);
            }
        } else {
            // No route (yet): clear stale path layers, keep the user dot.
            for (const ref of [miniRouteGlowRef, miniRouteRef, miniDestRef]) {
                if (ref.current) {
                    map.removeLayer(ref.current);
                    ref.current = null;
                }
            }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [userLocation, route, showMiniMap, started, freeRoam]);

    // ── Mini-map direction: camera heading + nearest-node arrow ──────
    // The map never rotates (north stays up), so "which way do I turn" is
    // shown two ways on the user dot: the POV wedge (absolute camera
    // heading) and a small arrow rotated by the signed angle from the
    // camera facing to the nearest remaining stop (0° = straight ahead).
    // Leaflet is mutated straight from refs on a 100 ms ticker — the
    // heading lives in dataRef/motionRef at sensor rate and must never
    // flow through React state.
    useEffect(() => {
        if (!showMiniMap || !started) return undefined;
        const id = window.setInterval(() => {
            const map = miniMapObj.current;
            if (!map || miniCollapsed) return;
            const d = dataRef.current;
            const fix = (d.user && Number.isFinite(d.user.latitude) && Number.isFinite(d.user.longitude))
                ? d.user
                : userLocation;
            if (!fix || !Number.isFinite(fix.latitude) || !Number.isFinite(fix.longitude)) return;
            const ll = [fix.latitude, fix.longitude];

            // Positions of the wedge and arrow belong to the follower (it
            // moves them with the dot every frame). Setting them here as
            // well would yank them to the un-eased target and flicker. New
            // markers are born at the dot's DRAWN position.
            const drawn = miniFollowRef.current.current;
            const born = drawn ? [drawn.lat, drawn.lng] : ll;
            const spin = miniSpinRef.current;
            if (!miniPovRef.current) {
                // 850 < 900: the wedge sits beneath the arrow (900 < 1000:
                // both stay beneath the you-are-here dot).
                miniPovRef.current = L.marker(born, {
                    icon: MINI_POV_ICON, zIndexOffset: 850, interactive: false, keyboard: false,
                }).addTo(map);
                if (spin.hasValue) paintPovRotation(miniPovRef.current, spin.angle);
            }
            if (!miniDirRef.current) {
                miniDirRef.current = L.marker(born, {
                    icon: MINI_DIR_ICON, zIndexOffset: 900, interactive: false, keyboard: false,
                }).addTo(map);
            }

            // Absolute camera heading in [0, 360). Compass headings arrive
            // as norm180; free-roam yaw is radians with azimuth = −yaw.
            let headingDeg = null;
            if (freeRoamRef.current) {
                const yaw = lookRef.current.yaw;
                if (Number.isFinite(yaw)) headingDeg = ((-yaw * 180) / Math.PI % 360 + 360) % 360;
            } else if (Number.isFinite(motionRef.current.yaw)) {
                headingDeg = ((motionRef.current.yaw % 360) + 360) % 360;
            } else if (d.heading !== null && d.heading !== undefined && Number.isFinite(d.heading)) {
                headingDeg = ((d.heading % 360) + 360) % 360;
            }

            // Nearest remaining stop by straight-line distance.
            const path = d.route && Array.isArray(d.route.path) ? d.route.path : null;
            let rel = null;
            if (path && path.length > 1 && headingDeg !== null) {
                let best = null;
                let bestDist = Infinity;
                for (let k = 1; k < path.length; k += 1) {
                    const p = path[k];
                    if (!Number.isFinite(p.latitude) || !Number.isFinite(p.longitude)) continue;
                    const r = bearingAndDistance(fix.latitude, fix.longitude, p.latitude, p.longitude);
                    if (r.dist < bestDist) {
                        bestDist = r.dist;
                        best = { bearing: r.bearing };
                    }
                }
                if (best) rel = norm180(best.bearing - headingDeg);
            }

            try {
                // SmoothAngle unwraps against the last painted angle (crossing
                // north rotates 2°, not 358° backwards) and eases between
                // the ticker's samples.
                if (headingDeg !== null) miniSpinRef.current.set(headingDeg);
                // Without a heading the wedge has no meaning — hide it, keep the dot.
                if (miniPovRef.current.getElement()) {
                    miniPovRef.current.getElement().style.display = headingDeg === null ? 'none' : '';
                }
                const dirEl = miniDirRef.current.getElement()?.querySelector('.dir-rot');
                if (dirEl && rel !== null) {
                    // Same unwrap: rel is a signed turn in (−180, 180], so a
                    // stop passing directly behind you would otherwise flip
                    // the arrow to the other side instead of sweeping past.
                    const prev = miniDirAngleRef.current;
                    const next = prev === null
                        ? rel
                        : rel + 360 * Math.round((prev - rel) / 360);
                    miniDirAngleRef.current = next;
                    dirEl.style.transform = `rotate(${next}deg)`;
                }
                if (miniDirRef.current.getElement()) {
                    miniDirRef.current.getElement().style.display = rel === null ? 'none' : '';
                }
                // Heading pill mirrors the mobile page readout ("123° NE").
                if (miniHdgRef.current) {
                    if (headingDeg === null) {
                        miniHdgRef.current.style.display = 'none';
                    } else {
                        const points = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
                        const shownDeg = ((headingDeg % 360) + 360) % 360;
                        const label = points[Math.round(shownDeg / 45) % 8];
                        miniHdgRef.current.textContent = `· ${Math.round(shownDeg) % 360}° ${label}`;
                        miniHdgRef.current.style.display = '';
                    }
                }
            } catch { /* marker mid-rebuild — next tick retries */ }
        }, 100);
        return () => window.clearInterval(id);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [showMiniMap, started, miniCollapsed, userLocation]);

    // ── Per-second heartbeat into the cam log ────────────────────────
    // Four lines per tick, one tick per second, reading ONLY refs — so the
    // trail records exactly which of the three inputs (orientation events,
    // GPS fixes, render loop/canvas) was alive at each moment. This is the
    // copy-pasteable answer to "what is frozen until I tap?".
    const buildHeartbeat = () => {
        const d = dataRef.current;
        const u = d.user;
        const o = deviceOrientationRef.current;
        const st = statsRef.current;
        const R = rendererRef.current;
        const v = videoRef.current;
        const anchor = anchorRef.current;
        const now = performance.now();
        const f = (n, dp = 1) => (Number.isFinite(n) ? Number(n).toFixed(dp) : '-');
        const ago = (t) => (t ? `${Math.round(now - t)}ms ago` : 'never');
        return [
            `hb frames ${st.totalFrames} · loop ${ago(st.lastFrameAt)} · fps ${f(st.fps, 0)} · errors ${f(st.errors, 0)}`
                + ` · video ${v ? (v.paused ? 'PAUSED' : `playing rs${v.readyState}`) : 'none'}`
                + ` · canvas ${R ? `${R.domElement.width}x${R.domElement.height} ar=${f(st.aspect, 2)}` : 'not started'}`,
            `    orient ev=${orientEventsRef.current} · last ${ago(lastOrientAtRef.current)}`
                + ` · fed camera ${ago(lastRotAtRef.current)} · re-arm gap ${Math.round(orientRearmGapRef.current)}ms`
                + ` · src ${d.sensorSource ?? 'none'}${absoluteSeenRef.current ? '' : ' (abs unseen)'}`
                + ` · a/b/g ${o ? `${f(o.alpha)}/${f(o.beta)}/${f(o.gamma)}` : 'NO EVENT'}`
                + ` · hdg ${f(d.heading, 1)}° · cam yaw ${f(st.camYaw)}° pitch ${f(st.camPitch)}° (${st.quatSource ?? 'none'})`
                + ` · focus ${document.hasFocus()} · vis ${document.visibilityState} · generic ${genericStateRef.current}`,
            `    yaw offset ${f(yawOffsetRef.current)}° · sensed az ${f(sensorAzRef.current)}°`
                + ` · gps speed ${f(u?.speed, 1)} m/s course ${f(u?.course, 0)}°`
                + ` · course ${f(courseInfoRef.current.course, 0)}° via ${courseInfoRef.current.src}`
                + ` · fuse ${fuseRef.current.state} Δraw ${f(fuseRef.current.raw)}° Δ ${f(fuseRef.current.delta)}° dev ${f(fuseRef.current.devT)}s`
                + ` · last course nudge ${lastCourseFixRef.current.t ? `${f(lastCourseFixRef.current.step)}° ${Math.round(now - lastCourseFixRef.current.t)}ms ago` : 'none'}`,
            `    gps ${u ? `${f(u.latitude, 6)},${f(u.longitude, 6)} ±${f(u.accuracy, 0)}m${u.source ? ` ${u.source}` : ''}` : 'NO FIX'}`
                + (u && u.source === 'pin' ? ' · MANUAL PIN — live GPS ignored' : '')
                + ` · prop arrived ${ago(lastUserAtRef.current)}`
                + ` · anchor ${anchor ? `${f(anchor.latitude, 5)},${f(anchor.longitude, 5)}` : 'none'}`,
            `    world cam x=${f(st.camX)} z=${f(st.camZ)} y=${f(st.camY)} · drawn ${f(st.drawn, 0)}`
                + ` · bake ${d.worldAnchorKey ?? 'none'} · route ${d.route ? `${d.route.node_count} pts` : 'none'}`
                // Free-roam telemetry: which keys are actually down, the raw
                // look angles, and whether the mouse is captured. The one
                // thing that cannot be read from a screenshot.
                + (freeRoamRef.current
                    ? ` · free-roam ${document.pointerLockElement ? 'MOUSE LOCKED' : 'unlocked'}`
                        + ` keys ${keysHeld(keysRef.current)}`
                        + ` · look ${f((lookRef.current.yaw * 180) / Math.PI)}°,${f((lookRef.current.pitch * 180) / Math.PI)}°`
                        + ` · seeded ${freePosRef.current.seeded}`
                        // What was last handed to the parent for the Dijkstra
                        // recompute — the thing to check when the path looks
                        // pinned to the old position.
                        + ` · reported ${walkedReportRef.current.lat === null
                            ? 'none'
                            : `${f(walkedReportRef.current.lat, 5)},${f(walkedReportRef.current.lng, 5)}`
                                + ` ${Math.round(performance.now() - walkedReportRef.current.at)}ms ago`}`
                    : ' · free-roam off'),
        ].join('\n');
    };

    // An unfocused page is the one measured state with ev=0 and no timer-based
    // way out: v9 stayed at ev=0 for 26 s and recovered on the `focus` event
    // a touch produced. Ask for focus back — same window, so browsers allow
    // it — but only a few times, so this cannot fight the user for the
    // omnibox. If it works, the focus listener re-arms the sensors too.
    const maybeStealFocus = () => {
        if (document.hasFocus()) return;
        const now = performance.now();
        if (now - focusAttemptAtRef.current < 5000) return;
        focusAttemptAtRef.current = now;
        const tries = focusAttemptCountRef.current + 1;
        focusAttemptCountRef.current = tries;
        if (tries > 3) return;
        window.focus();
        log(`window unfocused (attempt ${tries}) — called window.focus() → hasFocus=${document.hasFocus()}`);
    };

    const beginTouchLook = (event) => {
        // In mobile control mode, drag-look works with touch/pen on phones and
        // with the emulated pointer in a narrow DevTools viewport as well.
        if (!dragLook || !freeRoamRef.current) return;
        event.preventDefault();
        setDragged(true);
        touchLookRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
        event.currentTarget.setPointerCapture?.(event.pointerId);
    };

    const updateTouchLook = (event) => {
        const drag = touchLookRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        event.preventDefault();
        const dx = event.clientX - drag.x;
        const dy = event.clientY - drag.y;
        drag.x = event.clientX;
        drag.y = event.clientY;
        const look = lookRef.current;
        const sensitivity = FREE_ROAM_LOOK * 1.7;
        look.yaw -= dx * sensitivity;
        if (look.yaw > Math.PI) look.yaw -= Math.PI * 2;
        else if (look.yaw < -Math.PI) look.yaw += Math.PI * 2;
        look.pitch = clamp(look.pitch - dy * sensitivity, -FREE_ROAM_PITCH_MAX, FREE_ROAM_PITCH_MAX);
    };

    const endTouchLook = (event) => {
        if (touchLookRef.current?.pointerId !== event.pointerId) return;
        touchLookRef.current = null;
        try { event.currentTarget.releasePointerCapture?.(event.pointerId); } catch { /* no-op */ }
    };

    // Starts at mount (not at Start) so the trail covers the permission
    // window and the first frames too. One React render per second as a
    // side effect of log() — far below sensor rate, harmless to the loop.
    // checkOrientStall() rides along here: one look per second is frequent
    // enough to un-freeze the camera within a couple of seconds of a stall.
    useEffect(() => {
        const id = setInterval(() => {
            // Silent for 6 s (or never), past the mount grace period → try the
            // other API rather than re-attaching the same dead listener pair.
            // Covers BOTH patterns seen on this device: ev=0 for the entire
            // session (v9) and a 4-event burst at mount then silence (v5).
            // 'idle' only: an errored attempt is retried from a gesture, never
            // from here, so a permanent denial cannot spam the log once a second.
            const silentFor = lastOrientAtRef.current
                ? performance.now() - lastOrientAtRef.current
                : Infinity;
            // Two ways for the orientation pipeline to be dead. The original
            // (v9/v5) pattern is no events at all. The second is a stream that
            // keeps FIRING but has never yielded a heading — alpha === null on
            // every event, so the magnetometer yaw never arrives. That is
            // "chatty but blind": event silence never reaches 6 s, so the gate
            // below never opened and AbsoluteOrientationSensor — a different
            // API with a own permission model, and the one thing that could
            // still hand us yaw — was never attempted.
            const headingFor = lastHeadingAtRef.current
                ? performance.now() - lastHeadingAtRef.current
                : Infinity;
            const chattyButBlind = headingFor >= 6000 && orientEventsRef.current > 0;
            if ((silentFor >= 6000 || chattyButBlind)
                && genericStateRef.current === 'idle'
                && performance.now() >= genericNotBeforeRef.current) {
                startGenericSensor();
            }
            checkOrientStall();
            maybeStealFocus();
            log(buildHeartbeat());
        }, 1000);
        return () => clearInterval(id);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return (
        <div
            ref={rootRef}
            className="ar-stage"
            onClick={() => setMenuOpen(false)}
            style={{ position: 'fixed', inset: 0, background: C.page, zIndex: 5000, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}
        >
            <style>{HUD_CSS + arBtnStyle + INTERACTION_CSS}</style>
            {/* Rear camera, full-bleed (z-index 1).
                display is ALWAYS block — never let React set display:none
                on the video element because iOS Safari kills the camera
                stream when the element is hidden.  The overlay (z-index 4)
                covers the video before the camera starts. */}
            {/* The camera + 3D overlay live in ONE layer so the camera <-> map
                swap can shrink them together. The layer keeps its full size
                (the renderer sizes from the mount's clientWidth) and is scaled
                with a CSS transform into a corner preview, so the camera,
                projection and FOV maths never change. */}
            <div
                className="ar-cam-layer"
                style={{
                    position: 'absolute', inset: 0, overflow: 'hidden',
                    zIndex: mapMain ? 4 : 1,
                    transformOrigin: 'top right',
                    transform: mapMain
                        ? `translate(-10px, calc(max(8px, env(safe-area-inset-top)) + ${hasFloorRow ? 116 : 72}px)) scale(${pipScale})`
                        : 'translate(0px, 0px) scale(1)',
                    borderRadius: mapMain ? 16 / pipScale : 0,
                    boxShadow: mapMain ? `0 0 0 ${2 / pipScale}px rgba(255,255,255,0.4), 0 ${10 / pipScale}px ${30 / pipScale}px rgba(0,0,0,0.6)` : 'none',
                }}
            >
            <video
                ref={videoRef}
                muted
                playsInline
                autoPlay
                style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', zIndex: 1 }}
            />
            {/* Transparent 3D overlay (z-index 2) */}
            <div ref={mountRef} style={{ position: 'absolute', inset: 0, zIndex: 2, pointerEvents: 'none', background: 'transparent' }} />
            {mapMain && (
                <button
                    type="button"
                    className="ar-pip-hit"
                    aria-label={freeRoam ? 'Show the 3D view full screen' : 'Show the camera full screen'}
                    onClick={(e) => { e.stopPropagation(); setViewMode('camera'); }}
                />
            )}
            </div>

            {/* Desktop free-roam look layer. Sits above the Three canvas
                (which is pointer-events:none) but below the top bar and the
                ☰ sheet, so menu and Back-to-2D stay clickable. Covering the
                bottom bar too is intentional — in free-roam a click anywhere
                should capture the mouse, and that bar holds no controls. */}
            {freeRoam && started && !mapMain && !followMain && (
                <div
                    ref={lookLayerRef}
                    onPointerDown={beginTouchLook}
                    onPointerMove={updateTouchLook}
                    onPointerUp={endTouchLook}
                    onPointerCancel={endTouchLook}
                    onClick={() => {
                        if (dragLook) return;
                        const el = lookLayerRef.current;
                        if (!el || document.pointerLockElement === el) return;
                        try {
                            // Chrome ≥113 returns a promise here. A refusal
                            // (no gesture, still cooling down from an Esc)
                            // must be swallowed or the page-level
                            // unhandledrejection trap logs it as a crash.
                            const p = el.requestPointerLock?.();
                            if (p && typeof p.catch === 'function') p.catch(() => {});
                        } catch {
                            // Older browsers reject synchronously; the
                            // pointerlockerror listener below reports it.
                        }
                    }}
                    style={{
                        position: 'absolute', inset: 0, zIndex: 2, pointerEvents: 'auto',
                        cursor: pointerLocked ? 'none' : (dragLook ? 'grab' : 'crosshair'),
                        background: 'transparent', touchAction: dragLook ? 'none' : 'auto',
                    }}
                >
                    {/* Crosshair: the camera feed gives free-roam no fixed
                        landmark to judge aim against, and it doubles as
                        unmistakable proof that the mouse is captured. */}
                    {pointerLocked && <div className="ar-crosshair" />}
                </div>
            )}
            {freeRoam && started && !pointerLocked && !mapMain && !followMain && !(dragLook && dragged) && (
                <div className="ar-look-hint">
                    {dragLook ? 'Drag to look around' : 'Click to look around'}
                    <small>{dragLook ? 'WASD walks · or turn Free roam off to follow GPS' : 'WASD to walk · Esc releases the mouse'}</small>
                </div>
            )}

            {/* Top HUD card — the reference's floating glass panel: a
                telemetry strip, the active destination under it and the route
                summary as a chip in the exact format the 2D footer shows
                (`812 m · 6 pts`), so both screens report the same state. */}
            <div
                ref={topCardRef}
                onClick={() => setMenuOpen(false)}
                className="ar-panel"
                style={{
                    position: 'absolute', zIndex: 3,
                    top: 'max(8px, env(safe-area-inset-top))',
                    left: isPhone ? 8 : 10,
                    right: isWide ? 'auto' : (isPhone ? 8 : 10),
                    width: isWide ? 380 : undefined,
                    padding: isPhone ? '7px 8px' : '9px 10px',
                }}
            >
                <div className="ar-topbar" style={{ flexWrap: 'wrap' }}>
                    <button
                        onClick={(e) => { e.stopPropagation(); setMenuOpen((o) => !o); }}
                        className="ar-btn ar-btn-ghost ar-menu-btn"
                        aria-label="Menu"
                        aria-expanded={menuOpen}
                    >
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ flex: 'none' }}>
                            <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                        </svg>
                        <span className="ar-menu-label">Menu</span>
                    </button>
                    <div className="ar-dest-text">
                        <div className="ar-dest" title={destLabel}>{destLabel}</div>
                        {/* Where it is. The route numbers live in the guidance card, so
                            they are repeated here only while that card is hidden. */}
                        <div className="ar-dest-sub">
                            {!showGuidance && route
                                ? `${formatDistance(route.total_distance_meters)} · ${formatWalkTime(route.total_distance_meters)}`
                                : (destWhere || (route ? routeStopsLabel : 'No route yet'))}
                        </div>
                    </div>
                    {hasFloorRow && (
                        <div
                            className="seg ar-floor-seg" role="radiogroup" aria-label="Floor"
                            style={{ '--seg-i': Math.max(0, floors.indexOf(floor)), '--seg-n': floors.length }}
                        >
                            <span className="seg-thumb" aria-hidden="true" />
                            {floors.map((f) => (
                                <button
                                    key={f} type="button" role="radio" aria-checked={f === floor} aria-label={floorAria(f)}
                                    onClick={(e) => { e.stopPropagation(); onFloorChange?.(f); }}
                                >
                                    {floorTag(f)}
                                </button>
                            ))}
                        </div>
                    )}
                </div>
                {stairHint && (
                    <div className="ar-stair-hint" role="status">
                        <span className="ar-stair-arrow" aria-hidden="true" style={{ transform: `rotate(${stairHint.direction === 'up' ? -stairHint.angle_deg : stairHint.angle_deg}deg)` }}>&rarr;</span>
                        <span>
                            Take the stairs {stairHint.direction} to {floorAria(stairHint.to_floor).toLowerCase()}, then tap {floorTag(stairHint.to_floor)}
                        </span>
                    </div>
                )}
            </div>

            {/* Nearest stop: a two-part chip — distance as the value, the turn
                as a small label. The direction itself is already carried by
                the route arrows and the centred 3D cue, so this stays text-only.
                Hidden until a route and a fix both exist. */}
            <div
                ref={dirBannerRef}
                role="status"
                aria-label="Distance to the nearest stop"
                className="ar-panel ar-guide-chip"
                style={{
                    position: 'absolute', zIndex: 3, display: 'none',
                    visibility: showGuidance ? 'hidden' : undefined,
                    top: `calc(max(8px, env(safe-area-inset-top)) + ${topCardH + 6}px)`,
                    left: isWide ? 10 : '50%', transform: isWide ? 'none' : 'translateX(-50%)',
                    pointerEvents: 'none',
                    maxWidth: 'min(320px, calc(100vw - 24px))',
                }}
            >
                <span ref={dirTextRef} className="ar-guide-dist" />
                <span ref={dirTurnRef} className="ar-guide-turn" />
            </div>

            {menuOpen && (
                <div
                    onClick={(e) => e.stopPropagation()}
                    className="ar-panel anim-in"
                    style={{
                        position: 'absolute', zIndex: 7,
                        top: 'calc(env(safe-area-inset-top) + 78px)', left: 10,
                        width: 'min(320px, calc(100vw - 20px))',
                        padding: '10px', display: 'flex', flexDirection: 'column', gap: '8px',
                    }}
                >
                    <button onClick={stopAll} className="ar-btn ar-menu-row">
                        Back to 2D map
                    </button>
                    <div className="hud-divider" style={{ width: 'auto', height: 1, alignSelf: 'auto', margin: '2px 0' }} />
                    <button
                        onClick={() => setTechDetails((v) => !v)}
                        className="ar-btn ar-menu-row"
                        aria-pressed={techDetails}
                    >
                        Technical details
                        <span style={{ color: techDetails ? C.white : C.muted, fontWeight: 700 }}>{techDetails ? 'On' : 'Off'}</span>
                    </button>
                    <button
                        onClick={() => {
                            setFreeRoam((v) => {
                                const next = !v;
                                if (!next && document.pointerLockElement) document.exitPointerLock();
                                return next;
                            });
                        }}
                        className="ar-btn ar-menu-row"
                        aria-pressed={freeRoam}
                    >
                        Free roam
                        <span style={{ color: freeRoam ? C.white : C.muted, fontWeight: 700 }}>{freeRoam ? 'On' : 'Off'}</span>
                    </button>
                    {freeRoam && (
                        <div style={{ fontSize: TYPE.desc, color: C.muted, lineHeight: '1.45', padding: '0 4px' }}>
                            {dragLook
                                ? 'Drag the view to look around; WASD walks when a keyboard is attached.'
                                : 'WASD to walk; click the view for mouse look.'}{' '}
                            Walking moves your position, so distances and the 2D map follow.
                        </div>
                    )}
                </div>
            )}

            {compassWarn && (
                <div
                    role="status"
                    className="ar-notice is-attention"
                    style={{
                        top: `calc(env(safe-area-inset-top) + ${ctxLost ? 150 : 78}px)`,
                        right: isWide ? 'auto' : 10, width: isWide ? 380 : undefined, pointerEvents: 'none',
                    }}
                >
                    {compassWarn}
                </div>
            )}

            {ctxLost && (
                <div
                    role="alert"
                    className="ar-notice is-error"
                    style={{ top: 'calc(env(safe-area-inset-top) + 78px)', right: isWide ? 'auto' : 10, width: isWide ? 380 : undefined }}
                >
                    <span>The 3D layer paused because the phone reclaimed graphics memory. The camera is still live.</span>
                    <button
                        onClick={() => { setCtxLost(false); setGlNonce((n) => n + 1); }}
                        className="ar-btn ar-btn-primary ar-notice-btn"
                    >
                        Resume 3D
                    </button>
                </div>
            )}

            {/* Bottom guidance card — the 2D `.mnav-footer` content in the
                reference's card form: telemetry header, guidance text, then a
                metric readout under a hairline rule. Taps here close the menu,
                same as tapping anywhere else outside the sheet. Toggleable
                from ☰ (some presenters want the bare camera feed); when the
                mini-map is docked beneath, the card lifts clear of it. */}
            {showGuidance && (
            <div
                onClick={() => setMenuOpen(false)}
                ref={setGuideEl}
                className={`ar-panel anim-in ar-guidance${isShortLandscape ? ' is-short' : ''}`}
                style={isShortLandscape ? {
                    // Phone on its side: one compact line in the bottom-right corner,
                    // clear of the zoom (left) and the map buttons (top right).
                    // The numbers are one tap away under Details.
                    position: 'absolute', zIndex: 3, left: 'auto', right: 10, width: 'min(340px, 44vw)',
                    bottom: `calc(${SAFE_BOTTOM} + ${DOCK_LIFT}px)`, padding: '8px 12px',
                    boxShadow: '0 -16px 40px rgba(0,0,0,0.6)',
                } : {
                    position: 'absolute', zIndex: 3,
                    // Wide: left column, same 380px as the top card. Phones and
                    // tablets: full width, stacked above the mini-map.
                    right: isWide ? 'auto' : (isPhone ? 8 : 10),
                    width: isWide ? 380 : undefined,
                    maxWidth: isWide ? undefined : 460, marginLeft: isWide ? 0 : 'auto', marginRight: isWide ? 0 : 'auto',
                    bottom: showMiniMap && !mapMain && !isWide
                        ? `calc(${SAFE_BOTTOM} + ${miniLift + DOCK_LIFT}px)`
                        : `calc(${SAFE_BOTTOM} + ${DOCK_LIFT}px)`,
                    left: isPhone ? 8 : 10,
                    padding: isPhone ? '8px 10px 10px' : '10px 12px 12px',
                    maxHeight: isPhone ? '30dvh' : isShortLandscape ? '46dvh' : '38dvh',
                    overflowY: 'auto', WebkitOverflowScrolling: 'touch',
                    boxShadow: '0 -16px 40px rgba(0,0,0,0.6)',
                }}
            >
                {/* The turn as an arrow (pointing where to go, relative to the phone),
                    the instruction, then one quiet line of numbers. */}
                <div className="ar-step">
                    <span ref={instrIconRef} className="ar-step-icon" data-state="none" aria-hidden="true">
                        <svg className="ar-step-arrow" width="30" height="30" viewBox="0 0 24 24" fill="none">
                            <path d="M12 20V5M6 11l6-6 6 6" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                        <svg className="ar-step-check" width="30" height="30" viewBox="0 0 24 24" fill="none">
                            <path d="m5 12.5 4.5 4.5L19 7.5" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                    </span>
                    <div className="ar-instr ar-step-text" aria-live="polite">
                        <div ref={instrRef} className="ar-instr-main">{!started ? 'Starting camera…' : 'Getting ready'}</div>
                        <div ref={instrSubRef} className="ar-instr-sub" />
                    </div>
                </div>
                <div className="ar-guide-stats">
                    <span><b ref={closestRef}>-</b> left</span>
                    <span ref={closestNodeRef} />
                    <span>Stop <b ref={stopCountRef}>-</b></span>
                    {canSpeak && (
                        <button type="button" className={`ar-voice-btn${voiceOn ? ' is-on' : ''}`} aria-pressed={voiceOn}
                            onClick={(e) => { e.stopPropagation(); toggleVoice(); }}
                            title={voiceOn ? 'Spoken directions are on. Tap to turn them off.' : 'Hear the directions spoken aloud (works offline with the phone’s own voice).'}>
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                                <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
                                {voiceOn
                                    ? <path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                                    : <path d="m16 9.5 5 5m0-5-5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />}
                            </svg>
                            Voice {voiceOn ? 'on' : 'off'}
                        </button>
                    )}
                </div>
                {/* Field-test telemetry, off unless switched on in the menu. */}
                {techDetails && (
                    <div className="ar-tech">
                        <div ref={hudRef} className="ar-tech-lines" />
                        <div ref={youRef} className="ar-tech-lines" />
                    </div>
                )}
            </div>
            )}

            {/* Docked 2D top-view — the Leaflet GPS map from the main screen,
                shrunk to a strip: white you-dot, white route, green destination,
                recentering under the fix like a nav app. Toggled from the bottom dock,
                which can also swap it with the camera (the map then fills the
                stage and the camera becomes a corner preview). */}
            {showMiniMap && started && (
                <div
                    className={`ar-panel anim-in ar-miniwrap${mapMain ? ' is-full' : ''}${mapMain && showGuidance && !isWide && !isShortLandscape ? ' credit-top' : ''}`}
                    style={mapMain ? {
                        position: 'absolute', zIndex: 2, top: 0, left: 0, right: 0, bottom: 0,
                        padding: 0, borderRadius: 0, border: 'none', boxShadow: 'none',
                        background: C.page, WebkitBackdropFilter: 'none', backdropFilter: 'none',
                        '--ar-map-top': `calc(max(8px, env(safe-area-inset-top)) + ${topCardH + (showGuidance ? 10 : 52)}px)`,
                    } : {
                        position: 'absolute', zIndex: 3,
                        // Wide: pinned to the right column; otherwise centred full-width strip.
                        left: isWide ? 'auto' : (isPhone ? 8 : 10), right: isPhone ? 8 : 10,
                        width: isWide ? 420 : undefined,
                        maxWidth: isWide ? undefined : 560, marginLeft: isWide ? 0 : 'auto', marginRight: isWide ? 0 : 'auto',
                        bottom: isWide ? SAFE_BOTTOM : `calc(${SAFE_BOTTOM} + ${DOCK_LIFT}px)`,
                        padding: isPhone ? '6px' : '8px',
                        boxShadow: '0 -16px 40px rgba(0,0,0,0.6)',
                    }}
                >
                    {mapMain && satellite && (
                        <button
                            type="button"
                            className="ar-mini-toggle ar-map-sat"
                            style={{ right: `calc(max(10px, env(safe-area-inset-right)) + ${Math.round(viewport.w * pipScale) + 10}px)` }}
                            aria-pressed={satellite.active}
                            disabled={!satellite.online}
                            title={satellite.online ? 'Aerial photo under the map (Esri)' : 'Aerial photos need internet. Your GPS location still works offline.'}
                            onClick={(e) => { e.stopPropagation(); satellite.setOn(!satellite.on); }}
                        >
                            {satellite.online ? (satellite.active ? 'Map' : 'Satellite') : 'No photos'}
                        </button>
                    )}
                    <div
                        ref={miniMapRef}
                        className="ar-minimap"
                        style={mapMain ? {
                            height: '100%', display: 'block', borderRadius: 0, overflow: 'hidden', background: C.page,
                        } : {
                            height: miniCollapsed ? 0 : miniH,
                            display: miniCollapsed ? 'none' : 'block',
                            borderRadius: PANEL_RADIUS - 4, overflow: 'hidden', background: C.page,
                        }}
                    />
                </div>
            )}

            {followMain && started && !freeRoam && (
                <button
                    type="button"
                    className={`ar-btn ar-mini-toggle ar-test-walk${followTest ? ' is-on' : ''}`}
                    style={{ top: `calc(max(8px, env(safe-area-inset-top)) + ${topCardH + 10}px)` }}
                    aria-pressed={followTest}
                    title={followTest ? 'Back to your real GPS position' : 'Walk with a joystick or W A S D, for trying it off campus'}
                    onClick={(e) => { e.stopPropagation(); setFollowTest((v) => !v); }}
                >
                    {followTest ? 'Stop test walk' : 'Test walk'}
                </button>
            )}
            {followMain && started && (
                <div style={{ position: 'absolute', inset: 0, zIndex: 2 }}>
                    <FollowView3D
                        route={route} buildings={buildings} links={links} pathways={pathways} bridges={bridges} nodes={nodes}
                        getPose={getFollowPose}
                        floor={floor}
                        testWalk={testWalkOn}
                        onTestMove={onTestMove}
                        joyBottom={`calc(${SAFE_BOTTOM} + ${DOCK_LIFT + (showGuidance ? guideH + 12 : 12)}px)`}
                        // Rebuilt when the STOPS change, not on each GPS fix (the
                        // piece from you to the next stop is drawn live).
                        routeKey={(route?.path || []).filter((q) => q.type !== 'user').map((q) => q.id).join(',')}
                    />
                </div>
            )}

            {/* Bottom-centre dock: the controls you need while walking, always at
                the thumb. Details and the mini-map toggle on/off; the third
                button swaps the camera (or, in free roam, the 3D view) with
                the map, so either one can be the main view. */}
            {started && (
                <div className={`ar-panel ar-dock${isWide ? ' is-wide' : ''}`} role="toolbar" aria-label="3D view controls" onClick={(e) => e.stopPropagation()}>
                    <button
                        type="button"
                        className="ar-btn ar-dock-btn"
                        aria-pressed={showGuidance}
                        onClick={() => setShowGuidance((v) => !v)}
                    >
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 4h10M3 8h10M3 12h6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
                        <span className="ar-dock-label">Details</span>
                    </button>
                    {/* Camera (AR over the camera, or a walk-through in free roam) |
                        3D (you from behind and above, game style) | Map (flat, north up). */}
                    <div className="seg ar-mode" role="radiogroup" aria-label="View" style={{ '--seg-i': followMain ? 1 : mapMain ? 2 : 0, '--seg-n': 3 }}>
                        <span className="seg-thumb" aria-hidden="true" />
                        <button type="button" role="radio" aria-checked={!mapMain && !followMain} onClick={() => setViewMode('camera')}>
                            {freeRoam ? 'Walk' : 'Camera'}
                        </button>
                        <button type="button" role="radio" aria-checked={followMain} onClick={() => setViewMode('follow')}>
                            3D
                        </button>
                        <button type="button" role="radio" aria-checked={mapMain} onClick={() => setViewMode('map')}>
                            Map
                        </button>
                    </div>
                    <button type="button" className="ar-btn ar-dock-btn ar-dock-exit" onClick={stopAll} aria-label="Exit the 3D view and return to the 2D map">
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
                        <span className="ar-dock-label">Exit</span>
                    </button>
                </div>
            )}

            {/* Arrival: the trip's ending gets its own moment and a clear next step. */}
            {arrived && started && (
                <div className="ar-arrive" role="dialog" aria-labelledby="ar-arrive-title" onClick={(e) => e.stopPropagation()}>
                    <div className="ar-panel ar-arrive-card">
                        <svg className="ar-arrive-mark" viewBox="0 0 48 48" aria-hidden="true">
                            <circle cx="24" cy="24" r="22" fill="none" stroke="currentColor" strokeWidth="2.5" />
                            <path d="M14.5 24.5l6.5 6.5 12.5-13" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                        <h2 className="ar-arrive-title" id="ar-arrive-title">You have arrived</h2>
                        <p className="ar-arrive-place">{arrived.name}{destWhere ? `, ${destWhere}` : ''}</p>
                        <div className="ar-arrive-actions">
                            <button type="button" className="ar-btn ar-btn-primary ar-arrive-btn" onClick={stopAll}>Back to map</button>
                            <button type="button" className="ar-btn ar-btn-ghost ar-arrive-btn" onClick={() => setArrived(null)}>Stay here</button>
                        </div>
                    </div>
                </div>
            )}

            {!started && !exiting && (
                <div ref={camOverlayRef} className="ar-start">
                    <div className="ar-panel ar-start-card" role="dialog" aria-labelledby="ar-start-title">
                        <h2 className="ar-start-title" id="ar-start-title">{route ? `To ${destLabel}` : '3D view'}</h2>
                        {route && destWhere && <div className="ar-start-place">{destWhere}</div>}
                        <div className="metric-value ar-start-summary">{routeSummary}</div>
                        {!camError && (
                            <ul className="ar-start-tips">
                                <li>
                                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="4" y="1.5" width="8" height="13" rx="2" stroke="currentColor" strokeWidth="1.4" /><path d="M7 12h2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
                                    <span>Hold your phone up and follow the arrows on the camera view.</span>
                                </li>
                                <li>
                                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" /><circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.4" /></svg>
                                    <span><b>Look up from the screen</b> at crossings, stairs and doors. The arrows guide you; your surroundings come first.</span>
                                </li>
                            </ul>
                        )}
                        {camError && (
                            <div className="ar-start-error" role="alert">
                                <p className="ar-start-error-title">
                                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2 5.5A1.5 1.5 0 0 1 3.5 4h1.7l1-1.5h3.6l1 1.5h1.7A1.5 1.5 0 0 1 14 5.5v6a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5v-6z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" /><path d="M2.5 2.5l11 11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
                                    {camError.title}
                                </p>
                                <p className="ar-start-error-body">{camError.body}</p>
                                {camError.steps?.length > 0 && (
                                    <ol className="ar-start-steps">
                                        {camError.steps.map((step) => <li key={step}>{step}</li>)}
                                    </ol>
                                )}
                            </div>
                        )}
                        <div className="ar-start-actions">
                            <button
                                onClick={camError?.reload ? () => window.location.reload() : startCamera}
                                className="ar-btn ar-btn-primary ar-start-btn"
                                aria-busy={cameraPending}
                                disabled={cameraPending}
                            >
                                {cameraPending
                                    ? <span className="ar-spin" aria-hidden="true" />
                                    : <svg width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2 5.5A1.5 1.5 0 0 1 3.5 4h1.7l1-1.5h3.6l1 1.5h1.7A1.5 1.5 0 0 1 14 5.5v6a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5v-6z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" /><circle cx="8" cy="8.5" r="2.3" stroke="currentColor" strokeWidth="1.4" /></svg>}
                                {freeRoam ? 'Start 3D view' : (cameraPending ? 'Starting camera' : camError?.reload ? 'Reload page' : camError ? 'Try again' : 'Start camera')}
                            </button>
                            {/* The camera is a backdrop, not the feature. When it is
                                denied (and the browser will not ask again) this is
                                the way into the view: route and arrows on a plain
                                background. */}
                            {camError && !freeRoam && (
                                <button onClick={startWithoutCamera} className="ar-btn ar-btn-ghost ar-start-btn is-secondary">
                                    Continue without camera
                                </button>
                            )}
                            {/* User control/freedom: this opaque overlay covers the
                                ☰ bar, so the way back to the 2D map is offered here,
                                as the quiet option. */}
                            <button onClick={stopAll} className="ar-btn ar-start-btn is-tertiary">
                                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M10 3.5L5.5 8l4.5 4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
                                Back to 2D map
                            </button>
                        </div>
                        <div className="ar-start-build">Build {APP_TAG}</div>
                    </div>
                </div>
            )}
            {/* Stalled autoplay rescue — a fresh tap carries a new user gesture,
                which is the only thing that unlocks iOS video after the
                original Start-tap gesture has decayed. */}
            {needsTapToPlay && (
                <button
                    onClick={resumeVideoPlay}
                    className="ar-btn ar-btn-primary"
                    style={{
                        position: 'absolute', zIndex: 8, left: 16, right: 16, top: '42%',
                        padding: '16px 20px', borderRadius: PILL,
                        fontSize: TYPE.sub, fontWeight: '700',
                    }}
                >
                    Start video
                    <div style={{ fontSize: TYPE.desc, fontWeight: '400', marginTop: '6px', color: C.white }}>
                        iOS paused autoplay. One tap resumes the feed
                    </div>
                </button>
            )}
            {/* iOS permission dialog overlay — shown while waiting for the native camera permission prompt */}
            {cameraPending && (
                <div style={{
                    position: 'absolute', zIndex: 3, top: 0, left: 0, right: 0,
                    background: C.bar, color: C.text, borderBottom: `1px solid ${C.border}`,
                    padding: '16px', paddingTop: 'max(16px, env(safe-area-inset-top))',
                    textAlign: 'center', fontSize: TYPE.sub, fontWeight: '600', lineHeight: '1.5',
                }}>
                        Waiting for camera permission…
                    <div style={{ fontSize: TYPE.sub, color: C.muted, marginTop: '6px', fontWeight: '400' }}>
                        Tap <b>Allow</b> on the iOS dialog above, or
                        check <b>Settings → Safari → Camera</b> if nothing appears.
                    </div>
                </div>
            )}
        </div>
    );
}
