// Camera field of view for the classic (non-XR) AR view.
//
// The 3D camera used a fixed 60° vertical FOV. A real phone camera differs,
// AND the <video> is shown with `object-fit: cover`, which crops the stream
// to fill the screen — so what the user sees is a cropped window of the
// sensor's FOV, and the crop changes with screen shape. When the three.js
// FOV doesn't match what's on screen, dots slide against the scene as you
// turn. Browsers don't expose the lens FOV, so we model it:
//
//   1. Assume the stream's LONG side spans `longSideFovDeg` (≈65° is typical
//      of phone main cameras at 4:3 / 16:9 — override per device, below).
//   2. Derive the short side from the pixel aspect ratio (pinhole model).
//   3. Apply the `cover` crop: whichever axis of the stream is cropped, the
//      visible vertical FOV changes accordingly.
export const DEFAULT_LONG_SIDE_FOV_DEG = 65;
const MIN_FOV = 30;
const MAX_FOV = 90;
const STORAGE_KEY = 'arLongSideFovDeg';

const RAD = Math.PI / 180;

/**
 * Per-device override: set localStorage.arLongSideFovDeg = "70" to retune
 * without a rebuild (valid range 40–100). Falls back to the default.
 */
export function getLongSideFovDeg() {
    try {
        const v = Number(window.localStorage.getItem(STORAGE_KEY));
        if (Number.isFinite(v) && v >= 40 && v <= 100) return v;
    } catch { /* storage blocked */ }

    return DEFAULT_LONG_SIDE_FOV_DEG;
}

/**
 * Vertical FOV (degrees) of the part of the video that is actually visible
 * once it's covered into the container.
 *
 * @param {Object} p
 * @param {number} p.videoW  stream width in px, as displayed (portrait → W < H)
 * @param {number} p.videoH
 * @param {number} p.containerW  on-screen element size in px
 * @param {number} p.containerH
 * @param {number} [p.longSideFovDeg]
 * @returns {number|null} FOV in [30, 90], or null when sizes are unknown
 */
export function effectiveVerticalFov({ videoW, videoH, containerW, containerH, longSideFovDeg = DEFAULT_LONG_SIDE_FOV_DEG }) {
    if (!(videoW > 0 && videoH > 0 && containerW > 0 && containerH > 0)) return null;
    const tanLong = Math.tan((longSideFovDeg * RAD) / 2);
    const longPx = Math.max(videoW, videoH);
    const shortPx = Math.min(videoW, videoH);
    const tanShort = (tanLong * shortPx) / longPx;
    const tanH = videoW >= videoH ? tanLong : tanShort; // full-frame horizontal
    const tanV = videoW >= videoH ? tanShort : tanLong; // full-frame vertical

    const videoAspect = videoW / videoH;
    const containerAspect = containerW / containerH;
    // Container relatively taller/narrower than the video: the video is scaled
    // to fit the HEIGHT and cropped at the sides → full vertical FOV remains.
    // Otherwise it is scaled to fit the WIDTH and cropped top/bottom.
    const tanVisible = containerAspect <= videoAspect ? tanV : tanH / containerAspect;
    const fov = (2 * Math.atan(tanVisible)) / RAD;

    return Math.min(MAX_FOV, Math.max(MIN_FOV, fov));
}
