// Working out one route, shared by the route worker (off the main thread) and its in-page fallback
// (routeService.js). Pure: plain data in, plain data out, so it can run in a Web Worker.
import { computeRoute, pathwayWaypoints } from './pathfinding.js';
import { routeToBuilding } from './buildingDestinations.js';
import { shadeMap } from './shadeRouting.js';

/**
 * The map as the solver keeps it between requests: the parts computeRoute needs, the walkway points a
 * building route may end at, and the shade worked out for the last sun time asked for.
 * @param {{ nodes, walls, links, buildings, bridges, pathways, objects }} map
 */
export function prepareMap(map) {
    return { ...map, walkNodes: [...(map.nodes || []), ...pathwayWaypoints(map.pathways || [])], shade: { at: null, map: null } };
}

/**
 * The route for one request: to a place (destId) or to a whole building (buildingId: the best of its
 * doors). `shade` is { at (ms), penalty, lat, lng } on a hot day: buildings, trees and sheds shade the
 * paths at that sun time (worked out once per sun time, not per request).
 */
export function solveRoute(m, req) {
    let shade = null;
    if (req.shade) {
        if (m.shade.at !== req.shade.at) m.shade = { at: req.shade.at, map: shadeMap(m.buildings, new Date(req.shade.at), req.shade.lat, req.shade.lng, m.objects) };
        shade = m.shade.map ? { map: m.shade.map, penalty: req.shade.penalty } : null;
    }
    const routeTo = (target) => computeRoute(m.nodes, target, req.lat, req.lng, 0, m.walls, {
        rainMultiplier: req.rainMultiplier,
        rainNow: req.rainNow,
        heatNow: req.heatNow,
        shade,
        userFloor: req.userFloor,
        links: m.links,
        buildings: m.buildings,
        bridges: m.bridges,
        pathways: m.pathways,
        closedBuildingIds: req.closedBuildingIds,
    });
    const target = req.buildingId != null ? (m.buildings || []).find((b) => b.id === req.buildingId) : null;
    return target ? routeToBuilding(target, m.walkNodes, routeTo) : routeTo(req.destId);
}
