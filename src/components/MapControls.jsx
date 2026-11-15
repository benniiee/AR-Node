import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Collapse } from '../motion';
import { C, TYPE, PANEL_RADIUS, ELEVATION } from '../uiTokens';
import { stairLength } from '../pathfinding';
import { toLocalMeters } from '../geo';
import { floorOf, floorAria, floorTag } from '../floors';
import { buildingFloors, floorCountLabel } from '../campusGeometry';
import { stairRise, normalizeFlights, meanAngle, flightsForShape, planStairs, shapeLabel, STAIR_LANDING_DEFAULT } from '../stairGeometry';
import { StairShapeEditor, STAIR_EDITOR_CSS, compassWord } from './StairEditor';
import StairModal from './StairModal';

// ── Map tool surfaces ──────────────────────────────────────────────
// The admin map shows exactly ONE surface at the bottom of the screen:
//
//   dock       idle: four big buttons (Add node · Walls · My pin · View)
//   *-place    a slim bar while a tool waits for a map tap ("Tap the map…")
//   walls      a slim bar with Undo / Save / More / Cancel
//   *-form     a compact sheet (≤46% of the screen) for node details
//
// Because only one surface exists at a time, nothing can stack up and cover
// the map while a node or wall is being set.

const stroke = {
    fill: 'none', stroke: 'currentColor', strokeWidth: 1.9,
    strokeLinecap: 'round', strokeLinejoin: 'round',
};

export const ICONS = {
    add: (
        <svg viewBox="0 0 24 24" {...stroke} aria-hidden="true">
            <circle cx="12" cy="12" r="9" /><path d="M12 8v8M8 12h8" />
        </svg>
    ),
    walls: (
        <svg viewBox="0 0 24 24" {...stroke} aria-hidden="true">
            <path d="M4 18l6-8 4 5 6-9" /><circle cx="4" cy="18" r="1.4" /><circle cx="20" cy="6" r="1.4" />
        </svg>
    ),
    pin: (
        <svg viewBox="0 0 24 24" {...stroke} aria-hidden="true">
            <path d="M12 21s-6-5.2-6-10a6 6 0 1 1 12 0c0 4.8-6 10-6 10z" /><circle cx="12" cy="11" r="2.2" />
        </svg>
    ),
    campus: (
        <svg viewBox="0 0 24 24" {...stroke} aria-hidden="true">
            <path d="M3 20h18M5 20V9l7-5 7 5v11" /><path d="M9 20v-5h6v5" /><path d="M9 11h.01M15 11h.01" />
        </svg>
    ),
    view: (
        <svg viewBox="0 0 24 24" {...stroke} aria-hidden="true">
            <path d="M4 7h9M17 7h3M4 17h3M11 17h9" /><circle cx="15" cy="7" r="2" /><circle cx="9" cy="17" r="2" />
        </svg>
    ),
};

export function ToolDock({ viewOpen, onAdd, onWalls, onPin, onView, onCampus = null, campusOpen = false }) {
    // `short`: the label on very narrow phones.
    const btn = (key, icon, label, onClick, pressed, short = null) => (
        <button key={key} className="mt-dock-btn" onClick={onClick} aria-pressed={pressed} aria-label={short ? label : undefined}>
            {icon}
            {short
                ? <><span className="mt-l-long" aria-hidden="true">{label}</span><span className="mt-l-short" aria-hidden="true">{short}</span></>
                : <span>{label}</span>}
        </button>
    );
    return (
        <div className="mt-card mt-dock mt-enter" role="toolbar" aria-label="Map tools" style={onCampus ? { gridTemplateColumns: 'repeat(5, minmax(0, 1fr))' } : undefined}>
            {btn('add', ICONS.add, 'Add node', onAdd, undefined, 'Add')}
            {btn('walls', ICONS.walls, 'Walls', onWalls)}
            {onCampus && btn('campus', ICONS.campus, 'Campus', onCampus, campusOpen)}
            {btn('pin', ICONS.pin, 'My pin', onPin)}
            {btn('view', ICONS.view, 'View', onView, viewOpen)}
        </div>
    );
}

/** One row in the View menu: label left, switch right. */
export function MenuToggle({ label, on, onClick }) {
    return (
        <button className="mt-row" role="switch" aria-checked={on} onClick={onClick}>
            <span>{label}</span>
            <span className="mt-switch" aria-hidden="true" />
        </button>
    );
}

export function MenuAction({ label, onClick }) {
    return <button className="mt-row" onClick={onClick}><span>{label}</span></button>;
}

/** Slim bar: what the tool wants from the next tap, and the way out. */
export function ActionBar({ title, hint, children, ariaLabel }) {
    return (
        <div className="mt-card mt-enter" role="group" aria-label={ariaLabel || title}>
            <div className="mt-bar">
                <div className="mt-bar-head">
                    <div style={{ minWidth: 0 }}>
                        <div className="mt-bar-title">{title}</div>
                        {hint && <div className="mt-bar-hint" role="status">{hint}</div>}
                    </div>
                </div>
                <div className="mt-bar-actions">{children}</div>
            </div>
        </div>
    );
}

/** Compact bottom sheet: header, scrolling body, pinned footer. */
export function Sheet({ title, subtitle, onClose, children, footer, ariaLabel }) {
    return (
        <div className="mt-card mt-sheet mt-enter" role="group" aria-label={ariaLabel || title}>
            <div className="mt-sheet-head">
                <div style={{ minWidth: 0, display: 'flex', alignItems: 'baseline', flexWrap: 'wrap', gap: '2px 10px' }}>
                    <h2 className="ui-card-title" style={{ margin: 0 }}>{title}</h2>
                    {subtitle && <span className="ui-hint ui-num" style={{ margin: 0 }}>{subtitle}</span>}
                </div>
                {onClose && (
                    <button className="mt-x" onClick={onClose} aria-label="Close">
                        <svg viewBox="0 0 24 24" {...stroke} aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
                    </button>
                )}
            </div>
            <div className="mt-sheet-body">{children}</div>
            {footer}
        </div>
    );
}

export function Segmented({ label, value, onChange, options }) {
    const index = Math.max(0, options.findIndex((o) => o.value === value));
    return (
        <div className="seg" role="radiogroup" aria-label={label} style={{ '--seg-i': index, '--seg-n': options.length }}>
            <span className="seg-thumb" aria-hidden="true" />
            {options.map((o) => (
                <button
                    key={o.value} role="radio" aria-checked={value === o.value}
                    onClick={() => onChange(o.value)}
                >
                    {o.label}
                </button>
            ))}
        </div>
    );
}

/** Node details, compact: segmented type, name only for locations, and
 *  elevation / floor / label on one row instead of three stacked fields.
 *
 *  Building: which labelled building the node is inside. Once one is chosen
 *  the floor becomes a picker limited to that building's floors, so a room can
 *  never be filed on a floor the building does not have. `departments` is
 *  passed for admins only (faculty always file under their own department). */
export function NodeForm({
    id, type, setType, name, setName, elevation, setElevation, floor, setFloor, pathType, setPathType, campus, setCampus,
    buildings = [], buildingId = '', setBuildingId, departments = null, departmentId = '', setDepartmentId,
    // Staff place nodes only inside their department's buildings: no "outdoors".
    allowOutdoors = true,
}) {
    const building = buildings.find((b) => String(b.id) === String(buildingId)) || null;
    const floorChoices = building ? buildingFloors(building) : null;
    // A node in a department's building is inside by definition (there is no
    // roof or above-the-building option), so Elevation and Label are not
    // asked; the node is saved as inside.
    useEffect(() => {
        if (building && pathType !== 'inside') setPathType('inside');
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [building?.id]);
    const pickBuilding = (value) => {
        setBuildingId(value);
        const next = buildings.find((b) => String(b.id) === String(value));
        // Keep the floor valid for the newly chosen building.
        if (next) {
            const allowed = buildingFloors(next);
            if (!allowed.includes(parseInt(floor, 10) || 0)) setFloor(String(Math.min(Math.max(parseInt(floor, 10) || 0, allowed[0]), allowed[allowed.length - 1])));
        }
    };
    return (
        <div className="mt-form">
            <Segmented
                label="Node type" value={type} onChange={setType}
                options={[{ value: 'route', label: 'Route node' }, { value: 'location', label: 'Location' }]}
            />
            {/* Campus is not picked here: it comes from the campus area the node sits in. */}
            <Collapse open={type === 'location'} className="field-collapse">
                <div className="ui-field">
                    <label className="ui-label" htmlFor={`${id}-name`}>Name <span className="ui-req">*</span></label>
                    <input
                        id={`${id}-name`} className="ui-input" value={name}
                        onChange={(e) => setName(e.target.value)} placeholder="e.g. Library"
                        tabIndex={type === 'location' ? 0 : -1}
                    />
                </div>
            </Collapse>
            {setBuildingId && (
                <div className="ui-field">
                    <label className="ui-label" htmlFor={`${id}-building`}>Building</label>
                    <select id={`${id}-building`} className="ui-select" value={buildingId} onChange={(e) => pickBuilding(e.target.value)}>
                        {allowOutdoors
                            ? <option value="">Outdoors / not in a building</option>
                            : <option value="" disabled>Choose one of your buildings</option>}
                        {buildings.map((b) => (
                            <option key={b.id} value={b.id}>{b.name} ({floorCountLabel(b)})</option>
                        ))}
                    </select>
                </div>
            )}
            {departments && setDepartmentId && (
                <div className="ui-field">
                    <label className="ui-label" htmlFor={`${id}-dept`}>Department / office owner</label>
                    <select id={`${id}-dept`} className="ui-select" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
                        <option value="">Unassigned</option>
                        {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                    </select>
                </div>
            )}
            {floorChoices && (
                <div className="ui-field">
                    <span className="ui-label" id={`${id}-floor-label`}>Floor in {building.short_name || building.name}</span>
                    {floorChoices.length <= 6 ? (
                        <div
                            className="seg" role="radiogroup" aria-labelledby={`${id}-floor-label`}
                            style={{ '--seg-i': Math.max(0, floorChoices.indexOf(parseInt(floor, 10) || 0)), '--seg-n': floorChoices.length }}
                        >
                            <span className="seg-thumb" aria-hidden="true" />
                            {floorChoices.map((f) => (
                                <button
                                    key={f} type="button" role="radio" aria-checked={(parseInt(floor, 10) || 0) === f}
                                    aria-label={floorAria(f)} onClick={() => setFloor(String(f))}
                                >
                                    {floorTag(f)}
                                </button>
                            ))}
                        </div>
                    ) : (
                        <select className="ui-select" aria-labelledby={`${id}-floor-label`} value={String(parseInt(floor, 10) || 0)} onChange={(e) => setFloor(e.target.value)}>
                            {floorChoices.map((f) => <option key={f} value={f}>{floorAria(f)}</option>)}
                        </select>
                    )}
                    <span className="ui-hint">The map shows this floor inside the building; place the pin on it.</span>
                </div>
            )}
            {!floorChoices && (
            <div className="mt-grid3">
                <div className="ui-field">
                    <label className="ui-label" htmlFor={`${id}-elev`}>Elevation (m)</label>
                    <input id={`${id}-elev`} className="ui-input ui-num" type="number" inputMode="decimal" step="0.1" value={elevation} onChange={(e) => setElevation(e.target.value)} />
                </div>
                <div className="ui-field">
                    <label className="ui-label" htmlFor={`${id}-floor`}>Floor level (0 = G)</label>
                    <input id={`${id}-floor`} className="ui-input ui-num" type="number" inputMode="numeric" value={floor} onChange={(e) => setFloor(e.target.value)} />
                </div>
                <div className="ui-field">
                    <label className="ui-label" htmlFor={`${id}-path`}>Label</label>
                    <select id={`${id}-path`} className="ui-select" value={pathType === 'covered' ? 'inside' : pathType} onChange={(e) => setPathType(e.target.value)}>
                        <option value="outside">Outside</option>
                        <option value="inside">Inside</option>
                    </select>
                </div>
            </div>
            )}
        </div>
    );
}

export const MAP_CONTROLS_CSS = `
    /* ── Bottom stack: the only thing anchored to the bottom edge ── */
    .mt-stack {
        position: absolute; z-index: 1001; left: 8px; right: 8px;
        bottom: max(8px, env(safe-area-inset-bottom));
        display: flex; flex-direction: column; gap: 8px;
        max-width: 480px; margin: 0 auto; pointer-events: none;
    }
    .mt-stack > * { pointer-events: auto; }
    @media (min-width: 641px) {
        .mt-stack { left: 12px; right: auto; bottom: 12px; width: 360px; margin: 0; }
    }
    .mt-card {
        background: ${C.glass}; color: ${C.text};
        -webkit-backdrop-filter: blur(18px) saturate(140%); backdrop-filter: blur(18px) saturate(140%);
        border: 1px solid ${C.hairline}; border-radius: ${PANEL_RADIUS}px;
        box-shadow: ${ELEVATION.raised};
    }
    .mt-enter { animation: mtIn 0.28s var(--ease-out) both; }
    @keyframes mtIn { from { opacity: 0; transform: translateY(10px); } }
    @media (prefers-reduced-motion: reduce) { .mt-enter { animation: none; } }

    /* Dock */
    .mt-dock { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 4px; padding: 4px; }
    .mt-dock-btn {
        display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px;
        min-height: 50px; padding: 4px 2px; border: 0; border-radius: ${PANEL_RADIUS - 4}px; /* concentric: dock 16 - 4px padding */
        background: transparent; color: inherit; font: inherit; font-size: 12px; font-weight: 600;
        cursor: pointer; -webkit-tap-highlight-color: transparent;
        transition: background-color 0.25s var(--ease-out), transform 0.3s var(--ease-spring);
    }
    .mt-dock-btn svg { width: 20px; height: 20px; }
    .mt-dock-btn span { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .mt-dock-btn .mt-l-short { display: none; }
    @media (max-width: 380px) {
        .mt-dock-btn .mt-l-long { display: none; }
        .mt-dock-btn .mt-l-short { display: inline; }
    }
    .mt-dock-btn:hover { background: rgba(255,255,255,0.07); }
    .mt-dock-btn:active { background: rgba(255,255,255,0.12); transform: scale(0.97); }
    .mt-dock-btn[aria-pressed="true"] { background: rgba(21, 128, 61,0.18); }
    .mt-dock-btn:focus-visible { outline: 2px solid ${C.focus}; outline-offset: -2px; }

    /* View menu */
    /* Capped to the space above the dock so no option is cut off on short (landscape) screens. */
    .mt-menu { padding: 6px; display: flex; flex-direction: column; gap: 2px; max-height: calc(100dvh - 120px); overflow-y: auto; overscroll-behavior: contain; }
    .mt-row {
        display: flex; align-items: center; justify-content: space-between; gap: 10px; width: 100%;
        min-height: 44px; padding: 0 12px; border: 0; border-radius: 8px;
        background: transparent; color: inherit; font: inherit; font-size: ${TYPE.sub}; font-weight: 600; text-align: left;
        cursor: pointer; -webkit-tap-highlight-color: transparent;
    }
    .mt-row:hover { background: rgba(255,255,255,0.07); }
    .mt-row:active { background: rgba(255,255,255,0.12); }
    .mt-row:focus-visible { outline: 2px solid ${C.focus}; outline-offset: -2px; }
    .mt-switch { position: relative; flex: none; width: 30px; height: 18px; border-radius: 10px; background: rgba(255,255,255,0.16); transition: background-color 0.3s var(--ease-out); }
    .mt-switch::after { content: ''; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: #fff; transition: transform 0.4s var(--ease-spring); }
    .mt-row[aria-checked="true"] .mt-switch { background: ${C.primary}; }
    .mt-row[aria-checked="true"] .mt-switch::after { transform: translateX(12px); }

    /* Slim action bar */
    .mt-bar { padding: 10px 10px 10px 14px; display: flex; flex-direction: column; gap: 8px; }
    .mt-bar-head { display: flex; align-items: center; gap: 10px; min-width: 0; }
    .mt-bar-title { font-size: ${TYPE.sub}; font-weight: 700; color: #fff; }
    .mt-bar-hint { font-size: ${TYPE.desc}; color: ${C.muted}; line-height: 1.35; }
    @keyframes mtPulse { 0% { box-shadow: 0 0 0 0 rgba(74, 222, 128,0.7); } 100% { box-shadow: 0 0 0 9px rgba(74, 222, 128,0); } }
    .mt-bar-actions { display: flex; gap: 8px; }
    .mt-bar-actions > .ui-btn { flex: 1 1 0; min-width: 0; min-height: 44px; padding: 0 8px; font-size: 13px; }

    /* Wall options: opens on demand, never by default */
    .mt-opts { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; padding: 0 10px 10px; max-height: min(34dvh, 280px); overflow-y: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch; }
    .mt-opts .ui-btn { min-height: 42px; padding: 0 8px; font-size: 13px; }
    .mt-opts .full { grid-column: 1 / -1; }
    .mt-opts .ui-hint { margin: 0; padding: 0 4px; }

    /* Compact sheet */
    .mt-sheet { display: flex; flex-direction: column; max-height: min(52dvh, 420px); }
    .mt-sheet-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; padding: 10px 6px 4px 14px; flex: none; }
    .mt-sheet-body { padding: 0 14px 10px; overflow-y: auto; min-height: 0; overscroll-behavior: contain; -webkit-overflow-scrolling: touch; }
    .mt-sheet-foot { display: flex; gap: 8px; padding: 8px 14px 10px; flex: none; border-top: 1px solid ${C.hairline}; }
    .mt-sheet-foot .ui-btn { flex: 1 1 0; min-width: 0; min-height: 44px; padding: 0 8px; font-size: 13px; }
    .mt-sheet-foot .ui-btn-primary { flex: 1.5 1 0; }
    .mt-x { flex: none; width: 36px; height: 36px; margin-top: -2px; display: grid; place-items: center; border: 0; border-radius: 10px; background: transparent; color: ${C.muted}; cursor: pointer; -webkit-tap-highlight-color: transparent; }
    .mt-x svg { width: 20px; height: 20px; }
    .mt-x:hover { background: rgba(255,255,255,0.07); color: #fff; }
    .mt-confirm { margin: 0 14px 8px; padding: 10px 12px; border-radius: 12px; background: ${C.dangerBg}; border: 1px solid rgba(255,35,56,0.4); flex: none; }
    .mt-confirm .row { display: flex; gap: 8px; margin-top: 8px; }
    .mt-confirm .row .ui-btn { flex: 1; min-height: 40px; }

    /* Form */
    .mt-form { display: flex; flex-direction: column; gap: 12px; }
    .mt-grid3 { display: grid; grid-template-columns: 1fr 1fr 1.25fr; gap: 8px; }
    @media (max-width: 339px) {
        .mt-grid3 { grid-template-columns: 1fr 1fr; }
        .mt-grid3 > :last-child { grid-column: 1 / -1; }
    }

    /* GPS chip: top-right, one line */
    .mt-status {
        position: absolute; z-index: 1000; top: 12px; right: 12px; min-height: 36px; padding: 0 12px; border-radius: 10px;
        font-size: ${TYPE.desc}; font-weight: 600; color: ${C.muted}; display: flex; align-items: center; gap: 8px; pointer-events: none; white-space: nowrap;
    }
    .mt-status .coords { font-variant-numeric: tabular-nums; }
    .mt-status[data-live="true"] { color: #fff; }
    /* Zoom and coordinates only where the map is wide enough: below that the
       chip ran into the centred Admin/Student switch (landscape phones, tablets). */
    @media (max-width: 1180px) {
        .mt-status .coords, .mt-status .zoom { display: none; }
    }
    @media (max-width: 640px) {
        /* +4px centres the 36px chip on the first 44px zoom button. */
        .mt-status { top: calc(max(8px, env(safe-area-inset-top)) + 4px); right: max(8px, env(safe-area-inset-right)); padding: 0 12px; }
    }

    /* ── Staircase angle editor: a side view of the stairs you can drag ── */
    .stair-dial { display: flex; flex-direction: column; gap: 8px; padding: 10px; border-radius: 12px; background: rgba(255, 255, 255, 0.03); border: 1px solid ${C.hairline}; }
    .stair-dial-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .stair-dial-step { display: inline-flex; align-items: center; gap: 6px; }
    .stair-dial-step button { width: 38px; height: 38px; padding: 0; border-radius: 10px; border: 1px solid ${C.fieldBorder}; background: ${C.field}; color: ${C.white}; font-size: 20px; line-height: 1; cursor: pointer; touch-action: manipulation; }
    .stair-dial-step button:hover:not(:disabled) { background: ${C.surfaceHover}; }
    .stair-dial-step button:disabled { opacity: 0.4; cursor: not-allowed; }
    .stair-dial-step output { min-width: 58px; text-align: center; font-size: 22px; font-weight: 800; color: ${C.accent}; font-variant-numeric: tabular-nums; }
    .stair-dial-svg { display: block; width: 100%; height: auto; max-height: 210px; touch-action: none; user-select: none; -webkit-user-select: none; cursor: crosshair; }
    .stair-dial-handle { cursor: grab; outline: none; }
    .stair-dial-svg.is-dragging, .stair-dial-svg.is-dragging .stair-dial-handle { cursor: grabbing; }
    .stair-dial-handle:focus-visible .vis { stroke: #fff; stroke-width: 3; }
    .stair-dial-presets { display: flex; gap: 6px; }
    .stair-dial-presets button { flex: 1 1 0; min-width: 0; min-height: 38px; padding: 4px 6px; border-radius: 10px; border: 1px solid ${C.fieldBorder}; background: ${C.field}; color: ${C.text}; font: inherit; font-size: ${TYPE.desc}; font-weight: 700; line-height: 1.15; cursor: pointer; touch-action: manipulation; }
    .stair-dial-presets button small { display: block; color: ${C.muted}; font-size: ${TYPE.desc}; font-weight: 600; }
    .stair-dial-presets button.is-active { background: rgba(74, 222, 128, 0.16); border-color: ${C.accent}; color: ${C.accent}; }
    .stair-dial-presets button.is-active small { color: ${C.accent}; }
    .stair-link { list-style: none; display: flex; flex-direction: column; gap: 8px; }
    .stair-link-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .stair-link-head .mt-stairs-name { flex: 1 1 auto; }
    .stair-new { display: flex; flex-direction: column; gap: 10px; }
    .stair-summary { display: flex; flex-wrap: wrap; gap: 6px; }
    .stair-chip { display: inline-flex; align-items: center; gap: 4px; padding: 4px 10px; border-radius: 6px; font-size: 12px; font-weight: 700;
        color: ${C.accent}; background: rgba(74, 222, 128, 0.12); border: 1px solid rgba(74, 222, 128, 0.35); }
    .stair-section-title { margin: 4px 0 0; font-size: 12px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; color: ${C.muted}; }
    ${STAIR_EDITOR_CSS}

    /* While any tool is active the map belongs to the tool: the user's own
       dot and the wall hit-lines must not catch the tap meant for the map. */
    .tool-active .user-marker-icon { opacity: 0 !important; pointer-events: none !important; }
    /* Walls are inert under every tool, except the Walls tool before a draft starts
       (.walls-pick): then tapping a wall opens it to edit or remove. */
    .tool-active:not(.walls-pick) .wall-hit { pointer-events: none !important; }
    /* Labelled buildings and pathways are inert under every tool too: a tap on one
       placed the corner or node AND opened its popup. */
    .tool-active .campus-hit { pointer-events: none !important; }
`;

const STAIR_MIN = 10;
const STAIR_MAX = 80;
const STAIR_PRESETS = [
    { deg: 30, label: 'Gentle' },
    { deg: 45, label: 'Standard' },
    { deg: 60, label: 'Steep' },
];
const clampStairAngle = (n) => Math.min(STAIR_MAX, Math.max(STAIR_MIN, Math.round(n)));

// Side-view geometry (SVG units). The bottom of the stairs is the pivot; the
// handle sits at the TOP of the stairs, a fixed distance away, so dragging it
// swings the staircase up or down like a ramp.
const DIAL = { w: 280, h: 172, px: 34, py: 150, r: 122 };

/** Side view of a staircase with a draggable handle. Drag the green dot (or tap
 *  anywhere in the picture) and the stairs tilt to match; the number and the
 *  walked length update as you move. `onChange` fires live, `onCommit` once the
 *  finger lifts, so saving to the server is one call per adjustment. */
function StairAngleEditor({ angle, onChange, onCommit, lengthFor, label }) {
    const [draft, setDraft] = useState(clampStairAngle(Number(angle) || 45));
    const svgRef = useRef(null);
    const dragging = useRef(false);
    const lastCommitted = useRef(clampStairAngle(Number(angle) || 45));
    const timer = useRef(null);
    const [isDragging, setIsDragging] = useState(false);

    // Follow the server value unless a drag is in progress.
    useEffect(() => {
        if (dragging.current) return;
        const next = clampStairAngle(Number(angle) || 45);
        setDraft(next);
        lastCommitted.current = next;
    }, [angle]);
    useEffect(() => () => window.clearTimeout(timer.current), []);

    const apply = useCallback((deg) => {
        const next = clampStairAngle(deg);
        setDraft(next);
        onChange?.(next);
        return next;
    }, [onChange]);

    const commit = useCallback((deg) => {
        if (deg === lastCommitted.current) return;
        lastCommitted.current = deg;
        onCommit?.(deg);
    }, [onCommit]);

    // Nudges from buttons / keyboard save after a short pause, so holding an
    // arrow key does not send one request per degree.
    const nudge = (deg) => {
        const next = apply(deg);
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => commit(next), 450);
    };

    const fromPointer = (event) => {
        const svg = svgRef.current;
        if (!svg) return draft;
        const pt = svg.createSVGPoint();
        pt.x = event.clientX; pt.y = event.clientY;
        const loc = pt.matrixTransform(svg.getScreenCTM().inverse());
        let deg = (Math.atan2(DIAL.py - loc.y, loc.x - DIAL.px) * 180) / Math.PI;
        // Gentle magnet on the usual slopes so 30 / 45 / 60 are easy to hit.
        for (const snap of [15, 30, 45, 60, 75]) if (Math.abs(deg - snap) < 1.6) deg = snap;
        return apply(deg);
    };

    const onPointerDown = (event) => {
        if (event.button !== undefined && event.button !== 0) return;
        window.clearTimeout(timer.current);
        dragging.current = true;
        setIsDragging(true);
        event.currentTarget.setPointerCapture?.(event.pointerId);
        fromPointer(event);
    };
    const onPointerMove = (event) => { if (dragging.current) fromPointer(event); };
    const endDrag = (event) => {
        if (!dragging.current) return;
        dragging.current = false;
        setIsDragging(false);
        event.currentTarget.releasePointerCapture?.(event.pointerId);
        commit(draft);
    };

    const onKeyDown = (event) => {
        const big = event.shiftKey ? 5 : 1;
        let next = null;
        if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next = draft + big;
        else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next = draft - big;
        else if (event.key === 'Home') next = STAIR_MIN;
        else if (event.key === 'End') next = STAIR_MAX;
        else return;
        event.preventDefault();
        nudge(next);
    };

    const rad = (draft * Math.PI) / 180;
    const hx = DIAL.px + DIAL.r * Math.cos(rad);
    const hy = DIAL.py - DIAL.r * Math.sin(rad);
    const STEPS = 7;
    const sx = (hx - DIAL.px) / STEPS;
    const sy = (DIAL.py - hy) / STEPS;
    let stepPath = `M ${DIAL.px} ${DIAL.py}`;
    for (let i = 0; i < STEPS; i += 1) stepPath += ` h ${sx.toFixed(2)} v ${(-sy).toFixed(2)}`;
    const arcR = 38;
    const arcEnd = { x: DIAL.px + arcR * Math.cos(rad), y: DIAL.py - arcR * Math.sin(rad) };
    const length = lengthFor ? lengthFor(draft) : null;

    return (
        <div className="stair-dial">
            <div className="stair-dial-head">
                <span className="ui-label" style={{ margin: 0 }}>Slope of the stairs</span>
                <div className="stair-dial-step">
                    <button type="button" aria-label="One degree flatter" disabled={draft <= STAIR_MIN} onClick={() => nudge(draft - 1)}>&minus;</button>
                    <output aria-live="polite">{draft}&deg;</output>
                    <button type="button" aria-label="One degree steeper" disabled={draft >= STAIR_MAX} onClick={() => nudge(draft + 1)}>+</button>
                </div>
            </div>
            <svg
                ref={svgRef}
                className={`stair-dial-svg${isDragging ? ' is-dragging' : ''}`}
                viewBox={`0 0 ${DIAL.w} ${DIAL.h}`}
                role="img"
                aria-label={`Side view of the staircase, ${draft} degrees${label ? ` (${label})` : ''}`}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
            >
                {/* lower floor */}
                <line x1="8" y1={DIAL.py} x2={DIAL.w - 8} y2={DIAL.py} stroke={C.muted} strokeWidth="1.5" />
                <text x={DIAL.w - 8} y={DIAL.py + 14} textAnchor="end" fontSize="10" fill={C.muted}>Lower floor</text>
                {/* upper floor rides with the handle */}
                <line x1={hx} y1={hy} x2={DIAL.w - 8} y2={hy} stroke={C.muted} strokeWidth="1.5" />
                <text x={DIAL.w - 8} y={hy - 6} textAnchor="end" fontSize="10" fill={C.muted}>Upper floor</text>
                {/* rise */}
                <line x1={hx} y1={hy} x2={hx} y2={DIAL.py} stroke={C.accent} strokeOpacity="0.45" strokeWidth="1.5" strokeDasharray="4 4" />
                {/* steps + slope line */}
                <path d={stepPath} fill="none" stroke={C.text} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
                <line x1={DIAL.px} y1={DIAL.py} x2={hx} y2={hy} stroke={C.accent} strokeWidth="1.5" strokeDasharray="5 4" />
                {/* angle arc */}
                <path d={`M ${DIAL.px + arcR} ${DIAL.py} A ${arcR} ${arcR} 0 0 0 ${arcEnd.x.toFixed(2)} ${arcEnd.y.toFixed(2)}`} fill="none" stroke={C.accent} strokeWidth="2" />
                <circle cx={DIAL.px} cy={DIAL.py} r="4" fill={C.white} />
                <text x={DIAL.px} y={DIAL.py + 14} textAnchor="start" fontSize="10" fill={C.muted}>Bottom of stairs</text>
                {/* handle */}
                <g
                    className="stair-dial-handle"
                    tabIndex={0}
                    role="slider"
                    aria-label="Stair angle"
                    aria-valuemin={STAIR_MIN}
                    aria-valuemax={STAIR_MAX}
                    aria-valuenow={draft}
                    aria-valuetext={`${draft} degrees`}
                    onKeyDown={onKeyDown}
                >
                    <circle cx={hx} cy={hy} r="24" fill="transparent" />
                    <circle className="vis" cx={hx} cy={hy} r="11" fill={C.accent} stroke="#0a0a0c" strokeWidth="2" />
                </g>
            </svg>
            <div className="stair-dial-presets" role="group" aria-label="Common slopes">
                {STAIR_PRESETS.map((pr) => (
                    <button
                        key={pr.deg}
                        type="button"
                        className={draft === pr.deg ? 'is-active' : ''}
                        aria-pressed={draft === pr.deg}
                        onClick={() => { window.clearTimeout(timer.current); const next = apply(pr.deg); commit(next); }}
                    >
                        {pr.deg}&deg;<small>{pr.label}</small>
                    </button>
                ))}
            </div>
            <p className="ui-hint" style={{ margin: 0 }}>
                Drag the green dot, or tap the picture. {length != null
                    ? `The stairs are about ${length.toFixed(1)} m long to walk at ${draft}\u00b0.`
                    : 'A flatter slope makes longer stairs; a steeper one makes a shorter walk.'}
            </p>
        </div>
    );
}

const NEW_STAIR = () => ({
    angle_deg: 45, yaw_deg: null, landing_m: STAIR_LANDING_DEFAULT, flights: flightsForShape('straight', 45),
});

/** Fields of a saved link the editor works with. */
const shapeOf = (l) => ({
    angle_deg: l.angle_deg ?? 45,
    yaw_deg: l.yaw_deg ?? null,
    landing_m: l.landing_m ?? STAIR_LANDING_DEFAULT,
    flights: normalizeFlights(l.flights, l.angle_deg ?? 45),
});

/** One saved staircase. In the narrow edit sheet it is only a summary (shape,
 *  heading, slope, walk length) and an "Edit staircase" button: the many
 *  settings live in a roomy centred dialog with a big 3D preview. Controls
 *  update the preview instantly and every finished change is saved with one
 *  call, so there is no separate Save step for the staircase. */
function StairLinkCard({ link, node, other, label, onUpdate, onRemove }) {
    const sig = JSON.stringify([link.angle_deg, link.yaw_deg, link.landing_m, link.flights]);
    const [draft, setDraft] = useState(() => shapeOf(link));
    const [open, setOpen] = useState(false);
    const dragging = useRef(false);
    useEffect(() => {
        if (dragging.current) return;
        setDraft(shapeOf(link));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sig]);

    const [bottom, top] = other && floorOf(node) > floorOf(other) ? [other, node] : [node, other];
    const rise = other ? stairRise(bottom, top) : 3;
    const topOffset = other
        ? (([e, n]) => ({ e, n }))(toLocalMeters(top.latitude, top.longitude, bottom.latitude, bottom.longitude))
        : null;
    const direction = other && floorOf(other) > floorOf(node) ? 'up' : 'down';
    const walk = planStairs({
        rise, yawDeg: 0, flights: draft.flights, angleDeg: draft.angle_deg, landingM: draft.landing_m,
    }).totalLength;
    const hasYaw = draft.yaw_deg !== null && draft.yaw_deg !== undefined;

    const change = (patch, { final }) => {
        setDraft((d) => ({ ...d, ...patch }));
        dragging.current = !final;
        if (final) onUpdate(link, patch);
    };
    const setSlope = (deg) => {
        const flights = draft.flights.map((f) => ({ ...f, angle_deg: deg }));
        change({ angle_deg: deg, flights }, { final: true });
    };

    return (
        <li className="stair-link">
            <div className="stair-link-head">
                <span className="mt-stairs-name" title={other ? label(other) : 'Missing node'}>
                    {'\u2194 '}{other ? label(other) : 'Missing node'}
                </span>
                <button
                    className="ui-btn ui-btn-danger"
                    style={{ minHeight: 34, padding: '4px 12px' }}
                    onClick={() => onRemove(link)}
                    aria-label="Remove this staircase link"
                >
                    Remove
                </button>
            </div>
            <div className="stair-summary" aria-label="Staircase summary">
                <span className="stair-chip">{shapeLabel(draft.flights)}</span>
                <span className="stair-chip">{hasYaw ? `${Math.round(draft.yaw_deg)}\u00b0 ${compassWord(draft.yaw_deg)}` : 'Direction auto'}</span>
                <span className="stair-chip">{Math.round(meanAngle(draft.flights))}&deg; slope</span>
                <span className="stair-chip">{walk.toFixed(1)} m walk</span>
            </div>
            <button type="button" className="ui-btn ui-btn-secondary ui-btn-block" onClick={() => setOpen(true)}>
                Edit staircase
            </button>
            {open && (
                <StairModal
                    title="Edit staircase"
                    subtitle={other ? label(other) : undefined}
                    onClose={() => setOpen(false)}
                    footer={<button type="button" className="ui-btn ui-btn-primary" onClick={() => setOpen(false)}>Done</button>}
                >
                    <StairShapeEditor
                        wide
                        value={draft}
                        rise={rise}
                        topOffset={topOffset}
                        direction={direction}
                        onChange={change}
                    >
                        <span className="stair-section-title">Slope</span>
                        <StairAngleEditor
                            angle={meanAngle(draft.flights)}
                            label={other ? label(other) : undefined}
                            lengthFor={other ? (deg) => stairLength(node, other, deg, {
                                flights: draft.flights.map((f) => ({ ...f, angle_deg: deg })), landing_m: draft.landing_m,
                            }) : null}
                            onCommit={setSlope}
                        />
                        <p className="ui-hint" style={{ margin: 0 }}>Changes are saved as you make them.</p>
                    </StairShapeEditor>
                </StairModal>
            )}
        </li>
    );
}

/** Staircase links for one node: shows the stairs it is already joined to and
 *  joins it to the node at the other end of its staircase. The other node is
 *  picked by tapping it on the map (no long list to scroll through). Routes
 *  between floors use ONLY these links, so this is the single place the admin
 *  says "these two nodes are one staircase".
 *
 *  A staircase is described by its SHAPE (straight, L, U, or custom flights
 *  with landings), its DIRECTION (yaw, a compass heading the first flight
 *  points) and its SLOPE. Those settings open in a centred dialog with a 3D
 *  preview. `onPick(draft)` receives { angle_deg, yaw_deg, flights, landing_m };
 *  `onUpdate(link, patch)` receives only the fields that changed. */
export function StairLinks({ node, nodes, links, floorLabel, onPick, onUpdate, onRemove }) {
    const mine = links.filter((l) => l.node_a_id === node.id || l.node_b_id === node.id);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const label = (n) => `${floorLabel(n)} \u00b7 ${n.name || (n.type === 'location' ? 'Location' : 'Route node')} #${n.id}`;

    return (
        <section className="mt-stairs" aria-label="Staircase links">
            <h3 className="mt-stairs-title">Staircase</h3>
            <p className="ui-hint" style={{ margin: '0 0 10px' }}>
                Tap Add staircase, then the node at the other end of the stairs (on a different floor);
                its shape and slope come next. Routes only change floors through these links.
            </p>
            {mine.length > 0 && (
                <ul className="mt-stairs-list">
                    {mine.map((l) => (
                        <StairLinkCard
                            key={l.id}
                            link={l}
                            node={node}
                            other={byId.get(l.node_a_id === node.id ? l.node_b_id : l.node_a_id)}
                            label={label}
                            onUpdate={onUpdate}
                            onRemove={onRemove}
                        />
                    ))}
                </ul>
            )}
            <div className="stair-new">
                <button type="button" className="ui-btn ui-btn-primary ui-btn-block" onClick={() => onPick()}>
                    {mine.length > 0 ? 'Add another staircase' : 'Add staircase'}
                </button>
            </div>
        </section>
    );
}

/** The last step of a new staircase: both ends are picked on the map, so the
 *  preview already knows the real rise and where the top lands. Shape,
 *  direction and slope are set here; Connect saves the link.
 *  `onSave(draft)` receives { angle_deg, yaw_deg, flights, landing_m }. */
export function NewStairModal({ from, to, label, onBack, onSave }) {
    const [draft, setDraft] = useState(NEW_STAIR);
    const [saving, setSaving] = useState(false);
    const [bottom, top] = floorOf(from) > floorOf(to) ? [to, from] : [from, to];
    const rise = stairRise(bottom, top);
    const topOffset = (([e, n]) => ({ e, n }))(toLocalMeters(top.latitude, top.longitude, bottom.latitude, bottom.longitude));
    const direction = floorOf(to) > floorOf(from) ? 'up' : 'down';
    const changeDraft = (patch) => setDraft((d) => ({ ...d, ...patch }));
    const setSlope = (deg) => changeDraft({ angle_deg: deg, flights: draft.flights.map((f) => ({ ...f, angle_deg: deg })) });
    const save = async () => {
        setSaving(true);
        try { await onSave(draft); } finally { setSaving(false); }
    };

    return (
        <StairModal
            title="New staircase"
            subtitle={`${label(from)} to ${label(to)}`}
            onClose={onBack}
            footer={(
                <>
                    <button type="button" className="ui-btn ui-btn-secondary" onClick={onBack} disabled={saving}>Cancel</button>
                    <button type="button" className="ui-btn ui-btn-primary" onClick={save} disabled={saving} aria-busy={saving}>
                        {saving ? 'Connecting' : 'Connect staircase'}
                    </button>
                </>
            )}
        >
            <StairShapeEditor wide value={draft} rise={rise} topOffset={topOffset} direction={direction} onChange={(patch) => changeDraft(patch)}>
                <span className="stair-section-title">Slope</span>
                <StairAngleEditor
                    angle={meanAngle(draft.flights)}
                    label={label(to)}
                    lengthFor={(deg) => stairLength(from, to, deg, {
                        flights: draft.flights.map((f) => ({ ...f, angle_deg: deg })), landing_m: draft.landing_m,
                    })}
                    onChange={setSlope}
                />
            </StairShapeEditor>
        </StairModal>
    );
}
