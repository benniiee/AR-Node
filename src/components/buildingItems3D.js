import * as THREE from 'three';
import { ITEM_BY_TYPE, roofLayers } from '../buildingAppearance';

/**
 * Signed area in (east, north) coordinates so we know which side of each wall
 * faces outward, regardless of whether the polygon was drawn clockwise or counter-clockwise.
 */
export function isRingCCW(ring) {
    let area = 0;
    for (let i = 0; i < ring.length; i += 1) {
        const a = ring[i];
        const b = ring[(i + 1) % ring.length];
        area += a.x * (-b.z) - b.x * (-a.z);
    }
    return area > 0;
}

/**
 * Geometric frame for wall `edgeIndex` of `ring`: endpoints, length, tangent, outward normal, and Y rotation.
 */
export function wallFrameForEdge(ring, edgeIndex, ccw = isRingCCW(ring)) {
    if (!ring.length) return null;
    const i = ((edgeIndex % ring.length) + ring.length) % ring.length;
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    if (len < 1e-5) return null;
    const tx = dx / len;
    const tz = dz / len;
    const nx = ccw ? -tz : tz;
    const nz = ccw ? tx : -tx;
    return {
        edge: i,
        a,
        b,
        len,
        tx,
        tz,
        nx,
        nz,
        rotY: Math.atan2(nx, nz),
    };
}

/**
 * Base Y height (metres from ground) for an item based on its type and floor.
 */
export function itemBaseY(item, storeyH, wallHeight, roofRise = 0) {
    const spec = ITEM_BY_TYPE[item.type];
    if (!spec) return 0;
    if (spec.placement === 'roof') {
        return wallHeight + roofRise;
    }
    const floorBase = (item.floor || 0) * storeyH;
    const offset = Number(item.y_offset) || 0;
    let base = floorBase;
    switch (item.type) {
        case 'window_standard':
        case 'window_tall':
        case 'window_ribbon':
        case 'window_grille':
        case 'window_diamond':
        case 'window_jalousie':
        case 'window_clerestory':
        case 'window_grid':
            base = floorBase + (item.type === 'window_clerestory'
                ? Math.max(1.2, storeyH * 0.58)
                : item.type === 'window_tall'
                    ? Math.max(0.35, storeyH * 0.18)
                    : Math.max(0.55, storeyH * 0.28));
            break;
        case 'window_awning':
            base = floorBase + Math.max(1.2, storeyH * 0.56);
            break;
        case 'window_arch':
            base = floorBase + Math.max(0.15, storeyH * 0.08);
            break;
        case 'spandrel_ribbed':
            base = floorBase + Math.max(0, storeyH - item.height_m * 0.95);
            break;
        case 'balcony_parapet':
            base = floorBase;
            break;
        case 'canopy_slab':
        case 'canopy_curved':
            base = floorBase + Math.min(2.65, storeyH * 0.78);
            break;
        case 'sign_board':
            base = floorBase + Math.min(2.9, storeyH * 0.85);
            break;
        case 'banner':
            base = floorBase + Math.max(1.2, storeyH * 0.52);
            break;
        case 'ac_unit':
            base = floorBase + Math.max(1.6, storeyH * 0.62);
            break;
        case 'bunting':
            base = floorBase + Math.min(3.1, storeyH * 0.88);
            break;
        case 'lamp':
            base = floorBase + Math.min(2.4, storeyH * 0.72);
            break;
        default:
            base = floorBase;
            break;
    }
    return Math.max(0, base + offset);
}

function makeItemSignTexture(text, bg, fg) {
    if (typeof document === 'undefined') return null;
    const clean = (text || '').trim();
    if (!clean) return null;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    canvas.width = 512;
    canvas.height = 128;
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = fg;
    ctx.lineWidth = 4;
    ctx.strokeRect(8, 8, canvas.width - 16, canvas.height - 16);
    ctx.fillStyle = fg;
    ctx.font = 'bold 44px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(clean.slice(0, 28), canvas.width / 2, canvas.height / 2, canvas.width - 36);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
}

/**
 * Builds a Three.js Group for one studio item in local coordinates:
 * x = along wall, y = up from base, z = outward from wall (+z).
 */
export function buildStudioItemGroup(item, { ghost = false, blocked = false, selected = false } = {}) {
    const spec = ITEM_BY_TYPE[item.type];
    const g = new THREE.Group();
    if (!spec) return g;

    const w = item.width_m || spec.defaultWidth;
    const h = item.height_m || spec.defaultHeight;
    const d = item.depth_m || spec.defaultDepth;
    const primary = item.color || spec.defaultColor || '#d6d2c8';
    const secondary = item.accent || spec.defaultAccent || '#1f2937';

    const makeMat = (color, opts = {}) => {
        if (ghost) {
            return new THREE.MeshBasicMaterial({
                color: blocked ? 0xef4444 : 0x4ade80,
                transparent: true,
                opacity: 0.45,
                depthWrite: false,
            });
        }
        return new THREE.MeshStandardMaterial({
            color,
            roughness: opts.roughness ?? 0.65,
            metalness: opts.metalness ?? 0.1,
            side: opts.side ?? THREE.FrontSide,
            transparent: opts.transparent ?? false,
            opacity: opts.opacity ?? 1,
        });
    };

    const addBox = (bw, bh, bd, mat, x = 0, y = 0, z = 0) => {
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, bd), mat);
        mesh.position.set(x, y, z);
        g.add(mesh);
        return mesh;
    };

    const isGlassDoor = ['door_glass', 'door_sliding', 'door_double_wood', 'door_arched', 'door_frameless'].includes(item.type);
    const glassMat = makeMat(primary, {
        roughness: 0.18,
        metalness: 0.35,
        ...(isGlassDoor && !ghost ? { transparent: true, opacity: 0.32, depthWrite: false } : {}),
    });
    const frameMat = makeMat(secondary, { roughness: 0.45, metalness: 0.25 });
    const mainMat = makeMat(primary, { roughness: 0.75 });
    const accentMat = makeMat(secondary, { roughness: 0.5 });
    const steelMat = makeMat('#c9ccd1', { roughness: 0.35, metalness: 0.65 });
    const concreteMat = makeMat('#d6d2c8', { roughness: 0.9 });

    switch (item.type) {
        case 'window_standard': {
            addBox(w, h, 0.06, glassMat, 0, h / 2, 0.04);
            const t = 0.07;
            addBox(w, t, d, frameMat, 0, h - t / 2, d / 2);
            addBox(w, t, d, frameMat, 0, t / 2, d / 2);
            addBox(t, h, d, frameMat, -w / 2 + t / 2, h / 2, d / 2);
            addBox(t, h, d, frameMat, w / 2 - t / 2, h / 2, d / 2);
            addBox(t * 0.7, h, d * 0.85, frameMat, 0, h / 2, d / 2);
            addBox(w, t * 0.7, d * 0.85, frameMat, 0, h * 0.5, d / 2);
            if (item.awning) {
                addBox(w + 0.24, 0.1, 0.48, concreteMat, 0, h + 0.06, 0.24);
            }
            break;
        }
        case 'window_tall': {
            addBox(w, h, 0.06, glassMat, 0, h / 2, 0.04);
            const t = 0.075;
            addBox(w, t, d, frameMat, 0, h - t / 2, d / 2);
            addBox(w, t, d, frameMat, 0, t / 2, d / 2);
            addBox(t, h, d, frameMat, -w / 2 + t / 2, h / 2, d / 2);
            addBox(t, h, d, frameMat, w / 2 - t / 2, h / 2, d / 2);
            addBox(w, t * 0.75, d * 0.9, frameMat, 0, h * 0.62, d / 2);
            addBox(w, t * 0.65, d * 0.85, frameMat, 0, h * 0.3, d / 2);
            if (item.awning) {
                addBox(w + 0.26, 0.11, 0.52, concreteMat, 0, h + 0.06, 0.26);
            }
            break;
        }
        case 'window_ribbon': {
            addBox(w, h, 0.06, glassMat, 0, h / 2, 0.04);
            const t = 0.07;
            addBox(w, t, d, frameMat, 0, h - t / 2, d / 2);
            addBox(w, t, d, frameMat, 0, t / 2, d / 2);
            addBox(t, h, d, frameMat, -w / 2 + t / 2, h / 2, d / 2);
            addBox(t, h, d, frameMat, w / 2 - t / 2, h / 2, d / 2);
            const panes = Math.max(3, Math.round(w / 0.95));
            for (let i = 1; i < panes; i += 1) {
                addBox(0.055, h, d * 0.9, frameMat, -w / 2 + (i / panes) * w, h / 2, d / 2);
            }
            if (item.awning) {
                addBox(w + 0.24, 0.1, 0.48, concreteMat, 0, h + 0.06, 0.24);
            }
            break;
        }
        case 'window_diamond': {
            addBox(w, h, 0.05, glassMat, 0, h / 2, 0.04);
            const t = 0.08;
            addBox(w, t, d, frameMat, 0, h - t / 2, d / 2);
            addBox(w, t, d, frameMat, 0, t / 2, d / 2);
            addBox(t, h, d, frameMat, -w / 2 + t / 2, h / 2, d / 2);
            addBox(t, h, d, frameMat, w / 2 - t / 2, h / 2, d / 2);
            // Criss-cross diamond lattice bars.
            const cols = Math.max(4, Math.round(w / 0.45));
            const diagLen = Math.hypot(w / cols, h - t) * 1.15;
            const angle = Math.atan2(h - t, w / cols);
            for (let i = 0; i < cols; i += 1) {
                const cx = -w / 2 + ((i + 0.5) / cols) * w;
                const d1 = new THREE.Mesh(new THREE.BoxGeometry(diagLen, 0.025, 0.025), steelMat);
                d1.position.set(cx, h / 2, d * 0.8);
                d1.rotation.z = angle;
                g.add(d1);
                const d2 = new THREE.Mesh(new THREE.BoxGeometry(diagLen, 0.025, 0.025), steelMat);
                d2.position.set(cx, h / 2, d * 0.8);
                d2.rotation.z = -angle;
                g.add(d2);
            }
            if (item.awning) {
                addBox(w + 0.24, 0.1, 0.48, concreteMat, 0, h + 0.06, 0.24);
            }
            break;
        }
        case 'window_jalousie': {
            addBox(w, h, 0.05, glassMat, 0, h / 2, 0.04);
            const t = 0.07;
            addBox(w, t, d, frameMat, 0, h - t / 2, d / 2);
            addBox(w, t, d, frameMat, 0, t / 2, d / 2);
            addBox(t, h, d, frameMat, -w / 2 + t / 2, h / 2, d / 2);
            addBox(t, h, d, frameMat, w / 2 - t / 2, h / 2, d / 2);
            const blades = Math.max(4, Math.round(h / 0.16));
            for (let j = 1; j < blades; j += 1) {
                const blade = new THREE.Mesh(new THREE.BoxGeometry(w - t * 1.6, 0.09, 0.025), steelMat);
                blade.position.set(0, (j / blades) * h, d * 0.65);
                blade.rotation.x = 0.45;
                g.add(blade);
            }
            const bars = Math.max(2, Math.round(w / 0.65));
            for (let i = 1; i < bars; i += 1) {
                addBox(0.03, h - t, 0.03, frameMat, -w / 2 + (i / bars) * w, h / 2, d * 0.85);
            }
            if (item.awning) {
                addBox(w + 0.24, 0.1, 0.48, concreteMat, 0, h + 0.06, 0.24);
            }
            break;
        }
        case 'window_clerestory': {
            const t = 0.06;
            addBox(w, t, d, frameMat, 0, h - t / 2, d / 2);
            addBox(w, t, d, frameMat, 0, t / 2, d / 2);
            addBox(t, h, d, frameMat, -w / 2 + t / 2, h / 2, d / 2);
            addBox(t, h, d, frameMat, w / 2 - t / 2, h / 2, d / 2);
            const flaps = Math.max(2, Math.round(w / 0.65));
            const flapW = (w - t * 2) / flaps;
            for (let i = 0; i < flaps; i += 1) {
                const fx = -w / 2 + t + (i + 0.5) * flapW;
                if (i > 0) addBox(0.04, h, d * 0.9, frameMat, -w / 2 + t + i * flapW, h / 2, d / 2);
                const flap = new THREE.Mesh(new THREE.BoxGeometry(flapW * 0.92, h * 0.82, 0.03), glassMat);
                flap.position.set(fx, h * 0.48, d * 0.85);
                flap.rotation.x = -0.35;
                g.add(flap);
            }
            break;
        }
        case 'window_grid': {
            addBox(w, h, 0.05, glassMat, 0, h / 2, 0.04);
            const t = 0.07;
            addBox(w, t, d, frameMat, 0, h - t / 2, d / 2);
            addBox(w, t, d, frameMat, 0, t / 2, d / 2);
            addBox(t, h, d, frameMat, -w / 2 + t / 2, h / 2, d / 2);
            addBox(t, h, d, frameMat, w / 2 - t / 2, h / 2, d / 2);
            for (const fx of [-w / 6, w / 6]) {
                addBox(0.04, h - t, d * 0.85, frameMat, fx, h / 2, d / 2);
            }
            addBox(w - t, 0.04, d * 0.85, frameMat, 0, h * 0.5, d / 2);
            break;
        }
        case 'window_grille': {
            addBox(w, h, 0.05, glassMat, 0, h / 2, 0.04);
            const t = 0.08;
            addBox(w, t, d, frameMat, 0, h - t / 2, d / 2);
            addBox(w, t, d, frameMat, 0, t / 2, d / 2);
            addBox(t, h, d, frameMat, -w / 2 + t / 2, h / 2, d / 2);
            addBox(t, h, d, frameMat, w / 2 - t / 2, h / 2, d / 2);
            const bars = Math.max(3, Math.round(w / 0.38));
            for (let i = 1; i < bars; i += 1) {
                const bx = -w / 2 + (i / bars) * w;
                addBox(0.03, h - t, 0.03, steelMat, bx, h / 2, d * 0.78);
            }
            const hBars = Math.max(2, Math.round(h / 0.42));
            for (let j = 1; j < hBars; j += 1) {
                const by = (j / hBars) * h;
                addBox(w - t, 0.03, 0.03, steelMat, 0, by, d * 0.78);
            }
            if (item.awning) {
                addBox(w + 0.24, 0.1, 0.48, concreteMat, 0, h + 0.06, 0.24);
            }
            break;
        }
        case 'window_awning': {
            addBox(w, h, 0.06, glassMat, 0, h / 2, 0.04);
            const t = 0.06;
            addBox(w, t, d, frameMat, 0, h - t / 2, d / 2);
            addBox(w, t, d, frameMat, 0, t / 2, d / 2);
            addBox(t, h, d, frameMat, -w / 2 + t / 2, h / 2, d / 2);
            addBox(t, h, d, frameMat, w / 2 - t / 2, h / 2, d / 2);
            const panes = Math.max(2, Math.round(w / 0.55));
            for (let i = 1; i < panes; i += 1) {
                addBox(0.04, h, d * 0.9, frameMat, -w / 2 + (i / panes) * w, h / 2, d / 2);
            }
            break;
        }
        case 'window_arch': {
            const pierW = Math.max(0.22, w * 0.12);
            const archR = Math.max(0.4, (w - pierW * 2) / 2);
            const straightH = Math.max(0.4, h - archR);
            addBox(w - pierW * 1.4, h * 0.92, 0.06, glassMat, 0, h * 0.46, 0.04);
            addBox(pierW, straightH, d, accentMat, -w / 2 + pierW / 2, straightH / 2, d / 2);
            addBox(pierW, straightH, d, accentMat, w / 2 - pierW / 2, straightH / 2, d / 2);
            const segs = 6;
            for (let s = 0; s < segs; s += 1) {
                const a0 = (s / segs) * Math.PI;
                const a1 = ((s + 1) / segs) * Math.PI;
                const am = (a0 + a1) / 2;
                const segLen = (archR + pierW * 0.5) * (Math.PI / segs) * 1.1;
                const seg = new THREE.Mesh(new THREE.BoxGeometry(segLen, pierW, d), accentMat);
                seg.position.set(Math.cos(am) * (archR + pierW * 0.4), straightH + Math.sin(am) * archR, d / 2);
                seg.rotation.z = am - Math.PI / 2;
                g.add(seg);
            }
            break;
        }
        case 'pillar_square': {
            addBox(w, h, d, mainMat, 0, h / 2, d / 2);
            addBox(w + 0.1, 0.16, d + 0.08, mainMat, 0, 0.08, d / 2);
            addBox(w + 0.1, 0.16, d + 0.08, mainMat, 0, h - 0.08, d / 2);
            break;
        }
        case 'pillar_round': {
            const r = Math.min(w, d) / 2;
            const cyl = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 16), mainMat);
            cyl.position.set(0, h / 2, r);
            g.add(cyl);
            addBox(w + 0.1, 0.16, d + 0.08, mainMat, 0, 0.08, r);
            addBox(w + 0.1, 0.16, d + 0.08, mainMat, 0, h - 0.08, r);
            break;
        }
        case 'spandrel_ribbed': {
            addBox(w, h, d, mainMat, 0, h / 2, d / 2);
            const ribs = Math.max(3, Math.round(h / 0.18));
            for (let i = 1; i < ribs; i += 1) {
                const ry = (i / ribs) * h;
                addBox(w + 0.02, 0.04, 0.04, accentMat, 0, ry, d + 0.02);
            }
            break;
        }
        case 'louvre_screen': {
            const slats = Math.max(4, Math.round(w / 0.24));
            for (let i = 0; i < slats; i += 1) {
                const sx = -w / 2 + ((i + 0.5) / slats) * w;
                addBox(0.08, h, d, mainMat, sx, h / 2, d / 2);
            }
            addBox(w, 0.08, d, mainMat, 0, h - 0.04, d / 2);
            addBox(w, 0.08, d, mainMat, 0, 0.04, d / 2);
            break;
        }
        case 'balcony_parapet': {
            addBox(w, h * 0.65, d, mainMat, 0, (h * 0.65) / 2, d / 2);
            addBox(w, 0.06, 0.08, accentMat, 0, h - 0.03, d * 0.75);
            const posts = Math.max(2, Math.round(w / 0.9) + 1);
            for (let i = 0; i < posts; i += 1) {
                const px = -w / 2 + (i / Math.max(1, posts - 1)) * w;
                addBox(0.06, h * 0.35, 0.06, accentMat, px, h * 0.82, d * 0.75);
            }
            break;
        }
        case 'door_glass':
        case 'door_wood':
        case 'door_sliding':
        case 'door_double_wood': {
            addBox(w, h, 0.06, glassMat, 0, h / 2, 0.04);
            const t = 0.08;
            addBox(w, t, d, frameMat, 0, h - t / 2, d / 2);
            addBox(t, h, d, frameMat, -w / 2 + t / 2, h / 2, d / 2);
            addBox(t, h, d, frameMat, w / 2 - t / 2, h / 2, d / 2);
            addBox(0.07, h * 0.94, 0.05, steelMat, 0, h * 0.47, d * 0.75);
            if (item.type === 'door_sliding' || item.type === 'door_double_wood') {
                addBox(0.05, 0.7, 0.06, steelMat, 0.22, h * 0.48, d * 0.9);
                addBox(0.05, 0.7, 0.06, steelMat, -0.22, h * 0.48, d * 0.9);
            }
            if (item.type === 'door_double_wood') {
                addBox(w * 0.36, h * 0.32, 0.04, frameMat, -w * 0.24, h * 0.65, d * 0.45);
                addBox(w * 0.36, h * 0.32, 0.04, frameMat, w * 0.24, h * 0.65, d * 0.45);
            }
            break;
        }
        case 'door_arched': {
            const pierW = 0.14;
            const archR = Math.max(0.35, (w - pierW * 2) / 2);
            const straightH = Math.max(1.0, h - archR);
            addBox(w - pierW, h * 0.92, 0.06, glassMat, 0, h * 0.46, 0.04);
            addBox(pierW, straightH, d, frameMat, -w / 2 + pierW / 2, straightH / 2, d / 2);
            addBox(pierW, straightH, d, frameMat, w / 2 - pierW / 2, straightH / 2, d / 2);
            addBox(0.06, h * 0.85, 0.05, steelMat, 0, h * 0.425, d * 0.7);
            const segs = 6;
            for (let s = 0; s < segs; s += 1) {
                const am = ((s + 0.5) / segs) * Math.PI;
                const segLen = (archR + pierW * 0.4) * (Math.PI / segs) * 1.1;
                const seg = new THREE.Mesh(new THREE.BoxGeometry(segLen, pierW, d), frameMat);
                seg.position.set(Math.cos(am) * (archR + pierW * 0.35), straightH + Math.sin(am) * archR, d / 2);
                seg.rotation.z = am - Math.PI / 2;
                g.add(seg);
            }
            break;
        }
        case 'door_steel': {
            addBox(w, h, 0.08, mainMat, 0, h / 2, 0.04);
            const t = 0.08;
            addBox(w, t, d, frameMat, 0, h - t / 2, d / 2);
            addBox(t, h, d, frameMat, -w / 2 + t / 2, h / 2, d / 2);
            addBox(t, h, d, frameMat, w / 2 - t / 2, h / 2, d / 2);
            for (let l = 0; l < 4; l += 1) {
                addBox(w * 0.55, 0.04, 0.03, frameMat, 0, 0.35 + l * 0.09, d * 0.72);
            }
            addBox(0.14, 0.05, 0.06, steelMat, w * 0.32, 1.0, d * 0.8);
            break;
        }
        case 'door_roll_up': {
            addBox(w, h, 0.06, mainMat, 0, h / 2, 0.04);
            addBox(w + 0.16, 0.28, d * 1.3, frameMat, 0, h - 0.14, d * 0.65);
            const slats = Math.max(5, Math.round(h / 0.25));
            for (let s = 1; s < slats; s += 1) {
                addBox(w, 0.035, 0.03, frameMat, 0, (s / slats) * (h - 0.25), d * 0.55);
            }
            break;
        }
        case 'canopy_slab': {
            addBox(w, h, d, mainMat, 0, h / 2, d / 2);
            addBox(w + 0.08, h * 0.45, 0.08, accentMat, 0, h * 0.5, d + 0.03);
            break;
        }
        case 'canopy_curved': {
            const panels = 5;
            for (let s = 0; s < panels; s += 1) {
                const t = (s + 0.5) / panels;
                const panel = new THREE.Mesh(new THREE.BoxGeometry(w, 0.1, d / panels + 0.04), mainMat);
                panel.position.set(0, h * 0.5 * Math.sin(Math.PI * t), t * d);
                panel.rotation.x = -Math.cos(Math.PI * t) * 0.22;
                g.add(panel);
            }
            break;
        }
        case 'steps': {
            const stepCount = 3;
            for (let s = 0; s < stepCount; s += 1) {
                const sh = h / stepCount;
                const sd = d * ((stepCount - s) / stepCount);
                addBox(w, sh, sd, mainMat, 0, sh * (s + 0.5), sd / 2);
            }
            break;
        }
        case 'ramp': {
            addBox(1.4, 0.3, d, mainMat, -w / 2 + 0.7, 0.15, d / 2);
            const rampLen = Math.max(1.2, w - 1.4);
            const slope = new THREE.Mesh(new THREE.BoxGeometry(rampLen, 0.1, d * 0.85), mainMat);
            slope.position.set(0.7, 0.15, d / 2);
            slope.rotation.z = -Math.atan2(0.26, rampLen);
            g.add(slope);
            addBox(w, 0.05, 0.05, steelMat, 0, 0.9, d * 0.9);
            addBox(0.05, 0.9, 0.05, steelMat, -w / 2 + 0.1, 0.45, d * 0.9);
            addBox(0.05, 0.65, 0.05, steelMat, w / 2 - 0.1, 0.32, d * 0.9);
            break;
        }
        case 'sign_board':
        case 'banner': {
            const tex = !ghost ? makeItemSignTexture(item.label || (item.type === 'sign_board' ? 'BUILDING' : 'BANNER'), primary, secondary) : null;
            const faceMat = tex
                ? new THREE.MeshBasicMaterial({ map: tex })
                : mainMat;
            addBox(w, h, d, mainMat, 0, h / 2, d / 2);
            const front = new THREE.Mesh(new THREE.PlaneGeometry(w * 0.96, h * 0.9), faceMat);
            front.position.set(0, h / 2, d + 0.01);
            g.add(front);
            break;
        }
        case 'ac_unit': {
            addBox(w, h, d, mainMat, 0, h / 2, d / 2);
            const fan = new THREE.Mesh(new THREE.CylinderGeometry(Math.min(w, h) * 0.34, Math.min(w, h) * 0.34, 0.04, 14), accentMat);
            fan.rotation.x = Math.PI / 2;
            fan.position.set(-w * 0.16, h / 2, d + 0.01);
            g.add(fan);
            break;
        }
        case 'planter': {
            addBox(w, h * 0.55, d, mainMat, 0, h * 0.275, d / 2);
            const bushes = Math.max(1, Math.round(w / 0.85));
            for (let i = 0; i < bushes; i += 1) {
                const bx = -w / 2 + ((i + 0.5) / bushes) * w;
                const bush = new THREE.Mesh(new THREE.SphereGeometry(Math.min(0.45, d * 0.55), 8, 6), accentMat);
                bush.scale.set(1.15, 0.85, 0.95);
                bush.position.set(bx, h * 0.72, d / 2);
                g.add(bush);
            }
            break;
        }
        case 'bunting': {
            addBox(w, 0.03, 0.03, steelMat, 0, h - 0.02, d * 0.6);
            const colors = [0xb3262e, 0x2f6fb3, 0xf2c94c, 0x2f9e5f];
            const flags = Math.max(4, Math.round(w / 0.7));
            for (let i = 0; i < flags; i += 1) {
                const fx = -w / 2 + ((i + 0.5) / flags) * w;
                const flag = new THREE.Mesh(
                    new THREE.PlaneGeometry(0.28, h * 0.82),
                    ghost ? mainMat : new THREE.MeshStandardMaterial({ color: colors[i % colors.length], side: THREE.DoubleSide, roughness: 0.85 }),
                );
                flag.position.set(fx, h * 0.45, d * 0.62);
                g.add(flag);
            }
            break;
        }
        case 'kiosk': {
            addBox(w, h * 0.75, d, mainMat, 0, h * 0.375, d / 2);
            const top = new THREE.Mesh(new THREE.BoxGeometry(w * 0.92, h * 0.32, d * 0.75), accentMat);
            top.position.set(0, h * 0.84, d * 0.52);
            top.rotation.x = -0.35;
            g.add(top);
            break;
        }
        case 'bench': {
            addBox(w, 0.08, d * 0.8, mainMat, 0, h * 0.55, d / 2);
            addBox(w, h * 0.42, 0.08, mainMat, 0, h * 0.8, d * 0.15);
            addBox(0.08, h * 0.55, d * 0.75, accentMat, -w * 0.42, h * 0.275, d / 2);
            addBox(0.08, h * 0.55, d * 0.75, accentMat, w * 0.42, h * 0.275, d / 2);
            break;
        }
        case 'lamp': {
            addBox(0.12, 0.16, d * 0.5, mainMat, 0, h * 0.7, d * 0.25);
            const bulb = new THREE.Mesh(
                new THREE.SphereGeometry(Math.min(w, h) * 0.38, 10, 8),
                ghost ? mainMat : new THREE.MeshBasicMaterial({ color: secondary }),
            );
            bulb.position.set(0, h * 0.55, d * 0.72);
            g.add(bulb);
            break;
        }
        case 'water_tank': {
            const standH = h * 0.22;
            addBox(w, standH, d, accentMat, 0, standH / 2, 0);
            const r = Math.min(w, d) * 0.46;
            const tankH = h - standH;
            const cyl = new THREE.Mesh(new THREE.CylinderGeometry(r, r, tankH, 16), mainMat);
            cyl.position.set(0, standH + tankH / 2, 0);
            g.add(cyl);
            break;
        }
        default:
            addBox(w, h, d, mainMat, 0, h / 2, d / 2);
            break;
    }

    if (selected && !ghost) {
        const box = new THREE.Box3().setFromObject(g);
        if (!box.isEmpty()) {
            const helper = new THREE.Box3Helper(box, 0x38bdf8);
            g.add(helper);
        }
    }

    return g;
}

/**
 * Draws all individually placed Studio items for one building into `into`.
 * Tags every mesh with `userData.studioItemIndex = idx` when `pickable` is true.
 */
export function drawStudioItems(into, { ring, height, floors, look, selectedIndex = null, pickable = false }) {
    const items = Array.isArray(look?.items) ? look.items : [];
    if (!items.length || !ring.length) return;

    const levels = Math.max(1, Number(floors) || Math.round(height / 3.2) || 1);
    const storeyH = height / levels;
    const ccw = isRingCCW(ring);
    const { rise } = roofLayers(ring.map((p) => ({ x: p.x, y: -p.z })), look.roof?.style || 'flat');
    const cx = ring.reduce((s, p) => s + p.x, 0) / ring.length;
    const cz = ring.reduce((s, p) => s + p.z, 0) / ring.length;

    items.forEach((item, idx) => {
        const spec = ITEM_BY_TYPE[item.type];
        if (!spec) return;
        const group = buildStudioItemGroup(item, { selected: selectedIndex === idx });
        const baseY = itemBaseY(item, storeyH, height, rise);

        if (spec.placement === 'roof') {
            group.position.set(cx + (item.rx || 0), baseY, cz + (item.rz || 0));
        } else {
            const frame = wallFrameForEdge(ring, item.edge || 0, ccw);
            if (!frame) return;
            const along = (item.t ?? 0.5) * frame.len;
            group.position.set(frame.a.x + frame.tx * along, baseY, frame.a.z + frame.tz * along);
            group.rotation.y = frame.rotY;
        }

        if (pickable) {
            group.traverse((child) => {
                if (child.isMesh) {
                    child.userData.studioItemIndex = idx;
                }
            });
        }
        into.add(group);
    });
}
