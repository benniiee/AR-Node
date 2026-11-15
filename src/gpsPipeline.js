// Raw GPS fix → Kalman smoothing → map matching, in one place.
//
//   const pipe = new GpsPipeline();
//   const fix = pipe.process(pos, { nodes, borders });
//
// The returned object is what MobileNav hands to adoptLocation():
//   { latitude, longitude, accuracy (raw), filteredAccuracy, elevation,
//     altitudeAccuracy, source, rawLatitude, rawLongitude, snapped, snapOffsetM }
// The raw coordinates stay on the object so the debug HUD can show how far
// the filter + snap moved the dot.
import GPSKalmanFilter from './gpsKalmanFilter.js';
import { toLocalMeters } from './geo.js';
import { snapToWalkGraph } from './mapMatch.js';

// A new fix farther than this from the filter's estimate (and than 5× its own
// reported accuracy) is a relocation / stale-cache correction, not noise.
// Reset instead of dragging the dot across campus over many fixes.
const JUMP_RESET_MIN_M = 60;

export default class GpsPipeline {
    constructor({ processNoise = 4, enableFilter = true, enableMapMatch = true } = {}) {
        this.filter = new GPSKalmanFilter({ processNoise });
        this.enableFilter = enableFilter;
        this.enableMapMatch = enableMapMatch;
        this.prevEdgeKey = null;
    }

    reset() {
        this.filter.reset();
        this.prevEdgeKey = null;
    }

    /**
     * @param {GeolocationPosition} pos
     * @param {{nodes?: Array, borders?: Array}} [ctx]
     * @returns {object|null} fix, or null for an unusable position
     */
    process(pos, { nodes = [], borders = [] } = {}) {
        const { latitude, longitude, accuracy, altitude, altitudeAccuracy } = pos.coords;
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
        const acc = Number.isFinite(accuracy) ? accuracy : 50;
        const ts = Number.isFinite(pos.timestamp) ? pos.timestamp : Date.now();

        let lat = latitude;
        let lng = longitude;
        let filteredAcc = acc;

        if (this.enableFilter) {
            const est = this.filter.lat === null ? null : { lat: this.filter.lat, lng: this.filter.lng };
            if (est && this.filter.variance >= 0) {
                const [e, n] = toLocalMeters(latitude, longitude, est.lat, est.lng);
                if (Math.hypot(e, n) > Math.max(JUMP_RESET_MIN_M, acc * 5)) this.filter.reset();
            }
            // Speed-adaptive drift: still → heavy smoothing, walking → follow
            // the user closely. Without this a position-only filter trails a
            // walking person by several metres. Falls back to the constructor
            // default when the device reports no speed.
            const speed = pos.coords.speed;
            const q = Number.isFinite(speed) ? Math.min(8, Math.max(1.5, 1.5 + 3 * speed)) : undefined;
            const s = this.filter.process(latitude, longitude, acc, ts, q);
            lat = s.lat;
            lng = s.lng;
            filteredAcc = s.accuracy;
        }

        let snapped = false;
        let snapOffsetM = 0;
        if (this.enableMapMatch && nodes.length > 0) {
            const m = snapToWalkGraph({ latitude: lat, longitude: lng, accuracy: acc }, nodes, borders, { prevEdgeKey: this.prevEdgeKey });
            this.prevEdgeKey = m.edgeKey;
            if (m.snapped) {
                lat = m.latitude;
                lng = m.longitude;
                snapped = true;
                snapOffsetM = m.offsetM;
            }
        }

        return {
            latitude: lat,
            longitude: lng,
            // Deliberately the RAW reported accuracy: the filter's own
            // posterior assumes independent errors, but GPS errors are
            // strongly time-correlated, so it is over-confident. The accuracy
            // circles and the "placement approximate" warning must not shrink
            // just because we averaged. The filter's figure is kept apart.
            accuracy: acc,
            filteredAccuracy: filteredAcc,
            elevation: Number.isFinite(altitude) ? altitude : undefined,
            altitudeAccuracy: Number.isFinite(altitudeAccuracy) ? altitudeAccuracy : undefined,
            source: 'gps',
            // Ground speed (m/s) and true-north course (deg) from the receiver.
            // The AR view uses them to learn the compass error while walking.
            speed: Number.isFinite(pos.coords.speed) ? pos.coords.speed : undefined,
            course: Number.isFinite(pos.coords.heading) ? pos.coords.heading : undefined,
            rawLatitude: latitude,
            rawLongitude: longitude,
            snapped,
            snapOffsetM,
        };
    }
}
