import { useCallback, useEffect, useRef, useState } from 'react';
import { downloadForOffline } from './mobileApi.js';
import { offlineStore } from './offlineStore.js';
import { mapSignature, readOfflineMeta } from './offlineData.js';

/**
 * Automatic offline copy (replaces the old "Download for offline" button).
 *
 * The latest campus data (nodes, staircases, walls, buildings, pathways) and
 * the rain status are saved on the phone without anyone tapping anything:
 *   - right after the map first loads,
 *   - every 20 minutes (the server refreshes weather and the map file on the
 *     same beat, see routes/console.php),
 *   - when the phone comes back online, and
 *   - when the app is reopened after more than 20 minutes away.
 *
 * When a sync brings a different map, `onMap(map)` hands it to the screen.
 * `pill` is a short message for the information pill; most syncs are silent,
 * only the moments worth knowing about speak up (first save, map changed,
 * offline / back online, a failure).
 */
export const SYNC_INTERVAL_MS = 20 * 60 * 1000;
/** The one offline notice: short, calm (offline is normal for the installed app). */
export const OFFLINE_NOTE = 'Offline · using saved map';

export function useAutoSync({ onMap, headers, enabled = true }) {
    const [status, setStatus] = useState({ phase: 'idle', savedAt: null, places: null, weatherSaved: false });
    const [pill, setPill] = useState(null); // { text, tone: 'ok'|'info'|'attention'|'error', key }
    const signatureRef = useRef('');
    const savedOnceRef = useRef(false);
    const busyRef = useRef(false);
    const onMapRef = useRef(onMap);
    onMapRef.current = onMap;
    const headersRef = useRef(headers);
    headersRef.current = headers;

    const say = useCallback((text, tone = 'info') => setPill({ text, tone, key: Date.now() }), []);

    // What the phone already has, for the chip before the first sync finishes.
    useEffect(() => {
        readOfflineMeta(offlineStore).then((m) => {
            if (m) {
                savedOnceRef.current = true;
                setStatus((s) => (s.savedAt ? s : { ...s, savedAt: m.savedAt, places: m.nodes, weatherSaved: m.weatherSaved }));
            }
        }).catch(() => {});
    }, []);

    /** Tell the hook which map is on screen (so an identical sync stays silent). */
    const noteMap = useCallback((map) => { signatureRef.current = mapSignature(map); }, []);

    const sync = useCallback(async (reason = 'timer') => {
        // Visitors keep no offline copy: they see building locations only.
        if (!enabled || busyRef.current) return;
        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
            setStatus((s) => ({ ...s, phase: 'offline' }));
            if (reason === 'manual') say(OFFLINE_NOTE, 'info');
            return;
        }
        busyRef.current = true;
        setStatus((s) => ({ ...s, phase: 'syncing' }));
        try {
            const result = await downloadForOffline(headersRef.current);
            // Ask the browser not to evict the copy when storage runs low (best effort).
            try { await navigator.storage?.persist?.(); } catch { /* optional */ }
            const signature = mapSignature(result.map);
            const changed = signatureRef.current !== '' && signature !== signatureRef.current;
            signatureRef.current = signature;
            if (changed || reason === 'online') onMapRef.current?.(result.map);
            setStatus({ phase: 'ok', savedAt: result.savedAt, places: result.nodes, weatherSaved: result.weatherSaved });

            const rain = result.weatherSaved ? ' and the latest weather' : '';
            if (reason === 'online') say('Back online · map updated', 'ok');
            else if (changed) say(`Campus map updated: ${result.nodes} places${rain}.`, 'ok');
            else if (!savedOnceRef.current) say('Saved for offline use', 'ok');
            else if (reason === 'manual') say(`Up to date: ${result.nodes} places${rain}.`, 'ok');
            savedOnceRef.current = true;
        } catch (err) {
            setStatus((s) => ({ ...s, phase: 'error' }));
            if (reason === 'timer') return;
            // No data connection (or the server cannot be reached) is normal for an
            // installed app: say so calmly. Only a real problem with the copy itself
            // (storage blocked, a broken download) is shown as an error.
            const broken = /empty or incomplete|cannot store/i.test(err?.message || '');
            if (broken) say(`${err.message}`, 'error');
            else say(OFFLINE_NOTE, 'info');
        } finally {
            busyRef.current = false;
        }
    }, [say, enabled]);

    // Schedule: every 20 minutes, on reconnect, and on return after a long gap.
    const lastRunRef = useRef(0);
    useEffect(() => {
        if (!enabled) return undefined;
        const run = (reason) => { lastRunRef.current = Date.now(); sync(reason); };
        const timer = setInterval(() => run('timer'), SYNC_INTERVAL_MS);
        const onOnline = () => run('online');
        const onOffline = () => {
            setStatus((s) => ({ ...s, phase: 'offline' }));
            say(OFFLINE_NOTE, 'info');
        };
        const onVisible = () => {
            if (document.visibilityState === 'visible' && Date.now() - lastRunRef.current > SYNC_INTERVAL_MS) run('timer');
        };
        window.addEventListener('online', onOnline);
        window.addEventListener('offline', onOffline);
        document.addEventListener('visibilitychange', onVisible);
        return () => {
            clearInterval(timer);
            window.removeEventListener('online', onOnline);
            window.removeEventListener('offline', onOffline);
            document.removeEventListener('visibilitychange', onVisible);
        };
    }, [sync, say, enabled]);

    const syncNow = useCallback((reason = 'manual') => { lastRunRef.current = Date.now(); return sync(reason); }, [sync]);

    return { status, pill, dismissPill: () => setPill(null), noteMap, syncNow };
}
