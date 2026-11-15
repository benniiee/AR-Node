import React, { useMemo, useRef, useState } from 'react';
import { C, RADIUS } from '../uiTokens';
import StairPreview3D, { STAIR_PREVIEW_CSS } from './StairPreview3D';
import {
    STAIR_SHAPES, STAIR_MAX_FLIGHTS, STAIR_LANDING_MIN, STAIR_LANDING_MAX, STAIR_LANDING_DEFAULT,
    planStairs, fitYaw, shapeIdOf, flightsForShape, normalizeFlights, normalizeBearing, clampLanding,
    clampStairAngle, meanAngle,
} from '../stairGeometry';

// ── Staircase shape editor ───────────────────────────────────────────
// Controlled component. `value` = { angle_deg, yaw_deg (null = not set),
// flights, landing_m }. Every change calls onChange(patch, { final }):
// `final` is false while a control is still being dragged (update the live
// preview only) and true when the change should be saved.

const COMPASS_WORDS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export const compassWord = (bearing) => COMPASS_WORDS[Math.round(normalizeBearing(bearing) / 22.5) % 16];

const TURN_OPTIONS = [
    { v: 0, label: 'Straight on' },
    { v: -90, label: 'Left 90°' },
    { v: 90, label: 'Right 90°' },
    { v: -180, label: 'U-turn left' },
    { v: 180, label: 'U-turn right' },
];

/** Tiny line drawings of each shape, seen from above. */
function ShapeGlyph({ id }) {
    const p = {
        straight: 'M12 20V4M12 4l-3 3M12 4l3 3',
        'straight-landing': 'M12 21V13M12 11V3M9 7l3-4 3 4',
        'l-left': 'M16 21V11H8M8 11l3-3M8 11l3 3',
        'l-right': 'M8 21V11h8M16 11l-3-3M16 11l-3 3',
        'u-left': 'M16 21V8a3 3 0 0 0-6 0v13M10 18l-2 3M10 18l2 3',
        'u-right': 'M8 21V8a3 3 0 0 1 6 0v13M14 18l-2 3M14 18l2 3',
        custom: 'M5 19l4-4 3 3 4-5 3-4M5 19h4',
    }[id];
    return (
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d={p} />
        </svg>
    );
}

/** Draggable compass: the arrow is the direction the FIRST flight heads. */
function CompassDial({ bearing, onChange, disabled }) {
    const ref = useRef(null);
    const [drag, setDrag] = useState(false);
    const b = normalizeBearing(bearing);
    const R = 40;
    const hx = 60 + R * Math.sin((b * Math.PI) / 180);
    const hy = 60 - R * Math.cos((b * Math.PI) / 180);

    const fromEvent = (ev) => {
        const r = ref.current.getBoundingClientRect();
        const dx = ev.clientX - (r.left + r.width / 2);
        const dy = ev.clientY - (r.top + r.height / 2);
        if (Math.hypot(dx, dy) < 4) return null;
        let deg = (Math.atan2(dx, -dy) * 180) / Math.PI;
        if (deg < 0) deg += 360;
        return Math.round(deg);
    };
    const down = (ev) => {
        if (disabled) return;
        ev.currentTarget.setPointerCapture?.(ev.pointerId);
        setDrag(true);
        const v = fromEvent(ev);
        if (v !== null) onChange(v, false);
    };
    const move = (ev) => {
        if (!drag) return;
        const v = fromEvent(ev);
        if (v !== null) onChange(v, false);
    };
    const up = (ev) => {
        if (!drag) return;
        setDrag(false);
        const v = fromEvent(ev);
        onChange(v !== null ? v : Math.round(b), true);
    };
    const key = (ev) => {
        const step = ev.shiftKey ? 15 : 1;
        let next = null;
        if (ev.key === 'ArrowRight' || ev.key === 'ArrowUp') next = b + step;
        else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowDown') next = b - step;
        else return;
        ev.preventDefault();
        onChange(Math.round(normalizeBearing(next)), true);
    };

    return (
        <svg
            ref={ref}
            className={`se-compass${drag ? ' is-dragging' : ''}`}
            viewBox="0 0 120 120"
            role="slider"
            tabIndex={0}
            aria-label="Direction of the first flight, compass heading"
            aria-valuemin={0}
            aria-valuemax={359}
            aria-valuenow={Math.round(b)}
            aria-valuetext={`${Math.round(b)} degrees, ${compassWord(b)}`}
            onPointerDown={down}
            onPointerMove={move}
            onPointerUp={up}
            onPointerCancel={up}
            onKeyDown={key}
        >
            <circle cx="60" cy="60" r="48" fill="rgba(255,255,255,0.04)" stroke={C.muted} strokeWidth="1.2" />
            {[0, 90, 180, 270].map((d) => {
                const x = 60 + 56 * Math.sin((d * Math.PI) / 180);
                const y = 60 - 56 * Math.cos((d * Math.PI) / 180);
                return (
                    <text key={d} x={x} y={y + 3.5} textAnchor="middle" fontSize="10" fontWeight="700" fill={d === 0 ? C.white : C.muted}>
                        {['N', 'E', 'S', 'W'][d / 90]}
                    </text>
                );
            })}
            {Array.from({ length: 24 }, (_, i) => i * 15).map((d) => {
                const long = d % 90 === 0;
                const x1 = 60 + (long ? 40 : 44) * Math.sin((d * Math.PI) / 180);
                const y1 = 60 - (long ? 40 : 44) * Math.cos((d * Math.PI) / 180);
                const x2 = 60 + 48 * Math.sin((d * Math.PI) / 180);
                const y2 = 60 - 48 * Math.cos((d * Math.PI) / 180);
                return <line key={d} x1={x1} y1={y1} x2={x2} y2={y2} stroke={C.muted} strokeWidth="1" opacity="0.7" />;
            })}
            <line x1="60" y1="60" x2={hx} y2={hy} stroke={C.accent} strokeWidth="3" strokeLinecap="round" />
            <circle cx="60" cy="60" r="4" fill={C.white} />
            <circle cx={hx} cy={hy} r="9" fill={C.accent} stroke="#0a0a0c" strokeWidth="2" />
            <path
                d={`M ${hx} ${hy} l ${(5 * Math.sin(((b + 150) * Math.PI) / 180)).toFixed(2)} ${(-5 * Math.cos(((b + 150) * Math.PI) / 180)).toFixed(2)} M ${hx} ${hy} l ${(5 * Math.sin(((b - 150) * Math.PI) / 180)).toFixed(2)} ${(-5 * Math.cos(((b - 150) * Math.PI) / 180)).toFixed(2)}`}
                stroke="#0a0a0c" strokeWidth="2" strokeLinecap="round" fill="none"
            />
        </svg>
    );
}

function Stepper({ label, value, unit, min, max, step, onChange, format }) {
    const set = (v) => onChange(Math.min(max, Math.max(min, Math.round(v * 100) / 100)));
    return (
        <div className="se-stepper">
            <span className="ui-label" style={{ margin: 0 }}>{label}</span>
            <div className="se-step-ctl">
                <button type="button" aria-label={`Decrease ${label}`} disabled={value <= min} onClick={() => set(value - step)}>&minus;</button>
                <output aria-live="polite">{format ? format(value) : value}{unit}</output>
                <button type="button" aria-label={`Increase ${label}`} disabled={value >= max} onClick={() => set(value + step)}>+</button>
            </div>
        </div>
    );
}

/**
 * @param {object}  props.value    { angle_deg, yaw_deg, flights, landing_m }
 * @param {number}  props.rise     height gained, metres (3 if unknown)
 * @param {object} [props.topOffset] { e, n } of the top node from the bottom node, metres
 * @param {string} [props.direction] 'up' | 'down' arrow direction in the preview
 * @param {(patch: object, meta: { final: boolean }) => void} props.onChange
 */
export function StairShapeEditor({ value, rise = 3, topOffset = null, direction = 'up', onChange, previewHeight = 210, wide = false, children }) {
    const flights = useMemo(() => normalizeFlights(value.flights, value.angle_deg), [value.flights, value.angle_deg]);
    const angle = clampStairAngle(value.angle_deg ?? meanAngle(flights));
    const landing = clampLanding(value.landing_m ?? STAIR_LANDING_DEFAULT);
    const shapeId = shapeIdOf(flights);
    const [customOpen, setCustomOpen] = useState(false);
    const showCustom = customOpen || shapeId === 'custom';

    const fitted = useMemo(
        () => (topOffset ? fitYaw({ rise, topOffset, flights, angleDeg: angle, landingM: landing }) : null),
        [rise, topOffset, flights, angle, landing],
    );
    const yawSet = value.yaw_deg !== null && value.yaw_deg !== undefined && value.yaw_deg !== '' && Number.isFinite(Number(value.yaw_deg));
    const yaw = yawSet ? normalizeBearing(value.yaw_deg) : (fitted ?? 0);

    const plan = useMemo(
        () => planStairs({ rise, yawDeg: yaw, flights, angleDeg: angle, landingM: landing }),
        [rise, yaw, flights, angle, landing],
    );
    const gap = topOffset ? Math.hypot(plan.end.e - topOffset.e, plan.end.n - topOffset.n) : null;
    const hasLanding = flights.length > 1;

    const setFlights = (next, final = true) => onChange({
        flights: next.map((f, i) => ({ angle_deg: clampStairAngle(f.angle_deg, angle), turn_deg: i === 0 ? 0 : f.turn_deg })),
        angle_deg: meanAngle(next),
    }, { final });

    const pickShape = (id) => {
        setCustomOpen(false);
        setFlights(flightsForShape(id, angle));
    };
    const setTurn = (index, turn) => setFlights(flights.map((f, i) => (i === index ? { ...f, turn_deg: turn } : f)));
    const addFlight = () => {
        if (flights.length >= STAIR_MAX_FLIGHTS) return;
        setFlights([...flights, { angle_deg: angle, turn_deg: 90 }]);
    };
    const removeFlight = () => {
        if (flights.length <= 1) return;
        setFlights(flights.slice(0, -1));
    };

    return (
        <div className={`se${wide ? ' se-wide' : ''}`}>
            <div className="se-preview">
                <StairPreview3D
                    plan={plan}
                    direction={direction}
                    height={previewHeight}
                    autoRotate
                    ariaLabel={`3D view of ${hasLanding ? `${flights.length}-flight` : 'straight'} stairs heading ${Math.round(yaw)} degrees`}
                />
            </div>
            <div className="se-controls">

            <div className="se-block">
                <span className="ui-label" style={{ margin: 0 }}>Shape</span>
                <div className="se-shapes" role="group" aria-label="Staircase shape">
                    {STAIR_SHAPES.map((s) => (
                        <button
                            key={s.id}
                            type="button"
                            className={`se-chip${shapeId === s.id && !showCustom ? ' is-active' : ''}`}
                            aria-pressed={shapeId === s.id && !showCustom}
                            onClick={() => pickShape(s.id)}
                        >
                            <ShapeGlyph id={s.id} />
                            <span>{s.label}</span>
                        </button>
                    ))}
                    <button
                        type="button"
                        className={`se-chip${showCustom ? ' is-active' : ''}`}
                        aria-pressed={showCustom}
                        onClick={() => setCustomOpen((o) => !o)}
                    >
                        <ShapeGlyph id="custom" />
                        <span>Custom</span>
                    </button>
                </div>
                {showCustom && (
                    <div className="se-custom">
                        <p className="ui-hint" style={{ margin: 0 }}>
                            Walking up: flight 1, then at each landing choose how the stairs turn.
                        </p>
                        {flights.map((f, i) => (
                            <div key={i} className="se-flight-row">
                                <span className="se-flight-no">{i === 0 ? 'Flight 1' : `Landing ${i} → flight ${i + 1}`}</span>
                                {i > 0 && (
                                    <select
                                        className="ui-input"
                                        aria-label={`Turn at landing ${i}`}
                                        value={TURN_OPTIONS.some((o) => o.v === Math.round(f.turn_deg)) ? Math.round(f.turn_deg) : 0}
                                        onChange={(e) => setTurn(i, Number(e.target.value))}
                                    >
                                        {TURN_OPTIONS.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
                                    </select>
                                )}
                            </div>
                        ))}
                        <div className="se-flight-actions">
                            <button type="button" className="ui-btn ui-btn-secondary" disabled={flights.length >= STAIR_MAX_FLIGHTS} onClick={addFlight}>+ Flight</button>
                            <button type="button" className="ui-btn ui-btn-secondary" disabled={flights.length <= 1} onClick={removeFlight}>&minus; Flight</button>
                        </div>
                    </div>
                )}
            </div>

            <div className="se-block se-direction">
                <CompassDial
                    bearing={yaw}
                    onChange={(v, final) => onChange({ yaw_deg: v }, { final })}
                />
                <div className="se-direction-text">
                    <span className="ui-label" style={{ margin: 0 }}>Direction (yaw)</span>
                    <strong className="se-bearing">{Math.round(yaw)}&deg; {compassWord(yaw)}</strong>
                    <p className="ui-hint" style={{ margin: 0 }}>
                        The way the first flight heads when you walk up from the lower floor.
                        {!yawSet && ' Not set yet: it will be read from the two nodes.'}
                    </p>
                    <div className="se-direction-actions">
                        {fitted !== null && (
                            <button type="button" className="ui-btn ui-btn-secondary" onClick={() => onChange({ yaw_deg: fitted }, { final: true })}>
                                Aim at the top node
                            </button>
                        )}
                        {yawSet && (
                            <button type="button" className="ui-btn ui-btn-secondary" onClick={() => onChange({ yaw_deg: null }, { final: true })}>
                                Auto
                            </button>
                        )}
                    </div>
                </div>
            </div>

            {hasLanding && (
                <div className="se-block">
                    <Stepper
                        label="Landing depth"
                        value={landing}
                        unit=" m"
                        min={STAIR_LANDING_MIN}
                        max={STAIR_LANDING_MAX}
                        step={0.2}
                        format={(v) => v.toFixed(1)}
                        onChange={(v) => onChange({ landing_m: v }, { final: true })}
                    />
                </div>
            )}

            {children}

            <p className="se-stats">
                <span><b>{plan.totalLength.toFixed(1)} m</b> to walk</span>
                <span><b>{plan.rise.toFixed(1)} m</b> rise</span>
                {gap !== null && (
                    <span className={gap > 2 ? 'se-warn' : 'se-ok'}>
                        {gap > 2
                            ? `Ends ${gap.toFixed(1)} m from the top node`
                            : 'Ends at the top node'}
                    </span>
                )}
            </p>
            {gap !== null && gap > 2 && (
                <p className="ui-hint" style={{ margin: 0 }}>
                    The drawn stairs finish away from the node you linked. Aim at the top node, change the
                    shape or slope, or move the node so the two agree.
                </p>
            )}
            </div>
        </div>
    );
}

export const STAIR_EDITOR_CSS = `
    ${STAIR_PREVIEW_CSS}
    .se { display: flex; flex-direction: column; gap: 12px; }
    .se-controls { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
    .se-wide { display: grid; grid-template-columns: minmax(0, 1.05fr) minmax(0, 1fr); gap: 20px; align-items: start; }
    .se-wide .se-preview { position: sticky; top: 0; }
    /* Fill the dialog body (dialog height minus header, footer and padding) so nothing is left empty under the preview. */
    .se-wide .stair3d { height: max(340px, calc(min(92vh, 860px) - 190px)) !important; }
    @media (max-width: 760px) {
        .se-wide { grid-template-columns: minmax(0, 1fr); gap: 14px; }
        .se-wide .se-preview { position: static; }
        .se-wide .stair3d { height: 230px !important; }
    }
    .se-block { display: flex; flex-direction: column; gap: 8px; }
    .se-shapes { display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 8px; }
    .se-chip { display: flex; flex-direction: column; align-items: center; gap: 4px; min-height: 58px; padding: 8px 6px;
        border-radius: ${RADIUS + 2}px; border: 1px solid ${C.hairline}; background: transparent; color: ${C.text};
        font-size: 12px; font-weight: 600; text-align: center; cursor: pointer; }
    .se-chip.is-active { background: ${C.primary}; border-color: ${C.accent}; color: ${C.white}; }
    .se-chip:focus-visible { outline: 2px solid ${C.focus}; outline-offset: 2px; }
    .se-custom { display: flex; flex-direction: column; gap: 8px; padding: 10px; border-radius: ${RADIUS + 2}px; background: rgba(255,255,255,0.04); }
    .se-flight-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
    .se-flight-row .ui-input { width: auto; min-width: 140px; }
    .se-flight-no { font-size: 13px; font-weight: 600; }
    .se-flight-actions, .se-direction-actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .se-direction { flex-direction: row; align-items: center; gap: 14px; }
    .se-compass { width: 132px; height: 132px; flex: none; touch-action: none; cursor: grab; border-radius: 50%; }
    .se-compass.is-dragging { cursor: grabbing; }
    .se-compass:focus-visible { outline: 2px solid ${C.focus}; outline-offset: 3px; }
    .se-direction-text { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
    .se-bearing { font-size: 20px; color: #fff; }
    .se-stepper { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .se-step-ctl { display: inline-flex; align-items: center; gap: 4px; }
    .se-step-ctl button { width: 36px; height: 36px; border-radius: 10px; border: 1px solid ${C.hairline}; background: transparent; color: #fff; font-size: 18px; cursor: pointer; }
    .se-step-ctl button:disabled { opacity: 0.35; cursor: default; }
    .se-step-ctl output { min-width: 64px; text-align: center; font-weight: 700; }
    .se-stats { display: flex; flex-wrap: wrap; gap: 6px 14px; margin: 0; font-size: 13px; color: ${C.muted}; }
    .se-stats b { color: #fff; }
    .se-ok { color: ${C.accent}; font-weight: 600; }
    .se-warn { color: ${C.warning}; font-weight: 700; }
    @media (max-width: 420px) { .se-direction { flex-direction: column; align-items: flex-start; } }
    @media (prefers-reduced-motion: reduce) { .stair3d-host canvas { cursor: default; } }
`;
