import React, { useEffect, useId, useRef, useState } from 'react';
import { C, ELEVATION, PANEL_RADIUS, TAP } from '../uiTokens';
import WeatherChip from './WeatherChip';
import RainReportButton from './RainReportButton';

/**
 * The weather on the map: one pill at the bottom centre with the line that matters ("Extreme
 * heat: outdoor paths closed"), in the same glass as the other floating map controls. Colour
 * sits only on its small icon. Tapping it opens the details above it
 * (disclosure: next-hour rain, heat outlook, UV, "It's raining here"); tapping outside or
 * Escape closes them and focus returns to the pill.
 */
export default function WeatherPill({ weather, shadeActive = false, headers, onWeather }) {
    const [open, setOpen] = useState(false);
    const wrapRef = useRef(null);
    const buttonRef = useRef(null);
    const panelId = useId();

    useEffect(() => {
        if (!open) return undefined;
        const onDown = (e) => { if (!wrapRef.current?.contains(e.target)) setOpen(false); };
        const onKey = (e) => {
            if (e.key !== 'Escape') return;
            setOpen(false);
            buttonRef.current?.focus();
        };
        document.addEventListener('pointerdown', onDown);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('pointerdown', onDown);
            document.removeEventListener('keydown', onKey);
        };
    }, [open]);

    return (
        <div ref={wrapRef} className="wx-pill-wrap" onClick={(e) => e.stopPropagation()}>
            <style>{WEATHER_PILL_CSS}</style>
            {open && (
                <div id={panelId} className="wx-panel" role="region" aria-label="Weather details">
                    <WeatherChip weather={weather} inline detailsOnly shadeActive={shadeActive} />
                    {!weather.raining_now && <RainReportButton headers={headers} onWeather={onWeather} />}
                </div>
            )}
            <button
                ref={buttonRef}
                type="button"
                className="wx-pill"
                aria-expanded={open}
                aria-controls={open ? panelId : undefined}
                onClick={() => setOpen((v) => !v)}
            >
                <WeatherChip weather={weather} inline compact shadeActive={shadeActive} />
                <svg className="wx-pill-chevron" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path d="M4 10l4-4 4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
            </button>
        </div>
    );
}

const WEATHER_PILL_CSS = `
    .wx-pill-wrap { position: relative; max-width: 100%; display: flex; justify-content: center; }
    .wx-pill {
        display: inline-flex; align-items: center; gap: 10px; max-width: 100%; min-width: 0;
        min-height: ${TAP.minHeight}; padding: 0 14px 0 16px; border-radius: 999px;
        border: 1px solid ${C.hairline}; background: ${C.glass}; box-shadow: ${ELEVATION.float};
        -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px);
        color: ${C.text}; font: inherit; cursor: pointer;
        transition: background-color 160ms ease, transform 160ms ease;
    }
    .wx-pill:hover { background: ${C.bar}; }
    .wx-pill:active { transform: scale(${TAP.activeScale}); }
    .wx-pill:focus-visible { outline: ${TAP.focusOutline}; outline-offset: 2px; }
    .wx-pill-chevron { flex: none; color: ${C.muted}; transition: transform 160ms ease; }
    .wx-pill[aria-expanded="true"] .wx-pill-chevron { transform: rotate(180deg); }
    .wx-panel {
        position: absolute; left: 50%; bottom: calc(100% + 8px); transform: translateX(-50%);
        width: min(360px, calc(100vw - 24px)); padding: 12px 14px; border-radius: ${PANEL_RADIUS}px;
        border: 1px solid ${C.hairline}; background: ${C.glass}; box-shadow: ${ELEVATION.overlay};
        -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px);
        animation: wxPanelIn var(--dur-base, 200ms) var(--ease-out, ease) both;
    }
    @keyframes wxPanelIn { from { opacity: 0; transform: translate(-50%, 6px); } }
    /* Landscape phones: the map stack sits bottom-right, so the panel opens right-aligned. */
    @media (max-height: 520px) and (min-width: 560px) {
        .wx-panel { left: auto; right: 0; transform: none; }
        @keyframes wxPanelIn { from { opacity: 0; } }
    }
    @media (prefers-reduced-motion: reduce) {
        .wx-pill:active { transform: none; }
        .wx-pill-chevron { transition: none; }
        .wx-panel { animation: none; }
    }
`;
