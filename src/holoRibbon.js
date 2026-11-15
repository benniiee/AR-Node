// Holographic route visuals for the 3D AR view — the "line connection".
//
// Ported from the original 3D design reference and re-coloured to this app's
// black/white/green palette: a glowing translucent tube along the path, arrowhead
// chevrons that march toward the destination, a floating destination pin with
// a ground ripple, a pulsing "you are here" halo, and spatial dust.
//
// These are world-scale meshes that give the path a 3D presence; the flat
// screen-space markers in `routeArrows.js` handle the readable-at-any-distance
// job. ARView draws both, so the route never disappears when the tube is too
// thin to see and never loses its shape when the camera is right on top of it.
//
// Scale decisions, because the reference camera hovers 48 m up while ours sits
// at eye height: world sizes are trimmed, and the tube start is trimmed back
// by `HOLO_MIN_START` metres so the ribbon never wraps around the camera.
import * as THREE from 'three';

/** Shared colours (the Three.js twins of `uiTokens.js` `C`). */
export const HOLO = {
    /** Destination green - the beacon, its beam and rings */
    glow: 0x22c55e,
    /** Deep green - beam falloff */
    glowDeep: 0x0b4a24,
    /** The route: white, like the guidance arrows */
    route: 0xffffff,
    /** Route falloff / edge shell (neutral grey, never tinted) */
    routeDeep: 0x9aa0a6,
    /** Chevrons / highlights */
    ice: 0xffffff,
    /** Problem signal ONLY (a stop dropped from the route). Never navigation. */
    alert: 0xff2338,
    /** Spatial dust */
    dust: 0xd1fae5,
    /** Scene fog colour */
    fog: 0x0b0b0f,
};

export const HOLO_TUBE_RADIUS = 0.34;
export const HOLO_TUBE_SEGMENTS = 120;
export const HOLO_TUBE_RADIAL = 8;
/** Chevrons float this far above the tube centre line. */
export const HOLO_LIFT = 0.8;
/** The tube starts this far ahead of the camera (never wraps the viewer). */
export const HOLO_MIN_START = 2.6;
/** Roughly one chevron every N metres of route. */
export const HOLO_CHEVRON_GAP = 4;
/** Curve units per second — how fast the arrows march toward the goal. */
export const HOLO_CHEVRON_SPEED = 0.12;
export const HOLO_MAX_CHEVRONS = 20;

// Scratch objects for the per-frame chevron update — module scope so the
// render loop never allocates.
const _pt = new THREE.Vector3();
const _tan = new THREE.Vector3();
const _look = new THREE.Vector3();

/** Smoothstep 0→1 across [a, b] — eased end fades, no per-frame allocation. */
function sstep(a, b, x) {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
}

/**
 * Drop the first `minDist` metres of a polyline (which starts at the camera)
 * so a world-scale tube is never built on top of the viewer. Returns `[]` when
 * the whole route is shorter than `minDist`, i.e. the walker has arrived.
 *
 * @param {{x:number,y:number,z:number}[]} pts polyline, pts[0] == the camera
 * @param {number} minDist metres to skip from the head
 * @returns {{x:number,y:number,z:number}[]}
 */
export function trimPathStart(pts, minDist) {
    const out = [];
    let acc = 0;
    for (let i = 1; i < pts.length; i += 1) {
        const a = pts[i - 1];
        const b = pts[i];
        const seg = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
        if (seg > 0 && acc + seg >= minDist) {
            const t = (minDist - acc) / seg;
            out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });
            for (let j = i; j < pts.length; j += 1) out.push(pts[j]);
            return out;
        }
        acc += seg;
    }
    return out;
}

/**
 * Glowing tube + marching chevrons along a route.
 *
 * @returns {{
 *   group: THREE.Group,
 *   setPoints: (pts: {x:number,y:number,z:number}[]) => void,
 *   tick: (time: number, dt: number) => void,
 *   dispose: () => void,
 * }}
 */
export function createHoloPath({
    color = HOLO.route,
    emissive = HOLO.routeDeep,
    chevronColor = HOLO.ice,
    radius = HOLO_TUBE_RADIUS,
    maxChevrons = HOLO_MAX_CHEVRONS,
} = {}) {
    const group = new THREE.Group();
    group.visible = false;

    const tubeMat = new THREE.MeshPhongMaterial({
        color,
        emissive,
        specular: 0xffffff,
        shininess: 70,
        transparent: true,
        opacity: 0.9,
        // Pure overlay: the camera feed behind it is the background, so this
        // must never write depth or it punches holes in the markers.
        depthWrite: false,
    });
    // Full-circle outline shell for the tube: a slightly fatter BackSide copy
    // of the same path, so the connector reads as a solid pipe with a crisp
    // circular edge from every angle — including level with the line, where
    // the translucent core alone thins to almost nothing.
    const tubeEdgeMat = new THREE.MeshBasicMaterial({
        color: HOLO.routeDeep,
        transparent: true,
        opacity: 0.9,
        side: THREE.BackSide,
        depthWrite: false,
    });

    // ConeGeometry points along +Y; rotating +90° about X puts the apex on
    // +Z, the axis `Object3D.lookAt()` aims for a plain mesh — so the
    // arrowhead faces the direction of travel. `scale.y` then flattens it into
    // an arrow lying in the horizontal plane (local Y stays world-up).
    const chevronGeo = new THREE.ConeGeometry(0.62, 1.0, 3);
    chevronGeo.rotateX(Math.PI / 2);
    // Vertex-colour shading on the cone itself: the leading tip vertices are
    // mid grey, blending linearly back to light grey at the base — never
    // white. The camera chases the arrows from behind, so it mostly sees the
    // trailing faces; keeping the base grey too is what makes the shading
    // visible at all. Darker tip = forward, lighter base = behind. Pushed
    // deliberately dark: a flat white arrow washes out over bright video.
    const CHEVRON_TIP = new THREE.Color(0xe6e6e6); // same as base: flat white, no gradient
    const CHEVRON_BASE = new THREE.Color(0xe6e6e6);
    {
        chevronGeo.computeBoundingBox();
        const bb = chevronGeo.boundingBox;
        const span = Math.max(1e-6, bb.max.z - bb.min.z);
        const pp = chevronGeo.attributes.position;
        const cols = new Float32Array(pp.count * 3);
        const tmp = new THREE.Color();
        for (let i = 0; i < pp.count; i += 1) {
            const tt = (pp.getZ(i) - bb.min.z) / span;
            tmp.copy(CHEVRON_BASE).lerp(CHEVRON_TIP, tt);
            cols[i * 3] = tmp.r;
            cols[i * 3 + 1] = tmp.g;
            cols[i * 3 + 2] = tmp.b;
        }
        chevronGeo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    }
    const chevBaseMat = new THREE.MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 1,
        side: THREE.DoubleSide,
        depthWrite: false,
    });
    // Dark BackSide shell on every arrow: a heavy drop-shadow edge so the
    // body keeps contrast over bright video and the silhouette stays readable.
    // Kept strong on purpose — a faint rim disappeared over daylight feed.
    const chevBaseEdgeMat = new THREE.MeshBasicMaterial({
        color: 0x050507,
        transparent: true,
        opacity: 0.8,
        side: THREE.BackSide,
        depthWrite: false,
    });
    // Shared radial halo pooled on the tube beneath each arrow — one texture,
    // tinted white per sprite, so the arrow reads as light cast on the path.
    const haloTex = (() => {
        const c = document.createElement('canvas');
        c.width = 64;
        c.height = 64;
        const ctx = c.getContext('2d');
        // Flat disc, no gradient: the system palette is solid colours only.
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        ctx.beginPath();
        ctx.arc(32, 32, 28, 0, Math.PI * 2);
        ctx.fill();
        return new THREE.CanvasTexture(c);
    })();
    // Each chevron owns its body / edge / halo materials so end fades animate
    // per arrow (shared materials could only fade the whole formation).
    const chevrons = [];
    for (let i = 0; i < maxChevrons; i += 1) {
        const mat = chevBaseMat.clone();
        const edgeMat = chevBaseEdgeMat.clone();
        const mesh = new THREE.Mesh(chevronGeo, mat);
        const edge = new THREE.Mesh(chevronGeo, edgeMat);
        edge.scale.setScalar(1.25);
        edge.renderOrder = -4;
        mesh.add(edge);
        mesh.scale.set(1, 0.3, 1);
        mesh.visible = false;
        mesh.renderOrder = -3;
        group.add(mesh);
        const glowMat = new THREE.SpriteMaterial({
            map: haloTex, color: HOLO.route, transparent: true, opacity: 0, depthWrite: false,
        });
        const glow = new THREE.Sprite(glowMat);
        glow.visible = false;
        glow.renderOrder = -4;
        group.add(glow);
        chevrons.push({ mesh, mat, edgeMat, glow, glowMat });
    }

    let tube = null;
    let tubeEdge = null;
    // End-cap domes (start + end, core + outline) sharing capGeo / capEdgeGeo.
    let tubeCaps = [];
    let capGeo = null;
    let capEdgeGeo = null;
    let curve = null;
    let chevronCount = 0;
    let phase = 0;

    const clearTube = () => {
        if (tube) {
            group.remove(tube);
            tube.geometry.dispose();
            tube = null;
        }
        if (tubeEdge) {
            group.remove(tubeEdge);
            tubeEdge.geometry.dispose();
            tubeEdge = null;
        }
        for (const m of tubeCaps) group.remove(m);
        tubeCaps = [];
        if (capGeo) {
            capGeo.dispose();
            capGeo = null;
        }
        if (capEdgeGeo) {
            capEdgeGeo.dispose();
            capEdgeGeo = null;
        }
    };

    const hide = () => {
        clearTube();
        curve = null;
        chevronCount = 0;
        for (const c of chevrons) {
            c.mesh.visible = false;
            c.glow.visible = false;
        }
        group.visible = false;
    };

    return {
        group,
        setPoints(points) {
            if (!points || points.length < 2) {
                hide();
                return;
            }
            const vecs = points.map((p) => new THREE.Vector3(p.x, p.y, p.z));
            curve = new THREE.CatmullRomCurve3(vecs, false, 'catmullrom', 0.5);
            clearTube();
            tube = new THREE.Mesh(
                new THREE.TubeGeometry(curve, HOLO_TUBE_SEGMENTS, radius, HOLO_TUBE_RADIAL, false),
                tubeMat,
            );
            tube.renderOrder = -4;
            group.add(tube);
            tubeEdge = new THREE.Mesh(
                new THREE.TubeGeometry(curve, HOLO_TUBE_SEGMENTS, radius * 1.35, HOLO_TUBE_RADIAL, false),
                tubeEdgeMat,
            );
            tubeEdge.renderOrder = -5;
            group.add(tubeEdge);
            // Rounded end caps: an open TubeGeometry ends in a blunt cut and
            // the transparent wall shows the hollow interior (the flat face in
            // the screenshot). A dome at each end closes the pipe — rebuilt
            // here, so no per-frame cost.
            capGeo = new THREE.SphereGeometry(radius, 12, 10);
            capEdgeGeo = new THREE.SphereGeometry(radius * 1.35, 12, 10);
            for (const tt of [0, 1]) {
                const p = curve.getPointAt(tt);
                const cap = new THREE.Mesh(capGeo, tubeMat);
                cap.position.copy(p);
                cap.renderOrder = -4;
                group.add(cap);
                tubeCaps.push(cap);
                const capEdge = new THREE.Mesh(capEdgeGeo, tubeEdgeMat);
                capEdge.position.copy(p);
                capEdge.renderOrder = -5;
                group.add(capEdge);
                tubeCaps.push(capEdge);
            }

            // One arrow every HOLO_CHEVRON_GAP metres, capped by the pool size.
            const length = curve.getLength();
            chevronCount = Math.min(maxChevrons, Math.max(3, Math.round(length / HOLO_CHEVRON_GAP)));
            for (let i = 0; i < chevrons.length; i += 1) {
                const on = i < chevronCount;
                chevrons[i].mesh.visible = on;
                chevrons[i].glow.visible = on;
            }
            group.visible = true;
        },
        /** Call once per rendered frame with the frame's elapsed time and dt. */
        tick(time, dt) {
            if (!group.visible || !curve || chevronCount === 0) return;
            // March the whole formation forward; wrapping by 1 keeps the value
            // small enough never to lose float precision over a long walk.
            phase = (phase + HOLO_CHEVRON_SPEED * (Number.isFinite(dt) ? dt : 0)) % 1;
            if (phase < 0) phase += 1;
            for (let i = 0; i < chevronCount; i += 1) {
                const c = chevrons[i];
                const t = (i / chevronCount + phase) % 1;
                curve.getPointAt(t, _pt);
                curve.getTangentAt(t, _tan);
                c.mesh.position.set(_pt.x, _pt.y + HOLO_LIFT, _pt.z);
                _look.copy(_pt).add(_tan);
                // Aim from the arrow's own height, not the tube's: the mesh
                // floats HOLO_LIFT above the path, so targeting the unlifted
                // point tilted every arrow nose-down. Lifting the target by
                // the same amount keeps the chevron level (90°).
                _look.y += HOLO_LIFT;
                // lookAt aims the mesh's local +Z at the target, and the cone
                // apex sits on +Z after the rotateX above — so the tip points
                // along the tangent, node to node toward the gate. No extra
                // yaw: a 180° spin here is what turned the arrows back on the
                // camera.
                c.mesh.lookAt(_look);
                // Tiny bob so the arrows read as hovering, not painted on.
                c.mesh.position.y += Math.sin(time * 3 + i) * 0.05;
                // End fades: each arrow materializes out of the user end and
                // dissolves into the gate, instead of blinking at both caps.
                const a = Math.min(sstep(0, 0.12, t), 1 - sstep(0.88, 1, t));
                c.mat.opacity = a;
                c.edgeMat.opacity = 0.8 * a;
                const s = 0.7 + 0.3 * a;
                c.mesh.scale.set(s, 0.3 * s, s);
                // Halo pooled on the tube beneath the arrow, breathing with it.
                c.glow.position.set(_pt.x, _pt.y + 0.15, _pt.z);
                c.glowMat.opacity = 0.35 * a;
                const gs = 1.1 + 0.5 * a;
                c.glow.scale.set(gs, gs, 1);
            }
        },
        dispose() {
            clearTube();
            chevronGeo.dispose();
            haloTex.dispose();
            for (const c of chevrons) {
                group.remove(c.glow);
                group.remove(c.mesh);
                c.mat.dispose();
                c.edgeMat.dispose();
                c.glowMat.dispose();
            }
            chevrons.length = 0;
            tubeMat.dispose();
            tubeEdgeMat.dispose();
            group.parent?.remove(group);
        },
    };
}

/**
 * 3D destination marker for campus wayfinding: a light beacon topped by a
 * floating "arrive here" arrow.
 *
 *  - a tall, soft column of light (fading upward, slow shimmer) so the
 *    destination can be spotted from across the campus;
 *  - thin rings that rise up the beam like an elevator signal, which says
 *    "this spot" without any racing / event imagery;
 *  - a chunky downward-pointing arrow hovering above the beam, bobbing, with
 *    a white outline. It is the green twin of the white route arrows and always
 *    turns to face the walker, so it reads from any approach direction;
 *  - a glowing target disc, rim and sonar ripples on the ground that pin the
 *    marker to the exact destination point.
 *
 * `group.position` is the destination node (ground point); `group.scale` and
 * `group.visible` are driven by ARView, and `tick(time, camera)` animates it
 * (the camera makes the arrow face the user).
 */
export function createDestinationPin({
    color = HOLO.glow,
    headRadius = 0.6,
} = {}) {
    const group = new THREE.Group();
    group.visible = false;
    // 0.6 was the old pin's reference radius; keep it as the 1:1 size.
    const U = headRadius / 0.6;
    const disposables = [];
    const track = (o) => { disposables.push(o); return o; };

    // ── Light beam ───────────────────────────────────────────────────────
    const BEAM_H = 4.4 * U;
    const beamVert = `
        varying float vY;
        void main() {
            vY = uv.y;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`;
    const beamFrag = `
        uniform vec3 uColor;
        uniform float uOpacity;
        uniform float uTime;
        varying float vY;
        void main() {
            // Bright at the ground, gone by the top.
            float fall = pow(clamp(1.0 - vY, 0.0, 1.0), 1.5);
            // Slow upward-travelling shimmer so the beam feels alive.
            float shimmer = 0.85 + 0.15 * sin(vY * 22.0 - uTime * 2.6);
            // Fade in over the first few cm so the base meets the disc softly.
            float foot = smoothstep(0.0, 0.04, vY);
            gl_FragColor = vec4(uColor, uOpacity * fall * shimmer * foot);
        }`;
    const makeBeam = (rTop, rBottom, opacity) => {
        const geo = track(new THREE.CylinderGeometry(rTop * U, rBottom * U, BEAM_H, 32, 1, true));
        geo.translate(0, BEAM_H / 2, 0);
        const mat = track(new THREE.ShaderMaterial({
            uniforms: {
                uColor: { value: new THREE.Color(color) },
                uOpacity: { value: opacity },
                uTime: { value: 0 },
            },
            vertexShader: beamVert,
            fragmentShader: beamFrag,
            transparent: true,
            depthWrite: false,
            side: THREE.DoubleSide,
            blending: THREE.AdditiveBlending,
        }));
        const mesh = new THREE.Mesh(geo, mat);
        mesh.renderOrder = -2;
        group.add(mesh);
        return mat;
    };
    const beamOuter = makeBeam(0.3, 0.46, 0.34);   // wide soft glow
    const beamCore = makeBeam(0.08, 0.14, 0.8);    // thin bright core

    // ── Ground: target disc, fixed rim and two sonar ripples ─────────────
    const discGeo = track(new THREE.CircleGeometry(0.92 * U, 48));
    discGeo.rotateX(-Math.PI / 2);
    const discMat = track(new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.22, depthWrite: false,
        side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
    }));
    const disc = new THREE.Mesh(discGeo, discMat);
    disc.position.y = 0.03;
    disc.renderOrder = -4;
    group.add(disc);

    const ringGeo = track(new THREE.RingGeometry(0.88 * U, 0.98 * U, 56));
    ringGeo.rotateX(-Math.PI / 2);
    const rimMat = track(new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide,
    }));
    const rim = new THREE.Mesh(ringGeo, rimMat);
    rim.position.y = 0.05;
    rim.renderOrder = -3;
    group.add(rim);

    const ripples = [0, 0.5].map(() => {
        const mat = track(new THREE.MeshBasicMaterial({
            color, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide,
        }));
        const mesh = new THREE.Mesh(ringGeo, mat);
        mesh.position.y = 0.06;
        mesh.renderOrder = -3;
        group.add(mesh);
        return { mesh, mat };
    });

    // ── Rings rising up the beam ─────────────────────────────────────────
    const riseGeo = track(new THREE.RingGeometry(0.4 * U, 0.46 * U, 40));
    riseGeo.rotateX(-Math.PI / 2);
    const RISE_COUNT = 3;
    const RISE_TOP = 3.3 * U;
    const risers = Array.from({ length: RISE_COUNT }, () => {
        const mat = track(new THREE.MeshBasicMaterial({
            color, transparent: true, opacity: 0, depthWrite: false,
            side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
        }));
        const mesh = new THREE.Mesh(riseGeo, mat);
        mesh.renderOrder = -2;
        group.add(mesh);
        return { mesh, mat };
    });

    // ── Floating "arrive here" arrow ─────────────────────────────────────
    // Chunky downward arrow, extruded for depth. Built in the XY plane with
    // the tip down, centred on its own middle so yaw-billboarding is clean.
    const arrowShape = new THREE.Shape();
    arrowShape.moveTo(0, -0.62);        // tip
    arrowShape.lineTo(0.5, -0.02);
    arrowShape.lineTo(0.2, -0.02);
    arrowShape.lineTo(0.2, 0.62);
    arrowShape.lineTo(-0.2, 0.62);
    arrowShape.lineTo(-0.2, -0.02);
    arrowShape.lineTo(-0.5, -0.02);
    arrowShape.closePath();
    const ARROW_DEPTH = 0.26;
    const arrowGeo = track(new THREE.ExtrudeGeometry(arrowShape, {
        depth: ARROW_DEPTH, bevelEnabled: true, bevelSize: 0.04, bevelThickness: 0.04, bevelSegments: 2,
    }));
    arrowGeo.translate(0, 0, -ARROW_DEPTH / 2);
    arrowGeo.computeVertexNormals();
    {
        // Unlit, with a soft key light baked into vertex colours so the
        // warm AR scene lights cannot wash the green out.
        const normals = arrowGeo.attributes.normal;
        const colors = new Float32Array(normals.count * 3);
        const light = new THREE.Vector3(-0.4, 0.62, 0.72).normalize();
        const n = new THREE.Vector3();
        for (let i = 0; i < normals.count; i += 1) {
            n.set(normals.getX(i), normals.getY(i), normals.getZ(i));
            const shade = Math.min(1, 0.72 + 0.28 * Math.max(0, n.dot(light)));
            colors[i * 3] = shade;
            colors[i * 3 + 1] = shade;
            colors[i * 3 + 2] = shade;
        }
        arrowGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    }
    const arrowMat = track(new THREE.MeshBasicMaterial({
        color, vertexColors: true, transparent: true, opacity: 0.97, depthWrite: false,
    }));
    const outlineMat = track(new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 1, side: THREE.BackSide, depthWrite: false,
    }));
    const arrowRig = new THREE.Group();   // yaw (face walker) + bob
    const arrowBody = new THREE.Mesh(arrowGeo, arrowMat);
    const arrowOutline = new THREE.Mesh(arrowGeo, outlineMat);
    arrowOutline.scale.setScalar(1.14);   // geometry is centred, so this is even
    arrowOutline.renderOrder = -1;
    arrowBody.renderOrder = 0;
    arrowRig.add(arrowOutline);
    arrowRig.add(arrowBody);
    arrowRig.scale.setScalar(1.15 * U);
    const ARROW_Y = 3.15 * U;
    arrowRig.position.y = ARROW_Y;
    group.add(arrowRig);

    return {
        group,
        tick(time, camera) {
            if (!group.visible) return;
            beamOuter.uniforms.uTime.value = time;
            beamCore.uniforms.uTime.value = time;

            // Gentle beacon "breathing".
            const breathe = 0.5 + 0.5 * Math.sin(time * 2.0);
            beamOuter.uniforms.uOpacity.value = 0.28 + 0.12 * breathe;
            discMat.opacity = 0.18 + 0.1 * breathe;

            // Sonar ripples: born at the rim, ease outward while fading.
            ripples.forEach((rp, i) => {
                const k = (time * 0.6 + i * 0.5) % 1;
                const e = 1 - Math.pow(1 - k, 3);
                rp.mesh.scale.setScalar(1 + e * 1.1);
                rp.mat.opacity = 0.7 * (1 - k);
            });

            // Rings climbing the beam, fading in at the base and out at the top.
            risers.forEach((rs, i) => {
                const k = (time * 0.35 + i / RISE_COUNT) % 1;
                rs.mesh.position.y = 0.08 + k * RISE_TOP;
                rs.mat.opacity = 0.75 * Math.sin(Math.PI * k);
            });

            // Arrow: a slow "drop toward the spot" bob, turned to the walker.
            arrowRig.position.y = ARROW_Y + Math.sin(time * 2.6) * 0.14 * U;
            if (camera) {
                arrowRig.rotation.y = Math.atan2(
                    camera.position.x - group.position.x,
                    camera.position.z - group.position.z,
                );
            }
        },
        dispose() {
            group.parent?.remove(group);
            for (const d of disposables) d.dispose();
        },
    };
}

/**
 * Pulsing halo drawn on the ground at the route head — the reference's user
 * ring, minus the arrow puck (the camera *is* the user in AR, so an arrow at
 * your own feet would only ever be seen when you look down).
 */
export function createPulseRing({
    color = HOLO.glow,
    inner = 0.75,
    outer = 0.95,
} = {}) {
    const group = new THREE.Group();
    group.visible = false;

    const geo = new THREE.RingGeometry(inner, outer, 40);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false,
    });
    const ring = new THREE.Mesh(geo, mat);
    ring.renderOrder = -3;
    group.add(ring);

    return {
        group,
        /** @param {number} x @param {number} z ground position of the head */
        place(x, y, z) {
            group.position.set(x, y, z);
            group.visible = true;
        },
        hide() { group.visible = false; },
        tick(time) {
            if (!group.visible) return;
            // Same sonar ripple as the destination ring: tight and bright at
            // the feet, blooming outward with an ease-out cubic while fading.
            const k = (time * 0.9) % 1;
            const e = 1 - Math.pow(1 - k, 3);
            ring.scale.setScalar(0.3 + e * 1.6);
            mat.opacity = 0.8 * (1 - k);
        },
        dispose() {
            group.parent?.remove(group);
            geo.dispose();
            mat.dispose();
        },
    };
}

/**
 * One-shot pop bubbles for Dijkstra re-anchors: when a stop joins or leaves
 * the live route, ARView fires a bubble at its marker — a sphere that bursts
 * outward with an ease-out quad while fading to nothing (~0.6 s), then parks
 * invisible until recycled. Fixed pool, no per-frame allocation.
 */
export const HOLO_BUBBLE_COUNT = 10;
export const HOLO_BUBBLE_DURATION = 0.6;

export function createBubblePool({
    count = HOLO_BUBBLE_COUNT,
    duration = HOLO_BUBBLE_DURATION,
    baseRadius = 0.5,
} = {}) {
    const group = new THREE.Group();
    const geo = new THREE.SphereGeometry(baseRadius, 14, 12);
    const bubbles = [];
    for (let i = 0; i < count; i += 1) {
        const mat = new THREE.MeshBasicMaterial({
            color: HOLO.ice, transparent: true, opacity: 0, depthWrite: false,
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.visible = false;
        mesh.renderOrder = -2;
        mesh.frustumCulled = false;
        group.add(mesh);
        bubbles.push({ mesh, mat, age: duration, maxScale: 2.8 });
    }
    let cursor = 0;

    return {
        group,
        /**
         * Fire one bubble. Steals the oldest slot when the pool is busy, so
         * a mass re-route degrades to fewer pops, never to new allocation.
         */
        pop(x, y, z, { color = HOLO.ice, maxScale = 2.8 } = {}) {
            const b = bubbles[cursor];
            cursor = (cursor + 1) % bubbles.length;
            b.mesh.position.set(x, y, z);
            b.mat.color.setHex(color);
            b.age = 0;
            b.maxScale = maxScale;
            b.mesh.visible = true;
        },
        /** Advance every in-flight pop. Call once per rendered frame. */
        tick(time, dt) {
            const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
            if (step <= 0) return;
            for (const b of bubbles) {
                if (b.age >= duration) continue;
                b.age = Math.min(duration, b.age + step);
                const k = b.age / duration;
                const e = 1 - Math.pow(1 - k, 2);
                b.mesh.scale.setScalar(0.4 + e * b.maxScale);
                b.mat.opacity = 0.75 * (1 - k);
                if (k >= 1) b.mesh.visible = false;
            }
        },
        dispose() {
            group.parent?.remove(group);
            geo.dispose();
            for (const b of bubbles) {
                group.remove(b.mesh);
                b.mat.dispose();
            }
            bubbles.length = 0;
        },
    };
}

/**
 * Ambient spatial dust. Follows the camera on X/Z and drifts slowly so it
 * reads as depth rather than dirt on the lens; `sizeAttenuation: false` keeps
 * every mote at a constant few pixels so one drifting near the camera can
 * never bloom into a blob over the video.
 */
export function createSpatialDust({
    count = 70,
    color = HOLO.dust,
    spreadXZ = 46,
    height = 12,
} = {}) {
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(count * 3);
    for (let i = 0; i < count; i += 1) {
        pos[i * 3] = (Math.random() - 0.5) * spreadXZ;
        pos[i * 3 + 1] = -1 + Math.random() * height;
        pos[i * 3 + 2] = (Math.random() - 0.5) * spreadXZ;
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
        color,
        size: 3,
        sizeAttenuation: false,
        transparent: true,
        opacity: 0.4,
        depthWrite: false,
    });
    const points = new THREE.Points(geo, mat);
    points.renderOrder = -5;
    points.frustumCulled = false;

    return {
        group: points,
        /** @param {number} time @param {number} camX @param {number} camZ */
        tick(time, camX, camZ) {
            points.position.set(camX, 0, camZ);
            points.rotation.y = time * 0.035;
        },
        dispose() {
            points.parent?.remove(points);
            geo.dispose();
            mat.dispose();
        },
    };
}
