/**
 * Mobile design tokens - the visual language of the 2D map screen,
 * shared with the 3D view so both screens read as one product.
 *
 * Why this file exists: reach for an existing pattern before inventing a new
 * one, and keep the same component using the same visual treatment
 * everywhere. The values below are copied verbatim from the 2D screen
 * (`MobileNav.jsx`): `.mnav-root`, `.mnav-header`, `.mnav-footer`, `.mbtn`,
 * the select, the error bar and the route polyline. Change them here, not
 * in one screen only.
 *
 * The palette is BLACK + WHITE + GREEN, with red kept ONLY for problems.
 *   - white  = the route and "you" (the way to go; neutral guidance)
 *   - green  = the destination, primary actions, selected / live state
 *              (go, arrived, confirmed)
 *   - red    = the school brand (login, dashboard, nav, dropdowns) AND
 *              errors / unavailable / destructive actions. The route and the
 *              destination are never red, or a healthy route reads as a
 *              failure.
 *   - amber  = manual/test mode.
 * `glow` is the signature green used for every emissive accent (3D destination
 * beacon, active chips, panel edge) so the HUD and the 3D scene light the same
 * colour. `route` is the white used for the route line in 2D and 3D.
 *
 * @typedef {Object} MobileColors
 */

import { MOTION_CSS } from './motion';

export const C = {
    /** Page background (`.mnav-root`) */
    page: '#0a0a0c',
    /** Default text on page background (`.mnav-root` color) */
    text: '#ececf0',
    /** Chrome bars - header, footer, sheets, panels (`.mnav-header`/`.mnav-footer`) */
    bar: '#101014',
    /** Translucent HUD panel over the camera feed / map (ARView sheets, top bar). */
    glass: 'rgba(12,12,16,0.86)',
    /** Input/select surface (`.mnav-select`) */
    field: '#17171c',
    fieldBorder: '#31313a',
    /** Neutral button surface (`.mbtn`) */
    surface: '#1b1b21',
    /** Hover/pressed lift for neutral surfaces (no 2D equivalent - derived) */
    surfaceHover: '#25252c',
    border: '#3a3a44',
    /** Hairline between rows and inside cards - the one divider colour. */
    hairline: 'rgba(255, 255, 255, 0.08)',
    /** Placeholder text inside fields. */
    placeholder: '#74747f',
    /** Secondary / meta text (footer status text, telemetry labels) */
    muted: '#a6a6b1',
    /**
     * School brand red - the identity colour. Used for the login page, the
     * dashboard shell (wordmark, navigation, primary buttons) and the mobile
     * destination dropdown. NOT for the route, the destination or anything
     * that reports status: on those, red would read as "something is wrong".
     */
    brand: '#e5182b',
    brandHover: '#c0121f',
    brandPress: '#9d0f1a',
    /** Brand red for text / edges on dark surfaces. */
    brandAccent: '#ff5566',
    /** Primary action (go / confirm). White text on it passes WCAG AA (5:1). */
    primary: '#15803d',
    primaryHover: '#166534',
    primaryPress: '#14532d',
    /** Keyboard/touch focus ring and focused-field edge: white on every screen, never green. */
    focus: '#ffffff',
    /** GPS affordance, live/active/selected chips, text accents */
    accent: '#4ade80',
    accentPress: '#22c55e',
    /** Manual/test mode */
    warning: '#ff9f1a',
    /** Problem surfaces ONLY: error banners, destructive actions, invalid fields. */
    dangerBg: '#2b0a0e',
    danger: '#ff9ba3',
    /** Strong red for error borders / icons - never for route or destination. */
    error: '#ff2338',
    errorBorder: '#ff5566',
    white: '#fff',
    /** The route line in 2D and 3D: white, like the 3D guidance arrows. */
    route: '#ffffff',
    /**
     * Destination / arrival green - beacon, destination pin, active pill
     * shadow. Kept in sync with the Three.js constants in `holoRibbon.js`.
     */
    glow: '#22c55e',
    go: '#22c55e',
    /** Deep green kept in sync with holoRibbon.js (3D beam falloff). Not used for UI chrome. */
    glowDeep: '#0b4a24',
    /** High-contrast highlight (the "you" dot, chevrons, the route). */
    ice: '#ffffff',
};

/**
 * Corner radii - one documented system (shape lock):
 *   PILL (999)          every interactive control: buttons (`.ui-btn`, `.mbtn`,
 *                       the HUD buttons), chips, segmented toggles, and status chips;
 *   BADGE_RADIUS (6px)  badges, tags, counts and map labels;
 *   RADIUS (10px)       text inputs and notice boxes, same as controls;
 *   PANEL_RADIUS (16px) panels, cards, docks and bottom sheets.
 * One radius family: no pill-shaped controls next to square cards.
 */
export const BADGE_RADIUS = 6;
export const RADIUS = 10;

/** Radius for panels, cards, docks and sheets. */
export const PANEL_RADIUS = 16;

/** Interactive controls (buttons, chips, segmented toggles, notices): 10px, same as inputs. Kept the old name. */
export const PILL = 10;

/**
 * Three elevation levels (ported from Uber's system; tinted for the dark HUD,
 * which floats over a light map). Nothing else in the app invents a shadow.
 *   raised   cards and docked panels
 *   float    floating controls, pills, toasts over the map
 *   overlay  dialogs and sheets above everything
 */
export const ELEVATION = {
    raised: '0 4px 16px rgba(10, 10, 14, 0.22)',
    float: '0 2px 10px rgba(10, 10, 14, 0.28)',
    overlay: '0 12px 32px rgba(10, 10, 14, 0.34)',
};

/**
 * Motion: one set of curves and durations for every screen (admin, /map, AR).
 *   out      ease-out: things arriving (open, enter, reveal)
 *   in       ease-in: things leaving (close, dismiss), quicker than arriving
 *   inOut    moving between two places (thumb slide, view swap)
 *   spring   a small overshoot for press / pop feedback only
 */
export const MOTION = {
    out: 'cubic-bezier(0.16, 1, 0.3, 1)',
    in: 'cubic-bezier(0.4, 0, 1, 1)',
    inOut: 'cubic-bezier(0.65, 0, 0.35, 1)',
    spring: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
    fast: '160ms',
    base: '260ms',
    slow: '420ms',
};

/**
 * Shared interaction motion, injected by every screen (App, MobileNav,
 * ARView). Map popups open from their anchor, building shapes ease on hover,
 * segmented toggles slide a thumb between options. Respects reduced motion.
 */
export const INTERACTION_CSS = `
    /* ARNode logo (BrandLogo.jsx): the logo itself, transparent background. */
    .brand-logo { flex: none; display: block; object-fit: contain; user-select: none; }
    .brand-logo-inline { width: 1.3em; height: 1.3em; }
    /* Wordmark with its logo: the logo, then "AR" + red "Node" as one word. */
    .brand-lockup { display: inline-flex; align-items: center; gap: 0.4em; }

    /* The one tooltip (TooltipLayer.jsx): readable size, above everything, centred on its element. */
    .ui-tooltip {
        position: fixed; z-index: 10000; max-width: min(320px, calc(100vw - 16px)); pointer-events: none;
        padding: 8px 12px; border-radius: 8px; background: ${C.bar}; border: 1px solid ${C.border};
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5); color: ${C.text};
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 14px; font-weight: 400; line-height: 1.45;
        letter-spacing: normal; text-align: left; white-space: pre-line; overflow-wrap: anywhere;
        animation: uiTooltipIn var(--dur-fast, 120ms) var(--ease-out, ease-out) both;
    }
    @keyframes uiTooltipIn { from { opacity: 0; transform: translateY(2px); } to { opacity: 1; transform: none; } }
    @media (prefers-reduced-motion: reduce) { .ui-tooltip { animation: none; } }
    /* The ⓘ that marks "hover me for an explanation" (InfoIcon.jsx). */
    .ui-info-icon { flex: none; display: inline-block; width: 16px; height: 16px; margin-left: 6px; vertical-align: -0.15em; color: ${C.muted}; }

    /* Read by screen readers, not shown: page headings on full-screen map views. */
    .sr-only {
        position: absolute !important; width: 1px; height: 1px; padding: 0; margin: -1px;
        overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
    }
    :root {
        --ease-out: ${MOTION.out}; --ease-in: ${MOTION.in}; --ease-in-out: ${MOTION.inOut}; --ease-spring: ${MOTION.spring};
        --dur-fast: ${MOTION.fast}; --dur-base: ${MOTION.base}; --dur-slow: ${MOTION.slow};
    }

    /* Map popups (building info, node info): grow out of the tapped point.
       Leaflet positions .leaflet-popup itself with a transform, so only its
       children animate. */
    .leaflet-popup-content-wrapper, .leaflet-popup-tip-container {
        transform-origin: 50% 100%;
        animation: uiPopupOpen var(--dur-base) var(--ease-out) both;
    }
    .leaflet-popup-tip-container { animation-delay: 40ms; }
    @keyframes uiPopupOpen { from { opacity: 0; transform: translateY(6px) scale(0.96); } }
    .leaflet-popup-content > * { animation: uiFadeUp var(--dur-base) var(--ease-out) 60ms both; }
    @keyframes uiFadeUp { from { opacity: 0; transform: translateY(4px); } }

    /* Buildings and paths ease their outline / fill on hover and focus. */
    path.campus-hit { transition: fill-opacity var(--dur-fast) var(--ease-out), stroke-width var(--dur-fast) var(--ease-out), stroke-opacity var(--dur-fast) var(--ease-out); }

    /* Map pane fade when the base map is swapped. */
    .leaflet-tile-container { transition: opacity var(--dur-slow) var(--ease-out); }

    /* Segmented toggles: one thumb slides to the chosen option. Set
       --seg-i (chosen index) and --seg-n (option count) on the container. */
    .seg {
        position: relative; display: grid; grid-auto-flow: column; grid-auto-columns: 1fr;
        gap: 3px; padding: 3px; border-radius: ${PILL}px; background: rgba(255,255,255,0.06); isolation: isolate;
    }
    .seg-thumb {
        position: absolute; z-index: -1; top: 3px; bottom: 3px; left: 3px;
        width: calc((100% - 6px - (var(--seg-n) - 1) * 3px) / var(--seg-n));
        border-radius: ${PILL - 3}px; background: ${C.primary};
        transform: translateX(calc(var(--seg-i) * (100% + 3px)));
        transition: transform var(--dur-base) var(--ease-in-out);
        box-shadow: ${ELEVATION.float};
    }
    .seg > button {
        position: relative; min-height: 44px; padding: 0 14px; border: 0; border-radius: ${PILL - 3}px; background: transparent;
        color: ${C.muted}; font: inherit; font-size: 13px; font-weight: 600; white-space: nowrap; cursor: pointer;
        transition: color var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out);
        -webkit-tap-highlight-color: transparent;
    }
    .seg > button:hover { color: #fff; }
    .seg > button:active { transform: scale(0.97); }
    .seg > button[aria-checked="true"] { color: #fff; }
    .seg > button:focus-visible { outline: 2px solid ${C.focus}; outline-offset: 1px; }

    /* Menus: rows arrive one after another, never all at once. */
    .ui-stagger > * { animation: uiFadeUp var(--dur-base) var(--ease-out) both; }
    .ui-stagger > *:nth-child(2) { animation-delay: 30ms; } .ui-stagger > *:nth-child(3) { animation-delay: 60ms; }
    .ui-stagger > *:nth-child(4) { animation-delay: 90ms; } .ui-stagger > *:nth-child(5) { animation-delay: 120ms; }
    .ui-stagger > *:nth-child(n+6) { animation-delay: 150ms; }

    @media (prefers-reduced-motion: reduce) {
        .leaflet-popup-content-wrapper, .leaflet-popup-tip-container, .leaflet-popup-content > *, .ui-stagger > * { animation: none !important; }
        .seg-thumb, .seg > button, path.campus-hit { transition: none !important; }
    }
`;

/** The one font stack for every screen (admin + mobile + 3D). */
export const FONT_STACK = `-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`;

/**
 * The type scale: display (one hero number per screen), title (page
 * titles), lead (card titles, phone inputs), sub (buttons, body), desc
 * (captions, field labels - nothing ships below 12px). Numbers stay legible
 * via `font-variant-numeric: tabular-nums` on the same stack, not a second
 * family. Form inputs are 16px on phones so iOS never zooms on focus.
 */
export const TYPE = {
    /** Hero numbers: the live distance readout, the login heading */
    display: '32px',
    /** Screen and page titles */
    title: '22px',
    /** Card titles, form inputs on phones (16px also stops iOS zoom) */
    lead: '16px',
    /** Buttons, labels, body copy */
    sub: '14px',
    /** Meta, captions, field labels - nothing ships below 12px */
    desc: '12px',
};

/** Form input text: 16px keeps iOS from zooming on focus. */
export const INPUT_TEXT = '16px';

/**
 * Shared interaction states - copied from `.mbtn` in MobileNav.
 * Every tappable control on both screens uses these.
 */
export const TAP = {
    /** WCAG 2.5.5 touch target */
    minHeight: '44px',
    activeScale: 0.96,
    focusOutline: `2px solid ${C.focus}`,
    disabledOpacity: 0.5,
};

/** Buttons look like buttons on both screens (`.mbtn` base). */
export const btnBase = `
    transition: background-color 0.15s ease, transform 0.15s ease, opacity 0.2s ease, box-shadow 0.2s ease;
    -webkit-tap-highlight-color: transparent;
    user-select: none;
    touch-action: manipulation;
    min-height: ${TAP.minHeight};
`;

/**
 * Caption style for every secondary label on the HUD. Sentence case and
 * lightly tracked: an all-caps label above every block made each card look
 * the same and slowed scanning. Applied through the `.tele` class below.
 */
export const TELEMETRY = `
    font-size: ${TYPE.desc};
    letter-spacing: 0.01em;
    font-weight: 600;
`;

/**
 * Shared CSS for the HUD language: glass panels, telemetry labels, glowing
 * accents. Injected by both screens so a panel looks identical in 2D and 3D.
 */
export const HUD_CSS = `
    .tele {
        ${TELEMETRY}
        color: ${C.muted};
    }

    /* Glass panel - the reference's backdrop-blur-2xl card, black/white. */
    .glass {
        background: ${C.glass};
        -webkit-backdrop-filter: blur(18px) saturate(140%);
        backdrop-filter: blur(18px) saturate(140%);
        border: 1px solid rgba(255, 255, 255, 0.07);
        border-radius: ${PANEL_RADIUS}px;
        box-shadow: ${ELEVATION.overlay};
    }

    /* Metric column pair: label above, tabular value below (reference cards). */
    .metric { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .metric-value {
        font-family: ${FONT_STACK};
        font-variant-numeric: tabular-nums;
        font-weight: 700;
        color: ${C.text};
    }
    .hud-divider { width: 1px; align-self: stretch; background: rgba(255, 255, 255, 0.10); }
`;

/**
 * Admin console class system (login, sidebar, departments, map panels).
 * Injected once by App.jsx. One definition of "a label", "a field", "a
 * button" and "a card" so no page restyles them inline - the redundancy this
 * replaces was the same 15-line style object copied into four files.
 *
 * Button hierarchy: primary (one per view), secondary (everything else),
 * danger (outlined - destructive but not the page's main action).
 */
export const ADMIN_CSS = `
    .ui-root { font-family: ${FONT_STACK}; color: ${C.text}; -webkit-font-smoothing: antialiased; }
    .ui-root *, .ui-root *::before, .ui-root *::after { box-sizing: border-box; }

    .ui-h1 { margin: 0; font-size: ${TYPE.title}; font-weight: 700; line-height: 1.25; letter-spacing: -0.01em; color: ${C.white}; }
    .ui-sub { margin: 6px 0 0; font-size: ${TYPE.sub}; line-height: 1.5; color: ${C.muted}; max-width: 62ch; }
    .ui-hint { font-size: ${TYPE.desc}; line-height: 1.45; color: ${C.muted}; }
    .ui-num { font-variant-numeric: tabular-nums; }

    .ui-card {
        background: rgba(16, 16, 20, 0.92);
        border: 1px solid ${C.hairline};
        border-radius: ${PANEL_RADIUS}px;
        padding: 18px;
    }
    .ui-card-title { margin: 0 0 14px; font-size: ${TYPE.lead}; font-weight: 700; color: ${C.white}; }

    /* Shared scroll-window treatment for every long list/panel. Keep scrolling
       inside the collection instead of letting it stretch the page/map HUD. */
    .ui-scroll-window {
        min-width: 0;
        overscroll-behavior: contain;
        -webkit-overflow-scrolling: touch;
        scrollbar-width: thin;
        scrollbar-color: rgba(255, 255, 255, 0.26) transparent;
    }
    .ui-scroll-window::-webkit-scrollbar { width: 8px; height: 8px; }
    .ui-scroll-window::-webkit-scrollbar-track { background: transparent; }
    .ui-scroll-window::-webkit-scrollbar-thumb {
        background: rgba(255, 255, 255, 0.24);
        border: 2px solid transparent;
        border-radius: 10px;
        background-clip: padding-box;
    }
    .ui-scroll-window::-webkit-scrollbar-thumb:hover { background-color: rgba(255, 255, 255, 0.4); }
    .ui-scroll-window:focus-visible { outline: ${TAP.focusOutline}; outline-offset: 2px; }

    .ui-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
    .ui-label { font-size: ${TYPE.desc}; font-weight: 600; color: ${C.muted}; }
    .ui-label .ui-req { color: ${C.errorBorder}; }
    .ui-input, .ui-select {
        width: 100%; min-height: 40px; padding: 9px 12px;
        background: ${C.field}; color: ${C.white};
        border: 1px solid ${C.fieldBorder}; border-radius: ${RADIUS}px;
        font: inherit; font-size: ${TYPE.sub}; color-scheme: dark;
        transition: border-color 0.25s var(--ease-out), box-shadow 0.35s var(--ease-out), background-color 0.25s var(--ease-out);
    }
    .ui-input::placeholder { color: ${C.placeholder}; }
    .ui-input:hover:not(:disabled), .ui-select:hover:not(:disabled) { border-color: #4a4a55; }
    .ui-input:focus-visible, .ui-select:focus-visible {
        outline: none; border-color: ${C.focus};
        box-shadow: 0 0 0 3px rgba(255, 255, 255, 0.22);
    }
    .ui-input:disabled, .ui-select:disabled { opacity: ${TAP.disabledOpacity}; cursor: not-allowed; }
    .ui-input[aria-invalid="true"] { border-color: ${C.errorBorder}; }
    /* Inline field error: the message under the field, in the danger colour. */
    .ui-field-error { font-size: ${TYPE.desc}; line-height: 1.4; color: ${C.danger}; }

    .ui-btn {
        display: inline-flex; align-items: center; justify-content: center; gap: 8px;
        min-height: 40px; padding: 0 18px; border-radius: ${PILL}px;
        border: 1px solid transparent; font: inherit; font-size: ${TYPE.sub}; font-weight: 600;
        white-space: nowrap; cursor: pointer; user-select: none;
        -webkit-tap-highlight-color: transparent; touch-action: manipulation;
        transition: background-color 0.2s var(--ease-out), border-color 0.2s var(--ease-out), transform 0.35s var(--ease-spring), opacity 0.2s ease;
    }
    .ui-btn:active:not(:disabled) { transform: scale(${TAP.activeScale}); }
    .ui-btn:focus-visible { outline: ${TAP.focusOutline}; outline-offset: 2px; }
    .ui-btn:disabled { opacity: ${TAP.disabledOpacity}; cursor: not-allowed; }
    .ui-btn-block { width: 100%; }
    /* Primary = confirm / save / go: green. Brand red stays on brand surfaces
       (wordmark, nav edge, login art); on a button it would read as "danger"
       next to Remove. */
    .ui-btn-primary { background: ${C.primary}; color: ${C.white}; }
    .ui-btn-primary:hover:not(:disabled) { background: ${C.primaryHover}; }
    .ui-btn-primary:active:not(:disabled) { background: ${C.primaryPress}; }
    .ui-btn-secondary { background: rgba(255, 255, 255, 0.06); color: ${C.white}; border-color: rgba(255, 255, 255, 0.14); }
    .ui-btn-secondary:hover:not(:disabled) { background: rgba(255, 255, 255, 0.12); }
    .ui-btn-danger { background: transparent; color: ${C.danger}; border-color: rgba(255, 85, 102, 0.5); }
    .ui-btn-danger:hover:not(:disabled) { background: rgba(255, 35, 56, 0.12); border-color: ${C.errorBorder}; }
    .ui-btn-sm { min-height: 34px; padding: 0 14px; }

    /* Status badges: one colour language for the whole app.
       ok = green, attention = amber, danger = red, neutral = grey. Text only,
       no icons; used for standalone statuses (roles, building status). */
    .ui-badge {
        display: inline-flex; align-items: center; padding: 2px 9px; border-radius: 6px;
        font-size: ${TYPE.desc}; font-weight: 700; line-height: 1.4; white-space: nowrap;
        border: 1px solid ${C.hairline}; background: rgba(255, 255, 255, 0.07); color: ${C.text};
    }
    .ui-badge-ok { background: rgba(74, 222, 128, 0.12); border-color: rgba(74, 222, 128, 0.35); color: ${C.accent}; }
    .ui-badge-attention { background: rgba(255, 159, 26, 0.12); border-color: rgba(255, 159, 26, 0.4); color: ${C.warning}; }
    .ui-badge-danger { background: rgba(255, 35, 56, 0.12); border-color: rgba(255, 85, 102, 0.45); color: ${C.danger}; }

    /* Empty state: what is missing and the one thing to do about it. */
    .ui-empty {
        display: flex; flex-direction: column; align-items: center; gap: 6px; text-align: center;
        margin: 12px 0 0; padding: 24px 16px; border: 1px dashed ${C.hairline}; border-radius: 12px;
        background: rgba(255, 255, 255, 0.02); color: ${C.muted}; font-size: ${TYPE.sub}; line-height: 1.5;
    }
    .ui-empty strong { color: ${C.text}; font-weight: 600; }

    .ui-alert {
        padding: 10px 12px; border-radius: ${RADIUS}px;
        background: ${C.dangerBg}; color: ${C.danger};
        border: 1px solid rgba(255, 35, 56, 0.5);
        font-size: ${TYPE.sub}; line-height: 1.45;
    }

    @media (max-width: 760px), (pointer: coarse) {
        .ui-btn, .ui-input, .ui-select { min-height: ${TAP.minHeight}; }
        .ui-btn-sm { min-height: ${TAP.minHeight}; }
        .ui-input, .ui-select { font-size: ${INPUT_TEXT}; }
        .ui-root button:not(.swatch), .ui-root [role="button"] { touch-action: manipulation; -webkit-tap-highlight-color: transparent; }
    }
    ${MOTION_CSS}
`;

/**
 * Leaflet zoom control, shared by the admin map and the student map so the
 * +/- buttons look and feel identical on both: one glass pill, 44px targets
 * everywhere (the TAP minimum, so it matches every other button), a hairline divider and the same press state.
 * `--zoom-stack` is the control's total height plus its margins, so overlays
 * (the admin legend) can sit directly under it without guessing.
 */
export const MAP_ZOOM_CSS = `
    :root { --zoom-btn: 44px; --zoom-stack: calc(var(--zoom-btn) * 2 + 24px); }

    .leaflet-top.leaflet-left .leaflet-control-zoom { margin: 12px 0 0 12px; }
    .leaflet-control-zoom.leaflet-bar {
        border: 1px solid ${C.hairline} !important; border-radius: ${RADIUS}px !important;
        overflow: hidden; box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5) !important;
        background: ${C.glass};
        -webkit-backdrop-filter: blur(18px) saturate(140%); backdrop-filter: blur(18px) saturate(140%);
    }
    .leaflet-control-zoom.leaflet-bar a {
        display: grid; place-items: center;
        width: var(--zoom-btn) !important; height: var(--zoom-btn) !important; line-height: 1 !important;
        font-size: 26px !important; font-weight: 500; text-indent: 0;
        background: transparent !important; color: #fff !important;
        border: 0 !important; border-radius: 0 !important;
        transition: background-color 0.25s var(--ease-out), transform 0.3s var(--ease-spring) !important;
        -webkit-tap-highlight-color: transparent; touch-action: manipulation;
    }
    .leaflet-control-zoom-in { border-bottom: 1px solid ${C.hairline} !important; }
    .leaflet-control-zoom.leaflet-bar a:hover { background: rgba(255, 255, 255, 0.09) !important; }
    .leaflet-control-zoom.leaflet-bar a:active { background: rgba(255, 255, 255, 0.16) !important; transform: scale(${TAP.activeScale}); }
    .leaflet-control-zoom.leaflet-bar a:focus-visible { outline: ${TAP.focusOutline}; outline-offset: -2px; }
    .leaflet-control-zoom.leaflet-bar a.leaflet-disabled { opacity: ${TAP.disabledOpacity}; background: transparent !important; cursor: not-allowed; }
`;
