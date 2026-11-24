import React, { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import { loadMap } from '../mobileApi';
import { describeAge } from '../offlineData';
import { computeRoute, pathwayWaypoints } from '../pathfinding';
import { buildingDestination, parseBuildingDestination, routableBuildings, routeToBuilding } from '../buildingDestinations';
import { nodeArea, buildingArea } from '../campusAreas';
import { qrNodeIdFrom, QR_PARAM } from '../qrPosition';
import { shadeMap, shadePenaltyFor } from '../shadeRouting';
import { useWeather } from '../useWeather';
import WeatherPill from './WeatherPill';
import { SyncPill } from './SyncPill';
import AppMenu from './AppMenu';
import { useInstallPrompt } from '../pwa';
import { useAutoSync } from '../useAutoSync';
import { sessionHeaders, logVisit } from '../studentSession';
import StairHint from './StairHint';
import StairModal from './StairModal';
import { nodeRainStatus, nodeRainLabel, rainMultiplierOf, heatModeActive, NODE_STATUS } from '../weatherCost';
import { createDestinationPinIcon } from '../mapIcons';
import { createTileLayer, campusLatLngBounds, lockToCampus, CAMPUS_CENTER, CAMPUS_MIN_ZOOM, CAMPUS_MAX_ZOOM, CAMPUS_MAP_LOCK, GPS_HIDDEN_LAYERS, GPS_FLAVOR, ROUTE_CASING } from '../campusMap';
// Same heading maths and compass convention (0° = north) the 3D view uses,
// so the 2D POV wedge and the AR camera can never point apart.
import { headingFromOrientationEvent, headingAccuracyFromEvent, createCompassWatcher, compassLabel } from '../heading';
import { SmoothPoint, SmoothAngle, createPovIcon, paintPovRotation } from '../povMotion';
import { collectFloors, floorAria, floorOf, floorTag } from '../floors';
import { drawBuildings, drawBridges, drawPathways, drawShadows, bindLabelZoom, prepareCampusPanes, drawRouteFloors, floorLiftDeg, drawStairs25D, stairRouteLine, drawSkyTint, drawWalls25D } from '../campusLayers';
import { sunPosition, roofLiftM } from '../sunShadow';
import { closedBuildingIds, summarizeHours, buildingStatus, placeStatusOf, announcements, closedMessage, campusClosed, formatTime } from '../openingHours';
import { nodePlaceLabel, floorCountLabel, buildingAt, buildingFloors, pointInPolygon, bridgeDeckHeightM } from '../campusGeometry';
import { LIST_CSS, bindScrollCue } from './ScrollWindow';
import SatelliteControl, { SATELLITE_CSS } from './SatelliteControl';
import { useSatelliteSettings, useSatelliteLayer } from '../useSatellite';
import GpsPipeline from '../gpsPipeline';
import { stallAction, GPS_WATCH_OPTS, GPS_POLL_OPTS } from '../gpsWatchdog';
// Single source of the design language for BOTH screens (2D here, 3D in ARView).
// The values below are the same ones this screen has always used; they just
// live in one place now.
import { C, TYPE, INPUT_TEXT, TAP, btnBase, HUD_CSS, PANEL_RADIUS, MAP_ZOOM_CSS, INTERACTION_CSS, PILL, ELEVATION } from '../uiTokens';
import { formatDistance, formatWalkTime } from '../routeFormat';

// Demo controls for presentations (the campus-hours switch in the menu), as for the demo accounts on the
// sign-in page: in development, and in a build made with VITE_DEMO_ACCOUNTS=true; never in a real
// deployment, where students cannot turn the closing off. (Plain import.meta.env: replaced at build time.)
const SHOW_DEMO = import.meta.env.DEV || import.meta.env.VITE_DEMO_ACCOUNTS === 'true';
const CAMPUS_DEMO_KEY = 'arnode.campusDemo';

// The 3D views bring three.js (about 600 kB), so they load only when opened. The service
// worker still saves them at install (vite.config.js follows dynamic imports), so they work offline.
const ARView = React.lazy(() => import('./ARView'));
const RouteModel3D = React.lazy(() => import('./RouteModel3D').then((m) => ({
    default: (props) => <><style>{m.ROUTE_MODEL_CSS}</style><m.default {...props} /></>,
})));
const LOADING_3D = { display: 'grid', placeItems: 'center', color: C.muted, font: '500 15px/1.4 system-ui, sans-serif' };

// The "you are here" dot. White core (the palette reserves green for the
// destination, so user and goal can never be confused) wearing a thin white
// halo that ties it to the rest of the HUD.
const USER_ICON = L.divIcon({
    className: '',
    html: `<div style="width:18px;height:18px;border-radius:50%;background:${C.ice};border:3px solid ${C.ice};box-shadow:0 0 0 2px ${ROUTE_CASING},0 0 0 6px rgba(22,22,27,0.18),0 2px 10px rgba(0,0,0,0.45);"></div>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
});

// Does this browser hide the orientation API behind a permission prompt
// (iOS Safari, some Android builds)? If so, the 2D view must ask from inside
// a real tap — a prompt raised outside a gesture is rejected outright.
const HAS_COMPASS_PROMPT = typeof DeviceOrientationEvent !== 'undefined'
    && typeof DeviceOrientationEvent.requestPermission === 'function';

// POV wedge: a ~70° field-of-view cone laid over the you-are-here dot, drawn pointing
// north and then rotated by CSS to the live heading (the map itself never
// rotates — north stays up). The rotation lives on the inner element because
// Leaflet positions the outer one with translate3d; transforming the outer
// node would fight Leaflet's own transform. Centre-anchored at (48,48) so the
// wedge pivots exactly on the user's position, and pointer-events are off so
// it can never swallow a map gesture. Wedge geometry: centre (48,48), r 38,
// ±35° either side of north → M48 48 → L26.2 16.87 → arc → 69.8 16.87 → Z.
const POV_ICON = createPovIcon();



// Scene-change copy. The overlay names where the person is going, then walks
// through what is actually being prepared, so the wait reads as progress.
const SCENE_COPY = {
    enter: { title: 'Loading into AR View', steps: ['Locating you', 'Laying out your route', 'Opening the 3D view'] },
    exit: { title: 'Back to the 2D map', steps: ['Closing the camera'] },
};

// Full-screen hand-off between the 2D map and the 3D view. Solid page colour,
// one line of route art (the same motif the sign-in page draws), a title and
// a status line. No gradients, no glow.
function SceneOverlay({ scene, step }) {
    const copy = SCENE_COPY[scene.kind];
    return (
        <div className="scene" data-show={scene.show ? 'true' : 'false'} role="status" aria-live="polite">
            <div className="scene-box">
                <svg className="scene-art" viewBox="0 0 168 112" aria-hidden="true">
                    <path className="scene-path" pathLength="1" fill="none" stroke={C.route} strokeWidth="3" strokeLinecap="round"
                        d="M12 100 C 12 72, 72 84, 72 58 S 128 34, 156 12" />
                    <circle cx="12" cy="100" r="5" fill={C.white} />
                    <circle className="scene-ring" cx="156" cy="12" r="9" fill="none" stroke={C.accent} strokeWidth="2" />
                    <circle className="scene-dest" cx="156" cy="12" r="6" fill={C.white} />
                </svg>
                <div className="scene-title">{copy.title}</div>
                <div className="scene-step" key={step}>{copy.steps[Math.min(step, copy.steps.length - 1)]}</div>
                <div className="scene-rail"><i /></div>
            </div>
        </div>
    );
}

// Catches ARView render/mount crashes that would otherwise blank the
// whole page (React unmounts the tree on an uncaught render error).
// Shows the actual exception + a way back to the 2D map.
class ARViewErrorBoundary extends React.Component {
    constructor(props) {
        super(props);
        this.state = { error: null };
    }

    static getDerivedStateFromError(error) {
        return { error };
    }

    render() {
        if (this.state.error) {
            return (
                <div style={{ position: 'absolute', inset: 0, zIndex: 9999, background: C.dangerBg, color: C.white, padding: '24px', overflowY: 'auto' }}>
                    <div style={{ fontWeight: 800, marginBottom: '8px' }}>3D view crashed</div>
                    <div style={{ fontSize: '12px', wordBreak: 'break-all', marginBottom: '12px', opacity: 0.9 }}>
                        {String(this.state.error?.message || this.state.error)}
                    </div>
                    <button
                        onClick={() => {
                            this.setState({ error: null });
                            this.props.onExit();
                        }}
                        className="mbtn"
                        style={{ padding: '10px 14px', borderRadius: PILL, border: 'none', background: C.white, color: C.dangerBg, fontSize: TYPE.sub, fontWeight: 700 }}
                    >
                        Back to 2D map
                    </button>
                </div>
            );
        }

        return this.props.children;
    }
}

const escapeHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
));

export default function MobileNav({ session = { role: 'visitor' }, onSignOut, onSignIn }) {
    // Visitors (guests) see building locations only. The server enforces it
    // (no token = buildings-only map feed); the screen just shows less.
    const isVisitor = session?.role !== 'student';
    // Install app (PWA): offered to students and visitors alike while the browser allows it.
    const installOffer = useInstallPrompt();
    const showInstall = installOffer.canInstall || installOffer.iosHint;
    const authHeaders = useMemo(() => sessionHeaders(session), [session]);
    // Activity log: a visitor's map visit (students are logged when they sign in).
    useEffect(() => { if (isVisitor) logVisit('map.opened'); }, [isVisitor]);
    const mapRef = useRef(null);
    const mapInstance = useRef(null);
    const markersRef = useRef({});
    const userMarkerRef = useRef(null);
    const accuracyRef = useRef(null);
    const routeLayerRef = useRef(null);
    const buildingLayerRef = useRef(null);
    const wallLayerRef = useRef(null);
    const wallFrontLayerRef = useRef(null);
    // Buildings the route goes into, cut away at the floor being shown.
    const cutawayLayerRef = useRef(null);
    const pathwayLayerRef = useRef(null);
    const bridgeLayerRef = useRef(null);
    const areaLayerRef = useRef(null);
    const shadowLayerRef = useRef(null);
    // Live sun clock: ticks every minute and when the phone is unlocked again.
    // (The shadow time slider for checking shadows lives in the admin View menu.)
    const [sunClock, setSunClock] = useState(() => new Date());
    useEffect(() => {
        const tick = () => setSunClock(new Date());
        const timer = setInterval(tick, 60000);
        const onVisible = () => { if (document.visibilityState === 'visible') tick(); };
        document.addEventListener('visibilitychange', onVisible);
        return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
    }, []);
    const sunDate = sunClock;
    // Walls are re-shaded only when the sun has moved ~5 degrees (about every
    // 20 minutes live): rebuilding the buildings closes an open popup.
    const sunForWalls = useMemo(() => {
        const s = sunPosition(sunDate, CAMPUS_CENTER[0], CAMPUS_CENTER[1]);
        return { altitudeDeg: Math.round(s.altitudeDeg / 5) * 5, azimuthDeg: Math.round(s.azimuthDeg / 5) * 5 };
    }, [sunDate]);
    const sunWallsKey = `${sunForWalls.altitudeDeg}:${sunForWalls.azimuthDeg}`;
    const watchIdRef = useRef(null);
    const testLocRef = useRef(false);
    const prevDestRef = useRef(null);

    const [nodes, setNodes] = useState([]);
    const [borders, setBorders] = useState([]);
    // Labelled buildings (name + floor count) and the road/walkway network.
    // Display only: routing still runs on nodes.
    const [buildings, setBuildings] = useState([]);
    const [bridges, setBridges] = useState([]);
    // Closures and special openings (announcements), from the map feed: applied on top of opening hours.
    const [closures, setClosures] = useState([]);
    // When the campus is open (from the map feed, config/campus.php): outside it, /map is closed.
    const [campusHours, setCampusHours] = useState(null);
    const closuresRef = useRef([]);
    closuresRef.current = closures;
    // Buildings closed right now (opening hours, campus time): routes do not pass through them. Rechecked
    // with the sun clock (every minute); the key keeps the route from re-running when nothing changed.
    const closedIds = useMemo(() => closedBuildingIds(buildings, sunDate, closures), [buildings, sunDate, closures]);
    // School-level announcements going on now (whole school, a campus, every college or office): a banner.
    const announcementList = useMemo(() => announcements(closures, sunDate), [closures, sunDate]);
    const closedKey = closedIds.join(',');
    // Presentations only (same switch as the demo accounts): follow the clock, or force the campus
    // closed / open. Kept for the tab, so a reload mid-demo keeps it.
    const [campusDemo, setCampusDemoState] = useState(() => {
        if (!SHOW_DEMO) return 'clock';
        try { return sessionStorage.getItem(CAMPUS_DEMO_KEY) || 'clock'; } catch { return 'clock'; }
    });
    const setCampusDemo = (mode) => {
        setCampusDemoState(mode);
        try { sessionStorage.setItem(CAMPUS_DEMO_KEY, mode); } catch { /* private mode: for this view only */ }
    };
    // The whole campus closed (e.g. 9 pm to 6 am): the map gives way to a notice, rechecked every minute.
    const campusClosedNow = useMemo(() => {
        if (campusDemo === 'open') return null;
        if (campusDemo === 'closed') return { opens: formatTime(campusHours?.opens || '06:00'), closes: formatTime(campusHours?.closes || '21:00') };
        return campusClosed(campusHours, sunDate);
    }, [campusHours, sunDate, campusDemo]);
    const NEXT_DEMO = { clock: 'closed', closed: 'open', open: 'clock' };
    const DEMO_LABEL = { clock: 'Demo: campus hours follow the clock', closed: 'Demo: campus shown closed', open: 'Demo: campus kept open' };
    const campusDemoItem = SHOW_DEMO ? { label: DEMO_LABEL[campusDemo], onClick: () => setCampusDemo(NEXT_DEMO[campusDemo]) } : null;
    const [pathways, setPathways] = useState([]);
    // Campus outlines (Campus A, Campus B, ...): the campus picker and the map labels.
    const [campusAreas, setCampusAreas] = useState([]);
    // Campus filter for the destination list: 'all', an area id, or 'none' (outside every area).
    const [campusFilter, setCampusFilter] = useState('all');
    const buildingsById = useMemo(() => new Map(buildings.map((b) => [b.id, b])), [buildings]);
    // Staircase links [{ node_a_id, node_b_id, angle_deg }]: the only way the
    // router changes floors.
    const [links, setLinks] = useState([]);
    // Set when the chosen destination is on a different floor than the one
    // shown: asks "which floor are you on?" before routing there.
    const [floorPrompt, setFloorPrompt] = useState(null);
    // Which floor the student is on. null = follow the data's default (ground
    // when it exists, otherwise the lowest floor). Both the 2D markers and the
    // 3D AR view read `activeFloor`, so one tap updates both instantly.
    const [floor, setFloor] = useState(null);
    const floors = useMemo(() => collectFloors(nodes), [nodes]);
    const activeFloor = floor !== null
        ? floor
        : (floors.includes(0) ? 0 : (floors[0] ?? 0));
    const floorNodes = useMemo(
        () => nodes.filter((node) => floorOf(node) === activeFloor),
        [nodes, activeFloor],
    );
    const [userLocation, setUserLocation] = useState(null);
    // Desktop free-roam (WASD) reports its walked position here. It is a
    // *virtual* fix rather than a GPS one, but it is treated identically
    // downstream: the route is recomputed from it, so Dijkstra re-anchors
    // the path to where the presenter actually is, and the 2D you-are-here dot
    // follows. null whenever free-roam is off, so `effectiveUser` falls
    // straight back to the real fix.
    const [walkedPos, setWalkedPos] = useState(null);
    // The position everything route/position related consumes: walked if the
    // 3D view is driving it, otherwise the GPS fix or the manual test pin.
    const effectiveUser = walkedPos ?? userLocation;
    const [destId, setDestId] = useState('');
    const [destinationOpen, setDestinationOpen] = useState(false);
    const destinationPickerRef = useRef(null);
    const destinationTriggerRef = useRef(null);
    const destinationMenuRef = useRef(null);
    // What the student has typed into the destination search box.
    const [destQuery, setDestQuery] = useState('');
    const [route, setRoute] = useState(null);
    // The floor picker follows where you are. Outside, you are on the ground:
    // no picker (and no "which floor?" question). Inside a building, it shows
    // that building's floors. Outside but looking at another floor (the route
    // panel's "Go to 2"), it shows the route's floors so G is one tap away.
    const userBuilding = useMemo(
        () => (effectiveUser ? buildingAt(routableBuildings(buildings), effectiveUser.latitude, effectiveUser.longitude) : null),
        [effectiveUser, buildings],
    );
    const pickerFloors = useMemo(() => {
        if (userBuilding) return buildingFloors(userBuilding);
        if (activeFloor === 0) return [];
        return [...new Set([0, activeFloor, ...(route?.path || []).filter((p) => p.type !== 'user').map((p) => floorOf(p))])].sort((a, b) => a - b);
    }, [userBuilding, activeFloor, route]);
    // Walking out of a building puts you back on the ground floor.
    const lastBuildingRef = useRef(null);
    useEffect(() => {
        const id = userBuilding?.id ?? null;
        if (lastBuildingRef.current !== null && id === null) setFloor(null);
        lastBuildingRef.current = id;
    }, [userBuilding?.id]);
    // "Route in 3D": the route through its building as an orbitable model.
    const [routeModelOpen, setRouteModelOpen] = useState(false);
    // Buildings the current route goes into (a door or a node filed in them):
    // drawn cut away at the floor being shown (as the admin floor guide), with
    // the route and pins inside standing on that floor.
    const routeBuildingIds = useMemo(
        () => new Set((route?.path || []).map((p) => p.building_id).filter((id) => id !== null && id !== undefined)),
        [route],
    );
    const routeBuildingKey = [...routeBuildingIds].sort().join(',');
    /** Latitude lift of a point inside a cut-away building, onto its floor plate (0 elsewhere). */
    const cutawayLift = (point, ids = routeBuildingIds) => {
        const b = point?.building_id != null && ids.has(point.building_id) ? buildingsById.get(point.building_id) : null;
        if (!b) return 0;
        const top = Math.max(1, Number(b.floors) || 1) - 1;
        return floorLiftDeg(b, Math.min(Math.max(0, floorOf(point)), top));
    };
    useEffect(() => {
        const layer = cutawayLayerRef.current;
        if (!layer) return;
        layer.clearLayers();
        const path = route?.path || [];
        const destination = path[path.length - 1];
        for (const id of routeBuildingIds) {
            const b = buildingsById.get(id);
            if (!b) continue;
            // Only the floors this route uses, cut at the highest one.
            drawRouteFloors(L.layerGroup().addTo(layer), b, {
                floors: path.filter((p) => p.building_id === id).map((p) => floorOf(p)),
                active: activeFloor,
                destinationFloor: destination && destination.building_id === id ? floorOf(destination) : null,
                sun: sunForWalls,
            });
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [routeBuildingKey, activeFloor, buildingsById, route, sunWallsKey]);
    const [error, setError] = useState(null);
    // Each new error is shown in the info pill (top centre), like every
    // other notice on this page. Closing the pill does not forget the error.
    const [errorPill, setErrorPill] = useState(null);
    // Other notices that used to sit as banners above the map now use the
    // same pill: what applies right now, most important first (see SyncPill).
    const [noticePill, setNoticePill] = useState(null);
    useEffect(() => {
        setErrorPill(error ? { text: error, tone: 'error', key: Date.now() } : null);
    }, [error]);
    // Set when the map came from this phone's saved copy because the server was unreachable.
    const [offlineCopy, setOfflineCopy] = useState(null);
    const [showAR, setShowAR] = useState(false);
    const [arRoute, setArRoute] = useState(null);
    const [arPending, setArPending] = useState(false);
    // Scene-change transition into 3D: map glides to the fix, the 2D screen
    // fades + pushes in, then the AR overlay mounts and fades itself in.
    const [leaving, setLeaving] = useState(false);
    // Set the instant 3D view is tapped, so the button answers at once while
    // the map glides. `scene` is the full-screen hand-off overlay.
    const [launching, setLaunching] = useState(false);
    const [scene, setScene] = useState(null);
    const [sceneStep, setSceneStep] = useState(0);
    const mapWrapRef = useRef(null);
    const timersRef = useRef([]);
    const later = (fn, ms) => { timersRef.current.push(window.setTimeout(fn, ms)); };
    useEffect(() => () => timersRef.current.forEach((id) => window.clearTimeout(id)), []);
    // arKey: bumped each time a fresh AR session is launched. Used as React
    // key on ARView so every open is a guaranteed clean remount — no stale
    // worldKey/destKey/heading from the previous session can survive.
    const [arKey, setArKey] = useState(0);
    const [testMode, setTestMode] = useState(false);
    const [loading, setLoading] = useState(true);
    // "Use my location" flow: waiting for the next fresh GPS fix after
    // leaving manual mode (spins until the watch delivers one).
    const [waitingGps, setWaitingGps] = useState(false);
    const relocateRef = useRef(false);
    // Transient GPS health note shown in the footer status line.
    const [gpsNote, setGpsNote] = useState(null);

    // ── Weather ──────────────────────────────────────────────────────────
    // Live campus weather, read from OUR OWN /api/weather (never the
    // provider — the server caches and refreshes upstream on a schedule).
    const [weather, applyWeather] = useWeather();

    // Why no route is drawn, when rain closed every way to the destination.
    const [noRoute, setNoRoute] = useState(null);
    // The destination is closed right now (its hours or an announcement): no route is drawn, only why
    // and when it opens. From the clock, so the route appears the minute the place opens.
    const destClosed = useMemo(() => {
        if (!destId) return null;
        const buildingId = parseBuildingDestination(destId);
        const building = buildingId !== null ? buildingsById.get(buildingId) : null;
        const place = building || nodes.find((n) => String(n.id) === String(destId));
        if (!place) return null;
        const state = building ? buildingStatus(building, closures, sunDate) : placeStatusOf(place, buildingsById, closures, sunDate);
        return closedMessage(place.short_name || place.name, state);
    }, [destId, nodes, buildingsById, sunDate, closures]);
    // Loading, no route and the offline copy, as pill notices (one at a time,
    // most important first). Loading stays up while it lasts.
    useEffect(() => {
        if (loading && !error) {
            setNoticePill({ text: 'Loading the campus map', tone: 'info', persist: true, busy: true, key: 'loading' });
            return;
        }
        if (noRoute) {
            setNoticePill({ text: noRoute, tone: 'attention', key: `noroute:${Date.now()}` });
            return;
        }
        if (offlineCopy) {
            setNoticePill({
                // Short and calm: offline is normal for the installed app, and the map
                // updates by itself once the phone is back online.
                text: `Offline · map saved ${describeAge(offlineCopy.savedAt)}`,
                tone: 'info', key: `offline:${offlineCopy.savedAt}`,
            });
            return;
        }
        setNoticePill(null);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [loading, error, noRoute, offlineCopy?.savedAt]);

    // The destination picker is a custom menu rather than a native <select>
    // so its open/close and option-entry motion stay consistent across mobile
    // browsers. Close on an outside pointer or when keyboard focus leaves it.
    useEffect(() => {
        if (!destinationOpen) return undefined;
        const onPointerDown = (event) => {
            if (!destinationPickerRef.current?.contains(event.target)) {
                setDestinationOpen(false);
            }
        };
        document.addEventListener('pointerdown', onPointerDown);
        return () => document.removeEventListener('pointerdown', onPointerDown);
    }, [destinationOpen]);

    // Opening the list scrolls the current pick into view; closing wipes the
    // search text so the box shows the chosen place again.
    useEffect(() => {
        if (!destinationOpen) {
            setDestQuery('');
            return undefined;
        }
        const id = window.requestAnimationFrame(() => {
            destinationMenuRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
        });
        return () => window.cancelAnimationFrame(id);
    }, [destinationOpen]);

    // Load public map data: the server's static file (or API), else the copy this
    // phone saved with "Download latest data for offline". Bumping loadAttempt
    // (the Try again button) runs it again.
    const [loadAttempt, setLoadAttempt] = useState(0);
    // Only a failed map load offers "Try again" (error also carries GPS and
    // routing problems, which a reload would not fix).
    const [mapLoadFailed, setMapLoadFailed] = useState(false);
    const retryMapLoad = () => { setError(null); setMapLoadFailed(false); setLoadAttempt((n) => n + 1); };
    useEffect(() => {
        let alive = true;
        setLoading(true);
        loadMap(authHeaders)
            .then(({ data, source, savedAt }) => {
                if (!alive) return;
                setNodes(data.nodes || []);
                setBorders(data.borders || []);
                setLinks(data.links || []);
                setBuildings(data.buildings || []);
                setBridges(data.bridges || []);
                setClosures(data.closures || []);
                setCampusHours(data.campus_hours || null);
                setPathways(data.pathways || []);
                setCampusAreas(data.campus_areas || []);
                setOfflineCopy(source === 'offline' ? { savedAt } : null);
                // The map on screen is the baseline; the first automatic save
                // follows a moment later, once the map has painted.
                sync.noteMap(data);
                if (!isVisitor) setTimeout(() => sync.syncNow('first'), 1500);
                setLoading(false);
            })
            .catch((err) => {
                if (!alive) return;
                // Plain language for students; the technical cause stays in the console.
                console.warn('Map data failed to load:', err);
                setError('The campus map could not load. Check your Wi-Fi or mobile data, then try again.');
                setMapLoadFailed(true);
                setLoading(false);
            });

        return () => { alive = false; };
    }, [loadAttempt]);

    // A sync brought a newer map (or the phone is back online): show it now
    // and drop the "offline copy" notice.
    const applyMap = (map) => {
        setNodes(map.nodes || []);
        setBorders(map.borders || []);
        setLinks(map.links || []);
        setBuildings(map.buildings || []);
        setBridges(map.bridges || []);
        setClosures(map.closures || []);
        setCampusHours(map.campus_hours || null);
        setPathways(map.pathways || []);
        setCampusAreas(map.campus_areas || []);
        setOfflineCopy(null);
        setError(null);
        setMapLoadFailed(false);
    };
    // Automatic offline copy (nodes, routes, buildings, weather): on load,
    // every 20 minutes, on reconnect. Replaces the old download button.
    const sync = useAutoSync({ onMap: applyMap, headers: authHeaders, enabled: !isVisitor });

    // Latest adopted fix (ref mirror of userLocation for the watch handler).
    const stableRef = useRef(null);

    // GPS pipeline: Kalman smoothing (uses each fix's own accuracy as its
    // noise) + snap-to-walkway map matching. The GPS watch is registered once
    // on mount, so it reads nodes/borders through refs, never stale state.
    const gpsPipelineRef = useRef(null);
    if (gpsPipelineRef.current === null) gpsPipelineRef.current = new GpsPipeline();
    // Stream-health bookkeeping for the stall watchdog.
    const lastFixAtRef = useRef(0);
    const lastPollAtRef = useRef(0);
    const lastRestartAtRef = useRef(0);
    const nodesRef = useRef([]);
    const bordersRef = useRef([]);
    // GPS snapping uses the same walkable network as routing: route nodes and the pathways' lines.
    const walkNodes = useMemo(() => [...nodes, ...pathwayWaypoints(pathways)], [nodes, pathways]);
    nodesRef.current = walkNodes;
    bordersRef.current = borders;

    // The map is locked to the campus box and must never leave it — least of
    // all widen it to reach somewhere else (which is how the lock used to be
    // bypassed: the first GPS fix called setMaxBounds(extend(fix))). The view
    // therefore never chases coordinates; automatic recentering goes to the
    // PMTiles archive centre instead, and programmatic fits are clamped in.
    const centerOnCampus = () => {
        const map = mapInstance.current;
        if (!map) return;
        // Re-assert the lock: repairs any state where it had been widened.
        lockToCampus(map);
        map.flyTo(CAMPUS_CENTER, CAMPUS_MAX_ZOOM, { duration: 0.6 });
    };

    // Fit a requested view rectangle, clamped into the campus box first, so
    // off-archive nodes or a route that starts at the user's (out-of-box)
    // position can't pull the camera over blank tile space. Padded first, then
    // clamped — padding is what would otherwise push the rect back out.
    const fitInsideBox = (bounds) => {
        const map = mapInstance.current;
        if (!map) return;
        const box = campusLatLngBounds();
        const padded = bounds.pad(0.2);
        const sw = [Math.max(padded.getSouth(), box.getSouth()), Math.max(padded.getWest(), box.getWest())];
        const ne = [Math.min(padded.getNorth(), box.getNorth()), Math.min(padded.getEast(), box.getEast())];
        if (sw[0] >= ne[0] || sw[1] >= ne[1]) return; // nothing inside the box
        map.fitBounds(L.latLngBounds(sw, ne));
    };

    const adoptLocation = (fix, { centerMap = false } = {}) => {
        stableRef.current = fix;
        setUserLocation(fix);
        // A new position here (pin or GPS) replaces the one last walked
        // to in the 3D view, which otherwise stayed the route's start.
        setWalkedPos(null);
        // Deliberately NOT centred on the fix: the user's coordinates are
        // routinely outside the archive footprint, so chasing them escaped the
        // bounding box. Re-centre on the archive instead.
        if (centerMap) centerOnCampus();
    };

    // ── POV: which way the phone is facing, on the 2D map ────────────
    // The map never rotates (north stays up), so "facing" is shown two ways:
    // a wedge pivoting on the you-are-here dot, and a readout pill. Heading comes
    // from the same deviceorientation streams and src/heading.js maths the
    // 3D view uses, so both screens tell the same story.
    const headingRef = useRef(null);
    const povMarkerRef = useRef(null);
    const povPillRef = useRef(null);
    // Eased motion. One SmoothPoint drives the dot, the wedge and the accuracy
    // ring together, so they glide to each new fix as a unit instead of the
    // dot teleporting once a second. One SmoothAngle eases the wedge's
    // rotation and keeps it continuous across north (359°→1° is a 2° turn,
    // not 358° backwards).
    const userFollowRef = useRef(null);
    const povSpinRef = useRef(null);
    // Made (again) whenever there is none or the last one was shut down: an
    // unmount stops them for good, but React can mount this screen again
    // with the same refs (e.g. a dev-server hot reload), and a dead follower
    // left the "you" dot frozen while the route moved on without it.
    const ensureFollowers = () => {
        if (!userFollowRef.current || userFollowRef.current.dead) {
            userFollowRef.current = new SmoothPoint({
                tau: 0.12,
                onUpdate: (lat, lng) => {
                    const ll = [lat, lng];
                    userMarkerRef.current?.setLatLng(ll);
                    povMarkerRef.current?.setLatLng(ll);
                    accuracyRef.current?.setLatLng(ll);
                },
            });
        }
        if (!povSpinRef.current || povSpinRef.current.dead) {
            povSpinRef.current = new SmoothAngle({
                tau: 0.08,
                onUpdate: (deg) => paintPovRotation(povMarkerRef.current, deg),
            });
        }
    };
    ensureFollowers();
    useEffect(() => {
        ensureFollowers();
        return () => {
            userFollowRef.current?.destroy();
            povSpinRef.current?.destroy();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    const orientHandlersRef = useRef(null);
    const orientAttachAtRef = useRef(0);
    const orientLastEventAtRef = useRef(0);
    const absoluteSeen2DRef = useRef(false);
    const compassAskedRef = useRef(false);
    // Compass confidence (iOS reports ± degrees; elsewhere unknown → no
    // warning). Only re-renders when the quality bucket actually changes.
    const [compassWarn, setCompassWarn] = useState(null);
    const compassWatcherRef = useRef(null);
    if (compassWatcherRef.current === null) compassWatcherRef.current = createCompassWatcher();
    const noteCompassAccuracy = (e) => {
        const r = compassWatcherRef.current.update(headingAccuracyFromEvent(e));
        if (r.changed) setCompassWarn(r.warning);
    };

    // Creates the wedge once heading AND position have both arrived, and
    // keeps it under the you-are-here dot afterwards. Called from the heading
    // handler and from the GPS-fix effect, because either can come first.
    const ensurePovMarker = () => {
        const map = mapInstance.current;
        const cur = userFollowRef.current.current;
        const spin = povSpinRef.current;
        if (!map || !cur || !spin.hasValue) return;
        if (!povMarkerRef.current) {
            // 900 < 1000: the wedge always sits beneath the you-are-here dot.
            // Born at the dot's DRAWN position (not the raw fix) so it never
            // appears a few metres off and slides in.
            povMarkerRef.current = L.marker([cur.lat, cur.lng], {
                icon: POV_ICON, zIndexOffset: 900, interactive: false,
            }).addTo(map);
            paintPovRotation(povMarkerRef.current, spin.angle);
        }
    };

    // Sensor events arrive at up to 100 Hz; re-rendering React that often
    // would jank map panning, so the wedge and the pill are written straight
    // into the DOM instead of through state.
    const applyHeading = (rawDeg) => {
        headingRef.current = ((rawDeg % 360) + 360) % 360;
        povSpinRef.current.set(headingRef.current);
        ensurePovMarker();
        const pill = povPillRef.current;
        if (pill) {
            pill.style.display = 'flex';
            pill.textContent = `${Math.round(headingRef.current) % 360}° ${compassLabel(headingRef.current)}`;
        }
    };

    const attachOrientation = () => {
        if (orientHandlersRef.current) return;
        const onAbsolute = (e) => {
            const h = headingFromOrientationEvent(e);
            if (h === null || Number.isNaN(h)) return;
            absoluteSeen2DRef.current = true;
            orientLastEventAtRef.current = performance.now();
            applyHeading(h);
            noteCompassAccuracy(e);
        };
        const onRelative = (e) => {
            const h = headingFromOrientationEvent(e);
            if (h === null || Number.isNaN(h)) return;
            // Bootstrap only: some devices never fire 'absolute' at all, but
            // once it has spoken its frame is the trustworthy one — mixing
            // the two mid-session spins the cone (same rule as the 3D view).
            if (absoluteSeen2DRef.current) return;
            orientLastEventAtRef.current = performance.now();
            applyHeading(h);
            noteCompassAccuracy(e);
        };
        window.addEventListener('deviceorientationabsolute', onAbsolute, true);
        window.addEventListener('deviceorientation', onRelative, true);
        orientHandlersRef.current = { onAbsolute, onRelative };
        orientAttachAtRef.current = performance.now();
    };

    const detachOrientation = () => {
        const handlers = orientHandlersRef.current;
        if (!handlers) return;
        window.removeEventListener('deviceorientationabsolute', handlers.onAbsolute, true);
        window.removeEventListener('deviceorientation', handlers.onRelative, true);
        orientHandlersRef.current = null;
    };

    // Heading subscription. The gesture handler does the two jobs a timer
    // cannot: it raises the iOS permission prompt (only legal inside a real
    // tap) and re-attaches the listener pair once the stream goes quiet —
    // on Chrome/Android a tap is the only thing that has ever restarted a
    // stalled deviceorientation stream, which is the exact finding that
    // shaped the 3D view's re-arm. Wiring is ref-only, so it is attached
    // once on mount and never needs re-running when render state changes.
    useEffect(() => {
        attachOrientation();
        const onGesture = () => {
            if (HAS_COMPASS_PROMPT && !compassAskedRef.current) {
                compassAskedRef.current = true;
                try {
                    const asked = DeviceOrientationEvent.requestPermission();
                    if (asked && typeof asked.then === 'function') {
                        asked.then((res) => {
                            if (res === 'granted') { detachOrientation(); attachOrientation(); }
                        }).catch(() => { compassAskedRef.current = false; });
                    }
                } catch { compassAskedRef.current = false; }
            }
            const now = performance.now();
            // A stream that has never spoken at all gets re-attached on any
            // tap (that is the observed Chrome/Android failure: silence until
            // the listener pair is rebuilt), while a stream that is merely
            // going quiet only re-arms after 1.5 s so rapid taps can't churn.
            const silentFor = orientLastEventAtRef.current === 0
                ? Infinity
                : now - orientLastEventAtRef.current;
            const throttle = orientLastEventAtRef.current === 0 ? 500 : 1500;
            if (silentFor > throttle && now - orientAttachAtRef.current > throttle) {
                detachOrientation();
                attachOrientation();
            }
        };
        window.addEventListener('pointerdown', onGesture, true);
        window.addEventListener('focus', onGesture);
        return () => {
            detachOrientation();
            window.removeEventListener('pointerdown', onGesture, true);
            window.removeEventListener('focus', onGesture);
        };
    }, []);

    // Watchdog bookkeeping: when the current watch started, how many
    // silent auto-restarts we've done, and when a relocate was requested.
    const watchStartRef = useRef(0);
    const autoRetryRef = useRef(0);
    const relocateAtRef = useRef(0);

    const onGpsError = (err) => {
        const code = err && err.code;
        if (code === 1) {
            // Permission denied — nothing will ever arrive until the user
            // acts. Say so plainly instead of spinning "Waiting…" forever.
            setError('GPS permission denied. Allow Location access for this site in the browser, then tap Retry GPS.');
            setWaitingGps(false);
            return;
        }
        // Unavailable / timeout: the provider timed out — restart the watch
        // shortly so a stalled stream can't sit silent forever.
        // Offline, the phone cannot download satellite hints (assisted GPS), so the first fix is
        // slower: say so instead of "signal lost". GPS itself needs no internet.
        const slowOfflineFix = !stableRef.current && navigator.onLine === false;
        setGpsNote(slowOfflineFix ? 'Finding your location without internet. The first GPS fix can take a minute or two; open sky helps.' : `GPS signal lost (${(err && err.message) || 'unavailable'}). Retrying…`);
        setTimeout(() => { if (!stableRef.current) startWatch(); }, 5000);
        // Try fallback to network location if high accuracy timed out or is unavailable
        if (!stableRef.current && navigator.geolocation) {
            navigator.geolocation.getCurrentPosition(
                (pos) => onGpsFix(pos),
                (fallbackErr) => {
                    setGpsNote(slowOfflineFix ? 'Finding your location without internet. The first GPS fix can take a minute or two; open sky helps.' : `GPS waiting (${(fallbackErr && fallbackErr.message) || (err && err.message) || 'searching'})…`);
                },
                { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 }
            );
        } else {
            // We HAD a fix and the stream died (timeout / unavailable). The old
            // code only wrote a note here and never recovered — the dot froze
            // until the page was refreshed. Re-create the watch right away.
            setGpsNote(`GPS signal lost (${(err && err.message) || 'unavailable'}). Reconnecting…`);
            restartWatch();
        }
    };

    // One fresh, never-cached position. Used by the watchdog so the dot keeps
    // moving even while the watch itself is dead.
    const pollOnce = () => {
        if (!navigator.geolocation) return;
        lastPollAtRef.current = Date.now();
        navigator.geolocation.getCurrentPosition(onGpsFix, () => {}, GPS_POLL_OPTS);
    };

    // Tear the watch down and create a new one (throttled to once per 2 s so
    // an error storm or a focus+visibility pair can't thrash the receiver).
    const restartWatch = () => {
        if (testLocRef.current || !navigator.geolocation) return;
        const now = Date.now();
        if (now - lastRestartAtRef.current < 2000) return;
        lastRestartAtRef.current = now;
        if (watchIdRef.current !== null && watchIdRef.current !== undefined) {
            try { navigator.geolocation.clearWatch(watchIdRef.current); } catch { /* already gone */ }
            watchIdRef.current = null;
        }
        watchStartRef.current = now;
        watchIdRef.current = navigator.geolocation.watchPosition(onGpsFix, onGpsError, GPS_WATCH_OPTS);
        pollOnce();
    };

    const onGpsFix = (pos) => {
        if (testLocRef.current) return;
        lastFixAtRef.current = Date.now();
        // Only a genuinely unusable fix (non-finite coords would blank the
        // whole 3D scene) is dropped — the pipeline returns null for those.
        // Phone altitude / altitudeAccuracy are passed through (undefined
        // when the browser doesn't supply them, so the 3D scene keeps its
        // datum at 0 rather than inventing a value).
        //
        // Pipeline: raw fix → Kalman smoothing → snap to the nearest walkway
        // edge. The 2D dot and the 3D view both read the adopted fix, so they
        // still show the same number. A relocation (first fix, "Use my
        // location") restarts the filter so a stale position can't drag.
        const first = !stableRef.current;
        const recenter = first || relocateRef.current;
        if (recenter) gpsPipelineRef.current.reset();
        const fix = gpsPipelineRef.current.process(pos, { nodes: nodesRef.current, borders: bordersRef.current });
        if (!fix) return;
        relocateRef.current = false;
        adoptLocation(fix, { centerMap: recenter });
        setWaitingGps(false);
        setGpsNote(null);
    };

    // (Re)start the GPS watch and fetch an immediate initial position.
    const startWatch = () => {
        // A restarted watch begins a fresh stream: drop the filter's history.
        gpsPipelineRef.current.reset();
        if (!navigator.geolocation) {
            setError('Geolocation is not supported by this browser.');
            return;
        }

        // 1. Immediate one-shot position with cached fallback for instant location
        navigator.geolocation.getCurrentPosition(
            (pos) => onGpsFix(pos),
            (err) => {
                // If high-accuracy timed out, try low-accuracy (cell/WiFi) as fallback
                navigator.geolocation.getCurrentPosition(
                    (pos) => onGpsFix(pos),
                    (fallbackErr) => onGpsError(err || fallbackErr),
                    { enableHighAccuracy: false, timeout: 8000, maximumAge: 60000 }
                );
            },
            { enableHighAccuracy: true, timeout: 8000, maximumAge: 5000 }
        );

        // 2. Continuous watchPosition for live updates
        if (watchIdRef.current !== null && watchIdRef.current !== undefined) {
            try { navigator.geolocation.clearWatch(watchIdRef.current); } catch { /* already gone */ }
            watchIdRef.current = null;
        }
        watchStartRef.current = Date.now();
        watchIdRef.current = navigator.geolocation.watchPosition(
            onGpsFix,
            onGpsError,
            GPS_WATCH_OPTS,
        );
    };

    // GPS tracking (skipped while a manual test location is active).
    useEffect(() => {
        startWatch();

        return () => {
            if (watchIdRef.current !== null && watchIdRef.current !== undefined) {
                try { navigator.geolocation.clearWatch(watchIdRef.current); } catch { /* already gone */ }
                watchIdRef.current = null;
            }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Stall watchdog (runs once we have a fix; the cold-start retries below
    // own the "no fix yet" phase). Every second: no fix for 3 s → ask for a
    // fresh one-shot; no fix for 7 s → rebuild the watch. Also rebuilds it the
    // moment the page returns to the foreground, because browsers suspend
    // geolocation for hidden tabs and often never resume it on their own.
    useEffect(() => {
        const tick = setInterval(() => {
            if (testLocRef.current || document.hidden) return;
            const now = Date.now();
            const action = stallAction({
                now,
                lastFixAt: Math.max(lastFixAtRef.current, watchStartRef.current || 0),
                lastPollAt: lastPollAtRef.current,
                lastRestartAt: lastRestartAtRef.current,
                hasFix: !!stableRef.current,
            });
            if (action === 'restart') {
                setGpsNote('GPS stalled. Reconnecting…');
                restartWatch();
            } else if (action === 'poll') {
                pollOnce();
            }
        }, 1000);
        const wake = () => {
            if (document.hidden || !stableRef.current) return;
            restartWatch();
        };
        document.addEventListener('visibilitychange', wake);
        window.addEventListener('pageshow', wake);
        window.addEventListener('online', wake);

        return () => {
            clearInterval(tick);
            document.removeEventListener('visibilitychange', wake);
            window.removeEventListener('pageshow', wake);
            window.removeEventListener('online', wake);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Watchdog: checks if a fix has landed; if still waiting after 12s,
    // queries low-accuracy one-shot without resetting the continuous watch stream.
    useEffect(() => {
        const id = setInterval(() => {
            if (stableRef.current || testLocRef.current) return;
            if (waitingGps && Date.now() - (relocateAtRef.current || 0) > 25000) {
                setWaitingGps(false);
                setGpsNote('GPS timed out. Tap Use my location to try again');
                return;
            }
            const waited = Date.now() - (watchStartRef.current || Date.now());
            if (waited > 12000 && autoRetryRef.current < 3) {
                autoRetryRef.current += 1;
                setGpsNote(`Acquiring satellite fix (attempt ${autoRetryRef.current})…`);
                // Query low-accuracy one-shot without restarting watch
                navigator.geolocation?.getCurrentPosition(
                    (pos) => onGpsFix(pos),
                    () => {},
                    { enableHighAccuracy: false, timeout: 8000, maximumAge: 60000 }
                );
            } else if (waited > 25000) {
                setGpsNote('Still acquiring GPS fix. Tap Retry GPS or check site permissions');
            }
        }, 5000);

        return () => clearInterval(id);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [waitingGps]);

    // Init map once
    useEffect(() => {
        if (mapInstance.current || !mapRef.current) return;
        const map = L.map(mapRef.current, {
            zoomControl: true,
            minZoom: CAMPUS_MIN_ZOOM,
            maxZoom: CAMPUS_MAX_ZOOM,
            // Lock the view to campus — no panning/zooming out to the world.
            maxBounds: campusLatLngBounds(),
            maxBoundsViscosity: 1.0,
            // Gestures that cannot leave the box (see CAMPUS_MAP_LOCK).
            ...CAMPUS_MAP_LOCK,
        }).setView(CAMPUS_CENTER, CAMPUS_MAX_ZOOM);
        // The whole view stays inside the campus box at every zoom.
        lockToCampus(map);
        // Protomaps vector base map (campus PMTiles archive, box-restricted).
        // Light style (GPS_FLAVOR), same as the admin map: with the archive's
        // buildings and roads hidden, the dark style read as an empty black
        // screen. The white route and "you" dot carry a dark edge (ROUTE_CASING)
        // so they still stand out on the pale tiles.
        createTileLayer({ flavor: GPS_FLAVOR, hiddenLayers: GPS_HIDDEN_LAYERS }).addTo(map);
        // Pathways and building labels sit under the route and the pins.
        prepareCampusPanes(map);
        // Campus outlines first: everything else draws over them.
        areaLayerRef.current = L.layerGroup().addTo(map);
        pathwayLayerRef.current = L.layerGroup().addTo(map);
        // Sun shadows fall over the paths but under the buildings' roofs.
        shadowLayerRef.current = L.layerGroup().addTo(map);
        // Walls (2.5D) under the buildings: a building in front of a wall covers it.
        wallLayerRef.current = L.layerGroup().addTo(map);
        buildingLayerRef.current = L.layerGroup().addTo(map);
        // Walls in front of the buildings (south of them, nearer the viewer) draw over them.
        wallFrontLayerRef.current = L.layerGroup().addTo(map);
        bridgeLayerRef.current = L.layerGroup().addTo(map);
        cutawayLayerRef.current = L.layerGroup().addTo(map);
        bindLabelZoom(map);
        routeLayerRef.current = L.layerGroup().addTo(map);
        mapInstance.current = map;

        map.on('click', (e) => {
            if (!testLocRef.current) return;
            const { lat, lng } = e.latlng;
            adoptLocation({ latitude: lat, longitude: lng, accuracy: 5, source: 'pin' });
        });

        return undefined;
    }, []);

    // Satellite imagery: students and visitors alike (one setting per device,
    // shared with the 3D view's mini-map). Imagery loads only while it is on.
    const satellite = useSatelliteSettings();
    useSatelliteLayer(() => mapInstance.current, satellite);

    // Fit to nodes once data arrives — clamped: the DB holds two clusters a
    // long way apart, so an unclamped fit parks the view between them, off
    // the archive, where nothing renders.
    // Visitors get no nodes, so their map frames the buildings instead (it stayed on a blank
    // 40 m patch at zoom 22 before).
    useEffect(() => {
        if (!mapInstance.current) return;
        const pts = floorNodes.length > 0
            ? floorNodes.map((n) => [n.latitude, n.longitude])
            : buildings.flatMap((b) => (b.polygon || []).map((q) => [q.lat, q.lng]));
        if (pts.length === 0) return;
        fitInsideBox(L.latLngBounds(pts));
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [floorNodes, floorNodes.length === 0 ? buildings : null]);

    // Live sun shadows: recomputed from the clock every minute (the sun moves
    // ~0.25 degrees a minute, a visible creep on a long evening shadow), and
    // again when the phone returns to the app after being locked.
    useEffect(() => {
        const layer = shadowLayerRef.current;
        if (!layer) return undefined;
        drawShadows(layer, buildings, { date: sunDate, lat: CAMPUS_CENTER[0], lng: CAMPUS_CENTER[1] });
        // The map darkens with the time of day (dusk, night), like the shadows follow the sun.
        if (mapInstance.current) drawSkyTint(mapInstance.current, sunPosition(sunDate, CAMPUS_CENTER[0], CAMPUS_CENTER[1]).altitudeDeg);
        return undefined;
    }, [buildings, sunDate]);

    // Campus outlines: where Campus A ends and Campus B begins (display only).
    useEffect(() => {
        const layer = areaLayerRef.current;
        if (!layer) return;
        layer.clearLayers();
        for (const a of campusAreas) {
            if (!Array.isArray(a.polygon) || a.polygon.length < 3) continue;
            const focused = campusFilter === 'all' || campusFilter === String(a.id);
            L.polygon(a.polygon.map((q) => [q.lat, q.lng]), {
                color: a.color || '#38bdf8', weight: focused ? 2 : 1.25, opacity: focused ? 0.85 : 0.35, dashArray: '10, 7',
                fill: false, interactive: false,
            }).bindTooltip(escapeHtml(a.name), { permanent: true, direction: 'center', className: 'campus-area-label' }).addTo(layer);
        }
    }, [campusAreas, campusFilter]);

    // Building labels ("CCS · 4 floors") and the road/walkway network.
    useEffect(() => {
        if (!buildingLayerRef.current || !pathwayLayerRef.current) return;
        // Tapping a building lists what is inside it, each one a tap away
        // from being the destination (window.__mnavGoTo, bound below).
        const popup = (b) => {
            // Opening hours (read when the popup opens): open now or when it opens, and the week.
            const hoursNow = buildingStatus(b, closuresRef.current, new Date());
            // A room with hours of its own (a cashier inside the building): its state on its row.
            const roomHours = (n) => {
                const own = placeStatusOf(n, buildingsById, closuresRef.current, new Date());
                // Only when it differs from the building's line above (its own hours, or a closure of its own).
                if (own && hoursNow && own.label === hoursNow.label) return '';
                return own ? ` · <span class="${own.open ? '' : 'bp-closed'}">${escapeHtml(own.label)}</span>` : '';
            };
            const hoursLine = hoursNow
                ? `<small class="${hoursNow.open ? '' : 'bp-closed'}">${escapeHtml(hoursNow.label)}</small>${b.opening_hours ? `<small>${escapeHtml(summarizeHours(b.opening_hours))}</small>` : ''}`
                : '';
            // Visitors get the same popup: their map holds only the important places staff showed them.
            const inside = nodes
                .filter((n) => n.type === 'location' && n.building_id === b.id)
                .sort((x, y) => floorOf(x) - floorOf(y) || String(x.name).localeCompare(String(y.name)));
            const rows = inside.length
                ? inside.map((n) => `
                    <li class="bp-row">
                        <span class="bp-text"><b>${escapeHtml(n.name || 'Location')}</b><small>${escapeHtml(floorAria(floorOf(n)))}${roomHours(n)}</small></span>
                        <button class="bp-go" onclick="window.__mnavGoTo(${Number(n.id)})" aria-label="Go to ${escapeHtml(n.name || 'this location')}">Go</button>
                    </li>`).join('')
                : '<li class="bp-empty">No rooms listed yet.</li>';
            return `
                <div class="bp">
                    <div class="bp-head bp-head-go">
                        <span class="bp-text"><b>${escapeHtml(b.name)}</b><small>${escapeHtml(floorCountLabel(b))}${inside.length ? `, ${inside.length} ${inside.length === 1 ? 'place' : 'places'}` : ''}</small>${hoursLine}</span>
                        <button class="bp-go" onclick="window.__mnavGoTo('b:${Number(b.id)}')" aria-label="Go to ${escapeHtml(b.name)}">Go to building</button>
                    </div>
                    <ul class="bp-list sw ui-stagger" aria-label="Places in ${escapeHtml(b.name)}" style="--sw-desktop-rows:4;--sw-phone-rows:3;--sw-desktop-row-h:45px;--sw-phone-row-h:45px">${rows}</ul>
                </div>`;
        };
        drawPathways(pathwayLayerRef.current, pathways, { theme: GPS_FLAVOR });
        // The drawn walls stand up like the buildings (2.5D), shaded by the sun.
        if (wallLayerRef.current) {
            drawWalls25D(wallLayerRef.current, borders, { theme: GPS_FLAVOR, sun: sunForWalls, buildings, frontLayer: wallFrontLayerRef.current });
        }
        drawBuildings(buildingLayerRef.current, buildings, { popup, theme: GPS_FLAVOR, extrude: true, sun: sunForWalls, skipIds: routeBuildingIds });
        // After the buildings, raised like them (2.5D): the deck crosses over the road between them.
        if (bridgeLayerRef.current) drawBridges(bridgeLayerRef.current, bridges, { theme: GPS_FLAVOR, extrude: true, links, nodes });

        // Long lists in the popup get the same scroll cue as the rest of the app.
        const map = mapInstance.current;
        if (!map) return undefined;
        let unbind = () => {};
        const onOpen = (e) => { unbind(); unbind = bindScrollCue(e.popup.getElement()?.querySelector('.bp-list')); };
        map.on('popupopen', onOpen);
        return () => { map.off('popupopen', onOpen); unbind(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [buildings, bridges, pathways, nodes, links, borders, sunWallsKey, routeBuildingKey]);

    // Render node markers — destinations only, and only for the selected
    // floor. Intermediate route nodes stay hidden on the 2D screen; the path
    // itself (polyline + 3D tube) is what guides the eye between stops.
    // Routing still reads the full node list.
    useEffect(() => {
        if (!mapInstance.current) return;
        const map = mapInstance.current;
        Object.values(markersRef.current).forEach((m) => map.removeLayer(m));
        markersRef.current = {};
        floorNodes.forEach((node) => {
            if (node.type !== 'location') return;
            // Rooms inside buildings stay hidden until one is the chosen
            // destination: the map shows buildings, not every room in them.
            if (node.building_id != null && String(node.id) !== String(destId)) return;
            // Destination pins carry the weather status: green = routable,
            // amber = rain possible (exposed; the AI's chance shows in the popup),
            // red = raining now (closed). Sheltered paths are always green.
            const status = nodeRainStatus(node.path_type, weather);
            const color = status === NODE_STATUS.RED
                ? C.error
                : status === NODE_STATUS.YELLOW
                    ? C.warning
                    : C.go;
            const statusWord = nodeRainLabel(node.path_type, weather);
            const marker = L.marker(
                [node.latitude + cutawayLift(node), node.longitude],
                { icon: createDestinationPinIcon(color, 16, 'pin-hit'), zIndexOffset: 500, title: node.name || 'Location' }
            ).addTo(map);
            const place = nodePlaceLabel(node, buildingsById);
            // Live weather at this node: the campus forecast (refreshed by the
            // server every 20 min) applied to how exposed the spot is.
            const exposure = node.path_type === 'outside' ? 'Outdoors' : 'Sheltered';
            const temp = Number.isFinite(Number(weather.temperature_c)) ? `${Math.round(Number(weather.temperature_c))}°C` : null;
            const sky = weather.condition && weather.condition !== 'unknown' ? weather.condition : null;
            const age = Number.isFinite(Number(weather.age_minutes)) ? `updated ${Number(weather.age_minutes)} min ago` : null;
            const weatherLine = weather.status === 'unavailable'
                ? 'Weather not available right now'
                : [[exposure, temp, sky].filter(Boolean).join(', '), age].filter(Boolean).join(' · ');
            marker.bindPopup(
                `<strong>${escapeHtml(node.name || 'Location')}</strong><br>`
                + `${escapeHtml(place || floorAria(floorOf(node)))}<br>`
                + `${escapeHtml(statusWord)}<br>`
                + `<span style="color:${C.muted};font-size:12px">${escapeHtml(weatherLine)}</span>`,
            );
            markersRef.current[node.id] = marker;
        });
        // Floor markers are rebuilt on every floor change; close the old popup.
        map.closePopup();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [floorNodes, weather, buildingsById, routeBuildingKey, destId]);

    // User marker + accuracy circle (view is never moved here)
    useEffect(() => {
        if (!mapInstance.current || !effectiveUser) return;
        const map = mapInstance.current;
        const ll = [effectiveUser.latitude, effectiveUser.longitude];
        ensureFollowers();
        const follow = userFollowRef.current;
        if (userMarkerRef.current) {
            // Glide to the new position (the follower also carries the wedge
            // and the accuracy ring along, frame by frame). `stableRef` still
            // tracks the *real* fix: it doubles as "has a GPS fix ever been
            // adopted", which drives the watch bootstrapping.
            follow.moveTo(ll[0], ll[1]);
        } else {
            userMarkerRef.current = L.marker(ll, { icon: USER_ICON, zIndexOffset: 1000, title: 'Your location' }).addTo(map);
            follow.snapTo(ll[0], ll[1]);
        }
        // Anything created now starts where the dot is DRAWN, not at the
        // target, so nothing is born ahead of the dot mid-glide.
        const here = follow.current ? [follow.current.lat, follow.current.lng] : ll;
        // A walked (virtual) position has no GPS error, so drawing a radius
        // circle would invent an error bar. Hide it while free-roaming and
        // restore it as soon as a real fix takes over again.
        if (!walkedPos && effectiveUser.accuracy) {
            if (accuracyRef.current) {
                accuracyRef.current.setRadius(effectiveUser.accuracy)
                    .setStyle({ opacity: 0.5, fillOpacity: 0.08 });
            } else {
                accuracyRef.current = L.circle(here, {
                    radius: effectiveUser.accuracy, color: ROUTE_CASING, weight: 1, opacity: 0.5, fillColor: ROUTE_CASING, fillOpacity: 0.08,
                }).addTo(map);
            }
        } else if (accuracyRef.current) {
            accuracyRef.current.setStyle({ opacity: 0, fillOpacity: 0 });
        }
        // First fix or not, the POV wedge (if the sensor already spoke)
        // belongs under the dot too.
        ensurePovMarker();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [effectiveUser, walkedPos]);

    // Recompute route (same shared logic as the admin panel).
    // Driven by `effectiveUser`, so walking in 3D re-runs Dijkstra exactly
    // the way walking with a phone does — the path re-anchors continuously
    // Shade for routing on a hot day: building shadows at the current sun
    // (re-made when the sun has moved ~5 degrees), weighted by the heat index.
    // Stale or missing weather never adds a penalty.
    // Heat closes open-air paths when it is too hot now, or once a predicted hot hour has begun
    // (the minute clock re-checks it), never ahead of time.
    const heatClosed = heatModeActive(weather, sunClock.getTime());
    const shadePenalty = weather && weather.status !== 'stale' && weather.status !== 'unavailable'
        ? shadePenaltyFor(weather.heat_index_c, weather.uv_index) : 1;
    const routeShade = useMemo(() => {
        if (!(shadePenalty > 1)) return null;
        const map = shadeMap(buildings, sunDate, CAMPUS_CENTER[0], CAMPUS_CENTER[1]);
        return map ? { map, penalty: shadePenalty } : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [buildings, sunWallsKey, shadePenalty]);

    // instead of staying pinned to wherever the session started. This is
    // the whole point of reporting the walked position back out of ARView.
    useEffect(() => {
        // Visitors have no stored nodes (only the outdoor network), so "loaded" is the test, not a count.
        if (!destId || !effectiveUser || loading) {
            setRoute(null);
            setNoRoute(null);
            routeLayerRef.current?.clearLayers();
            return;
        }
        // Closed right now: no route, just why and when it opens (it reappears once open).
        if (destClosed) {
            setRoute(null);
            setNoRoute(destClosed);
            routeLayerRef.current?.clearLayers();
            return;
        }
        try {
            // Rain changes the COST of exposed edges (and closes them entirely
            // while it is actually falling), so a flip in the weather state
            // must re-run Dijkstra — hence the weather deps below.
            // The floor the student is on is where the route starts; other
            // floors are reached only through the admin's staircase links.
            const routeTo = (target) => computeRoute(nodes, target, effectiveUser.latitude, effectiveUser.longitude, 0, borders, {
                rainMultiplier: rainMultiplierOf(weather),
                rainNow: Boolean(weather.raining_now),
                heatNow: heatClosed,
                // Hot day: sunny exposed paths cost more, so shaded ones win.
                shade: routeShade,
                userFloor: activeFloor,
                links,
                // Routes walk around buildings, entering only the one they need.
                buildings,
                // Bridges with doors are got on and off only through them.
                bridges,
                // Every road and walkway is a route along its line.
                pathways,
                // Closed buildings (opening hours) are walked around, not through.
                closedBuildingIds: closedIds,
            });
            // A whole building: the shortest way to one of its doors (or its
            // ground floor when it has none yet).
            const destBuilding = parseBuildingDestination(destId);
            const target = destBuilding !== null ? buildingsById.get(destBuilding) : null;
            // walkNodes: with the pathways' points, so a building with no doors or nodes yet is reached at the
            // walkway beside it (real outdoor nodes are few now: routes follow the pathways).
            const result = target ? routeToBuilding(target, walkNodes, routeTo) : routeTo(destId);
            setRoute(result.success ? result : null);
            // Every failure is said out loud: a silent one left "Choose a destination" on screen
            // with a destination chosen.
            setNoRoute(result.success ? null : (result.message || 'No walking path to there yet.'));
            routeLayerRef.current?.clearLayers();
            if (result.success && mapInstance.current) {
                // Only the part of the route on the floor being shown is
                // drawn; the rest appears when the student changes floor.
                // Inside a building the route is drawn on the cut-away floor
                // plate it walks on, not on the ground under the raised roof.
                const entered = new Set(result.path.map((p) => p.building_id).filter((id) => id !== null && id !== undefined));
                // A raised bridge deck is drawn flat on the ground map, so on the ground floor its part of the
                // route is drawn too: up the stairs' walking line, along the deck, and down again.
                const deckUnder = (p) => (activeFloor === 0 && p.building_id == null && floorOf(p) > 0 ? (bridges || []).find((br) => br.status !== 'planned'
                    && Number(br.deck_floor) === floorOf(p) && Array.isArray(br.polygon) && pointInPolygon(+p.latitude, +p.longitude, br.polygon)) : null);
                const onDeck = (p) => Boolean(deckUnder(p));
                // On the raised (2.5D) deck, as drawBridges draws it: lifted by the deck's height.
                const deckLift = (br) => roofLiftM(bridgeDeckHeightM(br)) / 111320;
                const shown = (p) => p.type === 'user' || floorOf(p) === activeFloor || onDeck(p);
                // One line per stretch on this floor: a route that leaves it and comes back is not
                // joined straight across the gap (it used to draw the ground under a bridge).
                const segs = [];
                let seg = null;
                result.path.forEach((p, i) => {
                    if (!shown(p)) { seg = null; return; }
                    const prev = result.path[i - 1];
                    if (!seg) segs.push(seg = []);
                    else if (prev && prev.type !== 'user' && floorOf(prev) !== floorOf(p)) {
                        const link = links.find((l) => (l.node_a_id === prev.id && l.node_b_id === p.id) || (l.node_a_id === p.id && l.node_b_id === prev.id));
                        // Up (or down) the stairs from the ground to the raised deck.
                        const br = deckUnder(p) || deckUnder(prev);
                        if (link) seg.push(...stairRouteLine(link, prev, p, (f) => (f > 0 && br ? deckLift(br) : 0)).slice(1, -1));
                    }
                    const br = deckUnder(p);
                    seg.push([p.latitude + (br ? deckLift(br) : cutawayLift(p, entered)), p.longitude]);
                });
                const latlngs = segs.flat();
                // A staircase marker where this floor's route ends (going
                // up/down) and where it begins (arriving).
                // Depth: what is on a higher floor than the one shown (stairs
                // going up, the floor above's preview) is drawn OVER this
                // floor's route; lower floors go under it.
                const below = L.layerGroup().addTo(routeLayerRef.current);
                const above = L.layerGroup();
                for (const st of result.stairs || []) {
                    const leaving = st.from_floor === activeFloor;
                    const arriving = st.to_floor === activeFloor;
                    if (!leaving && !arriving) continue;
                    const node = result.path[leaving ? st.from_index : st.to_index];
                    const tagLift = cutawayLift(node, entered);
                    // Inside a cut-away building the staircase itself is drawn,
                    // rising from this floor's plate to the next one.
                    const fromNode = result.path[st.from_index];
                    const toNode = result.path[st.to_index];
                    const stairBuilding = fromNode?.building_id != null && fromNode.building_id === toNode?.building_id && entered.has(fromNode.building_id)
                        ? buildingsById.get(fromNode.building_id) : null;
                    if (stairBuilding) {
                        const link = links.find((l) => (l.node_a_id === st.from_id && l.node_b_id === st.to_id)
                            || (l.node_a_id === st.to_id && l.node_b_id === st.from_id)) || { angle_deg: st.angle_deg };
                        const top = Math.max(1, Number(stairBuilding.floors) || 1) - 1;
                        const liftOf = (f) => floorLiftDeg(stairBuilding, Math.min(Math.max(0, f), top));
                        const depth = Math.max(st.from_floor, st.to_floor) > activeFloor ? above : below;
                        drawStairs25D(depth, link, fromNode, toNode, liftOf, {
                            ghost: Math.max(st.from_floor, st.to_floor) > activeFloor,
                        });
                        // The route itself climbs the steps to the next floor,
                        // joining this floor's line to the preview above (below).
                        const climb = stairRouteLine(link, fromNode, toNode, liftOf);
                        if (climb.length >= 2) {
                            L.polyline(climb, { color: ROUTE_CASING, weight: 9, opacity: 0.85, lineJoin: 'round', lineCap: 'round', interactive: false }).addTo(depth);
                            L.polyline(climb, { color: C.route, weight: 5, opacity: 0.95, lineJoin: 'round', lineCap: 'round', interactive: false }).addTo(depth);
                        }
                    }
                    // A short tag at the foot of the stairs: where they go, in
                    // the same chip as the building labels (the details are in
                    // the route panel at the bottom).
                    const goingUp = st.direction !== 'down';
                    const main = leaving ? `${goingUp ? 'Up' : 'Down'} to ${floorTag(st.to_floor)}` : `From ${floorTag(st.from_floor)}`;
                    const sub = leaving ? 'Stairs' : 'Stairs arrive';
                    const icon = goingUp ? '<path d="M3 20h5v-5h5v-5h5V5" />' : '<path d="M3 5h5v5h5v5h5v5" />';
                    L.marker([node.latitude + tagLift, node.longitude], {
                        icon: L.divIcon({
                            className: '',
                            html: `<div class="mnav-stair-tag" role="img" aria-label="${escapeHtml(`${sub}: ${main}`)}">`
                                + `<span class="mnav-stair-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${icon}</svg></span>`
                                + `<span class="mnav-stair-main">${escapeHtml(main)}</span>`
                                + `<span class="mnav-stair-sub">${escapeHtml(sub)}</span></div>`,
                            iconSize: [0, 0],
                        }),
                        interactive: false, keyboard: false, zIndexOffset: 800,
                    }).addTo(routeLayerRef.current);
                }
                // Preview of the rest of the route on the building's other
                // floors (dashed, lighter), lifted onto those floors, and the
                // destination's pin when it is on another floor.
                const runs = [];
                for (const p of result.path) {
                    if (p.type === 'user' || floorOf(p) === activeFloor || !entered.has(p.building_id)) { runs.push(null); continue; }
                    const last = runs[runs.length - 1];
                    const at = [p.latitude + cutawayLift(p, entered), p.longitude];
                    if (last && last.floor === floorOf(p)) last.pts.push(at);
                    else runs.push({ floor: floorOf(p), pts: [at] });
                }
                for (const run of runs) {
                    if (!run || run.pts.length < 2) continue;
                    const depth = run.floor > activeFloor ? above : below;
                    L.polyline(run.pts, { color: ROUTE_CASING, weight: 7, opacity: 0.35, lineJoin: 'round', lineCap: 'round', interactive: false }).addTo(depth);
                    L.polyline(run.pts, { color: C.route, weight: 3.5, opacity: 0.85, dashArray: '6, 7', lineJoin: 'round', lineCap: 'round', interactive: false }).addTo(depth);
                }
                const dest = result.path[result.path.length - 1];
                if (dest && floorOf(dest) !== activeFloor && entered.has(dest.building_id)) {
                    L.marker([dest.latitude + cutawayLift(dest, entered), dest.longitude], {
                        icon: createDestinationPinIcon(C.go, 16), opacity: 0.75, interactive: false, keyboard: false, zIndexOffset: 400,
                    }).addTo(routeLayerRef.current);
                }
                if (latlngs.length < 2) { above.addTo(routeLayerRef.current); return; }
                // Two strokes: a dark casing under a bright white line, so the
                // route stands out on the light base map. White (not red): red
                // means "problem" in this app, and the 3D arrows are white too.
                const lines = segs.filter((s) => s.length >= 2);
                L.polyline(lines, {
                    color: ROUTE_CASING, weight: 9, opacity: 0.85,
                    lineJoin: 'round', lineCap: 'round',
                }).addTo(routeLayerRef.current);
                L.polyline(lines, {
                    color: C.route, weight: 5, opacity: 0.95,
                    lineJoin: 'round', lineCap: 'round',
                }).addTo(routeLayerRef.current);
                above.addTo(routeLayerRef.current);
                // Frame the route only when the destination itself changes,
                // never on GPS drift — the view must stay put while testing.
                // Deliberately not on free-roam either: re-framing on every
                // walked metre would yank the map out from under the
                // presenter mid-sentence.
                // Clamped: the route starts at the user, who may be outside
                // the archive footprint.
                if (prevDestRef.current !== destId) {
                    prevDestRef.current = destId;
                    fitInsideBox(L.latLngBounds(latlngs));
                }
            }
        } catch (err) {
            setError(err.message || 'Route failed');
        }
        // `weather.rain_multiplier` / `weather.raining_now` rather than the
        // whole object: a poll rebuilds it every 5 minutes, and the route
        // only cares about the two values that change routing.
    }, [destId, effectiveUser, nodes, borders, links, activeFloor, weather.rain_multiplier, weather.raining_now, heatClosed, buildings, buildingsById, bridges, pathways, routeShade, closedKey, destClosed, loading]);

    // A destination on another floor is a normal case now (the route climbs
    // the linked stairs), so it is only dropped when the node itself is gone.
    useEffect(() => {
        if (!destId || showAR || loading) return;
        if (nodes.some((n) => String(n.id) === String(destId))) return;
        const destBuilding = parseBuildingDestination(destId);
        if (destBuilding !== null && buildingsById.has(destBuilding)) return;
        setDestId('');
        prevDestRef.current = null;
        setRoute(null);
        setNoRoute(null);
        routeLayerRef.current?.clearLayers();
    }, [destId, nodes, showAR, loading, buildingsById]);

    // While the 3D view is open, keep feeding it the live route: the route
    // recomputes on every GPS fix, and the 3D view must never show a stale
    // path (that is exactly the "2D and 3D disagree" bug).
    useEffect(() => {
        if (showAR && route) setArRoute(route);
    }, [showAR, route]);

    // Desktop free-roam reports its walked position here (null when it is
    // off). Stored rather than applied straight into `userLocation`, so the
    // real GPS fix / test pin survives untouched and comes back the moment
    // free-roam ends.
    const handleWalkedPosition = (fix) => setWalkedPos(fix);

    // Overlay helpers. The node paints hidden first, then fades in, otherwise
    // the browser has nothing to transition from.
    const showScene = (kind) => {
        setSceneStep(0);
        setScene({ kind, show: false });
        requestAnimationFrame(() => requestAnimationFrame(() => setScene({ kind, show: true })));
        const steps = SCENE_COPY[kind].steps.length;
        for (let i = 1; i < steps; i += 1) later(() => setSceneStep(i), i * 450);
    };
    const hideScene = () => {
        setScene((sc) => (sc ? { ...sc, show: false } : sc));
        later(() => setScene(null), 500);
    };

    // Zoom the map *into* the user's actual screen position, not just around
    // a transform origin. A pure scale kept an off-centre marker off-centre
    // and could make it appear to slip away as the map enlarged. We compute
    // the translation for the final scale so the marker lands at the viewport
    // centre throughout the push-in. The campus bounds remain unchanged.
    const aimPushIn = () => {
        const wrap = mapWrapRef.current;
        const map = mapInstance.current;
        if (!wrap || !map || !userLocation
            || !Number.isFinite(userLocation.latitude)
            || !Number.isFinite(userLocation.longitude)) return;

        // Finish the launch fly-to before measuring the exact rendered point.
        map.stop();
        const rect = wrap.getBoundingClientRect();
        const point = map.latLngToContainerPoint([userLocation.latitude, userLocation.longitude]);
        const x = Number.isFinite(point?.x) ? point.x : rect.width / 2;
        const y = Number.isFinite(point?.y) ? point.y : rect.height / 2;
        const scale = 4.2;

        wrap.style.transformOrigin = '0 0';
        wrap.style.setProperty('--mnav-push-x', `${rect.width / 2 - scale * x}px`);
        wrap.style.setProperty('--mnav-push-y', `${rect.height / 2 - scale * y}px`);
        wrap.style.setProperty('--mnav-push-scale', String(scale));
    };

    // Staged launch into the 3D view:
    //   0 ms     button shows Loading, the map glides under the fix
    //   650 ms   panels slide away, the map zooms into the dot, the overlay
    //            ("Loading into AR View") fades in over it
    //   1300 ms  the AR view mounts behind the overlay
    //   1900 ms  the overlay fades out onto the camera screen
    // Coming back reverses it with a shorter "Back to the 2D map" overlay.
    const launch3D = () => {
        if (!route || !userLocation || leaving || launching || showAR) return;
        if (isVisitor) logVisit('route.3d', route.path?.[route.path.length - 1]?.name);
        // Fresh local trail for every 3D session.
        try { sessionStorage.removeItem('ar-cam-log'); } catch { /* private mode */ }
        setLaunching(true);
        const map = mapInstance.current;
        if (map && Number.isFinite(userLocation.latitude) && Number.isFinite(userLocation.longitude)) {
            try {
                map.flyTo([userLocation.latitude, userLocation.longitude], CAMPUS_MAX_ZOOM, { duration: 0.6 });
            } catch { /* map not ready, skip the glide */ }
        }
        later(() => { aimPushIn(); setLeaving(true); showScene('enter'); }, 650);
        later(() => {
            setArRoute(route);
            setArKey((k) => k + 1);
            setShowAR(true);
        }, 1300);
        later(hideScene, 1900);
    };

    const exitingRef = useRef(false);
    const exit3D = () => {
        if (exitingRef.current) return;
        exitingRef.current = true;
        showScene('exit');
        later(() => {
            setShowAR(false);
            setArRoute(null);
            // Reverses the leaving transition so the 2D screen zooms back out.
            setLeaving(false);
            setLaunching(false);
            exitingRef.current = false;
        }, 380);
        later(hideScene, 900);
    };

    const toggleTestMode = () => {
        const next = !testMode;
        setTestMode(next);
        testLocRef.current = next;
        // Entering or leaving the manual pin: the filter's history belongs to
        // the other mode, so start clean.
        gpsPipelineRef.current.reset();
    };

    // ── QR code at a room / stair / door (indoor positioning) ─────────
    // /map?at=<node id>: the phone's camera app opened a printed code. The
    // position and floor become that spot, held like a placed pin (GPS indoors
    // would only pull it away); "Use GPS" goes back to live GPS.
    const qrHandledRef = useRef(false);
    // Where the last QR code put you ({ name, place }), shown in the footer until you move the pin or use GPS.
    const [qrSpot, setQrSpot] = useState(null);
    useEffect(() => {
        if (qrHandledRef.current || loading) return;
        const id = qrNodeIdFrom(typeof window !== 'undefined' ? window.location.search : '');
        if (id === null) return;
        qrHandledRef.current = true;
        // Drop ?at= from the address so a reload does not jump back here.
        try {
            const url = new URL(window.location.href);
            url.searchParams.delete(QR_PARAM);
            window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
        } catch { /* history unavailable */ }
        if (isVisitor) {
            setNoticePill({ text: 'Sign in to use this QR code: it sets your position on the full campus map.', tone: 'attention', key: `qr:${id}` });
            return;
        }
        const spot = nodes.find((n) => Number(n.id) === id);
        if (!spot) {
            setNoticePill({ text: 'This QR code points to a spot that is no longer on the map. Ask the admin office for a new one.', tone: 'attention', key: `qr:${id}` });
            return;
        }
        testLocRef.current = true;
        gpsPipelineRef.current.reset();
        setTestMode(true);
        setFloor(floorOf(spot));
        adoptLocation({ latitude: Number(spot.latitude), longitude: Number(spot.longitude), accuracy: 1, source: 'qr' });
        // After the first layout pass, so the initial campus framing does not undo it.
        window.setTimeout(() => {
            mapInstance.current?.setView([Number(spot.latitude), Number(spot.longitude)], Math.max(mapInstance.current.getZoom(), 19));
        }, 450);
        const b = spot.building_id != null ? buildingsById.get(spot.building_id) : null;
        setQrSpot({
            name: spot.name || (spot.type === 'route' ? 'a marked spot' : 'this place'),
            place: [b ? (b.short_name || b.name) : null, floorAria(floorOf(spot))].filter(Boolean).join(' · '),
        });
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [loading, nodes, isVisitor]);

    // "Use my location": leave manual mode and recenter on the next fresh
    // GPS fix (the stale manual pin must not survive into GPS mode).
    const useMyLocation = () => {
        if (!navigator.geolocation) return;
        testLocRef.current = false;
        gpsPipelineRef.current.reset();
        setTestMode(false);
        relocateRef.current = true;
        relocateAtRef.current = Date.now();
        setWaitingGps(true);
        setGpsNote(null);
    };

    // Manual Retry GPS: fresh watch stream + relaxed patience, for when the
    // provider went silent (or permission was just granted in Settings).
    const retryGps = () => {
        setError(null);
        setGpsNote(null);
        autoRetryRef.current = 0;
        startWatch();
    };

    // Footer readout: one small label, one headline value, one quiet meta
    // line. The headline is what the walker needs right now — the distance
    // to go while a route is live, otherwise the next thing to do.
    const destName = destId
        ? (nodes.find((n) => String(n.id) === String(destId))?.name
            || buildingsById.get(parseBuildingDestination(destId))?.name || null)
        : null;
    // kind picks the icon and colour of the footer's status tile.
    const status = loading
        ? { kind: 'busy', value: 'Loading the map', meta: 'Campus places and routes' }
        : waitingGps
            ? { kind: 'busy', value: 'Finding your position', meta: 'This takes a few seconds outdoors' }
            : testMode && userLocation
                ? (userLocation.source === 'qr' && qrSpot
                    ? { kind: 'pin', label: 'Set by QR code', value: `At ${qrSpot.name}`, meta: `${qrSpot.place}. Choose where to go.` }
                    : { kind: 'pin', value: 'Your pin', meta: 'Tap the map where you are standing' })
                : route
                    ? { kind: 'route', label: destName ? `To ${destName}` : 'Route', value: formatDistance(route.total_distance_meters), meta: `${formatWalkTime(route.total_distance_meters)}, ${route.node_count} stops` }
                    : userLocation && destId && noRoute
                        ? { kind: 'ready', label: destName ? `To ${destName}` : 'Route', value: 'No route from here', meta: noRoute }
                    : userLocation
                        ? { kind: 'ready', value: isVisitor ? 'Your position' : 'Choose a destination', meta: `GPS accurate to about ${Math.round(userLocation.accuracy || 0)} m` }
                        : { kind: 'nogps', value: 'Waiting for GPS', meta: 'Retry GPS, or place your pin on the map' };
    // A live route is the screen's headline number — same green as the 3D
    // destination beacon. Everything else stays neutral.
    const statusHot = Boolean(route) && !testMode;

    // Every destination on every floor, nearest floor first. A destination on
    // another floor is routed through the linked staircases, and picking one
    // asks which floor the student is on.
    // Whole buildings come first (most people look for "CCS" before a room in
    // it); rooms and other places follow, labelled with their building.
    const destinations = useMemo(
        () => [
            ...routableBuildings(buildings).map(buildingDestination)
                .sort((x, y) => String(x.name).localeCompare(String(y.name))),
            ...nodes
                .filter((n) => n.type === 'location')
                .sort((x, y) => String(x.name || '').localeCompare(String(y.name || ''))),
        ],
        [nodes, buildings],
    );
    /** The building label shown under a place: its map label, else its name; '' outside buildings. */
    const buildingLabelOf = (d) => {
        const b = d?.building_id != null ? buildingsById.get(d.building_id) : null;
        return b ? (b.short_name || b.name) : '';
    };
    // The campus a place is on: the campus area its building (or itself) sits in.
    // Key: the area id as a string, or 'none' outside every area.
    const campusKeyOf = (d) => {
        const area = d?.is_building
            ? buildingArea(buildingsById.get(d.building_id), campusAreas)
            : nodeArea(d, campusAreas);
        return area ? String(area.id) : 'none';
    };
    const campusNameOf = (key) => campusAreas.find((a) => String(a.id) === key)?.name || 'Elsewhere on campus';
    // One campus key per place, worked out once per data change.
    const destinationCampus = useMemo(() => {
        const m = new Map();
        for (const d of destinations) m.set(d.id, campusKeyOf(d));
        return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [destinations, campusAreas, buildingsById]);
    const campusOf = (d) => destinationCampus.get(d.id) || 'none';
    // Chips: every campus area with places, then "Elsewhere" when some places sit outside them all.
    const campusChoices = useMemo(() => {
        const counts = new Map();
        for (const key of destinationCampus.values()) counts.set(key, (counts.get(key) || 0) + 1);
        const list = campusAreas
            .filter((a) => counts.get(String(a.id)))
            .map((a) => ({ key: String(a.id), label: a.name, count: counts.get(String(a.id)) }));
        if (counts.get('none')) list.push({ key: 'none', label: 'Elsewhere', count: counts.get('none') });
        return list;
    }, [destinationCampus, campusAreas]);
    // Search matches the name, the campus name, the building and the floor, so
    // typing "campus b", "ccs" or "gym" all narrow the list. Every word typed
    // must match somewhere. The campus chips filter first.
    const filteredDestinations = useMemo(() => {
        const words = destQuery.trim().toLowerCase().split(/\s+/).filter(Boolean);
        const byCampus = campusFilter === 'all' ? destinations : destinations.filter((d) => campusOf(d) === campusFilter);
        if (!words.length) return byCampus;
        return byCampus.filter((d) => {
            const b = d.building_id != null ? buildingsById.get(d.building_id) : null;
            const hay = `${d.name || ''} ${campusNameOf(campusOf(d))} ${floorAria(floorOf(d))} floor ${floorOf(d)} ${b ? `${b.name} ${b.short_name || ''}` : ''}`.toLowerCase();
            return words.every((w) => hay.includes(w));
        });
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [destinations, destQuery, buildingsById, campusFilter, destinationCampus]);
    // Under "All", places are grouped by campus; a single campus is one group.
    const destinationGroups = useMemo(() => {
        const groups = [];
        for (const c of campusChoices) {
            const items = filteredDestinations.filter((d) => campusOf(d) === c.key);
            if (items.length) groups.push({ key: c.key, label: c.key === 'none' ? 'Elsewhere on campus' : c.label, items });
        }
        if (!groups.length && filteredDestinations.length) groups.push({ key: 'all', label: '', items: filteredDestinations });
        return groups;
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [filteredDestinations, campusChoices]);
    const showCampusChips = campusChoices.length >= 2;
    // A campus chip also frames that campus on the map.
    const pickCampus = (key) => {
        setCampusFilter(key);
        const area = campusAreas.find((a) => String(a.id) === key);
        if (area && mapInstance.current) {
            mapInstance.current.fitBounds(L.latLngBounds(area.polygon.map((q) => [q.lat, q.lng])), { padding: [30, 30], maxZoom: 19 });
        }
    };
    // The chosen campus can disappear (outline removed): fall back to All.
    useEffect(() => {
        if (campusFilter !== 'all' && !campusChoices.some((c) => c.key === campusFilter)) setCampusFilter('all');
    }, [campusChoices, campusFilter]);
    const selectedDest = destinations.find((d) => String(d.id) === String(destId)) || null;
    const selectedDestName = selectedDest?.name || (destId ? `Location ${destId}` : '');
    const focusDestOption = (index) => {
        const options = Array.from(destinationMenuRef.current?.querySelectorAll('[role="option"]') || []);
        if (!options.length) return;
        if (index < 0) { destinationTriggerRef.current?.focus(); return; }
        options[Math.min(index, options.length - 1)]?.focus();
    };
    // Cancel the destination: the route, its line and the stairs panel go away.
    const clearDestination = () => {
        setDestId('');
        setDestQuery('');
        setFloorPrompt(null);
        setRoute(null);
        setNoRoute(null);
        setRouteModelOpen(false);
        prevDestRef.current = null;
        routeLayerRef.current?.clearLayers();
        setDestinationOpen(false);
    };
    const chooseDestination = (d) => {
        if (isVisitor) logVisit('route.chosen', d.name || d.short_name);
        setDestId(String(d.id));
        setDestinationOpen(false);
        // Different floor than the one shown: ask where the student is (a
        // whole building is entered at ground level, so never for those).
        setFloorPrompt(!d.is_building && userBuilding && floorOf(d) !== activeFloor ? { destId: String(d.id), destFloor: floorOf(d) } : null);
    };
    // "Go" buttons in a building's popup (Leaflet HTML, so a window hook).
    useEffect(() => {
        window.__mnavGoTo = (id) => {
            const d = destinations.find((n) => String(n.id) === String(id));
            if (!d) return;
            mapInstance.current?.closePopup();
            chooseDestination(d);
        };
        return () => { delete window.__mnavGoTo; };
    });
    // The first staircase this route takes from the floor being shown.
    const stairHint = route?.stairs?.find((st) => st.from_floor === activeFloor) || null;

    // NOTE: AR renders as an overlay, never as a replacement for this tree.
    // Swapping the tree would unmount the Leaflet container while the map
    // instance stays bound to the detached node — coming back would then
    // show a black, empty div because init never re-runs.
    return (
        <div className="mnav-root" role="main" data-picker-open={destinationOpen ? 'true' : undefined} style={{ height: '100%', display: 'flex', flexDirection: 'column', background: C.page, color: C.text }}>
            {/* Campus closed: nothing on the map can be used until it opens (students and visitors alike).
                Its own styles: it covers the page before the map's style sheet below has loaded. */}
            {campusClosedNow && (
                <div className="mnav-closed" role="alertdialog" aria-modal="true" aria-labelledby="mnav-closed-title" aria-describedby="mnav-closed-text">
                    <style>{`
                        .mnav-closed { position: fixed; inset: 0; z-index: 20000; display: flex; align-items: center; justify-content: center;
                            padding: 24px max(20px, env(safe-area-inset-right)) 24px max(20px, env(safe-area-inset-left));
                            background: ${C.page}; color: ${C.text}; text-align: center; animation: mnavClosedIn 0.45s ease both; }
                        .mnav-closed-card { display: flex; flex-direction: column; align-items: center; gap: 12px; width: 100%; max-width: 380px; }
                        .mnav-closed-moon { display: grid; place-items: center; width: 88px; height: 88px; margin-bottom: 6px; border-radius: 50%;
                            color: ${C.warning}; background: rgba(251, 191, 36, 0.08); border: 1px solid rgba(251, 191, 36, 0.22);
                            box-shadow: 0 0 0 10px rgba(251, 191, 36, 0.04); }
                        .mnav-closed h1 { margin: 0; font-size: 26px; font-weight: 800; letter-spacing: -0.01em; color: ${C.white}; }
                        .mnav-closed p { margin: 0; max-width: 32ch; font-size: ${TYPE.sub}; line-height: 1.55; color: ${C.muted}; }
                        .mnav-closed-hours { display: flex; gap: 8px; margin-top: 6px; }
                        .mnav-closed-chip { display: flex; flex-direction: column; gap: 2px; min-width: 104px; padding: 10px 14px; border-radius: 14px;
                            background: rgba(255, 255, 255, 0.04); border: 1px solid ${C.hairline}; }
                        .mnav-closed-chip small { font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: ${C.muted}; }
                        .mnav-closed-chip b { font-size: 18px; font-weight: 800; color: ${C.white}; }
                        .mnav-closed-demo { margin-top: 14px; min-height: ${TAP.minHeight}; padding: 0 20px; border-radius: 999px; cursor: pointer;
                            border: 1px solid ${C.border}; background: rgba(255, 255, 255, 0.05); color: ${C.text};
                            font: inherit; font-size: ${TYPE.desc}; font-weight: 700; transition: background-color 160ms ease, border-color 160ms ease; }
                        .mnav-closed-demo:hover { background: rgba(255, 255, 255, 0.1); border-color: rgba(255, 255, 255, 0.25); }
                        .mnav-closed-demo:focus-visible { outline: ${TAP.focusOutline}; outline-offset: 2px; }
                        @keyframes mnavClosedIn { from { opacity: 0; transform: translateY(8px); } }
                        @media (prefers-reduced-motion: reduce) { .mnav-closed { animation: none; } }
                    `}</style>
                    <div className="mnav-closed-card">
                        <div className="mnav-closed-moon" aria-hidden="true">
                            <svg width="40" height="40" viewBox="0 0 24 24" fill="none">
                                <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
                            </svg>
                        </div>
                        <h1 id="mnav-closed-title">The campus is closed</h1>
                        <p id="mnav-closed-text">The campus map can be used while the campus is open. Come back at {campusClosedNow.opens}.</p>
                        <div className="mnav-closed-hours">
                            <span className="mnav-closed-chip"><small>Opens</small><b>{campusClosedNow.opens}</b></span>
                            <span className="mnav-closed-chip"><small>Closes</small><b>{campusClosedNow.closes}</b></span>
                        </div>
                        {SHOW_DEMO && (
                            <button type="button" className="mnav-closed-demo" onClick={() => setCampusDemo(campusDemo === 'closed' ? 'clock' : 'open')}>
                                {campusDemo === 'closed' ? 'Demo: back to the clock' : 'Demo: open the map anyway'}
                            </button>
                        )}
                    </div>
                </div>
            )}
            <h1 className="sr-only">Campus navigation</h1>
            <style>{`
                ${HUD_CSS}
                .mnav-root { height: 100%; height: 100dvh; overflow: hidden; }
                .mnav-root, .mnav-root *, .mnav-root *::before, .mnav-root *::after { box-sizing: border-box; }
                /* Scene change into 3D. The AR overlay mounts beside the 2D
                   stage, never inside it, so fading this tree can't hide the
                   3D view. Panels slide off, the map zooms into the dot,
                   then the full-screen overlay takes over. transform and
                   opacity only. */
                .mnav-root { --e-out: cubic-bezier(0.16, 1, 0.3, 1); --e-io: cubic-bezier(0.65, 0, 0.35, 1); }
                .mnav-stage { display: flex; flex-direction: column; flex: 1; min-height: 0; overflow: hidden; }
                .mnav-mapwrap { flex: 1; min-height: 0; position: relative; transform-origin: 0 0; transition: transform 0.9s var(--e-io), opacity 0.45s ease-in 0.35s; }
                .mnav-header, .mnav-footer { transition: opacity 0.35s var(--e-out), transform 0.5s var(--e-out); }
                .mnav-leaving .mnav-header { opacity: 0; transform: translateY(-16px); }
                .mnav-leaving .mnav-footer { opacity: 0; transform: translateY(16px); }
                .mnav-leaving .mnav-mapwrap { transform: translate(var(--mnav-push-x, 0px), var(--mnav-push-y, 0px)) scale(var(--mnav-push-scale, 4.2)); opacity: 0; }

                /* Hand-off overlay: solid page colour, route line, title, status. */
                .scene {
                    position: fixed; inset: 0; z-index: 6000; display: flex; align-items: center; justify-content: center;
                    background: ${C.page}; opacity: 0; pointer-events: none;
                    transition: opacity 0.4s ease;
                }
                .scene[data-show="true"] { opacity: 1; pointer-events: auto; }
                .scene-box { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 24px; text-align: center; }
                .scene-art { width: 168px; height: 112px; margin-bottom: 8px; }
                .scene-path { stroke-dasharray: 1; stroke-dashoffset: 1; animation: sceneDraw 1.1s var(--e-io) 0.15s forwards; }
                .scene-dest { transform-box: fill-box; transform-origin: center; animation: scenePop 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) 1s both; }
                .scene-ring { opacity: 0; transform-box: fill-box; transform-origin: center; animation: sceneRing 1.6s var(--e-out) 1.1s infinite; }
                .scene-title { font-size: ${TYPE.title}; font-weight: 800; letter-spacing: -0.01em; color: ${C.white}; animation: sceneRise 0.6s var(--e-out) 0.1s both; }
                .scene-step { min-height: 20px; font-size: ${TYPE.sub}; color: ${C.muted}; animation: sceneRise 0.4s var(--e-out) both; }
                .scene-rail { width: 160px; height: 3px; margin-top: 6px; border-radius: 2px; overflow: hidden; background: rgba(255, 255, 255, 0.10); }
                .scene-rail i { display: block; height: 100%; background: ${C.primary}; transform-origin: left; transform: scaleX(0); animation: sceneRail 1.7s var(--e-io) 0.1s forwards; }
                @keyframes sceneDraw { to { stroke-dashoffset: 0; } }
                @keyframes scenePop { from { opacity: 0; transform: scale(0.5); } }
                @keyframes sceneRing { 0% { transform: scale(0.8); opacity: 0.8; } 100% { transform: scale(2.2); opacity: 0; } }
                @keyframes sceneRise { from { opacity: 0; transform: translateY(10px); } }
                @keyframes sceneRail { to { transform: scaleX(1); } }
                .mbtn-spin { width: 14px; height: 14px; flex: none; border-radius: 50%; border: 2px solid rgba(255, 255, 255, 0.35); border-top-color: #fff; animation: mbtnSpin 0.7s linear infinite; }
                @keyframes mbtnSpin { to { transform: rotate(360deg); } }
                @media (prefers-reduced-motion: reduce) {
                    .mnav-mapwrap, .mnav-header, .mnav-footer, .scene,
                    .mnav-select, .mnav-destination-mark, .mnav-destination-chevron,
                    .mnav-destination-menu, .mnav-destination-option,
                    .mnav-destination-index, .mnav-destination-check,
                    .mnav-floor-chip { transition: none !important; }
                    .mnav-destination-option { animation: none !important; }
                    .mnav-leaving .mnav-mapwrap { transform: none; }
                    .scene-path, .scene-dest, .scene-ring, .scene-title, .scene-step, .scene-rail i { animation: none; }
                    .scene-path { stroke-dashoffset: 0; }
                    .scene-rail i { transform: scaleX(1); }
                    .mbtn-spin { animation-duration: 2s; }
                }
                /* Header and footer are floating glass cards, not full-bleed
                   bars — the same panel shape the 3D screen uses, so both
                   screens read as one HUD. */
                .mnav-announce {
                    position: relative; z-index: 1099; flex: 0 0 auto;
                    margin: 8px max(10px, env(safe-area-inset-right)) 0 max(10px, env(safe-area-inset-left));
                    padding: 8px 12px; border-radius: ${PANEL_RADIUS}px;
                    background: ${C.glass}; -webkit-backdrop-filter: blur(18px); backdrop-filter: blur(18px);
                    border: 1px solid rgba(251, 191, 36, 0.45); box-shadow: 0 10px 30px rgba(0, 0, 0, 0.4);
                    animation: mnavNoticeIn 0.3s var(--e-out) both;
                }
                .mnav-announce p { margin: 0; display: flex; align-items: flex-start; gap: 8px; color: ${C.white}; font-size: ${TYPE.desc}; font-weight: 600; line-height: 1.35; }
                .mnav-announce p + p { margin-top: 6px; }
                .mnav-announce svg { flex: none; margin-top: 1px; color: ${C.warning}; }
                .mnav-header {
                    position: relative; z-index: 1100;
                    display: flex; align-items: center; gap: 8px; flex: 0 0 auto; min-width: 0;
                    background: ${C.glass};
                    -webkit-backdrop-filter: blur(18px) saturate(140%);
                    backdrop-filter: blur(18px) saturate(140%);
                    border: 1px solid rgba(255, 255, 255, 0.07);
                    border-radius: ${PANEL_RADIUS}px;
                    /* The card itself clears the notch — padding belongs to the
                       card's content, not to the screen edge. */
                    margin: max(10px, env(safe-area-inset-top)) max(10px, env(safe-area-inset-right)) 0 max(10px, env(safe-area-inset-left));
                    padding: 8px;
                    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
                }
                /* Footer: one row. Status tile, what is happening (one headline
                   and one quiet line), then the actions as one button group,
                   the same look as the route panel and Map / Satellite. */
                .mnav-footer { display: flex; align-items: center; gap: 12px; }
                .mnav-foot-icon { flex: none; display: grid; place-items: center; width: 40px; height: 40px; border-radius: 12px;
                    background: rgba(255,255,255,0.06); color: ${C.text}; }
                .mnav-foot-icon[data-kind="route"], .mnav-foot-icon[data-kind="ready"] { background: rgba(74, 222, 128, 0.14); color: #4ade80; }
                .mnav-foot-icon[data-kind="pin"], .mnav-foot-icon[data-kind="nogps"] { background: rgba(255, 176, 46, 0.14); color: ${C.warning}; }
                .mnav-foot-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
                .mnav-foot-label { font-size: ${TYPE.desc}; font-weight: 600; color: ${C.accent}; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
                .mnav-foot-value { font-size: ${TYPE.sub}; font-weight: 700; color: ${C.white}; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
                .mnav-foot-value.is-hot { font-size: 22px; font-weight: 800; line-height: 1.15; font-variant-numeric: tabular-nums; }
                .mnav-foot-meta { font-size: ${TYPE.desc}; color: ${C.muted}; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
                .mnav-foot-note { font-size: ${TYPE.desc}; color: ${C.warning}; line-height: 1.4; }
                .mnav-foot-actions { flex: none; display: flex; gap: 3px; padding: 3px; border-radius: ${PILL}px; background: rgba(255,255,255,0.06); }
                .mnav-foot-btn { min-height: ${TAP.minHeight}; padding: 0 16px; border: 0; border-radius: ${PILL}px; background: transparent; color: ${C.text};
                    font: inherit; font-size: 13px; font-weight: 700; white-space: nowrap; cursor: pointer;
                    transition: background-color 160ms ease, color 160ms ease, transform 160ms ease; }
                .mnav-foot-btn:hover { background: rgba(255,255,255,0.08); color: #fff; }
                .mnav-foot-btn:active { transform: scale(${TAP.activeScale}); }
                .mnav-foot-btn:focus-visible { outline: ${TAP.focusOutline}; outline-offset: 2px; }
                .mnav-foot-btn.is-primary { background: ${C.primary}; color: #fff; }
                .mnav-foot-btn.is-on { background: rgba(255, 176, 46, 0.18); color: #ffd9a0; }
                @media (max-width: 520px) {
                    .mnav-footer { flex-wrap: wrap; gap: 10px; }
                    .mnav-foot-text { flex: 1 1 calc(100% - 52px); }
                    .mnav-foot-actions { flex: 1 1 100%; }
                    .mnav-foot-btn { flex: 1 1 0; min-height: ${TAP.minHeight}; }
                }
                @media (prefers-reduced-motion: reduce) { .mnav-foot-btn:active { transform: none; } }
                .mnav-footer {
                    flex: 0 0 auto; min-width: 0;
                    background: ${C.glass};
                    -webkit-backdrop-filter: blur(18px) saturate(140%);
                    backdrop-filter: blur(18px) saturate(140%);
                    border: 1px solid rgba(255, 255, 255, 0.07);
                    border-radius: ${PANEL_RADIUS}px;
                    margin: 0 max(10px, env(safe-area-inset-right)) max(10px, env(safe-area-inset-bottom)) max(10px, env(safe-area-inset-left));
                    padding: 10px 12px;
                    box-shadow: 0 -10px 30px rgba(0, 0, 0, 0.5);
                }
                /* Floor picker: a compact glass elevator panel over the map.
                   Chips stay ≥36px so they clear the touch-target minimum. */
                .mnav-floor {
                    position: absolute; left: 12px; bottom: 12px; z-index: 1000;
                    display: flex; align-items: center; gap: 4px;
                    max-width: calc(100% - 24px);
                    padding: 4px; border-radius: 12px;
                    background: rgba(12, 12, 16, 0.86);
                    -webkit-backdrop-filter: blur(14px) saturate(140%);
                    backdrop-filter: blur(14px) saturate(140%);
                    border: 1px solid rgba(255, 255, 255, 0.10);
                    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.45);
                    overflow-x: auto; scrollbar-width: none;
                }
                .mnav-floor::-webkit-scrollbar { display: none; }
                .mnav-destination-floor { flex: none; margin-left: auto; padding: 1px 8px; border-radius: 6px; background: rgba(255,255,255,0.08); color: ${C.muted}; font-size: ${TYPE.desc}; font-weight: 600; white-space: nowrap; }
                /* Stair tag: the building-label chip (dark glass, one line) with
                   an amber stairs icon, just above the foot of the stairs. */
                .mnav-stair-tag {
                    transform: translate(-50%, calc(-100% - 10px)); display: inline-flex; align-items: center; gap: 7px;
                    padding: 3px 10px 3px 3px; border-radius: 6px; white-space: nowrap; pointer-events: none;
                    background: rgba(16, 16, 20, 0.88); border: 1px solid rgba(255, 176, 46, 0.6); color: #fff;
                    box-shadow: 0 2px 10px rgba(0,0,0,0.4); font-size: 12px; line-height: 1.2;
                }
                .mnav-stair-icon { display: grid; place-items: center; width: 22px; height: 22px; border-radius: 50%; background: #ffb02e; color: #1a1200; }
                .mnav-stair-main { font-weight: 800; }
                .mnav-stair-sub { font-weight: 500; color: rgba(255,255,255,0.65); }
                .mnav-floorask { position: absolute; inset: 0; z-index: 1500; display: grid; place-items: end center; padding: 12px; background: rgba(0,0,0,0.45); }
                .mnav-floorask-card { width: min(380px, 100%); display: flex; flex-direction: column; gap: 10px; padding: 16px; border-radius: ${PANEL_RADIUS}px; background: rgba(12,12,16,0.96); border: 1px solid ${C.hairline}; box-shadow: 0 16px 40px rgba(0,0,0,0.55); }
                .mnav-floorask-title { margin: 0; font-size: ${TYPE.title}; font-weight: 800; color: #fff; }
                .mnav-floorask-text { margin: 0; font-size: ${TYPE.sub}; color: ${C.muted}; line-height: 1.4; }
                .mnav-floorask-chips { display: flex; flex-wrap: wrap; gap: 6px; }
                .mnav-floorask-chips .mnav-floor-chip { min-width: 48px; height: 48px; font-size: 16px; border-color: ${C.hairline}; }
                .mnav-floor-chip {
                    flex: 0 0 auto; min-width: 36px; height: 36px; padding: 0 9px;
                    display: grid; place-items: center;
                    border-radius: 9px; border: 1px solid transparent;
                    background: transparent; color: ${C.muted};
                    font-family: inherit; font-size: 13px; font-weight: 800;
                    font-variant-numeric: tabular-nums; letter-spacing: 0.02em;
                    cursor: pointer;
                    transition: color 160ms ease, background-color 160ms ease, border-color 160ms ease;
                    touch-action: manipulation;
                }
                .mnav-floor-chip:hover { color: ${C.white}; background: rgba(255, 255, 255, 0.07); }
                .mnav-floor-chip:active { transform: scale(${TAP.activeScale}); }
                .mnav-floor-chip:focus-visible { outline: ${TAP.focusOutline}; outline-offset: 2px; }
                .mnav-floor-chip.is-active {
                    color: ${C.white}; background: ${C.primary};
                    border-color: rgba(74, 222, 128, 0.75);
                }
                /* Shared tap states — identical to the 3D view's .ar-btn. */
                .mbtn { ${btnBase} }
                .mbtn:hover { filter: brightness(1.12); }
                .mbtn:active { transform: scale(${TAP.activeScale}); }
                .mbtn:focus-visible { outline: ${TAP.focusOutline}; outline-offset: 2px; }
                .mbtn:disabled { opacity: ${TAP.disabledOpacity}; cursor: not-allowed; transform: none !important; }
                .mbtn[aria-busy="true"]:disabled { opacity: 1; cursor: progress; }
                .mbtn-gps { background: rgba(74, 222, 128, 0.16) !important; border: 1px solid rgba(74, 222, 128, 0.65) !important; color: #d1fae5 !important; }
                .mbtn-gps:active { background: rgba(21, 128, 61, 0.38) !important; }
                /* Leaflet zoom control: shared with the admin map. */
                ${MAP_ZOOM_CSS}
                .leaflet-container { background: ${C.page} !important; }
                .leaflet-container a { color: ${C.accent} !important; }
                .leaflet-popup-content-wrapper {
                    background: rgba(12, 12, 16, 0.96); color: #fff;
                    border: 1px solid rgba(34, 197, 94, 0.30);
                    border-radius: ${PANEL_RADIUS}px; box-shadow: ${ELEVATION.overlay};
                }
                .leaflet-popup-tip { background: rgba(12, 12, 16, 0.96); box-shadow: none; }
                @keyframes mnavNoticeIn { from { opacity: 0; transform: translateY(-6px); } }

                /* Visitor header: what this view is, and the way to the full map. */
                .mnav-visitor { display: flex; align-items: center; gap: 12px; animation: mnavNoticeIn var(--dur-base) var(--ease-out) both; }
                .mnav-visitor-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
                .mnav-visitor-title { font-size: ${TYPE.lead}; font-weight: 700; color: ${C.white}; }
                .mnav-visitor-sub { font-size: ${TYPE.desc}; line-height: 1.4; color: ${C.muted}; }
                .mnav-visitor-btn {
                    flex: none; min-height: ${TAP.minHeight}; padding: 0 20px !important; border-radius: ${PILL}px;
                    background: ${C.primary}; color: #fff; border: 0; font: inherit; font-size: ${TYPE.sub}; font-weight: 700;
                }
                .mnav-visitor-btn:hover { background: ${C.primaryHover}; }
                .mnav-account { margin-left: auto; }
                /* Visitor popup: just the name and floors, no divider under it. */
                .bp-head.is-plain { padding-bottom: 0; border-bottom: 0; }

                /* Building popup: name + floors, then what is inside, each with Go. */
                .bp { min-width: 220px; max-width: 280px; }
                .bp-head { display: flex; flex-direction: column; gap: 2px; padding-bottom: 8px; border-bottom: 1px solid ${C.hairline}; }
                .bp-head-go { flex-direction: row; align-items: center; gap: 10px; }
                .bp-head-go .bp-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
                .bp-head-go .bp-text b { font-size: ${TYPE.lead}; color: ${C.white}; }
                .bp-head b { font-size: ${TYPE.lead}; color: ${C.white}; }
                .bp-head small, .bp-text small { font-size: ${TYPE.desc}; color: ${C.muted}; }
                .bp-text small.bp-closed, .bp-text .bp-closed { color: ${C.warning}; }
                .bp-list { list-style: none; margin: 6px 0 0; padding: 0 4px 0 0; }
                ${LIST_CSS}
                ${INTERACTION_CSS}
                ${SATELLITE_CSS}
                .mnav-sat {
                    position: absolute; z-index: 1000; left: max(10px, env(safe-area-inset-left)); bottom: 10px;
                    width: min(200px, calc(100% - 20px)); padding: 6px; border-radius: ${PANEL_RADIUS}px;
                    background: ${C.glass}; border: 1px solid ${C.hairline}; box-shadow: ${ELEVATION.float};
                    -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px);
                }
                .mnav-sat .sat-row, .mnav-sat .sat-note { padding: 0 6px; }
                /* The floor picker owns the bottom-left corner: sit just above it. */
                .mnav-sat.above-floors { bottom: calc(12px + 54px + 8px); }
                /* Bottom centre: the weather pill, then the route tools, in one column. Desktop: between
                   the Map / Satellite panel (left) and the attribution (right). */
                .mnav-bottom-stack {
                    position: absolute; z-index: 1000; left: 50%; bottom: 10px; transform: translateX(-50%);
                    display: flex; flex-direction: column; align-items: center; gap: 8px;
                    width: max-content; max-width: min(640px, calc(100% - 460px)); pointer-events: none;
                }
                .mnav-bottom-stack > * { pointer-events: auto; }
                .mnav-bottom-stack .route-bar { position: static; transform: none; max-width: 100%; animation-name: mnavStackIn; }
                @keyframes mnavStackIn { from { opacity: 0; transform: translateY(10px); } }
                /* Phones: centred above the Map / Satellite panel (and the floor picker when shown). */
                @media (max-width: 900px) {
                    .mnav-bottom-stack { bottom: calc(10px + 66px + 8px); max-width: calc(100% - 20px); }
                    .mnav-bottom-stack.above-floors { bottom: calc(12px + 54px + 8px + 66px + 8px); }
                }
                /* Landscape phones: the map is short, so the stack sits bottom-right beside Map / Satellite. */
                @media (max-height: 520px) and (min-width: 560px) {
                    .mnav-bottom-stack { left: auto; right: 10px; bottom: 10px; transform: none; align-items: flex-end; max-width: calc(100% - 230px); }
                }
                /* Location pins are small on purpose; this invisible border makes them a 44 px touch target. */
                .pin-hit::after { content: ''; position: absolute; inset: -14px; }
                /* The photo's credit must stay readable while imagery shows. */
                .leaflet-control-attribution { font-size: 12px !important; }
                .bp-row { display: flex; align-items: center; gap: 10px; min-height: 44px; }
                .bp-row + .bp-row { border-top: 1px solid ${C.hairline}; }
                .bp-text { flex: 1; min-width: 0; display: flex; flex-direction: column; }
                .bp-text b { font-size: ${TYPE.sub}; color: ${C.text}; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
                .bp-go {
                    flex: none; min-width: 52px; min-height: 36px; padding: 0 14px; border: 0; border-radius: ${PILL}px;
                    background: ${C.primary}; color: #fff; font: inherit; font-size: 13px; font-weight: 700; cursor: pointer;
                    transition: background-color 0.2s ease, transform 0.2s ease;
                }
                .bp-go:hover { background: ${C.primaryHover}; }
                .bp-go:active { transform: scale(0.96); }
                .bp-go:focus-visible { outline: 2px solid ${C.focus}; outline-offset: 2px; }
                .bp-empty { padding: 8px 0 2px; font-size: ${TYPE.sub}; line-height: 1.4; color: ${C.white}; }
                .leaflet-popup-close-button { color: ${C.muted} !important; }
                .leaflet-control-attribution {
                    background: rgba(12, 12, 16, 0.72) !important;
                    color: ${C.muted} !important; font-size: 12px !important;
                }
                /* Narrow phones: the attribution (a licence requirement) wraps beside the
                   Map / Satellite panel instead of running under its opacity slider. */
                @media (max-width: 480px) {
                    .mnav-mapwrap .leaflet-control-attribution { max-width: calc(100vw - 230px); white-space: normal; text-align: right; }
                }
                /* Custom destination picker: animated panel and staggered rows
                   give the most-used control a little depth without slowing it down. */
                .mnav-destination { position: relative; z-index: 1; flex: 1 1 0; min-width: 0; }
                .mnav-destination.is-open { z-index: 1200; }
                /* Computers: keep the field (and the list that opens under it) a readable width, so the
                   map stays visible beside it; the 3D and menu buttons move to the right edge. */
                @media (min-width: 900px) { .mnav-destination { flex: 0 1 560px; margin-right: auto; } }
                .mnav-select {
                    width: 100%; min-width: 0; min-height: 54px; padding: 8px 12px;
                    display: flex; align-items: center; gap: 10px; text-align: left;
                    color: ${C.white}; background: ${C.field};
                    border: 1px solid ${C.fieldBorder}; border-radius: 12px;
                    cursor: pointer; touch-action: manipulation; -webkit-tap-highlight-color: transparent;
                    transition: background-color 0.18s ease, border-color 0.18s ease, box-shadow 0.22s ease, transform 0.18s ease;
                }
                .mnav-select:hover { background: ${C.surfaceHover}; border-color: rgba(255, 85, 102, 0.50); }
                .mnav-select:active { transform: scale(0.992); }
                .mnav-select[aria-expanded="true"] { border-color: rgba(255, 85, 102, 0.78); box-shadow: 0 0 0 3px rgba(255, 35, 56, 0.10); }
                .mnav-select:focus-visible { outline: ${TAP.focusOutline}; outline-offset: 2px; }
                .mnav-destination-mark {
                    width: 34px; height: 34px; flex: 0 0 34px; display: grid; place-items: center;
                    color: ${C.brandAccent}; background: rgba(255, 85, 102, 0.12);
                    border: 1px solid rgba(255, 85, 102, 0.24); border-radius: 10px;
                    transition: background-color 0.2s ease, transform 0.3s var(--e-out);
                }
                .mnav-select[aria-expanded="true"] .mnav-destination-mark { background: rgba(255, 85, 102, 0.20); transform: scale(1.04); }
                .mnav-destination-copy { display: flex; flex: 1; flex-direction: column; gap: 2px; min-width: 0; }
                .mnav-destination-eyebrow { color: ${C.muted}; font-size: ${TYPE.desc}; font-weight: 600; line-height: 1.1; letter-spacing: 0.01em; }
                .mnav-destination-name { overflow: hidden; color: ${C.white}; font-size: ${INPUT_TEXT}; font-weight: 700; line-height: 1.3; text-overflow: ellipsis; white-space: nowrap; }
                .mnav-select { cursor: text; }
                .mnav-destination.is-open .mnav-select, .mnav-select:focus-within { border-color: rgba(255, 85, 102, 0.78); box-shadow: 0 0 0 3px rgba(255, 35, 56, 0.10); }
                .mnav-destination.is-open .mnav-destination-mark { background: rgba(255, 85, 102, 0.20); transform: scale(1.04); }
                .mnav-destination.is-open .mnav-destination-chevron { color: ${C.brandAccent}; transform: rotate(180deg); }
                .mnav-destination-input {
                    width: 100%; min-width: 0; margin: 0; padding: 0; border: 0; outline: none; border-radius: 0;
                    background: transparent; color: ${C.white}; font: inherit; font-size: ${INPUT_TEXT}; font-weight: 700; line-height: 1.3;
                    text-overflow: ellipsis; -webkit-appearance: none; appearance: none;
                }
                .mnav-destination-input::placeholder { color: ${C.muted}; font-weight: 600; opacity: 1; }
                /* Cancel the chosen destination: a round x next to the chevron. */
                .mnav-destination-clear { flex: 0 0 auto; display: grid; place-items: center; width: 32px; height: 32px; margin: -6px 2px; padding: 0;
                    border: 0; border-radius: 50%; background: rgba(255,255,255,0.1); color: ${C.text}; cursor: pointer; touch-action: manipulation;
                    transition: background-color 160ms ease, transform 160ms ease; animation: uiFadeUp var(--dur-fast, 160ms) var(--ease-out, ease) both; }
                .mnav-destination-clear:hover { background: rgba(255,255,255,0.18); color: #fff; }
                .mnav-destination-clear:active { transform: scale(0.92); }
                .mnav-destination-clear:focus-visible { outline: ${TAP.focusOutline}; outline-offset: 2px; }
                @media (max-width: 640px), (pointer: coarse) { .mnav-destination-clear { width: ${TAP.minHeight}; height: ${TAP.minHeight}; margin: -12px 0; } }
                /* The open destination list sits under the notification pill's spot. */
                .mnav-root[data-picker-open="true"] .sync-pill-wrap { visibility: hidden; }
                .mnav-destination-chevron-btn { flex: 0 0 auto; display: grid; place-items: center; width: ${TAP.minHeight}; height: ${TAP.minHeight}; margin: -12px -12px -12px 0; padding: 0; border: 0; background: transparent; color: inherit; cursor: pointer; touch-action: manipulation; }
                .mnav-destination-chevron { width: 18px; height: 18px; flex: 0 0 18px; color: ${C.muted}; transition: transform 0.28s var(--e-out), color 0.2s ease; }
                .mnav-select[aria-expanded="true"] .mnav-destination-chevron { color: ${C.brandAccent}; transform: rotate(180deg); }
                .mnav-destination-menu {
                    position: absolute; top: calc(100% + 8px); left: 0; right: 0; z-index: 1300;
                    max-height: min(500px, 62dvh); overflow-x: hidden; overflow-y: auto; overscroll-behavior: contain;
                    padding: 7px; border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 14px;
                    background: rgba(15, 16, 21, 0.97); color: ${C.white};
                    box-shadow: 0 20px 48px rgba(0, 0, 0, 0.56), 0 4px 14px rgba(0, 0, 0, 0.28);
                    -webkit-backdrop-filter: blur(22px) saturate(140%); backdrop-filter: blur(22px) saturate(140%);
                    opacity: 0; visibility: hidden; pointer-events: none;
                    transform: translateY(-9px) scale(0.985); transform-origin: top center;
                    transition: opacity 180ms ease, transform 280ms var(--e-out), visibility 180ms linear;
                    scrollbar-width: thin; scrollbar-color: rgba(255, 85, 102, 0.55) rgba(255, 255, 255, 0.05);
                }
                .mnav-destination-menu[data-open="true"] { opacity: 1; visibility: visible; pointer-events: auto; transform: translateY(0) scale(1); }
                .mnav-destination-menu::-webkit-scrollbar { width: 5px; }
                .mnav-destination-menu::-webkit-scrollbar-track { background: rgba(255, 255, 255, 0.04); border-radius: 8px; }
                .mnav-destination-menu::-webkit-scrollbar-thumb { background: rgba(255, 85, 102, 0.5); border-radius: 8px; }
                .mnav-destination-menu-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 7px 9px 9px; color: ${C.muted}; font-size: ${TYPE.desc}; line-height: 1.2; font-weight: 600; letter-spacing: 0.01em; }
                .mnav-destination-count { padding: 3px 6px; border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 5px; background: rgba(255, 255, 255, 0.04); letter-spacing: 0.04em; white-space: nowrap; }
                .mnav-destination-option {
                    position: relative; width: 100%; min-height: 45px; padding: 7px 9px; margin: 0 0 3px;
                    display: grid; grid-template-columns: minmax(0, 1fr) auto 18px; align-items: center; gap: 10px;
                    border: 1px solid transparent; border-radius: 9px; text-align: left; color: ${C.text};
                    background: transparent; cursor: pointer; font: inherit;
                    animation: none;
                    transition: background-color 160ms ease, border-color 160ms ease, color 160ms ease, transform 160ms ease;
                }
                .mnav-destination-menu[data-open="true"] .mnav-destination-option { animation: mnav-option-enter 340ms var(--e-out) both; }
                .mnav-destination-option:last-child { margin-bottom: 0; }
                .mnav-destination-option:hover, .mnav-destination-option:focus-visible { outline: none; color: ${C.white}; background: rgba(255, 255, 255, 0.065); border-color: rgba(255, 255, 255, 0.08); }
                .mnav-destination-option:active { transform: scale(0.99); }
                .mnav-destination-option[aria-selected="true"] { color: ${C.white}; background: rgba(255, 35, 56, 0.13); border-color: rgba(255, 85, 102, 0.30); }
                .mnav-destination-index { width: 28px; height: 28px; display: grid; place-items: center; border-radius: 8px; color: ${C.muted}; background: rgba(255, 255, 255, 0.045); font-size: ${TYPE.desc}; font-weight: 700; font-variant-numeric: tabular-nums; transition: color 160ms ease, background-color 160ms ease; }
                .mnav-destination-option[aria-selected="true"] .mnav-destination-index { color: ${C.brandAccent}; background: rgba(255, 85, 102, 0.15); }
                .mnav-destination-text { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
                .mnav-destination-closed { color: ${C.warning}; }
                .mnav-destination-meta { display: flex; align-items: center; gap: 6px; min-width: 0; overflow: hidden; color: ${C.muted}; font-size: ${TYPE.desc}; font-weight: 600; line-height: 1.2; white-space: nowrap; text-overflow: ellipsis; }
                /* Campus tag: neutral (red means "problem" here, so no red / amber tags). */
                .leaflet-tooltip.campus-area-label {
                    background: rgba(16, 16, 20, 0.72); color: #fff; border: 0; border-radius: 6px; box-shadow: none;
                    padding: 2px 8px; font-size: 12px; font-weight: 700; letter-spacing: 0.02em; pointer-events: none;
                }
                .leaflet-tooltip.campus-area-label::before { display: none; }
                .mnav-destination-campus { flex: none; min-width: 24px; padding: 2px 8px; border-radius: 6px; text-align: center;
                    background: rgba(255, 255, 255, 0.08); color: ${C.text}; font-size: ${TYPE.desc}; font-weight: 700; }
                .mnav-dest-filter { display: flex; gap: 6px; padding: 0 9px 10px; overflow-x: auto; scrollbar-width: none; }
                .mnav-dest-filter::-webkit-scrollbar { display: none; }
                .mnav-dest-chip {
                    flex: none; display: inline-flex; align-items: center; gap: 6px; min-height: 36px; padding: 0 14px;
                    border-radius: 10px; border: 1px solid ${C.hairline}; background: rgba(255, 255, 255, 0.04);
                    color: ${C.muted}; font: inherit; font-size: 13px; font-weight: 600; cursor: pointer;
                    transition: background-color 160ms ease, color 160ms ease, border-color 160ms ease, transform 160ms ease;
                    min-height: ${TAP.minHeight};
                    -webkit-tap-highlight-color: transparent;
                }
                .mnav-dest-chip b { color: ${C.text}; font-weight: 700; font-variant-numeric: tabular-nums; }
                .mnav-dest-chip:hover { color: ${C.white}; background: rgba(255, 255, 255, 0.08); }
                .mnav-dest-chip:active { transform: scale(0.97); }
                .mnav-dest-chip:focus-visible { outline: ${TAP.focusOutline}; outline-offset: 2px; }
                .mnav-dest-chip[aria-pressed="true"] { color: ${C.white}; background: rgba(255, 255, 255, 0.12); border-color: rgba(255, 255, 255, 0.28); }
                .mnav-dest-group + .mnav-dest-group { margin-top: 6px; }
                .mnav-dest-group-head { padding: 8px 9px 4px; font-size: ${TYPE.desc}; font-weight: 700; color: ${C.muted}; }
                @media (max-width: 760px) { .mnav-dest-chip { min-height: ${TAP.minHeight}; } }
                .mnav-destination-option-name { min-width: 0; overflow: hidden; font-size: ${TYPE.sub}; line-height: 1.35; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
                .mnav-destination-check { width: 17px; height: 17px; color: ${C.brandAccent}; opacity: 0; transform: scale(0.7); transition: opacity 160ms ease, transform 220ms var(--e-out); }
                .mnav-destination-option[aria-selected="true"] .mnav-destination-check { opacity: 1; transform: scale(1); }
                .mnav-destination-option:nth-of-type(1) { animation-delay: 15ms; }
                .mnav-destination-option:nth-of-type(2) { animation-delay: 35ms; }
                .mnav-destination-option:nth-of-type(3) { animation-delay: 55ms; }
                .mnav-destination-option:nth-of-type(4) { animation-delay: 75ms; }
                .mnav-destination-option:nth-of-type(5) { animation-delay: 95ms; }
                .mnav-destination-option:nth-of-type(6) { animation-delay: 115ms; }
                .mnav-destination-option:nth-of-type(7) { animation-delay: 135ms; }
                .mnav-destination-option:nth-of-type(8) { animation-delay: 155ms; }
                .mnav-destination-option:nth-of-type(9) { animation-delay: 175ms; }
                .mnav-destination-option:nth-of-type(10) { animation-delay: 195ms; }
                .mnav-destination-empty { padding: 17px 12px; color: ${C.muted}; text-align: center; font-size: ${TYPE.sub}; }
                @keyframes mnav-option-enter { from { opacity: 0; transform: translateY(-5px); } to { opacity: 1; transform: translateY(0); } }
                .mnav-header > .mbtn { flex: 0 0 auto; align-self: stretch; justify-content: center; min-height: 52px; }
                .mnav-header > .mbtn svg { flex: none; }
                .mnav-3d-short { display: none; }
                @media (max-width: 400px) {
                    .mnav-3d-long { display: none; }
                    .mnav-3d-short { display: inline; }
                    .mnav-header > .mbtn { padding: 0 12px !important; }
                }

                /* Weather, offline sync and account: ONE row of 44px chips instead of three
                   differently-styled controls stacked down the screen. */
                .mnav-install-hint { flex: 1 0 100%; margin: 2px 4px 0; font-size: ${TYPE.desc}; line-height: 1.5; color: ${C.text}; }
                .mnav-chips {
                    display: flex; align-items: center; flex-wrap: wrap; gap: 6px 8px; flex: 0 0 auto;
                    margin: 8px max(10px, env(safe-area-inset-right)) 0 max(10px, env(safe-area-inset-left));
                }
                .mnav-chip {
                    display: inline-flex; align-items: center; gap: 8px; min-width: 0; max-width: 100%;
                    min-height: ${TAP.minHeight}; padding: 0 14px; border-radius: ${PILL}px;
                    background: ${C.surface}; border: 1px solid ${C.border}; color: ${C.text};
                    font: inherit; font-size: 13px; font-weight: 600; line-height: 1.2; text-align: left; white-space: nowrap;
                    cursor: pointer; ${btnBase}
                }
                .mnav-chip:hover { background: ${C.surfaceHover}; }
                .mnav-chip:active { transform: scale(${TAP.activeScale}); }
                .mnav-chip:focus-visible { outline: ${TAP.focusOutline}; outline-offset: 2px; }
                .mnav-chip:disabled { opacity: ${TAP.disabledOpacity}; cursor: progress; }
                .mnav-chip-icon { flex: none; font-size: 16px; line-height: 1; color: ${C.muted}; }
                .mnav-chip-text { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
                .mnav-chip-sub { overflow: hidden; text-overflow: ellipsis; font-size: ${TYPE.desc}; font-weight: 500; color: ${C.muted}; }
                .mnav-chip-dashed { background: transparent; border-style: dashed; color: ${C.muted}; }
                .mnav-chip-note { order: 10; flex: 1 1 100%; font-size: ${TYPE.desc}; line-height: 1.4; color: ${C.muted}; }
                .mnav-chip-note[data-tone="error"] { color: ${C.warning}; }
                .mnav-footer .mnav-status-reading { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; min-width: 0; }
                .mnav-footer .mnav-status-reading .metric-value { overflow-wrap: anywhere; }
                .mnav-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
                .mnav-actions > .mbtn { flex: 0 1 auto; }
                .mnav-mapwrap { min-width: 0; flex: 1 1 auto; }
                .mnav-stage { flex: 1; min-height: 0; }
                /* Phones: keep header as ONE compact row (picker + 3D button)
                   so the map keeps the viewport. The old stacked grid pushed
                   the 3D button to its own full-width row and shrank the map. */
                @media (max-width: 480px) {
                    .mnav-header { display: flex; flex-direction: row; align-items: stretch; gap: 8px; }
                    .mnav-destination { flex: 1 1 0; min-width: 0; }
                    .mnav-select { min-height: 52px; padding: 6px 10px; }
                    .mnav-destination-mark { width: 30px; height: 30px; flex-basis: 30px; }
                    .mnav-destination-name { font-size: 14px; }
                    .mnav-header > .mbtn { flex: 0 0 auto; width: auto; min-height: 52px; padding: 0 14px !important; font-size: 14px; }
                    .mnav-destination-menu { max-height: min(420px, 52dvh); }
                    /* The open list spans the whole header (not just the field), so
                       place names are not cut to a few letters. */
                    .mnav-destination { position: static; }
                    .mnav-destination-menu { top: calc(100% + 6px); left: 0; right: 0; }
                    /* Clear button: same 44 px target, lighter look, so the name keeps the room. */
                    .mnav-destination-clear { background: transparent; color: ${C.muted}; }
                    .mnav-footer { padding: 10px 12px; gap: 5px; }
                    .mnav-footer .metric-value { font-size: 22px !important; line-height: 1.1 !important; }
                    .mnav-footer .tele { font-size: 12px; }
                    .mnav-actions { flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; }
                    .mnav-actions::-webkit-scrollbar { display: none; }
                    .mnav-actions > .mbtn { flex: 0 0 auto; min-height: ${TAP.minHeight}; padding: 0 14px !important; font-size: ${TYPE.sub}; }
                    .mnav-mapwrap { min-height: 0; }
                    .leaflet-top.leaflet-left .leaflet-control-zoom { margin: 8px 0 0 8px; }
                }
                /* Narrow phones: the field itself opens the list, so the chevron goes
                   and the destination name gets its width. */
                @media (max-width: 400px) {
                    .mnav-destination-chevron-btn { display: none; }
                    /* The pin icon is decoration here; the name needs the room. */
                    .mnav-destination-mark { display: none; }
                }
                @media (max-width: 360px) {
                    .mnav-header { gap: 6px; padding: 6px; }
                    .mnav-select { min-height: 52px; padding: 5px 8px; }
                    .mnav-header > .mbtn { padding: 0 10px !important; }
                    .mnav-footer { padding: 8px 10px; }
                    .mnav-footer .metric-value { font-size: 20px !important; }
                    .mnav-actions { gap: 6px; }
                }
                /* Short landscape screens: keep the controls compact and make
                   the footer independently scrollable instead of covering the map. */
                @media (max-height: 520px) {
                    .mnav-header { display: flex; flex-direction: row; margin-top: max(5px, env(safe-area-inset-top)); padding: 5px; gap: 7px; }
                    .mnav-select { min-height: 44px; }
                    .mnav-header > .mbtn { width: auto; min-height: 44px; padding-left: 12px !important; padding-right: 12px !important; }
                    .mnav-footer { max-height: 30dvh; overflow-y: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch; margin: 0 8px max(5px, env(safe-area-inset-bottom)); padding: 7px 8px; }
                    .mnav-footer .metric-value { font-size: 20px !important; }
                    .mnav-mapwrap { min-height: 100px; }
                    .mnav-destination-menu { max-height: 44dvh; }
                }
            `}</style>
            <div className={`mnav-stage${leaving ? ' mnav-leaving' : ''}`}>
            {/* Header card: destination picker and the 3D launch, nothing else. */}
            {/* Visitors too: they pick a building (no rooms or offices) and get a route to it. */}
            {(
            <div className="mnav-header">
                <div
                    className={`mnav-destination${destinationOpen ? ' is-open' : ''}`}
                    ref={destinationPickerRef}
                    onBlur={(event) => {
                        if (!destinationPickerRef.current?.contains(event.relatedTarget)) setDestinationOpen(false);
                    }}
                >
                    <div
                        className="mnav-select"
                        onClick={() => {
                            if (!destinationOpen) setDestinationOpen(true);
                            destinationTriggerRef.current?.focus();
                        }}
                    >
                        <span className="mnav-destination-mark" aria-hidden="true">
                            <svg width="19" height="19" viewBox="0 0 24 24" fill="none">
                                <path d="M20 10.1c0 5.1-8 11.3-8 11.3S4 15.2 4 10.1a8 8 0 1 1 16 0Z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                                <circle cx="12" cy="10" r="2.6" stroke="currentColor" strokeWidth="1.8" />
                            </svg>
                        </span>
                        <span className="mnav-destination-copy">
                            <span className="mnav-destination-eyebrow">Destination</span>
                            <input
                                ref={destinationTriggerRef}
                                className="mnav-destination-input"
                                type="text"
                                role="combobox"
                                aria-label="Search destinations"
                                aria-expanded={destinationOpen}
                                aria-controls="mnav-destination-list"
                                aria-autocomplete="list"
                                autoComplete="off"
                                autoCorrect="off"
                                autoCapitalize="off"
                                spellCheck={false}
                                enterKeyHint="go"
                                placeholder={selectedDestName || (isVisitor ? 'Search buildings and offices' : 'Search places')}
                                value={destinationOpen ? destQuery : selectedDestName}
                                onFocus={() => setDestinationOpen(true)}
                                onChange={(event) => {
                                    setDestQuery(event.target.value);
                                    setDestinationOpen(true);
                                }}
                                onKeyDown={(event) => {
                                    if (event.key === 'Escape') {
                                        event.preventDefault();
                                        if (destinationOpen && destQuery) setDestQuery('');
                                        else setDestinationOpen(false);
                                    } else if (event.key === 'ArrowDown') {
                                        event.preventDefault();
                                        if (!destinationOpen) setDestinationOpen(true);
                                        else focusDestOption(0);
                                    } else if (event.key === 'Enter') {
                                        event.preventDefault();
                                        if (destinationOpen && filteredDestinations.length) chooseDestination(filteredDestinations[0]);
                                    } else if (event.key === 'Tab') {
                                        setDestinationOpen(false);
                                    }
                                }}
                            />
                        </span>
                        {destId && !destinationOpen && (
                            <button
                                type="button"
                                className="mnav-destination-clear"
                                aria-label={`Cancel the destination ${selectedDestName}`}
                                title="Cancel destination"
                                onMouseDown={(event) => event.preventDefault()}
                                onClick={(event) => { event.stopPropagation(); clearDestination(); }}
                            >
                                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden="true">
                                    <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
                                </svg>
                            </button>
                        )}
                        <button
                            type="button"
                            className="mnav-destination-chevron-btn"
                            aria-label={destinationOpen ? 'Close destination list' : 'Open destination list'}
                            tabIndex={-1}
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={(event) => {
                                event.stopPropagation();
                                if (destinationOpen) setDestinationOpen(false);
                                else { setDestinationOpen(true); destinationTriggerRef.current?.focus(); }
                            }}
                        >
                            <svg className="mnav-destination-chevron" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                                <path d="m6 9 6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                        </button>
                    </div>
                    <div
                        ref={destinationMenuRef}
                        className="mnav-destination-menu"
                        data-open={destinationOpen ? 'true' : 'false'}
                        aria-hidden={!destinationOpen}
                    >
                        <div className="mnav-destination-menu-head">
                            <span>Choose destination</span>
                            <span className="mnav-destination-count">
                                {destQuery.trim() || campusFilter !== 'all'
                                    ? `${filteredDestinations.length} of ${destinations.length}`
                                    : `${destinations.length} ${destinations.length === 1 ? 'place' : 'places'}`}
                            </span>
                        </div>
                        {showCampusChips && (
                            <div className="mnav-dest-filter" role="group" aria-label="Filter by campus">
                                {[['all', 'All', destinations.length], ...campusChoices.map((c) => [c.key, c.label, c.count])].map(([value, label, count]) => (
                                    <button
                                        key={value} type="button" className="mnav-dest-chip" aria-pressed={campusFilter === value}
                                        tabIndex={destinationOpen ? 0 : -1}
                                        onMouseDown={(e) => e.preventDefault()}
                                        onClick={() => pickCampus(value)}
                                    >
                                        {label} <b>{count}</b>
                                    </button>
                                ))}
                            </div>
                        )}
                        <div id="mnav-destination-list" role="listbox" aria-label="Choose destination">
                        {destinationGroups.length ? destinationGroups.map((group) => (
                            <div key={group.key} role="group" aria-label={group.label} className="mnav-dest-group">
                            {(campusFilter === 'all' && showCampusChips && group.label) && <div className="mnav-dest-group-head" aria-hidden="true">{group.label}</div>}
                            {group.items.map((d) => {
                            const isSelected = String(d.id) === String(destId);
                            // A building: "Building, 3 floors"; a room: its building.
                            const buildingLabel = d.is_building
                                ? `Building${buildingsById.get(d.building_id) ? `, ${floorCountLabel(buildingsById.get(d.building_id))}` : ''}`
                                : buildingLabelOf(d);
                            // Opening hours, when the place (or its building) has them: open now, or when it opens.
                            const hours = d.is_building
                                ? buildingStatus(buildingsById.get(d.building_id), closures, sunDate)
                                : placeStatusOf(d, buildingsById, closures, sunDate);
                            return (
                                <button
                                    key={d.id}
                                    type="button"
                                    role="option"
                                    aria-selected={isSelected}
                                    tabIndex={-1}
                                    className="mnav-destination-option"
                                    onClick={() => {
                                        chooseDestination(d);
                                        destinationTriggerRef.current?.blur();
                                    }}
                                    onKeyDown={(event) => {
                                        const options = Array.from(destinationMenuRef.current?.querySelectorAll('[role="option"]') || []);
                                        const activeIndex = options.indexOf(event.currentTarget);
                                        if (event.key === 'ArrowDown') focusDestOption((activeIndex + 1) % options.length);
                                        else if (event.key === 'ArrowUp') focusDestOption(activeIndex - 1);
                                        else if (event.key === 'Home') focusDestOption(0);
                                        else if (event.key === 'End') focusDestOption(options.length - 1);
                                        else if (event.key === 'Escape') {
                                            event.preventDefault();
                                            setDestinationOpen(false);
                                            destinationTriggerRef.current?.blur();
                                            return;
                                        } else if (event.key === 'Tab') {
                                            setDestinationOpen(false);
                                            return;
                                        } else return;
                                        event.preventDefault();
                                    }}
                                >
                                    <span className="mnav-destination-text">
                                        <span className="mnav-destination-option-name">{d.name || `Location ${d.id}`}</span>
                                        {/* The building it is in; nothing for a stand-alone destination. */}
                                        {(buildingLabel || hours) && (
                                            <span className="mnav-destination-meta">
                                                {buildingLabel}
                                                {buildingLabel && hours && <span aria-hidden="true">·</span>}
                                                {hours && <span className={hours.open ? undefined : 'mnav-destination-closed'}>{hours.label}</span>}
                                            </span>
                                        )}
                                    </span>
                                    <svg className="mnav-destination-check" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                                        <path d="m5 12.5 4.3 4.3L19 7" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
                                    </svg>
                                </button>
                            );
                            })}
                            </div>
                        )) : (
                            <div className="mnav-destination-empty" role="none">
                                {!destinations.length
                                    ? 'No destinations available yet.'
                                    : destQuery.trim()
                                        ? `No places match “${destQuery.trim()}”.`
                                        : `No places on ${campusNameOf(campusFilter)} yet.`}
                            </div>
                        )}
                        </div>
                    </div>
                </div>
                <button
                    className="mbtn"
                    onClick={launch3D}
                    disabled={!route || !userLocation || leaving || launching}
                    aria-busy={launching}
                    style={{
                        padding: '0 16px', borderRadius: PILL, fontSize: TYPE.sub, fontWeight: '700',
                        background: route && userLocation ? C.primary : C.surface, color: C.white,
                        border: `1px solid ${route && userLocation ? 'rgba(74, 222, 128, 0.75)' : C.border}`,
                        whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: 8,
                    }}
                >
                    {launching
                        ? <span className="mbtn-spin" aria-hidden="true" />
                        : (
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                                <path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
                                <path d="m4 7.5 8 4.5 8-4.5M12 12v9" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
                            </svg>
                        )}
                    <span className="mnav-3d-long">{launching ? 'Loading' : '3D view'}</span>
                    <span className="mnav-3d-short" aria-hidden="true">{launching ? '...' : '3D'}</span>
                </button>
                {isVisitor ? (
                    <>
                        <button type="button" className="mbtn mnav-visitor-btn" onClick={onSignIn}>Sign in</button>
                        <AppMenu isVisitor showInstall={showInstall} demo={campusDemoItem} />
                    </>
                ) : (
                    <AppMenu session={session} sync={sync} showInstall={showInstall} onSignOut={onSignOut} demo={campusDemoItem} />
                )}
            </div>
            )}
            {/* School-level announcements (classes suspended, campus closed): everyone sees them, visitors too. */}
            {announcementList.length > 0 && (
                <div className="mnav-announce" role="status">
                    {announcementList.map((a) => (
                        <p key={a.id}>
                            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden="true">
                                <path d="M4 10v4h3l6 4V6L7 10H4zM16.5 9a4 4 0 0 1 0 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                            <span>{a.text}</span>
                        </p>
                    ))}
                </div>
            )}




            {/* Offline status, Install app and the account live in the header menu (AppMenu).
                Weather and heat sit in the bottom sheet, next to the route. */}

            {/* Rain closed every way to this destination: say so plainly
                rather than leaving an empty route line. The 3D view cannot
                start without a route, so this is also why its button stays
                disabled. */}

            {/* The route continues on another floor: say how to get there. */}

            <div ref={mapWrapRef} className="mnav-mapwrap">
                <div ref={mapRef} style={{ position: 'absolute', inset: 0 }} />
                {/* One pill for every notice: sync news, and errors (a failed
                    map load keeps its Try again button until it is handled). */}
                {/* Route tools, bottom centre (same panel as Map / Satellite):
                    the stairs ahead and the route in 3D. */}
                {/* Only when there is something to do here: the stairs ahead or the
                    route through buildings in 3D. Cancelling is the x in the
                    destination field, so it is not repeated over the map. */}
                {/* Bottom centre, one column so they never overlap: the weather pill, then the
                    route tools. Phones: above the Map / Satellite panel. */}
                <div className={`mnav-bottom-stack${pickerFloors.length > 0 ? ' above-floors' : ''}`}>
                    {!isVisitor && weather && weather.status !== 'unavailable' && weather.status !== 'stale' && (
                        <WeatherPill weather={weather} shadeActive={Boolean(routeShade)} headers={authHeaders} onWeather={applyWeather} />
                    )}
                    {destId && route && !noRoute && (stairHint || routeBuildingIds.size > 0) && (
                        <StairHint
                            stair={stairHint}
                            onGoToFloor={(f) => setFloor(f)}
                            onRouteIn3D={routeBuildingIds.size > 0 ? () => {
                                setRouteModelOpen(true);
                                if (isVisitor) logVisit('route.model3d', route?.path?.[route.path.length - 1]?.name);
                            } : null}
                        />
                    )}
                </div>
                {routeModelOpen && route && (
                    <StairModal
                        title="Route in 3D"
                        subtitle={selectedDestName || route.path?.[route.path.length - 1]?.name || 'Your route'}
                        onClose={() => setRouteModelOpen(false)}
                        closeLabel="Close the 3D route"
                        footer={<button type="button" className="ui-btn ui-btn-primary" onClick={() => setRouteModelOpen(false)}>Done</button>}
                    >
                        <React.Suspense fallback={<div role="status" style={{ ...LOADING_3D, height: 'min(64vh, 600px)' }}>Loading the 3D route...</div>}>
                            <RouteModel3D route={route} buildings={buildings} bridges={bridges} nodes={nodes} links={links} height="min(64vh, 600px)" />
                        </React.Suspense>
                    </StairModal>
                )}
                <SyncPill
                    pill={errorPill
                        ? { ...errorPill, ...(mapLoadFailed ? { action: { label: 'Try again', onClick: retryMapLoad } } : {}) }
                        : noticePill || sync.pill}
                    onDismiss={errorPill ? () => setErrorPill(null) : noticePill ? () => setNoticePill(null) : sync.dismissPill}
                />
                {/* Bottom-left: clear of the zoom (top-left), the info pill
                    (top centre) and the attribution line (bottom-right). */}
                <div className={`mnav-sat${pickerFloors.length > 0 ? ' above-floors' : ''}`} onClick={(e) => e.stopPropagation()}>
                    <SatelliteControl settings={satellite} compact />
                </div>
                {/* ── Floor picker ──────────────────────────────────────────
                    An elevator panel for the building floor the student is
                    on. Both this screen and the 3D view read `activeFloor`,
                    so a tap re-renders the 2D pins and the 3D nodes together.
                    Pinned bottom-left: the zoom control owns top-left and the
                    compass pill owns top-right. */}
                {floorPrompt && (
                    <div className="mnav-floorask" role="dialog" aria-modal="true" aria-labelledby="mnav-floorask-title">
                        <div className="mnav-floorask-card">
                            <h2 id="mnav-floorask-title" className="mnav-floorask-title">Which floor are you on?</h2>
                            <p className="mnav-floorask-text">
                                {nodes.find((n) => String(n.id) === floorPrompt.destId)?.name || 'Your destination'} is on {floorAria(floorPrompt.destFloor).toLowerCase()}.
                                We&rsquo;ll route you from your floor.
                            </p>
                            <div className="mnav-floorask-chips" role="group" aria-label="Your floor">
                                {pickerFloors.map((f) => (
                                    <button
                                        key={f}
                                        type="button"
                                        className={`mnav-floor-chip${f === activeFloor ? ' is-active' : ''}`}
                                        aria-pressed={f === activeFloor}
                                        aria-label={floorAria(f)}
                                        onClick={() => { setFloor(f); setFloorPrompt(null); }}
                                    >
                                        {floorTag(f)}
                                    </button>
                                ))}
                            </div>
                        </div>
                    </div>
                )}
                {pickerFloors.length > 0 && (
                    <div className="mnav-floor" role="group" aria-label={userBuilding ? `Floor in ${userBuilding.short_name || userBuilding.name}` : 'Floor'}>
                        {pickerFloors.map((f) => (
                            <button
                                key={f}
                                type="button"
                                className={`mnav-floor-chip${f === activeFloor ? ' is-active' : ''}`}
                                aria-pressed={f === activeFloor}
                                aria-label={floorAria(f)}
                                onClick={() => setFloor(f)}
                            >
                                {floorTag(f)}
                            </button>
                        ))}
                    </div>
                )}
                {/* ── Facing-direction readout ───────────────────────────────
                    Starts hidden on purpose: a compass that shows a guess is
                    worse than no compass at all. The sensor handler writes the
                    text directly (it fires up to 100×/s) rather than through
                    React state. React only ever writes style keys whose value
                    changed between renders, and `display` never does here, so
                    the manual show survives re-renders. */}
                <div
                    ref={povPillRef}
                    style={{
                        position: 'absolute', right: 12, top: 12, zIndex: 1000,
                        display: 'none', alignItems: 'center',
                        padding: '6px 12px', borderRadius: 10,
                        background: 'rgba(12, 12, 16, 0.86)',
                        border: '1px solid rgba(34, 197, 94, 0.35)',
                        color: C.text,
                        fontSize: TYPE.sub, fontWeight: 700,
                        fontVariantNumeric: 'tabular-nums', letterSpacing: '0.04em',
                        whiteSpace: 'nowrap', pointerEvents: 'none',
                        boxShadow: '0 6px 18px rgba(0, 0, 0, 0.45)',
                    }}
                />
                {compassWarn && (
                    <div
                        role="status"
                        style={{
                            position: 'absolute', right: 12, top: 52, zIndex: 1000,
                            maxWidth: 'min(280px, calc(100% - 24px))',
                            padding: '8px 12px', borderRadius: 12,
                            background: 'rgba(43, 28, 6, 0.92)',
                            border: '1px solid rgba(255, 159, 26, 0.55)',
                            color: C.warning, fontSize: TYPE.sub, lineHeight: 1.4,
                            pointerEvents: 'none',
                            boxShadow: '0 6px 18px rgba(0, 0, 0, 0.45)',
                        }}
                    >
                        {compassWarn}
                    </div>
                )}
            </div>

            {/* Footer card: what to do now (readout), then the controls, so the
                thumb ends on the buttons. */}
            <div className="mnav-footer" role="status" aria-live="polite">
                <span className="mnav-foot-icon" data-kind={status.kind} aria-hidden="true">
                    {status.kind === 'busy' ? <span className="mbtn-spin" /> : (
                        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            {status.kind === 'route' && <path d="M5 19c3-6 11-1 14-9M15 6l4 4-4.5 1" />}
                            {status.kind === 'pin' && <path d="M12 21s-6-5.5-6-11a6 6 0 1 1 12 0c0 5.5-6 11-6 11ZM12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z" />}
                            {(status.kind === 'ready' || status.kind === 'nogps') && <path d="M12 3v3M12 18v3M3 12h3M18 12h3M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z" />}
                        </svg>
                    )}
                </span>
                <div className="mnav-foot-text">
                    {status.label && <span className="mnav-foot-label">{status.label}</span>}
                    <span className={`mnav-foot-value${statusHot ? ' is-hot' : ''}`}>{status.value}</span>
                    {status.meta && <span className="mnav-foot-meta">{status.meta}</span>}
                    {gpsNote && <span className="mnav-foot-note">{gpsNote}</span>}
                </div>
                <div className="mnav-foot-actions" role="group" aria-label="Your position">
                    <button type="button" className={`mnav-foot-btn${testMode ? ' is-on' : ''}`} onClick={toggleTestMode} aria-pressed={testMode}>
                        {testMode ? 'Done' : 'Place pin'}
                    </button>
                    {testMode && (
                        <button type="button" className="mnav-foot-btn is-primary" onClick={useMyLocation}>Use GPS</button>
                    )}
                    {!loading && !userLocation && !waitingGps && (
                        <button type="button" className="mnav-foot-btn is-primary" onClick={retryGps}>Retry GPS</button>
                    )}
                </div>
            </div>
            </div>
            {showAR && arRoute && userLocation && (
                <ARViewErrorBoundary onExit={exit3D}>
                    <React.Suspense fallback={<div role="status" style={{ ...LOADING_3D, position: 'fixed', inset: 0, zIndex: 3000, background: C.page }}>Opening the 3D view...</div>}>
                    {/* userLocation is LIVE (not a launch-time snapshot) so the
                        3D camera tracks the same fix the 2D you-are-here dot shows. */}
                    <ARView
                        key={arKey} nodes={nodes} borders={borders} route={arRoute} userLocation={userLocation}
                        floor={activeFloor} floors={floors} onFloorChange={setFloor} onExit={exit3D} onWalkedPosition={handleWalkedPosition}
                        buildings={buildings} pathways={pathways} bridges={bridges}
                        destPlace={selectedDest ? nodePlaceLabel(selectedDest, buildingsById) : ''}
                        links={links}
                        satellite={satellite}
                    />
                    </React.Suspense>
                </ARViewErrorBoundary>
            )}
            {scene && <SceneOverlay scene={scene} step={sceneStep} />}
        </div>
    );
}
