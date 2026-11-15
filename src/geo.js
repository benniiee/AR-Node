// Dependency-free geodesy helpers shared by the AR math, pathfinding,
// map matching and the 2D screens.
//
// Why this exists: the code used to treat 111320 m as "metres per degree" in
// BOTH directions. That figure is the length of a degree of LONGITUDE at the
// equator. A degree of LATITUDE is ~110.57 km at the equator and ~111.69 km
// at the poles, so north-south distances were ~0.7 % too long near the
// equator (≈0.7 m per 100 m). These are the standard WGS84 series
// (NIMA TR8350.2 / Bowring), accurate to well under a millimetre per degree.

const DEG = Math.PI / 180;

/**
 * Metres per degree of latitude and longitude at a given latitude (WGS84).
 * @param {number} latDeg
 * @returns {{ mLat: number, mLng: number }}
 */
export function metersPerDegree(latDeg) {
    const p = latDeg * DEG;
    const mLat = 111132.92 - 559.82 * Math.cos(2 * p) + 1.175 * Math.cos(4 * p) - 0.0023 * Math.cos(6 * p);
    const mLng = 111412.84 * Math.cos(p) - 93.5 * Math.cos(3 * p) + 0.118 * Math.cos(5 * p);

    return { mLat, mLng };
}

/**
 * Flat-earth local tangent plane offset of (lat, lng) from a reference point.
 * @returns {[number, number]} [east, north] in metres
 */
export function toLocalMeters(lat, lng, refLat, refLng) {
    const { mLat, mLng } = metersPerDegree(refLat);

    return [(lng - refLng) * mLng, (lat - refLat) * mLat];
}

/**
 * Inverse of toLocalMeters: move `east` / `north` metres from a reference.
 * @returns {{ latitude: number, longitude: number }}
 */
export function fromLocalMeters(refLat, refLng, east, north) {
    const { mLat, mLng } = metersPerDegree(refLat);

    return {
        latitude: refLat + north / mLat,
        longitude: refLng + (mLng === 0 ? 0 : east / mLng),
    };
}
