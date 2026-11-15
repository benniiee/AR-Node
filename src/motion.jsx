import React, { useEffect, useRef, useState } from 'react';

/**
 * Motion primitives shared by every admin screen.
 *
 * Rule of thumb: anything the person triggers (open, close, expand, confirm)
 * moves; anything that is not triggered stays still, apart from the live
 * indicators that carry real state (GPS fix, route direction, destination).
 * Only transform and opacity are animated, except for grid-template-rows in
 * Collapse, which is the one cheap way to animate to an auto height.
 */

export const EASE = {
    out: 'cubic-bezier(0.16, 1, 0.3, 1)',
    inOut: 'cubic-bezier(0.65, 0, 0.35, 1)',
    spring: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
};

/**
 * Three durations for the whole admin console (docs/frontend redesign skill:
 * interactions 200-300 ms). fast = press / hover / colour, base = a surface
 * opening or closing, slow = page-level entrances only.
 */
export const DUR = { fast: '160ms', base: '260ms', slow: '420ms' };

/**
 * Keeps an element mounted long enough to play its exit.
 * Render while `mounted`, and put `state` ("in" | "out") on data-state.
 */
export function usePresence(show, ms = 320) {
    const [mounted, setMounted] = useState(show);
    const [state, setState] = useState(show ? 'in' : 'out');
    useEffect(() => {
        if (show) {
            setMounted(true);
            // Two frames: the node must paint in the "out" state first,
            // otherwise the browser has nothing to transition from.
            let b;
            const a = requestAnimationFrame(() => { b = requestAnimationFrame(() => setState('in')); });
            return () => { cancelAnimationFrame(a); cancelAnimationFrame(b); };
        }
        setState('out');
        const t = setTimeout(() => setMounted(false), ms);
        return () => clearTimeout(t);
    }, [show, ms]);
    return { mounted, state };
}

/** Last non-null value, so content survives its own exit animation. */
export function useHold(value) {
    const ref = useRef(value);
    if (value !== null && value !== undefined) ref.current = value;
    return ref.current;
}

/** Height-auto open/close. Closed content is also removed from tab order. */
export function Collapse({ open, id, className = '', children }) {
    return (
        <div id={id} className={`collapse ${className}`} data-open={open ? 'true' : 'false'}>
            <div className="collapse-inner">{children}</div>
        </div>
    );
}

export const MOTION_CSS = `
    .ui-root {
        --ease-out: ${EASE.out};
        --ease-in-out: ${EASE.inOut};
        --ease-spring: ${EASE.spring};
        --dur-fast: ${DUR.fast};
        --dur-base: ${DUR.base};
        --dur-slow: ${DUR.slow};
    }

    @keyframes rise { from { opacity: 0; transform: translateY(10px); } }
    @keyframes fadeIn { from { opacity: 0; } }
    @keyframes popIn { from { opacity: 0; transform: scale(0.7); } }
    @keyframes tbIn { from { opacity: 0; transform: translateX(-10px); } }
    @keyframes alertIn {
        0% { opacity: 0; transform: translateY(-6px); }
        35% { opacity: 1; transform: translateX(-5px); }
        55% { transform: translateX(4px); }
        78% { transform: translateX(-2px); }
        100% { transform: none; }
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    @keyframes ring { 0% { transform: scale(0.7); opacity: 0.8; } 100% { transform: scale(2.4); opacity: 0; } }
    @keyframes dashflow { to { stroke-dashoffset: -16; } }
    @keyframes draw { to { stroke-dashoffset: 0; } }
    @keyframes pulse { 50% { opacity: 0.45; } }

    /* Staggered entrance: set style={{ '--i': n }} on each item. */
    /* Capped at 8 steps by callers, so a long list is never waiting on itself. */
    .rise { animation: rise var(--dur-slow) var(--ease-out) both; animation-delay: calc(var(--i, 0) * 40ms); }

    /* Enter and exit for mounted-on-demand surfaces (see usePresence). */
    .pres {
        opacity: 1; transform: none;
        transition: opacity var(--dur-base) var(--ease-out), transform var(--dur-slow) var(--ease-out);
    }
    .pres[data-state="out"] { opacity: 0; transform: translateY(10px) scale(0.985); pointer-events: none; }
    .pres-down[data-state="out"] { transform: translateY(-10px) scale(0.985); }
    .pres-side[data-state="out"] { transform: translateX(-12px) scale(0.985); }

    .collapse {
        display: grid; grid-template-rows: 0fr; opacity: 0; visibility: hidden;
        transition: grid-template-rows 0.3s var(--ease-in-out), opacity var(--dur-fast) ease, visibility 0s linear 0.3s;
    }
    .collapse[data-open="true"] {
        grid-template-rows: 1fr; opacity: 1; visibility: visible;
        transition: grid-template-rows 0.3s var(--ease-in-out), opacity var(--dur-base) ease 60ms, visibility 0s;
    }
    /* A closed collapse inside a flex gap would still leave one gap behind. */
    .field-collapse { margin-bottom: 0; transition-property: grid-template-rows, opacity, visibility, margin-bottom; }
    .field-collapse[data-open="false"] { margin-bottom: -12px; }
    /* Padding and negative margin keep focus rings from being clipped. */
    .collapse-inner { overflow: hidden; min-height: 0; padding: 3px; margin: -3px; }

    /* Cards are not clickable, so they do not react to hover (a hover glow
       on a static surface promises an action that is not there). */

    .ui-field .ui-label { transition: color var(--dur-fast) ease; }
    .ui-field:focus-within .ui-label { color: #fff; }

    /* Buttons: a small lift on hover, a press on active. Flat fills only. */
    .ui-btn { transition-duration: var(--dur-fast), var(--dur-fast), var(--dur-base), var(--dur-fast); }
    .ui-btn:hover:not(:disabled) { transform: translateY(-1px); }
    .ui-btn:active:not(:disabled) { transform: translateY(0) scale(0.97); transition-duration: 80ms; }
    .ui-btn-primary { transition-property: background-color, border-color, transform, opacity; }
    /* Filled red: only for the final "yes, delete" step of a confirmation. */
    .ui-btn-destroy { background: #b3121f; color: #fff; }
    .ui-btn-destroy:hover:not(:disabled) { background: #c8101f; }
    .ui-btn-destroy:active:not(:disabled) { background: #9a0f1a; }

    /* Base map fades in when the admin switches Admin / Student view. */
    .tile-swap { animation: fadeIn var(--dur-slow) var(--ease-out) both; }

    /* Error banner and toasts slide, never pop. */
    @keyframes slideDown { from { opacity: 0; transform: translateY(-8px); } }
    .btn-spin {
        width: 14px; height: 14px; flex: none; border-radius: 50%;
        border: 2px solid rgba(255, 255, 255, 0.35); border-top-color: #fff;
        animation: spin 0.7s linear infinite;
    }

    .ui-alert { animation: alertIn 0.5s var(--ease-out) both; }

    .skeleton { border-radius: 6px; background: rgba(255, 255, 255, 0.08); animation: pulse 1.4s ease-in-out infinite; }

    @media (prefers-reduced-motion: reduce) {
        .ui-root *, .ui-root *::before, .ui-root *::after { animation: none !important; transition-duration: 0.01ms !important; transition-delay: 0s !important; }
    }
`;
