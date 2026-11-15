// Camera-space "turn this way" arrow for the 3D AR views.
//
// The nearest route stop is sometimes outside the camera's frustum — behind
// the walker, or off to one side. A DOM notice there would cover the scene and
// need a label; this module builds a small arrow in camera space instead. It
// sits just above the centre of the view and rotates to point at that stop, so the
// walker can turn toward it without reading anything.
//
// Look: a genuine 3D extruded arrow (bevelled edges, baked directional
// shading) in white, floating over two soft drop shadows. It pops in with an
// overshoot and fades out, so the cue never blinks in or out of the frame.
//
// The caller owns the out-of-view test; this module only aims, animates and
// shows the arrow. `setVisible` is expected to be called every frame — it
// advances the transition, including the fade-out after it goes false.
import * as THREE from 'three';

/** Distance in front of the camera, in metres of camera space. */
const POINTER_DEPTH = 1;
/** Height above the view centre, in metres of camera space at POINTER_DEPTH. */
const POINTER_LIFT = 0.12;
/** Base size of the arrow at POINTER_DEPTH (~17% of a 60° view's height). */
const BASE_SCALE = 1.6;
/** Pop-in: scale overshoots 1 and settles (classic ease-out-back). */
const APPEAR_MS = 240;
/** Fade-out is quicker than the entrance so the cue never lags the view. */
const DISAPPEAR_MS = 150;
/** Scale the pop starts from — small enough to read as "growing in". */
const MIN_POP = 0.55;

/** Direction of the baked key light in arrow-local space (upper front-left). */
const LIGHT_DIR = new THREE.Vector3(-0.4, 0.62, 0.72).normalize();

const easeOutBack = (x) => {
    const c1 = 2.4;
    const c3 = c1 + 1;
    return 1 + c3 * (x - 1) ** 3 + c1 * (x - 1) ** 2;
};

const easeOutCubic = (x) => 1 - (1 - x) ** 3;

/**
 * 2D arrow outline extruded into a bevelled 3D solid, with a greyscale
 * vertex-colour bake so it reads as lit white plastic without adding lights
 * to the AR scene (which would cost a shader recompile and light the real
 * markers too).
 */
function buildArrowGeometry() {
    const shape = new THREE.Shape();
    shape.moveTo(0, 0.058);
    shape.lineTo(-0.045, 0.012);
    shape.lineTo(-0.018, 0.012);
    shape.lineTo(-0.018, -0.055);
    shape.lineTo(0.018, -0.055);
    shape.lineTo(0.018, 0.012);
    shape.lineTo(0.045, 0.012);
    shape.closePath();

    const depth = 0.022;
    const geometry = new THREE.ExtrudeGeometry(shape, {
        depth,
        bevelEnabled: true,
        bevelThickness: 0.008,
        bevelSize: 0.007,
        bevelSegments: 2,
        steps: 1,
        curveSegments: 6,
    });
    geometry.translate(0, 0, -depth / 2);
    geometry.computeVertexNormals();

    const normals = geometry.attributes.normal;
    const colors = new Float32Array(normals.count * 3);
    const normal = new THREE.Vector3();
    for (let i = 0; i < normals.count; i += 1) {
        normal.set(normals.getX(i), normals.getY(i), normals.getZ(i));
        const lit = Math.max(0, normal.dot(LIGHT_DIR));
        // 0.75 on faces pointing away, pure white on the lit front.
        const shade = Math.min(1, 0.75 + 0.36 * lit);
        colors[i * 3] = shade;
        colors[i * 3 + 1] = shade;
        colors[i * 3 + 2] = shade;
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return geometry;
}

/**
 * Build the pointer. Add `group` to the camera (and add the camera to the
 * scene so it is traversed), then call `setAngle`/`setVisible` each frame.
 *
 * @returns {{
 *   group: THREE.Group,
 *   setAngle: (angleDeg: number) => void,
 *   setVisible: (visible: boolean) => void,
 *   dispose: () => void,
 * }}
 */
export function createOffscreenArrow() {
    const group = new THREE.Group();
    group.position.set(0, POINTER_LIFT, -POINTER_DEPTH);
    group.scale.setScalar(BASE_SCALE);
    group.visible = false;

    const pointer = new THREE.Group();
    group.add(pointer);

    const geometry = buildArrowGeometry();

    const bodyMaterial = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        vertexColors: true,
        transparent: true,
        opacity: 1,
        depthTest: false,
        depthWrite: false,
    });
    const body = new THREE.Mesh(geometry, bodyMaterial);
    body.renderOrder = 999;

    // Drop shadows: the same silhouette in translucent black, offset down and
    // behind in two steps so the edge falls off instead of being one hard
    // band. Drawn under the body (renderOrder), never depth-tested.
    const shadowMaterials = [];
    const shadows = [
        { dx: 0.010, dy: -0.014, dz: -0.020, opacity: 0.30, scale: 1.0, order: 998 },
        { dx: 0.017, dy: -0.025, dz: -0.032, opacity: 0.14, scale: 1.03, order: 997 },
    ];
    for (const spec of shadows) {
        const material = new THREE.MeshBasicMaterial({
            color: 0x000000,
            transparent: true,
            opacity: spec.opacity,
            depthTest: false,
            depthWrite: false,
        });
        material.userData.baseOpacity = spec.opacity;
        shadowMaterials.push(material);

        const mesh = new THREE.Mesh(geometry, material);
        mesh.position.set(spec.dx, spec.dy, spec.dz);
        mesh.scale.setScalar(spec.scale);
        mesh.renderOrder = spec.order;
        pointer.add(mesh);
    }
    pointer.add(body);

    let targetVisible = false;
    let animStart = 0;

    function paint(scaleFactor, alpha) {
        group.scale.setScalar(BASE_SCALE * scaleFactor);
        bodyMaterial.opacity = alpha;
        for (const material of shadowMaterials) {
            material.opacity = material.userData.baseOpacity * alpha;
        }
    }

    return {
        group,
        /**
         * Aim the centred arrow. `angleDeg` follows screen convention:
         * 0° = straight up, 90° = right, 180° = down. The arrow is already at
         * the view centre, so only its rotation changes — no FOV maths.
         */
        setAngle(angleDeg) {
            const rad = (angleDeg * Math.PI) / 180;
            pointer.rotation.z = -rad;
        },
        setVisible(visible) {
            const now = performance.now();
            if (visible) {
                // Start the pop only on the false→true edge, so calling this
                // every frame does not restart the animation.
                if (!targetVisible) {
                    targetVisible = true;
                    animStart = now;
                    group.visible = true;
                }
                const x = Math.min(1, (now - animStart) / APPEAR_MS);
                paint(MIN_POP + (1 - MIN_POP) * easeOutBack(x), easeOutCubic(x));
                return;
            }

            if (targetVisible) {
                targetVisible = false;
                animStart = now;
            }
            if (!group.visible) return;
            const x = Math.min(1, (now - animStart) / DISAPPEAR_MS);
            paint(1 - 0.22 * x, 1 - x);
            if (x >= 1) group.visible = false;
        },
        dispose() {
            geometry.dispose();
            bodyMaterial.dispose();
            for (const material of shadowMaterials) material.dispose();
        },
    };
}
