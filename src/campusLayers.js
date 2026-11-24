// Leaflet drawing for labelled buildings and the road/walkway network, shared
// by the admin map and the student map so both read the same way.
//
// Two base-map palettes exist: the admin map uses the LIGHT protomaps flavor,
// the student map the DARK one (see createTileLayer calls). Every colour here
// therefore comes in a light/dark pair, picked with the `theme` option, so a
// shape never disappears into the map under it.
//
//   building   outline + soft fill in the department colour when it has one
//              (same rule as node markers), neutral otherwise;
//              under construction = warning amber, dashed; planned = dotted
//   label      one glass chip, same recipe as the HUD panels (uiTokens.js):
//              [dept dot] NAME | 3 floors
//   pathway    road = wide, walkway = thin, covered = sky blue (sheltered in
//              rain mode); under construction / planned = amber dashed
//
// Green stays reserved for the route/destination and red for problems (see
// uiTokens.js), so neither is used here.
import L from 'leaflet';
import { C, FONT_STACK, TYPE } from './uiTokens.js';
import { polygonCentroid, floorCountLabel, statusLabel, interiorPoint, bridgeKindLabel, deckLevelLabel, pathwayWidthM, bridgeDeckHeightM, pointInPolygon } from './campusGeometry.js';
import { floorAria, floorOf } from './floors.js';
import { doorFrames, doorGapWalls, DOOR_HEIGHT_M } from './doors.js';
import { planFromLink, stairTreads, walkLine, footprint } from './stairGeometry.js';
import { fromLocalMeters } from './geo.js';
import { convexHull, clipToConvex, cutStairwells } from './planarGeometry.js';
import {
    sunPosition, shadowRings, buildingHeightM, shadowOpacity, penumbraLayers, shadowColor,
    roofLiftM, visibleWalls, wallLight, insetPolygon, parapetShadowQuads, edgesWithNormals, roofLight,
    PARAPET_W, STOREY_M, EXTRUDE_FACTOR, skyTint, wallBehindBuilding,
} from './sunShadow.js';

const STYLE_ID = 'campus-layer-styles';

/** Shared campus colours (legend rows and the editor draft use these too). */
export const CAMPUS_COLORS = {
    construction: C.warning,
    covered: { light: '#0284c7', dark: '#38bdf8' },
    road: { light: '#7c7c88', dark: '#9a9aa6' },
    walkway: { light: '#4b4b56', dark: '#ececf0' },
    // Neutral building edge when no department colour applies.
    building: { light: '#2a2a33', dark: '#ffffff' },
    // Bridges and other connectors: teal, apart from buildings (white / department) and covered walks (blue).
    bridge: { light: '#0f766e', dark: '#2dd4bf' },
    planned: { light: '#6b6b76', dark: '#c9c9d2' },
};

// Labels need room: below this zoom they would pile on top of each other.
export const LABEL_MIN_ZOOM = 18;

export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
));
const isHex = (v) => /^#[0-9a-fA-F]{6}$/.test(v || '');

function ensureStyles() {
    if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
        /* Leaflet gives a divIcon a 0x0 box; the chip is positioned from its
           anchor and sized to its own content (max-content), so it never
           shrinks around the first word. */
        .bldg-label {
            position: absolute; left: 0; top: 0; width: max-content; max-width: 220px;
            transform: translate(-50%, -50%);
            display: inline-flex; align-items: center; gap: 7px;
            padding: 5px 10px; border-radius: 6px;
            background: ${C.glass}; color: ${C.white};
            -webkit-backdrop-filter: blur(10px) saturate(140%); backdrop-filter: blur(10px) saturate(140%);
            border: 1px solid rgba(255,255,255,0.14);
            box-shadow: 0 4px 14px rgba(0,0,0,0.35);
            font-family: ${FONT_STACK}; font-size: ${TYPE.desc}; line-height: 1.2;
            white-space: nowrap; pointer-events: none;
            animation: bldgIn 0.35s cubic-bezier(0.22, 1, 0.36, 1) both;
        }
        .bldg-label .bl-name { font-weight: 700; letter-spacing: 0.01em; overflow: hidden; text-overflow: ellipsis; }
        .bldg-label .bl-meta {
            flex: none; padding-left: 7px; border-left: 1px solid rgba(255,255,255,0.18);
            color: ${C.muted}; font-weight: 600; font-variant-numeric: tabular-nums;
        }
        .bldg-label.is-construction { border-color: ${C.warning}; }
        .bldg-label.is-construction .bl-meta { color: ${C.warning}; }
        .bldg-label.is-planned { border-style: dashed; border-color: rgba(255,255,255,0.35); }
        /* Bridge chips: teal accent (the chips are dark glass on both base maps). */
        .bldg-label.is-bridge { border-color: ${CAMPUS_COLORS.bridge.dark}; }
        .bldg-label.is-bridge .bl-meta { color: ${CAMPUS_COLORS.bridge.dark}; }
        @keyframes bldgIn { from { opacity: 0; transform: translate(-50%, -40%); } }
        @media (prefers-reduced-motion: reduce) { .bldg-label { animation: none; } }

        .campus-labels-off .bldg-label { display: none; }
        /* declutterLabels(): a crowded chip first drops its "2 floors" part, then hides. */
        .bldg-label.is-compact .bl-meta { display: none; }
        .bldg-label.is-crowded, .leaflet-tooltip.campus-area-label.is-crowded { visibility: hidden; }
        /* The floor guide's tag always shows (it is the point of the guide). */
        .campus-labels-off .floor-guide-tag { display: inline-flex; }
        /* Manage nodes: no name or floor chips over the nodes being placed (AdminMap toggles the class). */
        .manage-nodes-open .bldg-label, .manage-nodes-open .floor-guide-tag { display: none !important; }
        .floor-guide-tag { border-color: #16a34a; }
        path.floor-guide-plate { animation: floorPlateIn 280ms cubic-bezier(0.16, 1, 0.3, 1) both; }
        @keyframes floorPlateIn { from { opacity: 0; } }
        /* Soft shadow edges: a slight blur on the shadow pane only (the
           buildings, route and pins stay crisp above it). */
        .leaflet-campusShadow-pane { filter: blur(var(--shadow-blur, 1.5px)); }
        .tool-active .campus-hit { pointer-events: none !important; }
        path.campus-hit { cursor: pointer; }
    `;
    document.head.appendChild(style);
}

const pick = (pair, theme) => pair[theme] || pair.dark;

/** Outline + fill for a building in a given base-map theme. */
export function buildingStyle(status, theme = 'dark', departmentColor = null) {
    if (status === 'under_construction') {
        const c = CAMPUS_COLORS.construction;
        return { color: c, weight: 2, opacity: 0.95, dashArray: '7, 5', fillColor: c, fillOpacity: 0.12 };
    }
    if (status === 'planned') {
        const c = pick(CAMPUS_COLORS.planned, theme);
        return { color: c, weight: 1.75, opacity: 0.9, dashArray: '2, 6', lineCap: 'round', fillColor: c, fillOpacity: 0.05 };
    }
    const c = isHex(departmentColor) ? departmentColor : pick(CAMPUS_COLORS.building, theme);
    return {
        color: c, weight: 2, opacity: theme === 'light' ? 0.7 : 0.6, lineJoin: 'round',
        fillColor: c, fillOpacity: theme === 'light' ? 0.08 : 0.1,
    };
}

export function pathwayStyle(kind, status, theme = 'dark') {
    const base = kind === 'road'
        ? { color: pick(CAMPUS_COLORS.road, theme), weight: 7, opacity: 0.5 }
        : kind === 'covered'
            ? { color: pick(CAMPUS_COLORS.covered, theme), weight: 4, opacity: 0.9 }
            : { color: pick(CAMPUS_COLORS.walkway, theme), weight: 3, opacity: 0.75 };
    if (status === 'under_construction' || status === 'planned') {
        return { ...base, color: CAMPUS_COLORS.construction, opacity: 0.95, dashArray: '6, 6' };
    }
    return base;
}

/**
 * Map panes for the sunlit look, bottom to top:
 *   campusGround (380)  pathways: the ground that shadows fall onto
 *   skyTint      (375)  time-of-day tint over the base map (drawSkyTint)
 *   campusShadow (390)  sun shadows (blurred)
 *   overlayPane  (400)  buildings, walls, route  (Leaflet default)
 * Call once per map before drawing; harmless to call again.
 */
export function prepareCampusPanes(map) {
    ensureStyles();
    if (!map.getPane('campusGround')) map.createPane('campusGround').style.zIndex = 380;
    // The floor guide (drawFloorGuide) sits above the buildings (overlay pane, 400) and under the
    // node pins (600): buildings are redrawn on every view change, and in a shared pane the last
    // drawn wins, which buried the guide's floor plate after Student view -> Admin view -> Student view.
    if (!map.getPane('floorGuide')) {
        const guide = map.createPane('floorGuide');
        guide.style.zIndex = 410;
        guide.style.pointerEvents = 'none';
    }
    if (!map.getPane('campusShadow')) {
        const pane = map.createPane('campusShadow');
        pane.style.zIndex = 390;
        pane.style.pointerEvents = 'none';
        // Edge softness tracks the zoom: about 0.15 m of real penumbra, shown
        // as 1-5 px, so zoomed in the edge stays soft instead of banded.
        const blur = () => {
            const px = Math.min(5, Math.max(1, 1.5 * 2 ** (map.getZoom() - 19)));
            pane.style.setProperty('--shadow-blur', `${px.toFixed(2)}px`);
        };
        map.on('zoomend', blur);
        blur();
    }
}

/**
 * Darken (or warm) the base map for the time of day: skyTint for the sun's height, multiplied over
 * the tiles under the roads, buildings and route, so those stay readable at night. `altitudeDeg`
 * null clears it (Admin view, where the imagery is traced).
 */
export function drawSkyTint(map, altitudeDeg) {
    if (!map.getPane('skyTint')) {
        const pane = map.createPane('skyTint');
        pane.style.zIndex = 375;
        pane.style.pointerEvents = 'none';
        pane.style.mixBlendMode = 'multiply';
    }
    const { color, opacity } = skyTint(altitudeDeg);
    if (!map._skyTint) {
        // A plain sheet, not a vector shape: vectors are redrawn only after a zoom ends, which left the newly
        // shown edges untinted while zooming out. The sheet covers the view three times over, kept centred
        // on it as the map moves, so zooms and pans never reach its edge.
        const sheet = L.DomUtil.create('div', '', map.getPane('skyTint'));
        sheet.style.position = 'absolute';
        const place = () => {
            const size = map.getSize();
            const topLeft = map.containerPointToLayerPoint([-size.x, -size.y]);
            L.DomUtil.setPosition(sheet, topLeft);
            sheet.style.width = `${size.x * 3}px`;
            sheet.style.height = `${size.y * 3}px`;
        };
        map.on('move resize viewreset zoomend', place);
        place();
        map._skyTint = sheet;
    }
    map._skyTint.style.background = color;
    map._skyTint.style.opacity = String(opacity);
}

/** Wall colours for the 2.5D look: `shade` facing away from the sun, `lit` facing it. */
const WALL = {
    light: { shade: '#8f8b85', lit: '#d9d5ce' },
    dark: { shade: '#26262c', lit: '#5a5a63' },
};

/** Blend two #rrggbb colours, t = 0 gives a, t = 1 gives b. */
function mixHex(a, b, t) {
    const n = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    const [x, y] = [n(a), n(b)];
    const k = Math.max(0, Math.min(1, t));
    return `#${x.map((v, i) => Math.round(v + (y[i] - v) * k).toString(16).padStart(2, '0')).join('')}`;
}

/** Opaque roof for sunlit maps: the building reads as solid, above its shadow. */
const ROOF = { light: '#f6f5f2', dark: '#3a3a42' };
/** The same roof in low sun / at night (roofLight mixes between the two). */
const ROOF_DIM = { light: '#bdbab3', dark: '#24242a' };
const roofStyle = (style, theme) => ({
    ...style,
    fillColor: style.dashArray ? style.fillColor : (ROOF[theme] || ROOF.light),
    fillOpacity: style.dashArray ? Math.max(style.fillOpacity, 0.28) : 0.94,
    weight: style.weight + 0.5,
    opacity: Math.max(style.opacity, 0.85),
});

/** Hide labels while zoomed out; call once per map. */
export function bindLabelZoom(map) {
    ensureStyles();
    const apply = () => map.getContainer().classList.toggle('campus-labels-off', map.getZoom() < LABEL_MIN_ZOOM);
    map.on('zoomend', apply);
    apply();
    // Re-check overlaps after every zoom, resize or redraw (one pass per frame).
    let frame = 0;
    const tidy = () => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => declutterLabels(map));
    };
    map.on('zoomend resize layeradd viewreset', tidy);
    tidy();
}

/**
 * Building names never sit on top of each other: on a narrow phone the map is
 * zoomed further out and the chips crowd. In drawing order, a chip that would
 * overlap one already shown first drops its floor count, then hides until the
 * user zooms in; taller buildings keep their name first. Campus-area names give
 * way to building names. The floor guide's tag always shows.
 */
export function declutterLabels(map) {
    const root = map.getContainer();
    const labels = [...root.querySelectorAll('.bldg-label:not(.floor-guide-tag)')];
    const areas = [...root.querySelectorAll('.leaflet-tooltip.campus-area-label')];
    [...labels, ...areas].forEach((el) => el.classList.remove('is-compact', 'is-crowded'));
    const PAD = 3;
    const kept = [...root.querySelectorAll('.floor-guide-tag')].map((el) => el.getBoundingClientRect()).filter((r) => r.width > 0);
    const hits = (r) => kept.some((k) => r.left < k.right + PAD && r.right > k.left - PAD && r.top < k.bottom + PAD && r.bottom > k.top - PAD);
    const place = (el, canCompact) => {
        let r = el.getBoundingClientRect();
        if (!r.width) return; // hidden (zoomed out)
        if (canCompact && hits(r)) {
            el.classList.add('is-compact');
            r = el.getBoundingClientRect();
        }
        if (hits(r)) el.classList.add('is-crowded');
        else kept.push(r);
    };
    labels.sort((a, b) => (Number(b.dataset.rank) || 0) - (Number(a.dataset.rank) || 0)).forEach((el) => place(el, true));
    areas.forEach((el) => place(el, false));
}

/** One-line chip: [department dot] label | "3 floors" or the status. */
function labelHtml(b) {
    const title = b.short_name || b.name;
    const meta = b.status === 'under_construction' || b.status === 'planned' ? statusLabel(b.status) : floorCountLabel(b);
    const dept = b.department?.color;
    const cls = b.status === 'under_construction' ? ' is-construction' : b.status === 'planned' ? ' is-planned' : '';
    return `<div class="bldg-label${cls}" data-rank="${Number(b.floors) || 1}" title="${esc(b.name)} · ${esc(floorCountLabel(b))}">`
        + `<span class="bl-name">${esc(title)}</span><span class="bl-meta">${esc(meta)}</span></div>`;
}

/**
 * Draw every building into `layer` (cleared first).
 * `popup(b)` returns HTML for a click popup; omit it for display-only maps.
 * `skipId` leaves one building out (the admin is reshaping it as a draft).
 * `theme` matches the base map: 'light' or 'dark'.
 * `roofs` gives each building a solid roof (maps that draw shadows).
 * `extrude` draws it 2.5D, like OSM / bboxfinder: the roof lifted north by
 *   its height (see roofLiftM) and the viewer-facing walls filled in, shaded
 *   by `sun` (lit when facing it). Buildings are drawn back (north) to front
 *   (south) so nearer ones overlap the ones behind. Implies `roofs`.
 */
/**
 * `xray`: ids of buildings the current route goes into. In 2.5D their walls
 * and roof turn see-through and their real ground outline is drawn, with
 * the door gaps, so the route visibly enters through a door instead of
 * seeming to cross the (raised) roof.
 */
// viewDeg: the bearing the viewer looks towards (0 = north, the 2D map). Roofs
// lift that way and the walls facing back at the viewer are drawn, so a map
// turned to the walking heading (the tilted 3D map) still looks solid.
// liftScale: extra height for a laid-back map (vertical reads shorter there).
export function drawBuildings(layer, buildings, { popup = null, skipId = null, skipIds = null, theme = 'dark', roofs = false, extrude = false, sun = null, xray = null, viewDeg = 0, liftScale = 1 } = {}) {
    ensureStyles();
    layer.clearLayers();
    // skipIds: buildings drawn by someone else (e.g. cut away at a floor by drawFloorGuide).
    const list = (buildings || []).filter((b) => b.id !== skipId && !(skipIds && skipIds.has(b.id))
        && Array.isArray(b.polygon) && b.polygon.length >= 3);
    const vN = Math.cos(viewDeg * Math.PI / 180);
    const vE = Math.sin(viewDeg * Math.PI / 180);
    const kLng = Math.cos(((list[0]?.polygon?.[0]?.lat) || 0) * Math.PI / 180);
    // How far along the view a point is (larger = further from the viewer).
    const depth = (p) => p.lat * vN + p.lng * kLng * vE;
    if (extrude) {
        // Far buildings first, so nearer ones are drawn over them.
        const nearest = (b) => Math.min(...b.polygon.map(depth));
        list.sort((x, y) => nearest(y) - nearest(x));
    }
    for (const b of list) {
        const flat = buildingStyle(b.status, theme, b.department?.color);
        const style = roofs || extrude ? roofStyle(flat, theme) : flat;
        // Planned buildings do not exist yet: never extruded.
        const lift = extrude && b.status !== 'planned' ? (roofLiftM(buildingHeightM(b)) * liftScale) / 111320 : 0;
        // A point raised by a share f of the roof lift, towards the view direction.
        const raise = (p, f = 1) => [p.lat + lift * f * vN, p.lng + (lift * f * vE) / (kLng || 1)];
        const up = (p) => raise(p);
        const hit = [];
        const seeThrough = lift > 0 && xray && (xray.has ? xray.has(b.id) : xray.includes(b.id));

        if (lift > 0) {
            const wallBase = theme === 'dark' ? WALL.dark : WALL.light;
            // Back walls first, so a nearer wall of the same building covers them.
            const walls = visibleWalls(b.polygon, viewDeg)
                .sort((w1, w2) => Math.min(depth(w2.a), depth(w2.b)) - Math.min(depth(w1.a), depth(w1.b)));
            for (const w of walls) {
                const light = wallLight(w.normalDeg, sun);
                const fill = b.status === 'under_construction' ? CAMPUS_COLORS.construction : mixHex(wallBase.shade, wallBase.lit, light);
                hit.push(L.polygon([[w.a.lat, w.a.lng], [w.b.lat, w.b.lng], up(w.b), up(w.a)], {
                    stroke: true, color: mixHex(wallBase.shade, '#000000', 0.25), weight: 0.6, opacity: seeThrough ? 0.35 : 0.55,
                    fill: true, fillColor: fill, fillOpacity: seeThrough ? 0.18 : (b.status === 'under_construction' ? 0.35 : 0.97),
                    lineJoin: 'round', interactive: Boolean(popup), className: popup ? 'campus-hit' : '',
                }).addTo(layer));
                if (b.status === 'under_construction' || seeThrough) continue;
                // Contact shading: the foot of a wall is darker where sky light
                // is blocked by the ground (ambient occlusion), fading upwards.
                const at = (p, f) => raise(p, f);
                for (const [f0, f1, o] of [[0, 0.08, 0.16], [0.08, 0.2, 0.08]]) {
                    L.polygon([at(w.a, f0), at(w.b, f0), at(w.b, f1), at(w.a, f1)], {
                        stroke: false, fillColor: '#1a1a20', fillOpacity: o, interactive: false,
                    }).addTo(layer);
                }
                // Storey lines: one floor slab per level, so a 3-floor building
                // visibly has three floors (spacing from the real height).
                const storeys = Math.max(1, Math.round(buildingHeightM(b) / STOREY_M));
                for (let k = 1; k < storeys; k += 1) {
                    const f = k / storeys;
                    L.polyline([at(w.a, f), at(w.b, f)], {
                        color: mixHex(fill, '#000000', 0.35), weight: 1, opacity: 0.38, interactive: false,
                    }).addTo(layer);
                }
            }
            // Doors on the walls facing the viewer: a dark opening with a
            // light frame, door-high (doors on the far walls are hidden by
            // the building itself, as in real life).
            const doorLift = (Math.min(roofLiftM(DOOR_HEIGHT_M), roofLiftM(buildingHeightM(b)) * 0.85) * liftScale) / 111320;
            for (const d of doorFrames(b.polygon, b.doors)) {
                // Only doors on walls facing the viewer.
                if (Math.cos((d.normalDeg - (viewDeg + 180)) * Math.PI / 180) <= 0.05) continue;
                doorway(layer, d, doorLift, { viewDeg, kLng });
            }
        }

        // Roof surface brightness follows the sun's height (bright at noon,
        // greyer at dawn and dusk); the rim (outer ring) is a touch darker.
        const flatRoof = lift > 0 && b.status === 'existing' && !seeThrough;
        const surface = flatRoof ? mixHex(ROOF_DIM[theme] || ROOF_DIM.light, ROOF[theme] || ROOF.light, roofLight(sun)) : null;
        const roof = L.polygon(b.polygon.map(up), {
            ...style,
            ...(flatRoof ? { fillColor: mixHex(surface, '#000000', 0.07), fillOpacity: 0.97 } : {}),
            ...(seeThrough ? { fillOpacity: 0.12, opacity: 0.55, dashArray: '5, 5' } : {}),
            interactive: Boolean(popup),
            className: popup ? 'campus-hit' : '',
        }).addTo(layer);
        hit.push(roof);
        if (seeThrough) {
            // The real ground outline with its door gaps, and each door as a
            // bright threshold: the route below walks in through one of them.
            for (const wall of doorGapWalls(b.polygon, b.doors)) {
                L.polyline(wall.map((p) => [p.lat, p.lng]), { color: '#16161b', weight: 3, opacity: 0.9, lineCap: 'butt', interactive: false }).addTo(layer);
            }
            for (const d of doorFrames(b.polygon, b.doors)) {
                L.polyline([[d.a.lat, d.a.lng], [d.b.lat, d.b.lng]], { color: '#22c55e', weight: 5, opacity: 1, lineCap: 'round', interactive: false }).addTo(layer);
            }
        }
        if (lift === 0) {
            // Flat map: each door is a light gap across the outline.
            for (const d of doorFrames(b.polygon, b.doors)) {
                const line = [[d.a.lat, d.a.lng], [d.b.lat, d.b.lng]];
                L.polyline(line, { color: '#16161b', weight: 8, opacity: 0.85, lineCap: 'butt', interactive: false }).addTo(layer);
                L.polyline(line, { color: '#ffffff', weight: 4, opacity: 1, lineCap: 'butt', interactive: false }).addTo(layer);
            }
        }

        if (flatRoof) {
            const inner = insetPolygon(b.polygon, PARAPET_W);
            if (inner) {
                const innerUp = inner.map(up);
                // The roof inside the parapet.
                L.polygon(innerUp, { stroke: false, fillColor: surface, fillOpacity: 1, interactive: false }).addTo(layer);
                // The rim on the sun side throws a short shadow across the roof.
                const quads = parapetShadowQuads(inner, sun);
                if (quads.length) {
                    L.polygon(quads.map((q) => q.map(up)), {
                        stroke: false, fillColor: shadowColor(sun), fillOpacity: 0.2, fillRule: 'nonzero', interactive: false,
                    }).addTo(layer);
                }
                // Inner lip of the rim: catches light where it faces the sun,
                // dark on the far side (reads as a raised edge, not a line).
                for (const e of edgesWithNormals(inner)) {
                    const facing = sun && sun.altitudeDeg > 0 ? Math.cos((e.normalDeg - sun.azimuthDeg) * Math.PI / 180) : 0;
                    // The lip's own face points inwards: opposite to the edge's outward normal.
                    const lit = -facing;
                    L.polyline([up(e.a), up(e.b)], {
                        color: lit > 0.1 ? '#ffffff' : '#2a2a32',
                        weight: 1.1, opacity: lit > 0.1 ? 0.75 * lit : 0.22 + 0.2 * Math.max(0, -lit),
                        interactive: false, lineCap: 'round',
                    }).addTo(layer);
                }
            }
        }
        if (popup) {
            for (const shape of hit) shape.bindPopup(() => popup(b));
            // Hover lift: a slightly stronger edge and fill on the roof says "tap me".
            const on = () => roof.setStyle({ weight: style.weight + 1, fillOpacity: Math.min(1, style.fillOpacity + 0.08) });
            const off = () => roof.setStyle({ weight: style.weight, fillOpacity: style.fillOpacity });
            for (const shape of hit) { shape.on('mouseover', on); shape.on('mouseout', off); }
        }
        const c = polygonCentroid(b.polygon);
        if (c) {
            L.marker([c.lat + lift, c.lng], {
                icon: L.divIcon({ className: '', html: labelHtml(b), iconSize: [0, 0] }),
                interactive: false, keyboard: false,
            }).addTo(layer);
        }
    }
}

/**
 * Live sun shadows for every existing / under-construction building (planned
 * ones are not built yet, so they cast none). Every shadow ring of every
 * building goes into ONE path filled with the non-zero rule: where shadows of
 * a building, or of two neighbours, overlap, the shade stays even instead of
 * doubling up. Draw this layer UNDER the buildings so each roof sits on top.
 *
 * @returns {{ altitudeDeg: number, azimuthDeg: number }} the sun used
 */
export function drawShadows(layer, buildings, { date = new Date(), lat, lng } = {}) {
    ensureStyles();
    layer.clearLayers();
    const sun = sunPosition(date, lat, lng);
    const base = shadowOpacity(sun);
    if (base === 0) return sun;

    const cast = (buildings || []).filter((b) => b.status !== 'planned' && Array.isArray(b.polygon) && b.polygon.length >= 3);
    if (!cast.length) return sun;
    // Darkest at the wall, fading to the tip (see penumbraLayers). Each copy
    // is one non-zero path, so within a copy overlaps never double up.
    const pane = layer._map?.getPane('campusShadow') ? 'campusShadow' : undefined;
    const fill = shadowColor(sun);
    for (const { fraction, opacity } of penumbraLayers(base * 1.25)) {
        const rings = [];
        for (const b of cast) {
            for (const ring of shadowRings(b.polygon, buildingHeightM(b) * fraction, sun)) {
                rings.push(ring.map((p) => [p.lat, p.lng]));
            }
        }
        if (rings.length) {
            L.polygon(rings, {
                pane, stroke: false, fillColor: fill, fillOpacity: opacity, fillRule: 'nonzero',
                interactive: false, className: 'campus-shadow',
            }).addTo(layer);
        }
    }
    return sun;
}

// ── Floor guide: "which floor am I placing this on" ─────────────────
// While department staff add a node inside a building, the building is drawn
// as a cut-away: solid up to the chosen floor, that floor as a highlighted
// plate, the floors above as ghost outlines. Each floor's height is the
// building's height divided by its floors (the entered height, otherwise the
// floors x 3.2 m estimate), on the same 2.5D lift as the extruded buildings.

/** North offset (degrees of latitude) of a floor plate drawn at `level`. */
export function floorLiftDeg(building, level) {
    const floors = Math.max(1, Number(building?.floors) || 1);
    const perFloorM = buildingHeightM(building) / floors;
    return (Math.max(0, level) * perFloorM * EXTRUDE_FACTOR) / 111320;
}

const GUIDE = '#16a34a';

/**
 * Draw the floor guide into `layer` (cleared first). Returns the chosen
 * plate's latitude lift, so the caller can show the pin on the plate and turn
 * taps on the plate back into the real (ground) position.
 * `named`: label the plate with the building's name too (the student map,
 * where the cut-away replaces the building's own label).
 */
export function drawFloorGuide(layer, building, level, { named = false } = {}) {
    ensureStyles();
    layer.clearLayers();
    if (!building || !Array.isArray(building.polygon) || building.polygon.length < 3) return 0;
    const floors = Math.max(1, Number(building.floors) || 1);
    const chosen = Math.min(Math.max(0, level), floors - 1);
    const ring = building.polygon;
    const at = (k) => ring.map((p) => [p.lat + floorLiftDeg(building, k), p.lng]);
    const liftOf = (k) => floorLiftDeg(building, k);
    const pane = layer._map?.getPane('floorGuide') ? 'floorGuide' : undefined;

    // Ghost of the whole building: roof outline and every floor above.
    for (let k = floors; k > chosen; k -= 1) {
        L.polygon(at(k), {
            pane, color: '#2a2a33', weight: 1, opacity: 0.35, dashArray: '3, 5',
            fill: false, interactive: false,
        }).addTo(layer);
    }
    // Walls from the ground up to the chosen floor (solid: you are "inside" it).
    if (chosen > 0) {
        for (const w of visibleWalls(ring)) {
            L.polygon([[w.a.lat, w.a.lng], [w.b.lat, w.b.lng], [w.b.lat + liftOf(chosen), w.b.lng], [w.a.lat + liftOf(chosen), w.a.lng]], {
                stroke: true, pane, color: '#55555f', weight: 0.8, opacity: 0.6, fillColor: '#c9c6c0', fillOpacity: 0.75, interactive: false,
            }).addTo(layer);
        }
        for (let k = 1; k < chosen; k += 1) {
            L.polygon(at(k), { pane, color: '#55555f', weight: 1, opacity: 0.45, fill: false, interactive: false }).addTo(layer);
        }
    }
    // Doors: on the ground floor they are gaps in the plate's edge; seen from
    // an upper floor they are openings at the foot of the walls facing you.
    const doors = doorFrames(ring, building.doors);
    if (chosen > 0) {
        const doorLift = Math.min(roofLiftM(DOOR_HEIGHT_M), liftOf(chosen) * 111320 * 0.85) / 111320;
        for (const d of doors) {
            if (Math.cos((d.normalDeg - 180) * Math.PI / 180) <= 0.05) continue;
            L.polygon([[d.a.lat, d.a.lng], [d.b.lat, d.b.lng], [d.b.lat + doorLift, d.b.lng], [d.a.lat + doorLift, d.a.lng]], {
                pane, color: '#f4f1ea', weight: 1.2, opacity: 0.9, fillColor: '#2a2420', fillOpacity: 0.92, interactive: false,
            }).addTo(layer);
        }
    }
    // The chosen floor: a highlighted plate the pin stands on.
    L.polygon(at(chosen), {
        pane, color: GUIDE, weight: 2.5, opacity: 1, fillColor: GUIDE, fillOpacity: 0.16, lineJoin: 'round',
        interactive: false, className: 'floor-guide-plate',
    }).addTo(layer);
    if (chosen === 0) {
        for (const d of doors) {
            const line = [[d.a.lat, d.a.lng], [d.b.lat, d.b.lng]];
            L.polyline(line, { pane, color: '#16161b', weight: 8, opacity: 0.85, lineCap: 'butt', interactive: false }).addTo(layer);
            L.polyline(line, { pane, color: '#ffffff', weight: 4, opacity: 1, lineCap: 'butt', interactive: false }).addTo(layer);
        }
    }
    const c = interiorPoint(ring);
    if (c) {
        const title = named ? (building.short_name || building.name) : floorAria(chosen);
        const meta = named ? `${floorAria(chosen)} of ${floors}` : `of ${floors}`;
        L.marker([c.lat + liftOf(chosen), c.lng], {
            icon: L.divIcon({
                className: '',
                html: `<div class="bldg-label floor-guide-tag"><span class="bl-name">${esc(title)}</span><span class="bl-meta">${esc(meta)}</span></div>`,
                iconSize: [0, 0],
            }),
            interactive: false, keyboard: false,
        }).addTo(layer);
    }
    return liftOf(chosen);
}

/**
 * A door as a standing doorway in 2.5D: an opening from the ground up to
 * door height between its two jambs, with a light frame and threshold.
 * `behind`: on a far wall (seen through the building), drawn lighter with a
 * dashed frame so it still reads as being at the back.
 */
function doorway(layer, d, doorLift, { behind = false, viewDeg = 0, kLng = 1 } = {}) {
    const vN = Math.cos(viewDeg * Math.PI / 180);
    const vE = Math.sin(viewDeg * Math.PI / 180);
    const up = (p) => [p.lat + doorLift * vN, p.lng + (doorLift * vE) / (kLng || 1)];
    const a = [d.a.lat, d.a.lng];
    const b = [d.b.lat, d.b.lng];
    L.polygon([a, b, up(d.b), up(d.a)], {
        stroke: false, fillColor: behind ? '#22c55e' : '#2a2420', fillOpacity: behind ? 0.35 : 0.92, interactive: false,
    }).addTo(layer);
    L.polyline([a, up(d.a), up(d.b), b], {
        color: '#ffffff', weight: behind ? 1.6 : 2, opacity: behind ? 0.95 : 1, lineJoin: 'round', lineCap: 'round',
        ...(behind ? { dashArray: '3, 3' } : {}), interactive: false,
    }).addTo(layer);
    // Threshold on the ground: where the route steps through.
    L.polyline([a, b], { color: behind ? '#22c55e' : '#ffffff', weight: 3, opacity: 1, lineCap: 'round', interactive: false }).addTo(layer);
}

/**
 * A building on the student's route, in the 3D building style but only as
 * tall as the route needs: sun-shaded walls from the ground up to the
 * CEILING of the highest floor the route uses (one storey for a ground-floor
 * route), one line per storey, and a roof on top, a little see-through so the
 * floor inside and the route on it stay visible. Inside, the floor being
 * viewed is green and the route's other floors are see-through grey; floors
 * the route does not use are left out. Draws into `layer` (cleared first).
 *   floors: the floor numbers the route uses in this building
 *   active: the floor being viewed (always drawn)
 *   destinationFloor: labelled "destination" when it is not the active one
 */
export function drawRouteFloors(layer, building, { floors = [], active = 0, destinationFloor = null, sun = null } = {}) {
    ensureStyles();
    layer.clearLayers();
    const ring = building?.polygon;
    if (!Array.isArray(ring) || ring.length < 3) return;
    const total = Math.max(1, Number(building.floors) || 1);
    const clampF = (f) => Math.min(Math.max(0, Number(f) || 0), total - 1);
    const shown = clampF(active);
    const used = [...new Set([...floors.map(clampF), shown])].sort((a, b) => a - b);
    const top = used[used.length - 1];
    // Floor k stands at lift(k); the cut is the ceiling of the top floor.
    const lift = (k) => floorLiftDeg(building, k);
    const ceiling = lift(top + 1);
    const at = (k) => ring.map((p) => [p.lat + lift(k), p.lng]);
    const doors = doorFrames(ring, building.doors);

    // Floors inside, lowest first (under the walls and the roof).
    for (const f of used) {
        const isShown = f === shown;
        L.polygon(at(f), isShown
            ? { color: GUIDE, weight: 2, opacity: 0.9, fillColor: GUIDE, fillOpacity: 0.22, lineJoin: 'round', interactive: false }
            : { color: '#5f5f68', weight: 1.2, opacity: 0.7, fillColor: '#8a8f98', fillOpacity: 0.3, lineJoin: 'round', interactive: false },
        ).addTo(layer);
    }

    // Walls up to the ceiling, back walls first, as the 3D buildings.
    const walls = visibleWalls(ring).sort((w1, w2) => Math.min(w2.a.lat, w2.b.lat) - Math.min(w1.a.lat, w1.b.lat));
    for (const w of walls) {
        const fill = mixHex(WALL.light.shade, WALL.light.lit, wallLight(w.normalDeg, sun));
        L.polygon([[w.a.lat, w.a.lng], [w.b.lat, w.b.lng], [w.b.lat + ceiling, w.b.lng], [w.a.lat + ceiling, w.a.lng]], {
            stroke: true, color: mixHex(WALL.light.shade, '#000000', 0.25), weight: 0.7, opacity: 0.6,
            fill: true, fillColor: fill, fillOpacity: 0.95, lineJoin: 'round', interactive: false,
        }).addTo(layer);
        // Contact shading at the foot, then one line per storey.
        for (const [f0, f1, o] of [[0, 0.08, 0.16], [0.08, 0.2, 0.08]]) {
            L.polygon([[w.a.lat + ceiling * f0, w.a.lng], [w.b.lat + ceiling * f0, w.b.lng], [w.b.lat + ceiling * f1, w.b.lng], [w.a.lat + ceiling * f1, w.a.lng]], {
                stroke: false, fillColor: '#1a1a20', fillOpacity: o, interactive: false,
            }).addTo(layer);
        }
        for (let k = 1; k <= top; k += 1) {
            L.polyline([[w.a.lat + lift(k), w.a.lng], [w.b.lat + lift(k), w.b.lng]], {
                color: mixHex(fill, '#000000', 0.35), weight: 1, opacity: 0.45, interactive: false,
            }).addTo(layer);
        }
    }
    // Doors as standing doorways, door-high: the ones in the walls facing the
    // viewer sit in those walls; the ones on far walls are drawn after the
    // roof (below), lighter and dashed, so the way in is never hidden.
    const doorLift = Math.min(roofLiftM(DOOR_HEIGHT_M), ceiling * 111320 * 0.85) / 111320;
    const facesViewer = (d) => Math.cos(((d.normalDeg - 180) * Math.PI) / 180) > 0.05;
    for (const d of doors) if (facesViewer(d)) doorway(layer, d, doorLift);
    // Roof at the cut: the 3D buildings' roof colour, see-through enough for
    // the green floor and the route under it; a green edge marks the building
    // the route goes into.
    L.polygon(ring.map((p) => [p.lat + ceiling, p.lng]), {
        color: GUIDE, weight: 2, opacity: 0.95, fillColor: mixHex(ROOF_DIM.light, ROOF.light, roofLight(sun)),
        fillOpacity: 0.55, lineJoin: 'round', interactive: false,
    }).addTo(layer);
    for (const d of doors) if (!facesViewer(d)) doorway(layer, d, doorLift, { behind: true });

    // Labels: the building and the floor being viewed; the destination's floor.
    const c = interiorPoint(ring);
    if (!c) return;
    const tag = (f, title, meta) => L.marker([c.lat + lift(f), c.lng], {
        icon: L.divIcon({
            className: '',
            html: `<div class="bldg-label floor-guide-tag"><span class="bl-name">${esc(title)}</span><span class="bl-meta">${esc(meta)}</span></div>`,
            iconSize: [0, 0],
        }),
        interactive: false, keyboard: false,
    }).addTo(layer);
    tag(shown, building.short_name || building.name, `${floorAria(shown)} of ${total}`);
    if (destinationFloor !== null && clampF(destinationFloor) !== shown) tag(clampF(destinationFloor), floorAria(clampF(destinationFloor)), 'destination');
}

const STAIR_TREAD = '#ffb02e';
const STAIR_RISER = '#a35f00';

/**
 * A staircase in 2.5D: every tread and landing lifted from the lower node's
 * floor plate up to the upper node's, so the two floors read as one
 * staircase joining them (not a flat line with an arrow). Draws into `layer`
 * (not cleared). `liftOf(floor)` is the latitude lift of that floor's plate.
 *   muted: floors below the one being looked at (grey, see-through)
 *   ghost: climbs to a floor that is cut away (faint, ends at its outline)
 */
export function drawStairs25D(layer, link, a, b, liftOf, { muted = false, ghost = false } = {}) {
    if (!a || !b) return;
    const { plan, bottom, top } = planFromLink(link, a, b);
    const l0 = liftOf(floorOf(bottom));
    const l1 = liftOf(floorOf(top));
    const liftAt = (u) => l0 + (plan.rise > 0 ? Math.min(1, Math.max(0, u / plan.rise)) : 0) * (l1 - l0);
    const toLL = ([e, n], u) => {
        const p = fromLocalMeters(bottom.latitude, bottom.longitude, e, n);
        return [p.latitude + liftAt(u), p.longitude];
    };
    const tread = muted ? '#9a9aa2' : STAIR_TREAD;
    const riser = muted ? '#6b6b74' : STAIR_RISER;
    const alpha = muted ? 0.45 : ghost ? 0.4 : 0.95;
    // Far (north) to near (south): nearer steps cover the ones behind them.
    const centreN = (t) => t.ring.reduce((sum, p) => sum + p[1], 0) / t.ring.length;
    const parts = stairTreads(plan).sort((x, y) => centreN(y) - centreN(x) || x.u - y.u);
    for (const t of parts) {
        // The riser under a tread shows when it faces the viewer (south).
        if (t.riser && Math.cos(((t.facingDeg - 180) * Math.PI) / 180) > 0.05) {
            const [r0, r1] = t.riser;
            L.polygon([toLL(r0, t.u0), toLL(r1, t.u0), toLL(r1, t.u), toLL(r0, t.u)], {
                stroke: false, fillColor: riser, fillOpacity: alpha, interactive: false,
            }).addTo(layer);
        }
        L.polygon(t.ring.map((p) => toLL(p, t.u)), {
            color: riser, weight: 0.8, opacity: alpha, fillColor: tread,
            fillOpacity: t.kind === 'landing' ? alpha * 0.8 : alpha, interactive: false,
            ...(ghost ? { dashArray: '3, 3' } : {}),
        }).addTo(layer);
    }
    // Where the top of the plan is not exactly on the upper node: a short
    // dashed link on the upper floor so the two still read as connected.
    const end = fromLocalMeters(bottom.latitude, bottom.longitude, plan.end.e, plan.end.n);
    L.polyline([[end.latitude + l1, end.longitude], [top.latitude + l1, top.longitude]], {
        color: riser, weight: 2, opacity: alpha, dashArray: '2, 5', lineCap: 'round', interactive: false,
    }).addTo(layer);
}

/**
 * The route climbing a staircase in 2.5D, as [lat, lng] points from node
 * `from` to node `to` (either may be the lower end): along the walking line,
 * each point lifted to its height between the two floor plates, then over to
 * the far node. Same lifts as drawStairs25D, so the line runs on the steps.
 */
export function stairRouteLine(link, from, to, liftOf) {
    if (!from || !to) return [];
    const { plan, bottom, top } = planFromLink(link, from, to);
    const l0 = liftOf(floorOf(bottom));
    const l1 = liftOf(floorOf(top));
    const liftAt = (u) => l0 + (plan.rise > 0 ? Math.min(1, Math.max(0, u / plan.rise)) : 0) * (l1 - l0);
    const up = walkLine(plan).map((p) => {
        const q = fromLocalMeters(bottom.latitude, bottom.longitude, p.e, p.n);
        return [q.latitude + liftAt(p.u), q.longitude];
    });
    up.push([top.latitude + l1, top.longitude]);
    return bottom === from ? up : up.reverse();
}

/** Outline + fill for a bridge deck in a given base-map theme (under construction / planned like buildings). */
export function bridgeStyle(status, theme = 'dark') {
    if (status === 'under_construction' || status === 'planned') return buildingStyle(status, theme);
    const c = pick(CAMPUS_COLORS.bridge, theme);
    return { color: c, weight: 2.5, opacity: 0.95, lineJoin: 'round', fillColor: c, fillOpacity: theme === 'light' ? 0.28 : 0.32 };
}

/** How thick a raised deck is drawn, metres (its edge band in 2.5D). */
const DECK_SLAB_M = 0.6;
/** Railing height along a deck's long sides, metres (RouteModel3D's RAIL_M). */
const RAIL_M = 1.05;

/**
 * Draw every bridge into `layer` (cleared first): the deck in teal and a label chip such as
 * "Footbridge · 1 floor up". `extrude` (the student map and Student view, like the 2.5D buildings):
 * a raised deck is lifted to its real height (bridgeDeckHeightM, the 3D views' height) on pillars,
 * with its edge band facing the viewer (north-up). Call it after drawBuildings so the deck crosses over them.
 * Raised decks look like the 3D views: railings that stop at each entrance, door-high entrance frames,
 * and with `links` and `nodes` the staircases from the ground up to the deck, seen through the
 * stairwell cut out of the deck above them.
 */
export function drawBridges(layer, bridges, { popup = null, skipId = null, theme = 'dark', extrude = false, links = [], nodes = [] } = {}) {
    ensureStyles();
    layer.clearLayers();
    const nodeById = new Map((nodes || []).map((n) => [n.id, n]));
    for (const b of bridges || []) {
        if (b.id === skipId || !Array.isArray(b.polygon) || b.polygon.length < 3) continue;
        // Closed (an event): drawn like a planned structure, grey and dashed.
        const style = bridgeStyle(b.closed ? 'planned' : b.status, theme);
        const heightM = extrude && b.status !== 'planned' ? bridgeDeckHeightM(b) : 0;
        const lift = heightM > 0.3 ? roofLiftM(heightM) / 111320 : 0;
        // A point raised by a share f of the deck's lift (north-up, as drawBuildings with viewDeg 0).
        const up = (p, f = 1) => [p.lat + lift * f, p.lng];
        // Stairwells: one opening per flight and landing over the deck, in flat metres east (x) / north (z)
        // of the deck's first corner, as the 3D views cut them.
        const holes = [];
        const ref = b.polygon[0];
        const k = Math.cos((ref.lat * Math.PI) / 180) * 111320;
        const toLocal = (p) => ({ x: (p.lng - ref.lng) * k, z: (p.lat - ref.lat) * 111320 });
        const toLL = (p) => up({ lat: +ref.lat + p.z / 111320, lng: +ref.lng + p.x / k });
        const ring = b.polygon.map(toLocal);
        if (lift > 0) {
            const under = Math.max(0, (heightM - DECK_SLAB_M) / heightM);
            // The ground it crosses, faint; pillars at the deck's corners; the deck's edge facing the viewer.
            L.polygon(b.polygon.map((p) => [p.lat, p.lng]), { stroke: false, fillColor: style.color, fillOpacity: 0.08, interactive: false }).addTo(layer);
            for (const p of b.polygon) {
                L.polyline([[p.lat, p.lng], up(p, under)], { color: theme === 'dark' ? '#9ca3af' : '#6b7280', weight: 3, opacity: 0.9, lineCap: 'round', interactive: false }).addTo(layer);
            }
            // Staircases from the ground up to this deck, under the see-through deck as in 3D.
            const onDeck = (n) => n && n.building_id == null && floorOf(n) === Number(b.deck_floor)
                && pointInPolygon(+n.latitude, +n.longitude, b.polygon);
            for (const l of links || []) {
                const a = nodeById.get(l.node_a_id);
                const z = nodeById.get(l.node_b_id);
                if (!a || !z || floorOf(a) === floorOf(z) || !(onDeck(a) || onDeck(z))) continue;
                drawStairs25D(layer, l, a, z, (f) => (f > 0 ? lift : 0), { muted: Boolean(b.closed) });
                const { plan, bottom } = planFromLink(l, a, z);
                const base = toLocal({ lat: +bottom.latitude, lng: +bottom.longitude });
                for (const f of footprint(plan)) {
                    const hole = convexHull(f.ring.map(([e, n]) => ({ x: base.x + e, z: base.z + n })));
                    if (clipToConvex(ring, hole).length >= 3) holes.push(hole);
                }
            }
            // Each entrance is on the ground, under the deck's edge: a door-high white frame with a faint
            // pane, drawn before the deck so the deck covers the ones behind it.
            const door = Math.min(DOOR_HEIGHT_M / heightM, under);
            for (const d of doorFrames(b.polygon, b.doors)) {
                L.polygon([up(d.a, 0), up(d.b, 0), up(d.b, door), up(d.a, door)], { stroke: false, fillColor: '#e5e7eb', fillOpacity: 0.16, interactive: false }).addTo(layer);
                L.polyline([up(d.a, 0), up(d.a, door), up(d.b, door), up(d.b, 0)], { color: '#ffffff', weight: 2, opacity: 1, lineJoin: 'round', lineCap: 'round', interactive: false }).addTo(layer);
                L.polyline([up(d.a, 0), up(d.b, 0)], { color: '#ffffff', weight: 3, opacity: 1, lineCap: 'round', interactive: false }).addTo(layer);
            }
            for (const w of visibleWalls(b.polygon, 0)) {
                L.polygon([up(w.a, under), up(w.b, under), up(w.b), up(w.a)], {
                    stroke: true, color: mixHex(style.color, '#000000', 0.45), weight: 0.6, opacity: 0.7,
                    fillColor: mixHex(style.color, '#000000', 0.3), fillOpacity: b.closed ? 0.45 : 0.95, interactive: false,
                }).addTo(layer);
            }
        }
        // The stairwells are holes in the deck: the steps below show through them. With holes the
        // outline is drawn on its own (a cut ring's own stroke would trace slivers across the opening).
        const cut = holes.length ? cutStairwells(ring, holes) : null;
        const deck = L.polygon(cut ? cut.pieces.map((piece) => piece.map(toLL)) : b.polygon.map((p) => up(p)), {
            ...style, ...(lift > 0 && !b.closed ? { fillOpacity: 0.9 } : {}), ...(cut ? { stroke: false } : {}),
            interactive: Boolean(popup), className: popup ? 'campus-hit' : '',
        }).addTo(layer);
        if (cut) {
            // Drawn on their own (the pieces' own strokes would show the cuts between them): the deck's
            // outline, open where a stairwell reaches its edge, and each stairwell's edge over the deck in amber.
            const seg = ([p, q], color, weight) => L.polyline([toLL(p), toLL(q)], { color, weight, opacity: style.opacity, lineCap: 'round', interactive: false }).addTo(layer);
            cut.outline.forEach((part) => seg(part, style.color, style.weight));
            cut.wellEdges.forEach((part) => seg(part, STAIR_TREAD, 1.5));
        }
        if (lift > 0) {
            // Railings along the long sides (the walking line's direction), a faint panel with a top rail.
            const rail = (RAIL_M + heightM) / heightM;
            const line = Array.isArray(b.centre_line) ? b.centre_line : [];
            const k = Math.cos((b.polygon[0].lat * Math.PI) / 180);
            const vec = (p, q) => [(q.lng - p.lng) * k, q.lat - p.lat];
            const axis = line.length >= 2 ? vec(line[0], line[1]) : null;
            b.polygon.forEach((p, i) => {
                const q = b.polygon[(i + 1) % b.polygon.length];
                const d = vec(p, q);
                const len = Math.hypot(...d);
                if (len * 111320 < 0.2) return;
                if (axis && Math.abs((d[0] * axis[0] + d[1] * axis[1]) / (len * Math.hypot(...axis))) < 0.7) return;
                L.polygon([up(p), up(q), up(q, rail), up(p, rail)], { stroke: false, fillColor: '#e5e7eb', fillOpacity: 0.15, interactive: false }).addTo(layer);
                L.polyline([up(p, rail), up(q, rail)], { color: style.color, weight: 1.5, opacity: 0.9, interactive: false }).addTo(layer);
            });
        } else {
            // Flat map: each door is a light gap across the outline, like a building's.
            for (const d of doorFrames(b.polygon, b.doors)) {
                const line = [[d.a.lat, d.a.lng], [d.b.lat, d.b.lng]];
                L.polyline(line, { color: '#16161b', weight: 8, opacity: 0.85, lineCap: 'butt', interactive: false }).addTo(layer);
                L.polyline(line, { color: '#ffffff', weight: 4, opacity: 1, lineCap: 'butt', interactive: false }).addTo(layer);
            }
        }
        if (popup) deck.bindPopup(() => popup(b));
        const c = polygonCentroid(b.polygon);
        if (c) {
            const meta = b.closed ? `Closed${b.closed_reason ? ` · ${b.closed_reason}` : ''}`
                : b.status === 'under_construction' || b.status === 'planned' ? statusLabel(b.status) : deckLevelLabel(b.deck_floor);
            const html = `<div class="bldg-label is-bridge" data-rank="1" title="${esc(b.name)} · ${esc(bridgeKindLabel(b.kind))}">`
                + `<span class="bl-name">${esc(b.short_name || b.name)}</span><span class="bl-meta">${esc(meta)}</span></div>`;
            L.marker(up(c), { icon: L.divIcon({ className: '', html, iconSize: [0, 0] }), interactive: false, keyboard: false }).addTo(layer);
        }
    }
}

/** Draw every pathway into `layer` (cleared first). Same options as drawBuildings. */
/** Line weight in pixels that is `widthM` metres wide at the map's zoom, never under `minPx`. */
export function pathWeightPx(map, widthM, minPx = 0) {
    const metresPerPx = (40075016.686 * Math.cos((map.getCenter().lat * Math.PI) / 180)) / 2 ** (map.getZoom() + 8);
    return Math.max(minPx, widthM / metresPerPx);
}

/** How tall a campus wall or fence is drawn in 2.5D, metres. */
export const WALL_HEIGHT_M = 2.2;

/**
 * The drawn walls (borders: [{ coordinates: [{lat, lng}] }]) in 2.5D, as the student sees the
 * buildings: each stretch raised WALL_HEIGHT_M (north-up, like drawBuildings), its face shaded by
 * the sun like a building's wall, a darker top edge. Far stretches first, so nearer ones cover them.
 * Draws into `layer` (cleared first), the one under the buildings; with `frontLayer` (over them) and
 * `buildings`, a stretch in front of every building (wallBehindBuilding) goes there instead.
 */
export function drawWalls25D(layer, borders, { theme = 'light', sun = null, buildings = [], frontLayer = null } = {}) {
    layer.clearLayers();
    frontLayer?.clearLayers();
    const lift = roofLiftM(WALL_HEIGHT_M) / 111320;
    const tone = WALL[theme] || WALL.light;
    const segs = [];
    for (const g of borders || []) {
        const pts = (g?.coordinates || []).filter((p) => Number.isFinite(+p.lat) && Number.isFinite(+p.lng));
        for (let i = 1; i < pts.length; i += 1) segs.push([pts[i - 1], pts[i]]);
    }
    segs.sort(([a1, b1], [a2, b2]) => Math.max(+a2.lat, +b2.lat) - Math.max(+a1.lat, +b1.lat));
    for (const [a, b] of segs) {
        const k = Math.cos((+a.lat * Math.PI) / 180);
        const de = (+b.lng - +a.lng) * k;
        const dn = +b.lat - +a.lat;
        // The face towards the viewer: of the wall's two sides, the one facing south. Its compass
        // bearing (0 = north, clockwise) says how much sun falls on it.
        const [ne, nn] = -de <= 0 ? [dn, -de] : [-dn, de];
        const normalDeg = ((Math.atan2(ne, nn) * 180) / Math.PI + 360) % 360;
        const fill = mixHex(tone.shade, tone.lit, wallLight(normalDeg, sun));
        const up = (p) => [+p.lat + lift, +p.lng];
        const into = frontLayer && !wallBehindBuilding(a, b, buildings) ? frontLayer : layer;
        L.polygon([[+a.lat, +a.lng], [+b.lat, +b.lng], up(b), up(a)], {
            stroke: true, color: mixHex(fill, '#000000', 0.35), weight: 0.6, opacity: 0.8,
            fillColor: fill, fillOpacity: 0.95, interactive: false,
        }).addTo(into);
        // Its top: a darker edge (a wall running north-south shows mostly as this line).
        L.polyline([up(a), up(b)], { color: mixHex(fill, '#000000', 0.45), weight: 2.5, opacity: 0.95, lineCap: 'round', interactive: false }).addTo(into);
    }
}

export function drawPathways(layer, pathways, { popup = null, skipId = null, theme = 'dark' } = {}) {
    ensureStyles();
    layer.clearLayers();
    const lines = [];
    for (const p of pathways || []) {
        if (p.id === skipId || !Array.isArray(p.coordinates) || p.coordinates.length < 2) continue;
        const latlngs = p.coordinates.map((c) => [c.lat, c.lng]);
        const style = pathwayStyle(p.kind, p.status, theme);
        // On the ground pane (under the shadows) when the map has one, in a sub-pane per see-through level:
        // the lines are drawn solid and the pane fades them as one, so where pathways cross or join they
        // read as one surface instead of a darker overlap.
        const ground = layer._map?.getPane('campusGround');
        let pane;
        let opacity = style.opacity;
        if (ground) {
            pane = `campusGround${Math.round(style.opacity * 100)}`;
            if (!layer._map.getPane(pane)) layer._map.createPane(pane, ground).style.opacity = String(style.opacity);
            opacity = 1;
        }
        const line = L.polyline(latlngs, { ...style, opacity, pane, lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(layer);
        lines.push({ line, minPx: style.weight, widthM: pathwayWidthM(p.kind, p.width_m) });
        if (popup) {
            // Fat invisible hit line: a 3 px walkway is untappable on phones.
            L.polyline(latlngs, { weight: 22, opacity: 0, interactive: true, className: 'campus-hit' })
                .bindPopup(() => popup(p))
                .addTo(layer);
        }
    }
    // Each line as wide as the pathway really is (the 3D strips use the same widths), never
    // thinner than its style's weight when zoomed out. One zoom handler per layer.
    const map = layer._map;
    if (!map) return;
    if (layer._fitPathWidths) map.off('zoomend', layer._fitPathWidths);
    layer._fitPathWidths = () => {
        for (const { line, minPx, widthM } of lines) line.setStyle({ weight: pathWeightPx(map, widthM, minPx) });
    };
    map.on('zoomend', layer._fitPathWidths);
    layer._fitPathWidths();
}
