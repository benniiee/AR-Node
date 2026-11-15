import React, { useEffect, useMemo, useRef, useState } from 'react';
import { C, TYPE, PANEL_RADIUS, ELEVATION, PILL } from '../uiTokens';
import { sunPosition, MIN_SUN_ALTITUDE_DEG } from '../sunShadow';

// ── Shadow time demo ────────────────────────────────────────────────
// Scrub the time of day (and pick a date) to see where the real sun would be
// and how the building shadows fall. `value` is the Date being shown, or null
// for live time; `onChange(date | null)` reports it. Play runs a whole day in
// about 20 seconds. Times are the device's local time (campus = UTC+8).

const STEP_MIN = 5;
const DAY_MIN = 24 * 60;
const PLAY_MS_PER_STEP = 70; // 288 steps a day -> ~20 s

const pad = (n) => String(n).padStart(2, '0');
const dateInputValue = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const minutesOf = (d) => d.getHours() * 60 + d.getMinutes();
const timeLabel = (mins) => {
    const h = Math.floor(mins / 60) % 24;
    const m = mins % 60;
    return `${h % 12 || 12}:${pad(m)} ${h < 12 ? 'AM' : 'PM'}`;
};
const compass = (deg) => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(deg / 45) % 8];

const CSS = `
    .sun-demo {
        width: min(360px, calc(100vw - 16px)); padding: 12px 14px; border-radius: ${PANEL_RADIUS}px;
        background: ${C.glass}; color: ${C.text}; border: 1px solid ${C.hairline};
        -webkit-backdrop-filter: blur(18px) saturate(140%); backdrop-filter: blur(18px) saturate(140%);
        box-shadow: ${ELEVATION.raised};
        animation: sunDemoIn 0.26s cubic-bezier(0.16, 1, 0.3, 1) both;
    }
    @keyframes sunDemoIn { from { opacity: 0; transform: translateY(8px); } }
    @media (prefers-reduced-motion: reduce) { .sun-demo { animation: none; } }
    .sun-demo-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
    .sun-demo-title { margin: 0; font-size: ${TYPE.sub}; font-weight: 700; color: #fff; }
    .sun-demo-time { font-size: ${TYPE.lead}; font-weight: 800; color: #fff; font-variant-numeric: tabular-nums; }
    .sun-demo-mode { font-size: ${TYPE.desc}; font-weight: 700; color: ${C.accent}; }
    .sun-demo-mode.is-demo { color: ${C.warning}; }
    .sun-demo-range { width: 100%; margin: 10px 0 2px; accent-color: ${C.warning}; height: 28px; cursor: pointer; }
    .sun-demo-range:focus-visible { outline: 2px solid ${C.focus}; outline-offset: 2px; border-radius: 6px; }
    .sun-demo-ticks { display: flex; justify-content: space-between; font-size: ${TYPE.desc}; color: ${C.muted}; font-variant-numeric: tabular-nums; }
    .sun-demo-read { margin: 8px 0 0; font-size: ${TYPE.desc}; line-height: 1.45; color: ${C.muted}; font-variant-numeric: tabular-nums; min-height: 18px; }
    .sun-demo-read b { color: ${C.text}; font-weight: 600; }
    .sun-demo-row { display: flex; gap: 8px; margin-top: 10px; align-items: center; }
    .sun-demo-row input[type="date"] {
        flex: 1; min-width: 0; min-height: 38px; padding: 0 10px; border-radius: 8px;
        border: 1px solid ${C.fieldBorder}; background: ${C.field}; color: #fff; font: inherit; font-size: 13px; color-scheme: dark;
    }
    .sun-demo-row input[type="date"]:focus-visible { outline: none; border-color: ${C.focus}; box-shadow: 0 0 0 3px rgba(255,255,255,0.22); }
    .sun-demo-btn {
        flex: none; min-height: 38px; padding: 0 16px; border-radius: ${PILL}px; cursor: pointer;
        border: 1px solid rgba(255,255,255,0.14); background: rgba(255,255,255,0.06); color: #fff;
        font: inherit; font-size: 13px; font-weight: 700; transition: background-color 160ms ease, transform 160ms ease;
    }
    .sun-demo-btn:hover:not(:disabled) { background: rgba(255,255,255,0.12); }
    .sun-demo-btn:active:not(:disabled) { transform: scale(0.97); }
    .sun-demo-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .sun-demo-btn:focus-visible { outline: 2px solid ${C.focus}; outline-offset: 2px; }
    .sun-demo-btn.is-primary { background: ${C.primary}; border-color: transparent; }
    .sun-demo-btn.is-primary:hover:not(:disabled) { background: ${C.primaryHover}; }
    @media (max-width: 640px) {
        .sun-demo-row input[type="date"], .sun-demo-btn { min-height: 44px; }
    }
`;

export default function SunTimeSlider({ value, onChange, lat, lng, onClose = null }) {
    // Live clock for the "Now" display; ticks every 30 s while live.
    const [now, setNow] = useState(() => new Date());
    useEffect(() => {
        if (value) return undefined;
        const t = setInterval(() => setNow(new Date()), 30000);
        return () => clearInterval(t);
    }, [value]);

    const shown = value || now;
    const mins = minutesOf(shown);
    const sun = useMemo(() => sunPosition(shown, lat, lng), [shown, lat, lng]);

    const at = (day, minutes) => {
        const d = new Date(day);
        d.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
        return d;
    };

    // Play: step through the day from the current position, looping at midnight.
    const [playing, setPlaying] = useState(false);
    const playRef = useRef({ day: shown, mins });
    playRef.current = { day: shown, mins };
    useEffect(() => {
        if (!playing) return undefined;
        const t = setInterval(() => {
            const { day, mins: m } = playRef.current;
            onChange(at(day, (m + STEP_MIN) % DAY_MIN));
        }, PLAY_MS_PER_STEP);
        return () => clearInterval(t);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [playing]);

    const setTime = (m) => { setPlaying(false); onChange(at(shown, m)); };
    const setDate = (iso) => {
        if (!iso) return;
        const [y, mo, d] = iso.split('-').map(Number);
        const day = new Date(shown);
        day.setFullYear(y, mo - 1, d);
        onChange(day);
    };
    const live = () => { setPlaying(false); onChange(null); };

    const up = sun.altitudeDeg >= MIN_SUN_ALTITUDE_DEG;
    return (
        <section className="sun-demo" aria-label="Shadow time demo">
            <style>{CSS}</style>
            <div className="sun-demo-head">
                <h2 className="sun-demo-title">Shadow time demo</h2>
                <span className={`sun-demo-mode${value ? ' is-demo' : ''}`}>{value ? 'Demo time' : 'Live'}</span>
            </div>
            <div className="sun-demo-time" aria-live="polite">{timeLabel(mins)}</div>
            <input
                className="sun-demo-range" type="range" min={0} max={DAY_MIN - STEP_MIN} step={STEP_MIN}
                value={mins - (mins % STEP_MIN)} onChange={(e) => setTime(Number(e.target.value))}
                aria-label="Time of day" aria-valuetext={timeLabel(mins)}
            />
            <div className="sun-demo-ticks" aria-hidden="true">
                <span>12 AM</span><span>6 AM</span><span>12 PM</span><span>6 PM</span><span>12 AM</span>
            </div>
            <p className="sun-demo-read">
                {up
                    ? <>Sun <b>{sun.altitudeDeg.toFixed(1)}°</b> up, in the <b>{compass(sun.azimuthDeg)}</b> ({Math.round(sun.azimuthDeg)}°) · shadows fall to the <b>{compass((sun.azimuthDeg + 180) % 360)}</b></>
                    : <>Sun below the horizon ({sun.altitudeDeg.toFixed(1)}°) · no shadows</>}
            </p>
            <div className="sun-demo-row">
                <input type="date" aria-label="Date" value={dateInputValue(shown)} onChange={(e) => setDate(e.target.value)} />
                <button type="button" className="sun-demo-btn is-primary" onClick={() => setPlaying((p) => !p)} aria-pressed={playing}>
                    {playing ? 'Pause' : 'Play day'}
                </button>
                <button type="button" className="sun-demo-btn" onClick={live} disabled={!value && !playing}>Now</button>
                {onClose && <button type="button" className="sun-demo-btn" onClick={() => { live(); onClose(); }}>Close</button>}
            </div>
        </section>
    );
}
