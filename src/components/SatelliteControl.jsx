import React, { useId } from 'react';
import { C, TYPE, TAP, PILL } from '../uiTokens';
import { SATELLITE_ATTRIBUTION } from '../campusMap';

// ── Map / Satellite toggle + photo opacity ─────────────────────────
// One control for /map and the 3D view's mini-map (the admin map uses its
// View menu rows, same settings). The slider fades the aerial photo over the
// vector map, so drawn buildings and paths can be checked against reality.
// Offline: disabled with a short note (imagery is online only).

export const SATELLITE_CSS = `
    .sat-ctl { display: flex; flex-direction: column; gap: 8px; }
    .sat-ctl .seg { width: 100%; }
    .sat-ctl .seg > button { min-height: ${TAP.minHeight}; }
    .sat-row { display: flex; align-items: center; gap: 10px; animation: uiFadeUp var(--dur-base) var(--ease-out) both; }
    .sat-row label { flex: none; font-size: ${TYPE.desc}; font-weight: 600; color: ${C.muted}; }
    .sat-row input[type="range"] { flex: 1; min-width: 0; height: ${TAP.minHeight}; accent-color: ${C.primary}; cursor: pointer; }
    .sat-row input[type="range"]:focus-visible { outline: ${TAP.focusOutline}; outline-offset: 2px; border-radius: 6px; }
    .sat-row output { flex: none; min-width: 40px; text-align: right; font-size: ${TYPE.desc}; font-weight: 700; color: ${C.text}; font-variant-numeric: tabular-nums; }
    .sat-credit { font-size: ${TYPE.desc}; line-height: 1.35; color: ${C.muted}; }
`;

export default function SatelliteControl({ settings, compact = false }) {
    const id = useId();
    const { on, opacity, online, setOn, setOpacity } = settings;
    return (
        <div className="sat-ctl">
            <div
                className="seg" role="radiogroup" aria-label="Base map"
                // Offline is normal use (map, routes and GPS all work), so no warning on screen:
                // Satellite just greys out, and hovering explains why.
                title={online ? undefined : 'Aerial photos need internet. The map, routes and your GPS location work offline.'}
                style={{ '--seg-i': on && online ? 1 : 0, '--seg-n': 2, opacity: online ? 1 : 0.55 }}
            >
                <span className="seg-thumb" aria-hidden="true" />
                <button type="button" role="radio" aria-checked={!on || !online} onClick={() => setOn(false)}>Map</button>
                <button type="button" role="radio" aria-checked={on && online} onClick={() => setOn(true)} disabled={!online}>Satellite</button>
            </div>
            {online && on && (
                <div className="sat-row">
                    <label htmlFor={`${id}-op`}>Photo</label>
                    <input
                        id={`${id}-op`} type="range" min="0" max="100" step="5" value={opacity}
                        onChange={(e) => setOpacity(e.target.value)}
                        aria-valuetext={`${opacity}% photo`}
                    />
                    <output htmlFor={`${id}-op`}>{opacity}%</output>
                </div>
            )}
            {online && on && !compact && <div className="sat-credit">{SATELLITE_ATTRIBUTION}</div>}
        </div>
    );
}
