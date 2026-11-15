// Shared "you are here" motion + POV (field-of-view) helpers for every 2D map:
// the admin/faculty map, the student 2D map and the 3D view's mini-map.
//
//   SmoothPoint  - glides a lat/lng toward each new GPS fix (no teleporting).
//   SmoothAngle  - glides a compass angle toward each new heading, always by
//                  the short way round (359° → 1° is a 2° turn, not 358°).
//   createPovIcon- the ~70° wedge drawn under the dot (same look everywhere).
//   createHeadingListener - deviceorientation → heading, for screens that
//                  don't already own that plumbing (the admin map).
//
// Both followers use frame-rate-independent exponential smoothing: each
// frame moves a fixed fraction of the remaining gap, derived from elapsed
// time. A new fix mid-glide simply retargets (no restart, no pile-up), and a
// small `tau` makes the dot catch up fast instead of trailing the user.
import L from 'leaflet';
import { headingFromOrientationEvent, headingAccuracyFromEvent } from './heading.js';

const raf = (fn) => (typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame(fn)
    : setTimeout(() => fn(Date.now()), 16));
const caf = (id) => (typeof cancelAnimationFrame === 'function'
    ? cancelAnimationFrame(id)
    : clearTimeout(id));
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

const reducedMotion = () => typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ~55 m of latitude. A fix this far from where the dot is drawn is a
// relocation (manual pin, first fix, GPS correction), not a step — gliding
// across campus for it would look like a bug, so the dot jumps instead.
const SNAP_DEG = 0.0005;
// Stop the animation loop once within ~5 mm (far below one pixel at max zoom).
const EPS_DEG = 5e-8;

/**
 * Eased lat/lng follower.
 *
 *   const dot = new SmoothPoint({ tau: 0.12, onUpdate: (lat, lng) => marker.setLatLng([lat, lng]) });
 *   dot.moveTo(lat, lng);        // first call snaps, later calls glide
 *   dot.current                  // {lat, lng} as drawn right now
 *   dot.destroy();               // on unmount
 */
export class SmoothPoint {
    /**
     * @param {object} o
     * @param {number} [o.tau]  Time constant in seconds: ~63% of the gap is
     *   closed after `tau`, ~95% after 3·tau. 0.12 reaches the new fix in
     *   about a third of a second.
     * @param {(lat:number,lng:number)=>void} o.onUpdate  Paints the position.
     */
    constructor({ tau = 0.12, onUpdate }) {
        this.tau = tau;
        this.onUpdate = onUpdate;
        this.lat = null;
        this.lng = null;
        this.tLat = null;
        this.tLng = null;
        this.raf = null;
        this.last = 0;
        this.dead = false;
        this.tick = this.tick.bind(this);
    }

    get current() {
        return this.lat === null ? null : { lat: this.lat, lng: this.lng };
    }

    /** Place immediately, cancelling any glide in progress. */
    snapTo(lat, lng) {
        if (this.dead || !Number.isFinite(lat) || !Number.isFinite(lng)) return;
        this.lat = lat; this.lng = lng;
        this.tLat = lat; this.tLng = lng;
        this.paint();
    }

    /** Glide toward a new fix. The very first fix (or a far jump) snaps. */
    moveTo(lat, lng) {
        if (this.dead || !Number.isFinite(lat) || !Number.isFinite(lng)) return;
        if (this.lat === null
            || reducedMotion()
            || Math.abs(lat - this.lat) > SNAP_DEG
            || Math.abs(lng - this.lng) > SNAP_DEG) {
            this.snapTo(lat, lng);
            return;
        }
        this.tLat = lat; this.tLng = lng;
        if (this.raf === null) {
            this.last = now();
            this.raf = raf(this.tick);
        }
    }

    paint() {
        try { this.onUpdate(this.lat, this.lng); } catch { /* marker gone mid-frame */ }
    }

    tick(t) {
        this.raf = null;
        if (this.dead) return;
        const tNow = now();
        // Clamp dt so a backgrounded tab resuming doesn't take one giant step.
        const dt = Math.min(0.25, Math.max(0.001, (tNow - this.last) / 1000));
        this.last = tNow;
        const k = 1 - Math.exp(-dt / this.tau);
        this.lat += (this.tLat - this.lat) * k;
        this.lng += (this.tLng - this.lng) * k;
        if (Math.abs(this.tLat - this.lat) < EPS_DEG && Math.abs(this.tLng - this.lng) < EPS_DEG) {
            this.lat = this.tLat; this.lng = this.tLng;
            this.paint();
            return;
        }
        this.paint();
        this.raf = raf(this.tick);
    }

    destroy() {
        this.dead = true;
        if (this.raf !== null) caf(this.raf);
        this.raf = null;
    }
}

/**
 * Eased compass-angle follower. Keeps a continuous (unwrapped) angle so CSS
 * rotate() never spins the long way, and eases toward each new heading.
 */
export class SmoothAngle {
    /**
     * @param {object} o
     * @param {number} [o.tau]  Seconds. Compass events are noisy and fast
     *   (up to ~60 Hz), so this is shorter than the position tau.
     * @param {(deg:number)=>void} o.onUpdate  Paints the (unwrapped) angle.
     */
    constructor({ tau = 0.08, onUpdate }) {
        this.tau = tau;
        this.onUpdate = onUpdate;
        this.angle = null;   // drawn, unwrapped
        this.target = null;  // unwrapped
        this.raf = null;
        this.last = 0;
        this.dead = false;
        this.tick = this.tick.bind(this);
    }

    get hasValue() { return this.angle !== null; }

    /** Latest heading, normalised to [0, 360). */
    get heading() {
        return this.target === null ? null : ((this.target % 360) + 360) % 360;
    }

    /** @param {number} deg any heading; wrap-around is handled here */
    set(deg) {
        if (this.dead || !Number.isFinite(deg)) return;
        if (this.angle === null) {
            this.angle = deg; this.target = deg;
            this.paint();
            return;
        }
        // The 360°-equivalent of `deg` nearest the current angle.
        this.target = deg + 360 * Math.round((this.angle - deg) / 360);
        if (reducedMotion()) {
            this.angle = this.target;
            this.paint();
            return;
        }
        if (this.raf === null) {
            this.last = now();
            this.raf = raf(this.tick);
        }
    }

    paint() {
        try { this.onUpdate(this.angle); } catch { /* element gone mid-frame */ }
    }

    tick() {
        this.raf = null;
        if (this.dead) return;
        const tNow = now();
        const dt = Math.min(0.25, Math.max(0.001, (tNow - this.last) / 1000));
        this.last = tNow;
        const k = 1 - Math.exp(-dt / this.tau);
        this.angle += (this.target - this.angle) * k;
        if (Math.abs(this.target - this.angle) < 0.05) {
            this.angle = this.target;
            this.paint();
            return;
        }
        this.paint();
        this.raf = raf(this.tick);
    }

    destroy() {
        this.dead = true;
        if (this.raf !== null) caf(this.raf);
        this.raf = null;
    }
}

/**
 * The POV wedge: a ~70° field-of-view cone, drawn pointing north and rotated
 * to the live heading by writing `rotate(..)` onto `.pov-rot` (never the
 * outer element — Leaflet owns that transform). Geometry is identical to
 * the student map: centre (48,48), r 38, ±35° either side of north.
 *
 * No CSS transition here on purpose: SmoothAngle already eases the rotation,
 * and stacking a CSS transition on top makes the cone lag and overshoot.
 *
 * @param {object} [o]
 * @param {string} [o.className] Leaflet icon class (admin uses
 *   'user-marker-icon' so the wedge hides with the dot while a tool is active)
 */
export function createPovIcon({ className = '' } = {}) {
    return L.divIcon({
        className,
        html: '<div class="pov-rot" style="width:96px;height:96px;transform:rotate(0deg);transition:none;pointer-events:none;will-change:transform;">'
            + '<svg width="96" height="96" viewBox="0 0 96 96" aria-hidden="true">'
            + '<path d="M48 48 L26.2 16.87 A38 38 0 0 1 69.8 16.87 Z" fill="rgba(255,255,255,0.16)" stroke="rgba(255,255,255,0.8)" stroke-width="1.5" stroke-linejoin="round"/>'
            + '</svg></div>',
        iconSize: [96, 96],
        iconAnchor: [48, 48],
    });
}

/** Paint a rotation onto a POV marker's `.pov-rot` element (no-op if absent). */
export function paintPovRotation(marker, deg) {
    const rot = marker?.getElement?.()?.querySelector('.pov-rot');
    if (rot) rot.style.transform = `rotate(${deg}deg)`;
}

const HAS_COMPASS_PROMPT = typeof DeviceOrientationEvent !== 'undefined'
    && typeof DeviceOrientationEvent.requestPermission === 'function';

/**
 * Heading subscription with the same rules the student map follows:
 *  - 'deviceorientationabsolute' is the trustworthy frame; the relative
 *    stream only bootstraps devices that never send the absolute one, and is
 *    ignored once absolute has spoken (mixing frames spins the cone);
 *  - iOS needs the permission prompt raised from inside a real tap;
 *  - on Chrome/Android a tap re-arms a stalled stream.
 * Desktop browsers simply never fire these events, so no heading ever
 * arrives and callers draw no cone — nothing to special-case.
 *
 * @param {object} o
 * @param {(deg:number, e:Event)=>void} o.onHeading  heading in [0, 360)
 * @returns {{ start: ()=>void, stop: ()=>void, prompt: ()=>void }}
 */
export function createHeadingListener({ onHeading }) {
    let handlers = null;
    let absoluteSeen = false;
    let askedPermission = false;
    let attachAt = 0;
    let lastEventAt = 0;
    let gestureBound = false;

    const attach = () => {
        if (handlers) return;
        const onAbsolute = (e) => {
            const h = headingFromOrientationEvent(e);
            if (h === null || Number.isNaN(h)) return;
            absoluteSeen = true;
            lastEventAt = now();
            onHeading(((h % 360) + 360) % 360, e);
        };
        const onRelative = (e) => {
            const h = headingFromOrientationEvent(e);
            if (h === null || Number.isNaN(h)) return;
            if (absoluteSeen) return;
            lastEventAt = now();
            onHeading(((h % 360) + 360) % 360, e);
        };
        window.addEventListener('deviceorientationabsolute', onAbsolute, true);
        window.addEventListener('deviceorientation', onRelative, true);
        handlers = { onAbsolute, onRelative };
        attachAt = now();
    };

    const detach = () => {
        if (!handlers) return;
        window.removeEventListener('deviceorientationabsolute', handlers.onAbsolute, true);
        window.removeEventListener('deviceorientation', handlers.onRelative, true);
        handlers = null;
    };

    // iOS only allows the permission prompt from inside a real tap.
    const askPermission = () => {
        if (!HAS_COMPASS_PROMPT || askedPermission) return;
        askedPermission = true;
        try {
            const asked = DeviceOrientationEvent.requestPermission();
            if (asked && typeof asked.then === 'function') {
                asked.then((res) => {
                    if (res === 'granted') { detach(); attach(); }
                }).catch(() => { askedPermission = false; });
            }
        } catch { askedPermission = false; }
    };

    const onGesture = () => {
        askPermission();
        const t = now();
        const silentFor = lastEventAt === 0 ? Infinity : t - lastEventAt;
        const throttle = lastEventAt === 0 ? 500 : 1500;
        if (silentFor > throttle && t - attachAt > throttle) {
            detach();
            attach();
        }
    };

    return {
        start() {
            attach();
            if (gestureBound) return;
            gestureBound = true;
            window.addEventListener('pointerdown', onGesture, true);
            window.addEventListener('focus', onGesture);
        },
        /** Call from a click/tap handler (e.g. the "My location" button). */
        prompt: askPermission,
        stop() {
            detach();
            if (!gestureBound) return;
            gestureBound = false;
            window.removeEventListener('pointerdown', onGesture, true);
            window.removeEventListener('focus', onGesture);
        },
    };
}

// Re-exported so callers that already import this module for the cone don't
// need a second import for the accuracy helper.
export { headingAccuracyFromEvent };
