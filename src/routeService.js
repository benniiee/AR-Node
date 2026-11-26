// Routes without freezing the screen. A route takes up to a few hundred milliseconds on a phone (a
// Dijkstra over the walking graph, checked against every wall), and it used to run on the main thread on
// every GPS fix, so the 3D view and the camera stuttered each time. RouteService runs it in a Web Worker:
// the map goes to the worker once (and again only when it changes), each request then carries just the
// position and the conditions, and only the newest request counts (an older one still waiting is answered
// with null). Without workers (an old browser, a worker file that could not load offline, Node tests) it
// works the route out in the page instead, the same way (routeSolver.js).
import { prepareMap, solveRoute } from './routeSolver.js';
import { toLocalMeters } from './geo.js';

/** Moving less than this (metres) with nothing else changed keeps the route shown: GPS jitter is not a reason. */
export const REROUTE_MOVE_M = 2;

/**
 * Should a new route be worked out? Yes when anything but the position changed (destination, floor, weather,
 * closures, the map), or when the position moved at least REROUTE_MOVE_M since the last one.
 * @param {{ key: string, mapKey: object, lat: number, lng: number } | null} last
 * @param {{ key: string, mapKey: object, lat: number, lng: number }} next
 */
export function shouldReroute(last, next, minMoveM = REROUTE_MOVE_M) {
    if (!last || last.key !== next.key || last.mapKey !== next.mapKey) return true;
    const [e, n] = toLocalMeters(next.lat, next.lng, last.lat, last.lng);
    return Math.hypot(e, n) >= minMoveM;
}

const defaultWorker = () => new Worker(new URL('./routeWorker.js', import.meta.url), { type: 'module' });

export class RouteService {
    constructor(createWorker = defaultWorker) {
        this.latest = 0;
        this.waiting = new Map();
        this.parts = null;
        this.local = null;
        try {
            this.worker = createWorker();
        } catch {
            this.worker = null;
        }
        if (this.worker) {
            this.worker.onmessage = ({ data }) => this.settle(data.id, data);
            // The worker could not start (offline without its file): carry on in the page.
            this.worker.onerror = () => this.fallBack();
        }
    }

    /** The map to route on: sent to the worker only when one of its parts changed. */
    setMap(parts) {
        const keys = ['nodes', 'walls', 'links', 'buildings', 'bridges', 'pathways', 'objects'];
        if (this.parts && keys.every((k) => this.parts[k] === parts[k])) return;
        this.parts = parts;
        this.local = null;
        this.worker?.postMessage({ type: 'map', map: parts });
    }

    /** The route for `req` (routeSolver.solveRoute), or null when a newer request replaced it. */
    route(req) {
        this.latest += 1;
        const id = this.latest;
        this.cancel(id);
        return new Promise((resolve, reject) => {
            this.waiting.set(id, { req, resolve, reject });
            if (this.worker) this.worker.postMessage({ type: 'route', id, req });
            else Promise.resolve().then(() => this.solveHere(id));
        });
    }

    /** Answer every request older than `keepId` with null (all of them without an argument). */
    cancel(keepId = Infinity) {
        for (const [id, w] of this.waiting) {
            if (id < keepId) {
                w.resolve(null);
                this.waiting.delete(id);
            }
        }
    }

    dispose() {
        this.cancel();
        this.worker?.terminate();
        this.worker = null;
    }

    settle(id, data) {
        const w = this.waiting.get(id);
        if (!w) return;
        this.waiting.delete(id);
        if (data.error) w.reject(new Error(data.error));
        else w.resolve(data.result);
    }

    solveHere(id) {
        const w = this.waiting.get(id);
        if (!w) return;
        try {
            if (!this.local) this.local = prepareMap(this.parts || {});
            this.settle(id, { result: solveRoute(this.local, w.req) });
        } catch (err) {
            this.settle(id, { error: err?.message || 'Route failed' });
        }
    }

    fallBack() {
        this.worker?.terminate();
        this.worker = null;
        for (const id of [...this.waiting.keys()]) this.solveHere(id);
    }
}
