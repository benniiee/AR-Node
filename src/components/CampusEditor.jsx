import React, { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import { api } from '../api';
import { ActionBar, Sheet } from './MapControls';
import { loadOsmFeatures } from '../osmFeatures';
import { PATHWAY_KINDS, PATHWAY_WIDTH_M, pathwayWidthM, BRIDGE_KINDS, MAX_DECK_FLOOR, buildingFloors, polygonCentroid, deckLevelLabel } from '../campusGeometry';
import { pathwayStyle, pathWeightPx, buildingStyle, bridgeStyle, esc } from '../campusLayers';
import { toLocalMeters, fromLocalMeters } from '../geo';
import { snapToOutline, placedDoors, doorFrames, doorWidth, DOOR_SNAP_M, DOOR_WIDTH_M, MIN_DOOR_WIDTH_M, MAX_DOOR_WIDTH_M, MAX_DOORS } from '../doors';
import { lazyPreview } from './Lazy3D';
import { addJoined, canExtendFrom } from '../shapeDraft';
import StairModal from './StairModal';
import { suggestEntrances } from '../pathfinding';

// The door editor's 3D view (admin only): three.js loads when the editor opens.
const BuildingPreview3D = lazyPreview(() => import('./BuildingPreview3D'), 'BUILDING_PREVIEW_CSS', 'Loading the 3D preview...');

// ── Campus editor: buildings, bridges and pathways ──────────────────
// One tool for all three, because each is "a shape on the map plus a label".
// A bridge (or other connector, campusGeometry BRIDGE_KINDS) is drawn exactly
// like a building outline; its details are the deck instead of floors/doors:
//
//   1. shape    adopt a shape from the OpenStreetMap base map (its outlines
//               are drawn dashed: tap one), or tap the map to draw corners /
//               points yourself, e.g. for a building still being built.
//               Corners can be dragged; Undo drops the last one.
//   2. details  name, floors, status... then Save.
//
// Editing an existing building/pathway opens at step 2; "Reshape" goes back
// to step 1 with its points loaded as the draft.

// Unlabelled base-map shapes on offer: sky blue, the shade that reads on the
// current base map (admin view = light, student view = dark).
const CANDIDATE = { light: '#0284c7', dark: '#38bdf8' };

const VERTEX_ICON = L.divIcon({
    className: '',
    html: '<div class="wall-node-pad"><div style="width:12px;height:12px;border-radius:50%;background:#fff;border:2px solid #111;box-shadow:0 1px 3px rgba(0,0,0,0.45);"></div></div>',
    iconSize: [28, 28],
    iconAnchor: [14, 14],
});
// The selected corner: the next tap adds a corner joined to this one.
const VERTEX_ICON_SELECTED = L.divIcon({
    className: '',
    html: '<div class="wall-node-pad"><div style="width:16px;height:16px;border-radius:50%;background:#22c55e;border:3px solid #fff;box-shadow:0 0 0 3px rgba(34,197,94,0.35),0 1px 4px rgba(0,0,0,0.5);"></div></div>',
    iconSize: [28, 28],
    iconAnchor: [14, 14],
});

// Centre handle: drag it and the WHOLE shape moves (corners keep their
// relative positions). Four arrows say "move", unlike the round corner dots.
const MOVE_ICON = L.divIcon({
    className: '',
    html: `<div class="cf-move" title="Drag to move the whole shape"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3"/></svg></div>`,
    iconSize: [36, 36],
    iconAnchor: [18, 18],
});

/** Middle of a shape: area centre for an outline, point average for a line. */
const shapeCentre = (pts, isPolygon) => (isPolygon && pts.length >= 3
    ? polygonCentroid(pts)
    : { lat: pts.reduce((a, p) => a + p.lat, 0) / pts.length, lng: pts.reduce((a, p) => a + p.lng, 0) / pts.length });

/** A door's handle on the map: its number, draggable along the wall. */
const doorIcon = (n, lit) => L.divIcon({
    className: '',
    html: `<div class="cf-door${lit ? ' is-lit' : ''}">${n}</div>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
});

const FACING = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
/** "north-east" for a compass bearing (to the nearest of eight directions). */
const facingWords = (deg) => FACING[Math.round((((Number(deg) % 360) + 360) % 360) / 45) % 8];

/** A door width in metres, one decimal, kept within the allowed range. */
const clampWidth = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return DOOR_WIDTH_M;
    return Math.round(Math.min(MAX_DOOR_WIDTH_M, Math.max(MIN_DOOR_WIDTH_M, n)) * 10) / 10;
};

/** Door width: minus / typed value / plus, in 0.1 m steps. */
function WidthStepper({ value, onChange, label }) {
    const [text, setText] = useState(value.toFixed(1));
    useEffect(() => { setText(value.toFixed(1)); }, [value]);
    const commit = (v) => { const w = clampWidth(v); setText(w.toFixed(1)); if (w !== value) onChange(w); };
    return (
        <span className="cf-width" role="group" aria-label={label}>
            <button type="button" className="cf-width-btn" onClick={() => commit(value - 0.1)} disabled={value <= MIN_DOOR_WIDTH_M} aria-label={`${label}: narrower`}>&minus;</button>
            <input
                className="cf-width-input ui-num" type="text" inputMode="decimal" value={text} aria-label={`${label} in metres`}
                onChange={(e) => setText(e.target.value)}
                onBlur={() => commit(text)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(text); } }}
            />
            <span className="cf-width-unit" aria-hidden="true">m</span>
            <button type="button" className="cf-width-btn" onClick={() => commit(value + 0.1)} disabled={value >= MAX_DOOR_WIDTH_M} aria-label={`${label}: wider`}>+</button>
        </span>
    );
}

const clampInt = (v, lo, hi, fallback) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};

export default function CampusEditor({
    map, mode, record, buildings, pathways, departments, onSaved, onClose, onError,
    onManageNodes = null, onConnectBridge = null, theme = 'light', nodes = [], startStep = null,
    // Drawn walls and staircases, for "Find entrances".
    borders = [], links = [],
    // Department staff edit their own department's buildings but cannot
    // file a building under another department (the server enforces it too).
    canChangeDepartment = true,
}) {
    const THEME = theme;
    const candidateColor = CANDIDATE[theme] || CANDIDATE.light;
    const isBuilding = mode === 'building';
    const isBridge = mode === 'bridge';
    // Buildings and bridges are closed outlines; pathways are open lines.
    const isOutline = isBuilding || isBridge;
    const minPoints = isOutline ? 3 : 2;
    const noun = isBuilding ? 'building' : isBridge ? 'bridge' : 'pathway';

    const initialPoints = () => (record ? (isOutline ? record.polygon : record.coordinates) || [] : []);
    const [step, setStep] = useState(startStep || (record ? 'details' : 'shape'));
    // Total shift applied with the centre handle, so the rooms filed in a moved
    // building can follow it. Corner drags are reshaping and do not count.
    const [shift, setShift] = useState({ lat: 0, lng: 0 });
    const [moveNodesToo, setMoveNodesToo] = useState(true);
    // Admin handing the building to another department: its rooms and routes
    // go with it unless this is unticked.
    const [handOverNodes, setHandOverNodes] = useState(true);
    const nodesInside = isBuilding && record ? nodes.filter((n) => n.building_id === record.id) : [];
    const moved = Math.abs(shift.lat) > 1e-9 || Math.abs(shift.lng) > 1e-9;
    const [points, setPoints] = useState(initialPoints);
    // Drawing: a tap adds a corner joined to the SELECTED corner (`anchor`),
    // which then becomes the selected one, so taps chain on from there. With
    // none selected, a tap adds after the last corner (the old behaviour).
    // Tap a corner to select it. Undo steps back through the additions.
    const [anchor, setAnchor] = useState(null);
    const historyRef = useRef([]);
    // A short note for the drawing bar (e.g. why a point cannot be extended).
    const [drawNote, setDrawNote] = useState(null);
    const [source, setSource] = useState(record?.source || 'custom');
    const [ref, setRef] = useState(record?.osm_ref || null);

    const [name, setName] = useState(record?.name || '');
    const [shortName, setShortName] = useState(record?.short_name || '');
    const [floors, setFloors] = useState(String(record?.floors ?? 1));
    // Optional measured height; blank = estimated from floors (floors x 3.2 m).
    const [heightM, setHeightM] = useState(record?.height_m ? String(record.height_m) : '');
    // Status is no longer asked: everything on the map is an existing
    // building or path (saving one marks it existing).
    const status = 'existing';
    // Legacy column, kept as it was: the campus now comes from the campus areas.
    const campus = record?.campus === 'B' ? 'B' : 'A';
    const [departmentId, setDepartmentId] = useState(record?.department_id ? String(record.department_id) : '');
    // Doors belong to the building's department: its staff manage them; an
    // admin only for a building no department owns (BuildingController).
    const ownerName = record?.department?.name || departments.find((d) => String(d.id) === String(record?.department_id))?.name || 'its department';
    const manageDoors = !canChangeDepartment || String(record?.department_id ?? '') === '';
    // An admin filing an existing building under another department.
    const departmentChanged = Boolean(isBuilding && record && canChangeDepartment
        && String(departmentId) !== String(record.department_id ?? ''));
    // Handover wording comes from the nodes themselves: rooms added under an
    // earlier owner can still belong to it, so the building's own department
    // is not always who they "stay with".
    const departmentName = (id) => (id === null || id === undefined || id === ''
        ? null : departments.find((d) => String(d.id) === String(id))?.name || 'another department');
    const newOwnerName = departmentName(departmentId);
    const nodesToHandOver = nodesInside.filter((n) => String(n.department_id ?? '') !== String(departmentId));
    const currentOwners = [...new Set(nodesToHandOver.map((n) => departmentName(n.department_id)))];
    const staffOwners = currentOwners.filter(Boolean);
    const joinNames = (names) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);
    const [kind, setKind] = useState(record?.kind || (isBridge ? 'bridge' : 'walkway'));
    // A pathway's real width in metres; blank = the usual width for its type.
    const [widthM, setWidthM] = useState(record?.width_m != null ? String(record.width_m) : '');
    // Bridge deck: the floor its route nodes are on (0 = at ground level), its
    // optional measured height (blank = deck floor x 3.2 m) and whether it has a roof.
    const [deckFloor, setDeckFloor] = useState(String(record?.deck_floor ?? 1));
    const [deckHeight, setDeckHeight] = useState(record?.deck_height_m ? String(record.deck_height_m) : '');
    const [roofed, setRoofed] = useState(record ? Boolean(record.roofed) : true);
    // Closed by an admin (an event): routes do not cross it; students see the reason.
    const [closed, setClosed] = useState(Boolean(record?.closed));
    const [closedReason, setClosedReason] = useState(record?.closed_reason || '');
    // A raised deck is reached by stairs: build one down to the ground at each end.
    const [endStairs, setEndStairs] = useState(false);
    const raisedDeck = isBridge && clampInt(deckFloor, 0, MAX_DECK_FLOOR, 1) > 0;
    const stairsNote = (res) => (raisedDeck && endStairs
        ? (res.stairs_created ? ` and ${res.stairs_created} ${res.stairs_created === 1 ? 'staircase' : 'staircases'} down to the ground` : ' (both ends already have stairs)')
        : '');
    // Doors: points on the outline; routes go in and out only through them.
    const [doors, setDoors] = useState(() => (Array.isArray(record?.doors) ? record.doors : []));
    const [doorsOpen, setDoorsOpen] = useState(false);
    // A bridge's openings are entrances, a building's doors (the same data).
    const doorWord = isBridge ? 'entrance' : 'door';
    const DoorWord = isBridge ? 'Entrance' : 'Door';
    const aDoor = isBridge ? 'an entrance' : 'a door';
    const [placingDoor, setPlacingDoor] = useState(false);
    const [doorNote, setDoorNote] = useState(null);
    const [litDoor, setLitDoor] = useState(null);
    // Width given to the next door added (each door can be changed after).
    const [newDoorWidth, setNewDoorWidth] = useState(DOOR_WIDTH_M);
    const [layNodes, setLayNodes] = useState(false);
    const [spacing, setSpacing] = useState(isBridge ? '6' : '8');

    const [osm, setOsm] = useState(null);
    const [osmError, setOsmError] = useState(null);
    const [saving, setSaving] = useState(false);

    const layerRef = useRef(null);
    const vertexPressAt = useRef(0);

    useEffect(() => {
        if (!map) return undefined;
        const layer = L.layerGroup().addTo(map);
        layerRef.current = layer;
        return () => { layer.remove(); layerRef.current = null; };
    }, [map]);

    // Base-map shapes, read once from the tile archive.
    useEffect(() => {
        let alive = true;
        loadOsmFeatures()
            .then((data) => { if (alive) setOsm(data); })
            .catch((err) => { if (alive) setOsmError(err.message || 'Base map shapes could not be read'); });
        return () => { alive = false; };
    }, []);

    // Shapes already labelled are not offered again.
    const candidates = useMemo(() => {
        if (!osm || isBridge) return [];
        const taken = new Set((isBuilding ? buildings : pathways).map((x) => x.osm_ref).filter(Boolean));
        return (isBuilding ? osm.buildings : osm.roads).filter((c) => !taken.has(c.ref));
    }, [osm, isBuilding, isBridge, buildings, pathways]);

    const adopt = (c) => {
        if (isBuilding) {
            setPoints(c.polygon);
        } else {
            setPoints(c.coordinates);
            if (c.name && !name) setName(c.name);
            setKind(c.kind);
        }
        setSource('osm');
        setRef(c.ref);
        setStep('details');
    };

    // Draw candidates + the draft.
    useEffect(() => {
        const layer = layerRef.current;
        if (!layer) return;
        layer.clearLayers();
        // The pathway preview's zoom handler (removed when the draft is redrawn).
        let fitBand = null;

        // Candidates only while nothing is drafted yet: once the admin starts
        // drawing corners, the outlines would swallow those taps.
        if (step === 'shape' && points.length === 0 && !record) {
            for (const c of candidates) {
                const latlngs = (isBuilding ? c.polygon : c.coordinates).map((p) => [p.lat, p.lng]);
                const opts = { bubblingMouseEvents: false };
                if (isBuilding) {
                    L.polygon(latlngs, { ...opts, color: candidateColor, weight: 1.75, dashArray: '4, 4', fillColor: candidateColor, fillOpacity: 0.1 })
                        .bindTooltip('Tap to label this building', { sticky: true })
                        .on('click', () => adopt(c))
                        .addTo(layer);
                } else {
                    L.polyline(latlngs, { color: candidateColor, weight: 4, opacity: 0.85, dashArray: '6, 5', interactive: false }).addTo(layer);
                    L.polyline(latlngs, { ...opts, weight: 22, opacity: 0 })
                        .bindTooltip(c.name ? `${esc(c.name)} · tap to add` : 'Tap to add this path', { sticky: true })
                        .on('click', () => adopt(c))
                        .addTo(layer);
                }
            }
        }

        if (points.length === 0) return;
        const latlngs = points.map((p) => [p.lat, p.lng]);
        let outline = null;
        // Shapes to update together while the whole draft is dragged.
        const drawn = [];
        const setShape = (lls) => {
            for (const d of drawn) d.set(lls);
        };
        const outlineStyle = isBridge ? bridgeStyle(status, THEME) : buildingStyle(status, THEME);
        if (isOutline && points.length >= 3 && step === 'shape') {
            const draft = outlineStyle;
            const fill = L.polygon(latlngs, { ...draft, stroke: false, fillOpacity: draft.fillOpacity + 0.08, interactive: false }).addTo(layer);
            const chain = L.polyline(latlngs, { color: draft.color, weight: 2.5, opacity: 1, lineJoin: 'round', interactive: false }).addTo(layer);
            const close = L.polyline([latlngs[latlngs.length - 1], latlngs[0]], { color: draft.color, weight: 2, opacity: 0.55, dashArray: '4, 7', interactive: false }).addTo(layer);
            drawn.push({ set: (l) => fill.setLatLngs(l) }, { set: (l) => chain.setLatLngs(l) }, { set: (l) => close.setLatLngs([l[l.length - 1], l[0]]) });
            outline = fill;
        } else if (isOutline && points.length >= 3) {
            const draft = outlineStyle;
            outline = L.polygon(latlngs, { ...draft, weight: 2.5, dashArray: '8, 6', fillOpacity: draft.fillOpacity + 0.08, interactive: false }).addTo(layer);
            drawn.push({ set: (l) => outline.setLatLngs(l) });
        } else if (points.length >= 2) {
            // Preview of the real width (the Width field, else the usual one for the type), kept on zoom.
            const style = pathwayStyle(kind, status, THEME);
            const metres = pathwayWidthM(kind, widthM.trim() === '' ? null : Number(widthM));
            // Light and see-through, so it stands apart from the grey centre line and the ground shows through.
            // The road as saved (its own place, type and width), under the preview, for comparison.
            const savedStyle = record ? pathwayStyle(record.kind, record.status, THEME) : null;
            const saved = record?.coordinates?.length >= 2
                ? L.polyline(record.coordinates.map((p) => [p.lat, p.lng]), { ...savedStyle, lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(layer)
                : null;
            const savedMetres = record ? pathwayWidthM(record.kind, record.width_m) : 0;
            const band = L.polyline(latlngs, { ...style, color: '#e5e7eb', opacity: 0.4, lineCap: 'butt', lineJoin: 'round', interactive: false }).addTo(layer);
            fitBand = () => {
                saved?.setStyle({ weight: pathWeightPx(map, savedMetres, savedStyle.weight) });
                band.setStyle({ weight: pathWeightPx(map, metres, style.weight) });
            };
            fitBand();
            map.on('zoomend', fitBand);
            // The centre line only while reshaping (the points are dragged along it); otherwise just the band.
            if (step === 'shape') outline = L.polyline(latlngs, { ...style, interactive: false }).addTo(layer);
            drawn.push({ set: (l) => { outline?.setLatLngs(l); band.setLatLngs(l); } });
        }

        // Doors on the draft: a light gap in the outline and a numbered
        // handle that slides along the wall (re-snapped on drop). Buildings and bridges.
        if (isOutline && points.length >= 3) {
            doorFrames(points, doors).forEach((d, k) => {
                const line = [[d.a.lat, d.a.lng], [d.b.lat, d.b.lng]];
                L.polyline(line, { color: '#16161b', weight: 9, opacity: 0.9, lineCap: 'butt', interactive: false }).addTo(layer);
                L.polyline(line, { color: litDoor === k ? '#22c55e' : '#ffffff', weight: 5, opacity: 1, lineCap: 'butt', interactive: false }).addTo(layer);
                // Draggable only for who manages the doors (the building's department).
                if (step === 'shape' || !manageDoors) return;
                const handle = L.marker([d.center.lat, d.center.lng], {
                    icon: doorIcon(k + 1, litDoor === k), draggable: true, bubblingMouseEvents: false, zIndexOffset: 1100,
                    keyboard: true, title: `Door ${k + 1}: drag along the wall to move it`,
                }).addTo(layer);
                handle.on('mouseover', () => setLitDoor(k));
                handle.on('mouseout', () => setLitDoor(null));
                handle.on('dragend', (e) => {
                    const ll = e.target.getLatLng();
                    const s = snapToOutline(points, ll.lat, ll.lng);
                    if (!s || s.distM > DOOR_SNAP_M) {
                        setDoorNote('A door has to sit on the outline: drop it on or next to a wall.');
                        e.target.setLatLng([d.center.lat, d.center.lng]);
                        return;
                    }
                    setDoorNote(null);
                    setDoors((prev) => prev.map((p, i) => (i === k ? { ...p, lat: s.lat, lng: s.lng } : p)));
                });
            });
        }

        if (step !== 'shape') return fitBand ? () => map.off('zoomend', fitBand) : undefined;

        // Move handle (shapes that are complete enough to have a middle).
        if (outline && points.length >= minPoints) {
            const start = shapeCentre(points, isOutline);
            const handle = L.marker([start.lat, start.lng], {
                icon: MOVE_ICON, draggable: true, bubblingMouseEvents: false, zIndexOffset: 1200,
                keyboard: true, title: 'Drag to move the whole shape',
            }).addTo(layer);
            const stamp = () => { vertexPressAt.current = Date.now(); };
            handle.on('mousedown', stamp);
            handle.getElement()?.addEventListener('touchstart', stamp, { passive: true });
            const offset = (ll) => ({ lat: ll.lat - start.lat, lng: ll.lng - start.lng });
            handle.on('drag', (e) => {
                const d = offset(e.target.getLatLng());
                setShape(points.map((p) => [p.lat + d.lat, p.lng + d.lng]));
            });
            handle.on('dragend', (e) => {
                stamp();
                const d = offset(e.target.getLatLng());
                setPoints((prev) => prev.map((p) => ({ lat: p.lat + d.lat, lng: p.lng + d.lng })));
                setDoors((prev) => prev.map((p) => ({ lat: p.lat + d.lat, lng: p.lng + d.lng })));
                setShift((sh) => ({ lat: sh.lat + d.lat, lng: sh.lng + d.lng }));
            });
        }

        points.forEach((p, k) => {
            const selected = anchor === k;
            const vm = L.marker([p.lat, p.lng], {
                icon: selected ? VERTEX_ICON_SELECTED : VERTEX_ICON, draggable: true, bubblingMouseEvents: false,
                zIndexOffset: selected ? 1000 : 0, title: selected ? 'Selected: the next corner joins here' : 'Tap to add corners after this one, or drag to move it',
            }).addTo(layer);
            const stamp = () => { vertexPressAt.current = Date.now(); };
            vm.on('mousedown', stamp);
            vm.getElement()?.addEventListener('touchstart', stamp, { passive: true });
            // Tap (not drag): select this corner; tap it again to let go.
            vm.on('click', () => {
                stamp();
                if (!canExtendFrom(points, k, { closed: isOutline })) {
                    setDrawNote('A path grows from its ends: tap its first or last point to continue it.');
                    return;
                }
                setDrawNote(null);
                setAnchor((a) => (a === k ? null : k));
            });
            vm.on('dragend', (e) => {
                stamp();
                const ll = e.target.getLatLng();
                setPoints((prev) => prev.map((q, i) => (i === k ? { lat: ll.lat, lng: ll.lng } : q)));
            });
        });
        return fitBand ? () => map.off('zoomend', fitBand) : undefined;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [points, step, candidates, isBuilding, isOutline, isBridge, record, kind, status, theme, doors, litDoor, anchor, manageDoors, widthM]);

    // Put a door where the outline was tapped (map or 3D view).
    const addDoorAt = (lat, lng) => {
        const s = snapToOutline(points, lat, lng);
        if (!s || s.distM > DOOR_SNAP_M) { setDoorNote(`Tap on or right next to the ${isBridge ? 'deck' : 'building'} outline.`); return; }
        const placed = placedDoors(points, doors);
        if (placed.length >= MAX_DOORS) { setDoorNote(`A building can have up to ${MAX_DOORS} doors.`); return; }
        // Two doors may not overlap: their centres at least half of each width apart.
        const crowded = placed.some((d) => Math.hypot(...toLocalMeters(d.lat, d.lng, s.lat, s.lng)) < (d.width + newDoorWidth) / 2);
        if (crowded) { setDoorNote(`There is ${aDoor} there already.`); return; }
        setDoorNote(null);
        setDoors((prev) => [...prev, { lat: s.lat, lng: s.lng, width_m: newDoorWidth }]);
    };
    const setDoorWidthAt = (k, width) => setDoors((prev) => prev.map((p, i) => (i === k ? { ...p, width_m: width } : p)));
    // Moving door k: tap a wall (map or 3D), or slide it along its wall.
    const [movingDoor, setMovingDoor] = useState(null);
    const fits = (k, s, width) => !placedDoors(points, doors).some((d, i) => i !== k
        && Math.hypot(...toLocalMeters(d.lat, d.lng, s.lat, s.lng)) < (d.width + width) / 2);
    const moveDoorTo = (k, lat, lng) => {
        const s = snapToOutline(points, lat, lng);
        if (!s || s.distM > DOOR_SNAP_M) { setDoorNote(`Tap on or right next to the ${isBridge ? 'deck' : 'building'} outline.`); return false; }
        if (!fits(k, s, doorWidth(doors[k]))) { setDoorNote(`That spot overlaps another ${doorWord}.`); return false; }
        setDoorNote(null);
        setDoors((prev) => prev.map((p, i) => (i === k ? { ...p, lat: s.lat, lng: s.lng } : p)));
        return true;
    };
    /** Slide door k along its wall by `metres` (minus = towards the wall's start). */
    const slideDoor = (k, metres) => {
        const f = doorFrames(points, doors)[k];
        if (!f) return;
        const [ae, an] = toLocalMeters(f.a.lat, f.a.lng, f.center.lat, f.center.lng);
        const [be, bn] = toLocalMeters(f.b.lat, f.b.lng, f.center.lat, f.center.lng);
        const len = Math.hypot(be - ae, bn - an) || 1;
        const p = fromLocalMeters(f.center.lat, f.center.lng, ((be - ae) / len) * metres, ((bn - an) / len) * metres);
        moveDoorTo(k, p.latitude, p.longitude);
    };
    const toggleMove = (k) => { setPlacingDoor(false); setDoorNote(null); setMovingDoor((m) => (m === k ? null : k)); setLitDoor(k); };
    /**
     * An entrance wherever an existing walking path (or staircase) crosses the outline: a building's
     * ground floor, a bridge's deck floor, and for a raised deck the ground paths into its staircases.
     */
    const findEntrances = () => {
        const deck = isBridge ? clampInt(deckFloor, 0, MAX_DECK_FLOOR, 1) : 0;
        const found = suggestEntrances(points, nodes, { floor: deck, links, walls: borders });
        if (deck > 0) {
            const feet = new Set(links.flatMap((l) => [String(l.node_a_id), String(l.node_b_id)]));
            found.push(...suggestEntrances(points, nodes, { floor: 0, links, walls: borders, onlyInto: feet }));
        }
        const placed = placedDoors(points, doors);
        const add = [];
        for (const s of found) {
            const taken = [...placed, ...add.map((a) => ({ ...a, width: newDoorWidth }))]
                .some((d) => Math.hypot(...toLocalMeters(d.lat, d.lng, s.lat, s.lng)) < (d.width + newDoorWidth) / 2);
            if (!taken && placed.length + add.length < MAX_DOORS) add.push(s);
        }
        setPlacingDoor(false);
        setMovingDoor(null);
        if (add.length) {
            setDoors((prev) => [...prev, ...add.map((s) => ({ lat: s.lat, lng: s.lng, width_m: newDoorWidth }))]);
            setDoorNote(`Added ${add.length} ${add.length === 1 ? doorWord : `${doorWord}s`} where paths come in. Check them, then Save.`);
        } else {
            setDoorNote(found.length ? `Every path that comes in already has ${aDoor}.`
                : isBridge ? 'No path or staircase comes in across the outline. Connect the deck to the ground first.'
                    : 'No path crosses the outline yet. Lay route nodes up to the building first, or add doors by hand.');
        }
    };
    const removeDoor = (k) => { setDoors((prev) => prev.filter((_, i) => i !== k)); setLitDoor(null); setDoorNote(null); setMovingDoor(null); };


    // Tapping the map adds the next corner / point.
    useEffect(() => {
        if (!map || step !== 'shape') return undefined;
        const onClick = (e) => {
            if (Date.now() - vertexPressAt.current < 350) return;
            const at = { lat: e.latlng.lat, lng: e.latlng.lng };
            // The new point joins ONLY the selected one (see shapeDraft.js).
            const next = addJoined(points, anchor, at, { closed: isOutline });
            if (!next) { setDrawNote('A path grows from its ends: tap its first or last point to continue it.'); return; }
            historyRef.current.push({ points, anchor });
            setDrawNote(null);
            setPoints(next.points);
            setAnchor(next.anchor);
            setSource((s) => (s === 'osm' && ref ? s : 'custom'));
        };
        map.on('click', onClick);
        return () => map.off('click', onClick);
    }, [map, step, ref, points, anchor, isOutline]);

    // Undo: back one addition (corner + which one was selected).
    const undo = () => {
        const last = historyRef.current.pop();
        if (last) { setPoints(last.points); setAnchor(last.anchor); return; }
        setPoints((p) => p.slice(0, -1));
        setAnchor(null);
    };

    const save = async () => {
        if (isOutline && !name.trim()) { onError(`A ${noun} needs a name`); return; }
        if (points.length < minPoints) { onError(`A ${noun} needs at least ${minPoints} points`); return; }
        if (isBridge && closed && !closedReason.trim()) { onError('Add the reason students will see while the bridge is closed'); return; }
        setSaving(true);
        try {
            if (isBridge) {
                const data = {
                    name: name.trim(),
                    short_name: shortName.trim() || null,
                    kind,
                    polygon: points,
                    deck_floor: clampInt(deckFloor, 0, MAX_DECK_FLOOR, 1),
                    deck_height_m: deckHeight.trim() === '' ? null : Math.min(30, Math.max(0, Number(deckHeight) || 0)) || null,
                    roofed,
                    closed,
                    closed_reason: closed ? closedReason.trim() : null,
                    // Re-snapped onto the (possibly reshaped) outline, like a building's.
                    doors: placedDoors(points, doors).map((d) => ({ lat: d.lat, lng: d.lng, width_m: d.width })),
                    status,
                    source,
                };
                const saved = record ? await api.updateBridge(record.id, data) : await api.createBridge(data);
                let message = record ? (moved ? 'Bridge moved' : 'Bridge updated') : `${data.name} added`;
                if (!record && layNodes) {
                    const res = await api.generateBridgeNodes(saved.id, { spacing_m: clampInt(spacing, 3, 50, 6), stairs: raisedDeck && endStairs });
                    message += ` with ${res.created} route nodes on the deck${stairsNote(res)}`;
                }
                onSaved(message);
            } else if (isBuilding) {
                const data = {
                    name: name.trim(),
                    short_name: shortName.trim() || null,
                    floors: clampInt(floors, 1, 50, 1),
                    height_m: heightM.trim() === '' ? null : Math.min(200, Math.max(2, Number(heightM) || 0)) || null,
                    status,
                    campus,
                    polygon: points,
                    // Re-snapped onto the (possibly reshaped) outline; doors left
                    // far from it by a reshape are dropped.
                    ...(manageDoors ? { doors: placedDoors(points, doors).map((d) => ({ lat: d.lat, lng: d.lng, width_m: d.width })) } : {}),
                    source,
                    osm_ref: ref,
                    ...(canChangeDepartment ? { department_id: departmentId === '' ? null : Number(departmentId) } : {}),
                    // Rooms filed here follow a moved building: the server moves
                    // them with it in one transaction (whoever placed each room).
                    ...(record && moved && nodesInside.length ? { move_nodes_by: shift } : {}),
                    ...(departmentChanged ? { transfer_nodes: handOverNodes } : {}),
                };
                const saved = record ? await api.updateBuilding(record.id, data) : await api.createBuilding(data);
                const carried = Number(saved?.nodes_moved) || 0;
                const handed = Number(saved?.nodes_transferred) || 0;
                const newOwner = departments.find((d) => String(d.id) === String(departmentId))?.name;
                onSaved(record
                    ? (handed
                        ? `${data.name} and its ${handed} ${handed === 1 ? 'node' : 'nodes'} now belong to ${newOwner || 'no department'}`
                        : departmentChanged
                            ? `${data.name} now belongs to ${newOwner || 'no department'}`
                            : carried ? `Building moved with ${carried} node(s) inside` : (moved ? 'Building moved' : 'Building updated'))
                    : `${data.name} labelled`);
            } else {
                const data = { name: name.trim() || null, kind, status, width_m: widthM.trim() === '' ? null : Number(widthM), coordinates: points, source, osm_ref: ref };
                const saved = record ? await api.updatePathway(record.id, data) : await api.createPathway(data);
                let message = record ? 'Pathway updated' : 'Pathway added';
                if (!record && layNodes) {
                    const res = await api.generatePathwayNodes(saved.id, { spacing_m: clampInt(spacing, 3, 50, 8), campus: 'A' });
                    message += ` with ${res.created} route nodes`;
                }
                onSaved(message);
            }
        } catch (err) {
            onError(err.message);
        } finally {
            setSaving(false);
        }
    };

    const layRouteNodes = async () => {
        if (!record) return;
        setSaving(true);
        try {
            const res = isBridge
                ? await api.generateBridgeNodes(record.id, { spacing_m: clampInt(spacing, 3, 50, 6), stairs: raisedDeck && endStairs })
                : await api.generatePathwayNodes(record.id, { spacing_m: clampInt(spacing, 3, 50, 8) });
            const laid = res.created > 0 ? `${res.created} route nodes laid along the ${noun}` : `Every spot along this ${noun} already has a route node`;
            onSaved(`${laid}${stairsNote(res)}`);
        } catch (err) {
            onError(err.message);
        } finally {
            setSaving(false);
        }
    };

    if (step === 'shape') {
        const ready = points.length >= minPoints;
        let hint;
        if (points.length > 0) {
            const part = isOutline ? 'corner' : 'point';
            hint = drawNote || (anchor !== null
                ? `The green ${part} is selected: tap the map to add a ${part} joined only to it, and keep tapping to carry on from there. Tap it again to let go.`
                : ready
                ? `Tap a ${part} to add new ones after it, drag one to reshape, or drag the centre handle to move the whole ${noun}. Then press Next.`
                : `Tap to add the next ${isOutline ? 'corner' : 'point'} (${points.length} of at least ${minPoints}).`);
        } else if (record) {
            hint = `Tap the map to draw the new ${isOutline ? 'outline' : 'line'}.`;
        } else if (isBridge) {
            hint = 'Tap the map at each corner of the deck (4 corners for a straight bridge). Its walking line runs along the long side.';
        } else if (osmError) {
            hint = `Base map shapes unavailable (${osmError}). Tap the map to draw the ${isOutline ? 'corners' : 'points'}.`;
        } else if (!osm) {
            hint = 'Reading the base map shapes… You can already tap the map to draw.';
        } else {
            hint = isBuilding
                ? `Tap a dashed outline to label that building (${candidates.length} unlabelled), or tap the map to draw the corners of a new one.`
                : `Tap a dashed road or path to add it (${candidates.length} not added yet), or tap the map to draw a new walkway.`;
        }
        return (
            <ActionBar title={record ? `Reshape ${noun}` : (isBuilding ? 'Label a building' : isBridge ? 'Add a bridge' : 'Add a pathway')} hint={hint}>
                <button className="ui-btn ui-btn-secondary" onClick={undo} disabled={points.length === 0}>Undo</button>
                <button className="ui-btn ui-btn-primary" onClick={() => setStep('details')} disabled={!ready}>Next</button>
                <button className="ui-btn ui-btn-danger" onClick={record ? () => { setPoints(initialPoints()); setShift({ lat: 0, lng: 0 }); setAnchor(null); historyRef.current = []; setStep('details'); } : onClose}>
                    {record ? 'Back' : 'Cancel'}
                </button>
            </ActionBar>
        );
    }

    const floorList = buildingFloors({ floors: clampInt(floors, 1, 50, 1) });

    const closeDoors = () => { setDoorsOpen(false); setPlacingDoor(false); setMovingDoor(null); setDoorNote(null); setLitDoor(null); };
    const frames = isOutline && points.length >= 3 ? doorFrames(points, doors) : [];
    const doorDialog = doorsOpen && (
        <StairModal
            title={isBridge ? 'Manage entrances' : 'Manage doors'}
            subtitle={name.trim() || shortName.trim() || (isBridge ? 'Bridge' : 'Building')}
            onClose={closeDoors}
            closeLabel={`Close ${doorWord} editor`}
            footer={<button type="button" className="ui-btn ui-btn-primary" onClick={closeDoors}>Done</button>}
        >
            <div className="cf-doors-modal">
                <BuildingPreview3D
                    polygon={points} doors={doors}
                    floors={isBridge ? 1 : clampInt(floors, 1, 50, 1)}
                    heightM={isBridge ? 2.6 : (heightM.trim() === '' ? null : Number(heightM) || null)}
                    placing={placingDoor || movingDoor !== null} highlight={movingDoor ?? litDoor}
                    onWallPick={(p) => {
                        if (movingDoor !== null) { if (moveDoorTo(movingDoor, p.lat, p.lng)) setMovingDoor(null); return; }
                        addDoorAt(p.lat, p.lng);
                    }}
                    newDoorWidth={movingDoor !== null ? doorWidth(doors[movingDoor]) : newDoorWidth}
                    movingDoor={movingDoor}
                    onDoorPick={(k) => toggleMove(k)}
                    height="var(--cf-doors-h)"
                />
                <div className="cf-doors-side">
                    <div className="cf-width-row">
                        <span className="ui-label" style={{ margin: 0 }}>New {doorWord} width</span>
                        <WidthStepper value={newDoorWidth} onChange={setNewDoorWidth} label={`New ${doorWord} width`} />
                    </div>
                    <button
                        type="button" className={`ui-btn ui-btn-block ${placingDoor ? 'ui-btn-primary' : 'ui-btn-secondary'}`}
                        aria-pressed={placingDoor} onClick={() => { setMovingDoor(null); setPlacingDoor((v) => !v); setDoorNote(null); }}
                    >
                        {placingDoor ? `Done adding ${doorWord}s` : `Add ${doorWord}`}
                    </button>
                    <button type="button" className="ui-btn ui-btn-secondary ui-btn-block" onClick={findEntrances}>
                        Find entrances
                    </button>
                    <p className="ui-hint" style={{ margin: 0 }} role="status">
                        {doorNote || (movingDoor !== null
                            ? `Moving ${doorWord} ${movingDoor + 1}: tap a wall in the 3D view, or slide it with the arrows.`
                            : placingDoor ? `Tap a wall in the 3D view to put ${aDoor} there.`
                                : `Tap ${aDoor}, or press Move, to change where it is. Find entrances adds one wherever a path comes in.`)}
                    </p>
                    {frames.length > 0 ? (
                        <ul className="cf-doors">
                            {frames.map((d, k) => (
                                <li
                                    key={`${d.center.lat}-${d.center.lng}`} className={movingDoor === k ? 'is-moving' : ''}
                                    onMouseEnter={() => setLitDoor(k)} onMouseLeave={() => setLitDoor(null)}
                                >
                                    <div className="cf-door-top">
                                        <span className="cf-door-num" aria-hidden="true">{k + 1}</span>
                                        <span className="cf-door-name">{DoorWord} {k + 1}<span>Faces {facingWords(d.normalDeg)}</span></span>
                                        <div className="cf-door-actions">
                                            <button
                                                type="button" className={`cf-door-btn${movingDoor === k ? ' is-on' : ''}`}
                                                aria-pressed={movingDoor === k} onClick={() => toggleMove(k)} aria-label={`Move ${doorWord} ${k + 1}`}
                                            >
                                                {movingDoor === k ? 'Done' : 'Move'}
                                            </button>
                                            <button type="button" className="cf-door-btn is-danger" onClick={() => removeDoor(k)} aria-label={`Remove ${doorWord} ${k + 1}`}>Remove</button>
                                        </div>
                                    </div>
                                    <div className="cf-door-row">
                                        <span className="cf-door-row-label">Width</span>
                                        <WidthStepper value={doorWidth(doors[k])} onChange={(w) => setDoorWidthAt(k, w)} label={`${DoorWord} ${k + 1} width`} />
                                    </div>
                                    {movingDoor === k && (
                                        <div className="cf-door-slide" role="group" aria-label={`Slide door ${k + 1} along its wall`}>
                                            <button type="button" className="cf-width-btn" onClick={() => slideDoor(k, -0.25)} aria-label="Slide back 25 centimetres">&lsaquo;</button>
                                            <span>Slide along the wall</span>
                                            <button type="button" className="cf-width-btn" onClick={() => slideDoor(k, 0.25)} aria-label="Slide on 25 centimetres">&rsaquo;</button>
                                        </div>
                                    )}
                                </li>
                            ))}
                        </ul>
                    ) : (
                        <p className="cf-doors-empty">
                            {isBridge
                                ? 'No entrances yet. Routes can get on this deck from any side until you add one. Find entrances puts one where each path comes in to a staircase or the deck.'
                                : 'No doors yet. Routes can enter this building from any side until you add one.'}
                        </p>
                    )}
                </div>
            </div>
        </StairModal>
    );

    return (
        <>
        {doorDialog}
        <Sheet
            title={record ? `Edit ${noun}` : (isBuilding ? 'New building' : isBridge ? 'New bridge' : 'New pathway')}
            subtitle={`${source === 'osm' ? 'From base map' : 'Drawn'} · ${points.length} points`}
            onClose={onClose}
            footer={(
                <div className="mt-sheet-foot">
                    <button className="ui-btn ui-btn-primary" onClick={save} disabled={saving}>
                        {saving && <span className="btn-spin" aria-hidden="true" />}
                        {saving ? 'Saving' : 'Save'}
                    </button>
                    <button className="ui-btn ui-btn-secondary" onClick={() => setStep('shape')} disabled={saving}>Move / reshape</button>
                    <button className="ui-btn ui-btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
                </div>
            )}
        >
            <div className="mt-form">
                <div className="ui-field">
                    <label className="ui-label" htmlFor="cf-name">Name {isOutline && <span className="ui-req">*</span>}</label>
                    <input
                        id="cf-name" className="ui-input" value={name} onChange={(e) => setName(e.target.value)}
                        placeholder={isBuilding ? 'e.g. College of Computing Studies' : isBridge ? 'e.g. Campus A to B Footbridge' : 'e.g. Main covered walk'}
                    />
                </div>

                {isBridge && (
                    <>
                        <div className="mt-grid3">
                            <div className="ui-field">
                                <label className="ui-label" htmlFor="cf-short">Map label</label>
                                <input id="cf-short" className="ui-input" value={shortName} maxLength={32} onChange={(e) => setShortName(e.target.value)} placeholder="Footbridge" />
                            </div>
                            <div className="ui-field">
                                <label className="ui-label" htmlFor="cf-deck">Deck</label>
                                <select id="cf-deck" className="ui-select" value={deckFloor} onChange={(e) => setDeckFloor(e.target.value)} aria-describedby="cf-deck-hint">
                                    {Array.from({ length: MAX_DECK_FLOOR + 1 }, (_, f) => <option key={f} value={String(f)}>{deckLevelLabel(f)}</option>)}
                                </select>
                            </div>
                            <div className="ui-field">
                                <label className="ui-label" htmlFor="cf-deck-h">Height (m)</label>
                                <input
                                    id="cf-deck-h" className="ui-input ui-num" type="number" inputMode="decimal" min="0" max="30" step="0.5"
                                    value={deckHeight} onChange={(e) => setDeckHeight(e.target.value)}
                                    placeholder={(clampInt(deckFloor, 0, MAX_DECK_FLOOR, 1) * 3.2).toFixed(1)}
                                />
                            </div>
                        </div>
                        <span className="ui-hint" id="cf-deck-hint">
                            {raisedDeck
                                ? 'Raised: its route nodes are on that floor, so routes reach the deck only by a staircase. After laying them, use "Connect to ground" to join each end to the ground routes.'
                                : 'At ground level: its route nodes join the paths around it directly.'}
                        </span>
                        {BRIDGE_KINDS.length > 1 && (
                            <div className="ui-field">
                                <label className="ui-label" htmlFor="cf-bkind">Type</label>
                                <select id="cf-bkind" className="ui-select" value={kind} onChange={(e) => setKind(e.target.value)}>
                                    {BRIDGE_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
                                </select>
                            </div>
                        )}
                        <label className="mt-check">
                            <input type="checkbox" checked={roofed} onChange={(e) => setRoofed(e.target.checked)} />
                            <span>It has a roof (its route nodes count as sheltered when it rains)</span>
                        </label>
                        <label className="mt-check">
                            <input type="checkbox" checked={closed} onChange={(e) => setClosed(e.target.checked)} />
                            <span>Closed: routes do not cross it until you reopen it (for an event, repairs)</span>
                        </label>
                        {closed && (
                            <div className="ui-field">
                                <label className="ui-label" htmlFor="cf-closed-reason">Reason students see <span className="ui-req">*</span></label>
                                <input
                                    id="cf-closed-reason" className="ui-input" value={closedReason} maxLength={160}
                                    onChange={(e) => setClosedReason(e.target.value)} placeholder="e.g. Campus A event until 5 PM"
                                    aria-invalid={closedReason.trim() === '' ? 'true' : undefined}
                                />
                                <span className="ui-hint">Shown on the map and when the bridge was the only way.</span>
                            </div>
                        )}
                    </>
                )}

                {isBuilding ? (
                    <>
                        <div className="mt-grid3">
                            <div className="ui-field">
                                <label className="ui-label" htmlFor="cf-short">Map label</label>
                                <input id="cf-short" className="ui-input" value={shortName} maxLength={32} onChange={(e) => setShortName(e.target.value)} placeholder="CCS" />
                            </div>
                            <div className="ui-field">
                                <label className="ui-label" htmlFor="cf-floors">Floors</label>
                                <input id="cf-floors" className="ui-input ui-num" type="number" inputMode="numeric" min="1" max="50" value={floors} onChange={(e) => setFloors(e.target.value)} />
                            </div>
                            <div className="ui-field">
                                <label className="ui-label" htmlFor="cf-height">Height (m)</label>
                                <input
                                    id="cf-height" className="ui-input ui-num" type="number" inputMode="decimal" min="2" max="200" step="0.5"
                                    value={heightM} onChange={(e) => setHeightM(e.target.value)}
                                    placeholder={(clampInt(floors, 1, 50, 1) * 3.2).toFixed(1)}
                                    aria-describedby="cf-height-hint"
                                />
                            </div>
                        </div>
                        <span className="ui-hint" id="cf-height-hint">
                            Height is optional: it sets how tall the building looks in 3D and how long its shadow is. Blank estimates it from the floors.
                        </span>
                        <p className="ui-hint" style={{ margin: 0 }}>
                            Floors count the ground floor: {floorList.length === 1 ? 'a 1-floor building has only the ground floor' : `rooms inside go on the ground floor up to floor ${floorList.length}`}.
                        </p>
                        <div className="ui-field">
                            <label className="ui-label" htmlFor="cf-dept">Department</label>
                            <select
                                id="cf-dept" className="ui-select" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}
                                disabled={!canChangeDepartment} aria-describedby={canChangeDepartment ? undefined : 'cf-dept-hint'}
                            >
                                <option value="">None / shared</option>
                                {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                            </select>
                            {!canChangeDepartment && <span className="ui-hint" id="cf-dept-hint">Only an admin can file it under another department.</span>}
                            {departmentChanged && nodesToHandOver.length > 0 && (
                                <label className="mt-check cf-handover">
                                    <input type="checkbox" checked={handOverNodes} onChange={(e) => setHandOverNodes(e.target.checked)} />
                                    <span>
                                        Transfer ownership of the {nodesToHandOver.length} {nodesToHandOver.length === 1 ? 'room or route' : 'rooms and routes'} inside
                                        {newOwnerName ? ` to ${newOwnerName}` : ' to no department (shared)'}
                                        <small>
                                            Nothing is deleted: what {staffOwners.length ? `${joinNames(staffOwners)} or earlier` : 'earlier'} staff added
                                            keeps its spot, floor, name and staircases.
                                            {' '}{newOwnerName
                                                ? `${newOwnerName} staff manage them either way, because they manage the building.`
                                                : 'Only admins manage them either way, because the building has no department.'}
                                            {' '}Unticked, they keep {currentOwners.length === 1 && !currentOwners[0]
                                                ? 'no department label'
                                                : `the ${joinNames(currentOwners.map((o) => o || 'no department'))} label`}.
                                        </small>
                                    </span>
                                </label>
                            )}
                        </div>
                        {points.length >= 3 && (
                            <section className="mt-pathnodes" aria-labelledby="cf-doors-title">
                                <span className="ui-label" id="cf-doors-title">Doors</span>
                                {manageDoors ? (
                                    <button type="button" className="ui-btn ui-btn-secondary ui-btn-block" onClick={() => setDoorsOpen(true)} disabled={saving}>
                                        Manage doors
                                    </button>
                                ) : null}
                                <p className="ui-hint" style={{ margin: 0 }}>
                                    {!manageDoors
                                        ? `${doors.length ? `${doors.length} ${doors.length === 1 ? 'door' : 'doors'}. ` : 'No doors yet. '}Doors are managed by ${ownerName} staff.`
                                        : doors.length
                                            ? 'Routes go in and out of this building only through its doors.'
                                            : 'No doors yet, so routes can enter from any side.'}
                                </p>
                            </section>
                        )}
                        {moved && nodesInside.length > 0 && (
                    <p className="ui-hint" style={{ margin: 0 }}>
                        The {nodesInside.length} {nodesInside.length === 1 ? 'room' : 'rooms'} inside move with the building and keep their spots in it.
                    </p>
                )}
                {record && onManageNodes && (
                            <section className="mt-pathnodes" aria-labelledby="cf-nodes-title">
                                <span className="ui-label" id="cf-nodes-title">Nodes</span>
                                <button type="button" className="ui-btn ui-btn-secondary ui-btn-block" onClick={() => onManageNodes(record)} disabled={saving}>
                                    Manage nodes
                                </button>
                                <p className="ui-hint" style={{ margin: 0 }}>Add, edit and remove this building's rooms and route nodes floor by floor. Save building changes first: this closes the editor.</p>
                            </section>
                        )}
                    </>
                ) : !isBridge && (
                    <div className="ui-field">
                        <label className="ui-label" htmlFor="cf-kind">Type</label>
                        <select id="cf-kind" className="ui-select" value={kind} onChange={(e) => setKind(e.target.value)} aria-describedby="cf-kind-hint">
                            {PATHWAY_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
                        </select>
                        <span className="ui-hint" id="cf-kind-hint">Route nodes on a covered walkway count as sheltered when it rains.</span>
                    </div>
                )}
                {!isOutline && (
                    <div className="ui-field">
                        <label className="ui-label" htmlFor="cf-width">Width (m)</label>
                        <input
                            id="cf-width" className="ui-input" type="number" inputMode="decimal" min="1" max="30" step="0.5"
                            value={widthM} onChange={(e) => setWidthM(e.target.value)}
                            placeholder={String(PATHWAY_WIDTH_M[kind] ?? PATHWAY_WIDTH_M.walkway)} aria-describedby="cf-width-hint"
                        />
                        <span className="ui-hint" id="cf-width-hint">How wide it really is, so the map and the 3D views match the ground. Blank uses the usual width for its type.</span>
                    </div>
                )}

                {isBridge && points.length >= 3 && (
                    <section className="mt-pathnodes" aria-labelledby="cf-bdoors-title">
                        <span className="ui-label" id="cf-bdoors-title">Entrances</span>
                        <button type="button" className="ui-btn ui-btn-secondary ui-btn-block" onClick={() => setDoorsOpen(true)} disabled={saving}>
                            Manage entrances
                        </button>
                        <p className="ui-hint" style={{ margin: 0 }}>
                            {doors.length
                                ? `${doors.length} ${doors.length === 1 ? 'entrance' : 'entrances'}: routes get on and off the deck only through them${raisedDeck ? ' or its staircases (the ground under it stays open)' : ''}.`
                                : 'No entrances yet, so routes can get on the deck from any side, even sideways into a building next to it. In Manage entrances, Find entrances puts one where each path comes in.'}
                        </p>
                    </section>
                )}

                {isBridge && record && onManageNodes && (
                    <section className="mt-pathnodes" aria-labelledby="cf-bnodes-title">
                        <span className="ui-label" id="cf-bnodes-title">Nodes</span>
                        <button type="button" className="ui-btn ui-btn-secondary ui-btn-block" onClick={() => onManageNodes(record)} disabled={saving}>
                            Manage nodes
                        </button>
                        <p className="ui-hint" style={{ margin: 0 }}>Add, edit and remove the route nodes on the deck. Save bridge changes first: this closes the editor.</p>
                    </section>
                )}

                {isBridge && record && raisedDeck && onConnectBridge && (
                    <section className="mt-pathnodes" aria-labelledby="cf-connect-title">
                        <span className="ui-label" id="cf-connect-title">Connect to ground routes</span>
                        <button type="button" className="ui-btn ui-btn-secondary ui-btn-block" onClick={() => onConnectBridge(record)} disabled={saving}>
                            Connect to ground
                        </button>
                        <p className="ui-hint" style={{ margin: 0 }}>
                            Join a deck node to an existing ground route node with a staircase, like a building's stairs. Do it once for each end.
                            Save bridge changes first: this closes the editor.
                        </p>
                    </section>
                )}

                {!isBuilding && (
                    <div className="mt-pathnodes">
                        {record ? (
                            <p className="ui-hint" style={{ margin: 0 }}>
                                {isBridge
                                    ? 'Routing uses route nodes. Lay them along the deck, on its floor, in one step (spots that already have one are skipped).'
                                    : 'Routing uses route nodes. Lay them along this pathway in one step (spots that already have one are skipped).'}
                            </p>
                        ) : (
                            <label className="mt-check">
                                <input type="checkbox" checked={layNodes} onChange={(e) => setLayNodes(e.target.checked)} />
                                <span>{isBridge ? 'Also lay route nodes along the deck so routes can cross it' : 'Also lay route nodes along it so routes can use it'}</span>
                            </label>
                        )}
                        {raisedDeck && (record || layNodes) && (
                            <label className="mt-check" style={{ alignItems: 'flex-start' }}>
                                <input type="checkbox" checked={endStairs} onChange={(e) => setEndStairs(e.target.checked)} aria-describedby="cf-stairs-hint" />
                                <span>
                                    Also build new stairs down to new ground nodes at each end
                                    <small id="cf-stairs-hint" className="cf-stairs-hint">
                                        Only when there is no ground route where the stairs come down: each end gets a ground node one stair-length beyond
                                        the deck (35&deg; stairs). Usually leave this off and use "Connect to ground" to join existing routes.
                                    </small>
                                </span>
                            </label>
                        )}
                        <div className="mt-pathnodes-row">
                            <label className="ui-label" htmlFor="cf-spacing" style={{ margin: 0 }}>Every</label>
                            <input id="cf-spacing" className="ui-input ui-num" type="number" min="3" max="50" value={spacing} onChange={(e) => setSpacing(e.target.value)} style={{ width: 72 }} />
                            <span className="ui-hint" style={{ margin: 0 }}>m</span>
                            {record && (
                                <button className="ui-btn ui-btn-secondary ui-btn-sm" onClick={layRouteNodes} disabled={saving}>
                                    {raisedDeck && endStairs ? 'Lay route nodes and stairs' : 'Lay route nodes'}
                                </button>
                            )}
                        </div>
                    </div>
                )}
            </div>
        </Sheet>
        </>
    );
}

export const CAMPUS_EDITOR_CSS = `
    .cf-doors-modal { --cf-doors-h: min(62vh, 560px); display: grid; grid-template-columns: minmax(0, 1.7fr) minmax(260px, 1fr); gap: 16px; align-items: start; }
    .cf-doors-side { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
    .cf-doors-side .cf-doors { max-height: calc(var(--cf-doors-h) - 110px); overflow-y: auto; overscroll-behavior: contain; }
    .cf-width-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
    .cf-width { flex: none; display: inline-flex; align-items: center; gap: 2px; padding: 2px; border-radius: 10px;
        border: 1px solid rgba(255,255,255,0.14); background: rgba(255,255,255,0.04); }
    .cf-width-btn { width: 32px; height: 32px; border: 0; border-radius: 50%; background: transparent; color: #fff;
        font: inherit; font-size: 18px; font-weight: 700; line-height: 1; cursor: pointer; transition: background-color 160ms ease, transform 160ms ease; }
    .cf-width-btn:hover:not(:disabled) { background: rgba(255,255,255,0.1); }
    .cf-width-btn:active:not(:disabled) { transform: scale(0.92); }
    .cf-width-btn:disabled { opacity: 0.35; cursor: default; }
    .cf-width-btn:focus-visible, .cf-width-input:focus-visible { outline: 2px solid #4ade80; outline-offset: 1px; }
    .cf-width-input { width: 40px; height: 30px; border: 0; background: transparent; color: #fff; text-align: right;
        font: inherit; font-size: 14px; font-weight: 700; }
    .cf-width-unit { padding-right: 4px; font-size: 13px; color: rgba(255,255,255,0.62); }
    @media (max-width: 760px) { .cf-width-btn { width: 40px; height: 40px; } }
    .cf-door-slide { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 2px;
        border-radius: 10px; border: 1px solid rgba(74, 222, 128, 0.4); background: rgba(74, 222, 128, 0.06);
        font-size: 13px; font-weight: 600; color: rgba(255,255,255,0.8); animation: uiFadeUp var(--dur-base, 220ms) var(--ease-out, ease) both; }
    .cf-door-slide .cf-width-btn { font-size: 22px; }
    .cf-doors-empty { margin: 0; padding: 14px 12px; border: 1px dashed rgba(255,255,255,0.14); border-radius: 12px; font-size: 13px; line-height: 1.45; color: rgba(255,255,255,0.62); }
    @media (max-width: 760px) {
        .cf-doors-modal { --cf-doors-h: 46vh; grid-template-columns: 1fr; }
        .cf-doors-side .cf-doors { max-height: none; }
    }
    .cf-doors { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
    .cf-doors li { flex-shrink: 0; display: flex; flex-direction: column; gap: 8px; padding: 10px;
        border: 1px solid rgba(255,255,255,0.1); border-radius: 12px; background: rgba(255,255,255,0.03);
        transition: border-color 160ms ease, background-color 160ms ease; }
    .cf-doors li:hover { border-color: rgba(74, 222, 128, 0.45); }
    .cf-doors li.is-moving { border-color: rgba(74, 222, 128, 0.6); background: rgba(74, 222, 128, 0.06); }
    .cf-door-top { display: flex; align-items: center; gap: 10px; min-width: 0; }
    .cf-door-actions { flex: none; display: flex; gap: 6px; }
    .cf-door-btn { min-height: 36px; padding: 0 14px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.14);
        background: #0a0a0c; color: #fff; font: inherit; font-size: 13px; font-weight: 700; cursor: pointer; white-space: nowrap;
        transition: background-color 160ms ease, border-color 160ms ease, color 160ms ease, transform 160ms ease; }
    .cf-door-btn:hover { background: #18181c; border-color: rgba(255,255,255,0.26); }
    .cf-door-btn:active { transform: scale(0.97); }
    .cf-door-btn:focus-visible { outline: 2px solid #4ade80; outline-offset: 2px; }
    .cf-door-btn.is-on { background: #15803d; border-color: #15803d; }
    .cf-door-btn.is-danger { color: #ff8a96; }
    .cf-door-btn.is-danger:hover { border-color: rgba(255, 85, 102, 0.55); }
    .cf-door-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding-left: 36px; }
    .cf-door-row-label { font-size: 13px; font-weight: 600; color: rgba(255,255,255,0.7); }
    @media (max-width: 480px) {
        .cf-door-top { flex-wrap: wrap; }
        .cf-door-actions { flex: 1 1 100%; }
        .cf-door-btn { flex: 1 1 0; min-height: 44px; }
        .cf-door-row { padding-left: 0; }
    }
    .cf-door-num, .cf-door { display: grid; place-items: center; width: 26px; height: 26px; border-radius: 50%;
        background: #fff; color: #0a0a0c; font-size: 12px; font-weight: 800; border: 2px solid #15803d; box-shadow: 0 1px 4px rgba(0,0,0,0.45); }
    .cf-door { cursor: grab; transition: transform 160ms cubic-bezier(0.34, 1.56, 0.64, 1), background-color 160ms ease; }
    .cf-door.is-lit, .cf-door:hover { transform: scale(1.15); background: #22c55e; color: #fff; }
    .cf-door-num { flex: none; }
    .cf-door-name { flex: 1; min-width: 0; display: flex; flex-direction: column; font-size: 14px; font-weight: 700; }
    .cf-door-name span { font-size: 12px; font-weight: 500; color: rgba(255,255,255,0.62); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    @media (prefers-reduced-motion: reduce) { .cf-door { transition: none; } }
    .mt-pathnodes { display: flex; flex-direction: column; gap: 8px; padding-top: 10px; border-top: 1px solid rgba(255,255,255,0.08); }
    .mt-pathnodes-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .mt-check { display: flex; align-items: center; gap: 10px; min-height: 40px; font-size: 13px; font-weight: 600; cursor: pointer; }
    .mt-check input { width: 18px; height: 18px; accent-color: #15803d; }
    .cf-handover { align-items: flex-start; padding: 10px 12px; margin-top: 4px; border-radius: 12px;
        border: 1px solid rgba(74, 222, 128, 0.35); background: rgba(74, 222, 128, 0.06); animation: uiFadeUp var(--dur-base, 220ms) var(--ease-out, ease) both; }
    .cf-handover input { flex: none; margin-top: 2px; }
    .cf-stairs-hint { display: block; margin-top: 3px; font-size: 12px; font-weight: 500; color: rgba(255,255,255,0.62); line-height: 1.4; }
    .cf-handover small { display: block; margin-top: 3px; font-size: 12px; font-weight: 500; color: rgba(255,255,255,0.62); line-height: 1.4; }
    .cf-move {
        width: 36px; height: 36px; display: grid; place-items: center; border-radius: 50%; cursor: move;
        background: #15803d; color: #fff; border: 2px solid #fff; box-shadow: 0 2px 10px rgba(0,0,0,0.45);
        transition: transform 160ms cubic-bezier(0.34, 1.56, 0.64, 1);
    }
    .leaflet-marker-icon:hover > .cf-move { transform: scale(1.08); }
    .leaflet-dragging .cf-move { transform: scale(1.12); }
`;
