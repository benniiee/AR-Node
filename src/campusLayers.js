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
import { fromLocalMeters, toLocalMeters } from './geo.js';
import { convexHull, clipToConvex, cutStairwells } from './planarGeometry.js';
import {
    treeModel, trunkTopM, crownFootprint, shedRoof, objectRect, gateEnds, objectShadowRings, seededRandom, parkingLayout,
    objectSize, RESIZE_HANDLES, fromObjectFrame, resizeFrom, rotateTo, rotateHandleAt,
    crownFromFrame, heightHandleAt, heightTo,
} from './campusObjects.js';
import { arrowsAlong, startBearing } from './routeArrows.js';
import { appearanceOf, roofLayers, roofColorOf, BAY_M } from './buildingAppearance.js';
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
 * A layer group whose shapes (lines, polygons) are drawn in map pane `pane` (prepareCampusPanes), so they
 * stay above or below other layers whatever is redrawn later. Shapes that already chose a pane (shadows,
 * the floor guide) keep it; so do markers and labels.
 */
export function paneLayerGroup(pane) {
    // Groups added inside it (a route's pieces above and below a floor) carry the pane down to their shapes.
    const claim = (layer) => {
        if (layer instanceof L.Path) {
            if (layer.options.pane === 'overlayPane') layer.options.pane = pane;
        } else if (layer instanceof L.LayerGroup && !layer.campusPane) {
            layer.campusPane = pane;
            const add = layer.addLayer.bind(layer);
            layer.addLayer = (child) => { claim(child); return add(child); };
            layer.eachLayer(claim);
        }
    };
    const group = L.layerGroup();
    claim(group);
    return group;
}

/**
 * Map panes for the sunlit 2.5D look, bottom to top:
 *   skyTint            (375)  time-of-day tint over the base map (drawSkyTint)
 *   campusGround       (380)  pathways: the ground that shadows fall onto
 *   campusShadow       (390)  sun shadows (blurred)
 *   campusAreas        (391)  campus areas
 *   campusBack         (393)  walls behind a building
 *   campusBackObjects  (394)  trees, benches, sheds behind a building
 *   campusBuildings    (395)  buildings
 *   campusFront        (396)  walls in front of the buildings
 *   campusFrontObjects (397)  trees, benches, sheds in front of them
 *   campusBridges      (398)  bridges over it all
 *   campusTop          (399)  route, staircases, building cut-away, wall editor
 *   overlayPane        (400)  anything drawn straight on the map: editor drafts, picked-node rings, GPS accuracy
 *   floorGuide         (410)  the "which floor" guide
 * Each its own pane because in one shared pane the last drawn wins: a redraw (Student view -> Admin view
 * -> Student view, saving a tree) put trees, walls and the floor guide behind or in front of the buildings
 * at random. Call once per map before drawing; harmless to call again.
 */
export function prepareCampusPanes(map) {
    ensureStyles();
    if (!map.getPane('campusGround')) map.createPane('campusGround').style.zIndex = 380;
    if (!map.getPane('floorGuide')) {
        const guide = map.createPane('floorGuide');
        guide.style.zIndex = 410;
        guide.style.pointerEvents = 'none';
    }
    const stack = [
        ['campusAreas', 391], ['campusBack', 393], ['campusBackObjects', 394], ['campusBuildings', 395],
        ['campusFront', 396], ['campusFrontObjects', 397], ['campusBridges', 398], ['campusTop', 399],
    ];
    for (const [name, z] of stack) if (!map.getPane(name)) map.createPane(name).style.zIndex = z;
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
    layer._stopCranes?.();
    layer._cranes = [];
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
        // How its department dressed it (Building Studio); the plain look when nobody has.
        const look = appearanceOf(b);
        const H = buildingHeightM(b);
        const placeLabel = () => {
            const c = polygonCentroid(b.polygon);
            if (!c) return;
            L.marker([c.lat + lift, c.lng], {
                icon: L.divIcon({ className: '', html: labelHtml(b), iconSize: [0, 0] }),
                interactive: false, keyboard: false,
            }).addTo(layer);
        };
        if (lift > 0 && b.status === 'under_construction') {
            // Being built: its frame, hollow-block walls going up, scaffolding and a tower crane (as in 3D).
            const site = drawSite25D(layer, b, { raise, kLng, sun, theme, viewDeg, depth, interactive: Boolean(popup) });
            if (popup) for (const shape of site) shape.bindPopup(() => popup(b));
            placeLabel();
            continue;
        }

        if (lift > 0) {
            const wallBase = look.walls.color
                ? { shade: mixHex(look.walls.color, '#000000', 0.4), lit: look.walls.color }
                : (theme === 'dark' ? WALL.dark : WALL.light);
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
                const storeys = Math.max(1, Number(b.floors) || Math.round(H / STOREY_M));
                // Its front: windows, arches or pillars on every storey (Building Studio).
                facade25D(layer, w, look, at, H, storeys, kLng);
                for (let k = 1; k < storeys; k += 1) {
                    const f = k / storeys;
                    L.polyline([at(w.a, f), at(w.b, f)], look.walls.accent
                        ? { color: look.walls.accent, weight: 1.8, opacity: 0.95, interactive: false }
                        : { color: mixHex(fill, '#000000', 0.35), weight: 1, opacity: 0.38, interactive: false }).addTo(layer);
                }
            }
            // Doors on the walls facing the viewer: a dark opening with a
            // light frame, door-high (doors on the far walls are hidden by
            // the building itself, as in real life).
            const doorLift = (Math.min(roofLiftM(DOOR_HEIGHT_M), roofLiftM(buildingHeightM(b)) * 0.85) * liftScale) / 111320;
            const RAD = Math.PI / 180;
            const shift = (p, bearing, m) => ({
                lat: p.lat + (Math.cos(bearing * RAD) * m) / 111320,
                lng: p.lng + (Math.sin(bearing * RAD) * m) / (111320 * (kLng || 1)),
            });
            let frontDoor = null;
            for (const d of doorFrames(b.polygon, b.doors)) {
                // Only doors on walls facing the viewer.
                if (Math.cos((d.normalDeg - (viewDeg + 180)) * Math.PI / 180) <= 0.05) continue;
                if (!frontDoor) frontDoor = d;
                if (look.entrance.steps && !seeThrough) {
                    // Two shallow steps out from the threshold (Building Studio).
                    const alongDeg = Math.atan2((d.b.lng - d.a.lng) * (kLng || 1), d.b.lat - d.a.lat) / RAD;
                    for (let s = 0; s < 2; s += 1) {
                        const out0 = 0.15 + s * 0.45;
                        const out1 = out0 + 0.45;
                        const p0 = shift(d.a, alongDeg + 180, 0.55 + s * 0.08);
                        const p1 = shift(d.b, alongDeg, 0.55 + s * 0.08);
                        L.polygon([
                            shift(p0, d.normalDeg, out0), shift(p1, d.normalDeg, out0),
                            shift(p1, d.normalDeg, out1), shift(p0, d.normalDeg, out1),
                        ], {
                            color: '#8d877c', weight: 0.5, opacity: 0.8,
                            fillColor: s ? '#c9c4b8' : '#b9b5ac', fillOpacity: 1, interactive: false,
                        }).addTo(layer);
                    }
                }
                doorway(layer, d, doorLift, { viewDeg, kLng, style: look.entrance.door, color: look.entrance.doorColor });
                if (look.entrance.canopy && !seeThrough) {
                    canopy25D(layer, d, look.entrance.color, raise, H, kLng, look.entrance.canopyShape);
                }
            }
            if (frontDoor && !seeThrough) {
                drawDecor25D(layer, look, frontDoor, { raise, H, kLng, shift });
            }
        }

        // Roof surface brightness follows the sun's height (bright at noon,
        // greyer at dawn and dusk); the rim (outer ring) is a touch darker.
        // A sloped or curved roof (Building Studio): its faces, shaded by the sun, from the eave to the top.
        const slopes = lift > 0 && !seeThrough && b.status === 'existing' && look.roof.style !== 'flat'
            ? slopedRoof25D(layer, b, look, { raise, H, sun, depth, outline: style, interactive: Boolean(popup) })
            : null;
        const flatRoof = lift > 0 && b.status === 'existing' && !seeThrough && !slopes;
        const surface = flatRoof
            ? (look.roof.color
                ? mixHex(mixHex(look.roof.color, '#000000', 0.25), look.roof.color, roofLight(sun))
                : mixHex(ROOF_DIM[theme] || ROOF_DIM.light, ROOF[theme] || ROOF.light, roofLight(sun)))
            : null;
        const roof = slopes ? slopes[0] : L.polygon(b.polygon.map(up), {
            ...style,
            ...(flatRoof ? { fillColor: mixHex(surface, '#000000', 0.07), fillOpacity: 0.97 } : {}),
            ...(seeThrough ? { fillOpacity: 0.12, opacity: 0.55, dashArray: '5, 5' } : {}),
            interactive: Boolean(popup),
            className: popup ? 'campus-hit' : '',
        }).addTo(layer);
        hit.push(...(slopes || [roof]));
        // A water tank on the roof, standing above the roof surface.
        if (lift > 0 && !seeThrough && look.decor.tank) {
            const c = polygonCentroid(b.polygon);
            if (c) {
                const ring = [];
                for (let i = 0; i < 14; i += 1) {
                    const th = (i / 14) * Math.PI * 2;
                    ring.push(raise({
                        lat: c.lat + (Math.cos(th) * 0.95) / 111320,
                        lng: c.lng + (Math.sin(th) * 0.95) / (111320 * (kLng || 1)),
                    }, 1 + 1.5 / H));
                }
                L.polygon(ring, { color: '#5d636b', weight: 0.8, opacity: 0.9, fillColor: '#9aa3a8', fillOpacity: 1, interactive: false }).addTo(layer);
            }
        }
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
        placeLabel();
    }
    const cranes = layer._cranes;
    const reduce = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (cranes?.length && !reduce && typeof window !== 'undefined') {
        let raf = 0;
        let lastTick = 0;
        const step = (now) => {
            raf = window.requestAnimationFrame(step);
            if (!layer._map || document.hidden || now - lastTick < 48) return;
            lastTick = now;
            const sec = now / 1000;
            for (const update of cranes) update(sec);
        };
        raf = window.requestAnimationFrame(step);
        const stop = () => {
            window.cancelAnimationFrame(raf);
            layer.off('remove', stop);
        };
        layer.on('remove', stop);
        layer._stopCranes = stop;
    }
}

/**
 * A wall's front in 2.5D (Building Studio): on every storey, a window per bay (BAY_M) or an arched
 * opening, and with pillars a strip of the accent colour at every bay. One path each, however many bays.
 * `at(p, f)`: a point raised by a share f of the building's height `H`.
 */
function facade25D(layer, w, look, at, H, levels, kLng) {
    const len = Math.hypot((w.b.lat - w.a.lat) * 111320, (w.b.lng - w.a.lng) * 111320 * (kLng || 1));
    if (len < 2 || !(H > 0)) return;
    const bays = Math.max(1, Math.round(len / BAY_M));
    const storeyH = H / levels;
    const pt = (t, hM) => at({ lat: w.a.lat + (w.b.lat - w.a.lat) * t, lng: w.a.lng + (w.b.lng - w.a.lng) * t }, hM / H);
    const facade = look.facade;
    if (facade === 'none') return;
    const arched = facade === 'arches' || facade === 'balcony';
    const frame = look.windows.frame;
    const openings = [];
    const awnings = [];
    for (let k = 0; k < levels; k += 1) {
        const y = k * storeyH;
        for (let i = 0; i < bays; i += 1) {
            if (arched) {
                const tc = (i + 0.5) / bays;
                const rt = 0.38 / bays;
                const spring = y + storeyH * 0.52;
                const ring = [pt(tc - rt, y + storeyH * 0.12)];
                for (let s = 0; s <= 8; s += 1) {
                    const th = Math.PI - (s / 8) * Math.PI;
                    ring.push(pt(tc + rt * Math.cos(th), spring + storeyH * 0.32 * Math.sin(th)));
                }
                ring.push(pt(tc + rt, y + storeyH * 0.12));
                openings.push([ring]);
            } else {
                const glazed = facade === 'glass';
                const t0 = (i + (glazed ? 0.1 : 0.22)) / bays;
                const t1 = (i + (glazed ? 0.9 : 0.78)) / bays;
                const low = y + storeyH * (glazed ? 0.16 : 0.32);
                const high = y + storeyH * (glazed ? 0.86 : 0.72);
                if (facade === 'louvres') {
                    // A louvre screen: slats across the opening, not glass.
                    const slats = [];
                    for (let s = 0; s < 6; s += 1) {
                        const yy = low + ((high - low) * s) / 6;
                        slats.push([[pt(t0, yy), pt(t1, yy), pt(t1, yy + storeyH * 0.05), pt(t0, yy + storeyH * 0.05)]]);
                    }
                    openings.push(...slats);
                } else {
                    openings.push([[pt(t0, low), pt(t1, low), pt(t1, high), pt(t0, high)]]);
                }
                if (look.windows.awning) {
                    // The concrete eyebrow over the window, standing a little proud of the wall.
                    awnings.push([[pt(t0 - 0.03 / bays, high + storeyH * 0.03), pt(t1 + 0.03 / bays, high + storeyH * 0.03),
                        pt(t1 + 0.03 / bays, high + storeyH * 0.12), pt(t0 - 0.03 / bays, high + storeyH * 0.12)]]);
                }
            }
        }
    }
    // A balcony's walkway rail, on every storey: the open gallery of the old blocks.
    if (facade === 'balcony') {
        const rails = [];
        for (let k = 1; k <= levels; k += 1) {
            const y = k * storeyH - storeyH * 0.06;
            rails.push([pt(0, y), pt(1, y)]);
        }
        L.polyline(rails, { color: '#5d636b', weight: 1.4, opacity: 0.9, interactive: false, lineCap: 'round' }).addTo(layer);
    }
    L.polygon(openings, {
        stroke: Boolean(frame), color: frame || '#000000', weight: frame ? 1.1 : 0, opacity: frame ? 1 : 0,
        fillColor: arched ? '#3b3631' : (frame ? mixHex(frame, '#000000', 0.55) : '#2b3440'), fillOpacity: facade === 'louvres' ? 0.9 : 0.85, interactive: false,
    }).addTo(layer);
    if (awnings.length) {
        L.polygon(awnings, { color: '#b9b5ac', weight: 0.6, opacity: 0.8, fillColor: '#efece4', fillOpacity: 1, interactive: false }).addTo(layer);
    }
    if (facade === 'pillars') {
        const dt = 0.35 / len;
        const strips = [];
        for (let i = 0; i <= bays; i += 1) {
            const t0 = Math.max(0, i / bays - dt);
            const t1 = Math.min(1, i / bays + dt);
            strips.push([[pt(t0, 0), pt(t1, 0), pt(t1, H), pt(t0, H)]]);
        }
        L.polygon(strips, { stroke: false, fillColor: look.walls.accent || '#b9b5ac', fillOpacity: 0.95, interactive: false }).addTo(layer);
    }
    // The department's band along the foot of the wall: the maroon or salmon stripe of the photos.
    if (look.walls.band) {
        L.polygon([[pt(0, 0), pt(1, 0), pt(1, storeyH * 0.22), pt(0, storeyH * 0.22)]], {
            stroke: false, fillColor: look.walls.band, fillOpacity: 0.95, interactive: false,
        }).addTo(layer);
    }
}

/** A canopy over a door in 2.5D: a slab door-high, reaching 1.6 m out and a little past each side. */
function canopy25D(layer, d, color, raise, H, kLng, shape = 'slab') {
    if (!(H > DOOR_HEIGHT_M)) return;
    const RAD = Math.PI / 180;
    const shift = (p, bearing, m) => ({
        lat: p.lat + (Math.cos(bearing * RAD) * m) / 111320,
        lng: p.lng + (Math.sin(bearing * RAD) * m) / (111320 * (kLng || 1)),
    });
    const alongDeg = Math.atan2((d.b.lng - d.a.lng) * (kLng || 1), d.b.lat - d.a.lat) / RAD;
    const a = shift(d.a, alongDeg + 180, 0.7);
    const b = shift(d.b, alongDeg, 0.7);
    const f = (DOOR_HEIGHT_M + 0.45) / H;
    let plan;
    if (shape === 'curved') {
        // Bowed out at the middle: a curved canopy in plan.
        const out = [a, b];
        for (let s = 0; s <= 6; s += 1) {
            const t = 1 - s / 6;
            const p = { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
            out.push(shift(p, d.normalDeg, 1.6 + 0.5 * Math.sin(Math.PI * t)));
        }
        plan = out;
    } else {
        plan = [a, b, shift(b, d.normalDeg, 1.6), shift(a, d.normalDeg, 1.6)];
    }
    L.polygon(plan.map((p) => raise(p, f)), {
        color: mixHex(color, '#000000', 0.35), weight: 0.6, fillColor: color, fillOpacity: 1, interactive: false,
    }).addTo(layer);
}

/**
 * The decorations a department dressed its front with (Building Studio): planter boxes and air-con
 * units beside the door, and flags strung across the front. Drawn on the wall of the main door, the
 * side the map looks at. `shift(p, bearing, m)` moves a point; `raise(p, f)` lifts it by a share of H.
 */
function drawDecor25D(layer, look, d, { raise, H, kLng, shift }) {
    const decor = look.decor;
    if (!decor.planters && !decor.ac && !decor.bunting) return;
    const RAD = Math.PI / 180;
    const alongDeg = Math.atan2((d.b.lng - d.a.lng) * (kLng || 1), d.b.lat - d.a.lat) / RAD;
    const mid = { lat: (d.a.lat + d.b.lat) / 2, lng: (d.a.lng + d.b.lng) / 2 };
    // A rectangle `along` metres sideways of the door, `out` metres in front of the wall, raised `f` up it.
    const quad = (along, out, halfAlong, halfOut, f = 0) => {
        const c0 = shift(shift(mid, alongDeg, along), d.normalDeg, out);
        const side = (m) => shift(c0, alongDeg + 90, m);
        return [
            shift(side(-halfAlong), d.normalDeg, -halfOut), shift(side(halfAlong), d.normalDeg, -halfOut),
            shift(side(halfAlong), d.normalDeg, halfOut), shift(side(-halfAlong), d.normalDeg, halfOut),
        ].map((p) => raise(p, f));
    };
    if (decor.planters) {
        const pots = [];
        const leaves = [];
        for (const along of [-3.4, 3.4]) {
            pots.push([quad(along, 0.9, 0.9, 0.3)]);
            leaves.push([quad(along, 0.9, 0.78, 0.2)]);
        }
        L.polygon(pots, { color: '#8d877c', weight: 0.5, opacity: 0.85, fillColor: '#c9c4b8', fillOpacity: 1, interactive: false }).addTo(layer);
        L.polygon(leaves, { stroke: false, fillColor: '#4f7a3a', fillOpacity: 0.95, interactive: false }).addTo(layer);
    }
    if (decor.ac) {
        // Wall-hung air-con units, halfway up the front.
        const units = [];
        for (const along of [-4.8, 4.8]) units.push([quad(along, 0.32, 0.5, 0.18, 0.5)]);
        L.polygon(units, { color: '#5d636b', weight: 0.6, opacity: 0.9, fillColor: '#dadde0', fillOpacity: 1, interactive: false }).addTo(layer);
    }
    if (decor.bunting) {
        // Flags strung across the front, above the doors.
        const f = Math.min(1, (DOOR_HEIGHT_M + 1.6) / (H || 1));
        const a = shift(mid, alongDeg + 90, -4.2);
        const z = shift(mid, alongDeg + 90, 4.2);
        L.polyline([raise(a, f), raise(z, f)], { color: '#5d636b', weight: 1.1, opacity: 0.85, interactive: false }).addTo(layer);
        const colors = ['#b3262e', '#2f6fb3', '#f2c94c', '#2f9e5f'];
        for (let i = 0; i < 8; i += 1) {
            const t = (i + 0.5) / 8;
            const p = { lat: a.lat + (z.lat - a.lat) * t, lng: a.lng + (z.lng - a.lng) * t };
            L.polygon([
                raise(shift(p, alongDeg + 90, -0.13), f),
                raise(shift(p, alongDeg + 90, 0.13), f),
                raise(shift(p, alongDeg, 0.4), f - 0.02),
            ], { stroke: false, fillColor: colors[i % colors.length], fillOpacity: 0.95, interactive: false }).addTo(layer);
        }
    }
}

/**
 * A sloped or curved roof in 2.5D: from its eave (in the department's outline colour, the shape that is
 * tapped) up to its top, every face shaded by where it faces the sun, far faces first.
 * Returns the shapes to tap (the eave first), or null when the outline cannot take a sloped roof.
 */
function slopedRoof25D(layer, b, look, { raise, H, sun, depth, outline, interactive }) {
    const c = polygonCentroid(b.polygon);
    if (!c || !(H > 0)) return null;
    const local = b.polygon.map((p) => { const [x, y] = toLocalMeters(+p.lat, +p.lng, c.lat, c.lng); return { x, y }; });
    const { rings } = roofLayers(local, look.roof.style);
    if (rings.length < 2) return null;
    const back = (q) => { const p = fromLocalMeters(c.lat, c.lng, q.x, q.y); return { lat: p.latitude, lng: p.longitude }; };
    const at = (q, h) => raise(back(q), (H + h) / H);
    const color = roofColorOf(look);
    const tap = interactive ? { interactive: true, className: 'campus-hit' } : { interactive: false };
    const shapes = [L.polygon(rings[0].pts.map((q) => at(q, rings[0].h)), {
        ...outline, fillColor: mixHex(color, '#000000', 0.3), fillOpacity: 1, ...tap,
    }).addTo(layer)];
    const faces = [];
    // The roof's surface: ribs up each slope for metal, rows across it for tile and shingle.
    const material = look.roof.material;
    const ribs = [];
    const rows = [];
    for (let k = 0; k + 1 < rings.length; k += 1) {
        const A = rings[k];
        const B = rings[k + 1];
        const n = A.pts.length;
        for (let i = 0; i < n; i += 1) {
            const a0 = A.pts[i];
            const a1 = A.pts[(i + 1) % n];
            const b0 = B.pts[i];
            const b1 = B.pts[(i + 1) % n];
            // The rings run counter-clockwise: the side's outward normal is to its right.
            const normalDeg = ((Math.atan2(a1.y - a0.y, -(a1.x - a0.x)) * 180) / Math.PI + 360) % 360;
            const run = Math.hypot(b0.x - a0.x, b0.y - a0.y) || 1;
            const steep = Math.min(1, (B.h - A.h) / run);
            const light = (1 - steep) * roofLight(sun) + steep * wallLight(normalDeg, sun);
            faces.push({
                pts: [at(a0, A.h), at(a1, A.h), at(b1, B.h), at(b0, B.h)],
                far: depth(back({ x: (a0.x + a1.x) / 2, y: (a0.y + a1.y) / 2 })),
                fill: mixHex(mixHex(color, '#000000', 0.45), color, 0.25 + 0.75 * light),
            });
            if (material === 'metal') {
                // Ribs up the slope, about every 0.45 m along the eave.
                for (let t = 0.08; t < 1; t += 0.1) {
                    const p0 = { x: a0.x + (a1.x - a0.x) * t, y: a0.y + (a1.y - a0.y) * t };
                    const p1 = { x: b0.x + (b1.x - b0.x) * t, y: b0.y + (b1.y - b0.y) * t };
                    ribs.push([at(p0, A.h), at(p1, B.h)]);
                }
            } else if (material === 'tile' || material === 'shingle') {
                for (let s = 0.15; s < 1; s += 0.2) {
                    const h = A.h + (B.h - A.h) * s;
                    rows.push([
                        at({ x: a0.x + (b0.x - a0.x) * s, y: a0.y + (b0.y - a0.y) * s }, h),
                        at({ x: a1.x + (b1.x - a1.x) * s, y: a1.y + (b1.y - a1.y) * s }, h),
                    ]);
                }
            }
        }
    }
    faces.sort((f1, f2) => f2.far - f1.far);
    for (const f of faces) {
        shapes.push(L.polygon(f.pts, { color: mixHex(color, '#000000', 0.5), weight: 0.5, opacity: 0.6, fillColor: f.fill, fillOpacity: 1, lineJoin: 'round', ...tap }).addTo(layer));
    }
    const grooves = ribs.length ? ribs : rows;
    if (grooves.length) {
        L.polyline(grooves, {
            color: mixHex(color, '#000000', 0.2), weight: 0.5, opacity: 0.4, interactive: false, lineCap: 'round',
        }).addTo(layer);
    }
    const top = rings[rings.length - 1];
    shapes.push(L.polygon(top.pts.map((q) => at(q, top.h)), {
        color: mixHex(color, '#000000', 0.5), weight: 0.5, opacity: 0.6, fillColor: mixHex(mixHex(color, '#000000', 0.3), color, roofLight(sun)), fillOpacity: 1, ...tap,
    }).addTo(layer));
    return shapes;
}

const SITE = {
    concrete: '#a9a59d',
    concreteEdge: '#6f6a62',
    blocks: { light: ['#8d877c', '#d2ccbf'], dark: ['#3a3833', '#6d6a62'] },
    steel: '#5d636b',
    plank: '#9a7446',
    crane: '#f2b705',
    craneEdge: '#3b2f05',
};

/**
 * A building under construction in 2.5D, like the 3D views: the top storey's floor slab (no roof yet),
 * hollow-block walls going up on the sides facing the viewer (the top storey part way), the concrete
 * columns standing above them, scaffolding in front, a yellow tower crane by the longest near side with
 * its jib over the building, and pallets of blocks on the ground. How far along it is comes from its id.
 * `raise(p, f)`: a point lifted by a share f of the building's full height. Returns the shapes to click.
 */
function drawSite25D(layer, b, { raise, kLng, sun, theme, viewDeg, depth, interactive }) {
    const H = buildingHeightM(b);
    const levels = Math.max(1, Number(b.floors) || Math.round(H / STOREY_M));
    const storeyH = H / levels;
    const rand = seededRandom((Number(b.id) || 1) * 7 + 3);
    const RAD = Math.PI / 180;
    const at = (p, hM) => raise(p, hM / H);
    const move = (p, bearingDeg, m) => ({
        lat: p.lat + (Math.cos(bearingDeg * RAD) * m) / 111320,
        lng: p.lng + (Math.sin(bearingDeg * RAD) * m) / (111320 * (kLng || 1)),
    });
    const along = (w, t) => ({ lat: w.a.lat + (w.b.lat - w.a.lat) * t, lng: w.a.lng + (w.b.lng - w.a.lng) * t });
    const lengthM = (w) => Math.hypot((w.b.lat - w.a.lat) * 111320, (w.b.lng - w.a.lng) * 111320 * (kLng || 1));
    const line = (pts, color, weight, opacity = 1) => L.polyline(pts, { color, weight, opacity, interactive: false, lineCap: 'round', lineJoin: 'round' }).addTo(layer);
    const click = interactive ? { interactive: true, className: 'campus-hit' } : { interactive: false };
    const shapes = [];
    const slabH = (levels - 1) * storeyH;
    const wallTop = slabH + storeyH * (0.3 + rand() * 0.35);

    // The floor of the top storey (the roof is not cast yet), seen through the open frame.
    shapes.push(L.polygon(b.polygon.map((p) => at(p, slabH)), {
        color: SITE.concreteEdge, weight: 0.8, fillColor: theme === 'dark' ? '#55524c' : '#bdb8ae', fillOpacity: 0.95, ...click,
    }).addTo(layer));

    const walls = visibleWalls(b.polygon, viewDeg)
        .sort((w1, w2) => Math.min(depth(w2.a), depth(w2.b)) - Math.min(depth(w1.a), depth(w1.b)));
    const [shade, lit] = SITE.blocks[theme] || SITE.blocks.light;
    for (const w of walls) {
        const len = lengthM(w);
        // Hollow blocks up to this side's height (some sides further behind than others).
        const top = Math.max(0.6, wallTop - (rand() < 0.4 ? rand() * storeyH * 0.6 : 0));
        const fill = mixHex(shade, lit, wallLight(w.normalDeg, sun));
        shapes.push(L.polygon([[w.a.lat, w.a.lng], [w.b.lat, w.b.lng], at(w.b, top), at(w.a, top)], {
            color: mixHex(fill, '#000000', 0.35), weight: 0.6, fillColor: fill, fillOpacity: 0.97, lineJoin: 'round', ...click,
        }).addTo(layer));
        // Block courses.
        for (let y = 0.8; y < top - 0.1; y += 0.8) line([at(w.a, y), at(w.b, y)], mixHex(fill, '#000000', 0.4), 0.7, 0.6);
        // Floor slabs and columns, the columns standing bare above the walls.
        for (let k = 1; k < levels; k += 1) line([at(w.a, k * storeyH), at(w.b, k * storeyH)], SITE.concrete, 2.2);
        const bays = Math.max(1, Math.round(len / 4.5));
        for (let i = 0; i <= bays; i += 1) {
            const p = along(w, i / bays);
            line([at(p, 0), at(p, H + 0.6)], SITE.concreteEdge, 3.2);
            line([at(p, 0), at(p, H + 0.6)], SITE.concrete, 2);
        }
        // Scaffolding a metre out from the wall: standards, braces and a plank every 2 m up.
        const scaffTop = Math.min(H + 1, top + 1.5);
        const o = { a: move(w.a, w.normalDeg, 1), b: move(w.b, w.normalDeg, 1) };
        const sBays = Math.max(1, Math.round(len / 2.2));
        for (let i = 0; i <= sBays; i += 1) {
            const p = along(o, i / sBays);
            line([at(p, 0), at(p, scaffTop)], SITE.steel, 1, 0.9);
        }
        for (let i = 0; i < sBays; i += 1) {
            const zig = [];
            for (let y = 0, k = i; y <= scaffTop + 0.01; y += 2, k += 1) zig.push(at(along(o, (i + (k % 2)) / sBays), Math.min(y, scaffTop)));
            line(zig, SITE.steel, 0.6, 0.7);
        }
        for (let y = 2; y <= scaffTop + 0.01; y += 2) {
            line([at(o.a, y), at(o.b, y)], SITE.steel, 0.8, 0.9);
            line([at(along(o, 0), y + 0.05), at(along(o, 1), y + 0.05)], SITE.plank, 1.3, 0.8);
        }
    }

    // Pallets of blocks: little 2.5D boxes.
    const box = (c, h, from = 0) => {
        const ring = [move(move(c, 90, -0.6), 0, -0.5), move(move(c, 90, 0.6), 0, -0.5), move(move(c, 90, 0.6), 0, 0.5), move(move(c, 90, -0.6), 0, 0.5)];
        for (const f of visibleWalls(ring, viewDeg)) {
            L.polygon([at(f.a, from), at(f.b, from), at(f.b, from + h), at(f.a, from + h)], { color: '#55524c', weight: 0.5, fillColor: mixHex(shade, lit, wallLight(f.normalDeg, sun)), fillOpacity: 1, interactive: false }).addTo(layer);
        }
        L.polygon(ring.map((q) => at(q, from + h)), { color: '#55524c', weight: 0.5, fillColor: lit, fillOpacity: 1, interactive: false }).addTo(layer);
    };

    const style = b.construction_style || 'crane';
    const withCrane = style !== 'workers';
    const withWorkers = style === 'workers' || style === 'workers_crane';

    // The tower crane, standing out from the longest side facing the viewer, its jib over the building.
    const front = walls.reduce((best, w) => (!best || lengthM(w) > lengthM(best) ? w : best), null);
    if (!front) return shapes;
    const base = move(along(front, 0.25 + rand() * 0.5), front.normalDeg, 5);
    const inward = (front.normalDeg + 180 + (rand() - 0.5) * 60) % 360;
    const mastH = H + 9;
    const across = (front.normalDeg + 90) % 360;
    const yellow = (pts, weight = 1.6) => { line(pts, SITE.craneEdge, weight + 1.2, 0.8); line(pts, SITE.crane, weight); };
    for (let i = 0; i < 3; i += 1) box(move(move(base, front.normalDeg, 2.4), across, -3 - i * 1.5), 0.8);

    if (withWorkers) {
        const mkLine = (color, weight, opacity = 1) => L.polyline([], {
            color, weight, opacity, interactive: false, lineCap: 'round', lineJoin: 'round',
        }).addTo(layer);
        const mkDot = (radius, fillColor, color = '#18181b', weight = 0.7) => L.circleMarker([0, 0], {
            radius, color, weight, fillColor, fillOpacity: 1, interactive: false,
        }).addTo(layer);

        const workers25D = [];
        const addWorker25D = ({ vest = '#f97316', helmet = '#facc15', shirt = '#334155', action = 'walk', ...anim }) => {
            const legL = mkLine('#1e293b', 2.4);
            const legR = mkLine('#1e293b', 2.4);
            const torso = mkLine(vest, 4.6);
            const stripe = mkLine('#e2e8f0', 4.6, 0.85);
            const armL = mkLine(shirt, 2.0);
            const armR = mkLine(shirt, 2.0);
            const head = mkDot(2.3, '#d2a27c', '#1e293b', 0.5);
            const hat = mkDot(2.9, helmet, '#3b2f05', 0.7);
            const prop = action === 'carry' ? mkLine('#b3ada2', 4.8)
                : action === 'lunch' ? { cup: mkDot(1.7, '#f8fafc', '#3f2312', 0.8), bread: mkDot(1.8, '#d97706', '#78350f', 0.7) }
                    : null;
            workers25D.push({
                action, phase: rand() * Math.PI * 2,
                legL, legR, torso, stripe, armL, armR, head, hat, prop, ...anim,
            });
        };

        const cPt = { lat: b.polygon.reduce((s, p) => s + +p.lat, 0) / b.polygon.length, lng: b.polygon.reduce((s, p) => s + +p.lng, 0) / b.polygon.length };
        const w0 = walls[0];
        const w1 = walls[Math.min(1, walls.length - 1)];
        const midPt = (p, q, k) => ({ lat: p.lat + (q.lat - p.lat) * k, lng: p.lng + (q.lng - p.lng) * k });

        // 1 & 2. Walking in other parts of the building (upper open slab).
        addWorker25D({ action: 'walk', a: midPt(cPt, w0.a, 0.45), b: midPt(cPt, w0.b, 0.45), hBase: slabH, speed: 0.4 });
        addWorker25D({ action: 'walk', vest: '#eab308', a: midPt(cPt, w1.a, 0.4), b: midPt(cPt, w1.b, 0.4), hBase: slabH, speed: 0.34 });
        // 3 & 4. Walking along different ground sides.
        addWorker25D({ action: 'walk', a: move(along(front, 0.12), front.normalDeg, 2.1), b: move(along(front, 0.52), front.normalDeg, 2.1), hBase: 0, speed: 0.45 });
        addWorker25D({ action: 'walk', vest: '#eab308', a: move(along(w1, 0.18), w1.normalDeg, 2.2), b: move(along(w1, 0.82), w1.normalDeg, 2.2), hBase: 0, speed: 0.38 });
        // 5 & 6. Carrying hollow blocks from pallets to the wall.
        addWorker25D({ action: 'carry', helmet: '#f97316', a: move(move(base, front.normalDeg, 1.5), across, -2.5), b: move(along(front, 0.48), front.normalDeg, 1.7), hBase: 0, speed: 0.32 });
        addWorker25D({ action: 'carry', vest: '#eab308', a: move(move(base, front.normalDeg, 2.6), across, -4.0), b: move(along(front, 0.28), front.normalDeg, 1.7), hBase: 0, speed: 0.28 });
        // 7. Thinking (white-helmet foreman).
        addWorker25D({ action: 'think', vest: '#eab308', helmet: '#f8fafc', shirt: '#1e3a8a', pos: move(move(base, front.normalDeg, 0.8), across, -1.2), bearing: (front.normalDeg + 180) % 360, hBase: 0 });
        // 8. Looking up at the building.
        addWorker25D({ action: 'inspect', pos: move(along(front, 0.72), front.normalDeg, 3.6), bearing: (front.normalDeg + 180) % 360, hBase: 0 });
        // 9. Drinking coffee & eating bread/lunch beside the pallets.
        addWorker25D({ action: 'lunch', shirt: '#475569', pos: move(move(base, front.normalDeg, 1.8), across, -4.6), bearing: (front.normalDeg + 210) % 360, hBase: 0 });

        const updateWorkers = (timeSec) => {
            for (const w of workers25D) {
                const t = timeSec + w.phase;
                let pos = w.pos;
                let bearing = w.bearing || 0;
                let stride = 0;
                if (w.action === 'walk' || w.action === 'carry') {
                    const mix = (Math.sin(t * w.speed) + 1) * 0.5;
                    const dir = Math.cos(t * w.speed) >= 0 ? 1 : -1;
                    pos = { lat: w.a.lat + (w.b.lat - w.a.lat) * mix, lng: w.a.lng + (w.b.lng - w.a.lng) * mix };
                    const dLat = (w.b.lat - w.a.lat) * dir * 111320;
                    const dLng = (w.b.lng - w.a.lng) * dir * 111320 * (kLng || 1);
                    bearing = (Math.atan2(dLng, dLat) * 180) / Math.PI;
                    stride = Math.sin(t * 5.2);
                }
                const right = (bearing + 90) % 360;
                const bob = w.action === 'walk' || w.action === 'carry' ? Math.abs(stride) * 0.05 : 0;
                const hipH = w.hBase + 0.86 + bob;
                const shH = w.hBase + 1.42 + bob;
                const fL = move(move(pos, right, -0.11), bearing, stride * 0.28);
                const fR = move(move(pos, right, 0.11), bearing, -stride * 0.28);
                const hL = move(pos, right, -0.11);
                const hR = move(pos, right, 0.11);
                w.legL.setLatLngs([at(fL, w.hBase), at(hL, hipH)]);
                w.legR.setLatLngs([at(fR, w.hBase), at(hR, hipH)]);
                w.torso.setLatLngs([at(pos, hipH), at(pos, shH)]);
                w.stripe.setLatLngs([at(pos, hipH + 0.22), at(pos, hipH + 0.34)]);

                const shL = move(pos, right, -0.24);
                const shR = move(pos, right, 0.24);
                let handL = move(move(pos, right, -0.26), bearing, -stride * 0.22);
                let handR = move(move(pos, right, 0.26), bearing, stride * 0.22);
                let handLH = w.hBase + 0.92;
                let handRH = w.hBase + 0.92;
                let headOff = 0;

                if (w.action === 'carry') {
                    handL = move(move(pos, right, -0.18), bearing, 0.28);
                    handR = move(move(pos, right, 0.18), bearing, 0.28);
                    handLH = w.hBase + 1.12 + bob;
                    handRH = w.hBase + 1.12 + bob;
                    const blkL = move(move(pos, right, -0.2), bearing, 0.34);
                    const blkR = move(move(pos, right, 0.2), bearing, 0.34);
                    w.prop.setLatLngs([at(blkL, w.hBase + 1.16 + bob), at(blkR, w.hBase + 1.16 + bob)]);
                } else if (w.action === 'think') {
                    handR = move(pos, bearing, 0.14);
                    handRH = w.hBase + 1.5 + Math.sin(t * 1.4) * 0.03;
                    handL = move(move(pos, right, -0.12), bearing, 0.12);
                    handLH = w.hBase + 1.05;
                    headOff = Math.sin(t * 0.8) * 0.04;
                } else if (w.action === 'inspect') {
                    handR = move(move(pos, right, 0.15), bearing, 0.24);
                    handRH = w.hBase + 1.56 + Math.sin(t * 0.9) * 0.05;
                    headOff = Math.sin(t * 0.6) * 0.06;
                } else if (w.action === 'lunch') {
                    const sip = Math.max(0, Math.sin(t * 1.4));
                    const bite = Math.max(0, Math.sin(t * 1.4 + Math.PI));
                    handR = move(move(pos, right, 0.16 - sip * 0.1), bearing, 0.18);
                    handRH = w.hBase + 1.05 + sip * 0.45;
                    handL = move(move(pos, right, -0.16 + bite * 0.1), bearing, 0.18);
                    handLH = w.hBase + 1.05 + bite * 0.45;
                    w.prop.cup.setLatLng(at(handR, handRH + 0.05));
                    w.prop.bread.setLatLng(at(handL, handLH + 0.04));
                }
                w.armL.setLatLngs([at(shL, shH), at(handL, handLH)]);
                w.armR.setLatLngs([at(shR, shH), at(handR, handRH)]);
                const headPos = move(pos, right, headOff);
                w.head.setLatLng(at(headPos, w.hBase + 1.56 + bob));
                w.hat.setLatLng(at(headPos, w.hBase + 1.66 + bob));
            }
        };
        updateWorkers(0);
        if (Array.isArray(layer._cranes)) layer._cranes.push(updateWorkers);
    }
    if (!withCrane) return shapes;

    // Concrete foundation pad + base anchor struts.
    const padRing = [
        move(move(base, across, -1.7), front.normalDeg, -1.7),
        move(move(base, across, 1.7), front.normalDeg, -1.7),
        move(move(base, across, 1.7), front.normalDeg, 1.7),
        move(move(base, across, -1.7), front.normalDeg, 1.7),
    ];
    for (const f of visibleWalls(padRing, viewDeg)) {
        L.polygon([at(f.a, 0), at(f.b, 0), at(f.b, 0.55), at(f.a, 0.55)], {
            color: '#55524c', weight: 0.6, fillColor: mixHex('#8b867d', SITE.concrete, wallLight(f.normalDeg, sun)), fillOpacity: 1, interactive: false,
        }).addTo(layer);
    }
    L.polygon(padRing.map((q) => at(q, 0.55)), {
        color: '#55524c', weight: 0.6, fillColor: SITE.concrete, fillOpacity: 1, interactive: false,
    }).addTo(layer);

    // 4-cornered mast with horizontal cross-ties, X-bracing, and base stabilizer struts.
    const mW = 0.8;
    const mFL = move(move(base, across, -mW), front.normalDeg, mW);
    const mFR = move(move(base, across, mW), front.normalDeg, mW);
    const mBL = move(move(base, across, -mW), front.normalDeg, -mW);
    const mBR = move(move(base, across, mW), front.normalDeg, -mW);
    for (const corner of [mFL, mFR, mBL, mBR]) {
        yellow([at(corner, 0.55), at(corner, mastH)], 1.5);
    }
    yellow([at(move(move(base, across, -1.45), front.normalDeg, 1.45), 0.55), at(mFL, 2.2)], 1.0);
    yellow([at(move(move(base, across, 1.45), front.normalDeg, 1.45), 0.55), at(mFR, 2.2)], 1.0);
    for (let y = 0.6; y < mastH - 0.1; y += 1.6) {
        const yNext = Math.min(mastH, y + 1.6);
        yellow([at(mFL, y), at(mFR, y), at(mBR, y), at(mBL, y), at(mFL, y)], 0.85);
        yellow([at(mFL, y), at(mFR, yNext)], 0.75);
        yellow([at(mFR, y), at(mFL, yNext)], 0.75);
        yellow([at(mBL, y), at(mBR, yNext)], 0.65);
    }

    // Dark steel slewing ring / turntable collar at mast top.
    const ringPts = [
        move(move(base, across, -1.05), front.normalDeg, -1.05),
        move(move(base, across, 1.05), front.normalDeg, -1.05),
        move(move(base, across, 1.05), front.normalDeg, 1.05),
        move(move(base, across, -1.05), front.normalDeg, 1.05),
    ];
    L.polygon(ringPts.map((q) => at(q, mastH + 0.15)), {
        color: '#1b1d22', weight: 0.8, fillColor: '#2c3038', fillOpacity: 1, interactive: false,
    }).addTo(layer);

    // Jib over the building and the counter-jib behind, with the counterweight and the ties to the head.
    const extent = Math.max(...b.polygon.map((q) => Math.hypot((q.lat - base.lat) * 111320, (q.lng - base.lng) * 111320 * (kLng || 1))));
    const jibL = Math.min(45, Math.max(14, extent * 0.85));
    const backL = Math.max(6.5, jibL * 0.32);

    // Moving upper assembly (cat-head, jib, counter-jib, cab, counterweight, trolley, dual cables, hook block, hanging pallet) updated in place via setLatLngs.
    const mkLine = (color, weight, opacity = 1) => L.polyline([], { color, weight, opacity, interactive: false, lineCap: 'round', lineJoin: 'round' }).addTo(layer);
    const mkYellow = (weight = 1.6) => [mkLine(SITE.craneEdge, weight + 1.2, 0.8), mkLine(SITE.crane, weight)];
    const catHeadL = mkYellow(1.35);
    const catHeadR = mkYellow(1.35);
    const jibWebBack = mkYellow(0.85);
    const jibWebFront = mkYellow(0.95);
    const counterWeb = mkYellow(0.9);
    const boomFrontPair = mkYellow(1.9);
    const boomBackPair = mkYellow(1.65);
    const topBoomPair = mkYellow(1.6);
    const tieFront1 = mkYellow(0.95);
    const tieFront2 = mkYellow(0.95);
    const tieBack1 = mkYellow(0.95);
    const tieBack2 = mkYellow(0.95);
    const beaconGlow = L.circleMarker([0, 0], {
        radius: 3.2, color: '#fca5a5', weight: 1, fillColor: '#ef4444', fillOpacity: 0.95, interactive: false,
    }).addTo(layer);
    const cabBody = L.polygon([], {
        color: '#3f3d38', weight: 0.7, fillColor: '#e9e4d6', fillOpacity: 1, interactive: false,
    }).addTo(layer);
    const cabGlass = L.polygon([], {
        color: '#162836', weight: 0.5, fillColor: '#254a63', fillOpacity: 0.95, interactive: false,
    }).addTo(layer);
    const winchPoly = L.polygon([], {
        color: '#1b1d22', weight: 0.6, fillColor: '#2f343d', fillOpacity: 1, interactive: false,
    }).addTo(layer);
    const weightFront = L.polygon([], {
        color: '#55524c', weight: 0.6, fillColor: mixHex('#7b766d', SITE.concrete, 0.55), fillOpacity: 1, interactive: false,
    }).addTo(layer);
    const weightTop = L.polygon([], {
        color: '#55524c', weight: 0.6, fillColor: SITE.concrete, fillOpacity: 1, interactive: false,
    }).addTo(layer);
    const trolleyBody = L.polygon([], {
        color: '#1b1d22', weight: 0.7, fillColor: '#2c3038', fillOpacity: 1, interactive: false,
    }).addTo(layer);
    const trolleyFrame = L.polygon([], {
        color: SITE.craneEdge, weight: 0.7, fillColor: SITE.crane, fillOpacity: 1, interactive: false,
    }).addTo(layer);
    const cableLine1 = mkLine('#222226', 0.9, 1);
    const cableLine2 = mkLine('#222226', 0.9, 1);
    const palletSides = [0, 1].map(() => L.polygon([], {
        color: '#4a3820', weight: 0.5, fillColor: '#a67f49', fillOpacity: 1, interactive: false,
    }).addTo(layer));
    const loadSides = [0, 1].map(() => L.polygon([], {
        color: '#55524c', weight: 0.55, fillColor: shade, fillOpacity: 1, interactive: false,
    }).addTo(layer));
    const loadTop = L.polygon([], {
        color: '#55524c', weight: 0.55, fillColor: lit, fillOpacity: 1, interactive: false,
    }).addTo(layer);
    const loadSeams = mkLine('#55524c', 0.55, 0.55);
    const slingLines = [mkLine('#222226', 0.65, 0.9), mkLine('#222226', 0.65, 0.9)];
    const hookBlockPoly = L.polygon([], {
        color: '#1b1d22', weight: 0.7, fillColor: SITE.crane, fillOpacity: 1, interactive: false,
    }).addTo(layer);

    const phase = rand() * Math.PI * 2;
    const hookMin = Math.max(1.8, H * 0.3);
    const hookMax = Math.max(2.6, Math.min(mastH - 2.8, H * 0.92));

    const updateCrane = (timeSec) => {
        const t = timeSec + phase;
        const dir = inward + Math.sin(t * 0.25) * 28;
        const perp = (dir + 90) % 360;
        const jibY = mastH + 0.35;
        const headY = mastH + 5.2;
        const jibW = 0.6;
        const jibH0 = 1.55;
        const jibHTip = 0.92;
        const jibHBack = 0.78;
        const tip = move(base, dir, jibL);
        const tail = move(base, dir, -backL);
        const headPt = at(base, headY);

        for (const l of catHeadL) l.setLatLngs([at(move(base, perp, -jibW), jibY), headPt, at(move(base, dir, 0.8), jibY)]);
        for (const l of catHeadR) l.setLatLngs([at(move(base, perp, jibW), jibY), headPt, at(move(base, dir, -0.8), jibY)]);
        beaconGlow.setLatLng(headPt);

        // Dense 3D triangular truss along the main jib (front web, back web, bottom cross-ties, and tip cap).
        const webBackSegs = [];
        const webFrontSegs = [];
        const jibBay = 1.15;
        for (let x = 0; x < jibL - 0.05; x += jibBay) {
            const x2 = Math.min(jibL, x + jibBay);
            const xm = (x + x2) * 0.5;
            const h1 = jibH0 - ((jibH0 - jibHTip) * x) / jibL;
            const hm = jibH0 - ((jibH0 - jibHTip) * xm) / jibL;
            const p1 = move(base, dir, x);
            const p2 = move(base, dir, x2);
            const pm = move(base, dir, xm);
            const b1L = at(move(p1, perp, -jibW), jibY);
            const b1R = at(move(p1, perp, jibW), jibY);
            const b2L = at(move(p2, perp, -jibW), jibY);
            const b2R = at(move(p2, perp, jibW), jibY);
            const t1 = at(p1, jibY + h1);
            const tm = at(pm, jibY + hm);
            // Back face diagonals + bottom cross-tie + diagonal floor brace.
            webBackSegs.push([b1L, tm], [tm, b2L], [b1L, b1R], [b1L, b2R]);
            // Front face diagonals + vertical post + top-to-bottom rib.
            webFrontSegs.push([b1R, t1], [b1R, tm], [tm, b2R]);
        }
        // Sturdy jib tip triangular frame.
        const tipL = at(move(tip, perp, -jibW), jibY);
        const tipR = at(move(tip, perp, jibW), jibY);
        const tipT = at(tip, jibY + jibHTip);
        webFrontSegs.push([tipL, tipR], [tipL, tipT], [tipR, tipT]);
        for (const l of jibWebBack) l.setLatLngs(webBackSegs);
        for (const l of jibWebFront) l.setLatLngs(webFrontSegs);

        // Dense counter-jib truss.
        const cSegs = [];
        const cBay = 1.15;
        for (let x = 0; x < backL - 0.05; x += cBay) {
            const x2 = Math.min(backL, x + cBay);
            const xm = (x + x2) * 0.5;
            const h1 = jibH0 - ((jibH0 - jibHBack) * x) / backL;
            const hm = jibH0 - ((jibH0 - jibHBack) * xm) / backL;
            const p1 = move(base, dir, -x);
            const p2 = move(base, dir, -x2);
            const pm = move(base, dir, -xm);
            const b1L = at(move(p1, perp, -jibW), jibY);
            const b1R = at(move(p1, perp, jibW), jibY);
            const b2L = at(move(p2, perp, -jibW), jibY);
            const b2R = at(move(p2, perp, jibW), jibY);
            const t1 = at(p1, jibY + h1);
            const tm = at(pm, jibY + hm);
            cSegs.push([b1L, b1R], [b1L, tm], [tm, b2L], [b1R, t1], [b1R, tm], [tm, b2R]);
        }
        cSegs.push([at(move(tail, perp, -jibW), jibY), at(move(tail, perp, jibW), jibY)]);
        for (const l of counterWeb) l.setLatLngs(cSegs);

        for (const l of boomFrontPair) l.setLatLngs([at(move(tail, perp, jibW), jibY), at(move(tip, perp, jibW), jibY)]);
        for (const l of boomBackPair) l.setLatLngs([at(move(tail, perp, -jibW), jibY), at(move(tip, perp, -jibW), jibY)]);
        for (const l of topBoomPair) l.setLatLngs([at(tail, jibY + jibHBack), at(base, jibY + jibH0), at(tip, jibY + jibHTip)]);

        const f1 = jibL * 0.42;
        const f2 = jibL * 0.78;
        const b1 = backL * 0.55;
        for (const l of tieFront1) l.setLatLngs([headPt, at(move(base, dir, f1), jibY + jibH0 - ((jibH0 - jibHTip) * f1) / jibL)]);
        for (const l of tieFront2) l.setLatLngs([headPt, at(move(base, dir, f2), jibY + jibH0 - ((jibH0 - jibHTip) * f2) / jibL)]);
        for (const l of tieBack1) l.setLatLngs([headPt, at(move(base, dir, -b1), jibY + jibH0 - ((jibH0 - jibHBack) * b1) / backL)]);
        for (const l of tieBack2) l.setLatLngs([headPt, at(tail, jibY + jibHBack)]);

        // Operator cab beside the mast.
        const cabCenter = move(move(base, dir, 0.7), perp, 1.25);
        const cA = move(move(cabCenter, dir, -0.7), perp, -0.55);
        const cB = move(move(cabCenter, dir, 0.7), perp, -0.55);
        const cC = move(move(cabCenter, dir, 0.7), perp, 0.55);
        const cD = move(move(cabCenter, dir, -0.7), perp, 0.55);
        cabBody.setLatLngs([at(cA, mastH - 1.2), at(cB, mastH - 1.2), at(cC, mastH + 0.3), at(cD, mastH + 0.3)]);
        cabGlass.setLatLngs([at(cA, mastH - 0.55), at(cB, mastH - 0.55), at(cC, mastH + 0.12), at(cD, mastH + 0.12)]);

        // Winch housing on counter-jib.
        const winchC = move(base, dir, -2.0);
        winchPoly.setLatLngs([
            at(move(move(winchC, dir, -0.8), perp, -0.5), jibY + 0.05),
            at(move(move(winchC, dir, 0.8), perp, -0.5), jibY + 0.05),
            at(move(move(winchC, dir, 0.8), perp, 0.5), jibY + 0.95),
            at(move(move(winchC, dir, -0.8), perp, 0.5), jibY + 0.95),
        ]);

        // 2.5D concrete counterweight block.
        const wPos = move(base, dir, -backL + 1.3);
        const wFL = move(move(wPos, dir, 0.95), perp, -0.7);
        const wFR = move(move(wPos, dir, 0.95), perp, 0.7);
        const wBL = move(move(wPos, dir, -0.95), perp, -0.7);
        const wBR = move(move(wPos, dir, -0.95), perp, 0.7);
        weightFront.setLatLngs([at(wFL, jibY - 1.35), at(wFR, jibY - 1.35), at(wFR, jibY + 0.15), at(wFL, jibY + 0.15)]);
        weightTop.setLatLngs([at(wFL, jibY + 0.15), at(wFR, jibY + 0.15), at(wBR, jibY + 0.15), at(wBL, jibY + 0.15)]);

        const reach = jibL * (0.42 + 0.44 * (0.5 + 0.5 * Math.sin(t * 0.35 + 1.1)));
        const hook = move(base, dir, reach);
        const hy = hookMin + (hookMax - hookMin) * (0.5 + 0.5 * Math.sin(t * 0.5 + 2.3));

        // Compact steel trolley carriage riding under the jib chords + dual hoist cables + hook block + slings.
        const tB0 = move(hook, dir, -0.45);
        const tB1 = move(hook, dir, 0.45);
        trolleyBody.setLatLngs([
            at(move(tB0, perp, -0.48), jibY - 0.32),
            at(move(tB1, perp, -0.48), jibY - 0.32),
            at(move(tB1, perp, 0.48), jibY - 0.02),
            at(move(tB0, perp, 0.48), jibY - 0.02),
        ]);
        trolleyFrame.setLatLngs([
            at(move(tB0, perp, jibW), jibY - 0.24),
            at(move(tB1, perp, jibW), jibY - 0.24),
            at(move(tB1, perp, jibW), jibY + 0.06),
            at(move(tB0, perp, jibW), jibY + 0.06),
        ]);
        const c1 = move(hook, perp, -0.1);
        const c2 = move(hook, perp, 0.1);
        cableLine1.setLatLngs([at(c1, jibY - 0.28), at(c1, hy + 1.45)]);
        cableLine2.setLatLngs([at(c2, jibY - 0.28), at(c2, hy + 1.45)]);
        hookBlockPoly.setLatLngs([
            at(move(hook, perp, -0.22), hy + 1.12),
            at(move(hook, perp, 0.22), hy + 1.12),
            at(move(hook, perp, 0.22), hy + 1.48),
            at(move(hook, perp, -0.22), hy + 1.48),
        ]);

        const pRing = [
            move(move(hook, dir, -0.6), perp, -0.5),
            move(move(hook, dir, 0.6), perp, -0.5),
            move(move(hook, dir, 0.6), perp, 0.5),
            move(move(hook, dir, -0.6), perp, 0.5),
        ];
        const pWalls = visibleWalls(pRing, viewDeg);
        const seamSegs = [];
        for (let i = 0; i < 2; i += 1) {
            const f = pWalls[i];
            if (f) {
                const kLight = wallLight(f.normalDeg, sun);
                palletSides[i].setLatLngs([at(f.a, hy), at(f.b, hy), at(f.b, hy + 0.14), at(f.a, hy + 0.14)]);
                palletSides[i].setStyle({ fillColor: mixHex('#856336', '#c2995b', kLight) });
                loadSides[i].setLatLngs([at(f.a, hy + 0.14), at(f.b, hy + 0.14), at(f.b, hy + 0.88), at(f.a, hy + 0.88)]);
                loadSides[i].setStyle({ fillColor: mixHex(shade, lit, kLight) });
                const mid = { lat: (f.a.lat + f.b.lat) * 0.5, lng: (f.a.lng + f.b.lng) * 0.5 };
                seamSegs.push([at(f.a, hy + 0.51), at(f.b, hy + 0.51)], [at(mid, hy + 0.14), at(mid, hy + 0.88)]);
            } else {
                palletSides[i].setLatLngs([]);
                loadSides[i].setLatLngs([]);
            }
        }
        seamSegs.push(
            [at(move(hook, dir, -0.6), hy + 0.88), at(move(hook, dir, 0.6), hy + 0.88)],
            [at(move(hook, perp, -0.5), hy + 0.88), at(move(hook, perp, 0.5), hy + 0.88)],
        );
        loadSeams.setLatLngs(seamSegs);
        loadTop.setLatLngs(pRing.map((q) => at(q, hy + 0.88)));
        const hookTipPt = at(hook, hy + 1.12);
        slingLines[0].setLatLngs([at(pRing[0], hy + 0.88), hookTipPt, at(pRing[2], hy + 0.88)]);
        slingLines[1].setLatLngs([at(pRing[1], hy + 0.88), hookTipPt, at(pRing[3], hy + 0.88)]);
    };
    updateCrane(0);
    if (Array.isArray(layer._cranes)) layer._cranes.push(updateCrane);
    return shapes;
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
function doorway(layer, d, doorLift, { behind = false, viewDeg = 0, kLng = 1, style = 'glass', color = null } = {}) {
    // Glass, timber or sliding glass doors, in the department's own door colour (Building Studio).
    const leaf = behind ? '#22c55e' : (color || (style === 'wood' ? '#6b4a2f' : style === 'sliding' ? '#26404f' : '#2a2420'));
    const vN = Math.cos(viewDeg * Math.PI / 180);
    const vE = Math.sin(viewDeg * Math.PI / 180);
    const up = (p) => [p.lat + doorLift * vN, p.lng + (doorLift * vE) / (kLng || 1)];
    const a = [d.a.lat, d.a.lng];
    const b = [d.b.lat, d.b.lng];
    L.polygon([a, b, up(d.b), up(d.a)], {
        stroke: false, fillColor: leaf, fillOpacity: behind ? 0.35 : 0.92, interactive: false,
    }).addTo(layer);
    if (!behind) {
        // The leaves: a stile down the middle, and a pair of panels on a timber door.
        const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        const midUp = [(up(d.a)[0] + up(d.b)[0]) / 2, (up(d.a)[1] + up(d.b)[1]) / 2];
        L.polyline([mid, midUp], { color: 'rgba(255, 255, 255, 0.9)', weight: 1.6, opacity: 0.95, interactive: false, lineCap: 'round' }).addTo(layer);
        if (style === 'wood') {
            for (const t of [0.3, 0.7]) {
                const p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
                const q = [up(d.a)[0] + (up(d.b)[0] - up(d.a)[0]) * t, up(d.a)[1] + (up(d.b)[1] - up(d.a)[1]) * t];
                L.polyline([p, q], { color: 'rgba(0, 0, 0, 0.35)', weight: 1.2, opacity: 0.8, interactive: false }).addTo(layer);
            }
        }
    }
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
 *   walls: a footbridge's staircase, as built: a solid concrete body under each flight and a parapet
 *          along both its sides (the far one behind the steps, the near one in front)
 */
export function drawStairs25D(layer, link, a, b, liftOf, { muted = false, ghost = false, walls = false } = {}) {
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
    // Each flight's two sides: [from, to] corner points and the heights there; north side first.
    const sides = [];
    if (walls) {
        for (const s of plan.segments) {
            if (s.kind !== 'flight') continue;
            const r = ((s.yawDeg + 90) * Math.PI) / 180;
            for (const k of [-1, 1]) {
                const off = [Math.sin(r) * k * (plan.widthM / 2), Math.cos(r) * k * (plan.widthM / 2)];
                sides.push({ far: off[1] > 0, a: [s.from.e + off[0], s.from.n + off[1]], b: [s.to.e + off[0], s.to.n + off[1]], ua: s.from.u, ub: s.to.u });
            }
        }
    }
    // A parapet's top, RAIL_M above the steps: lifted at the stairs' own scale, past the top floor's plate.
    const perMetre = plan.rise > 0 ? (l1 - l0) / plan.rise : 0;
    const railLL = ([e, n], u) => {
        const p = fromLocalMeters(bottom.latitude, bottom.longitude, e, n);
        return [p.latitude + l0 + (u + RAIL_M) * perMetre, p.longitude];
    };
    const wallStyle = { stroke: true, color: FOOTBRIDGE.edge, weight: 0.6, opacity: alpha, fillColor: FOOTBRIDGE.concrete, fillOpacity: alpha, interactive: false };
    const parapet = (w) => L.polygon([toLL(w.a, w.ua), toLL(w.b, w.ub), railLL(w.b, w.ub), railLL(w.a, w.ua)], wallStyle).addTo(layer);
    // Behind the steps: the far parapets, and the near sides' solid body from the ground up to the steps.
    sides.filter((w) => w.far).forEach(parapet);
    sides.filter((w) => !w.far).forEach((w) => L.polygon([toLL(w.a, 0), toLL(w.b, 0), toLL(w.b, w.ub), toLL(w.a, w.ua)], { ...wallStyle, fillColor: mixHex(FOOTBRIDGE.concrete, '#000000', 0.12) }).addTo(layer));
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
    // In front of the steps: the near parapets.
    sides.filter((w) => !w.far).forEach(parapet);
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
/** A raised deck drawn like the campus footbridge (RouteModel3D's colours): concrete deck, cream concrete
 * pillars and parapets, a dark edge band with light diagonal stripes. */
const FOOTBRIDGE = { deck: '#bdb6a6', concrete: '#e6dabd', edge: '#8a8170', band: '#26262a', stripe: '#ece6d6' };

/**
 * Draw every bridge into `layer` (cleared first): the deck in teal (raised: as the real footbridge) and a label chip such as
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
                L.polyline([[p.lat, p.lng], up(p, under)], { color: b.closed ? '#9ca3af' : FOOTBRIDGE.concrete, weight: 5, opacity: 0.95, lineCap: 'butt', interactive: false }).addTo(layer);
            }
            // Staircases from the ground up to this deck, under the see-through deck as in 3D.
            const onDeck = (n) => n && n.building_id == null && floorOf(n) === Number(b.deck_floor)
                && pointInPolygon(+n.latitude, +n.longitude, b.polygon);
            for (const l of links || []) {
                const a = nodeById.get(l.node_a_id);
                const z = nodeById.get(l.node_b_id);
                if (!a || !z || floorOf(a) === floorOf(z) || !(onDeck(a) || onDeck(z))) continue;
                drawStairs25D(layer, l, a, z, (f) => (f > 0 ? lift : 0), { muted: Boolean(b.closed), walls: true });
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
                    stroke: true, color: b.closed ? mixHex(style.color, '#000000', 0.45) : '#111114', weight: 0.6, opacity: 0.7,
                    fillColor: b.closed ? mixHex(style.color, '#000000', 0.3) : FOOTBRIDGE.band, fillOpacity: b.closed ? 0.45 : 0.95, interactive: false,
                }).addTo(layer);
                // The striped band along the deck's edge: short light dashes across its middle.
                if (!b.closed) {
                    const mid = (under + 1) / 2;
                    L.polyline([up(w.a, mid), up(w.b, mid)], { color: FOOTBRIDGE.stripe, weight: 3, opacity: 0.9, dashArray: '2 5', lineCap: 'butt', interactive: false }).addTo(layer);
                }
            }
        }
        // The stairwells are holes in the deck: the steps below show through them. With holes the
        // outline is drawn on its own (a cut ring's own stroke would trace slivers across the opening).
        const cut = holes.length ? cutStairwells(ring, holes) : null;
        const concrete = lift > 0 && !b.closed;
        const deck = L.polygon(cut ? cut.pieces.map((piece) => piece.map(toLL)) : b.polygon.map((p) => up(p)), {
            ...style, ...(concrete ? { fillColor: FOOTBRIDGE.deck, color: FOOTBRIDGE.edge, fillOpacity: 0.95 } : {}), ...(cut ? { stroke: false } : {}),
            interactive: Boolean(popup), className: popup ? 'campus-hit' : '',
        }).addTo(layer);
        if (cut) {
            // Drawn on their own (the pieces' own strokes would show the cuts between them): the deck's
            // outline, open where a stairwell reaches its edge, and each stairwell's edge over the deck in amber.
            const seg = ([p, q], color, weight) => L.polyline([toLL(p), toLL(q)], { color, weight, opacity: style.opacity, lineCap: 'round', interactive: false }).addTo(layer);
            cut.outline.forEach((part) => seg(part, concrete ? FOOTBRIDGE.edge : style.color, style.weight));
            cut.wellEdges.forEach((part) => seg(part, STAIR_TREAD, 1.5));
        }
        if (lift > 0) {
            // Parapets along the long sides (the walking line's direction): solid cream concrete with a top edge.
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
                L.polygon([up(p), up(q), up(q, rail), up(p, rail)], { stroke: false, fillColor: b.closed ? '#e5e7eb' : FOOTBRIDGE.concrete, fillOpacity: b.closed ? 0.15 : 0.92, interactive: false }).addTo(layer);
                L.polyline([up(p, rail), up(q, rail)], { color: b.closed ? style.color : FOOTBRIDGE.edge, weight: 1.5, opacity: 0.9, interactive: false }).addTo(layer);
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

// ── Campus objects: trees, benches, sheds and gates ─────────────────
const TREE_GREENS = ['#3f7d3a', '#467f36', '#3b7442', '#4d8a3c', '#38703a'];
const OBJECT_TONES = { trunk: '#6b4a2e', bench: '#8b5a2b', benchSide: '#5f3c1d', shedRoof: '#8d9f96', shedEdge: '#5e6e66', post: '#5b5f63', gate: '#e6dabd', gateEdge: '#8a8170' };

/**
 * Trees, benches, sheds and gates on the map. `extrude` (the student map, like the 2.5D buildings): each
 * stands up north-up by its real height, with the trees' and sheds' shadows on the ground for `sun`.
 * Flat (the admin map): a top-down symbol. Objects behind a building (north of it, as the map is seen)
 * are drawn into `layer` under the buildings, the rest into `frontLayer` over them. `onSelect(obj)` makes
 * them clickable (the editor); `selectedId` is outlined.
 */
export function drawCampusObjects(layer, objects, { extrude = false, sun = null, buildings = [], frontLayer = null, onSelect = null, selectedId = null, onMove = null, onTransform = null } = {}) {
    // The selected one's frame: resize and rotate handles (or a tree's crown handle), drawn last, on top.
    const framed = onTransform && selectedId !== null ? (objects || []).find((o) => String(o.id) === String(selectedId)) : null;
    layer.clearLayers();
    frontLayer?.clearLayers();
    const placed = (objects || []).filter((o) => Number.isFinite(+o.latitude) && Number.isFinite(+o.longitude));
    // Parking lots first: painted on the ground, under the trees and the shadows.
    for (const o of placed.filter((p) => p.kind === 'parking')) {
        const lot = parkingLayout(o);
        const selected = selectedId !== null && String(o.id) === String(selectedId);
        const ground = L.polygon(lot.outline.map((p) => [p.lat, p.lng]), {
            color: selected ? '#22c55e' : '#d4d4d8', weight: selected ? 3 : 1, opacity: 0.9,
            fillColor: '#3f4047', fillOpacity: 0.92, interactive: Boolean(onSelect),
        }).addTo(layer);
        if (onSelect) ground.on('click', (e) => { L.DomEvent.stopPropagation(e); onSelect(o); });
        L.polyline(lot.lines.map(([a, b]) => [[a.lat, a.lng], [b.lat, b.lng]]), { color: '#f4f4f5', weight: 1.4, opacity: 0.85, interactive: false }).addTo(layer);
        // In the lot's own pane, so a building in front of the lot covers its sign too.
        L.marker([lot.sign.lat, lot.sign.lng], { icon: PARKING_SIGN_ICON, interactive: false, keyboard: false, pane: layer.campusPane || 'markerPane' }).addTo(layer);
        if (selected && onMove) {
            const handle = L.marker([+o.latitude, +o.longitude], { icon: MOVE_HANDLE_ICON, draggable: true, zIndexOffset: 2000, keyboard: false, title: 'Drag to move' });
            handle.on('dragend', () => { const p = handle.getLatLng(); onMove(p.lat, p.lng); });
            handle.on('click', (e) => L.DomEvent.stopPropagation(e));
            handle.addTo(frontLayer || layer);
        }
    }
    const list = placed.filter((o) => o.kind !== 'parking');
    // Shadows first, all on the ground layer.
    if (extrude && sun) {
        const fill = shadowColor(sun);
        const opacity = shadowOpacity(sun) * 0.85;
        for (const o of list) {
            const rings = objectShadowRings([o], sun);
            if (rings.length) L.polygon(rings.map((r) => r.map((p) => [p.lat, p.lng])), { stroke: false, fillColor: fill, fillOpacity: opacity, fillRule: 'nonzero', interactive: false }).addTo(layer);
        }
    }
    // Lowest first, so what stands taller covers it: benches, then gates, sheds, and the tree crowns over them;
    // within each, far (north) first, so nearer ones cover them.
    const RANK = { bench: 0, gate: 1, shed: 2, tree: 3 };
    const sorted = [...list].sort((a, b) => (RANK[a.kind] ?? 2) - (RANK[b.kind] ?? 2) || +b.latitude - +a.latitude);
    // In front of the buildings or behind them; a tree's crown reaches out over its width.
    const behind = (o) => wallBehindBuilding({ lat: +o.latitude, lng: +o.longitude }, { lat: +o.latitude, lng: +o.longitude }, buildings, o.kind === 'tree' ? (Number(o.width_m) || 4) / 2 : 1);
    const trees = list.filter((t) => t.kind === 'tree');
    for (const o of sorted) {
        const here = { lat: +o.latitude, lng: +o.longitude };
        // A bench, shed or gate under a tree's crown goes where that tree goes, so the crown always covers it.
        const under = o.kind === 'tree' ? null : trees.find((t) => Math.hypot(...toLocalMeters(+o.latitude, +o.longitude, +t.latitude, +t.longitude)) < (Number(t.width_m) || 4) / 2);
        const into = frontLayer && !behind(under || o) ? frontLayer : layer;
        const selected = selectedId !== null && String(o.id) === String(selectedId);
        const hit = (shape) => {
            if (!onSelect || !shape) return;
            shape.options.interactive = true;
            shape.on('click', (e) => { L.DomEvent.stopPropagation(e); onSelect(o); });
        };
        const outline = selected ? { color: '#22c55e', weight: 3, opacity: 1 } : null;
        const liftM = (m) => (extrude ? roofLiftM(m) / 111320 : 0);
        if (o.kind === 'tree') drawTree25D(into, o, liftM, hit, outline, Boolean(onSelect));
        else if (o.kind === 'bench') {
            const rect = objectRect(o, Number(o.width_m) || 0.5, Number(o.length_m) || 1.8);
            const seat = liftM(Number(o.height_m) || 0.45);
            if (seat) L.polygon(rect.map((p) => [p.lat, p.lng]), { stroke: false, fillColor: OBJECT_TONES.benchSide, fillOpacity: 0.9, interactive: false }).addTo(into);
            const top = L.polygon(rect.map((p) => [p.lat + seat, p.lng]), { color: outline?.color || OBJECT_TONES.benchSide, weight: outline?.weight || 0.8, fillColor: OBJECT_TONES.bench, fillOpacity: 1, interactive: Boolean(onSelect) }).addTo(into);
            hit(top);
        } else if (o.kind === 'shed') {
            const roof = shedRoof(o);
            const h = liftM(Number(o.height_m) || 2.6);
            for (const p of roof) L.polyline([[p.lat, p.lng], [p.lat + h, p.lng]], { color: OBJECT_TONES.post, weight: 2, opacity: 0.9, interactive: false }).addTo(into);
            const top = L.polygon(roof.map((p) => [p.lat + h, p.lng]), { color: outline?.color || OBJECT_TONES.shedEdge, weight: outline?.weight || 1, fillColor: OBJECT_TONES.shedRoof, fillOpacity: 0.95, interactive: Boolean(onSelect) }).addTo(into);
            // The roof's ridge along its length.
            const [a, b, c, d] = roof;
            L.polyline([[(a.lat + b.lat) / 2 + h, (a.lng + b.lng) / 2], [(c.lat + d.lat) / 2 + h, (c.lng + d.lng) / 2]], { color: OBJECT_TONES.shedEdge, weight: 1, opacity: 0.8, interactive: false }).addTo(into);
            hit(top);
        } else if (o.kind === 'gate') {
            const h = liftM(Number(o.height_m) || 2.2);
            const ends = gateEnds(o);
            // The opening on the ground (dashed), then a pillar at each end.
            L.polyline(ends.map((p) => [p.lat, p.lng]), { color: OBJECT_TONES.gateEdge, weight: 2, opacity: 0.8, dashArray: '3 4', interactive: false }).addTo(into);
            for (const p of ends) {
                const pillar = objectRect({ latitude: p.lat, longitude: p.lng, rotation_deg: o.rotation_deg }, 0.5, 0.5);
                if (h) L.polygon([[pillar[0].lat, pillar[0].lng], [pillar[1].lat, pillar[1].lng], [pillar[1].lat + h, pillar[1].lng], [pillar[0].lat + h, pillar[0].lng]], { stroke: false, fillColor: OBJECT_TONES.gateEdge, fillOpacity: 0.95, interactive: false }).addTo(into);
                const top = L.polygon(pillar.map((q) => [q.lat + h, q.lng]), { color: outline?.color || OBJECT_TONES.gateEdge, weight: outline?.weight || 1, fillColor: OBJECT_TONES.gate, fillOpacity: 1, interactive: Boolean(onSelect) }).addTo(into);
                hit(top);
            }
        }
        // The selected one gets a handle to drag it somewhere else (tapping the map also moves it).
        if (selected && onMove) {
            const handle = L.marker([here.lat, here.lng], { icon: MOVE_HANDLE_ICON, draggable: true, zIndexOffset: 2000, keyboard: false, title: 'Drag to move' });
            handle.on('dragend', () => { const p = handle.getLatLng(); onMove(p.lat, p.lng); });
            handle.on('click', (e) => L.DomEvent.stopPropagation(e));
            handle.addTo(frontLayer || layer);
        }
    }
    if (framed && framed.kind !== 'gate') drawTransformFrame(frontLayer || layer, framed, onTransform);
}

/**
 * The transform frame of the selected tree, bench, shed or parking lot, like a design tool's: an outline,
 * round corner handles and edge bars to resize (the opposite side stays put), and a round rotate handle
 * behind it; a tree gets one handle on its crown's edge for the crown width. While a handle is dragged a
 * dashed outline shows the result; it is applied (onTransform(patch)) when the handle is let go.
 */
function drawTransformFrame(into, o, onTransform) {
    const ll = (p) => [p.lat, p.lng];
    const ghost = L.polygon([[0, 0]], { color: '#22c55e', weight: 2, dashArray: '6 5', fill: false, opacity: 0, interactive: false }).addTo(into);
    const handle = (at, icon, title, onDrag, onDrop) => {
        const m = L.marker(ll(at), { icon, draggable: true, zIndexOffset: 2100, keyboard: false, title });
        m.on('drag', () => { const p = m.getLatLng(); ghost.setLatLngs(onDrag(p.lat, p.lng)); ghost.setStyle({ opacity: 1 }); });
        m.on('dragend', () => { const p = m.getLatLng(); onDrop(p.lat, p.lng); });
        m.on('click', (e) => L.DomEvent.stopPropagation(e));
        return m.addTo(into);
    };
    const { w, l } = objectSize(o);
    if (o.kind === 'tree') {
        // A tree: a square round its crown. Corners and edges widen the crown from the trunk (which stays
        // put), the round arrow turns it, and the up-down handle above sets its height.
        const square = (width) => objectRect(o, width, width).map(ll);
        L.polygon(square(w), { color: '#22c55e', weight: 1.5, fill: false, interactive: false }).addTo(into);
        for (const { sx, sy } of RESIZE_HANDLES) {
            const corner = sx !== 0 && sy !== 0;
            const icon = corner ? FRAME_CORNER_ICON : frameEdgeIcon((Number(o.rotation_deg) || 0) + (sy !== 0 ? 90 : 0));
            handle(fromObjectFrame(o, (sx * w) / 2, (sy * w) / 2), icon, 'Drag to change the crown width',
                (lat, lng) => square(crownFromFrame(o, lat, lng)), (lat, lng) => onTransform({ width_m: crownFromFrame(o, lat, lng) }));
        }
        const knob = rotateHandleAt(o);
        L.polyline([ll(fromObjectFrame(o, 0, -w / 2)), ll(knob)], { color: '#22c55e', weight: 1.5, interactive: false }).addTo(into);
        handle(knob, FRAME_ROTATE_ICON, 'Drag to turn the tree',
            (lat, lng) => objectRect({ ...o, rotation_deg: rotateTo(o, lat, lng) }, w, w).map(ll), (lat, lng) => onTransform({ rotation_deg: rotateTo(o, lat, lng) }));
        const top = heightHandleAt(o);
        L.polyline([[+o.latitude, +o.longitude], ll(top)], { color: '#22c55e', weight: 1, dashArray: '2 4', interactive: false }).addTo(into);
        handle(top, FRAME_HEIGHT_ICON, 'Drag up or down to change the height',
            (lat) => [[+o.latitude, +o.longitude], [lat, +o.longitude]], (lat, lng) => onTransform({ height_m: heightTo(o, lat, lng) }));
        return;
    }
    L.polygon(objectRect(o, w, l).map(ll), { color: '#22c55e', weight: 1.5, fill: false, interactive: false }).addTo(into);
    const rectOf = (patch) => { const n = { ...o, ...patch }; return objectRect(n, objectSize(n).w, objectSize(n).l).map(ll); };
    for (const { sx, sy } of RESIZE_HANDLES) {
        const corner = sx !== 0 && sy !== 0;
        // An edge bar lies along its edge: across the facing on the front and back, along it on the sides.
        const icon = corner ? FRAME_CORNER_ICON : frameEdgeIcon((Number(o.rotation_deg) || 0) + (sy !== 0 ? 90 : 0));
        handle(fromObjectFrame(o, (sx * w) / 2, (sy * l) / 2), icon, corner ? 'Drag to resize' : 'Drag to stretch this side',
            (lat, lng) => rectOf(resizeFrom(o, sx, sy, lat, lng)), (lat, lng) => onTransform(resizeFrom(o, sx, sy, lat, lng)));
    }
    // The rotate handle, joined to the back edge by a short line.
    const knob = rotateHandleAt(o);
    L.polyline([ll(fromObjectFrame(o, 0, -l / 2)), ll(knob)], { color: '#22c55e', weight: 1.5, interactive: false }).addTo(into);
    handle(knob, FRAME_ROTATE_ICON, 'Drag to rotate',
        (lat, lng) => rectOf({ rotation_deg: rotateTo(o, lat, lng) }), (lat, lng) => onTransform({ rotation_deg: rotateTo(o, lat, lng) }));
}

const FRAME_CORNER_ICON = L.divIcon({
    className: '',
    html: '<div style="width:14px;height:14px;border-radius:50%;background:#fff;border:2px solid #22c55e;box-shadow:0 1px 4px rgba(0,0,0,0.45);cursor:nwse-resize"></div>',
    iconSize: [14, 14],
    iconAnchor: [7, 7],
});
/** An edge bar, turned to lie along its edge (bearing of the edge, degrees). */
const frameEdgeIcon = (bearing) => L.divIcon({
    className: '',
    html: `<div style="width:18px;height:18px;display:flex;align-items:center;justify-content:center;transform:rotate(${Math.round(bearing) - 90}deg)">`
        + '<div style="width:16px;height:6px;border-radius:3px;background:#fff;border:2px solid #22c55e;box-shadow:0 1px 4px rgba(0,0,0,0.45)"></div></div>',
    iconSize: [18, 18],
    iconAnchor: [9, 9],
});
// The height handle: an up-down arrow in a pill, above the tree's crown.
const FRAME_HEIGHT_ICON = L.divIcon({
    className: '',
    html: '<div style="width:24px;height:30px;border-radius:12px;background:#fff;border:2px solid #22c55e;box-shadow:0 2px 6px rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;cursor:ns-resize" role="img" aria-label="Height">'
        + '<svg width="14" height="20" viewBox="0 0 14 20" fill="none" stroke="#15803d" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
        + '<path d="M7 2v16M3 6l4-4 4 4M3 14l4 4 4-4"/></svg></div>',
    iconSize: [24, 30],
    iconAnchor: [12, 15],
});
const FRAME_ROTATE_ICON = L.divIcon({
    className: '',
    html: '<div style="width:28px;height:28px;border-radius:50%;background:#22c55e;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;cursor:grab" role="img" aria-label="Rotate">'
        + '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
        + '<path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v5h-5"/></svg></div>',
    iconSize: [28, 28],
    iconAnchor: [14, 14],
});

// The parking lot's sign: a blue square with a white P, as on road signs.
const PARKING_SIGN_ICON = L.divIcon({
    className: '',
    html: '<div style="width:20px;height:20px;border-radius:4px;background:#1d4ed8;border:2px solid #fff;color:#fff;font:700 13px/16px system-ui,sans-serif;text-align:center;box-shadow:0 1px 4px rgba(0,0,0,0.4)" role="img" aria-label="Parking">P</div>',
    iconSize: [20, 20],
    iconAnchor: [10, 10],
});

// A round green grip with four arrows, on the selected campus object's base point.
const MOVE_HANDLE_ICON = L.divIcon({
    className: '',
    html: '<div style="width:34px;height:34px;border-radius:50%;background:#22c55e;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;cursor:grab" role="img" aria-label="Drag to move">'
        + '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
        + '<path d="M12 2v20M2 12h20M12 2l-3 3M12 2l3 3M12 22l-3-3M12 22l3-3M2 12l3-3M2 12l3 3M22 12l-3-3M22 12l-3 3"/></svg></div>',
    iconSize: [34, 34],
    iconAnchor: [17, 17],
});

/** One tree: the trunk standing up to the crown, then the crown's puffs (or a palm's fronds), lit from above. */
function drawTree25D(into, o, liftM, hit, outline, interactive) {
    const m = treeModel(o);
    const rand = seededRandom((Number(o.seed) || 1) + 3);
    const green = TREE_GREENS[Math.floor(rand() * TREE_GREENS.length)];
    const base = { lat: +o.latitude, lng: +o.longitude };
    const k = Math.cos((base.lat * Math.PI) / 180) * 111320;
    const off = (e, n, u = 0) => [base.lat + n / 111320 + liftM(u), base.lng + e / k];
    // Trunk: a thin upright band from the ground to where the crown starts.
    const tr = m.trunkR;
    const topU = trunkTopM(m);
    if (m.stems.length) {
        // A banana plant: its clumped stems, yellow-green.
        for (const s of m.stems) {
            L.polygon([off(s.e - s.r, s.n, 0), off(s.e + s.r, s.n, 0), off(s.te + s.r * 0.75, s.tn, s.h), off(s.te - s.r * 0.75, s.tn, s.h)], {
                color: '#6f7a2e', weight: 0.6, fillColor: '#a9b356', fillOpacity: 1, interactive: false,
            }).addTo(into);
        }
    } else {
        L.polygon([off(-tr, 0, 0), off(tr, 0, 0), off(m.lean.e + tr * 0.7, m.lean.n, topU), off(m.lean.e - tr * 0.7, m.lean.n, topU)], {
            stroke: false, fillColor: OBJECT_TONES.trunk, fillOpacity: 1, interactive: false,
        }).addTo(into);
    }
    // A shade tree's limbs, from the top of the trunk out to its clumps (drawn first: the leaves cover their ends).
    for (const l of m.limbs) {
        const len = Math.hypot(l.e, l.n) || 1;
        const pe = -l.n / len;
        const pn = l.e / len;
        const w0 = tr * 0.6;
        const w1 = tr * 0.22;
        L.polygon([
            off(m.lean.e + pe * w0, m.lean.n + pn * w0, m.trunkH), off(m.lean.e - pe * w0, m.lean.n - pn * w0, m.trunkH),
            off(m.lean.e + l.e - pe * w1, m.lean.n + l.n - pn * w1, l.u), off(m.lean.e + l.e + pe * w1, m.lean.n + l.n + pn * w1, l.u),
        ], { stroke: false, fillColor: OBJECT_TONES.trunk, fillOpacity: 1, interactive: false }).addTo(into);
    }
    if (m.fronds.length) {
        let lastFrond = null;
        // Back leaves (north) first, so the near ones cover them.
        for (const f of [...m.fronds].sort((p, q) => Math.cos((q.dir * Math.PI) / 180) - Math.cos((p.dir * Math.PI) / 180))) {
            const a = (f.dir * Math.PI) / 180;
            if (f.wide) {
                // A banana leaf: a long paddle from its stem's top, rising or drooping towards its tip.
                const oe = f.e ?? m.lean.e;
                const on = f.n ?? m.lean.n;
                const oh = f.h ?? m.trunkH;
                const at = (t, side) => off(
                    oe + Math.sin(a) * f.len * t + Math.cos(a) * side,
                    on + Math.cos(a) * f.len * t - Math.sin(a) * side,
                    oh + 0.15 - f.droop * f.len * t * t,
                );
                const hw = f.wide / 2;
                const leaf = L.polygon([at(0.05, 0), at(0.22, hw * 0.8), at(0.55, hw), at(0.88, hw * 0.65), at(1, 0), at(0.88, -hw * 0.65), at(0.55, -hw), at(0.22, -hw * 0.8)], {
                    color: '#3f7a2a', weight: 0.6, fillColor: f.droop > 0.3 ? '#6aa63d' : '#86c04f', fillOpacity: 1, interactive,
                }).addTo(into);
                // The midrib, a lighter line down the leaf.
                L.polyline([at(0.05, 0), at(1, 0)], { color: '#c7e39a', weight: 0.8, opacity: 0.8, interactive: false }).addTo(into);
                hit(leaf);
                lastFrond = leaf;
                continue;
            }
            const w = 0.35;
            const tip = off(m.lean.e + Math.sin(a) * f.len, m.lean.n + Math.cos(a) * f.len, m.trunkH - f.droop * f.len);
            const side = (s) => off(m.lean.e + Math.sin(a) * f.len * 0.45 + Math.cos(a) * w * s, m.lean.n + Math.cos(a) * f.len * 0.45 - Math.sin(a) * w * s, m.trunkH + 0.2);
            lastFrond = L.polygon([off(m.lean.e, m.lean.n, m.trunkH + 0.2), side(1), tip, side(-1)], { color: '#2f5f2c', weight: 0.6, fillColor: green, fillOpacity: 1, interactive }).addTo(into);
            hit(lastFrond);
        }
        if (outline) L.polygon(crownFootprint(o).map((p) => [p.lat + liftM(m.trunkH), p.lng]), { ...outline, fill: false, interactive: false }).addTo(into);
        return;
    }
    // Crown: back puffs first (north, low), front ones last; each a disc with a lighter top-left highlight.
    const puffs = [...m.puffs].sort((p, q) => q.n - p.n || p.u - q.u);
    const disc = (cx, cn, u, r, sides = 14) => Array.from({ length: sides }, (_, i) => {
        const t = (i / sides) * Math.PI * 2;
        return off(m.lean.e + cx + Math.sin(t) * r, m.lean.n + cn + Math.cos(t) * r * 0.92, u);
    });
    for (const p of puffs) {
        const puff = L.polygon(disc(p.e, p.n, p.u, p.r), { color: '#2b5a28', weight: 0.7, opacity: 0.9, fillColor: green, fillOpacity: 1, interactive }).addTo(into);
        hit(puff);
        L.polygon(disc(p.e - p.r * 0.25, p.n + p.r * 0.2, p.u + p.r * 0.3, p.r * 0.5, 10), { stroke: false, fillColor: '#6aa85a', fillOpacity: 0.55, interactive: false }).addTo(into);
    }
    if (outline) {
        const top = (m.crownBase + m.crownTop) / 2;
        L.polygon(crownFootprint(o).map((p) => [p.lat + liftM(top), p.lng]), { ...outline, fill: false, interactive: false }).addTo(into);
    }
}

// ── Route direction: chevrons along the route and the arrow at your position ─────
/** A small white chevron on the route line, pointing along `bearing`. */
export function chevronIcon(bearing) {
    return L.divIcon({
        className: '',
        html: `<div style="width:14px;height:14px;transform:rotate(${Math.round(bearing)}deg)">`
            + '<svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true"><path d="M3 9.5 7 4.5l4 5" fill="none" stroke="#ffffff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></div>',
        iconSize: [14, 14],
        iconAnchor: [7, 7],
    });
}

/**
 * The large raised arrow at your position, pointing along `bearing`: a blue arrow with a darker copy
 * offset straight down on screen (its side, like a 3D marker lying on the map) and a soft shadow.
 */
export function directionArrowIcon(bearing) {
    const arrow = (fill, stroke) => `<path d="M24 1 35 46 24 38 13 46Z" fill="${fill}" stroke="${stroke}" stroke-width="2.5" stroke-linejoin="round"/>`;
    // `--dir` on .route-dir-arrow turns it live without rebuilding the icon (the 2D map: where you face).
    const rotDeg = `${Math.round(bearing)}deg`;
    return L.divIcon({
        className: '',
        html: '<div class="route-dir-arrow" style="position:relative;width:48px;height:48px;filter:drop-shadow(0 3px 4px rgba(0,0,0,0.45))" role="img" aria-label="Walk this way">'
            + `<svg viewBox="0 0 48 48" width="48" height="48" style="position:absolute;inset:0;transform:translateY(4px) rotate(var(--dir, ${rotDeg}))" aria-hidden="true">${arrow('#0b3d91', '#0b3d91')}</svg>`
            + `<svg viewBox="0 0 48 48" width="48" height="48" style="position:absolute;inset:0;transform:rotate(var(--dir, ${rotDeg}))" aria-hidden="true">${arrow('#3d8bff', '#ffffff')}</svg>`
            + '</div>',
        iconSize: [48, 48],
        iconAnchor: [24, 24],
    });
}

/**
 * Draw the chevrons along each route line and the raised arrow at its start into `layer`.
 * `lines`: arrays of [lat, lng] (the route on the floor shown). The arrow goes on the first line's start.
 */
export function drawRouteDirection(layer, lines, { everyM = 14, userArrow = true } = {}) {
    for (const line of lines || []) {
        for (const a of arrowsAlong(line, everyM)) {
            L.marker([a.lat, a.lng], { icon: chevronIcon(a.bearing), interactive: false, keyboard: false, zIndexOffset: 300 }).addTo(layer);
        }
    }
    const first = (lines || [])[0];
    const bearing = userArrow ? startBearing(first) : null;
    if (bearing !== null) {
        L.marker(first[0], { icon: directionArrowIcon(bearing), interactive: false, keyboard: false, zIndexOffset: 1200 }).addTo(layer);
    }
}
