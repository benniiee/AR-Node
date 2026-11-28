// The route worker: works out routes off the main thread (routeService.js), so the map, the 3D view
// and the camera keep moving while the search runs. Keeps the map between requests; each request carries
// only the position and the conditions.
import { prepareMap, solveRoute } from './routeSolver.js';

let map = null;
let arrival = 0;

self.onmessage = ({ data }) => {
    if (data.type === 'map') {
        map = prepareMap(data.map);
        return;
    }
    if (data.type === 'route') {
        const { id, req } = data;
        const ticket = ++arrival;
        // A worker handles one message at a time, so a request that is already computing holds up the
        // newer one queued behind it. Waiting one turn lets that newer request arrive first: this one is
        // then already answered with null by the route service and is skipped instead of being worked out
        // (and then thrown away) on a phone that is walking.
        setTimeout(() => {
            // A newer route request has replaced this one (routeService already answered it with null).
            if (ticket !== arrival) return;
            try {
                self.postMessage({ id, result: map ? solveRoute(map, req) : null });
            } catch (err) {
                self.postMessage({ id, error: err?.message || 'Route failed' });
            }
        }, 0);
    }
};
