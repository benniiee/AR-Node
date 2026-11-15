// Single 3D guidance arrow for the AR view.
//
// Replaces the glowing tube, marching chevrons and node spheres: one solid
// arrow floats ahead of the walker, points at the NEXT node on the route and
// slides back and forth along that direction (toward the node, then back)
// so it reads as "go this way".
//
// The pool variant puts one plain white arrow on every route node. Every arrow has the same FIXED world size (no scaling with distance)
// and fades out as the walker closes in on its node, fading back in once
// the walker has moved far enough away again.
import * as THREE from 'three';

/** Metres ahead of the camera where the sweep starts. */
export const NAV_ARROW_NEAR = 3.4;
/** Length of the back-and-forth sweep in metres. */
export const NAV_ARROW_SWEEP = 1.4;
/** Seconds for one full back-and-forth cycle. */
export const NAV_ARROW_PERIOD = 1.4;
/** Arrow hovers this far above the ground reference (eye level is 1.3 m above it). */
export const NAV_ARROW_LIFT = 0.8;
/** The arrow floating ahead of the walker rides lower, out of the eye line. */
export const NAV_LEAD_LIFT = 0.4;

// White "this is the way" arrows. The destination carries the green accent,
// so the arrows read as neutral guidance: pure white, nothing dark around
// them. (The old black outline hull dominated the thin end-on view and made
// the whole arrow read as black.)
const ARROW_COLOR = 0xffffff;
const ARROW_BODY_OPACITY = 1;

/** Fixed world scale of every node arrow (a bit larger than the 0.38 trial). */
export const NODE_ARROW_SCALE = 0.48;

/** At/below this distance from the node the arrow has faded out completely. */
export const NODE_ARROW_FADE_NEAR = 3.5;
/** At/above this distance the arrow is fully visible. */
export const NODE_ARROW_FADE_FAR = 6.5;
/** Seconds for one fade direction; short enough to track walking pace. */
export const NODE_ARROW_FADE_SECONDS = 0.22;

/** Proximity fade: hidden up close, fully in from NODE_ARROW_FADE_FAR out. */
export function nodeArrowFade(distM) {
    if (!Number.isFinite(distM)) return 1;
    const t = Math.min(1, Math.max(0, (distM - NODE_ARROW_FADE_NEAR) / (NODE_ARROW_FADE_FAR - NODE_ARROW_FADE_NEAR)));
    return t * t * (3 - 2 * t);
}

/** Smooth 0 -> 1 -> 0 ping-pong, eased at both ends. */
export function pingPong(time, period = NAV_ARROW_PERIOD) {
    const k = ((time / period) % 1 + 1) % 1;
    const tri = k < 0.5 ? k * 2 : 2 - k * 2;
    return tri * tri * (3 - 2 * tri);
}

/**
 * Where the arrow sits and where it points.
 * Pure maths so it can be tested without WebGL.
 * @param {{x:number,z:number}} head camera ground position
 * @param {{x:number,z:number}} target next node
 * @param {number} time seconds
 * @returns {{x:number,z:number,yaw:number,dist:number}|null} null when no target/too close
 */
export function arrowPlacement(head, target, time) {
    const dx = target.x - head.x;
    const dz = target.z - head.z;
    const dist = Math.hypot(dx, dz);
    if (!(dist > 0.01)) return null;
    const ux = dx / dist;
    const uz = dz / dist;
    // Never overshoot the node itself.
    const near = Math.min(NAV_ARROW_NEAR, dist * 0.5);
    const sweep = Math.min(NAV_ARROW_SWEEP, Math.max(0, dist - near) * 0.6);
    const d = near + sweep * pingPong(time);
    return { x: head.x + ux * d, z: head.z + uz * d, yaw: Math.atan2(ux, uz), dist };
}

/** Shared arrow geometry; each arrow owns its material pair (for fading). */
function buildArrowAssets() {

    // Arrow built in the XZ plane pointing +Z: shaft box + cone head,
    // extruded a little so it has real thickness from every angle.
    const shape = new THREE.Shape();
    shape.moveTo(0, 1.6);       // tip
    shape.lineTo(0.95, 0.35);
    shape.lineTo(0.38, 0.35);
    shape.lineTo(0.38, -1.1);
    shape.lineTo(-0.38, -1.1);
    shape.lineTo(-0.38, 0.35);
    shape.lineTo(-0.95, 0.35);
    shape.closePath();
    const depth = 0.42;
    const geo = new THREE.ExtrudeGeometry(shape, {
        depth, bevelEnabled: true, bevelSize: 0.06, bevelThickness: 0.06, bevelSegments: 2,
    });
    // Shape lives in XY with the tip on +Y. rotateX(+90deg) lays it flat with
    // the tip on +Z (the axis rotation.y = atan2(dx, dz) aims at the target)
    // and the extrusion on -Y. (-90deg put the tip on -Z: arrow faced the user.)
    geo.rotateX(Math.PI / 2);
    // Then stand it on its side: a further 90deg about the travel axis (Z)
    // puts the arrow's face in a vertical plane, so its outline reads from
    // the side instead of lying flat on the floor. Thickness is now along X.
    geo.rotateZ(Math.PI / 2);
    geo.translate(-depth / 2, 0, 0);

    // The AR scene's lights are warm (they were tuned for an older red arrow),
    // which would tint a lit white material pink. Bake a soft key light into
    // vertex colours instead and draw the body unlit, so it stays white.
    geo.computeVertexNormals();
    {
        const normals = geo.attributes.normal;
        const colors = new Float32Array(normals.count * 3);
        const light = new THREE.Vector3(-0.4, 0.62, 0.72).normalize();
        const normal = new THREE.Vector3();
        for (let i = 0; i < normals.count; i += 1) {
            normal.set(normals.getX(i), normals.getY(i), normals.getZ(i));
            // 0.88 on faces turned away, pure white on the lit face.
            const shade = Math.min(1, 0.88 + 0.12 * Math.max(0, normal.dot(light)));
            colors[i * 3] = shade;
            colors[i * 3 + 1] = shade;
            colors[i * 3 + 2] = shade;
        }
        geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    }

    const make = () => {
        // One material per arrow: the proximity fade animates opacity per
        // node, so it cannot be shared across the pool. Unlit, unfogged and
        // not tone-mapped so it stays true white at any distance.
        const mat = new THREE.MeshBasicMaterial({
            color: ARROW_COLOR, vertexColors: true,
            transparent: true, opacity: ARROW_BODY_OPACITY, depthWrite: false,
            side: THREE.DoubleSide, fog: false, toneMapped: false,
        });
        const g = new THREE.Group();
        g.visible = false;
        const body = new THREE.Mesh(geo, mat);
        body.renderOrder = -4;
        g.add(body);
        return { group: g, mat };
    };
    const dispose = () => { geo.dispose(); };
    return { make, dispose };
}

/**
 * Placement of an arrow that sits ON a node and bounces toward the node it
 * connects to. Pure maths (no WebGL).
 * @param {{x:number,z:number}} node  where the arrow lives
 * @param {{x:number,z:number}} next  the node it connects to
 * @param {number} time seconds (add a per-arrow offset to stagger)
 */
export function nodeArrowPlacement(node, next, time) {
    const dx = next.x - node.x;
    const dz = next.z - node.z;
    const dist = Math.hypot(dx, dz);
    if (!(dist > 0.01)) return null;
    const ux = dx / dist;
    const uz = dz / dist;
    const sweep = Math.min(NAV_ARROW_SWEEP, dist * 0.4);
    const d = sweep * pingPong(time);
    return { x: node.x + ux * d, z: node.z + uz * d, yaw: Math.atan2(ux, uz), dist };
}

/**
 * One arrow per route node. Each arrow points at the next node along the
 * route (the last one points at the destination) and slides toward it and
 * back, slightly staggered so the motion ripples along the path.
 */
export function createNavArrowPool(count = 32) {
    const assets = buildArrowAssets();
    const group = new THREE.Group();
    const arrows = [];
    // 0 = invisible, 1 = full. Eased toward the proximity target every frame,
    // so walking up to a node fades its arrow out instead of snapping it.
    const fade = new Float32Array(count);
    let lastTime = null;
    for (let i = 0; i < count; i += 1) {
        const a = assets.make();
        group.add(a.group);
        arrows.push(a);
    }
    return {
        group,
        /**
         * @param {Array<{pos:{x,y,z}, next:{x,y,z}, dist:number}>} items route order
         *        (`dist` = horizontal metres from the camera to the node, drives the fade)
         * @param {number} time seconds
         * @param {THREE.Camera} [camera] used for the proximity fade
         * @param {(x:number, z:number, y?:number) => boolean} [isHidden] true when a wall
         *        blocks the view of that ground point; the arrow fades out
         */
        update(items, time, camera, isHidden) {
            // Frame-rate independent easing toward each arrow's target opacity.
            const dt = lastTime === null ? 0 : Math.min(0.25, Math.max(0, time - lastTime));
            lastTime = time;
            const k = dt > 0 ? 1 - Math.exp(-dt / NODE_ARROW_FADE_SECONDS) : 0;

            for (let i = 0; i < arrows.length; i += 1) {
                const it = items[i];
                const a = arrows[i];
                const p = it ? nodeArrowPlacement(it.pos, it.next, time - i * 0.12) : null;
                // Fade on how close the ARROW itself is (it slides up to
                // NAV_ARROW_SWEEP m away from its node, so the node distance
                // alone lets an arrow loom large right in front of the lens).
                const camDist = !p ? Infinity
                    : camera
                        ? Math.hypot(p.x - camera.position.x, p.z - camera.position.z)
                        : it.dist;
                // Behind a wall from the camera's point of view: fade out
                // with the same easing as the proximity fade.
                const walled = !!p && !!isHidden && isHidden(p.x, p.z, p.y);
                const target = p && !walled ? nodeArrowFade(camDist) : 0;
                fade[i] += (target - fade[i]) * k;
                if (Math.abs(target - fade[i]) < 0.004) fade[i] = target;

                const alpha = fade[i];
                if (!p || alpha < 0.01) {
                    a.group.visible = false;
                    continue;
                }
                const y = it.pos.y + NAV_ARROW_LIFT + Math.sin(time * 2.2 + i) * 0.04;
                a.group.visible = true;
                a.group.position.set(p.x, y, p.z);
                // Fixed orientation (standing on its side, tip toward the next
                // node) and fixed size: nothing depends on the camera.
                a.group.rotation.set(0, p.yaw, 0);
                a.group.scale.setScalar(NODE_ARROW_SCALE);
                a.mat.opacity = ARROW_BODY_OPACITY * alpha;
                            }
        },
        dispose() {
            group.parent?.remove(group);
            for (const a of arrows) {
                a.mat.dispose();
            }
            assets.dispose();
        },
    };
}

export function createNavArrow() {
    const assets = buildArrowAssets();
    const { group, mat } = assets.make();

    return {
        group,
        /** Hide until a target exists. */
        hide() { group.visible = false; },
        /**
         * @param {{x:number,y:number,z:number}} head camera position (y = ground ref)
         * @param {{x:number,y:number,z:number}|null} target next node
         * @param {number} time seconds
         * @param {number} scale apparent-size scale
         */
        update(head, target, time, scale = 1) {
            if (!target) { group.visible = false; return; }
            const p = arrowPlacement(head, target, time);
            if (!p) { group.visible = false; return; }
            group.visible = true;
            group.position.set(p.x, head.y + NAV_LEAD_LIFT + Math.sin(time * 2.2) * 0.03, p.z);
            group.rotation.set(0, p.yaw, 0);
            group.scale.setScalar(scale);
        },
        dispose() {
            group.parent?.remove(group);
            mat.dispose();
            assets.dispose();
        },
    };
}
