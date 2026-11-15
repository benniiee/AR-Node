import L from 'leaflet';

const DESTINATION_PIN_STYLE_ID = 'ar-destination-pin-animation-styles';

/**
 * Install the shared keyframes once. The animated element is nested inside
 * Leaflet's marker element so its transform never overwrites Leaflet's own
 * geographic positioning transform. Respect the device's reduced-motion
 * preference for people who opt out of continuous movement.
 */
function ensureDestinationPinAnimationStyles() {
    if (typeof document === 'undefined' || document.getElementById(DESTINATION_PIN_STYLE_ID)) return;

    const style = document.createElement('style');
    style.id = DESTINATION_PIN_STYLE_ID;
    style.textContent = `
        @keyframes arDestinationPinBob {
            0%, 100% { transform: translate3d(0, 0, 0); }
            50% { transform: translate3d(0, -2.5px, 0); }
        }
        .ar-destination-pin-bob {
            transform-box: fill-box;
            transform-origin: 50% 82%;
            animation: arDestinationPinBob 1.5s ease-in-out 3; /* draws the eye when shown, then rests */
            will-change: transform;
        }
        @media (prefers-reduced-motion: reduce) {
            .ar-destination-pin-bob {
                animation: none !important;
                will-change: auto;
            }
        }
    `;
    (document.head || document.documentElement).appendChild(style);
}

/**
 * Animated destination pin. The solid map-pin silhouette is easier to recognise
 * than an arrow and avoids a secondary dot that could be mistaken for a route
 * node. The subtle vertical bob draws the eye to each destination while staying
 * restrained. The SVG sits inside a wrapper because Leaflet owns the outer
 * marker's geographic positioning transform.
 */
export function createDestinationPinIcon(color = '#22c55e', size = 16, className = '') {
    ensureDestinationPinAnimationStyles();

    const width = size;
    const height = size * (32 / 24);
    // The small-radius bottom cusp reads as a location pin rather than a balloon.
    const tipY = height * (31.1 / 32);

    return L.divIcon({
        className,
        html: `<div style="width:${width}px;height:${height}px;display:block;filter:drop-shadow(0 1px 3px rgba(0,0,0,0.72));pointer-events:none;overflow:visible;">
            <svg class="ar-destination-pin-bob" width="${width}px" height="${height}px" viewBox="0 0 24 32" fill="none" aria-hidden="true" focusable="false" style="display:block;overflow:visible;">
                <path d="M12 1.25C6.05 1.25 1.25 6.01 1.25 11.88c0 7.5 8.88 17.45 10.45 19.2a.39.39 0 0 0 .6 0c1.57-1.75 10.45-11.7 10.45-19.2C22.75 6.01 17.95 1.25 12 1.25Z" fill="${color}" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/>
            </svg>
        </div>`,
        iconSize: [width, height],
        iconAnchor: [width / 2, tipY],
        popupAnchor: [0, -tipY],
    });
}
