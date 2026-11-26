// The route worker: works out routes off the main thread (routeService.js), so the map, the 3D view
// and the camera keep moving while Dijkstra runs. Keeps the map between requests; each request carries
// only the position and the conditions.
import { prepareMap, solveRoute } from './routeSolver.js';

let map = null;

self.onmessage = ({ data }) => {
    if (data.type === 'map') {
        map = prepareMap(data.map);
        return;
    }
    if (data.type === 'route') {
        try {
            self.postMessage({ id: data.id, result: map ? solveRoute(map, data.req) : null });
        } catch (err) {
            self.postMessage({ id: data.id, error: err?.message || 'Route failed' });
        }
    }
};
