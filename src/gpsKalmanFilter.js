/**
 * GPSKalmanFilter
 * Smooths a raw lat/lng GPS stream using each fix's own reported accuracy
 * as its measurement noise. Bad fixes (high accuracy value = more error)
 * are automatically trusted less; good fixes are trusted more. Outputs a
 * continuously-updated smoothed position plus an implied confidence radius,
 * with no arbitrary distance threshold required.
 *
 * Usage:
 *   const filter = new GPSKalmanFilter({ processNoise: 3 });
 *   const smoothed = filter.process(lat, lng, accuracyMeters, Date.now());
 *   // smoothed = { lat, lng, accuracy }
 */
class GPSKalmanFilter {
    /**
     * @param {Object} opts
     * @param {number} opts.processNoise - Expected drift speed in metres/second
     *   while "coasting" between fixes (i.e. how fast you assume the true
     *   position can wander when you're not getting new information).
     *   Higher = filter trusts new fixes more / reacts faster.
     *   Lower  = filter smooths harder / reacts slower.
     *   Typical range: 1 (very smooth, walking pace) to 6 (fast-moving, e.g. biking).
     */
    constructor({ processNoise = 3 } = {}) {
        this.Q = processNoise; // metres/second of assumed drift
        this.timestampMs = null;
        this.lat = null;
        this.lng = null;
        this.variance = -1; // -1 means "not initialized yet"
    }

    /**
     * Feed one raw GPS fix in, get one smoothed fix out.
     * @param {number} latMeasurement
     * @param {number} lngMeasurement
     * @param {number} accuracyMeters - the accuracy value the Geolocation API reported for this fix
     * @param {number} timestampMs - Date.now() (or event.timestamp) for this fix
     * @param {number} [processNoise] - override the drift speed (m/s) for THIS
     *   fix only. Lets the caller loosen the filter while the user is moving
     *   (a random-walk model lags badly behind a walking person) and tighten
     *   it while they stand still.
     * @returns {{lat: number, lng: number, accuracy: number}}
     */
    process(latMeasurement, lngMeasurement, accuracyMeters, timestampMs, processNoise = this.Q) {
        const accuracy = Math.max(1, accuracyMeters); // clamp: never trust "0m accuracy" fully

        if (this.variance < 0) {
            // First fix ever: just adopt it as-is, no smoothing possible yet.
            this.timestampMs = timestampMs;
            this.lat = latMeasurement;
            this.lng = lngMeasurement;
            this.variance = accuracy * accuracy;
            return { lat: this.lat, lng: this.lng, accuracy };
        }

        // --- Predict step ---
        // Time has passed since the last fix, so our confidence in the old
        // estimate decays a bit, scaled by how fast we assume the user can move.
        const dtSeconds = Math.max(0.001, (timestampMs - this.timestampMs) / 1000);
        this.timestampMs = timestampMs;
        this.variance += dtSeconds * processNoise * processNoise;

        // --- Update step ---
        // Kalman gain: how much to trust the new fix vs. the current estimate.
        // If the new fix's accuracy is bad (large accuracy value), K shrinks
        // and the new fix is blended in gently. If it's good, K grows toward 1
        // and the estimate snaps closer to the new fix.
        const K = this.variance / (this.variance + accuracy * accuracy);
        this.lat += K * (latMeasurement - this.lat);
        this.lng += K * (lngMeasurement - this.lng);
        this.variance = (1 - K) * this.variance;

        return { lat: this.lat, lng: this.lng, accuracy: Math.sqrt(this.variance) };
    }

    /** Call this if GPS tracking stops and restarts (e.g. tab backgrounded),
     *  so a stale timestamp doesn't cause a huge fake variance jump. */
    reset() {
        this.timestampMs = null;
        this.variance = -1;
    }
}

export default GPSKalmanFilter;
