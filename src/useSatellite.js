import { useCallback, useEffect, useRef, useState } from 'react';
import { createSatelliteLayer } from './campusMap.js';

// Satellite view settings shared by every map on this device: on/off and the
// photo's opacity (fade between the aerial photo and the vector map). Saved per
// device; storage may be blocked (private mode), which only means the choice
// is not remembered. Default for everyone: the normal map, satellite off.

const KEY = 'mapSatellite';
const DEFAULTS = { on: false, opacity: 100 };

function readSaved() {
    try {
        const v = JSON.parse(localStorage.getItem(KEY) || 'null');
        if (v && typeof v === 'object') {
            return { on: Boolean(v.on), opacity: Math.max(0, Math.min(100, Number(v.opacity) || 0)) };
        }
    } catch { /* blocked or bad JSON */ }
    return DEFAULTS;
}

function writeSaved(value) {
    try { localStorage.setItem(KEY, JSON.stringify(value)); } catch { /* blocked: not remembered */ }
}

/** Live online/offline state (satellite tiles need a connection). */
function useOnline() {
    const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine !== false));
    useEffect(() => {
        const up = () => setOnline(true);
        const down = () => setOnline(false);
        window.addEventListener('online', up);
        window.addEventListener('offline', down);
        return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down); };
    }, []);
    return online;
}

/**
 * @returns {{ on: boolean, opacity: number, online: boolean, active: boolean,
 *            setOn: (v: boolean) => void, setOpacity: (n: number) => void }}
 *   `active` = on and online: the only state in which imagery is requested.
 */
export function useSatelliteSettings() {
    const [settings, setSettings] = useState(readSaved);
    const online = useOnline();
    const update = useCallback((patch) => {
        setSettings((s) => {
            const next = { ...s, ...patch };
            writeSaved(next);
            return next;
        });
    }, []);
    // Another map on the page (e.g. the 3D view's mini-map) changed it.
    useEffect(() => {
        const onStorage = (e) => { if (e.key === KEY) setSettings(readSaved()); };
        window.addEventListener('storage', onStorage);
        return () => window.removeEventListener('storage', onStorage);
    }, []);
    return {
        ...settings,
        online,
        active: settings.on && online,
        setOn: (on) => update({ on: Boolean(on) }),
        setOpacity: (opacity) => update({ opacity: Math.max(0, Math.min(100, Math.round(Number(opacity) || 0))) }),
    };
}

/**
 * Keep a Leaflet map's satellite layer in step with the settings: created and
 * added only while active (no tiles are fetched otherwise), removed when off or
 * offline, opacity updated in place (no reload while sliding).
 *
 * @param {() => import('leaflet').Map|null} getMap returns the map once it exists
 */
export function useSatelliteLayer(getMap, { active, opacity }, ready = true) {
    const layerRef = useRef(null);
    useEffect(() => {
        const map = getMap();
        // No map (yet / any more): any old layer went with the old map.
        if (!map || !ready) { layerRef.current = null; return undefined; }
        if (layerRef.current && layerRef.current._map !== map) layerRef.current = null;
        if (!active) {
            layerRef.current?.remove();
            layerRef.current = null;
            return undefined;
        }
        if (!layerRef.current) {
            layerRef.current = createSatelliteLayer({ opacity: opacity / 100 }).addTo(map);
        } else {
            layerRef.current.setOpacity(opacity / 100);
        }
        return undefined;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [active, opacity, ready]);
    // Map torn down (e.g. the mini-map closes): drop the reference.
    useEffect(() => () => { layerRef.current = null; }, []);
}
