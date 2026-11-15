// Mobile client API helper (no auth — map data and routing are public).
//
// Set VITE_API_BASE_URL=https://<dev-machine-LAN-IP>:8443 when the app is
// served from a different origin than the backend (phone on LAN). When
// served same-origin (Vite dev), the empty default keeps relative URLs.

import { downloadOfflineData, loadMapData } from './offlineData.js';
import { offlineStore } from './offlineStore.js';

const API_BASE = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');
export { API_BASE };

// ngrok's free plan answers a request that lacks its cookie with its "You are about
// to visit" page (HTML, not JSON). Safari on iPhone does not keep that cookie the way
// Chrome does, so the map data came back as that page and the app said "could not
// load". This header skips the page. It is always sent to our own server (a
// same-origin custom header needs no CORS check and any other host ignores it, as
// the service worker already does); to a separate API host (VITE_API_BASE_URL) only
// with VITE_TUNNEL=ngrok, because there it would trigger a CORS preflight.
export const TUNNEL_HEADERS = (API_BASE === '' || import.meta.env.VITE_TUNNEL === 'ngrok')
    ? { 'ngrok-skip-browser-warning': 'true' } : {};

/** Map for the 2D screen: the network (static file, then API), or the saved offline copy. */
// `headers` carries the student's bearer token when signed in: the server then
// sends the full map; without it the visitor view (building locations only).
export const loadMap = (headers = TUNNEL_HEADERS) => loadMapData({ base: API_BASE, headers, store: offlineStore });

/** Saves the map and the rain status on this phone (called automatically by useAutoSync). */
export const downloadForOffline = (headers = TUNNEL_HEADERS) => downloadOfflineData({ base: API_BASE, headers, store: offlineStore });

// Build tag: proves on-device which bundle is running (stale-cache triage).
// Bump on every user-facing deploy; shown on the 3D view's start screen.
export const APP_TAG = 'v12-pov';

export async function getMapData() {
    const url = `${API_BASE}/api/map-data`;
    let res;
    try {
        res = await fetch(url, {
            headers: TUNNEL_HEADERS,
        });
    } catch (err) {
        throw new Error(`Cannot reach ${url || '/api/map-data'} (${err.message}). Is the backend running and is this device on the same Wi-Fi as it?`);
    }
    if (!res.ok) {
        throw new Error(`Map data request failed (HTTP ${res.status}) at ${url}`);
    }

    return res.json();
}
