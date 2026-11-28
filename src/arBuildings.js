// Labelled campus buildings in the 3D / AR view.
//
// The buildings themselves are not drawn: no outline, no volume. Each one is an
// invisible occluder instead (walls and a roof that write depth but no colour),
// so a staircase, node or arrow on the far side of a building's wall is hidden
// the same way the admin walls hide it, while everything inside stays visible
// once you are inside or looking in through a door (doors are holes in the
// occluder). What is drawn: the door markers and the name above the roof.
// Same world frame as the route (x = east, z = -north, metres from the scene
// anchor; eye level y = 0).
//
// Geometry is rebuilt only when the building list or the scene anchor changes,
// never per frame. `segments` mirrors the walls (door gaps included) for the
// sight-line test that sprites and markers use (wallOcclusion.js).
import * as THREE from 'three';
import { anchorENU, createLabelSprite } from './arMath.js';
import { buildingHeightM } from './sunShadow.js';
import { doorFrames, DOOR_HEIGHT_M } from './doors.js';

/** Ground level in the scene: about eye height below the camera. */
export const AR_GROUND_Y = -1.6;
/** Labels only for buildings this close (metres): further ones are clutter. */
const LABEL_RANGE_M = 150;
/** Doors: the one solid-ish thing on a hologram, so entrances stand out. */
const DOOR_COLOR = 0x22c55e;

/** Writes depth, never colour: hides what is behind it and is itself invisible. */
const occluderMaterial = () => new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: true, side: THREE.DoubleSide });

/** Footprint ring in world XZ, in the polygon's own order (door edges index into it). */
function ringXZ(polygon, anchor) {
    return polygon
        .filter((p) => p && Number.isFinite(+p.lat) && Number.isFinite(+p.lng))
        .map((p) => anchorENU(anchor, { latitude: +p.lat, longitude: +p.lng }));
}

/** Push one vertical quad (two triangles) from y0 to y1 between a and b. */
function pushQuad(out, a, b, y0, y1) {
    out.push(a.x, y0, a.z, b.x, y0, b.z, b.x, y1, b.z, a.x, y0, a.z, b.x, y1, b.z, a.x, y1, a.z);
}

/**
 * Door openings per edge, as [t0, t1] along the edge (0 = edge start), from the
 * door frames' world end points.
 */
function doorSpans(ring, frames, anchor) {
    const spans = new Map();
    for (const d of frames) {
        const a = ring[d.edge];
        const b = ring[(d.edge + 1) % ring.length];
        if (!a || !b) continue;
        const ex = b.x - a.x;
        const ez = b.z - a.z;
        const len2 = ex * ex + ez * ez;
        if (!(len2 > 1e-6)) continue;
        const along = (ll) => {
            const q = anchorENU(anchor, { latitude: ll.lat, longitude: ll.lng });
            return Math.max(0, Math.min(1, ((q.x - a.x) * ex + (q.z - a.z) * ez) / len2));
        };
        const t0 = along(d.a);
        const t1 = along(d.b);
        if (!spans.has(d.edge)) spans.set(d.edge, []);
        spans.get(d.edge).push([Math.min(t0, t1), Math.max(t0, t1)]);
    }
    for (const list of spans.values()) list.sort((x, y) => x[0] - y[0]);
    return spans;
}

export function createBuildingLayer() {
    const group = new THREE.Group();
    group.name = 'campus-buildings';
    let key = '';
    let labels = [];
    /** Walls for the sight-line test: {ax, az, bx, bz, top} with door gaps. */
    const segments = [];

    const clear = () => {
        group.traverse((o) => {
            if (o.geometry) o.geometry.dispose();
            if (o.material) {
                if (o.material.map) o.material.map.dispose();
                o.material.dispose();
            }
        });
        group.clear();
        labels = [];
        segments.length = 0;
    };

    /**
     * (Re)build for these buildings around this anchor. Cheap to call every
     * frame: it only does work when the inputs changed.
     */
    function sync(buildings, anchor) {
        if (!anchor) return;
        const next = `${anchor.latitude.toFixed(6)},${anchor.longitude.toFixed(6)}|${(buildings || []).map((b) => `${b.id}:${b.status}:${b.floors}:${b.height_m ?? ''}:${(b.polygon || []).length}:${b.polygon?.[0]?.lat}:${JSON.stringify(b.doors || [])}`).join(';')}`;
        if (next === key) return;
        key = next;
        clear();

        for (const b of buildings || []) {
            // Planned buildings do not exist yet: nothing to see in the street.
            if (b.status === 'planned' || !Array.isArray(b.polygon) || b.polygon.length < 3) continue;
            const ring = ringXZ(b.polygon, anchor);
            if (ring.length < 3 || !ring.every((q) => Number.isFinite(q.x) && Number.isFinite(q.z))) continue;
            const height = buildingHeightM(b);
            const top = AR_GROUND_Y + height;
            const doorH = Math.min(DOOR_HEIGHT_M, height * 0.85);
            const frames = doorFrames(b.polygon, b.doors);
            const spans = doorSpans(ring, frames, anchor);

            // Occluder walls: full height, except a door-sized hole at each door
            // (a lintel above it). They start a little below ground so nothing
            // peeks under them.
            const wallTris = [];
            const footY = AR_GROUND_Y - 0.3;
            for (let i = 0; i < ring.length; i += 1) {
                const a = ring[i];
                const c = ring[(i + 1) % ring.length];
                const at = (t) => ({ x: a.x + (c.x - a.x) * t, z: a.z + (c.z - a.z) * t });
                let from = 0;
                for (const [t0, t1] of spans.get(i) || []) {
                    if (t0 > from + 1e-4) {
                        const p0 = at(from);
                        const p1 = at(t0);
                        pushQuad(wallTris, p0, p1, footY, top);
                        segments.push({ ax: p0.x, az: p0.z, bx: p1.x, bz: p1.z, top });
                    }
                    if (t1 > t0 + 1e-4 && doorH < height) pushQuad(wallTris, at(t0), at(t1), AR_GROUND_Y + doorH, top);
                    from = Math.max(from, t1);
                }
                if (from < 1 - 1e-4) {
                    const p0 = at(from);
                    pushQuad(wallTris, p0, c, footY, top);
                    segments.push({ ax: p0.x, az: p0.z, bx: c.x, bz: c.z, top });
                }
            }
            const wallGeo = new THREE.BufferGeometry();
            wallGeo.setAttribute('position', new THREE.Float32BufferAttribute(wallTris, 3));
            const walls = new THREE.Mesh(wallGeo, occluderMaterial());
            walls.renderOrder = -10;
            group.add(walls);

            // Roof: hides the inside from a raised free-roam view. Shape (x, -z),
            // then rotateX(-90deg) maps it back to world (x, ., z).
            const roofGeo = new THREE.ShapeGeometry(new THREE.Shape(ring.map((q) => new THREE.Vector2(q.x, -q.z))));
            roofGeo.rotateX(-Math.PI / 2);
            roofGeo.translate(0, top, 0);
            const roof = new THREE.Mesh(roofGeo, occluderMaterial());
            roof.renderOrder = -10;
            group.add(roof);

            // Entrance checkpoints: a ground pad + floating beacon marker right in front of each door
            // so the real doorway stays unobstructed in camera mode.
            for (const d of frames) {
                const a = anchorENU(anchor, { latitude: d.a.lat, longitude: d.a.lng });
                const c = anchorENU(anchor, { latitude: d.b.lat, longitude: d.b.lng });
                const rad = (d.normalDeg * Math.PI) / 180;
                const nx = Math.sin(rad);
                const nz = -Math.cos(rad);
                const px = (a.x + c.x) * 0.5 + nx * 0.85;
                const pz = (a.z + c.z) * 0.5 + nz * 0.85;

                const ringGeo = new THREE.RingGeometry(0.32, 0.44, 24);
                ringGeo.rotateX(-Math.PI / 2);
                const ringMesh = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
                    color: DOOR_COLOR, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false,
                }));
                ringMesh.position.set(px, AR_GROUND_Y + 0.04, pz);
                ringMesh.renderOrder = 3;
                group.add(ringMesh);

                const padGeo = new THREE.CircleGeometry(0.24, 24);
                padGeo.rotateX(-Math.PI / 2);
                const padMesh = new THREE.Mesh(padGeo, new THREE.MeshBasicMaterial({
                    color: DOOR_COLOR, transparent: true, opacity: 0.32, side: THREE.DoubleSide, depthWrite: false,
                }));
                padMesh.position.set(px, AR_GROUND_Y + 0.04, pz);
                padMesh.renderOrder = 3;
                group.add(padMesh);

                const stem = new THREE.Mesh(
                    new THREE.CylinderGeometry(0.018, 0.018, 0.52, 8),
                    new THREE.MeshBasicMaterial({ color: DOOR_COLOR, transparent: true, opacity: 0.75, depthWrite: false }),
                );
                stem.position.set(px, AR_GROUND_Y + 0.3, pz);
                stem.renderOrder = 4;
                group.add(stem);

                const diamond = new THREE.Mesh(
                    new THREE.OctahedronGeometry(0.16, 0),
                    new THREE.MeshBasicMaterial({ color: DOOR_COLOR, transparent: true, opacity: 0.92 }),
                );
                diamond.position.set(px, AR_GROUND_Y + 0.68, pz);
                diamond.renderOrder = 4;
                group.add(diamond);
            }

            // Name above the roof centre.
            let cx = 0;
            let cz = 0;
            for (const q of ring) { cx += q.x; cz += q.z; }
            cx /= ring.length;
            cz /= ring.length;
            const building = b.status === 'under_construction';
            const label = createLabelSprite(b.short_name || b.name, building ? 'rgba(120, 72, 6, 0.9)' : 'rgba(16, 16, 20, 0.82)');
            label.position.set(cx, AR_GROUND_Y + height + 1.4, cz);
            label.renderOrder = 998;
            label.userData.baseScale = label.scale.clone();
            group.add(label);
            labels.push(label);
        }
    }

    const tmp = new THREE.Vector3();
    /** Per frame: labels only nearby, scaled to stay legible, faded at range. */
    function tick(camera) {
        for (const label of labels) {
            tmp.copy(label.position).sub(camera.position);
            tmp.y = 0;
            const d = tmp.length();
            const show = d < LABEL_RANGE_M;
            label.visible = show;
            if (!show) continue;
            // Constant-ish screen size: grow gently with distance.
            const s = Math.min(3.2, Math.max(1, d / 22));
            label.scale.set(label.userData.baseScale.x * s, label.userData.baseScale.y * s, 1);
            label.material.opacity = d > LABEL_RANGE_M * 0.7 ? Math.max(0, (LABEL_RANGE_M - d) / (LABEL_RANGE_M * 0.3)) : 1;
        }
    }

    return { group, sync, tick, segments, dispose: clear };
}
