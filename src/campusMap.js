// Shared campus map configuration.
//
// The base map is a Protomaps PMTiles archive in storage/app/, served by the
// backend at /<TILE_FILE> (routes/web.php). TILE_FILE below picks which one, and
// with it the map's box and centre (ARCHIVES); the dev proxy and the installed
// app's offline copy follow it too.
//
// ── Updating a base map (pmtiles.exe, in the project root) ──────────────────
// Cut a box out of Protomaps' free daily world build (OpenStreetMap data,
// ~140 GB, but only the tiles inside the box are downloaded: about 600 kB).
//
//   1. Find the newest build name (YYYYMMDD.pmtiles, the last "key"):
//        curl https://build-metadata.protomaps.dev/builds.json
//      or browse https://maps.protomaps.com/builds/
//
//   2. Extract the box, --bbox = min_lon,min_lat,max_lon,max_lat (west,south,east,north),
//      zoom 0-15. Add --dry-run first to see the size without downloading.
//
//      Production campus (university.pmtiles):
//        .\pmtiles.exe extract https://build.protomaps.com/20261108.pmtiles storage/app/university.pmtiles --bbox=122.059264,6.911304,122.064242,6.915020 --maxzoom=15
//
//   3. Check it:   .\pmtiles.exe show storage/app/university.pmtiles      (bounds, center, zooms)
//                  .\pmtiles.exe verify storage/app/university.pmtiles
//
//   4. A new box or a new file: add/update its entry in ARCHIVES below (same box and
//      centre as the extract), allow its name in routes/web.php, point TILE_FILE at
//      it, then `npm run build` (installed apps refresh their offline copy on their
//      next online start).
//
// Data © OpenStreetMap contributors (ODbL); Protomaps basemap. Keep the map's
// attribution visible.
//
// Every map (admin, mobile, AR mini-map) is locked to the chosen archive's box:
// the view cannot pan or zoom out of it, and the tile layer never requests tiles
// outside it.
import L from 'leaflet';
import { PMTiles, FetchSource } from 'pmtiles';
import { leafletLayer, paintRules, labelRules } from 'protomaps-leaflet';
// The flavor table protomaps-leaflet itself imports (its own dependency, not
// a new install; pmtiles above is used the same way).
import { namedFlavor } from '@protomaps/basemaps';

// Same origin rule as mobileApi: empty in production (same-origin Laravel),
// LAN URL in dev when Vite serves the frontend on a different origin.
// Same origin rule as mobileApi: empty in production (same-origin Laravel),
// LAN URL in dev when Vite serves the frontend on a different origin.
const API_BASE = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');

// The archives in storage/app/, each with the box it was extracted for
// (Leaflet order: [[south, west], [north, east]]) and that box's centre [lat, lng].
// The box is also the pan limit (maxBounds): a node outside it cannot be reached on
// the 2D map at all, so widen the extract and the box together.
const ARCHIVES = {
    // Production: the campus. OSM 2026-03-31.
    'university.pmtiles': {
        bounds: [[6.911304, 122.059264], [6.915020, 122.064242]],
        center: [6.913164, 122.061753],
    },
};

// Which archive the maps read. PRODUCTION: 'university.pmtiles'.
// vite.config.js reads this line (keep it a plain string).
export const TILE_FILE = 'university.pmtiles';
export const TILE_URL = `${API_BASE}/${TILE_FILE}`;

if (!ARCHIVES[TILE_FILE]) throw new Error(`campusMap.js: no ARCHIVES entry for ${TILE_FILE}`);

// The chosen archive's box and centre: every map, the sun shadows and the OSM building
// outlines use these.
export const CAMPUS_BOUNDS = ARCHIVES[TILE_FILE].bounds;
export const CAMPUS_CENTER = ARCHIVES[TILE_FILE].center;

// Zoom range. The real lower limit is set per screen by lockToCampus: the
// zoom at which the whole view still fits inside the campus box.
export const CAMPUS_MIN_ZOOM = 15;
export const CAMPUS_MAX_ZOOM = 22;

// Gestures that cannot leave the box. Leaflet's normal pinch zooms around the
// fingers and moves the centre freely *during* the gesture (it only clamps on
// release), which flashed off-campus tiles on Android. Pinching around the
// view's centre ('center') never moves the centre, so with lockToCampus's
// minimum zoom the view stays inside the box the whole time. Same for the
// wheel. bounceAtZoomLimits off: no rubber-banding past the limits.
export const CAMPUS_MAP_LOCK = {
    touchZoom: 'center',
    scrollWheelZoom: 'center',
    bounceAtZoomLimits: false,
};

export function campusLatLngBounds() {
    return L.latLngBounds(CAMPUS_BOUNDS);
}

/**
 * Keep the whole view inside the campus box (the PMTiles footprint) at every
 * zoom, on every screen: pan limit = the box (hard edge), and the minimum
 * zoom = the lowest zoom at which the view still fits inside it, recomputed
 * whenever the map is resized (window, phone rotation, panel opening).
 * Call right after creating the map. Returns a function that undoes it.
 */
export function lockToCampus(map, { minZoom = CAMPUS_MIN_ZOOM } = {}) {
    // No "Leaflet" link before the map credit (its licence does not ask for one): a smaller
    // credit box on phones, and one less link to tap away from the app by accident.
    map.attributionControl?.setPrefix(false);
    const box = campusLatLngBounds();
    map.options.maxBoundsViscosity = 1;
    map.setMaxBounds(box);
    const fit = () => {
        const size = map.getSize();
        if (!size.x || !size.y) return; // hidden (e.g. another tab): try again on resize
        const snap = map.options.zoomSnap || 1;
        const fitsInside = map.getBoundsZoom(box, true);
        const lowest = Math.min(map.getMaxZoom(), Math.max(minZoom, Math.ceil(fitsInside / snap) * snap));
        map.setMinZoom(lowest);
        if (map.getZoom() < lowest) map.setZoom(lowest, { animate: false });
        map.panInsideBounds(box, { animate: false });
    };
    fit();
    map.on('resize', fit);
    return () => map.off('resize', fit);
}

/**
 * Build the vector base tile layer, restricted to the campus box so no
 * off-campus tiles are ever requested.
 *
 * Tile fetches go through an explicit PMTiles/FetchSource (instead of a
 * bare URL string) so ngrok's skip-warning header can be attached; without it
 * ngrok's free-tier warning page answers range requests with HTML and the map
 * renders blank (Safari on iPhone does not keep ngrok's cookie). Sent to our
 * own server always, to a separate API host only with VITE_TUNNEL=ngrok (same
 * rule as TUNNEL_HEADERS in mobileApi.js).
 */
export function openCampusArchive() {
    const headers = (API_BASE === '' || import.meta.env.VITE_TUNNEL === 'ngrok') ? { 'ngrok-skip-browser-warning': 'true' } : {};
    return new PMTiles(new FetchSource(TILE_URL, new Headers(headers)));
}

// Archive layers the GPS map (student /map and the 3D view's mini-map) does
// not draw: the campus's own buildings and pathways (campusLayers.js) replace
// them there. The admin map keeps them for the campus editor's "adopt a shape"
// flow (which reads shapes from the archive itself, see osmFeatures.js).
export const GPS_HIDDEN_LAYERS = ['buildings', 'roads'];

// Base-map style of the GPS maps (student /map, the 3D mini-map and the admin
// "Student view"). Light, like the admin map: the dark style made the map read
// as a black void once the archive's buildings and roads were hidden. Overlays
// pick their colours from the same value (campusLayers `theme`).
export const GPS_FLAVOR = 'light';

// Dark edge drawn under the white route line (and around the white "you" dot),
// so white stays the route colour and still stands out on light tiles.
export const ROUTE_CASING = '#16161b';

/**
 * `hiddenLayers` names archive layers (e.g. 'buildings', 'roads') whose paint
 * AND label rules are dropped, the way pmtiles.io switches a layer off. The
 * rules are filtered before the layer is built because protomaps-leaflet reads
 * the label rules once, in its constructor. With no hidden layers the flavor
 * is passed through exactly as before.
 */
// The base map's credit (a licence requirement). Its links open OUTSIDE the app: inside an
// installed app a tapped link replaced the map with protomaps.com, which offline showed
// "no internet" (and iOS home-screen apps have no back button).
const EXTERNAL = 'target="_blank" rel="noopener noreferrer"';
export const MAP_ATTRIBUTION = `<a href="https://protomaps.com" ${EXTERNAL}>Protomaps</a> © <a href="https://openstreetmap.org/copyright" ${EXTERNAL}>OpenStreetMap</a>`;

export function createTileLayer({ flavor = 'light', lang = 'en', hiddenLayers = [] } = {}) {
    const common = {
        url: openCampusArchive(),
        attribution: MAP_ATTRIBUTION,
        bounds: campusLatLngBounds(),
        // Single world copy: never render wrapped duplicates of the archive
        // outside the campus box.
        noWrap: true,
    };

    if (hiddenLayers.length === 0) {
        return leafletLayer({ ...common, flavor, lang });
    }

    // Same three values leafletLayer derives from `flavor` internally.
    const theme = namedFlavor(flavor);
    const shown = (rule) => !hiddenLayers.includes(rule.dataLayer);

    return leafletLayer({
        ...common,
        paintRules: paintRules(theme).filter(shown),
        labelRules: labelRules(theme, lang).filter(shown),
        // Keep the flavor's background so the map is not left blank/white.
        backgroundColor: theme.background,
    });
}

// ── Satellite imagery (Esri World Imagery) ───────────────────────────
// An optional photo layer under the campus layers, to compare the drawn map
// against real aerial imagery. One definition for every map (admin, /map, the
// 3D view's mini-map); change the source here only.
//
// Terms (Esri): free use needs an ArcGIS developer account, a non-revenue app,
// fewer than 1 million tile requests a month, and the attribution below shown
// on screen. Tiles are fetched straight from Esri by the browser: never
// proxied, stored or added to the offline download.
export const SATELLITE_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
export const SATELLITE_ATTRIBUTION = 'Imagery: Esri, Maxar, Earthstar Geographics, and the GIS User Community';
// Deepest zoom with real imagery over the campus (checked against Esri's
// tilemap service: 18 has photos, 19+ only the "not available" placeholder).
// Leaflet enlarges the zoom-18 photos above this instead of showing blanks.
export const SATELLITE_MAX_NATIVE_ZOOM = 18;
// Optional ArcGIS API key (VITE_ESRI_API_KEY). Browser-visible by nature, so it
// must be a referrer-restricted key in the ArcGIS dashboard.
export const SATELLITE_API_KEY = import.meta.env.VITE_ESRI_API_KEY || '';

export function createSatelliteLayer({ opacity = 1 } = {}) {
    const url = SATELLITE_API_KEY ? `${SATELLITE_URL}?token=${encodeURIComponent(SATELLITE_API_KEY)}` : SATELLITE_URL;
    return L.tileLayer(url, {
        attribution: SATELLITE_ATTRIBUTION,
        // Only campus tiles, only the zooms the maps allow.
        bounds: campusLatLngBounds(),
        noWrap: true,
        minZoom: CAMPUS_MIN_ZOOM,
        maxZoom: CAMPUS_MAX_ZOOM,
        maxNativeZoom: SATELLITE_MAX_NATIVE_ZOOM,
        opacity,
        // Above the vector base map (both live in the tile pane), so the
        // opacity slider fades between photo and map; every campus layer
        // (buildings, pathways, route, pins) sits in higher panes on top.
        zIndex: 5,
        // Fewer off-screen tiles kept around: less traffic on phones.
        keepBuffer: 1,
        className: 'satellite-layer',
    });
}
