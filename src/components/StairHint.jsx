import React, { useMemo, useState } from 'react';
import { C, TYPE, PANEL_RADIUS, TAP, PILL, ELEVATION } from '../uiTokens';
import { floorAria, floorTag } from '../floors';
import { planStairs, normalizeFlights } from '../stairGeometry';
import StairModal from './StairModal';
import { StairPreview3D } from './Lazy3D'; // three.js loads only when "Stairs in 3D" is opened

/** Route tools on the map, bottom centre, in the same floating panel as the
 *  Map / Satellite control. With a staircase ahead (`stair`, one entry of
 *  route.stairs) it says where the stairs go and how they bend, and offers
 *  Go to that floor, the staircase in 3D, and the route in 3D. Without one it
 *  is just the "Route in 3D" button. */
export default function StairHint({ stair = null, onGoToFloor, onRouteIn3D, onCancel = null }) {
    const [open, setOpen] = useState(false);
    const plan = useMemo(() => (stair ? planStairs({
        rise: stair.rise_m,
        yawDeg: stair.yaw_deg,
        flights: stair.flights,
        angleDeg: stair.angle_deg,
        landingM: stair.landing_m,
    }) : null), [stair]);
    const to = stair ? floorAria(stair.to_floor).toLowerCase() : '';
    const bends = stair ? normalizeFlights(stair.flights, stair.angle_deg).length > 1 : false;
    const detail = stair ? `${bends ? stair.shape : 'Straight'}, ${Math.round(stair.angle_deg)}° incline` : '';

    return (
        <section className="route-bar" aria-label={stair ? `Stairs ${stair.direction} to ${to}` : 'Route tools'} onClick={(e) => e.stopPropagation()}>
            <style>{ROUTE_BAR_CSS}</style>
            {stair && (
                <div className="route-bar-text" title={stair.instruction || undefined}>
                    <b>Stairs {stair.direction} to {to}</b>
                    <span>{detail}</span>
                </div>
            )}
            <div className="route-bar-group" role="group" aria-label="Route actions">
                {stair && onGoToFloor && (
                    <button type="button" className="route-bar-btn is-primary" onClick={() => onGoToFloor(stair.to_floor)}>
                        Go to {floorTag(stair.to_floor)}
                    </button>
                )}
                {stair && <button type="button" className="route-bar-btn" onClick={() => setOpen(true)}>Stairs in 3D</button>}
                {onRouteIn3D && <button type="button" className="route-bar-btn" onClick={onRouteIn3D}>Route in 3D</button>}
                {onCancel && (
                    <button type="button" className="route-bar-btn is-cancel" onClick={onCancel}>Cancel route</button>
                )}
            </div>
            {open && plan && (
                <StairModal
                    title={`Stairs ${stair.direction} to ${to}`}
                    subtitle={stair.instruction || detail}
                    onClose={() => setOpen(false)}
                    closeLabel="Close the stairs view"
                    footer={<button type="button" className="ui-btn ui-btn-primary" onClick={() => setOpen(false)}>Done</button>}
                >
                    <StairPreview3D
                        plan={plan}
                        direction={stair.direction}
                        height="min(60vh, 520px)"
                        autoRotate
                        compass={false}
                        lowerLabel={floorAria(Math.min(stair.from_floor, stair.to_floor))}
                        upperLabel={floorAria(Math.max(stair.from_floor, stair.to_floor))}
                        ariaLabel={`3D view of the stairs ${stair.direction}. ${stair.instruction || ''}`}
                    />
                </StairModal>
            )}
        </section>
    );
}

const ROUTE_BAR_CSS = `
    /* Same floating panel as the Map / Satellite control (.mnav-sat). */
    .route-bar {
        position: absolute; z-index: 1000; left: 50%; bottom: 10px; transform: translateX(-50%);
        display: flex; align-items: center; gap: 10px; width: max-content; max-width: min(640px, calc(100% - 540px));
        padding: 6px; border-radius: ${PANEL_RADIUS}px;
        background: ${C.glass}; border: 1px solid ${C.hairline}; box-shadow: ${ELEVATION.float};
        -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px);
        animation: routeBarIn var(--dur-base, 220ms) var(--ease-out, ease) both;
    }
    @keyframes routeBarIn { from { opacity: 0; transform: translate(-50%, 10px); } }
    .route-bar-text { min-width: 0; display: flex; flex-direction: column; gap: 1px; padding: 0 6px 0 10px; }
    .route-bar-text b { font-size: ${TYPE.sub}; font-weight: 700; color: ${C.white}; white-space: nowrap; }
    .route-bar-text span { font-size: ${TYPE.desc}; color: ${C.muted}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    /* The button group: the segmented look of the Map / Satellite switch. */
    .route-bar-group { flex: none; display: flex; gap: 3px; padding: 3px; border-radius: ${PILL}px; background: rgba(255,255,255,0.06); }
    .route-bar-btn {
        min-height: ${TAP.minHeight}; padding: 0 16px; border: 0; border-radius: ${PILL}px; background: transparent;
        color: ${C.muted}; font: inherit; font-size: 13px; font-weight: 700; white-space: nowrap; cursor: pointer;
        transition: background-color 160ms ease, color 160ms ease, transform 160ms ease;
    }
    .route-bar-btn:hover { color: #fff; background: rgba(255,255,255,0.08); }
    .route-bar-btn:active { transform: scale(${TAP.activeScale}); }
    .route-bar-btn:focus-visible { outline: ${TAP.focusOutline}; outline-offset: 2px; }
    .route-bar-btn.is-primary { background: ${C.primary}; color: #fff; }
    .route-bar-btn.is-primary:hover { background: ${C.primaryHover || C.primary}; }
    .route-bar-btn.is-cancel { display: inline-flex; align-items: center; gap: 6px; }
    .route-bar-btn.is-cancel:hover { color: #ff8a96; background: rgba(255, 85, 102, 0.12); }
    @media (max-width: 900px) {
        /* Phones: centred above the Map / Satellite control, only as wide as its
           buttons (a lone Cancel route stays a small button, not a full-width bar). */
        .route-bar { max-width: calc(100% - 20px); flex-wrap: wrap; gap: 6px; padding: 4px;
            bottom: calc(12px + 54px + 8px + 66px + 8px); }
        .route-bar-text { flex: 1 1 100%; padding: 2px 6px 0; }
        .route-bar-group { flex: 1 1 auto; }
        .route-bar-btn { flex: 1 1 auto; min-height: ${TAP.minHeight}; padding: 0 14px; }
    }
    /* Landscape phones: the map is short, so the bar sits bottom-right on one row,
       beside the Map / Satellite switch, without the instruction (the sheet has it). */
    @media (max-height: 520px) and (min-width: 560px) {
        .route-bar { left: auto; right: 10px; bottom: 10px; max-width: calc(100% - 230px); flex-wrap: nowrap; }
        .route-bar-text { display: none; }
        .route-bar-group { flex: 0 1 auto; }
        .route-bar-btn { flex: 0 1 auto; padding: 0 12px; }
    }
    @media (max-width: 480px) {
        .route-bar-group { flex-wrap: wrap; }
        .route-bar-btn { flex: 1 1 calc(50% - 2px); }
    }
    @media (prefers-reduced-motion: reduce) { .route-bar { animation: none; } .route-bar-btn:active { transform: none; } }
`;
