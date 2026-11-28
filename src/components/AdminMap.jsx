import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import L from 'leaflet';
import { api } from '../api';
import { useWeather } from '../useWeather';
import AdminDepartments from './AdminDepartments';
import AdminStudents from './AdminStudents';
import AdminWeather from './AdminWeather';
import AdminActivity from './AdminActivity';
import AdminCourses from './AdminCourses';
import AdminAnnouncements from './AdminAnnouncements';
import { C, TYPE, PANEL_RADIUS, RADIUS, MAP_ZOOM_CSS, ELEVATION, PILL, TAP } from '../uiTokens';
import { usePresence, useHold, Collapse } from '../motion';
import { IDLE, TOOL_ADD, TOOL_MOVE, TOOL_PIN, TOOL_WALLS, TOOL_BUILDING, TOOL_PATHWAY, TOOL_BRIDGE, TOOL_AREA, TOOL_AREAS, TOOL_OBJECTS, resolveTool, resolveMode, surfaceFor } from '../toolState';
import ObjectPalette from './ObjectPalette';
import { bordersWithGates, objectDefaults, snapGateToWall, kindLabel as objectKindLabel } from '../campusObjects';
import CampusEditor, { CAMPUS_EDITOR_CSS } from './CampusEditor';
import CampusAreaEditor from './CampusAreaEditor';
import QrSheet from './QrSheet';
import { nodeArea, buildingArea, campusMatcher } from '../campusAreas';
import ManageNodes, { MANAGE_NODES_CSS } from './ManageNodes';
import { confirmAction } from './ConfirmDialog';
import ScrollWindow from './ScrollWindow';
import SunTimeSlider from './SunTimeSlider';
import { useSatelliteSettings, useSatelliteLayer } from '../useSatellite';
import { sunPosition } from '../sunShadow';
import { drawBuildings, drawBridges, drawPathways, drawShadows, bindLabelZoom, prepareCampusPanes, drawFloorGuide, floorLiftDeg, drawStairs25D, CAMPUS_COLORS, drawSkyTint, drawWalls25D, drawCampusObjects, paneLayerGroup } from '../campusLayers';
import { buildingAt, nodePlaceLabel, floorCountLabel, statusLabel, kindLabel, interiorPoint, bridgeKindLabel, deckLevelLabel, bridgeDeckHeightM, pointInPolygon } from '../campusGeometry';
import {
    MAP_CONTROLS_CSS, ToolDock, ActionBar, Sheet, NodeForm, MenuToggle, MenuAction, StairLinks, NewStairModal,
} from './MapControls';
import { floorOf, floorTag, floorAria } from '../floors';
import { computeRoute } from '../pathfinding';
import HoursEditor, { hoursProblem } from './HoursEditor';
import { summarizeHours, closedBuildingIds } from '../openingHours';
import { toLocalMeters, fromLocalMeters } from '../geo';
import { planFromLink, fitYaw, footprint, centreline, stairRise, normalizeFlights, meanAngle, shapeLabel } from '../stairGeometry';
import { createDestinationPinIcon } from '../mapIcons';
import { BuildingStudio } from './Lazy3D';
import { createTileLayer, campusLatLngBounds, lockToCampus, CAMPUS_CENTER, CAMPUS_MIN_ZOOM, CAMPUS_MAX_ZOOM, CAMPUS_MAP_LOCK, GPS_HIDDEN_LAYERS, GPS_FLAVOR } from '../campusMap';
import { SmoothPoint, SmoothAngle, createPovIcon, paintPovRotation, createHeadingListener } from '../povMotion';

// The 3D sky is three.js, like the other 3D views, so it loads only when the map opens.
const CloudField3D = React.lazy(() => import('./CloudField3D'));

// ── Theme: ARNode black / white / green ─────────────────────────────
// Same HUD language as the mobile screens (see src/uiTokens.js): near-black
// surfaces, green for actions, white text. Red only for problems.
// Red is reserved for problems; navigation uses green (destination) and white (route).
const THEME = '#22c55e';
const ROUTE_LINE = '#ffffff';
const ANCHOR = '#4ade80';
const PAGE = '#0a0a0c';
const TEXT = C.text;
const MUTED = C.muted;
// Nodes on the floors below the one shown in the floor guide.
const LOWER_FLOOR_GREY = '#8a8f98';
const NODE_TYPE_COLORS = {
    route: '#1f6feb',
    location: THEME,
};

const NODE_TYPE_ICONS = {
    route: (size, color = '#95a5a6') => L.divIcon({
        className: 'node-hit',
        html: `<div style="
            width:${size}px;height:${size}px;border-radius:50%;
            background:${color};border:2px solid #fff;
            box-shadow:0 2px 6px rgba(0,0,0,0.3);
        "></div>`,
        iconSize: [size, size],
        iconAnchor: [size / 2, size / 2],
    }),
    location: (size, color = THEME) => createDestinationPinIcon(color, size, 'node-hit'),
};

const USER_ICON = L.divIcon({
    className: 'user-marker-icon',
    html: `<div class="user-dot" style="
        width:18px;height:18px;border-radius:50%;
        background:#fff;border:3px solid #fff;
        box-shadow:0 0 0 3px rgba(214,27,27,0.5), 0 2px 8px rgba(0,0,0,0.5);
    "></div>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
});

// POV wedge under the dot: which way the phone is facing (same ~70° cone as
// the student map and the 3D mini-map). Shares the dot's class so it hides
// with it while a tool is active (see MAP_CONTROLS_CSS).
const POV_ICON = createPovIcon({ className: 'user-marker-icon' });

// Wall-draft nodes. Each is a 12px dot (same size as a route node, so the
// spot you place is the spot that is saved) inside a 28px transparent pad
// that only exists to be easy to grab with a finger. The HEAD icon marks the
// last node: the one the next tap connects from.
const VERTEX_ICON = L.divIcon({
    className: '',
    html: `<div class="wall-node-pad"><div style="width:12px;height:12px;border-radius:50%;background:#fff;border:2px solid #111;box-shadow:0 1px 3px rgba(0,0,0,0.45);"></div></div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
});
const HEAD_ICON = L.divIcon({
    className: '',
    html: `<div class="wall-node-pad"><div class="anchor-dot" style="width:12px;height:12px;border-radius:50%;background:${ANCHOR};border:2px solid #fff;box-shadow:0 0 0 3px rgba(74, 222, 128,0.30),0 1px 3px rgba(0,0,0,0.4);"></div></div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
});
// A dragged or tapped wall node sticks to another wall node once it is
// within this many screen pixels, so snapping feels the same at any zoom.
const WALL_SNAP_PX = 16;

// True when a wall's last node sits on its first (a closed box).
function draftClosedFor(pts) {
    if (pts.length < 4) return false;
    try {
        const [dE, dN] = toLocalMeters(pts[0].lat, pts[0].lng, pts[pts.length - 1].lat, pts[pts.length - 1].lng);
        return Math.hypot(dE, dN) < 0.6;
    } catch { return false; }
}

// ── Styles ────────────────────────────────────────────────
// Surfaces share the HUD glass recipe; buttons, fields and labels come from
// the shared `.ui-*` classes (uiTokens.js ADMIN_CSS), not from this file.
const glass = {
    background: C.glass,
    WebkitBackdropFilter: 'blur(18px) saturate(140%)',
    backdropFilter: 'blur(18px) saturate(140%)',
    border: `1px solid ${C.hairline}`,
    borderRadius: `${PANEL_RADIUS}px`,
    boxShadow: ELEVATION.raised,
};

const styles = {
    container: { position: 'relative', height: '100%', background: PAGE },
    map: { width: '100%', height: '100%' },

    // One glass toolbar instead of a dozen floating buttons.
    legend: {
        ...glass,
        position: 'absolute', top: 'var(--zoom-stack)', left: '12px', zIndex: 1000,
        width: '244px', minWidth: 0, maxWidth: 'calc(100vw - 24px)',
        maxHeight: 'calc(100% - var(--zoom-stack) - 108px)',
        display: 'flex', flexDirection: 'column',
        fontSize: TYPE.sub, color: TEXT,
    },
    routePanel: {
        ...glass,
        padding: '14px 16px', width: '100%', pointerEvents: 'auto',
        color: TEXT, boxShadow: '0 16px 40px rgba(0,0,0,0.55)',
    },
};

// Escape user-entered text before it goes into Leaflet's HTML popups.
// Node, department and faculty names are typed by staff; unescaped they
// would run as markup in every admin's browser.
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
));

// One anatomy for every map popup (node, building, pathway, wall):
//   [swatch] Title [tag]      header
//   line, line, ...           details (already-escaped HTML strings)
//   [badge]                   optional status, ui-badge colour language
//   [primary, full width]     actions: text-only buttons (ui-ux doc §2.2)
//   [secondary] [danger]
// `actions[].call` is a window hook name + numeric id, e.g. ['__editNode', 4].
function popupCard({ swatch = null, round = true, title, tag = null, lines = [], badge = null, actions = [] }) {
    const btn = (a) => `<button class="popup-btn${a.kind ? ` popup-btn-${a.kind}` : ''}${a.wide ? ' is-wide' : ''}" onclick="window.${a.call[0]}(${Number(a.call[1])})">${esc(a.label)}</button>`;
    return `
        <div class="pp">
            <div class="pp-head">
                ${swatch ? `<span class="pp-swatch${round ? '' : ' is-square'}" style="background:${esc(swatch)}"></span>` : ''}
                <strong class="pp-title">${esc(title)}</strong>
                ${tag ? `<span class="pp-tag">${esc(tag)}</span>` : ''}
            </div>
            ${lines.filter(Boolean).map((l, i) => `<div class="pp-line${i === 0 ? ' is-strong' : ''}">${l}</div>`).join('')}
            ${badge ? `<span class="ui-badge${badge.tone ? ` ui-badge-${badge.tone}` : ''} pp-badge">${esc(badge.text)}</span>` : ''}
            ${actions.length ? `<div class="pp-actions">${actions.map(btn).join('')}</div>` : ''}
        </div>`;
}
// Department name only: the header swatch already carries its colour.
const dotHtml = () => '';
const statusBadge = (status) => (status === 'under_construction'
    ? { text: 'Under construction', tone: 'attention' }
    : status === 'planned' ? { text: 'Planned' } : null);
const placeWord = (pathType) => (pathType === 'outside' ? 'Outside' : 'Inside');

// Shared fields for the Add and Edit node panels (they were two copies).
/**
 * The name for the next node in a run: a trailing number counts up, keeping
 * its zero padding ("Room 101" to "Room 102", "CR 09" to "CR 10"); any other
 * name is kept as it is.
 */
function nextNodeName(name) {
    const match = /^(.*?)(\d+)$/.exec(name || '');
    if (!match) return name;
    const next = String(Number(match[2]) + 1).padStart(match[2].length, '0');
    return match[1] + next;
}

export default function AdminMap({ currentUser, tab = 'map' }) {
    const isAdmin = currentUser?.role === 'admin';
    // Office staff (not their department's head): they set the hours of the places assigned to them, nothing else.
    const isOfficeStaff = currentUser?.role === 'faculty' && currentUser?.is_head === false;
    // The same live campus weather the student map reads, for the sky over this map.
    const [weather] = useWeather();
    const mapRef = useRef(null);
    const mapInstance = useRef(null);
    const markersRef = useRef({});
    const userMarkerRef = useRef(null);
    const watchIdRef = useRef(null);
    // POV wedge + eased motion. The dot and the wedge are driven by ONE
    // SmoothPoint so they can never drift apart while gliding; the heading
    // is eased separately (compass events are far faster than GPS).
    // Move-by-GPS: blocks double taps while a fix is pending, and lets the
    // callback see whether Move mode is still on when the fix arrives.
    const moveGpsBusyRef = useRef(false);
    const moveToolActiveRef = useRef(false);
    const [moveGpsBusy, setMoveGpsBusy] = useState(false);
    const povMarkerRef = useRef(null);
    const followRef = useRef(null);
    const povSpinRef = useRef(null);
    const headingListenerRef = useRef(null);
    if (followRef.current === null) {
        followRef.current = new SmoothPoint({
            tau: 0.12,
            onUpdate: (lat, lng) => {
                const ll = [lat, lng];
                userMarkerRef.current?.setLatLng(ll);
                povMarkerRef.current?.setLatLng(ll);
            },
        });
    }
    if (povSpinRef.current === null) {
        povSpinRef.current = new SmoothAngle({
            tau: 0.08,
            onUpdate: (deg) => paintPovRotation(povMarkerRef.current, deg),
        });
    }
    const routeLayerRef = useRef(null);
    const pendingMarkerRef = useRef(null);
    const cursorCircleRef = useRef(null);
    const borderLayerRef = useRef(null);
    // Student view (2.5D walls): behind a building under it, in front over it, and always under the
    // bridges (raised decks stand above any wall). The border layer is for Admin view's flat walls.
    const wallBackLayerRef = useRef(null);
    const wallFrontLayerRef = useRef(null);
    // Trees, benches, sheds and gates: behind the buildings (under them) and in front (over them).
    const objectLayerRef = useRef(null);
    const objectFrontLayerRef = useRef(null);
    const linkLayerRef = useRef(null);
    const buildingLayerRef = useRef(null);
    const areaLayerRef = useRef(null);
    const floorGuideLayerRef = useRef(null);
    // Latitude lift of the floor plate being shown (0 = no guide / ground):
    // the pin is drawn on the plate, taps on the plate map back to the ground.
    const guideLiftRef = useRef(0);
    const [guideLift, setGuideLift] = useState(0);
    const pathwayLayerRef = useRef(null);
    const bridgeLayerRef = useRef(null);
    const shadowLayerRef = useRef(null);
    const drawingBorderRef = useRef(null);

    const [nodes, setNodes] = useState([]);
    const [borders, setBorders] = useState([]);
    // null = first load in flight, true = loaded, false = failed.
    const [dataLoaded, setDataLoaded] = useState(null);
    const [startHidden, setStartHidden] = useState(false);
    // Staircase links: [{ id, node_a_id, node_b_id, angle_deg }]
    const [links, setLinks] = useState([]);
    // Picking the far end of a staircase by tapping it on the map:
    // { sourceId, angle, floor } while active (floor = null shows every floor).
    const [stairPick, setStairPick] = useState(null);
    // New staircase from Manage nodes, step 1: tap the node at one end
    // ({ buildingId }). Last step, after both ends: { sourceId, otherId }
    // opens the shape / slope dialog.
    const [stairStart, setStairStart] = useState(null);
    // Connect a bridge to the ground: { bridgeId }. Tap a deck node, then the stairs
    // flow (stairPick, filtered to the ground floor) picks the existing ground node.
    const [bridgeConnect, setBridgeConnect] = useState(null);
    // Pathway points: connecting one walkway to another ({ pathwayId, idx }), and the point a popup is on.
    const [pathConnect, setPathConnect] = useState(null);
    // Manage nodes for a bridge: the nodes on its deck, like a building's floor list.
    const [manageBridgeId, setManageBridgeId] = useState(null);
    const [stairConfig, setStairConfig] = useState(null);
    // ONE active map tool (see toolState.js). The old flags below are derived
    // from it, and their setters are shims over it, so starting a tool always
    // replaces the previous one - two tools can never be armed together.
    const [tool, setTool] = useState(IDLE);
    const mode = tool === TOOL_ADD ? 'addNode' : 'navigate';
    const isSettingPosition = tool === TOOL_MOVE;
    const isSettingUserLoc = tool === TOOL_PIN;
    const isDrawingBorder = tool === TOOL_WALLS;
    const flagSetter = (name) => (on) => setTool((cur) => resolveTool(cur, name, typeof on === 'function' ? on(cur === name) : on));
    const setIsSettingPosition = flagSetter(TOOL_MOVE);
    moveToolActiveRef.current = isSettingPosition;
    const setIsSettingUserLoc = flagSetter(TOOL_PIN);
    const setIsDrawingBorder = flagSetter(TOOL_WALLS);
    const setMode = (m) => setTool((cur) => resolveMode(cur, m));
    const [pendingNode, setPendingNode] = useState(null);
    // Where the last node was added from the still-open form: Add stays off
    // until the pin moves, so one double tap cannot create a duplicate.
    const [lastAddedSpot, setLastAddedSpot] = useState(null);
    // Manage nodes: the building whose nodes are being managed, and the floor shown.
    const [manageBuildingId, setManageBuildingId] = useState(null);
    const [manageFloor, setManageFloor] = useState(0);
    const [userLocation, setUserLocation] = useState(null);

    // Labelled buildings and the road/walkway network (admin-edited).
    const [buildings, setBuildings] = useState([]);
    const [pathways, setPathways] = useState([]);
    const [bridges, setBridges] = useState([]);
    // Closures and special openings: the Announcements page and the route preview (closed buildings).
    const [closures, setClosures] = useState([]);
    const [showCampus, setShowCampus] = useState(true);
    const [campusOpen, setCampusOpen] = useState(false);
    // Campus areas (named outlines) and the "show one campus" filter.
    const [campusAreas, setCampusAreas] = useState([]);
    // Trees, benches, sheds and gates; the Objects tool's choice and the one open for changes (a draft).
    const [campusObjects, setCampusObjects] = useState([]);
    // Building Studio: the building being dressed (its id), or null.
    const [studioId, setStudioId] = useState(null);
    const [objectKind, setObjectKind] = useState('tree');
    const [objectDraft, setObjectDraft] = useState(null);
    // What was placed since the tool was opened, newest last: Undo removes the last one, Cancel all of them.
    const [placedIds, setPlacedIds] = useState([]);
    // When the last one was placed: a second tap right after (a double-click) must not place a second one.
    const lastPlacedAtRef = useRef(0);
    const [objectSaving, setObjectSaving] = useState(false);
    const [objectNote, setObjectNote] = useState(null);
    // The walls with each gate's opening cut out (routing and the drawn walls), the draft included.
    const shownObjects = useMemo(() => (objectDraft
        ? campusObjects.map((o) => (o.id === objectDraft.id ? objectDraft : o))
        : campusObjects), [campusObjects, objectDraft]);
    const walls = useMemo(() => bordersWithGates(borders, shownObjects), [borders, shownObjects]);
    const [campusFilter, setCampusFilter] = useState(() => {
        try { return localStorage.getItem('admin_campus_filter') || 'all'; } catch { return 'all'; }
    });
    const [areaEdit, setAreaEdit] = useState(null);
    // QR codes to print: { title, subtitle, nodes } or null.
    const [qrSheet, setQrSheet] = useState(null);
    // The building/pathway being created or edited: { mode, record, key }.
    const [campusEdit, setCampusEdit] = useState(null);
    // Picking the second office of a swap: { sourceId } while active.
    const [swapPick, setSwapPick] = useState(null);
    // 'admin' = light base map with the archive's own buildings/roads (good for
    // tracing); 'student' = exactly what /map shows (light, archive buildings
    // and roads hidden, only destinations, no walls/stairs). Remembered.
    const [viewMode, setViewMode] = useState(() => {
        try { return localStorage.getItem('adminMapView') === 'student' ? 'student' : 'admin'; } catch { return 'admin'; }
    });
    const tileLayerRef = useRef(null);
    // Shadow time demo (View menu): scrub the day to check the shadows.
    const [sunDemoOn, setSunDemoOn] = useState(false);
    const [sunDemoDate, setSunDemoDate] = useState(null);
    const [sunClock, setSunClock] = useState(() => new Date());
    useEffect(() => {
        if (sunDemoDate) return undefined;
        const timer = setInterval(() => setSunClock(new Date()), 60000);
        return () => clearInterval(timer);
    }, [sunDemoDate]);
    const sunDate = sunDemoDate || sunClock;
    // Wall shading in ~5 degree steps, so live time rarely rebuilds (and closes) popups.
    const sunForWalls = useMemo(() => {
        const s = sunPosition(sunDate, CAMPUS_CENTER[0], CAMPUS_CENTER[1]);
        return { altitudeDeg: Math.round(s.altitudeDeg / 5) * 5, azimuthDeg: Math.round(s.azimuthDeg / 5) * 5 };
    }, [sunDate]);
    const sunWallsKey = `${sunForWalls.altitudeDeg}:${sunForWalls.azimuthDeg}`;
    const isStudentView = viewMode === 'student';
    // Both views use the light base map now; Student view only hides the
    // archive's buildings/roads and the editing layers (see GPS_FLAVOR).
    const mapTheme = isStudentView ? GPS_FLAVOR : 'light';

    // Node form state
    const [formName, setFormName] = useState('');
    const [formType, setFormType] = useState('route');
    const [formElevation, setFormElevation] = useState('0');
    const [formFloor, setFormFloor] = useState('0');
    const [formPathType, setFormPathType] = useState('outside');
    // Which campus this node belongs to: 'A' | 'B'. Stored on the node and
    // shown in the form; routing/rendering ignore it for now.
    const [formCampus, setFormCampus] = useState('A');
    const [formBuilding, setFormBuilding] = useState('');
    const [formDept, setFormDept] = useState('');

    // Edit node state
    const [editingNode, setEditingNode] = useState(null);
    const [editName, setEditName] = useState('');
    // A place's own opening hours (null: it follows its building's).
    const [editHours, setEditHours] = useState(null);
    // An important place visitors may see and be routed to (the Dean's office).
    const [editPublic, setEditPublic] = useState(false);
    // Office staff who run the place being edited ('' = the building head).
    const [editManager, setEditManager] = useState('');
    // An office's hours and closures belong to whoever runs it: the building head sets them only while nobody does.
    const hoursLockedFor = (managerId) => !isAdmin && !isOfficeStaff && managerId !== '' && String(managerId) !== String(myId);
    const [editType, setEditType] = useState('route');
    const [editElevation, setEditElevation] = useState('0');
    const [editFloor, setEditFloor] = useState('0');
    const [editPathType, setEditPathType] = useState('outside');
    const [editCampus, setEditCampus] = useState('A');
    const [editBuilding, setEditBuilding] = useState('');
    const [editDept, setEditDept] = useState('');

    // Destination / route state
    const [selectedDestination, setSelectedDestination] = useState(null);
    const [routeResult, setRouteResult] = useState(null);
    const [isComputingRoute, setIsComputingRoute] = useState(false);

    // Debug: set user position manually

    // True while the GPS watch is feeding live fixes. Manual map-click
    // placement pauses it; "My location" resumes it.
    const [gpsLive, setGpsLive] = useState(false);

    // Follow mode: when off, drawing a route never moves the map view,
    // so the user pin can be placed without the screen jumping.
    const [autoFit, setAutoFit] = useState(false);
    const autoFitRef = useRef(false);

    // Live zoom readout for the status bar.
    const [zoom, setZoom] = useState(CAMPUS_MAX_ZOOM);

    // Border drawing state
    const [drawingBorderPoints, setDrawingBorderPoints] = useState([]);
    const [showBorders, setShowBorders] = useState(true);
    // Wall being edited (group id) - its points are loaded into the same
    // drawing draft, so Done rewrites the group instead of creating one.
    // Null means the draft is a brand-new wall.
    const [editingWallId, setEditingWallId] = useState(null);
    // Marker-drag end timestamp: Leaflet also fires a map click after a
    // vertex drag, which must not append a duplicate point.
    const vertexDragAtRef = useRef(0);

    // Drop wall-edit mode without saving (nothing is written until Done).
    const cancelWallEdit = () => {
        setEditingWallId(null);
        setDrawingBorderPoints([]);
        setIsDrawingBorder(false);
    };

    // Legend is a collapsible overlay on phones (open by default on desktop).
    // Open by default only where it fits beside the map (large screens); one tap in View otherwise.
    const [showLegend, setShowLegend] = useState(
        () => typeof window === 'undefined' || window.innerWidth >= 1200
    );

    // Departments + faculty attribution (admin dashboard). The management UI
    // lives in the Departments tab (AdminDepartments); the map only reads.
    const [departments, setDepartments] = useState([]);
    const [users, setUsers] = useState([]);

    // Map label colour for a node: its department's colour when filed under
    // one, otherwise the grey/green type colour.
    const nodeColor = (node) => node.department?.color || NODE_TYPE_COLORS[node.type] || '#95a5a6';
    const buildingsById = new Map(buildings.map((b) => [b.id, b]));

    // Edit rights, mirrored from the server (NodeController / BorderController):
    // admins change everything; faculty the nodes inside their department's
    // buildings (whoever placed them: a building handed over comes with its
    // rooms and routes) and the walls they drew. Nodes outside buildings are
    // admin-only. The server still decides; this only stops offering buttons that would 403.
    const myId = currentUser?.id;
    const myDeptId = currentUser?.department?.id ?? null;
    const canEditNode = (node) => {
        // Admins: only nodes on bridges (decks and stair feet); rooms and routes in buildings are the departments'.
        if (isAdmin) return node?.building_id == null && bridges.some((br) => pointInPolygon(+node.latitude, +node.longitude, br.polygon || []));
        if (isOfficeStaff) return node?.manager_id != null && node.manager_id === myId;
        // Outside buildings: not staff. Inside: the building's department.
        if (node?.building_id == null) return false;
        const b = buildings.find((x) => x.id === node.building_id);
        return myDeptId !== null && Boolean(b) && (b.department?.id ?? b.department_id) === myDeptId;
    };
    const canEditWall = (group) => isAdmin || (group?.created_by != null && group.created_by === myId);
    // Buildings: admins edit every one; department staff edit (move, reshape,
    // rename) the buildings filed under their own department. Adding and
    // removing buildings stays admin-only (BuildingController).
    const myDept = currentUser?.department?.id ?? null;
    const canEditBuilding = (b) => isAdmin || (!isOfficeStaff && myDept !== null && (b?.department?.id ?? b?.department_id) === myDept);
    // "Close now": the building head's (or an admin's) closure of the whole building, until reopened. It
    // overrides the opening hours without changing them (a closure, like the Announcements ones).
    const closedNowWhere = (match) => closures.find((c) => match(c) && c.kind !== 'open' && c.can_manage
        && new Date(c.starts_at) <= new Date() && new Date(c.ends_at) > new Date());
    const closedNowOf = (b) => closedNowWhere((c) => c.building_id === b.id);
    // One office closed now (by whoever runs it: its office staff, or the building head when nobody is assigned).
    const officeClosedNow = (node) => closedNowWhere((c) => c.node_id === node.id);
    // The building head's "Close now" (the Dean of a college), for an event, maintenance or an emergency: closes the
    // whole building now, whatever its hours say, until reopened. Admins close buildings from Announcements instead.
    const canCloseNow = (b) => !isAdmin && canEditBuilding(b) && b?.status !== 'under_construction';
    // Building Studio (how it looks outside): the building's head; an admin only for a building no department runs.
    const canStudio = (b) => b?.status === 'existing' && !isOfficeStaff
        && (isAdmin ? (b.department?.id ?? b.department_id) == null : canEditBuilding(b));
    // `target`: { building_id } or { node_id }; `name`: what to call it.
    const closeNow = async (target, name, reason = '') => {
        if (!(await confirmAction({
            title: `Close ${name} now?`,
            message: 'Students see it as closed and routes go around it until you reopen it. Its opening hours stay as they are.',
            confirmLabel: 'Close now', tone: 'danger',
        }))) return;
        try {
            const now = new Date();
            // shortcut: "until reopened" is a closure ending in a year; a forgotten one shows as Closed now on the map.
            await api.createClosure({
                ...target, reason: reason.trim() || 'Closed now', starts_at: now.toISOString(),
                ends_at: new Date(now.getTime() + 365 * 86400000).toISOString(),
            });
            mapInstance.current?.closePopup();
            setClosures(await api.getClosures());
            showToast(`${name} is closed until you reopen it`);
        } catch (err) { onError(err.message); }
    };
    const reopen = async (closure, name) => {
        if (!closure) return;
        try {
            await api.deleteClosure(closure.id);
            mapInstance.current?.closePopup();
            setClosures(await api.getClosures());
            showToast(`${name} follows its opening hours again`);
        } catch (err) { onError(err.message); }
    };
    const closeBuildingNow = (b, reason = '') => b && closeNow({ building_id: b.id }, b.short_name || b.name, reason);
    const reopenBuilding = (b) => b && reopen(closedNowOf(b), b.short_name || b.name);
    const [officeCloseReason, setOfficeCloseReason] = useState('');
    // Where this account may place nodes: admins anywhere; staff only inside
    // their department's buildings (NodeController enforces the same rule).
    const ownBuildings = isAdmin ? buildings : buildings.filter(canEditBuilding);
    const placeableAt = (lat, lng) => isAdmin || Boolean(buildingAt(ownBuildings, lat, lng));
    const ownNames = ownBuildings.slice(0, 3).map((b) => b.short_name || b.name).join(', ');
    const staffPlaceHint = ownBuildings.length
        ? `Tap inside one of your department's buildings (${ownNames}).`
        : 'Your department has no buildings on the map yet. Ask an admin to label one.';
    const ownerNote = (creatorName) => (creatorName
        ? `View only \u00b7 placed by ${creatorName}`
        : 'View only \u00b7 only an admin can edit it');

    const activeAction = tool === IDLE ? null : tool;

    // Height of the bottom stack (dock, tool bar or sheet), for the map credit above it.
    const stackRef = useRef(null);
    useEffect(() => {
        const stack = stackRef.current;
        const host = mapRef.current;
        if (!stack || !host || typeof ResizeObserver === 'undefined') return undefined;
        const ro = new ResizeObserver(() => host.style.setProperty('--mt-stack-h', `${Math.round(stack.getBoundingClientRect().height)}px`));
        ro.observe(stack);
        return () => ro.disconnect();
    }, []);

    // Notification pill (top centre): confirmations and errors share it, so
    // every message appears in the same place. { text, tone: 'ok' | 'error', key }
    const [successToast, setSuccessToast] = useState(null);
    const toastTimerRef = useRef(0);

    // Two-step node removal, the View menu and the two-tap wall discard. All of them close whenever the tool changes.
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [viewOpen, setViewOpen] = useState(false);
    const [confirmDiscard, setConfirmDiscard] = useState(false);
    const discardTimerRef = useRef(0);
    useEffect(() => { setConfirmDelete(false); }, [editingNode?.id]);
    useEffect(() => {
        setViewOpen(false);
        setCampusOpen(false);
        setConfirmDiscard(false);
    }, [tool]);
    // While a tool is active the map belongs to the tool: hide the user's own
    // dot (it caught the finger meant for the map), make wall hit-lines inert
    // via CSS, and drop any open popup.
    useEffect(() => {
        const map = mapInstance.current;
        if (!map) return;
        map.getContainer().classList.toggle('tool-active', tool !== IDLE);
        if (tool !== IDLE) map.closePopup();
    }, [tool]);
    // Walls tool before a draft starts: existing walls can be tapped to edit or remove them.
    useEffect(() => {
        const map = mapInstance.current;
        if (!map) return;
        map.getContainer().classList.toggle('walls-pick', tool === TOOL_WALLS && drawingBorderPoints.length === 0 && editingWallId === null);
    }, [tool, drawingBorderPoints.length, editingWallId]);
    const showToast = (message, tone = 'ok') => {
        clearTimeout(toastTimerRef.current);
        setSuccessToast({ text: message, tone, key: Date.now() });
        // Errors stay until dismissed (the x button): they usually need reading and acting on.
        if (tone !== 'error') toastTimerRef.current = setTimeout(() => setSuccessToast(null), 2500);
    };
    // Every error on the admin pages (this map, Departments, Students) goes
    // to the same pill, in red.
    const onError = useCallback((message) => {
        if (message) showToast(String(message), 'error');
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Draw route on map (shared by initial compute and live updates)
    const drawRoute = useCallback((result) => {
        if (routeLayerRef.current) {
            routeLayerRef.current.clearLayers();
        }

        if (!result || !result.path || result.path.length < 2) return;

        const latlngs = result.path.map(p => [p.latitude, p.longitude]);

        const routeLine = L.polyline(latlngs, {
            color: ROUTE_LINE,
            weight: 5,
            opacity: 0.9,
            lineJoin: 'round',
            lineCap: 'round',
        });
        routeLayerRef.current.addLayer(routeLine);

        result.path.forEach((p, i) => {
            if (i === 0 && p.type === 'user') return;
            // The destination pin already exists in the base node layer. Keep
            // the route overlay focused on intermediate route nodes so Preview
            // route never draws a second pin directly on top of the destination.
            if (p.type === 'location') return;

            // Preview markers use the same compact icons as the admin map:
            // small route-node dots and the animated destination pin. Reusing
            // the shared icon source avoids stale, oversized preview markers.
            const color = NODE_TYPE_COLORS[p.type] || THEME;
            const size = p.type === 'location' ? 16 : 12;
            const routeIcon = NODE_TYPE_ICONS[p.type]?.(size, color)
                || NODE_TYPE_ICONS.route(12, color);
            const routeMarker = L.marker([p.latitude, p.longitude], {
                icon: routeIcon,
                title: p.name || (p.type === 'route' ? 'Route node' : 'Stop'),
                zIndexOffset: 2000,
            });
            routeMarker.bindPopup(popupCard({ title: p.name || (p.type === 'route' ? 'Route node' : 'Stop') }));
            routeLayerRef.current.addLayer(routeMarker);
        });

        if (autoFitRef.current) {
            mapInstance.current?.fitBounds(routeLine.getBounds(), { padding: [50, 50] });
        }
    }, []);

    // Recompute route live when user location changes (if a destination is active)
    useEffect(() => {
        if (!selectedDestination || !userLocation) return;

        const result = computeRoute(
            nodes,
            selectedDestination.id,
            userLocation.latitude,
            userLocation.longitude,
            0,
            walls,
            // Closed buildings (opening hours, now) are walked around, as on /map.
            { buildings, bridges, links, pathways, closedBuildingIds: closedBuildingIds(buildings, new Date(), closures) },
        );
        setRouteResult(result);
        drawRoute(result);
    }, [userLocation, selectedDestination, nodes, walls, drawRoute, buildings, bridges, links, pathways, closures]);
    const loadData = useCallback(async () => {
        try {
            const nodesData = await api.getNodes();
            setNodes(nodesData);
            setDataLoaded(true);
            try {
                const flatBorders = await api.getBorders();
                // Group flat rows into walls by group_id
                const grouped = {};
                for (const b of flatBorders) {
                    if (!grouped[b.group_id]) grouped[b.group_id] = { group_id: b.group_id, created_by: b.created_by ?? null, coordinates: [] };
                    grouped[b.group_id].coordinates.push({ lat: b.latitude, lng: b.longitude });
                }
                setBorders(Object.values(grouped));
            } catch { /* borders endpoint may fail */ }
            try {
                setLinks(await api.getNodeLinks());
            } catch { setLinks([]); /* stairs endpoint may be missing on an old backend */ }
            try {
                setDepartments(await api.getDepartments());
            } catch { /* departments endpoint may fail */ }
            try {
                const [b, p] = await Promise.all([api.getBuildings(), api.getPathways()]);
                setBuildings(b);
                setPathways(p);
            } catch { /* older backend without buildings/pathways */ }
            try {
                setBridges(await api.getBridges());
            } catch { setBridges([]); /* older backend without bridges */ }
            try {
                setCampusAreas(await api.getCampusAreas());
            } catch { setCampusAreas([]); /* older backend without campus areas */ }
            try {
                setCampusObjects(await api.getCampusObjects());
            } catch { setCampusObjects([]); /* older backend without campus objects */ }
            try {
                setClosures(await api.getClosures());
            } catch { setClosures([]); }
            // Faculty get a 403 here - they still see every node and colour,
            // they just can't manage the roster.
            try {
                setUsers(await api.getUsers());
            } catch { setUsers([]); }
        } catch (err) {
            setDataLoaded((v) => (v === true ? true : false));
            onError(err.message);
        }
    }, [onError]);

    // First view: everything mapped inside the campus box, once, after the first load (the map
    // starts at zoom 22 on the archive's centre, a 40 m patch between buildings). A view the
    // admin already moved or zoomed is left alone.
    const firstFitRef = useRef(false);
    useEffect(() => {
        const map = mapInstance.current;
        if (firstFitRef.current || !map || !dataLoaded) return;
        const box = campusLatLngBounds();
        const pts = [...nodes.map((n) => [Number(n.latitude), Number(n.longitude)]),
            ...buildings.flatMap((b) => (b.polygon || []).map((q) => [q.lat, q.lng]))]
            .filter(([lat, lng]) => box.contains([lat, lng]));
        if (pts.length === 0) return;
        firstFitRef.current = true;
        if (map.getZoom() < CAMPUS_MAX_ZOOM) return; // already zoomed by the admin
        map.fitBounds(L.latLngBounds(pts).pad(0.1), { maxZoom: 19 });
    }, [dataLoaded, nodes, buildings]);

    // Initialize map and auto-center on GPS
    useEffect(() => {
        if (mapInstance.current) return;

        const map = L.map(mapRef.current, {
            center: CAMPUS_CENTER,
            zoom: CAMPUS_MAX_ZOOM,
            minZoom: CAMPUS_MIN_ZOOM,
            maxZoom: CAMPUS_MAX_ZOOM,
            // Lock the view to campus - no panning/zooming out to the world.
            maxBounds: campusLatLngBounds(),
            maxBoundsViscosity: 1.0,
            zoomControl: true,
            // Gestures that cannot leave the box (see CAMPUS_MAP_LOCK).
            ...CAMPUS_MAP_LOCK,
        });
        // The whole view stays inside the campus box at every zoom.
        lockToCampus(map);

        // The Protomaps base layer is added by the view-mode effect below.

        // Campus boundary outline (non-interactive): edge tiles render whole
        // so they spill slightly past the box - the dashed line shows exactly
        // where the tile box ends. Never blocks node taps.
        L.rectangle(campusLatLngBounds(), {
            color: THEME,
            weight: 2,
            dashArray: '8, 6',
            fill: false,
            interactive: false,
        }).addTo(map);

        setZoom(map.getZoom());
        map.on('zoomend', () => setZoom(map.getZoom()));
        // Popups pan clear of the Admin / Student view switch at the top (one opened
        // near the top edge slid under it).
        map.on('popupopen', (e) => {
            const popup = e.popup;
            if (popup.options.autoPanPaddingTopLeft?.y === 84) return;
            popup.options.autoPanPaddingTopLeft = L.point(16, 84);
            popup.update();
        });

        // Pathways and buildings first, so walls, stairs and routes draw on top.
        prepareCampusPanes(map);
        // Campus outlines lie under everything else.
        areaLayerRef.current = paneLayerGroup('campusAreas').addTo(map);
        pathwayLayerRef.current = L.layerGroup().addTo(map);
        shadowLayerRef.current = L.layerGroup().addTo(map);
        wallBackLayerRef.current = paneLayerGroup('campusBack').addTo(map);
        objectLayerRef.current = paneLayerGroup('campusBackObjects').addTo(map);
        buildingLayerRef.current = paneLayerGroup('campusBuildings').addTo(map);
        wallFrontLayerRef.current = paneLayerGroup('campusFront').addTo(map);
        objectFrontLayerRef.current = paneLayerGroup('campusFrontObjects').addTo(map);
        // Bridges over the roads between buildings: above the buildings (and the walls).
        bridgeLayerRef.current = paneLayerGroup('campusBridges').addTo(map);
        // "Which floor": the cut-away guide while placing a node in a building.
        floorGuideLayerRef.current = L.layerGroup().addTo(map);
        bindLabelZoom(map);
        routeLayerRef.current = paneLayerGroup('campusTop').addTo(map);
        borderLayerRef.current = paneLayerGroup('campusTop').addTo(map);
        linkLayerRef.current = paneLayerGroup('campusTop').addTo(map);
        mapInstance.current = map;

        loadData();

        // GPS live tracking starts with the map, so a faculty account walking
        // the campus gets a moving dot without tapping anything. A manual
        // map-click pin pauses it; "My location" resumes it. Desktop browsers
        // without GPS simply fail silent into manual mode.
        startGpsWatch();

        // Facing direction for the POV wedge. Desktop browsers never fire
        // orientation events, so there the wedge simply never appears.
        headingListenerRef.current = createHeadingListener({
            onHeading: (deg) => {
                povSpinRef.current.set(deg);
                ensurePovMarker();
            },
        });
        headingListenerRef.current.start();

        return () => {
            stopGpsWatch();
            headingListenerRef.current?.stop();
            headingListenerRef.current = null;
            followRef.current?.destroy();
            povSpinRef.current?.destroy();
        };
    }, []);

    // Base map for the chosen view. Swapping only replaces the tile layer;
    // every overlay (nodes, buildings, routes) stays where it is.
    useEffect(() => {
        const map = mapInstance.current;
        if (!map) return;
        // The new base map fades in over the old one, then the old one goes.
        const previous = tileLayerRef.current;
        const next = isStudentView
            ? createTileLayer({ flavor: GPS_FLAVOR, hiddenLayers: GPS_HIDDEN_LAYERS })
            : createTileLayer();
        if (previous) next.options.className = 'tile-swap';
        tileLayerRef.current = next.addTo(map);
        if (previous) setTimeout(() => previous.remove(), 450);
        map.getContainer().classList.toggle('view-student', isStudentView);
        try { localStorage.setItem('adminMapView', viewMode); } catch { /* private mode */ }
    }, [viewMode]);

    // Satellite imagery (View menu): same settings as /map on this device.
    const satellite = useSatelliteSettings();
    useSatelliteLayer(() => mapInstance.current, satellite);

    // Returning to the map tab must re-measure: Leaflet lays out zero-size
    // while its container is display:none, so tiles would stay blank.
    useEffect(() => {
        if (tab === 'map' && mapInstance.current) {
            const t = setTimeout(() => mapInstance.current?.invalidateSize(), 60);
            return () => clearTimeout(t);
        }
        return undefined;
    }, [tab]);

    // Floor guide: while a node is being added (or moved / edited) inside a
    // building, show that building cut away at the chosen floor.
    const manageBuilding = manageBuildingId != null ? buildings.find((b) => b.id === manageBuildingId) || null : null;
    const manageBridge = manageBridgeId != null ? bridges.find((b) => b.id === manageBridgeId) || null : null;
    // While Manage nodes is open the label chips would sit on the nodes: hide them (campusLayers CSS).
    const managingNodes = Boolean(manageBuilding || manageBridge);
    useEffect(() => {
        mapInstance.current?.getContainer().classList.toggle('manage-nodes-open', managingNodes);
    }, [managingNodes]);
    /** A node on bridge br's deck (= Bridge::deckNodes()): inside its outline, in no building, and raised
     *  (any floor above the ground) for a raised deck, on the ground for one at ground level. */
    const onDeckOf = (br) => (n) => Boolean(br) && n.building_id == null
        && (Number(br.deck_floor) > 0 ? floorOf(n) > 0 : floorOf(n) === 0)
        && pointInPolygon(n.latitude, n.longitude, br.polygon);
    // Manage nodes for a bridge: the floors its deck nodes are on (normally just the deck's).
    const bridgeFloors = (br) => [...new Set([Number(br.deck_floor) || 0, ...nodes.filter(onDeckOf(br)).map((n) => floorOf(n))])].sort((a, b) => a - b);
    const guideBuilding = (() => {
        if (stairPick || swapPick || stairConfig) return null;
        const adding = tool === TOOL_ADD && !isAdmin && formBuilding !== '';
        const editing = !adding && editingNode && editBuilding !== '' && (tool === TOOL_MOVE || tool === IDLE);
        const managing = !adding && !editing && !editingNode && tool === IDLE && manageBuilding;
        const id = adding ? formBuilding : editing ? editBuilding : managing ? manageBuilding.id : '';
        return id ? buildings.find((b) => String(b.id) === String(id)) || null : null;
    })();
    const guideLevel = tool === TOOL_ADD
        ? parseInt(formFloor, 10) || 0
        : editingNode ? parseInt(editFloor, 10) || 0 : manageFloor;
    // The floor actually shown (clamped to the building), for the markers.
    const guideFloor = guideBuilding ? Math.min(Math.max(0, guideLevel), Math.max(1, guideBuilding.floors || 1) - 1) : null;

    // Admin view: a building's own nodes (rooms, indoor routes) show only
    // while that building is being worked on: its Edit panel, Manage nodes,
    // or adding / editing one of its nodes. Outdoor nodes always show.
    // Picking a staircase end or an office to swap shows everything, since
    // the other end can be anywhere. Same in Student view (as /map, where a
    // room's pin shows only once it is the chosen destination).
    const focusBuildingIds = new Set([
        campusEdit?.mode === 'building' ? campusEdit.record?.id : null,
        manageBuilding?.id,
        tool === TOOL_ADD && formBuilding !== '' ? Number(formBuilding) : null,
        editingNode?.building_id,
        editingNode && editBuilding !== '' ? Number(editBuilding) : null,
    ].filter((id) => id !== null && id !== undefined).map(String));
    const showAllIndoor = !!stairPick || !!swapPick;
    // The floor guide shows one floor at a time (Manage nodes, New node, or
    // editing a node): only that floor's nodes and the staircases that reach
    // it, nothing from the floors below, to keep the map calm.
    const manageOnlyFloor = !!guideBuilding;
    const indoorShown = (n) => showAllIndoor || n.building_id == null || focusBuildingIds.has(String(n.building_id))
        // The room a route is being previewed to keeps its pin.
        || (selectedDestination && String(n.id) === String(selectedDestination.id));
    const focusKey = `${[...focusBuildingIds].sort().join(',')}|${selectedDestination?.id ?? ''}`;

    // Render markers when nodes change
    useEffect(() => {
        if (!mapInstance.current) return;
        const map = mapInstance.current;

        Object.values(markersRef.current).forEach(m => map.removeLayer(m));
        markersRef.current = {};

        // Student view mirrors /map: destinations only. While a tool or an edit
        // is open the working parts come back, so nothing being edited hides.
        const studentOnly = isStudentView && tool === IDLE && !editingNode && !stairPick && !swapPick && !manageBuilding && !stairStart && !bridgeConnect;
        const inCampus = campusMatcher(campusFilter, campusAreas);
        nodes.forEach(node => {
            // One campus at a time when the filter is set (never hides the node being edited).
            if (!inCampus(nodeArea(node, campusAreas)) && !(editingNode && editingNode.id === node.id)) return;
            // Nodes outside buildings always show (both views); a building's own
            // nodes only while it is being edited (indoorShown below).
            if (studentOnly && node.type !== 'location' && node.building_id != null) return;
            if (!indoorShown(node)) return;
            // When repositioning, the node becomes a white handle at its
            // normal size: same footprint as every other route node, but
            // colourless so it reads as "move this point" rather than as a
            // department-coloured node. Destinations keep their pin shape.
            const isHighlighted = isSettingPosition && editingNode && editingNode.id === node.id;
            // Floor guide up: this building's nodes stand on their own floor
            // plates. The chosen floor keeps its colours; the floors below go
            // grey and see-through so the depth reads at a glance; the floors
            // above are cut away with the rest of the building.
            const inGuide = guideBuilding && node.building_id === guideBuilding.id;
            const nodeFloor = inGuide ? floorOf(node) : 0;
            if (inGuide && nodeFloor > guideFloor && !(editingNode && editingNode.id === node.id)) return;
            const belowGuide = inGuide && nodeFloor < guideFloor && !(editingNode && editingNode.id === node.id);
            if (belowGuide && manageOnlyFloor) return;
            const lift = inGuide ? floorLiftDeg(guideBuilding, editingNode && editingNode.id === node.id ? guideFloor : nodeFloor) : 0;
            const color = belowGuide ? LOWER_FLOOR_GREY : nodeColor(node);

            const icon = isHighlighted && node.type === 'route'
                ? L.divIcon({
                    className: '',
                    html: `<div style="
                        width:12px;height:12px;border-radius:50%;
                        background:#fff;
                        border:2px solid rgba(10,10,12,0.55);
                        box-shadow:0 0 0 3px rgba(255,255,255,0.5), 0 2px 6px rgba(0,0,0,0.35);
                        animation:pulse-edit 1.5s infinite;
                    "></div>
                    <style>
                        @keyframes pulse-edit {
                            0%, 100% { box-shadow:0 0 0 3px rgba(255,255,255,0.5), 0 2px 6px rgba(0,0,0,0.35); }
                            50% { box-shadow:0 0 0 6px rgba(255,255,255,0.12), 0 2px 6px rgba(0,0,0,0.35); }
                        }
                    </style>`,
                    iconSize: [12, 12],
                    iconAnchor: [6, 6],
                })
                : NODE_TYPE_ICONS[node.type]?.(node.type === 'route' ? 12 : 16, color) || NODE_TYPE_ICONS.route(12, color);

            // Picking a staircase end: only nodes on a DIFFERENT floor than the
            // source (and not already joined to it) can be tapped. Everything
            // else dims and goes inert, so a node stacked on top of a
            // candidate on another floor can never swallow the tap.
            let pickRole = null; // 'source' | 'candidate' | 'muted'
            if (swapPick) {
                if (node.id === swapPick.sourceId) pickRole = 'source';
                // Only offices in the staff member's own buildings (NodeController::swap checks both).
                else if (node.type === 'location' && canEditNode(node)) pickRole = 'candidate';
                else pickRole = 'muted';
            } else if (stairStart) {
                // First end of a new staircase: this building's nodes on the floor shown.
                pickRole = inGuide && nodeFloor === guideFloor && canEditNode(node) ? 'candidate' : 'muted';
            } else if (bridgeConnect) {
                // First end: a route node on the bridge's deck (its floor, inside its outline).
                const br = bridges.find((x) => x.id === bridgeConnect.bridgeId);
                pickRole = node.type === 'route' && onDeckOf(br)(node) ? 'candidate' : 'muted';
            } else if (stairPick) {
                const src = nodes.find((n) => n.id === stairPick.sourceId);
                const joined = links.some((l) => (l.node_a_id === stairPick.sourceId && l.node_b_id === node.id)
                    || (l.node_b_id === stairPick.sourceId && l.node_a_id === node.id));
                if (node.id === stairPick.sourceId) pickRole = 'source';
                // Staff can also end a staircase on a shared outdoor node.
                else if (src && floorOf(node) !== floorOf(src) && !joined && (canEditNode(node) || node.building_id == null)
                    && (stairPick.floor === null || floorOf(node) === stairPick.floor)) pickRole = 'candidate';
                else pickRole = 'muted';
            }

            const marker = L.marker([node.latitude + lift, node.longitude], {
                icon,
                // Markers are keyboard buttons: the title is their name for screen readers.
                title: node.name || (node.type === 'route' ? 'Route node' : 'Location'),
                // Popups would open a second editing surface on top of the
                // active tool (or an open edit sheet), so nodes are inert
                // until the map is idle again.
                interactive: pickRole ? pickRole === 'candidate' : (tool === IDLE && !editingNode),
                opacity: pickRole === 'muted' ? 0.25 : belowGuide ? 0.5 : 1,
                zIndexOffset: pickRole === 'candidate' ? 900 : belowGuide ? -500 : 0,
            })
                .addTo(map);

            if (pickRole === 'candidate' || pickRole === 'source') {
                const ring = L.circleMarker([node.latitude + lift, node.longitude], {
                    radius: pickRole === 'source' ? 13 : 12,
                    color: pickRole === 'source' ? '#ffffff' : '#ffb02e', weight: 3, fill: false,
                    interactive: false, className: pickRole === 'candidate' ? 'stair-pick-ring' : '',
                }).addTo(map);
                markersRef.current[`ring-${node.id}`] = ring;
                marker.bindTooltip(
                    swapPick
                        ? (pickRole === 'source' ? `Swap: ${esc(node.name || 'this office')}` : esc(node.name || 'Location'))
                        : stairStart ? esc(node.name || 'Route node')
                        : bridgeConnect ? 'Deck node'
                        : (pickRole === 'source' ? `This node \u00b7 Floor ${floorTag(floorOf(node))}` : `Floor ${floorTag(floorOf(node))}`),
                    { permanent: true, direction: 'top', offset: [0, -10], className: 'stair-pick-tip' },
                );
            }
            if (pickRole === 'candidate') {
                marker.on('click', () => {
                    (swapPick ? window.__pickSwapOffice : stairStart ? window.__pickStairStart
                        : bridgeConnect ? window.__pickBridgeDeck : window.__pickStairEnd)?.(node.id);
                });
                markersRef.current[node.id] = marker;
                return;
            }
            if (pickRole) {
                markersRef.current[node.id] = marker;
                return;
            }

            // Popup: who owns the node first (department colour + faculty), then
            // where it sits. Every typed string is escaped (see esc above).
            const owner = node.department
                ? `${dotHtml(node.department.color)}${esc(node.department.name)}`
                : 'Unassigned department';
            const byline = node.creator ? ` · by ${esc(node.creator.name)}` : '';
            const place = nodePlaceLabel(node, buildingsById);
            const popupContent = popupCard({
                swatch: color,
                title: node.name || (node.type === 'route' ? 'Route node' : 'Location'),
                tag: node.type === 'route' ? 'Route' : null,
                lines: [
                    `${owner}${byline}`,
                    place ? esc(place) : `Floor ${esc(floorTag(floorOf(node)))}`,
                    `<span class="ui-num">${esc(placeWord(node.path_type))}, ${esc(node.elevation)} m elevation</span>`,
                    esc(nodeArea(node, campusAreas)?.name || 'Outside every campus area'),
                    `<span class="ui-num pp-muted">${node.latitude.toFixed(6)}, ${node.longitude.toFixed(6)}</span>`,
                ],
                badge: canEditNode(node) ? null : { text: ownerNote(node.creator?.name) },
                actions: [
                    ...(node.type === 'location' ? [{ label: 'Preview route', call: ['__giveDestination', node.id], kind: 'primary', wide: true }] : []),
                    ...(canEditNode(node) ? [
                        { label: 'Edit', call: ['__editNode', node.id] },
                        { label: 'Remove', call: ['__deleteNode', node.id], kind: 'danger' },
                    ] : []),
                    { label: 'QR code', call: ['__qrNode', node.id] },
                ],
            });
            marker.bindPopup(popupContent);

            markersRef.current[node.id] = marker;
        });
    }, [nodes, tool, editingNode, stairPick, swapPick, stairStart, bridgeConnect, bridges, links, buildings, isStudentView, guideBuilding?.id, guideFloor, manageBuilding?.id, focusKey, manageOnlyFloor, campusFilter, campusAreas]);

    // Trees, benches, sheds and gates: standing up with their shadows in Student view, a top-down symbol in
    // Admin view; tappable (to change one) only in the Objects tool.
    useEffect(() => {
        if (!mapInstance.current || !objectLayerRef.current) return;
        drawCampusObjects(objectLayerRef.current, shownObjects, {
            extrude: isStudentView, sun: isStudentView ? sunForWalls : null, buildings,
            frontLayer: objectFrontLayerRef.current,
            onSelect: tool === TOOL_OBJECTS ? (o) => {
                setObjectNote(null);
                setObjectDraft({ ...o });
                // Keep it (and its move handle) in sight beside the panel that opens: the panel sits at the
                // bottom left on a computer and along the bottom on a phone.
                const wide = window.innerWidth > 900;
                mapInstance.current?.panInside([+o.latitude, +o.longitude], {
                    paddingTopLeft: [wide ? 420 : 40, 80],
                    paddingBottomRight: [60, wide ? 60 : Math.round(window.innerHeight * 0.62)],
                });
            } : null,
            selectedId: objectDraft?.id ?? null,
            onMove: tool === TOOL_OBJECTS ? (lat, lng) => {
                setObjectDraft((d) => {
                    if (!d) return d;
                    const spot = objectSpot(d.kind, lat, lng);
                    return spot ? { ...d, ...spot } : d;
                });
            } : null,
            // Resize and rotate on the map (corner, edge and rotate handles; a tree's crown handle).
            onTransform: tool === TOOL_OBJECTS ? (patch) => setObjectDraft((d) => (d ? { ...d, ...patch } : d)) : null,
        });
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [shownObjects, isStudentView, sunWallsKey, buildings, tool, objectDraft?.id, borders]);

    // Where an object of `kind` goes when put at lat/lng: a gate snaps onto the nearest wall (null, with a
    // note, when no wall is near); everything else stays where it was put.
    const objectSpot = (kind, lat, lng) => {
        if (kind !== 'gate') { setObjectNote(null); return { latitude: lat, longitude: lng }; }
        const snap = snapGateToWall(borders, lat, lng);
        setObjectNote(snap ? null : 'A gate goes in a wall: put it on or next to one.');
        return snap;
    };

    // Objects tool: a tap on the map places the chosen kind (saved at once), or moves the one open for changes.
    useEffect(() => {
        const map = mapInstance.current;
        if (!map || tool !== TOOL_OBJECTS) return undefined;
        const onClick = async (e) => {
            const kind = objectDraft ? objectDraft.kind : objectKind;
            const spot = objectSpot(kind, e.latlng.lat, e.latlng.lng);
            if (!spot) return;
            if (objectDraft) { setObjectDraft((d) => ({ ...d, ...spot })); return; }
            try {
                if (Date.now() - lastPlacedAtRef.current < 600) return;
                lastPlacedAtRef.current = Date.now();
                const created = await api.createCampusObject({ ...objectDefaults(kind), ...spot });
                setCampusObjects((list) => [...list, created]);
                setPlacedIds((ids) => [...ids, created.id]);
                setObjectNote(`${objectKindLabel(kind)} placed. Tap it to change its size or look.`);
            } catch (err) {
                onError(err.message);
            }
        };
        map.on('click', onClick);
        return () => map.off('click', onClick);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tool, objectKind, objectDraft, borders]);

    const startObjects = () => {
        cancelWallEdit();
        setCampusEdit(null);
        setAreaEdit(null);
        setManageBuildingId(null);
        setPendingNode(null);
        setEditingNode(null);
        setCampusOpen(false);
        setObjectDraft(null);
        setObjectNote(null);
        setPlacedIds([]);
        mapInstance.current?.closePopup();
        setTool(TOOL_OBJECTS);
    };
    // Remove placed objects (ids) from the map and the database.
    const unplace = async (ids) => {
        for (const id of ids) await api.deleteCampusObject(id);
        setCampusObjects((list) => list.filter((o) => !ids.includes(o.id)));
        setPlacedIds((list) => list.filter((id) => !ids.includes(id)));
        setObjectDraft((d) => (d && ids.includes(d.id) ? null : d));
    };
    const undoPlaced = async () => {
        const last = placedIds[placedIds.length - 1];
        if (last === undefined) return;
        const kind = campusObjects.find((o) => o.id === last)?.kind;
        try {
            await unplace([last]);
            setObjectNote(`Removed the ${objectKindLabel(kind).toLowerCase()} you placed last.`);
        } catch (err) { onError(err.message); }
    };
    const cancelPlaced = async () => {
        if (placedIds.length && !(await confirmAction({
            title: `Remove the ${placedIds.length} ${placedIds.length === 1 ? 'object' : 'objects'} you placed?`,
            message: 'Everything placed since you opened the tool comes off the map. Changes you saved to earlier objects stay.',
            confirmLabel: 'Remove them', tone: 'danger',
        }))) return;
        try {
            await unplace(placedIds);
            setObjectDraft(null);
            setObjectNote(null);
            setTool(IDLE);
            if (placedIds.length) showToast(`Removed ${placedIds.length} ${placedIds.length === 1 ? 'object' : 'objects'}`);
        } catch (err) { onError(err.message); }
    };
    const saveObject = async () => {
        if (!objectDraft) return;
        setObjectSaving(true);
        try {
            const saved = await api.updateCampusObject(objectDraft.id, objectDraft);
            setCampusObjects((list) => list.map((o) => (o.id === saved.id ? saved : o)));
            setObjectDraft(null);
            setObjectNote('Saved.');
        } catch (err) {
            onError(err.message);
        } finally {
            setObjectSaving(false);
        }
    };
    const removeObject = async () => {
        if (!objectDraft) return;
        setObjectSaving(true);
        try {
            await unplace([objectDraft.id]);
            setObjectNote('Removed.');
        } catch (err) {
            onError(err.message);
        } finally {
            setObjectSaving(false);
        }
    };

    const isCampusTool = tool === TOOL_BUILDING || tool === TOOL_PATHWAY || tool === TOOL_BRIDGE;

    // Labelled buildings + pathways. The one being edited is drawn by the
    // editor as a draft instead, so it is not shown twice.
    useEffect(() => {
        const bLayer = buildingLayerRef.current;
        const pLayer = pathwayLayerRef.current;
        if (!mapInstance.current || !bLayer || !pLayer) return;
        const brLayer = bridgeLayerRef.current;
        if (!showCampus) { bLayer.clearLayers(); pLayer.clearLayers(); brLayer?.clearLayers(); return; }
        const editingId = (mode) => (isCampusTool && campusEdit?.mode === mode ? campusEdit.record?.id ?? null : null);
        const buildingPopup = (b) => {
            const inside = nodes.filter((n) => n.building_id === b.id && n.type === 'location').length;
            const swatch = b.status === 'under_construction' ? CAMPUS_COLORS.construction : (b.department?.color || '#ffffff');
            return popupCard({
                swatch, round: false, title: b.name, tag: b.short_name,
                lines: [
                    b.department ? `${dotHtml(b.department.color)}${esc(b.department.name)}` : 'Shared building',
                    `<span class="ui-num">${esc(floorCountLabel(b))}, ${b.height_m ? `${esc(b.height_m)} m tall` : `about ${(Math.max(1, b.floors || 1) * 3.2).toFixed(1)} m tall`}</span>`,
                    esc(buildingArea(b, campusAreas)?.name || 'Outside every campus area'),
                    `<span class="pp-muted">${inside === 0 ? 'No rooms filed yet' : `${inside} ${inside === 1 ? 'room' : 'rooms'} inside`}</span>`,
                ],
                badge: closedNowOf(b) ? { text: 'Closed now', tone: 'danger' } : statusBadge(b.status),
                actions: [
                    ...(canEditBuilding(b) ? [
                        { label: 'Edit', call: ['__editBuilding', b.id] },
                        { label: 'Move / reshape', call: ['__moveBuilding', b.id] },
                    ] : []),
                    ...(canStudio(b) ? [{ label: 'Building Studio', call: ['__openStudio', b.id], wide: true }] : []),
                    // Office staff: straight to each office they run in this building (its hours and closures).
                    ...(isOfficeStaff ? nodes.filter((n) => n.building_id === b.id && n.manager_id === myId)
                        .map((n) => ({ label: `Manage ${n.name || 'my office'}`, call: ['__editNode', n.id], wide: true })) : []),
                    ...(canCloseNow(b) ? [closedNowOf(b)
                        ? { label: 'Reopen', call: ['__reopenBuilding', b.id], wide: true }
                        : { label: 'Close now', call: ['__closeBuildingNow', b.id], kind: 'danger', wide: true }] : []),
                    ...(isAdmin ? [{ label: 'Remove building', call: ['__deleteBuilding', b.id], kind: 'danger', wide: true }] : []),
                ],
            });
        };
        const pathwayPopup = (p) => popupCard({
            swatch: p.kind === 'covered' ? CAMPUS_COLORS.covered.dark : CAMPUS_COLORS.road.dark,
            round: false,
            title: p.name || kindLabel(p.kind),
            lines: [esc(kindLabel(p.kind)), `<span class="ui-num pp-muted">${p.coordinates.length} points</span>`],
            badge: statusBadge(p.status),
            actions: isAdmin ? [
                { label: 'Edit', call: ['__editPathway', p.id] },
                { label: 'Move / reshape', call: ['__movePathway', p.id] },
                { label: 'Remove pathway', call: ['__deletePathway', p.id], kind: 'danger', wide: true },
            ] : [],
        });
        const bridgePopup = (br) => popupCard({
            swatch: CAMPUS_COLORS.bridge.dark, round: false, title: br.name, tag: br.short_name,
            lines: [
                esc(bridgeKindLabel(br.kind)),
                `<span class="ui-num">${esc(deckLevelLabel(br.deck_floor))}${br.deck_floor > 0 ? `, deck about ${esc(bridgeDeckHeightM(br).toFixed(1))} m up` : ''}</span>`,
                `<span class="pp-muted">${br.roofed ? 'Roofed: sheltered when it rains' : 'No roof'}</span>`,
                ...(br.closed ? [`<strong>Closed</strong>: ${esc(br.closed_reason || 'no reason given')}. Routes do not cross it (Edit to reopen).`] : []),
            ],
            badge: statusBadge(br.status),
            actions: isAdmin ? [
                { label: 'Edit', call: ['__editBridge', br.id] },
                { label: 'Move / reshape', call: ['__moveBridge', br.id] },
                { label: 'Manage nodes', call: ['__manageBridge', br.id] },
                ...(Number(br.deck_floor) > 0 ? [{ label: 'Connect to ground', call: ['__connectBridge', br.id], wide: true }] : []),
                { label: 'Remove bridge', call: ['__deleteBridge', br.id], kind: 'danger', wide: true },
            ] : [],
        });
        // Colours follow the base map of the current view (light / dark).
        drawPathways(pLayer, pathways, { popup: pathwayPopup, skipId: editingId('pathway'), theme: mapTheme });
        // Each pathway's points, clickable: connect to another walkway, remove the point, edit the pathway.
        if (isAdmin && !isStudentView) {
            for (const pw of pathways) {
                if (pw.id === editingId('pathway')) continue;
                (pw.coordinates || []).forEach((c, idx) => {
                    const from = pathConnect && pathConnect.pathwayId === pw.id && pathConnect.idx === idx;
                    L.circleMarker([c.lat, c.lng], {
                        radius: from ? 7 : 5, color: '#1f2937', weight: 2, fillColor: from ? '#22c55e' : '#ffffff', fillOpacity: 1,
                        bubblingMouseEvents: false, className: 'campus-hit',
                    }).on('click', () => {
                        // Editing a pathway: a tap on another pathway's point goes to the editor (it joins there).
                        if (isCampusTool && campusEdit?.mode === 'pathway') mapInstance.current?.fire('click', { latlng: L.latLng(c.lat, c.lng) });
                        else window.__pathPoint?.(pw.id, idx);
                    }).addTo(pLayer);
                });
            }
        }
        // Solid roofs only where shadows are drawn (Student view); Admin view
        // keeps the see-through fill so the base-map outline shows for tracing.
        // Student view: 2.5D buildings (lifted roofs, sun-shaded walls), like /map.
        const inCampus = campusMatcher(campusFilter, campusAreas);
        drawBuildings(bLayer, buildings.filter((b) => inCampus(buildingArea(b, campusAreas))), {
            popup: buildingPopup, skipId: editingId('building'), theme: mapTheme,
            extrude: isStudentView, sun: sunForWalls,
            // Buildings the previewed route goes into: see-through, door visible.
            xray: new Set((routeResult?.path || []).map((p) => p.building_id).filter((id) => id !== null && id !== undefined)),
        });
        // After the buildings: in the shared overlay pane the last drawn is on top, and decks cross over them.
        if (brLayer) drawBridges(brLayer, bridges, { popup: bridgePopup, skipId: editingId('bridge'), theme: mapTheme, extrude: isStudentView, links, nodes });
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [buildings, pathways, bridges, showCampus, campusEdit, isCampusTool, nodes, links, isAdmin, mapTheme, isStudentView, sunWallsKey, routeResult, campusFilter, campusAreas, pathConnect, closures]);

    // Campus outlines: only in Manage campus areas (and, for context, while one of
    // them is being drawn or edited). Anywhere else they would sit over the whole
    // campus and catch the taps meant for buildings, nodes and the other tools.
    // The one being edited is drawn by its editor instead.
    useEffect(() => {
        const layer = areaLayerRef.current;
        if (!mapInstance.current || !layer) return;
        layer.clearLayers();
        if (tool !== TOOL_AREAS && tool !== TOOL_AREA) return;
        const managing = tool === TOOL_AREAS;
        for (const a of campusAreas) {
            if (areaEdit?.record?.id === a.id) continue;
            const focused = campusFilter === 'all' || String(campusFilter) === String(a.id);
            const shape = L.polygon(a.polygon.map((p) => [p.lat, p.lng]), {
                color: a.color, weight: focused ? 2.5 : 1.5, opacity: focused ? 0.9 : 0.4, dashArray: '10, 7',
                fillColor: a.color, fillOpacity: focused ? 0.08 : 0.03,
                // While drawing another area the map taps must reach the editor.
                interactive: managing, bubblingMouseEvents: false,
            }).addTo(layer);
            shape.bindTooltip(esc(a.name), { permanent: true, direction: 'center', className: 'campus-area-label' });
            if (managing) {
                shape.bindPopup(() => popupCard({
                    swatch: a.color, round: false, title: a.name, tag: 'Campus area',
                    lines: [
                        `<span class="ui-num">${nodes.filter((n) => nodeArea(n, campusAreas)?.id === a.id).length} nodes, ${buildings.filter((b) => buildingArea(b, campusAreas)?.id === a.id).length} buildings inside</span>`,
                    ],
                    actions: [
                        { label: 'Edit', call: ['__editArea', a.id] },
                        { label: 'Reshape', call: ['__reshapeArea', a.id] },
                        { label: 'Show only this campus', call: ['__filterArea', a.id], wide: true },
                    ],
                }));
            }
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [campusAreas, campusFilter, areaEdit, nodes, buildings, tool]);

    // Floor guide drawing (guideBuilding / guideLevel are worked out above
    // the node markers, which sit on the same floor plates).
    useEffect(() => {
        const layer = floorGuideLayerRef.current;
        if (!layer) return;
        const lift = guideBuilding ? drawFloorGuide(layer, guideBuilding, guideLevel) : (layer.clearLayers(), 0);
        guideLiftRef.current = lift;
        setGuideLift(lift);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [guideBuilding?.id, guideBuilding?.floors, guideBuilding?.height_m, guideBuilding?.polygon, guideLevel]);

    // Student view shows the same live sun shadows as /map (Admin view stays
    // flat: shadows would hide the base-map outlines being traced).
    useEffect(() => {
        const layer = shadowLayerRef.current;
        if (!layer) return undefined;
        if (!isStudentView || !showCampus) { layer.clearLayers(); return undefined; }
        drawShadows(layer, buildings, { date: sunDate, lat: CAMPUS_CENTER[0], lng: CAMPUS_CENTER[1] });
        return undefined;
    }, [buildings, isStudentView, showCampus, sunDate]);
    // Student view: the map darkens with the time of day (follows the sun slider too). Admin view stays clear for tracing.
    useEffect(() => {
        if (!mapInstance.current) return;
        drawSkyTint(mapInstance.current, isStudentView ? sunPosition(sunDate, CAMPUS_CENTER[0], CAMPUS_CENTER[1]).altitudeDeg : null);
    }, [isStudentView, sunDate]);
    // Leaving Student view ends the demo (Admin view draws no shadows).
    useEffect(() => { if (!isStudentView) { setSunDemoOn(false); setSunDemoDate(null); } }, [isStudentView]);

    // Staircase links: a dashed amber line between the two ends of each
    // staircase, labelled with its angle, so the admin can see which nodes
    // are joined across floors.
    useEffect(() => {
        const layer = linkLayerRef.current;
        if (!mapInstance.current || !layer) return;
        layer.clearLayers();
        if (isStudentView && tool === IDLE && !editingNode) return;
        const byId = new Map(nodes.map((n) => [n.id, n]));
        for (const l of links) {
            const a = byId.get(l.node_a_id);
            const b = byId.get(l.node_b_id);
            if (!a || !b) continue;
            // A building's staircases show with its nodes (see indoorShown).
            if (!indoorShown(a) || !indoorShown(b)) continue;
            // Floor guide up for this building: the staircase in 2.5D, rising
            // from the lower node's floor plate to the upper one's.
            if (guideBuilding && a.building_id === guideBuilding.id && b.building_id === guideBuilding.id) {
                const lo = Math.min(floorOf(a), floorOf(b));
                const hi = Math.max(floorOf(a), floorOf(b));
                if (lo > guideFloor) continue; // wholly above the cut: hidden with those floors
                const top = Math.max(1, guideBuilding.floors || 1) - 1;
                const liftOf = (f) => floorLiftDeg(guideBuilding, Math.min(Math.max(0, f), top));
                if (hi < guideFloor && manageOnlyFloor) continue; // wholly below the floor being managed
                drawStairs25D(layer, l, a, b, liftOf, { muted: hi < guideFloor, ghost: hi > guideFloor });
                const [low, high] = floorOf(a) <= floorOf(b) ? [a, b] : [b, a];
                for (const [n, f] of [[low, lo], [high, hi]]) {
                    if (f > guideFloor) continue;
                    L.circleMarker([n.latitude + liftOf(f), n.longitude], { radius: 6, color: '#ffb02e', weight: 2, fill: false, interactive: false }).addTo(layer);
                }
                continue;
            }
            const latlngs = [[a.latitude, a.longitude], [b.latitude, b.longitude]];
            const shaped = (Array.isArray(l.flights) && l.flights.length > 1)
                || (l.yaw_deg !== null && l.yaw_deg !== undefined);
            const tip = `Stairs \u00b7 ${floorTag(floorOf(a))} \u2194 ${floorTag(floorOf(b))} \u00b7 ${shaped ? shapeLabel(l.flights) : `${Number(l.angle_deg)}\u00b0`}`;
            if (shaped) {
                // Draw the real outline: every flight and landing, from the lower node,
                // so a switchback or L-shaped stair looks like one on the map.
                const { plan, bottom } = planFromLink(l, a, b);
                const toLL = ([e, n]) => {
                    const p = fromLocalMeters(bottom.latitude, bottom.longitude, e, n);
                    return [p.latitude, p.longitude];
                };
                for (const part of footprint(plan)) {
                    L.polygon(part.ring.map(toLL), {
                        color: '#ffb02e', weight: part.kind === 'landing' ? 1 : 1.5, opacity: 0.95,
                        fillColor: '#ffb02e', fillOpacity: part.kind === 'landing' ? 0.38 : 0.2, interactive: false,
                    }).addTo(layer);
                }
                L.polyline(centreline(plan).map(toLL), { color: '#ffb02e', weight: 2, opacity: 0.9, interactive: false }).addTo(layer);
            }
            L.polyline(latlngs, { color: '#ffb02e', weight: shaped ? 1.5 : 3, opacity: shaped ? 0.55 : 0.95, dashArray: '2, 7', lineCap: 'round', interactive: false }).addTo(layer);
            L.circleMarker(latlngs[0], { radius: 6, color: '#ffb02e', weight: 2, fill: false, interactive: false }).addTo(layer);
            L.circleMarker(latlngs[1], { radius: 6, color: '#ffb02e', weight: 2, fill: false, interactive: false }).addTo(layer);
            L.marker([(a.latitude + b.latitude) / 2, (a.longitude + b.longitude) / 2], {
                icon: L.divIcon({ className: '', html: `<div class="stair-tag">${tip}</div>`, iconSize: [0, 0] }),
                interactive: false, keyboard: false,
            }).addTo(layer);
        }
    }, [links, nodes, isStudentView, tool, editingNode, focusKey, stairPick, swapPick, guideBuilding?.id, guideFloor, manageOnlyFloor]);

    // Render borders as wall polylines on the map
    useEffect(() => {
        if (!mapInstance.current || !borderLayerRef.current) return;
        borderLayerRef.current.clearLayers();
        wallBackLayerRef.current?.clearLayers();
        wallFrontLayerRef.current?.clearLayers();

        // Student view, no wall being edited (nothing open, or the trees / benches / sheds / gates tool): the
        // walls stand up like the buildings (2.5D), as on /map: behind a building under it, in front over it.
        const wallsStand = isStudentView && (tool === IDLE || tool === TOOL_OBJECTS);
        if (showBorders && wallsStand && !isDrawingBorder && wallBackLayerRef.current) {
            drawWalls25D(wallBackLayerRef.current, walls, { theme: mapTheme, sun: sunForWalls, buildings, frontLayer: wallFrontLayerRef.current });
            return;
        }

        // Saved walls honor the visibility toggle; the live draft below it
        // always draws, so points stay visible while creating or editing.
        if (showBorders && !wallsStand) {
            for (const group of borders) {
                if (!group.coordinates || group.coordinates.length < 2) continue;
                // The wall being edited is drawn as the draft instead, so it
                // is not shown twice.
                if (group.group_id === editingWallId) continue;
                const latlngs = group.coordinates.map(c => [c.lat, c.lng]);
                // Visible line: non-interactive so taps fall through to the
                // fat hit line below it.
                L.polyline(latlngs, {
                    color: '#ffffff', weight: 5, opacity: 0.82, interactive: false,
                }).addTo(borderLayerRef.current);
                L.polyline(latlngs, {
                    color: '#000000', weight: 2.6, opacity: 1, interactive: false,
                }).addTo(borderLayerRef.current);
                const popupHtml = popupCard({
                    swatch: '#111114', round: false,
                    title: `Wall ${group.group_id}`,
                    lines: [`<span class="ui-num">${group.coordinates.length} points</span>`, '<span class="pp-muted">Routes never cross it.</span>'],
                    badge: canEditWall(group) ? null : { text: group.created_by == null ? 'View only \u00b7 only an admin can edit it' : 'View only \u00b7 drawn by someone else' },
                    actions: canEditWall(group) ? [
                        { label: 'Edit', call: ['__editWall', group.group_id] },
                        { label: 'Remove', call: ['__deleteBorderGroup', group.group_id], kind: 'danger' },
                    ] : [],
                });
                // Fat invisible hit line: a 4px wall is untappable on phones. It opens the
                // wall's card (Edit / Remove). In the Walls tool with an empty draft, a tap on
                // one of its NODES still starts a new wall joined there (the old behaviour);
                // bubblingMouseEvents off so the tap never also adds a draft point.
                // Not while placing trees, benches, sheds and gates: a tap on a wall there puts a gate in it.
                if (tool !== TOOL_OBJECTS) L.polyline(latlngs, {
                    weight: 26,
                    opacity: 0,
                    interactive: true,
                    className: 'wall-hit',
                    bubblingMouseEvents: false,
                }).on('click', (ev) => {
                    if (isDrawingBorder) {
                        const node = findWallSnap(ev.latlng, -1);
                        if (node) {
                            setDrawingBorderPoints([{ lat: node.lat, lng: node.lng }]);
                            showToast('Connected to wall node');
                            return;
                        }
                    }
                    L.popup().setLatLng(ev.latlng).setContent(popupHtml).openOn(mapInstance.current);
                }).addTo(borderLayerRef.current);
                // Wall nodes stay visible at all times (static dots - the
                // draggable handles appear on these same spots while editing).
                for (const c of group.coordinates) {
                    L.circleMarker([c.lat, c.lng], {
                        radius: isDrawingBorder ? 5 : 2.5, color: '#ffffff', weight: isDrawingBorder ? 2 : 1.25, fillColor: '#000000',
                        fillOpacity: 1, interactive: false,
                    }).addTo(borderLayerRef.current);
                }
            }
        }

        // The draft: one chain, each node connected to the one before it.
        if (drawingBorderPoints.length > 0) {
            const latlngs = drawingBorderPoints.map(p => [p.lat, p.lng]);
            if (latlngs.length >= 2) {
                L.polyline(latlngs, {
                    color: '#ffffff', weight: 5, opacity: 0.82,
                    dashArray: '8, 6', interactive: false,
                }).addTo(borderLayerRef.current);
                L.polyline(latlngs, {
                    color: '#000000', weight: 2.6, opacity: 1,
                    dashArray: '8, 6', interactive: false,
                }).addTo(borderLayerRef.current);
            }
            const lastIdx = drawingBorderPoints.length - 1;
            drawingBorderPoints.forEach((p, k) => {
                const vm = L.marker([p.lat, p.lng], {
                    icon: k === lastIdx ? HEAD_ICON : VERTEX_ICON,
                    draggable: true,
                    // Keep the map from also treating the press as a tap.
                    bubblingMouseEvents: false,
                }).addTo(borderLayerRef.current);

                // The press that starts a drag (or a tap) is always followed
                // by a map click, which must not add a point.
                const stamp = () => { vertexDragAtRef.current = Date.now(); };
                vm.on('mousedown', stamp);
                const el = vm.getElement();
                if (el) el.addEventListener('touchstart', stamp, { passive: true });

                // Ring around the node it is about to stick to.
                let ring = null;
                const clearRing = () => { if (ring) { ring.remove(); ring = null; } };

                // Magnet: while dragging, a node within reach jumps onto the
                // nearest other wall node and shows a ring around it.
                vm.on('drag', (e) => {
                    const hit = findWallSnap(e.target.getLatLng(), k);
                    if (hit) {
                        e.target.setLatLng([hit.lat, hit.lng]);
                        if (!ring) {
                            ring = L.circleMarker([hit.lat, hit.lng], {
                                radius: 13, color: '#ffffff', weight: 2.5, fill: false, interactive: false,
                            }).addTo(borderLayerRef.current);
                        } else {
                            ring.setLatLng([hit.lat, hit.lng]);
                        }
                    } else {
                        clearRing();
                    }
                });
                vm.on('dragend', (e) => {
                    clearRing();
                    stamp();
                    const ll = e.target.getLatLng();
                    const hit = findWallSnap(ll, k);
                    const next = hit ? { lat: hit.lat, lng: hit.lng } : { lat: ll.lat, lng: ll.lng };
                    const [dE, dN] = toLocalMeters(next.lat, next.lng, p.lat, p.lng);
                    if (Math.hypot(dE, dN) > 0.05) {
                        setDrawingBorderPoints(prev => prev.map((q, qi) => (qi === k ? next : q)));
                        if (hit) showToast('Connected to wall node');
                    }
                });

                // Tapping the first node of a chain of three or more closes
                // it into a box (the last node joins the first).
                vm.on('click', () => {
                    stamp();
                    const pts = drawingBorderPoints;
                    if (k === 0 && pts.length >= 3 && !draftClosedFor(pts)) {
                        setDrawingBorderPoints([...pts, { lat: pts[0].lat, lng: pts[0].lng }]);
                        showToast('Box closed. Save the wall to keep it.');
                    }
                });
            });
        }
    }, [borders, walls, drawingBorderPoints, showBorders, editingWallId, isDrawingBorder, isStudentView, tool, mapTheme, sunWallsKey, buildings]);

    // Manage pending node marker
    useEffect(() => {
        if (!mapInstance.current) return;
        const map = mapInstance.current;

        if (pendingMarkerRef.current) {
            map.removeLayer(pendingMarkerRef.current);
            pendingMarkerRef.current = null;
        }

        if (pendingNode && mode === 'addNode') {
            // Same 12px dot (and border) as an existing route node, so the
            // spot being placed is exactly where the saved node will sit.
            // The wrapper is bigger only to give a finger something to drag;
            // the pulse is a ring around the dot, never a scale change.
            const pendingIcon = L.divIcon({
                className: '',
                html: `<div class="pending-hit"><div class="pending-dot" style="
                    width:12px;height:12px;border-radius:50%;
                    background:${THEME};border:2px solid #fff;
                    box-shadow:0 2px 6px rgba(0,0,0,0.3);
                "></div></div>`,
                iconSize: [36, 36],
                iconAnchor: [18, 18],
            });

            const marker = L.marker([pendingNode.latitude + guideLift, pendingNode.longitude], {
                icon: pendingIcon,
                draggable: true,
                zIndexOffset: 1000,
            }).addTo(map);

            marker.on('dragend', (e) => {
                const { lat, lng } = e.target.getLatLng();
                const real = { latitude: lat - guideLiftRef.current, longitude: lng };
                if (!placeableAt(real.latitude, real.longitude)) {
                    showToast(staffPlaceHint);
                    e.target.setLatLng([pendingNode.latitude + guideLiftRef.current, pendingNode.longitude]);
                    return;
                }
                setPendingNode(real);
            });

            pendingMarkerRef.current = marker;
        }

        return () => {
            if (pendingMarkerRef.current) {
                map.removeLayer(pendingMarkerRef.current);
                pendingMarkerRef.current = null;
            }
        };
    }, [pendingNode, mode, guideLift]);

    // Global handlers for popup buttons
    useEffect(() => {
        window.__deleteNode = async (id) => {
            const node = nodes.find((n) => n.id === id);
            if (!(await confirmAction({
                title: `Remove ${node?.name || 'this node'}?`,
                message: 'Its staircase links go with it. This cannot be undone.',
                confirmLabel: 'Remove node', tone: 'danger',
            }))) return;
            try {
                await api.deleteNode(id);
                setEditingNode(null);
                loadData();
                showToast('Node removed');
            } catch (err) {
                onError(err.message);
            }
        };

        window.__editNode = (id) => {
            const node = nodes.find(n => n.id === id);
            if (!node) return;
            if (!canEditNode(node)) { onError(isAdmin ? "Admins edit nodes only on bridges. A building's rooms and routes are managed by its department staff." : node.building_id == null ? 'Only admins edit nodes on bridges.' : "You can edit nodes only inside your department's buildings."); return; }
            // Exclusive modes: opening Edit closes any in-progress Add Node
            // (pending marker, placement clicks and all) or wall edit.
            cancelWallEdit();
            setPendingNode(null);
            if (mode === 'addNode') setMode('navigate');
            if (markersRef.current[id]) {
                markersRef.current[id].closePopup();
            }
            setEditingNode(node);
            setEditName(node.name || '');
            setEditHours(node.opening_hours ?? null);
            setOfficeCloseReason('');
            setEditPublic(Boolean(node.is_public));
            setEditManager(node.manager_id ? String(node.manager_id) : '');
            setEditType(node.type);
            setEditElevation(String(node.elevation));
            setEditFloor(String(node.floor_level));
            // Legacy 'covered' rows were folded into 'inside' — never show a
            // third option the API no longer accepts.
            setEditPathType(node.path_type === 'covered' ? 'inside' : node.path_type);
            // Nodes created before the column existed read back as 'A'.
            setEditCampus(node.campus === 'B' ? 'B' : 'A');
            setEditBuilding(node.building_id ? String(node.building_id) : '');
            setEditDept(node.department?.id ? String(node.department.id) : '');
            setIsSettingPosition(false);
            setIsSettingUserLoc(false);
        };

        window.__giveDestination = (nodeId) => {
            const node = nodes.find(n => n.id === nodeId);
            if (!node) return;

            if (!userLocation) {
                onError('Your location is not available. Turn on location (GPS) and try again.');
                return;
            }

            setSelectedDestination(node);
            setIsComputingRoute(true);
            setRouteResult(null);

            try {
                const result = computeRoute(nodes, nodeId, userLocation.latitude, userLocation.longitude, 0, walls, { buildings, bridges, links, pathways, closedBuildingIds: closedBuildingIds(buildings, new Date(), closures) });
                setRouteResult(result);
                drawRoute(result);
            } catch (err) {
                onError(err.message || 'Failed to compute route');
            } finally {
                setIsComputingRoute(false);
            }
        };

        window.__deleteBorderGroup = async (groupId) => {
            if (!(await confirmAction({
                title: `Remove wall ${groupId}?`,
                message: 'Routes will be able to pass where it stood.',
                confirmLabel: 'Remove wall', tone: 'danger',
            }))) return false;
            try {
                await api.deleteBorderGroup(groupId);
                mapInstance.current?.closePopup();
                loadData();
                showToast('Wall removed');
                return true;
            } catch (err) {
                onError(err.message);
                return false;
            }
        };

        // Open a wall in the drawing draft for editing: drag the dots to
        // reshape, tap the map to extend, Undo to drop the last point, Done
        // to rewrite the group. Closing popups/modes mirrors __editNode.
        window.__editWall = (groupId) => {
            const group = borders.find(g => g.group_id === groupId);
            if (group && !canEditWall(group)) { onError('You can only edit walls you drew yourself.'); return; }
            if (!group || !group.coordinates || group.coordinates.length === 0) {
                onError(`Wall ${groupId} has no points to edit`);
                return;
            }
            cancelWallEdit();
            setPendingNode(null);
            if (mode === 'addNode') setMode('navigate');
            setEditingNode(null);
            setIsSettingPosition(false);
            if (mapInstance.current) mapInstance.current.closePopup();
            setEditingWallId(groupId);
            setDrawingBorderPoints(group.coordinates.map(c => ({ lat: c.lat, lng: c.lng })));
            setIsDrawingBorder(true);
        };

        return () => {
            delete window.__deleteNode;
            delete window.__editNode;
            delete window.__giveDestination;
            delete window.__deleteBorderGroup;
            delete window.__editWall;
        };
    // Everything the handlers read, or a click runs an old copy (it refused CCS staff their own lab before the buildings loaded).
    }, [loadData, onError, nodes, userLocation, borders, drawRoute, mode, buildings, bridges, links, pathways, isAdmin, myDeptId, myId]);

    // Popup buttons on buildings and pathways (re-bound every render so they
    // always see the current lists).
    useEffect(() => {
        window.__editBuilding = (id) => {
            const b = buildings.find((x) => x.id === id);
            if (!b) return;
            if (!canEditBuilding(b)) { onError('You can only edit buildings of your own department.'); return; }
            startCampus('building', b);
        };
        window.__openStudio = (id) => {
            const b = buildings.find((x) => x.id === id);
            if (!b || !canStudio(b)) return;
            mapInstance.current?.closePopup();
            setStudioId(id);
        };
        window.__moveBuilding = (id) => {
            const b = buildings.find((x) => x.id === id);
            if (!b) return;
            if (!canEditBuilding(b)) { onError('You can only move buildings of your own department.'); return; }
            startCampus('building', b, 'shape');
        };
        window.__movePathway = (id) => {
            const p = pathways.find((x) => x.id === id);
            if (p) startCampus('pathway', p, 'shape');
        };
        window.__closeBuildingNow = (id) => closeBuildingNow(buildings.find((x) => x.id === id));
        window.__reopenBuilding = (id) => reopenBuilding(buildings.find((x) => x.id === id));
        const nodeWord = (n) => `${n} ${n === 1 ? 'node' : 'nodes'}`;
        window.__deleteBuilding = async (id) => {
            const b = buildings.find((x) => x.id === id);
            const inside = nodes.filter((n) => n.building_id === id).length;
            if (!b || !(await confirmAction({
                title: `Remove ${b.name}?`,
                message: inside
                    ? `The building and the ${nodeWord(inside)} filed under it (rooms, offices and indoor routes on every floor) are deleted, with their staircases. This cannot be undone.`
                    : 'The outline and label are deleted. No nodes are filed under it.',
                confirmLabel: 'Remove building', tone: 'danger',
            }))) return;
            try {
                const res = await api.deleteBuilding(id);
                mapInstance.current?.closePopup();
                loadData();
                showToast(res?.nodes_deleted ? `Building and ${nodeWord(res.nodes_deleted)} removed` : 'Building removed');
            } catch (err) { onError(err.message); }
        };
        window.__editBridge = (id) => {
            const br = bridges.find((x) => x.id === id);
            if (br) startCampus('bridge', br);
        };
        window.__manageBridge = (id) => {
            const br = bridges.find((x) => x.id === id);
            if (br) openManageBridge(br);
        };
        window.__connectBridge = (id) => {
            const br = bridges.find((x) => x.id === id);
            if (br) startBridgeConnect(br);
        };
        window.__moveBridge = (id) => {
            const br = bridges.find((x) => x.id === id);
            if (br) startCampus('bridge', br, 'shape');
        };
        window.__deleteBridge = async (id) => {
            const br = bridges.find((x) => x.id === id);
            const onDeck = br ? nodes.filter(onDeckOf(br)).length : 0;
            if (!br || !(await confirmAction({
                title: `Remove ${br.name}?`,
                message: onDeck
                    ? `The bridge and the ${nodeWord(onDeck)} on its deck are deleted, with the staircases up to them. The ground routes the stairs came down to stay. This cannot be undone.`
                    : 'The outline and label are deleted. There are no nodes on its deck.',
                confirmLabel: 'Remove bridge', tone: 'danger',
            }))) return;
            try {
                const res = await api.deleteBridge(id);
                mapInstance.current?.closePopup();
                loadData();
                showToast(res?.nodes_deleted ? `Bridge and ${nodeWord(res.nodes_deleted)} removed` : 'Bridge removed');
            } catch (err) { onError(err.message); }
        };
        window.__editPathway = (id) => {
            const p = pathways.find((x) => x.id === id);
            if (p) startCampus('pathway', p);
        };
        // A pathway point was tapped: it becomes the selected (green) point, the one a tap on the map
        // extends from. Tapping a point on another walkway while one is selected joins the two, then
        // selects it; tapping the selected point again lets go of it.
        window.__pathPoint = async (pathwayId, idx) => {
            const pw = pathways.find((x) => x.id === pathwayId);
            const at = pw?.coordinates?.[idx];
            if (!at) return;
            mapInstance.current?.closePopup();
            if (pathConnect && pathConnect.pathwayId === pathwayId && pathConnect.idx === idx) { setPathConnect(null); return; }
            const from = pathConnect && pathConnect.pathwayId !== pathwayId
                ? pathways.find((x) => x.id === pathConnect.pathwayId) : null;
            const start = from?.coordinates?.[pathConnect.idx];
            if (start) {
                try {
                    // A short walkway joining the two points (covered only when both ends are).
                    await api.createPathway({
                        kind: from.kind === 'covered' && pw.kind === 'covered' ? 'covered' : 'walkway',
                        status: 'existing', source: 'custom', coordinates: [start, at],
                    });
                    await loadData();
                    showToast('Walkways connected');
                } catch (err) { onError(err.message); return; }
            }
            setPathConnect({ pathwayId, idx });
        };
        window.__deletePathway = async (id) => {
            const p = pathways.find((x) => x.id === id);
            if (!(await confirmAction({
                title: `Remove ${p?.name || 'this pathway'}?`,
                message: 'Routes stop following it. Anything that was reached only along it may become unreachable.',
                confirmLabel: 'Remove pathway', tone: 'danger',
            }))) return;
            try {
                await api.deletePathway(id);
                mapInstance.current?.closePopup();
                loadData();
                showToast('Pathway removed');
            } catch (err) { onError(err.message); }
        };
        window.__qrNode = (id) => {
            const n = nodes.find((x) => x.id === id);
            if (!n) return;
            mapInstance.current?.closePopup();
            setQrSheet({ title: 'QR code', subtitle: n.name || (n.type === 'route' ? 'Route node' : 'Location'), nodes: [n] });
        };
        window.__editArea = (id) => { const a = campusAreas.find((x) => x.id === id); if (a) startArea(a); };
        window.__reshapeArea = (id) => { const a = campusAreas.find((x) => x.id === id); if (a) startArea(a, 'shape'); };
        window.__filterArea = (id) => { mapInstance.current?.closePopup(); chooseCampusFilter(String(id)); };
        return () => {
            delete window.__qrNode;
            delete window.__editArea;
            delete window.__reshapeArea;
            delete window.__filterArea;
            delete window.__editBuilding;
            delete window.__moveBuilding;
            delete window.__openStudio;
            delete window.__movePathway;
            delete window.__closeBuildingNow;
            delete window.__reopenBuilding;
            delete window.__deleteBuilding;
            delete window.__editPathway;
            delete window.__deletePathway;
            delete window.__pathPoint;
            delete window.__editBridge;
            delete window.__connectBridge;
            delete window.__manageBridge;
            delete window.__moveBridge;
            delete window.__deleteBridge;
        };
    });

    // Handle map click in addNode mode, setting position mode, or setting user location
    useEffect(() => {
        if (!mapInstance.current) return;
        const map = mapInstance.current;

        const handleMapClick = async (e) => {
            const { lat, lng } = e.latlng;

            // Wall drawing mode: each tap adds a wall node and connects it to
            // the previous one. A tap that lands on an existing wall node
            // reuses that node instead, so walls join exactly. Nothing is
            // written until Save.
            if (isDrawingBorder) {
                // Ignore the map click that follows a node press or drag.
                if (Date.now() - vertexDragAtRef.current < 350) return;
                const hit = findWallSnap(e.latlng, -1);
                const pt = hit ? { lat: hit.lat, lng: hit.lng } : { lat, lng };
                const pts = drawingBorderPoints;
                const last = pts[pts.length - 1];
                // Tapping the node you just placed must not stack a copy on it.
                if (last && last.lat === pt.lat && last.lng === pt.lng) return;
                setDrawingBorderPoints([...pts, pt]);
                if (hit) showToast('Connected to wall node');
                return;
            }

            // Debug: set user position
            if (isSettingUserLoc) {
                // Manual pin wins: stop any GPS watch so it can't overwrite it.
                stopGpsWatch();
                setUserLocation({ latitude: lat, longitude: lng });
                // A hand-placed pin is a relocation, not a step: jump.
                placeUserDot(lat, lng, { snap: true });
                showToast(`User set: ${lat.toFixed(6)}, ${lng.toFixed(6)}`);
                // One shot: placing the pin ends the mode, so the next tap on
                // the map goes back to normal selection instead of moving it.
                setIsSettingUserLoc(false);
                return;
            }

            // Extending a pathway: a new point where the map was tapped, joined to the selected point. From an
            // end the pathway itself grows; from a middle point a branch starts. The new point stays selected,
            // so each tap adds the next one.
            if (pathConnect) {
                const pw = pathways.find((x) => x.id === pathConnect.pathwayId);
                const from = pw?.coordinates?.[pathConnect.idx];
                if (!from) { setPathConnect(null); return; }
                const to = { lat, lng };
                const last = pw.coordinates.length - 1;
                try {
                    if (pathConnect.idx === 0 || pathConnect.idx === last) {
                        const atStart = pathConnect.idx === 0 && last > 0;
                        await api.updatePathway(pw.id, { coordinates: atStart ? [to, ...pw.coordinates] : [...pw.coordinates, to] });
                        await loadData();
                        setPathConnect({ pathwayId: pw.id, idx: atStart ? 0 : last + 1 });
                    } else {
                        const made = await api.createPathway({
                            kind: pw.kind, status: 'existing', source: 'custom', coordinates: [from, to],
                            ...(pw.width_m ? { width_m: pw.width_m } : {}),
                        });
                        await loadData();
                        setPathConnect(made?.id ? { pathwayId: made.id, idx: 1 } : null);
                    }
                    showToast('Point added');
                } catch (err) { onError(err.message); }
                return;
            }

            if (mode === 'addNode') {
                // With a floor guide up, the tap lands on the raised floor
                // plate: shift it back down to the real (ground) position.
                const realLat = lat - guideLiftRef.current;
                // Staff: a tap outside their buildings places nothing, and says why.
                if (!placeableAt(realLat, lng)) { showToast(staffPlaceHint); return; }
                // Only the position changes: a tap used to wipe whatever had
                // already been typed into the form.
                setPendingNode({ latitude: realLat, longitude: lng });
                revealPoint(lat, lng);
                return;
            }

            if (isSettingPosition && editingNode) {
                await moveEditingNodeTo(lat - guideLiftRef.current, lng);
            }
        };

        map.on('click', handleMapClick);
        return () => map.off('click', handleMapClick);
    }, [mode, isSettingPosition, editingNode, isSettingUserLoc, isDrawingBorder, drawingBorderPoints, borders, editingWallId, showBorders, pathConnect, pathways]);

    // Cursor circle when setting position
    useEffect(() => {
        if (!mapInstance.current) return;
        const map = mapInstance.current;

        if (!isSettingPosition) {
            if (cursorCircleRef.current) {
                map.removeLayer(cursorCircleRef.current);
                cursorCircleRef.current = null;
            }
            map.getContainer().style.cursor = '';
            return;
        }

        map.getContainer().style.cursor = 'crosshair';

        const cursorCircle = L.circleMarker([0, 0], {
            // Same 16px visual footprint as a route node, white like the
            // move handle. The cursor is a preview, not a coloured marker.
            radius: 8,
            fillColor: '#ffffff',
            fillOpacity: 0.95,
            color: 'rgba(10,10,12,0.55)',
            weight: 1.5,
            opacity: 1,
            interactive: false,
        }).addTo(map);
        cursorCircleRef.current = cursorCircle;

        const onMouseMove = (e) => {
            cursorCircle.setLatLng(e.latlng);
        };

        map.on('mousemove', onMouseMove);

        return () => {
            map.off('mousemove', onMouseMove);
            map.removeLayer(cursorCircle);
            cursorCircleRef.current = null;
            map.getContainer().style.cursor = '';
        };
    }, [isSettingPosition]);

    // Hide route while setting position, restore when done
    useEffect(() => {
        if (!mapInstance.current || !routeLayerRef.current) return;
        if (isSettingPosition) {
            mapInstance.current.removeLayer(routeLayerRef.current);
        } else if (routeResult) {
            routeLayerRef.current.addTo(mapInstance.current);
        }
    }, [isSettingPosition, routeResult]);

    // Clear route when switching modes
    useEffect(() => {
        if (routeLayerRef.current) {
            routeLayerRef.current.clearLayers();
        }
        setRouteResult(null);
        setSelectedDestination(null);
    }, [mode]);

    const pinUnmoved = !!(lastAddedSpot && pendingNode
        && lastAddedSpot.latitude === pendingNode.latitude
        && lastAddedSpot.longitude === pendingNode.longitude);

    const handleCreateNode = async () => {
        if (!pendingNode || pinUnmoved) return;
        if (formType === 'location' && !formName.trim()) {
            onError('Name is required for locations');
            return;
        }
        try {
            await api.createNode({
                name: formName.trim() || null,
                type: formType,
                latitude: pendingNode.latitude,
                longitude: pendingNode.longitude,
                elevation: parseFloat(formElevation) || 0,
                floor_level: parseInt(formFloor) || 0,
                path_type: formPathType,
                campus: formCampus,
                // Admins add outdoor nodes; staff file theirs under their building.
                building_id: isAdmin || formBuilding === '' ? null : Number(formBuilding),
                ...(isAdmin ? { department_id: formDept === '' ? null : Number(formDept) } : {}),
            });
            // The form stays open with every detail kept, so a run of rooms or
            // route nodes is tap, (rename), Add. A name ending in a number
            // counts up ("Room 101" then "Room 102"). Add waits for the pin
            // to move so the same spot is never added twice.
            setFormName((name) => nextNodeName(name));
            setLastAddedSpot(pendingNode);
            loadData();
            showToast(`${formType === 'location' ? 'Location' : 'Route node'} added. Tap the map for the next one.`);
        } catch (err) {
            onError(err.message);
        }
    };

    const handleUpdateNode = async () => {
        if (!editingNode) return;
        if (isOfficeStaff) {
            if (hoursProblem(editHours)) { onError(hoursProblem(editHours)); return; }
            try {
                await api.updateNode(editingNode.id, { opening_hours: editHours });
                setEditingNode(null);
                loadData();
                showToast('Hours saved');
            } catch (err) { onError(err.message); }
            return;
        }
        if (editType === 'location' && !editName.trim()) {
            onError('Name is required for locations');
            return;
        }
        const hoursLocked = hoursLockedFor(editManager);
        if (editType === 'location' && !hoursLocked && hoursProblem(editHours)) {
            onError(hoursProblem(editHours));
            return;
        }
        try {
            await api.updateNode(editingNode.id, {
                name: editName.trim() || null,
                type: editType,
                elevation: parseFloat(editElevation) || 0,
                floor_level: parseInt(editFloor) || 0,
                path_type: editPathType,
                campus: editCampus,
                building_id: editBuilding === '' ? null : Number(editBuilding),
                ...(isAdmin ? { department_id: editDept === '' ? null : Number(editDept) } : {}),
                // Only a place (location) has hours, or is shown to visitors; a route node never is. The hours of
                // an office someone else runs are theirs to set, so they are left out.
                ...(editType !== 'location' ? { opening_hours: null } : hoursLocked ? {} : { opening_hours: editHours }),
                is_public: editType === 'location' && editPublic,
                ...(!isAdmin && editType === 'location' ? { manager_id: editManager === '' ? null : Number(editManager) } : {}),
            });
            setEditingNode(null);
            setIsSettingPosition(false);
            loadData();
            showToast('Node updated');
        } catch (err) {
            onError(err.message);
        }
    };

    // Creates the wedge once a heading AND a dot position both exist, then
    // leaves it to the follower/angle easing. Either can arrive first.
    const ensurePovMarker = () => {
        const map = mapInstance.current;
        const cur = followRef.current.current;
        const spin = povSpinRef.current;
        if (!map || !cur || !spin.hasValue) return;
        if (!povMarkerRef.current) {
            // 900 < 1000: the wedge always sits beneath the dot.
            povMarkerRef.current = L.marker([cur.lat, cur.lng], {
                icon: POV_ICON, zIndexOffset: 900, interactive: false, keyboard: false,
            }).addTo(map);
            paintPovRotation(povMarkerRef.current, spin.angle);
        }
    };

    // Single entry point for moving the "you are here" dot (GPS fix or manual
    // pin). `snap` skips the glide.
    const placeUserDot = (lat, lng, { snap = false } = {}) => {
        const map = mapInstance.current;
        if (!map) return;
        const follow = followRef.current;
        if (!userMarkerRef.current) {
            userMarkerRef.current = L.marker([lat, lng], { icon: USER_ICON, zIndexOffset: 1000, title: 'Your location' })
                .addTo(map)
                .bindPopup('Your location');
            follow.snapTo(lat, lng);
        } else if (snap) {
            follow.snapTo(lat, lng);
        } else {
            follow.moveTo(lat, lng);
        }
        ensurePovMarker();
    };

    // Locate: center map on user + start watching position for live routes
    const applyGpsFix = (latitude, longitude, { center = false } = {}) => {
        setUserLocation({ latitude, longitude });
        if (center) mapInstance.current?.flyTo([latitude, longitude], 19);
        // Eased: the dot glides to each new fix instead of teleporting.
        placeUserDot(latitude, longitude);
    };

    const stopGpsWatch = () => {
        if (watchIdRef.current !== null) {
            try { navigator.geolocation.clearWatch(watchIdRef.current); } catch { /* already gone */ }
            watchIdRef.current = null;
        }
        setGpsLive(false);
    };

    const startGpsWatch = ({ center = false, onFail = null } = {}) => {
        if (!navigator.geolocation) {
            if (onFail) onFail(new Error('unsupported'));
            return;
        }
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                const { latitude, longitude } = pos.coords;
                applyGpsFix(latitude, longitude, { center });
                setGpsLive(true);
                // Start continuous tracking for live route updates.
                if (watchIdRef.current === null) {
                    watchIdRef.current = navigator.geolocation.watchPosition(
                        (p) => applyGpsFix(p.coords.latitude, p.coords.longitude),
                        () => setGpsLive(false),
                        // maximumAge 0: never re-serve a cached fix, so the
                        // dot follows the receiver as fast as it reports.
                        { enableHighAccuracy: true, maximumAge: 0 }
                    );
                }
            },
            (err) => {
                setGpsLive(false);
                if (onFail) onFail(err);
            },
            { enableHighAccuracy: true, timeout: 10000 }
        );
    };

    const handleMyLocation = () => {
        // A real tap: the only place iOS lets us ask for compass access.
        headingListenerRef.current?.prompt();
        if (!navigator.geolocation) {
            onError('Geolocation is not supported by your browser');
            return;
        }
        startGpsWatch({
            center: true,
            onFail: (err) => onError(`Geolocation error: ${err.message}`),
        });
    };

    // Writes a new position for the node being edited. Shared by the two ways
    // of choosing it in Move mode: tapping the map, and the GPS button.
    // `nodeId` pins the write to the node that was being moved when the
    // request started (a GPS fix takes a few seconds; the admin may have
    // opened a different node by then).
    const moveEditingNodeTo = async (lat, lng, nodeId = editingNode?.id) => {
        if (nodeId === undefined || nodeId === null) return false;
        if (!placeableAt(lat, lng)) { showToast(staffPlaceHint); return false; }
        try {
            await api.updateNode(nodeId, { latitude: lat, longitude: lng });
            setEditingNode((prev) => (prev && prev.id === nodeId ? { ...prev, latitude: lat, longitude: lng } : prev));
            setIsSettingPosition(false);
            loadData();
            showToast('Position updated');
            return true;
        } catch (err) {
            onError(err.message);
            return false;
        }
    };

    // Move mode, GPS route: one fresh fix becomes the node's new position.
    // Explicit tap only (never automatic). If Move was cancelled, or another
    // tool took over, while the fix was in flight, the result is dropped
    // instead of moving a node the admin no longer asked to move.
    const handleMoveNodeToMyLocation = () => {
        if (!editingNode) return;
        if (!navigator.geolocation) {
            onError('Geolocation is not supported by your browser');
            return;
        }
        if (moveGpsBusyRef.current) return;
        moveGpsBusyRef.current = true;
        setMoveGpsBusy(true);
        const nodeId = editingNode.id;
        const done = () => { moveGpsBusyRef.current = false; setMoveGpsBusy(false); };
        navigator.geolocation.getCurrentPosition(
            async (pos) => {
                const { latitude, longitude } = pos.coords;
                if (!moveToolActiveRef.current) { done(); return; }
                mapInstance.current?.flyTo([latitude, longitude], 19);
                await moveEditingNodeTo(latitude, longitude, nodeId);
                done();
            },
            (err) => {
                done();
                onError(`Geolocation error: ${err.message}`);
            },
            { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
        );
    };

    // One-shot GPS fix for node placement (explicit tap only - never auto).
    // Moves only the pending marker; form fields are left untouched.
    const handleUseMyLocationForNode = () => {
        if (!navigator.geolocation) {
            onError('Geolocation is not supported by your browser');
            return;
        }

        navigator.geolocation.getCurrentPosition(
            (pos) => {
                const { latitude, longitude } = pos.coords;
                if (!placeableAt(latitude, longitude)) { onError(`Your GPS position is outside your department's buildings. ${staffPlaceHint}`); return; }
                setPendingNode({ latitude, longitude });
                mapInstance.current?.flyTo([latitude, longitude], 19);
                showToast(`Pinned to GPS: ${latitude.toFixed(6)}, ${longitude.toFixed(6)}`);
            },
            (err) => {
                onError(`Geolocation error: ${err.message}`);
            },
            { enableHighAccuracy: true, timeout: 10000 }
        );
    };

    // A node placed inside a labelled building is filed under it (and marked
    // inside) unless a building was already picked for this one.
    useEffect(() => {
        if (isAdmin || !pendingNode) return;
        const b = buildingAt(ownBuildings, pendingNode.latitude, pendingNode.longitude);
        if (b && String(b.id) !== formBuilding) {
            setFormBuilding(String(b.id));
            setFormPathType('inside');
            // Keep the chosen floor when the new building has it.
            setFormFloor((f) => String(Math.min(parseInt(f, 10) || 0, Math.max(0, (b.floors || 1) - 1))));
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pendingNode]);

    // Campus tool: label a building / add a pathway, or edit an existing one.
    // Like every tool it first releases the others.
    const startCampus = (mode, record = null, startStep = null) => {
        cancelWallEdit();
        setManageBuildingId(null);
        setPendingNode(null);
        setEditingNode(null);
        setStairPick(null);
        setSwapPick(null);
        setCampusOpen(false);
        mapInstance.current?.closePopup();
        setManageBridgeId(null);
        setCampusEdit({ mode, record, startStep, key: Date.now() });
        setTool(mode === 'building' ? TOOL_BUILDING : mode === 'bridge' ? TOOL_BRIDGE : TOOL_PATHWAY);
    };
    const endCampus = () => {
        setCampusEdit(null);
        setTool(IDLE);
    };
    // Manage campus areas: the only place campus outlines are shown. Tap one to edit,
    // reshape or filter by it; New area draws one. Like every tool it first releases
    // the others, and the map frames the areas when none is in view.
    const startManageAreas = () => {
        cancelWallEdit();
        setCampusEdit(null);
        setAreaEdit(null);
        setManageBuildingId(null);
        setPendingNode(null);
        setEditingNode(null);
        setStairPick(null);
        setSwapPick(null);
        setCampusOpen(false);
        mapInstance.current?.closePopup();
        setTool(TOOL_AREAS);
        const map = mapInstance.current;
        if (map && campusAreas.length) {
            const all = L.latLngBounds(campusAreas.flatMap((a) => a.polygon.map((p) => [p.lat, p.lng])));
            if (!map.getBounds().intersects(all)) map.fitBounds(all, { padding: [40, 40], maxZoom: 19 });
        }
    };
    const endManageAreas = () => {
        mapInstance.current?.closePopup();
        setAreaEdit(null);
        setTool(IDLE);
    };
    // Draw a new area (record null) or edit one; reached from Manage campus areas,
    // and back there when the editor closes or saves.
    const startArea = (record = null, startStep = null) => {
        mapInstance.current?.closePopup();
        setAreaEdit({ record, startStep, key: Date.now() });
        setTool(TOOL_AREA);
    };
    const endArea = () => {
        setAreaEdit(null);
        setTool(TOOL_AREAS);
    };
    // Show one campus: remembered on this device, and the map frames that campus.
    const chooseCampusFilter = (value) => {
        setCampusFilter(value);
        try { localStorage.setItem('admin_campus_filter', value); } catch { /* blocked storage */ }
        const area = campusAreas.find((a) => String(a.id) === String(value));
        if (area && mapInstance.current) {
            mapInstance.current.fitBounds(L.latLngBounds(area.polygon.map((p) => [p.lat, p.lng])), { padding: [40, 40], maxZoom: 19 });
        }
    };

    // Manage nodes' "Add node on floor": opens Add node with the pin already in the
    // building's middle, filed under it, as an inside location on the ground
    // floor. The pin can still be dragged or re-tapped before saving.
    const addNodeInBuilding = (b, floor = 0) => {
        // Inside the outline even for L / U shapes (their centre is outside).
        const c = interiorPoint(b.polygon);
        if (!c) return;
        if (!placeableAt(c.lat, c.lng)) { showToast(staffPlaceHint); return; }
        mapInstance.current?.closePopup();
        setCampusEdit(null);
        enterAddNodeMode();
        setPendingNode({ latitude: c.lat, longitude: c.lng });
        setFormType('location');
        setFormBuilding(String(b.id));
        setFormPathType('inside');
        setFormFloor(String(floor));
        if (b.department?.id && isAdmin) setFormDept(String(b.department.id));
        revealPoint(c.lat, c.lng);
    };

    // Office swap: pick the second location on the map, confirm, done.
    const startSwapPick = () => {
        if (!editingNode) return;
        setConfirmDelete(false);
        setSwapPick({ sourceId: editingNode.id });
    };
    window.__pickSwapOffice = async (otherId) => {
        const pick = swapPick;
        if (!pick) return;
        const a = nodes.find((n) => n.id === pick.sourceId);
        const b = nodes.find((n) => n.id === otherId);
        if (!a || !b) { setSwapPick(null); return; }
        if (!(await confirmAction({
            title: `Swap ${a.name} and ${b.name}?`,
            message: 'Each spot keeps its building and floor; the names and departments trade places.',
            confirmLabel: 'Swap offices', tone: 'primary',
        }))) return;
        setSwapPick(null);
        try {
            await api.swapNodes(a.id, b.id);
            setEditingNode(null);
            loadData();
            showToast(`${a.name} and ${b.name} swapped`);
        } catch (err) { onError(err.message); }
    };
    useEffect(() => () => { delete window.__pickSwapOffice; }, []);

    // Staircase links are written straight away (no draft): each call is one
    // link, and loadData() re-reads them so the map and the list agree.
    const createStairLink = async (sourceId, otherId, draft) => {
        try {
            const a = nodes.find((n) => n.id === sourceId);
            const b = nodes.find((n) => n.id === otherId);
            const flights = normalizeFlights(draft.flights, draft.angle_deg);
            let yaw = draft.yaw_deg;
            // Direction not chosen: aim the stairs so they end on the second node
            // (stacked nodes can't tell us, so the direction stays unset and
            // clients fall back to their own default).
            if ((yaw === null || yaw === undefined) && a && b) {
                const [bottom, top] = floorOf(a) <= floorOf(b) ? [a, b] : [b, a];
                const [e, n] = toLocalMeters(top.latitude, top.longitude, bottom.latitude, bottom.longitude);
                yaw = fitYaw({
                    rise: stairRise(bottom, top), topOffset: { e, n }, flights,
                    angleDeg: draft.angle_deg, landingM: draft.landing_m,
                });
            }
            await api.createNodeLink({
                node_a_id: sourceId,
                node_b_id: otherId,
                angle_deg: meanAngle(flights),
                yaw_deg: yaw ?? null,
                flights,
                landing_m: draft.landing_m,
            });
            setLinks(await api.getNodeLinks());
            showToast('Staircase connected');
            return true;
        } catch (err) { onError(err.message); return false; }
    };
    useEffect(() => () => { delete window.__pickStairEnd; }, []);
    // New staircase: pick the ends on the map first, then set its shape and
    // slope in the dialog (it then knows the real rise and layout).
    // From the edit sheet the edited node is the first end.
    const startStairPick = () => {
        if (!editingNode) return;
        setConfirmDelete(false);
        setStairPick({ sourceId: editingNode.id, floor: null });
    };
    // Connect a bridge: the tapped deck node is the top of the stairs; next, its ground end.
    window.__pickBridgeDeck = (id) => {
        setBridgeConnect(null);
        setStairPick({ sourceId: id, floor: 0 });
    };
    // From Manage nodes: tap the first end on the floor shown.
    window.__pickStairStart = (id) => {
        setStairStart(null);
        setStairPick({ sourceId: id, floor: null });
    };
    // Tapped the other end: on to the shape / slope dialog.
    window.__pickStairEnd = (otherId) => {
        const pick = stairPick;
        if (!pick) return;
        setStairPick(null);
        setStairConfig({ sourceId: pick.sourceId, otherId });
    };
    useEffect(() => () => { delete window.__pickStairStart; delete window.__pickBridgeDeck; }, []);
    // `patch` holds only what changed: yaw_deg, flights (+ angle_deg), landing_m or angle_deg.
    const updateStairLink = async (link, patch) => {
        try {
            await api.updateNodeLink(link.id, patch);
            setLinks(await api.getNodeLinks());
            showToast('Staircase updated');
        } catch (err) { onError(err.message); setLinks(await api.getNodeLinks().catch(() => links)); }
    };
    const removeStairLink = async (link) => {
        try {
            await api.deleteNodeLink(link.id);
            setLinks(await api.getNodeLinks());
            showToast('Staircase removed');
        } catch (err) { onError(err.message); }
    };

    // Navigate is the idle state: it cancels every map tool, because a tool
    // and normal panning cannot both own the same tap.
    const enterNavigateMode = () => {
        cancelWallEdit();
        setPendingNode(null);
        setEditingNode(null);
        setIsSettingPosition(false);
        setIsSettingUserLoc(false);
        setMode('navigate');
    };

    // Manual pin: one map tap, then the mode ends by itself (see the click
    // handler). Turning it on leaves Add node, node move and wall drafting.
    const toggleUserPin = () => {
        if (isSettingUserLoc) {
            setIsSettingUserLoc(false);
            return;
        }
        cancelWallEdit();
        setPendingNode(null);
        setEditingNode(null);
        setIsSettingPosition(false);
        setMode('navigate');
        setIsSettingUserLoc(true);
    };

    // Repositioning keeps the edit panel open - it is the same node - but
    // releases the other map tools before the picker cursor appears.
    const toggleNodeMove = () => {
        if (isSettingPosition) {
            setIsSettingPosition(false);
            return;
        }
        cancelWallEdit();
        setPendingNode(null);
        setMode('navigate');
        setIsSettingPosition(true);
    };

    const enterAddNodeMode = () => {
        // Exclusive modes: opening Add Node closes any in-progress Edit
        // (panel, position-picker cursor and all), wall edit or manual pin.
        cancelWallEdit();
        setEditingNode(null);
        setIsSettingPosition(false);
        setIsSettingUserLoc(false);
        setMode('addNode');

        // No auto-geolocation and no pre-placed pin: the first step is a slim
        // bar asking for a tap, so the map stays fully visible. The details
        // sheet only appears once there is a spot to describe.
        setPendingNode(null);
        setLastAddedSpot(null);
        setFormName('');
        setFormType('route');
        setFormElevation('0');
        setFormFloor('0');
        setFormPathType('outside');
        setFormCampus('A');
        setFormBuilding('');
        setFormDept('');
    };

    // Keep a freshly placed point clear of the bottom sheet on phones.
    const revealPoint = (lat, lng) => {
        const map = mapInstance.current;
        if (!map || window.innerWidth > 640) return;
        const size = map.getSize();
        const sheetPx = Math.min(size.y * 0.52, 420) + 24;
        const p = map.latLngToContainerPoint([lat, lng]);
        const safeBottom = size.y - sheetPx;
        if (p.y > safeBottom - 24 || p.y < 56) {
            map.panBy([0, p.y - Math.max(80, safeBottom / 2)], { animate: true });
        }
    };

    // Undo removes the last wall node.
    const undoWallPoint = () => {
        if (drawingBorderPoints.length === 0) return;
        setDrawingBorderPoints(prev => prev.slice(0, -1));
    };

    // Nearest other wall node within WALL_SNAP_PX of a position: a node of
    // any saved wall (not the one being edited) or another node of the draft
    // (`skipIdx` is the node being dragged, so it never snaps to itself).
    const findWallSnap = (latlng, skipIdx = -1) => {
        const map = mapInstance.current;
        if (!map) return null;
        const here = map.latLngToContainerPoint(latlng);
        let best = null;
        let bestD = WALL_SNAP_PX;
        const consider = (lat, lng) => {
            const d = here.distanceTo(map.latLngToContainerPoint([lat, lng]));
            if (d <= bestD) { bestD = d; best = { lat, lng }; }
        };
        if (showBorders) {
            for (const g of borders) {
                if (g.group_id === editingWallId) continue;
                for (const c of g.coordinates || []) consider(c.lat, c.lng);
            }
        }
        drawingBorderPoints.forEach((q, i) => { if (i !== skipIdx) consider(q.lat, q.lng); });
        return best;
    };

    // Cancel needs a second tap when real work would be lost.
    const requestDiscardWall = () => {
        if (drawingBorderPoints.length >= 2 && !confirmDiscard) {
            setConfirmDiscard(true);
            clearTimeout(discardTimerRef.current);
            discardTimerRef.current = setTimeout(() => setConfirmDiscard(false), 3000);
            return;
        }
        clearTimeout(discardTimerRef.current);
        setConfirmDiscard(false);
        const wasEditing = editingWallId !== null;
        cancelWallEdit();
        showToast(wasEditing ? 'Wall edit cancelled' : 'Wall drawing cancelled');
    };

    // Exactly one surface owns the bottom of the screen at any time.
    const surface = swapPick ? 'swap-pick' : stairPick ? 'stair-pick' : stairStart ? 'stair-start' : bridgeConnect ? 'bridge-connect' : pathConnect ? 'path-connect' : surfaceFor({ tool, hasPending: !!pendingNode, hasEditing: !!editingNode, hasManaging: !!manageBuilding || !!manageBridge });

    // Connect a raised bridge to the ground routes, from its popup or Edit panel.
    const startBridgeConnect = (br) => {
        endCampus();
        setEditingNode(null);
        setManageBuildingId(null);
        mapInstance.current?.closePopup();
        setBridgeConnect({ bridgeId: br.id });
        const c = interiorPoint(br.polygon);
        if (c) revealPoint(c.lat, c.lng);
    };

    // Manage nodes for a bridge: its deck's nodes, from its Edit panel or popup.
    const openManageBridge = (br) => {
        endCampus();
        setEditingNode(null);
        setManageBuildingId(null);
        mapInstance.current?.closePopup();
        setManageBridgeId(br.id);
        setManageFloor(Number(br.deck_floor) || 0);
        const c = interiorPoint(br.polygon);
        if (c) revealPoint(c.lat, c.lng);
    };
    // "Add node on the deck": Add node with the pin in the deck's middle, on the deck's
    // floor, in no building, sheltered under a roof. The pin can still be moved before saving.
    const addNodeOnBridge = (br) => {
        const c = interiorPoint(br.polygon);
        if (!c) return;
        mapInstance.current?.closePopup();
        setCampusEdit(null);
        enterAddNodeMode();
        setPendingNode({ latitude: c.lat, longitude: c.lng });
        setFormType('route');
        setFormBuilding('');
        setFormPathType(br.roofed ? 'inside' : 'outside');
        setFormFloor(String(Number(br.deck_floor) || 0));
        revealPoint(c.lat, c.lng);
    };

    // Manage nodes, opened from a building's Edit panel.
    const openManageNodes = (b) => {
        endCampus();
        setEditingNode(null);
        setManageBridgeId(null);
        mapInstance.current?.closePopup();
        setManageFloor(0);
        setManageBuildingId(b.id);
        const c = interiorPoint(b.polygon);
        if (c) revealPoint(c.lat, c.lng);
    };

    const destinationCount = nodes.filter(n => n.type === 'location').length;
    const pathNodeCount = nodes.filter(n => n.type === 'route').length;

    // ── A wall is an open line of nodes; it is a box when its last node
    // sits exactly on its first (drag the last onto the first, or tap the
    // first). The router blocks any edge crossing a segment, so the closing
    // segment seals the box.
    const draftClosed = draftClosedFor(drawingBorderPoints);

    // Wall button: starts a draft, or saves it when one is open.
    const toggleWallDrawing = () => {
        if (isDrawingBorder) {
            if (drawingBorderPoints.length >= 2) {
                // Save the wall: points stay in tap order as one open line.
                // Rewriting an edited wall keeps its group id (delete +
                // recreate - row order is id order, so the line survives).
                const wallId = editingWallId;
                (async () => {
                    try {
                        const nextGroupId = wallId !== null ? wallId : (borders.length > 0
                            ? Math.max(...borders.map(g => g.group_id)) + 1
                            : 0);
                        if (wallId !== null) {
                            await api.deleteBorderGroup(wallId);
                        }
                        for (const p of drawingBorderPoints) {
                            await api.createBorder({ latitude: p.lat, longitude: p.lng, group_id: nextGroupId });
                        }
                        const updated = await api.getBorders();
                        const grouped = {};
                        for (const b of updated) {
                            if (!grouped[b.group_id]) grouped[b.group_id] = { group_id: b.group_id, created_by: b.created_by ?? null, coordinates: [] };
                            grouped[b.group_id].coordinates.push({ lat: b.latitude, lng: b.longitude });
                        }
                        setBorders(Object.values(grouped));
                        showToast(wallId !== null ? `Wall ${wallId} updated (${drawingBorderPoints.length} points)` : `Wall saved (${drawingBorderPoints.length} points)`);
                    } catch (err) {
                        onError(err.message);
                    }
                })();
            } else {
                showToast('Tap at least 2 points for a wall');
                return;
            }
            setDrawingBorderPoints([]);
            setIsDrawingBorder(false);
            setEditingWallId(null);
        } else {
            // Only one map tool at a time: leave add-node, node-move and the
            // manual pin before the first wall point is captured.
            setMode('navigate');
            setPendingNode(null);
            setEditingNode(null);
            setIsSettingPosition(false);
            setIsSettingUserLoc(false);
            setIsDrawingBorder(true);
            setDrawingBorderPoints([]);
        }
    };

    const dot = (color, ring) => (
        <span className={`lg-dot${ring ? ' is-you' : ''}`} style={{ background: color }} />
    );
    const legendRow = (color, text, count, ring) => (
        <li className="lg-row" key={text}>
            {dot(color, ring)}
            <span className="lg-name" title={text}>{text}</span>
            {count !== '' && count != null && <span className="lg-count ui-num">{count}</span>}
        </li>
    );
    const departmentNodeCounts = new Map();
    let unassignedCount = 0;
    nodes.forEach((node) => {
        if (!node.department) {
            unassignedCount += 1;
        } else if (node.department.id != null) {
            const id = node.department.id;
            departmentNodeCounts.set(id, (departmentNodeCounts.get(id) || 0) + 1);
        }
    });
    const departmentsOnMap = departments.filter(d => departmentNodeCounts.has(d.id));

    const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

    // Surfaces that animate out before they unmount.
    const legendP = usePresence(showLegend && surface === 'dock');
    const routeP = usePresence(!!routeResult && surface === 'dock');
    const computingP = usePresence(isComputingRoute, 240);
    const heldRoute = useHold(routeResult);
    const heldDest = useHold(selectedDestination);

    return (
        <div style={styles.container} className="admin-shell">
            <style>{`
                @keyframes toastIn {
                    0% { opacity: 0; transform: translate(-50%, -12px) scale(0.96); }
                    10%, 82% { opacity: 1; transform: translate(-50%, 0) scale(1); }
                    100% { opacity: 0; transform: translate(-50%, -6px) scale(0.98); }
                }
                @keyframes toastBar { from { transform: scaleX(1); } to { transform: scaleX(0); } }
                @keyframes toastEnter {
                    from { opacity: 0; transform: translate(-50%, -12px) scale(0.96); }
                    to { opacity: 1; transform: translate(-50%, 0) scale(1); }
                }
                @keyframes popupIn { from { opacity: 0; transform: translateY(8px) scale(0.94); } }

                .map-in { animation: fadeIn 0.6s var(--ease-out) both; }

                /* ── Legend ── header, scrolling body, pinned "You" footer.
                   Sits directly under the zoom control (--zoom-stack). */
                .legend-box { padding: 0; overflow: hidden; }
                .lg-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; padding: 12px 14px 8px; flex: none; }
                .lg-title { margin: 0; font-size: ${TYPE.sub}; font-weight: 700; color: #fff; }
                .lg-total { font-size: ${TYPE.desc}; color: ${MUTED}; }
                .lg-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 0 14px; }
                .lg-group + .lg-group { margin-top: 10px; padding-top: 10px; border-top: 1px solid ${C.hairline}; }
                .lg-label { margin: 0 0 4px; font-size: ${TYPE.desc}; font-weight: 600; color: ${MUTED}; letter-spacing: 0.01em; }
                .lg-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
                .lg-row { display: flex; align-items: center; gap: 10px; min-height: 30px; }
                .lg-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: 500; }
                .lg-count { flex: none; min-width: 28px; padding: 1px 7px; border-radius: 6px; background: rgba(255,255,255,0.08); text-align: center; font-size: ${TYPE.desc}; font-weight: 600; color: ${TEXT}; }
                .lg-dot { flex: none; width: 12px; height: 12px; border-radius: 50%; border: 2px solid #fff; box-shadow: 0 1px 3px rgba(0,0,0,0.35); }
                .lg-dot.is-you { box-shadow: 0 0 0 3px rgba(214,27,27,0.45); }
                .lg-dept-list { padding-right: 4px; }
                .lg-foot { flex: none; margin-top: 10px; padding: 4px 14px 6px; border-top: 1px solid ${C.hairline}; }
                .legend-scroll-hint { margin: 4px 0 0; font-size: ${TYPE.desc}; color: ${MUTED}; line-height: 1.35; }

                ${MAP_CONTROLS_CSS}
                ${MAP_ZOOM_CSS}
                ${CAMPUS_EDITOR_CSS}
                ${MANAGE_NODES_CSS}

                @media (max-width: 640px) {
                    .leaflet-top.leaflet-left .leaflet-control-zoom { margin: max(8px, env(safe-area-inset-top)) 0 0 8px; }
                    /* chip: top + 4px, 36px tall; legend starts 8px below it. */
                    .legend-box { top: calc(max(8px, env(safe-area-inset-top)) + 48px) !important; bottom: auto !important; left: auto !important; right: max(8px, env(safe-area-inset-right)) !important; width: min(232px, calc(100vw - 80px)) !important; max-height: min(40dvh, 320px) !important; }
                    .lg-head { padding: 10px 12px 6px; } .lg-body, .lg-foot { padding-left: 12px; padding-right: 12px; }
                    .lg-row { min-height: 30px; }
                    .admin-toast { max-width: calc(100vw - 32px); left: 16px !important; right: 16px !important; }
                    .map-pill { min-height: 42px; padding: 0 14px; font-size: 13px; }
                }

                .map-pill {
                    display: inline-flex; align-items: center; gap: 6px; min-height: 44px; padding: 0 18px;
                    border-radius: ${PILL}px; background: ${C.glass}; color: #fff;
                    border: 1px solid rgba(214,27,27,0.6); font: inherit; font-size: ${TYPE.sub}; font-weight: 600;
                    cursor: pointer; pointer-events: auto; box-shadow: 0 6px 18px rgba(0,0,0,0.5);
                    transition: background-color 0.25s var(--ease-out), transform 0.4s var(--ease-spring), border-color 0.25s ease;
                }
                .map-pill:hover { background: ${C.surfaceHover}; border-color: ${C.accent}; transform: translateY(-2px); }
                .map-pill:active { transform: scale(0.96); }
                .map-pill:focus-visible { outline: 2px solid ${C.focus}; outline-offset: 2px; }

                .coords { font-variant-numeric: tabular-nums; }
                .status-meta { display: flex; flex-wrap: wrap; gap: 2px 14px; }
                .gps-state { display: inline-flex; align-items: center; gap: 7px; }
                .gps-state[data-live="true"] { color: #fff; }

                .legend-box > * { animation: tbIn 0.5s var(--ease-out) both; animation-delay: calc(var(--k, 0) * 40ms + 80ms); }
                .legend-box > :nth-child(2) { --k: 1; } .legend-box > :nth-child(3) { --k: 2; }
                .legend-box > :nth-child(4) { --k: 3; } .legend-box > :nth-child(5) { --k: 4; }
                .tb-sep { height: 1px; margin: 4px 6px; background: ${C.hairline}; flex: none; }

                .move-note { margin-top: 8px; padding: 10px 12px; border-radius: ${RADIUS}px; background: rgba(255,255,255,0.06); border: 1px solid ${C.hairline}; font-size: ${TYPE.desc}; line-height: 1.45; color: ${MUTED}; }
                .danger-confirm { margin-top: 10px; padding: 12px; border-radius: ${RADIUS}px; background: ${C.dangerBg}; border: 1px solid rgba(255,35,56,0.4); }
                .danger-confirm .row { display: flex; gap: 8px; margin-top: 10px; }
                .danger-confirm .row .ui-btn { flex: 1; }

                .admin-toast-ok { flex: none; color: ${C.accent}; }
                .admin-toast-icon { flex: none; display: grid; place-items: center; width: 22px; height: 22px; border-radius: 50%;
                    background: ${C.danger}; color: #fff; font-size: 13px; font-weight: 800; }
                .admin-toast-x { flex: none; min-width: 32px; min-height: 32px; border: 0; border-radius: 50%; background: transparent;
                    color: rgba(255,255,255,0.7); font: inherit; font-size: 17px; line-height: 1; cursor: pointer; }
                .admin-toast-x:hover { color: #fff; background: rgba(255,255,255,0.1); }
                .admin-toast-x:focus-visible { outline: ${TAP.focusOutline}; outline-offset: 2px; }
                .toast-bar { position: absolute; left: 0; right: 0; bottom: 0; height: 3px; background: ${C.primary}; transform-origin: left; animation: toastBar 2.5s linear forwards; }

                /* ── Map markers and route ── */
                .leaflet-marker-icon > div { transition: transform 0.4s var(--ease-spring), box-shadow 0.3s ease; }
                .leaflet-marker-icon:hover > div { transform: scale(1.3); }
                .user-dot { position: relative; }
                .user-dot::after {
                    content: ''; position: absolute; inset: -3px; border-radius: 50%;
                    border: 2px solid rgba(74, 222, 128,0.75); animation: ring 2.2s var(--ease-out) infinite;
                }
                .leaflet-marker-icon:hover > .pending-hit { transform: none; }
                .pending-hit { width: 36px; height: 36px; display: grid; place-items: center; cursor: grab; }
                .pending-dot { animation: pendingRing 1.6s var(--ease-out) infinite; }
                @keyframes pendingRing { 0% { box-shadow: 0 0 0 0 rgba(255,255,255,0.55), 0 2px 6px rgba(0,0,0,0.3); } 100% { box-shadow: 0 0 0 10px rgba(255,255,255,0), 0 2px 6px rgba(0,0,0,0.3); } }
                @media (prefers-reduced-motion: reduce) { .pending-dot { animation: none; } }
                .stair-pick-ring { animation: stairPickPulse 1.4s ease-in-out infinite; }
                @keyframes stairPickPulse { 0%, 100% { stroke-opacity: 1; } 50% { stroke-opacity: 0.35; } }
                @media (prefers-reduced-motion: reduce) { .stair-pick-ring { animation: none; } }
                .stair-pick-tip { padding: 2px 8px; border-radius: 6px; border: 0; background: #ffb02e; color: #1a1200; font-size: 12px; font-weight: 700; box-shadow: 0 1px 4px rgba(0,0,0,0.45); }
                .stair-pick-tip::before { display: none; }
                .mt-stair-floors { display: flex; gap: 6px; flex-wrap: wrap; }
                /* Satellite opacity row in the View menu. */
                .mt-sat-row { cursor: default; gap: 10px; }
                .mt-sat-row:hover { background: transparent; }
                .mt-sat-row label { flex: none; font-size: ${TYPE.desc}; color: ${MUTED}; }
                .mt-sat-row input[type="range"] { flex: 1; min-width: 0; accent-color: ${C.primary}; height: 32px; cursor: pointer; }
                .mt-sat-row output { flex: none; min-width: 40px; text-align: right; font-size: ${TYPE.desc}; font-variant-numeric: tabular-nums; }
                .mt-campus-row { cursor: default; gap: 10px; }
                .mt-campus-row:hover { background: transparent; }
                .mt-campus-row label { flex: none; font-size: ${TYPE.desc}; color: ${MUTED}; }
                .mt-campus-row .ui-select { flex: 1; min-width: 0; min-height: 36px; }
                /* Campus area names: quiet, on the outline's middle, never in the way of taps. */
                .leaflet-tooltip.campus-area-label {
                    background: rgba(16, 16, 20, 0.72); color: #fff; border: 0; border-radius: 6px; box-shadow: none;
                    padding: 2px 8px; font-size: 12px; font-weight: 700; letter-spacing: 0.02em; pointer-events: none;
                }
                .leaflet-tooltip.campus-area-label::before { display: none; }

                /* Loading / failed chip and the first-run card in the bottom stack. */
                .mt-loading { display: flex; align-items: center; gap: 10px; min-height: 48px; padding: 6px 8px 6px 14px; font-size: ${TYPE.sub}; color: ${MUTED}; }
                .mt-loading .ui-btn { margin-left: auto; }
                .mt-start { padding: 14px 14px 12px; }
                .mt-start-title { margin: 0; font-size: ${TYPE.lead}; font-weight: 700; color: #fff; }
                .mt-start-steps { margin: 8px 0 0; padding-left: 20px; display: flex; flex-direction: column; gap: 6px; font-size: 13px; line-height: 1.45; color: ${MUTED}; }
                .mt-start-steps strong { color: ${TEXT}; font-weight: 600; }
                .mt-start-actions { display: flex; gap: 8px; margin-top: 12px; }
                .mt-start-actions .ui-btn { flex: 1 1 0; min-width: 0; }

                /* View switch: top centre, same segmented look as the forms. */
                .view-switch {
                    position: absolute; z-index: 1000; top: 12px; left: 50%; transform: translateX(-50%);
                    border-radius: ${PILL}px; background: ${C.glass};
                }
                /* Button skin and the sliding thumb come from .seg (INTERACTION_CSS). */
                .view-switch .vs-short { display: none; }
                @media (pointer: coarse) { .view-switch button { min-height: ${TAP.minHeight}; } }
                @media (max-width: 640px) {
                    .view-switch { top: calc(max(8px, env(safe-area-inset-top)) + 4px); }
                    .view-switch button { padding: 0 10px; }
                    .view-switch .vs-long { display: none; }
                    .view-switch .vs-short { display: inline; }
                }
                .stair-tag { transform: translate(-50%, -50%); padding: 2px 8px; border-radius: 6px; white-space: nowrap; font-size: 12px; font-weight: 700; color: #1a1200; background: #ffb02e; box-shadow: 0 1px 4px rgba(0,0,0,0.45); pointer-events: none; }
                .mt-stairs { margin-top: 14px; padding-top: 12px; border-top: 1px solid ${C.hairline}; }
                .mt-stairs-title { margin: 0 0 4px; font-size: ${TYPE.sub}; font-weight: 700; color: #fff; }
                .mt-stairs-list { list-style: none; margin: 0 0 10px; padding: 0; display: flex; flex-direction: column; gap: 8px; }
                .mt-stairs-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
                .mt-stairs-name { flex: 1 1 120px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: 500; }
                .mt-stairs-angle { display: inline-flex; align-items: center; gap: 6px; }
                .mt-stairs-angle .ui-input { width: 64px; }
                .mt-stairs-add { display: flex; gap: 8px; align-items: flex-end; }
                .wall-node-pad { width: 28px; height: 28px; display: grid; place-items: center; cursor: grab; }
                /* Touch: a 12-16 px node gets a 32 px invisible hit area (WCAG 2.5.8 minimum 24 px);
                   not 44, because route nodes along a walkway sit about 26 px apart at zoom 19. */
                @media (pointer: coarse) { .node-hit::after { content: ''; position: absolute; inset: -10px; border-radius: 50%; } }
                .leaflet-marker-icon:hover > .wall-node-pad { transform: none; }
                .anchor-dot { animation: popIn 0.5s var(--ease-spring) both; }

                /* ── Leaflet chrome, themed to the ARNode HUD ── */
                .leaflet-container { background: ${PAGE} !important; font: inherit; }
                .leaflet-container a { color: ${C.accent} !important; }
                .leaflet-popup-content-wrapper {
                    background: rgba(12,12,16,0.97); color: ${TEXT};
                    border: 1px solid rgba(34, 197, 94,0.30);
                    border-radius: ${PANEL_RADIUS}px; box-shadow: ${ELEVATION.overlay};
                }
                .leaflet-popup-content { margin: 14px 16px; line-height: 1.45; font-size: ${TYPE.sub}; }
                .leaflet-popup-tip { background: rgba(12,12,16,0.97); box-shadow: none; }
                .leaflet-popup-close-button { color: ${MUTED} !important; }
                .leaflet-control-attribution {
                    background: rgba(12,12,16,0.72) !important; color: ${MUTED} !important; font-size: 12px !important;
                }
                /* Phones: the bottom stack spans the width, so the map credit (a licence
                   requirement) sits just above whatever it shows: the dock, a tool's bar
                   or a sheet (--mt-stack-h is measured, see stackRef). */
                @media (max-width: 640px) {
                    .map-in .leaflet-bottom.leaflet-right { margin-bottom: calc(var(--mt-stack-h, 68px) + 16px + env(safe-area-inset-bottom)); }
                }

                /* Map popups (Leaflet innerHTML, so plain classes; see popupCard). */
                .pp { min-width: 220px; max-width: 280px; display: flex; flex-direction: column; gap: 3px; }
                .pp-head { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; min-width: 0; }
                .pp-swatch { flex: none; width: 12px; height: 12px; border-radius: 50%; border: 2px solid #fff; box-shadow: 0 1px 3px rgba(0,0,0,0.4); }
                .pp-swatch.is-square { border-radius: 3px; }
                .pp-title { min-width: 0; font-size: ${TYPE.lead}; font-weight: 700; color: #fff; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
                .pp-tag { flex: none; padding: 1px 8px; border-radius: 6px; background: rgba(255,255,255,0.08); font-size: ${TYPE.desc}; font-weight: 600; color: ${TEXT}; }
                .pp-line { font-size: ${TYPE.desc}; line-height: 1.45; color: ${MUTED}; }
                .pp-line.is-strong { color: ${TEXT}; }
                .pp-muted { color: ${MUTED}; }
                .pp-dot { display: inline-block; width: 9px; height: 9px; margin-right: 6px; border-radius: 50%; vertical-align: 0; }
                .pp-badge { align-self: flex-start; margin-top: 6px; }
                .pp-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-top: 12px; }
                .pp-actions .is-wide { grid-column: 1 / -1; }
                .popup-btn {
                    min-height: 38px; padding: 0 14px; border-radius: ${PILL}px; cursor: pointer;
                    font: inherit; font-size: 13px; font-weight: 600; width: 100%;
                    border: 1px solid rgba(255,255,255,0.16); background: rgba(255,255,255,0.08); color: #fff;
                    transition: background-color var(--dur-fast) var(--ease-out), border-color var(--dur-fast) ease, transform var(--dur-base) var(--ease-spring);
                    -webkit-tap-highlight-color: transparent;
                }
                .popup-btn:hover { background: rgba(255,255,255,0.14); transform: translateY(-1px); }
                .popup-btn:active { transform: scale(0.97); transition-duration: 80ms; }
                .popup-btn:focus-visible { outline: 2px solid ${C.focus}; outline-offset: 2px; }
                .popup-btn-primary { background: ${C.primary}; border-color: transparent; }
                .popup-btn-primary:hover { background: ${C.primaryHover}; }
                .popup-btn-danger { background: transparent; color: ${C.danger}; border-color: rgba(255,85,102,0.5); }
                .popup-btn-danger:hover { background: rgba(255,35,56,0.12); }
            `}</style>
            <div ref={mapRef} className={tab === 'map' ? 'map-in' : undefined} style={{ ...styles.map, display: tab === 'map' ? 'block' : 'none' }} />
            {/* The sky draws into its own Leaflet pane (CloudField3D), so it needs no slot here. */}
            <React.Suspense fallback={null}><CloudField3D weather={weather} mapRef={mapInstance} /></React.Suspense>

            {tab === 'departments' && isAdmin && (
                <AdminDepartments
                    departments={departments}
                    users={users}
                    currentUser={currentUser}
                    onChanged={loadData}
                    notify={showToast}
                    fail={onError}
                />
            )}

            {tab === 'students' && isAdmin && (
                <AdminStudents notify={showToast} fail={onError} />
            )}

            {tab === 'courses' && (
                <AdminCourses currentUser={currentUser} departments={departments} notify={showToast} fail={onError} />
            )}

            {tab === 'announcements' && (
                <AdminAnnouncements
                    currentUser={currentUser} departments={departments} buildings={buildings} nodes={nodes} closures={closures}
                    onChanged={async () => { try { setClosures(await api.getClosures()); } catch { /* the list stays as it was */ } }}
                    notify={showToast} fail={onError}
                />
            )}
            {tab === 'activity' && (
                <AdminActivity isAdmin={isAdmin} fail={onError} />
            )}

            {tab === 'weather' && isAdmin && (
                <AdminWeather fail={onError} />
            )}

            {tab === 'map' && (<>
            <h1 className="sr-only">Campus map</h1>
            {/* Legend: colour key with counts. Three labelled groups (map
                nodes, departments, you) instead of one undivided list. */}
            {legendP.mounted && (
            <aside style={styles.legend} className="legend-box pres pres-side" data-state={legendP.state} aria-label="Map legend">
                <header className="lg-head">
                    <h2 className="lg-title">Legend</h2>
                    <span className="lg-total ui-num">{plural(nodes.length, 'node', 'nodes')}</span>
                </header>
                <div className="lg-body ui-scroll-window">
                    <section className="lg-group" aria-label="Node types">
                        <h3 className="lg-label">Node type</h3>
                        <ul className="lg-list">
                            {legendRow(NODE_TYPE_COLORS.location, 'Location', destinationCount)}
                            {legendRow(NODE_TYPE_COLORS.route, 'Route node', pathNodeCount)}
                        </ul>
                    </section>
                    {(buildings.length > 0 || pathways.length > 0) && (
                        <section className="lg-group" aria-label="Campus features">
                            <h3 className="lg-label">Campus</h3>
                            {/* Only kinds that exist on the map: a key full of 0 rows is noise. */}
                            <ul className="lg-list">
                                {[
                                    ['rgba(255,255,255,0.25)', 'Labelled building', buildings.length],
                                    [CAMPUS_COLORS.construction, 'Under construction', buildings.filter((b) => b.status === 'under_construction').length + pathways.filter((p) => p.status === 'under_construction').length],
                                    [CAMPUS_COLORS.covered.dark, 'Covered walkway', pathways.filter((p) => p.kind === 'covered').length],
                                    [CAMPUS_COLORS.road.dark, 'Road / walkway', pathways.filter((p) => p.kind !== 'covered').length],
                                ].filter(([, , n]) => n > 0).map(([color, text, n]) => legendRow(color, text, n))}
                            </ul>
                        </section>
                    )}
                    {(departmentsOnMap.length > 0 || unassignedCount > 0) && (
                        <section className="lg-group" aria-label="Departments represented on the map">
                            <h3 className="lg-label">Department</h3>
                            <ScrollWindow
                                as="ul" className="lg-list lg-dept-list"
                                rows={4} phoneRows={3} rowHeight={30}
                                count={departmentsOnMap.length + (unassignedCount > 0 ? 1 : 0)}
                                label="Departments on the map"
                            >
                                {departmentsOnMap.map(d => legendRow(d.color, d.name, departmentNodeCounts.get(d.id) || 0))}
                                {unassignedCount > 0 && legendRow('#bbb', 'Unassigned', unassignedCount)}
                            </ScrollWindow>
                        </section>
                    )}
                </div>
                <footer className="lg-foot">
                    <ul className="lg-list">{legendRow('#fff', 'You', '', true)}</ul>
                </footer>
            </aside>
            )}

            {/* GPS chip: one quiet line, top-right. */}
            <div
                className="mt-card view-switch seg" role="radiogroup" aria-label="Map view"
                style={{ '--seg-i': viewMode === 'student' ? 1 : 0, '--seg-n': 2 }}
            >
                <span className="seg-thumb" aria-hidden="true" />
                {[
                    { value: 'admin', label: 'Admin view', short: 'Admin', hint: 'Base map buildings and roads shown: best for tracing' },
                    { value: 'student', label: 'Student view', short: 'Student', hint: 'Exactly what students see on /map' },
                ].map((o) => (
                    <button
                        key={o.value} role="radio" aria-checked={viewMode === o.value} title={o.hint}
                        onClick={() => { setViewMode(o.value); showToast(o.value === 'student' ? 'Student view: as seen on /map' : 'Admin view: base map shapes shown'); }}
                    >
                        <span className="vs-long">{o.label}</span><span className="vs-short">{o.short}</span>
                    </button>
                ))}
            </div>

            <div className="mt-card mt-status" data-live={gpsLive} role="status">
                <span>{userLocation ? (gpsLive ? 'GPS live' : 'Manual pin') : 'No position'}</span>
                <span className="zoom ui-num">Zoom {zoom}</span>
                {userLocation && (
                    <span className="coords">{userLocation.latitude.toFixed(6)}, {userLocation.longitude.toFixed(6)}</span>
                )}
            </div>

            {/* Bottom stack: ONE column, and exactly one tool surface in it.
                Idle shows the dock; an active tool replaces it with a slim
                bar (waiting for a tap) or a compact sheet (details), so the
                map is never buried under panels while placing a node/wall. */}
            <div className="mt-stack" ref={stackRef}>
                {dataLoaded === null && (
                    <div className="mt-card mt-loading mt-enter" role="status">
                        <span className="btn-spin" aria-hidden="true" />
                        <span>Loading the campus map</span>
                    </div>
                )}
                {dataLoaded === false && (
                    <div className="mt-card mt-loading mt-enter" role="status">
                        <span>The map data did not load.</span>
                        <button className="ui-btn ui-btn-secondary ui-btn-sm" onClick={() => { setDataLoaded(null); loadData(); }}>Try again</button>
                    </div>
                )}
                {dataLoaded === true && surface === 'dock' && !startHidden && nodes.length === 0 && buildings.length === 0 && (
                    <section className="mt-card mt-start mt-enter" aria-labelledby="mt-start-title">
                        <h2 className="mt-start-title" id="mt-start-title">Start mapping the campus</h2>
                        <ol className="mt-start-steps">
                            {isAdmin && <li><strong>Label the buildings.</strong> Campus, then tap an outline from the base map.</li>}
                            <li><strong>Add rooms.</strong> Tap a building, choose Edit, then Manage nodes.</li>
                            <li><strong>Connect them with route nodes</strong> along the walkways, so routes can be found.</li>
                        </ol>
                        <div className="mt-start-actions">
                            {isAdmin
                                ? <button className="ui-btn ui-btn-primary" onClick={() => startCampus('building')}>Label a building</button>
                                : <button className="ui-btn ui-btn-primary" onClick={enterAddNodeMode}>Add the first node</button>}
                            <button className="ui-btn ui-btn-secondary" onClick={() => setStartHidden(true)}>Not now</button>
                        </div>
                    </section>
                )}
                {routeP.mounted && heldRoute && (
                    <div className="pres" data-state={routeP.state} style={styles.routePanel}>
                        <div style={{ fontSize: TYPE.lead, fontWeight: 700, color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {heldDest?.name || 'Destination'}
                        </div>
                        <div className="ui-num" style={{ fontSize: TYPE.sub, color: MUTED, margin: '2px 0 12px', display: 'flex', gap: '14px' }}>
                            <strong style={{ color: C.accent }}>{heldRoute.total_distance_meters} m</strong>
                            <span>{plural(heldRoute.node_count, 'stop', 'stops')}</span>
                        </div>
                        <button
                            className="ui-btn ui-btn-secondary ui-btn-block"
                            onClick={() => {
                                setRouteResult(null);
                                setSelectedDestination(null);
                                if (routeLayerRef.current) routeLayerRef.current.clearLayers();
                                showToast('Route cleared');
                            }}
                        >
                            Clear route
                        </button>
                    </div>
                )}
                {computingP.mounted && (
                    <div className="pres" data-state={computingP.state} style={{ ...styles.routePanel, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10 }} role="status">
                        <span className="btn-spin" aria-hidden="true" />
                        <span style={{ fontSize: TYPE.sub, color: MUTED }}>Finding route</span>
                    </div>
                )}

                {surface === 'dock' && viewOpen && (
                    <div className="mt-card mt-menu mt-enter ui-stagger" role="group" aria-label="View options">
                        <MenuToggle label="Walls" on={showBorders} onClick={() => setShowBorders(!showBorders)} />
                        <MenuToggle label="Buildings & pathways" on={showCampus} onClick={() => setShowCampus(!showCampus)} />
                        {campusAreas.length > 0 && (
                            <div className="mt-row mt-campus-row">
                                <label htmlFor="admin-campus-filter">Campus</label>
                                <select
                                    id="admin-campus-filter" className="ui-select" value={campusFilter}
                                    onChange={(e) => chooseCampusFilter(e.target.value)}
                                >
                                    <option value="all">All campuses</option>
                                    {campusAreas.map((a) => <option key={a.id} value={String(a.id)}>{a.name}</option>)}
                                    <option value="none">Outside every campus area</option>
                                </select>
                            </div>
                        )}
                        <MenuToggle
                            label={satellite.online ? 'Satellite imagery' : 'Satellite imagery (needs internet)'}
                            on={satellite.active}
                            onClick={() => { if (satellite.online) satellite.setOn(!satellite.on); }}
                        />
                        {satellite.active && (
                            <div className="mt-row mt-sat-row">
                                <label htmlFor="admin-sat-op">Photo</label>
                                <input
                                    id="admin-sat-op" type="range" min="0" max="100" step="5" value={satellite.opacity}
                                    onChange={(e) => satellite.setOpacity(e.target.value)} aria-valuetext={`${satellite.opacity}% photo`}
                                />
                                <output htmlFor="admin-sat-op">{satellite.opacity}%</output>
                            </div>
                        )}
                        <MenuToggle
                            label="Shadow time demo" on={sunDemoOn}
                            onClick={() => {
                                const next = !sunDemoOn;
                                setSunDemoOn(next);
                                if (next) { setViewMode('student'); setShowCampus(true); setViewOpen(false); } else setSunDemoDate(null);
                            }}
                        />
                        <MenuToggle
                            label="Auto-frame route" on={autoFit}
                            onClick={() => {
                                const next = !autoFit;
                                setAutoFit(next);
                                autoFitRef.current = next;
                                if (next && routeResult) drawRoute(routeResult);
                            }}
                        />
                        <MenuToggle label="Legend" on={showLegend} onClick={() => setShowLegend(!showLegend)} />
                        <MenuAction label="Center on me" onClick={() => { setViewOpen(false); handleMyLocation(); }} />
                        <MenuAction label="Reload data" onClick={() => { setViewOpen(false); loadData(); }} />
                    </div>
                )}

                {surface === 'dock' && sunDemoOn && isStudentView && (
                    <SunTimeSlider
                        value={sunDemoDate} onChange={setSunDemoDate}
                        lat={CAMPUS_CENTER[0]} lng={CAMPUS_CENTER[1]}
                        onClose={() => { setSunDemoOn(false); setSunDemoDate(null); }}
                    />
                )}

                {surface === 'dock' && campusOpen && isAdmin && (
                    <div className="mt-card mt-menu mt-enter ui-stagger" role="group" aria-label="Campus tools">
                        <MenuAction label={`Label a building (${buildings.length} labelled)`} onClick={() => startCampus('building')} />
                        <MenuAction label={`Add a bridge (${bridges.length} drawn)`} onClick={() => startCampus('bridge')} />
                        <MenuAction label={`Manage campus areas (${campusAreas.length} drawn)`} onClick={startManageAreas} />
                        <MenuAction label={`Trees, benches, sheds and gates (${campusObjects.length} placed)`} onClick={startObjects} />
                        <p className="ui-hint" style={{ margin: '4px 12px 8px' }}>
                            Adopt a shape from the base map or draw a new one (e.g. a building under construction).
                            Tap a building or bridge on the map to edit it. Roads and walkways: Add path. Rooms, offices and doors are managed by each building's department staff.
                        </p>
                    </div>
                )}

                {surface === 'dock' && (
                    <ToolDock
                        viewOpen={viewOpen}
                        addPath={isAdmin}
                        // Admins draw roads and walkways (routes); department staff place the nodes in their buildings.
                        onAdd={isAdmin ? () => { setViewOpen(false); setCampusOpen(false); startCampus('pathway'); } : enterAddNodeMode}
                        onWalls={toggleWallDrawing}
                        onPin={toggleUserPin}
                        onView={() => { setCampusOpen(false); setViewOpen((v) => !v); }}
                        onCampus={isAdmin ? () => { setViewOpen(false); setCampusOpen((v) => !v); } : null}
                        campusOpen={campusOpen}
                    />
                )}

                {surface === 'campus' && campusEdit && (
                    <CampusEditor
                        key={campusEdit.key}
                        map={mapInstance.current}
                        mode={campusEdit.mode}
                        record={campusEdit.record}
                        buildings={buildings}
                        pathways={pathways}
                        departments={departments}
                        onError={onError}
                        onClose={endCampus}
                        onSaved={(message) => { endCampus(); loadData(); showToast(message); }}
                        // Edit is where a building's nodes are managed.
                        onManageNodes={campusEdit.mode === 'bridge' ? openManageBridge : (isAdmin ? null : openManageNodes)}
                        onConnectBridge={startBridgeConnect}
                        canChangeDepartment={isAdmin}
                        // The building head's "Close now" (and Reopen), separate from the hours.
                        closedNow={campusEdit.mode === 'building' && campusEdit.record ? closedNowOf(campusEdit.record) || null : null}
                        onCloseNow={campusEdit.mode === 'building' && canCloseNow(campusEdit.record) ? (reason) => closeBuildingNow(campusEdit.record, reason) : null}
                        onReopen={() => reopenBuilding(campusEdit.record)}
                        nodes={nodes}
                        borders={borders}
                        links={links}
                        startStep={campusEdit.startStep}
                        theme={mapTheme}
                    />
                )}

                {surface === 'objects' && (
                    <ObjectPalette
                        count={campusObjects.length}
                        placeKind={objectKind}
                        onPlaceKind={(k) => { setObjectKind(k); setObjectNote(null); }}
                        selected={objectDraft}
                        campus={{ objects: shownObjects, buildings, pathways, bridges }}
                        onChange={(patch) => setObjectDraft((d) => ({ ...d, ...patch }))}
                        onSave={saveObject}
                        onDelete={removeObject}
                        onDeselect={() => { setObjectDraft(null); setObjectNote(null); }}
                        onDone={() => { setObjectDraft(null); setObjectNote(null); setPlacedIds([]); setTool(IDLE); }}
                        placedCount={placedIds.length}
                        onUndo={undoPlaced}
                        onCancel={cancelPlaced}
                        saving={objectSaving}
                        note={objectNote}
                    />
                )}

                {surface === 'areas' && (
                    <ActionBar
                        title="Campus areas"
                        hint={campusAreas.length
                            ? 'Tap an outline to edit it, reshape it or show only that campus.'
                            : 'No campus areas yet. Draw one to group buildings and nodes into Campus A, Campus B and so on.'}
                    >
                        <button className="ui-btn ui-btn-secondary" onClick={() => startArea()}>New area</button>
                        <button className="ui-btn ui-btn-primary" onClick={endManageAreas}>Done</button>
                    </ActionBar>
                )}

                {surface === 'area' && areaEdit && (
                    <CampusAreaEditor
                        key={areaEdit.key}
                        map={mapInstance.current}
                        record={areaEdit.record}
                        areas={campusAreas}
                        startStep={areaEdit.startStep}
                        onError={onError}
                        onClose={endArea}
                        onSaved={(message) => { endArea(); loadData(); showToast(message); }}
                    />
                )}

                {surface === 'swap-pick' && swapPick && (
                    <ActionBar
                        title="Swap offices"
                        hint={`Tap the office that trades places with ${nodes.find((n) => n.id === swapPick.sourceId)?.name || 'this one'}.`}
                    >
                        <button className="ui-btn ui-btn-primary" onClick={() => setSwapPick(null)}>Cancel</button>
                    </ActionBar>
                )}

                {studioId != null && buildings.some((b) => b.id === studioId) && (
                    <div style={{ position: 'fixed', inset: 0, zIndex: 4000, background: C.page }}>
                        <BuildingStudio
                            building={buildings.find((b) => b.id === studioId)}
                            buildings={buildings} pathways={pathways} bridges={bridges} objects={campusObjects}
                            nodes={nodes} links={links} canManageDoors={!isAdmin}
                            onClose={() => setStudioId(null)}
                            onSave={async (appearance, nextDoors) => {
                                const b = buildings.find((x) => x.id === studioId);
                                try {
                                    const payload = { appearance };
                                    if (!isAdmin && Array.isArray(nextDoors)) {
                                        payload.doors = nextDoors;
                                    }
                                    await api.updateBuilding(studioId, payload);
                                    setStudioId(null);
                                    await loadData();
                                    showToast(`${b?.short_name || b?.name || 'The building'} has its new look`);
                                } catch (err) { onError(err.message); }
                            }}
                        />
                    </div>
                )}

                {surface === 'manage' && manageBuilding && (
                    <ManageNodes
                        building={manageBuilding}
                        nodes={nodes}
                        links={links}
                        floor={Math.min(manageFloor, Math.max(1, manageBuilding.floors || 1) - 1)}
                        setFloor={setManageFloor}
                        canEditNode={canEditNode}
                        // Admins add outdoor nodes; rooms come from the department staff.
                        canAdd={!isAdmin && canEditBuilding(manageBuilding)}
                        onAdd={(floor) => addNodeInBuilding(manageBuilding, floor)}
                        onEdit={(n) => window.__editNode?.(n.id)}
                        onRemove={(n) => window.__deleteNode?.(n.id)}
                        onEditStair={(link, here) => window.__editNode?.(here.id)}
                        onRemoveStair={async (link) => {
                            if (await confirmAction({ title: 'Remove this staircase?', message: 'The two nodes stay; routes can no longer change floors here.', confirmLabel: 'Remove staircase', tone: 'danger' })) removeStairLink(link);
                        }}
                        // Pan to the node where it is drawn (on its floor plate).
                        onAddStair={() => { mapInstance.current?.closePopup(); setStairStart({ buildingId: manageBuilding.id }); }}
                        onShow={(n) => {
                            const at = markersRef.current[n.id]?.getLatLng();
                            if (at) revealPoint(at.lat, at.lng);
                        }}
                        onClose={() => setManageBuildingId(null)}
                        onPrintQr={(list, floor) => setQrSheet({
                            title: 'QR codes',
                            subtitle: `${manageBuilding.short_name || manageBuilding.name} · ${floorAria(floor)}`,
                            nodes: list,
                        })}
                    />
                )}

                {surface === 'manage' && manageBridge && !manageBuilding && (
                    <ManageNodes
                        building={manageBridge}
                        belongs={onDeckOf(manageBridge)}
                        floors={bridgeFloors(manageBridge)}
                        floor={bridgeFloors(manageBridge).includes(manageFloor) ? manageFloor : Number(manageBridge.deck_floor) || 0}
                        setFloor={setManageFloor}
                        nodes={nodes}
                        links={links}
                        canEditNode={canEditNode}
                        canAdd={isAdmin}
                        onAdd={() => addNodeOnBridge(manageBridge)}
                        onEdit={(n) => window.__editNode?.(n.id)}
                        onRemove={(n) => window.__deleteNode?.(n.id)}
                        onEditStair={(link, here) => window.__editNode?.(here.id)}
                        onRemoveStair={async (link) => {
                            if (await confirmAction({ title: 'Remove this staircase?', message: 'The two nodes stay; routes can no longer change floors here.', confirmLabel: 'Remove staircase', tone: 'danger' })) removeStairLink(link);
                        }}
                        // A raised deck reaches the ground routes by stairs: the Connect to ground flow.
                        onAddStair={Number(manageBridge.deck_floor) > 0 ? () => startBridgeConnect(manageBridge) : null}
                        addStairLabel="Connect to ground"
                        onShow={(n) => {
                            const at = markersRef.current[n.id]?.getLatLng();
                            if (at) revealPoint(at.lat, at.lng);
                        }}
                        onClose={() => setManageBridgeId(null)}
                        note={Number(manageBridge.deck_floor) > 0
                            ? `The nodes on the deck (${deckLevelLabel(manageBridge.deck_floor).toLowerCase()}). Connect to ground joins a deck node to a ground route node with stairs.`
                            : 'The nodes on the deck, at ground level: they join the paths around it directly.'}
                    />
                )}

                {qrSheet && (
                    <QrSheet
                        title={qrSheet.title} subtitle={qrSheet.subtitle} nodes={qrSheet.nodes}
                        buildingsById={buildingsById} onClose={() => setQrSheet(null)}
                    />
                )}

                {surface === 'path-connect' && (
                    <ActionBar
                        title={(() => {
                            const pw = pathways.find((x) => x.id === pathConnect.pathwayId);
                            return pw ? `Point ${pathConnect.idx + 1} of ${pw.coordinates?.length || 0} · ${pw.name || kindLabel(pw.kind)}` : 'Pathway point';
                        })()}
                        hint="Tap the map to add a point joined to the green one (keep tapping to go on). Tap another point to select it instead, or a point on another walkway to join the two."
                    >
                        <button onClick={async () => {
                            const pw = pathways.find((x) => x.id === pathConnect.pathwayId);
                            if (!pw) return;
                            if (pw.coordinates.length <= 2) { onError('A pathway needs at least two points. Remove the pathway instead.'); return; }
                            try {
                                await api.updatePathway(pw.id, { coordinates: pw.coordinates.filter((_, i) => i !== pathConnect.idx) });
                                setPathConnect(null);
                                loadData();
                                showToast('Point removed');
                            } catch (err) { onError(err.message); }
                        }} className="ui-btn ui-btn-danger">Remove point</button>
                        <button className="ui-btn" onClick={() => {
                            const pw = pathways.find((x) => x.id === pathConnect.pathwayId);
                            setPathConnect(null);
                            if (pw) startCampus('pathway', pw);
                        }}>Edit pathway</button>
                        <button className="ui-btn ui-btn-primary" onClick={() => setPathConnect(null)}>Done</button>
                    </ActionBar>
                )}

                {surface === 'bridge-connect' && (() => {
                    const br = bridges.find((x) => x.id === bridgeConnect.bridgeId);
                    const onDeck = br ? nodes.filter((n) => n.type === 'route' && onDeckOf(br)(n)).length : 0;
                    return (
                        <ActionBar
                            title={`Connect ${br?.short_name || br?.name || 'the bridge'} to the ground`}
                            hint={onDeck === 0
                                ? 'This deck has no route nodes yet. Edit the bridge and press Lay route nodes first.'
                                : 'Tap the highlighted deck node at the end where the stairs are. Next, tap the ground route node the stairs come down to, then set their shape and slope.'}
                        >
                            <button className="ui-btn ui-btn-primary" onClick={() => setBridgeConnect(null)}>Cancel</button>
                        </ActionBar>
                    );
                })()}

                {surface === 'stair-start' && manageBuilding && (
                    <ActionBar title="Add staircase" hint={`Tap the node at one end of the stairs on ${floorAria(guideFloor ?? 0).toLowerCase()}.`}>
                        {Math.max(1, manageBuilding.floors || 1) > 1 && (
                            <div className="mt-stair-floors" role="group" aria-label="Floor">
                                {Array.from({ length: Math.max(1, manageBuilding.floors || 1) }, (_, f) => (
                                    <button
                                        key={f} type="button"
                                        className={`ui-btn ${manageFloor === f ? 'ui-btn-primary' : 'ui-btn-secondary'}`}
                                        aria-pressed={manageFloor === f} aria-label={floorAria(f)}
                                        onClick={() => setManageFloor(f)}
                                    >{floorTag(f)}</button>
                                ))}
                            </div>
                        )}
                        <button className="ui-btn ui-btn-secondary" onClick={() => setStairStart(null)}>Cancel</button>
                    </ActionBar>
                )}

                {surface === 'add-place' && (
                    <ActionBar title="Add node" hint={isAdmin ? 'Tap the map to place it, or use your GPS fix.' : staffPlaceHint}>
                        <button className="ui-btn ui-btn-secondary" onClick={handleUseMyLocationForNode}>Use my location</button>
                        <button className="ui-btn ui-btn-primary" onClick={enterNavigateMode}>Done</button>
                    </ActionBar>
                )}

                {surface === 'pin' && (
                    <ActionBar title="Place my pin" hint="Tap the map where you are standing.">
                        <button className="ui-btn ui-btn-secondary" onClick={() => { setIsSettingUserLoc(false); handleMyLocation(); }}>Use GPS</button>
                        <button className="ui-btn ui-btn-primary" onClick={() => setIsSettingUserLoc(false)}>Cancel</button>
                    </ActionBar>
                )}

                {surface === 'stair-pick' && stairPick && (() => {
                    const src = nodes.find((n) => n.id === stairPick.sourceId);
                    const floorsAvailable = [...new Set(nodes
                        .filter((n) => src && n.id !== src.id && floorOf(n) !== floorOf(src))
                        .map((n) => floorOf(n)))].sort((a, b) => a - b);
                    return (
                        <ActionBar
                            title="Connect staircase"
                            hint={floorsAvailable.length === 0
                                ? 'No nodes on other floors yet. Add the other end first.'
                                : 'Tap the highlighted node at the other end of the stairs. Its shape and slope come next.'}
                        >
                            {floorsAvailable.length > 1 && (
                                <div className="mt-stair-floors" role="group" aria-label="Show nodes on floor">
                                    <button
                                        type="button" className={`ui-btn ${stairPick.floor === null ? 'ui-btn-primary' : 'ui-btn-secondary'}`}
                                        aria-pressed={stairPick.floor === null}
                                        onClick={() => setStairPick((p) => ({ ...p, floor: null }))}
                                    >All</button>
                                    {floorsAvailable.map((f) => (
                                        <button
                                            key={f} type="button"
                                            className={`ui-btn ${stairPick.floor === f ? 'ui-btn-primary' : 'ui-btn-secondary'}`}
                                            aria-pressed={stairPick.floor === f}
                                            onClick={() => setStairPick((p) => ({ ...p, floor: f }))}
                                        >{floorTag(f)}</button>
                                    ))}
                                </div>
                            )}
                            <button className="ui-btn ui-btn-primary" onClick={() => setStairPick(null)}>Cancel</button>
                        </ActionBar>
                    );
                })()}

                {surface === 'move' && editingNode && (
                    <ActionBar title="Move node" hint="Tap the map to set the new position, or use your GPS fix.">
                        <button className="ui-btn ui-btn-secondary" onClick={handleMoveNodeToMyLocation} disabled={moveGpsBusy}>
                            {moveGpsBusy ? 'Locating…' : 'Use my location'}
                        </button>
                        <button className="ui-btn ui-btn-primary" onClick={() => setIsSettingPosition(false)}>Cancel move</button>
                    </ActionBar>
                )}

                {surface === 'walls' && (
                    <div className="mt-card mt-enter" role="group" aria-label="Wall drawing">
                        <div className="mt-bar">
                            <div className="mt-bar-head">
                                <div style={{ minWidth: 0 }}>
                                    <div className="mt-bar-title">
                                        {editingWallId !== null ? `Editing wall ${editingWallId}` : 'New wall'}
                                        {draftClosed ? ' (box)' : ''} · draft · {plural(drawingBorderPoints.length, 'wall node', 'wall nodes')}
                                    </div>
                                    <div className="mt-bar-hint" role="status">
                                        {drawingBorderPoints.length === 0
                                            ? 'Tap the map to start a new wall, or tap an existing wall to edit or remove it.'
                                            : drawingBorderPoints.length === 1
                                                ? 'Tap to add the next node. It connects to the one before it.'
                                                : draftClosed
                                                    ? 'Box closed. Save to keep it, or Cancel to discard.'
                                                    : 'Keep tapping to extend. Drag a node onto another wall node to connect them.'}
                                    </div>
                                </div>
                            </div>
                            <div className="mt-bar-actions">
                                <button className="ui-btn ui-btn-secondary" onClick={undoWallPoint} disabled={drawingBorderPoints.length === 0}>Undo</button>
                                <button className="ui-btn ui-btn-primary" onClick={toggleWallDrawing} disabled={drawingBorderPoints.length < 2}>Save</button>
                                <button className="ui-btn ui-btn-secondary" onClick={requestDiscardWall}>
                                    {confirmDiscard ? 'Discard?' : 'Cancel'}
                                </button>
                                {editingWallId !== null && (
                                    <button
                                        className="ui-btn ui-btn-danger"
                                        onClick={async () => { if (await window.__deleteBorderGroup?.(editingWallId)) cancelWallEdit(); }}
                                    >
                                        Remove wall
                                    </button>
                                )}
                            </div>
                        </div>
                    </div>
                )}

                {surface === 'add-form' && pendingNode && (
                    <Sheet
                        title="New node"
                        subtitle={`${pendingNode.latitude.toFixed(6)}, ${pendingNode.longitude.toFixed(6)}`}
                        footer={(
                            <div className="mt-sheet-foot">
                                <button className="ui-btn ui-btn-primary" onClick={handleCreateNode} disabled={pinUnmoved}>Add node</button>
                                <button className="ui-btn ui-btn-secondary" onClick={() => setPendingNode(null)}>Back</button>
                            </div>
                        )}
                    >
                        <NodeForm
                            id="add"
                            type={formType} setType={setFormType}
                            name={formName} setName={setFormName}
                            elevation={formElevation} setElevation={setFormElevation}
                            floor={formFloor} setFloor={setFormFloor}
                            pathType={formPathType} setPathType={setFormPathType}
                            campus={formCampus} setCampus={setFormCampus}
                            buildings={ownBuildings} buildingId={formBuilding} setBuildingId={isAdmin ? undefined : setFormBuilding} allowOutdoors={isAdmin}
                            departments={isAdmin ? departments : null} departmentId={formDept} setDepartmentId={setFormDept}
                        />
                        <p className="ui-hint" style={{ margin: '10px 0 0', color: pinUnmoved ? TEXT : undefined }} role="status">
                            {pinUnmoved
                                ? 'Added. Tap the map or drag the pin to place the next one; the details stay filled in.'
                                : 'Tap the map or drag the pin to adjust the spot.'}
                        </p>
                        <button className="ui-btn ui-btn-secondary ui-btn-sm" style={{ marginTop: 8 }} onClick={handleUseMyLocationForNode}>Use my location</button>
                        {!isAdmin && (
                            <p className="ui-hint" style={{ margin: '10px 0 0', color: TEXT }}>
                                {currentUser?.department
                                    ? <>Placed under <strong>{currentUser.department.name}</strong> as <strong>{currentUser.name}</strong>.</>
                                    : 'No department assigned. Ask an admin before placing nodes.'}
                            </p>
                        )}
                    </Sheet>
                )}

                {surface === 'edit-form' && editingNode && (
                    <Sheet
                        title="Edit node"
                        subtitle={`${editingNode.latitude.toFixed(6)}, ${editingNode.longitude.toFixed(6)}`}
                        onClose={() => setEditingNode(null)}
                        footer={(
                            <>
                                <div style={{ flex: 'none' }}>
                                    <Collapse open={confirmDelete}>
                                        <div className="mt-confirm">
                                            <div className="ui-hint" style={{ color: C.danger, margin: 0 }}>This node and its connections are deleted. It cannot be undone.</div>
                                            <div className="row">
                                                <button
                                                    className="ui-btn ui-btn-destroy"
                                                    onClick={() => {
                                                        api.deleteNode(editingNode.id).then(() => {
                                                            setEditingNode(null);
                                                            loadData();
                                                            showToast('Node removed');
                                                        }).catch(err => onError(err.message));
                                                    }}
                                                >
                                                    Remove for good
                                                </button>
                                                <button className="ui-btn ui-btn-secondary" onClick={() => setConfirmDelete(false)}>Keep</button>
                                            </div>
                                        </div>
                                    </Collapse>
                                </div>
                                <div className="mt-sheet-foot">
                                    <button className="ui-btn ui-btn-primary" onClick={handleUpdateNode}>Save</button>
                                    {!isOfficeStaff && (
                                        <>
                                            <button className="ui-btn ui-btn-secondary" onClick={toggleNodeMove}>Move</button>
                                            <button className="ui-btn ui-btn-danger" aria-expanded={confirmDelete} onClick={() => setConfirmDelete(!confirmDelete)}>Remove</button>
                                        </>
                                    )}
                                </div>
                            </>
                        )}
                    >
                        {isOfficeStaff ? (
                            <p className="ui-hint" style={{ margin: 0, color: TEXT }}>
                                <strong>{editingNode.name}</strong>: you run this office. Set its hours and close it when you need to; the building head manages everything else.
                            </p>
                        ) : (
                        <NodeForm
                            id="edit"
                            type={editType} setType={setEditType}
                            name={editName} setName={setEditName}
                            elevation={editElevation} setElevation={setEditElevation}
                            floor={editFloor} setFloor={setEditFloor}
                            pathType={editPathType} setPathType={setEditPathType}
                            campus={editCampus} setCampus={setEditCampus}
                            buildings={ownBuildings} buildingId={editBuilding} setBuildingId={setEditBuilding} allowOutdoors={isAdmin}
                            departments={isAdmin ? departments : null} departmentId={editDept} setDepartmentId={setEditDept}
                        />
                        )}
                        {editType === 'location' && (() => {
                            const building = editBuilding !== '' ? buildings.find((b) => String(b.id) === String(editBuilding)) : null;
                            const buildingName = building ? (building.short_name || building.name) : 'the building';
                            const inherited = building?.opening_hours ? summarizeHours(building.opening_hours) : null;
                            const ownerDept = editingNode.department_id ?? building?.department?.id ?? building?.department_id;
                            const staff = users.filter((u) => u.role === 'faculty' && u.department?.id === ownerDept && u.id !== myId);
                            const runner = editManager !== '' ? (users.find((u) => String(u.id) === editManager)?.name || 'its office staff') : null;
                            const locked = hoursLockedFor(editManager);
                            return (
                                <>
                                    {/* 1. Who runs it: the building head's choice. */}
                                    {!isAdmin && !isOfficeStaff && (
                                        <section className="mt-stairs" aria-labelledby="edit-manager-title">
                                            <h3 className="mt-stairs-title" id="edit-manager-title">Who runs this office</h3>
                                            <select id="edit-manager" className="ui-select" value={editManager} onChange={(e) => setEditManager(e.target.value)} aria-labelledby="edit-manager-title" aria-describedby="edit-manager-hint">
                                                <option value="">You (the building head)</option>
                                                {staff.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                                            </select>
                                            <span className="ui-hint" id="edit-manager-hint" style={{ display: 'block', marginTop: 6 }}>
                                                {staff.length
                                                    ? 'The office staff you pick set this office\'s hours and closures; you keep the building, its rooms and doors.'
                                                    : 'No office staff in your department yet. An admin adds their accounts.'}
                                            </span>
                                        </section>
                                    )}
                                    {/* 2. Its hours: whoever runs it. */}
                                    <section className="mt-stairs" aria-labelledby="edit-hours-title">
                                        <h3 className="mt-stairs-title" id="edit-hours-title">Opening hours</h3>
                                        {locked ? (
                                            <p className="ui-hint" style={{ margin: 0 }}>
                                                {editingNode.opening_hours ? summarizeHours(editingNode.opening_hours) : `Follows ${buildingName}${inherited ? ` (${inherited})` : ''}`}.
                                                {' '}Set by <strong>{runner}</strong>, who runs this office.
                                            </p>
                                        ) : (
                                            <HoursEditor
                                                value={editHours} onChange={setEditHours} idPrefix="edit-hours"
                                                offHint={inherited
                                                    ? `Leave off to follow ${buildingName} (${inherited}). Turn on for its own hours, like a cashier with a lunch break.`
                                                    : 'Leave off if it is always open.'}
                                            />
                                        )}
                                    </section>
                                    {/* 3. Close it now: whoever runs it (as the building's Close now, for this office alone). */}
                                    {!isAdmin && !locked && (() => {
                                        const closedNow = officeClosedNow(editingNode);
                                        const name = editingNode.name || 'This office';
                                        return (
                                            <section className="mt-stairs" aria-labelledby="edit-close-title">
                                                <h3 className="mt-stairs-title" id="edit-close-title">Close now</h3>
                                                {closedNow ? (
                                                    <>
                                                        <p className="ui-hint" style={{ margin: '0 0 10px' }} role="status">
                                                            <strong>Closed now</strong>{closedNow.reason && closedNow.reason !== 'Closed now' ? `: ${closedNow.reason}` : ''}.
                                                            {' '}Students see it closed until you reopen it.
                                                        </p>
                                                        <button type="button" className="ui-btn ui-btn-primary ui-btn-block" onClick={() => reopen(closedNow, name)}>
                                                            Reopen (follow the opening hours again)
                                                        </button>
                                                    </>
                                                ) : (
                                                    <>
                                                        <label className="ui-label" htmlFor="edit-close-reason">Reason students see (optional)</label>
                                                        <input
                                                            id="edit-close-reason" className="ui-input" value={officeCloseReason} maxLength={160}
                                                            onChange={(e) => setOfficeCloseReason(e.target.value)} placeholder="e.g. Closed for a meeting"
                                                        />
                                                        <button type="button" className="ui-btn ui-btn-danger ui-btn-block" style={{ marginTop: 10 }} onClick={() => closeNow({ node_id: editingNode.id }, name, officeCloseReason)}>
                                                            Close this office now
                                                        </button>
                                                        <p className="ui-hint" style={{ margin: '8px 0 0' }}>
                                                            Closes it right away, whatever its hours say, until you reopen it. The hours stay as they are. To plan a closure for later dates, use Announcements.
                                                        </p>
                                                    </>
                                                )}
                                            </section>
                                        );
                                    })()}
                                    {/* 4. Visitors: the building head's choice. */}
                                    {!isOfficeStaff && (
                                        <section className="mt-stairs" aria-labelledby="edit-visitors-title">
                                            <h3 className="mt-stairs-title" id="edit-visitors-title">Visitors</h3>
                                            <label className="hours-toggle" style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer' }}>
                                                <input
                                                    type="checkbox" checked={editPublic} onChange={(e) => setEditPublic(e.target.checked)}
                                                    style={{ flex: 'none', width: 18, height: 18, margin: '2px 0 0' }}
                                                />
                                                <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                                                    <span style={{ fontWeight: 600, color: '#fff' }}>Show to visitors</span>
                                                    <span className="ui-hint" style={{ margin: 0 }}>
                                                        An important place, like the Dean's office: visitors can find it and get a route to it. Other rooms stay hidden from them.
                                                    </span>
                                                </span>
                                            </label>
                                        </section>
                                    )}
                                </>
                            );
                        })()}
                        {!isAdmin && !isOfficeStaff && editingNode.type === 'location' && (
                            <section className="mt-stairs" aria-label="Swap offices">
                                <h3 className="mt-stairs-title">Office moved?</h3>
                                <p className="ui-hint" style={{ margin: '0 0 10px' }}>
                                    Swap this office with another location: both spots stay where they are; their names and departments trade places.
                                </p>
                                <button type="button" className="ui-btn ui-btn-secondary ui-btn-block" onClick={startSwapPick}>Swap with another office</button>
                            </section>
                        )}
                        {!isOfficeStaff && (
                        <StairLinks
                            node={editingNode}
                            nodes={nodes}
                            links={links}
                            floorLabel={(n) => `Floor ${floorTag(floorOf(n))}`}
                            onPick={startStairPick}
                            onUpdate={updateStairLink}
                            onRemove={removeStairLink}
                        />
                        )}
                    </Sheet>
                )}
            </div>

            {stairConfig && (() => {
                const from = nodes.find((n) => n.id === stairConfig.sourceId);
                const to = nodes.find((n) => n.id === stairConfig.otherId);
                if (!from || !to) return null;
                const label = (n) => `Floor ${floorTag(floorOf(n))}, ${n.name || (n.type === 'location' ? 'Location' : 'Route node')}`;
                return (
                    <NewStairModal
                        from={from} to={to} label={label}
                        onBack={() => setStairConfig(null)}
                        onSave={async (draft) => {
                            if (await createStairLink(from.id, to.id, draft)) setStairConfig(null);
                        }}
                    />
                );
            })()}

            {/* Departments & faculty live in the Departments tab (AdminDepartments) */}
            </>)}

            {/* Confirmation toast: top-centre so it never covers the map
                point the admin just worked on. */}
            {successToast && (
                <div
                    className={`admin-toast${successToast.tone === 'error' ? ' is-error' : ''}`}
                    role={successToast.tone === 'error' ? 'alert' : 'status'} key={successToast.key}
                    style={{
                        position: 'absolute', top: '64px', left: '50%', zIndex: 2000,
                        display: 'flex', alignItems: 'center', gap: 10,
                        background: successToast.tone === 'error' ? 'rgba(30, 10, 14, 0.94)' : 'rgba(12, 12, 16, 0.92)',
                        color: successToast.tone === 'error' ? '#ffe4e7' : TEXT,
                        padding: successToast.tone === 'error' ? '6px 6px 6px 12px' : '10px 18px', borderRadius: PILL,
                        border: `1px solid ${successToast.tone === 'error' ? 'rgba(255, 85, 102, 0.5)' : C.hairline}`, boxShadow: ELEVATION.float,
                        WebkitBackdropFilter: 'blur(14px)', backdropFilter: 'blur(14px)',
                        fontSize: TYPE.sub, fontWeight: 600, whiteSpace: successToast.tone === 'error' ? 'normal' : 'nowrap',
                        maxWidth: 'min(560px, calc(100% - 32px))',
                        animation: successToast.tone === 'error' ? 'toastEnter 0.2s var(--ease-out) forwards' : 'toastIn 2.5s var(--ease-out) forwards',
                        pointerEvents: successToast.tone === 'error' ? 'auto' : 'none',
                    }}
                >
                    {successToast.tone === 'error' ? <span className="admin-toast-icon" aria-hidden="true">!</span> : (
                        <svg className="admin-toast-ok" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                            <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                    )}
                    <span>{successToast.text}</span>
                    {successToast.tone === 'error' && (
                        <button type="button" className="admin-toast-x" aria-label="Dismiss" onClick={() => { clearTimeout(toastTimerRef.current); setSuccessToast(null); }}>&times;</button>
                    )}
                </div>
            )}
        </div>
    );
}
