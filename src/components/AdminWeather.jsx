import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { C, TYPE, TAP } from '../uiTokens';
import { heatCategory, heatLabel } from '../heatIndex';
import InfoIcon from './InfoIcon';

/*
 * Weather Dashboard (admin only): is the rain model and the heat model working
 * in real life? Every 10-minute weather refresh is recorded on the server
 * (weather_predictions) and later checked against the RPMZ airport report.
 * The same summary feeds ml/gui.py (php artisan weather:history).
 *
 * Charts are plain SVG (no chart library). Colour follows the entity on every
 * chart: blue = our model, orange = Open-Meteo's own number, aqua = what the
 * airport observed. Dark steps validated for CVD and contrast on #101014.
 */
const COLOR = { model: '#3987e5', provider: '#d95926', airport: '#199e70', dry: '#6b6b76', unchecked: '#34343c' };
const SURFACE = '#101014';
const GRID = 'rgba(255, 255, 255, 0.08)';
const AXIS_TEXT = C.muted;
const TZ = 'Asia/Manila';
const PERIODS = [{ days: 1, label: '24 hours' }, { days: 7, label: '7 days' }, { days: 30, label: '30 days' }, { days: 90, label: '90 days' }];
/** Gaps longer than this (minutes) break a line instead of joining across server downtime. */
const MAX_JOIN_MINUTES = 75;

const fmt = {
    clock: new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true }),
    hour: new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hour12: true }),
    day: new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'short', day: 'numeric' }),
    full: new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }),
};
const pct = (v) => (v === null || v === undefined ? '-' : `${Math.round(v)}%`);
const deg = (v) => (v === null || v === undefined ? '-' : `${Number(v).toFixed(1)} °C`);
const num = (v, d = 3) => (v === null || v === undefined ? '-' : Number(v).toFixed(d));

const CSS = `
    .wx-page {
        position: absolute; inset: 0; min-height: 0; overflow-y: auto; -webkit-overflow-scrolling: touch;
        background: ${C.page}; padding: clamp(20px, 2.5vw, 30px) clamp(16px, 2.25vw, 26px) 44px;
        animation: fadeIn var(--dur-slow) var(--ease-out) both;
    }
    .wx-inner { width: 100%; max-width: 1180px; margin: 0 auto; display: flex; flex-direction: column; gap: 22px; }
    .wx-filters { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .wx-seg { display: inline-flex; padding: 3px; border-radius: 10px; background: ${C.field}; border: 1px solid ${C.fieldBorder}; }
    .wx-seg button {
        min-height: 34px; padding: 0 14px; border: 0; border-radius: 7px; background: transparent; color: ${C.muted};
        font: inherit; font-size: ${TYPE.sub}; font-weight: 600; cursor: pointer;
    }
    .wx-seg button[aria-pressed="true"] { background: ${C.surfaceHover}; color: ${C.white}; }
    .wx-seg button:focus-visible { outline: 2px solid ${C.focus}; outline-offset: 1px; }
    .wx-updated { font-size: ${TYPE.desc}; color: ${C.muted}; margin-left: 4px; }
    .wx-update { margin-left: auto; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; justify-content: flex-end; }
    .wx-update .ui-btn:disabled { opacity: 0.6; cursor: progress; }
    .wx-loading { opacity: 0.55; transition: opacity var(--dur-base) var(--ease-out); }
    .wx-card-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 14px; }
    .wx-card-head .ui-card-title { margin: 0; display: flex; align-items: center; }
    .wx-page .ui-h1 { display: flex; align-items: center; }
    .wx-tiles { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin-bottom: 18px; }
    .wx-now { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
    .wx-now .wx-tile { background: rgba(16, 16, 20, 0.92); }
    .wx-more { margin-top: 16px; border-top: 1px solid ${C.hairline}; padding-top: 12px; }
    .wx-more > summary {
        cursor: pointer; font-size: ${TYPE.sub}; font-weight: 600; color: ${C.muted}; list-style: none;
        display: inline-flex; align-items: center; gap: 8px; min-height: 32px; border-radius: 6px;
    }
    .wx-more > summary::-webkit-details-marker { display: none; }
    .wx-more > summary::before { content: '›'; display: inline-block; transition: transform var(--dur-fast) var(--ease-out); font-size: 16px; }
    .wx-more[open] > summary::before { transform: rotate(90deg); }
    .wx-more > summary:hover { color: ${C.white}; }
    .wx-more > summary:focus-visible { outline: 2px solid ${C.focus}; outline-offset: 2px; }
    .wx-more-body { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 18px; margin-top: 12px; }
    .ui-card.wx-more { margin-top: 0; padding: 12px 18px; }
    .wx-tipwrap { position: relative; display: inline-flex; align-items: center; outline: none; }
    .wx-tipwrap-block { display: block; }
    /* A tile with a tooltip sits inside .wx-tipwrap-block: fill it, so every tile in a row is the same height. */
    .wx-tipwrap-block > .wx-tile { height: 100%; box-sizing: border-box; }
    .wx-tipwrap:focus-visible { outline: 2px solid ${C.focus}; outline-offset: 3px; border-radius: 10px; }
    .wx-legend-row { display: flex; align-items: center; gap: 10px; margin: 4px 0 6px; }
    .wx-legend-row .wx-legend { margin: 0; }
    .wx-glossary { margin: 0; padding-left: 18px; font-size: ${TYPE.desc}; color: ${C.muted}; line-height: 1.6; }
    .wx-tile { background: rgba(255,255,255,0.03); border: 1px solid ${C.hairline}; border-radius: 10px; padding: 12px 14px; min-width: 0; }
    .wx-tile-label { display: flex; align-items: center; font-size: ${TYPE.sub}; color: ${C.muted}; }
    .wx-tile-value { font-size: 22px; font-weight: 700; color: ${C.white}; margin-top: 4px; }
    .wx-tile-sub { font-size: ${TYPE.desc}; color: ${C.muted}; margin-top: 2px; line-height: 1.4; }
    .wx-charts { display: grid; grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr); gap: 18px; }
    .wx-chart-title { font-size: ${TYPE.sub}; font-weight: 600; color: ${C.white}; margin: 0 0 2px; }
    .wx-chart-sub { font-size: ${TYPE.desc}; color: ${C.muted}; margin: 0 0 8px; line-height: 1.4; }
    .wx-legend { display: flex; gap: 14px; flex-wrap: wrap; font-size: ${TYPE.desc}; color: ${C.muted}; margin: 0 0 6px; }
    .wx-legend span { display: inline-flex; align-items: center; gap: 6px; }
    .wx-plot { position: relative; }
    .wx-plot svg { display: block; overflow: visible; }
    .wx-plot svg:focus-visible { outline: 2px solid ${C.focus}; outline-offset: 2px; border-radius: 4px; }
    .wx-tip {
        position: absolute; top: 4px; pointer-events: none; z-index: 2; min-width: 150px;
        background: ${C.bar}; border: 1px solid ${C.border}; border-radius: 8px; padding: 8px 10px;
        font-size: ${TYPE.desc}; color: ${C.muted}; box-shadow: 0 6px 18px rgba(0,0,0,0.45);
    }
    .wx-tip-head { color: ${C.text}; margin-bottom: 4px; }
    .wx-tip-row { display: flex; align-items: center; gap: 8px; line-height: 1.6; white-space: nowrap; }
    .wx-tip-row b { color: ${C.white}; font-variant-numeric: tabular-nums; }
    .wx-empty { padding: 28px 8px; text-align: center; color: ${C.muted}; font-size: ${TYPE.sub}; line-height: 1.6; }
    .wx-table-wrap { overflow-x: auto; }
    .wx-table { width: 100%; border-collapse: collapse; font-size: ${TYPE.desc}; font-variant-numeric: tabular-nums; }
    .wx-table th { text-align: right; font-weight: 600; color: ${C.muted}; padding: 8px 10px; border-bottom: 1px solid ${C.hairline}; white-space: nowrap; }
    .wx-table td { text-align: right; padding: 7px 10px; border-bottom: 1px solid ${C.hairline}; color: ${C.text}; white-space: nowrap; }
    .wx-table th:first-child, .wx-table td:first-child { text-align: left; }
    .wx-note { font-size: ${TYPE.desc}; color: ${C.muted}; line-height: 1.5; margin: 12px 0 0; max-width: 90ch; }
    @media (max-width: 900px) {
        .wx-charts, .wx-more-body { grid-template-columns: minmax(0, 1fr); }
    }
    /* Phones: the three tiles stay one row (smaller type) instead of stacking into a tall
       column; the period switch spans the width and Update now sits under it. */
    @media (max-width: 760px) {
        .wx-now { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
    @media (max-width: 600px) {
        .wx-inner { gap: 16px; }
        .wx-tiles, .wx-now { gap: 6px; }
        .wx-tile { padding: 9px 10px; }
        .wx-tile-label { display: block; font-size: ${TYPE.desc}; line-height: 1.35; }
        .wx-tile-label .ui-info-icon { vertical-align: middle; }
        .wx-tile-value { font-size: 17px; line-height: 1.25; overflow-wrap: anywhere; }
        .wx-seg { display: flex; width: 100%; }
        .wx-seg button { flex: 1 1 0; padding: 0 6px; min-height: ${TAP.minHeight}; }
        .wx-update { width: 100%; margin-left: 0; justify-content: space-between; }
    }
    @media (max-width: 340px) {
        .wx-tiles, .wx-now { grid-template-columns: minmax(0, 1fr); }
    }
    /* Touch screens of any size: 44 px period buttons. */
    @media (pointer: coarse) { .wx-seg button { min-height: ${TAP.minHeight}; } }
`;

function useWidth() {
    const ref = useRef(null);
    const [width, setWidth] = useState(0);
    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return undefined;
        const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
        observer.observe(el);
        return () => observer.disconnect();
    }, []);
    return [ref, width];
}

/** A short line key (lines) or a square swatch (bars). */
const Key = ({ color, kind = 'line' }) => (
    <svg width="14" height="10" aria-hidden="true">
        {kind === 'line'
            ? <line x1="1" y1="5" x2="13" y2="5" stroke={color} strokeWidth="3" strokeLinecap="round" />
            : kind === 'dot'
                ? <circle cx="7" cy="5" r="4" fill={color} />
                : <rect x="2" y="1" width="10" height="8" rx="2" fill={color} />}
    </svg>
);

function Legend({ items }) {
    return (
        <div className="wx-legend">
            {items.map((it) => <span key={it.label}><Key color={it.color} kind={it.kind} />{it.label}</span>)}
        </div>
    );
}

function niceTicks(min, max, count = 5) {
    const span = max - min || 1;
    const raw = span / count;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= count) || 10 * mag;
    const out = [];
    for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(Number(v.toFixed(6)));
    return out;
}

/**
 * Time series: 2px lines (broken at missing values and long gaps), optional dot series,
 * optional outcome rug under the plot, crosshair + one tooltip listing every series.
 */
function TimeChart({ points, lines, dots = [], rug = null, yDomain, yFormat, height = 230, label }) {
    const [ref, width] = useWidth();
    const [hover, setHover] = useState(null);
    const m = { top: 10, right: 12, bottom: 26 + (rug ? 16 : 0), left: 44 };
    const w = Math.max(0, width - m.left - m.right);
    const h = height - m.top - m.bottom;
    const t0 = points.length ? points[0].t : 0;
    const t1 = points.length ? points[points.length - 1].t : 1;
    const pad = t1 === t0 ? 30 * 60000 : 0;
    const x = (t) => m.left + ((t - (t0 - pad)) / ((t1 + pad) - (t0 - pad))) * w;
    const [y0, y1] = yDomain;
    const y = (v) => m.top + h - ((v - y0) / (y1 - y0)) * h;
    const yTicks = niceTicks(y0, y1, 4);
    const daySpan = (t1 - t0) / 86400000;
    const xTicks = useMemo(() => {
        if (!points.length || w <= 0) return [];
        const n = Math.max(2, Math.min(6, Math.floor(w / 110)));
        return Array.from({ length: n }, (_, i) => t0 - pad + ((t1 + pad - (t0 - pad)) * i) / (n - 1));
    }, [points.length, w, t0, t1, pad]);
    const xLabel = (t) => (daySpan > 1.5 ? fmt.day.format(t) : fmt.hour.format(t));

    const paths = useMemo(() => lines.map((line) => {
        const segs = [];
        let cur = [];
        let prevT = null;
        for (const p of points) {
            const v = p.values[line.key];
            const broken = v === null || v === undefined || (prevT !== null && p.t - prevT > MAX_JOIN_MINUTES * 60000);
            if (broken && cur.length) { segs.push(cur); cur = []; }
            if (v !== null && v !== undefined) cur.push([x(p.t), y(v)]);
            prevT = p.t;
        }
        if (cur.length) segs.push(cur);
        // Connectors across gaps (no data recorded in between), so the trend still reads.
        const bridges = segs.slice(1).map((seg, i) => [segs[i][segs[i].length - 1], seg[0]]);
        return { ...line, segs, bridges };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }), [points, lines, width, y0, y1]);

    // Measured dots are joined by a thin line too, so their change over time is visible.
    const dotLines = useMemo(() => dots.map((d) => ({
        ...d,
        pts: points.filter((p) => p.values[d.key] !== null && p.values[d.key] !== undefined).map((p) => [x(p.t), y(p.values[d.key])]),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    })), [points, dots, width, y0, y1]);

    const nearest = useCallback((px) => {
        let lo = 0;
        let hi = points.length - 1;
        while (hi - lo > 1) {
            const mid = (lo + hi) >> 1;
            if (x(points[mid].t) < px) lo = mid; else hi = mid;
        }
        return Math.abs(x(points[lo].t) - px) <= Math.abs(x(points[hi].t) - px) ? lo : hi;
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [points, width]);

    const onMove = (e) => {
        if (!points.length) return;
        const box = e.currentTarget.getBoundingClientRect();
        setHover(nearest(e.clientX - box.left));
    };
    const onKey = (e) => {
        if (!points.length) return;
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            e.preventDefault();
            setHover((i) => Math.max(0, Math.min(points.length - 1, (i ?? points.length - 1) + (e.key === 'ArrowLeft' ? -1 : 1))));
        }
    };

    const hp = hover !== null ? points[hover] : null;
    const tipLeft = hp ? Math.min(Math.max(0, x(hp.t) + 12), Math.max(0, width - 190)) : 0;

    return (
        <div className="wx-plot" ref={ref}>
            {width > 0 && (
                <svg
                    width={width} height={height} role="img" aria-label={label} tabIndex={0}
                    onPointerMove={onMove} onPointerLeave={() => setHover(null)} onFocus={() => setHover(points.length - 1)} onBlur={() => setHover(null)} onKeyDown={onKey}
                >
                    {yTicks.map((v) => (
                        <g key={v}>
                            <line x1={m.left} x2={m.left + w} y1={y(v)} y2={y(v)} stroke={GRID} strokeWidth="1" />
                            <text x={m.left - 8} y={y(v)} dy="0.32em" textAnchor="end" fontSize="11" fill={AXIS_TEXT} style={{ fontVariantNumeric: 'tabular-nums' }}>{yFormat(v)}</text>
                        </g>
                    ))}
                    {xTicks.map((t, i) => (
                        <text key={t} x={x(t)} y={height - 6} textAnchor={i === 0 ? 'start' : i === xTicks.length - 1 ? 'end' : 'middle'} fontSize="11" fill={AXIS_TEXT}>{xLabel(t)}</text>
                    ))}
                    {rug && points.map((p, i) => {
                        const state = rug(p);
                        if (!state) return null;
                        return <rect key={i} x={x(p.t) - 1.5} y={m.top + h + 6} width="3" height="9" rx="1" fill={state === 'rain' ? COLOR.airport : COLOR.dry} />;
                    })}
                    {dotLines.map((d) => (d.pts.length > 1
                        ? <polyline key={`${d.key}-join`} points={d.pts.map((pt) => pt.join(',')).join(' ')} fill="none" stroke={d.color} strokeWidth="2.5" strokeLinejoin="round" />
                        : null))}
                    {paths.map((line) => line.bridges.map(([a, b], i) => (
                        <line key={`${line.key}-gap${i}`} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke={line.color} strokeWidth="2.5" strokeLinecap="round" />
                    )))}
                    {paths.map((line) => line.segs.map((seg, i) => (seg.length === 1
                        ? <circle key={`${line.key}${i}`} cx={seg[0][0]} cy={seg[0][1]} r="4" fill={line.color} stroke={SURFACE} strokeWidth="1.5" />
                        : <polyline key={`${line.key}${i}`} points={seg.map((pt) => pt.join(',')).join(' ')} fill="none" stroke={line.color} strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />)))}
                    {dots.map((d) => points.map((p, i) => {
                        const v = p.values[d.key];
                        return v === null || v === undefined ? null
                            : <circle key={`${d.key}${i}`} cx={x(p.t)} cy={y(v)} r="4" fill={d.color} stroke={SURFACE} strokeWidth="2" />;
                    }))}
                    {hp && (
                        <g pointerEvents="none">
                            <line x1={x(hp.t)} x2={x(hp.t)} y1={m.top} y2={m.top + h} stroke={C.muted} strokeWidth="1" />
                            {[...lines, ...dots].map((s) => {
                                const v = hp.values[s.key];
                                return v === null || v === undefined ? null
                                    : <circle key={s.key} cx={x(hp.t)} cy={y(v)} r="4.5" fill={s.color} stroke={SURFACE} strokeWidth="2" />;
                            })}
                        </g>
                    )}
                </svg>
            )}
            {hp && (
                <div className="wx-tip" style={{ left: tipLeft }}>
                    <div className="wx-tip-head">{fmt.full.format(hp.t)}</div>
                    {[...lines, ...dots].map((s) => (
                        <div className="wx-tip-row" key={s.key}>
                            <Key color={s.color} kind={dots.includes(s) ? 'dot' : 'line'} />
                            <b>{hp.values[s.key] === null || hp.values[s.key] === undefined ? '-' : yFormat(hp.values[s.key], true)}</b>
                            <span>{s.label}</span>
                        </div>
                    ))}
                    {hp.note && <div className="wx-tip-row">{hp.note}</div>}
                </div>
            )}
        </div>
    );
}

/** Rounded data-end, square baseline: a column path with 4px top corners. */
function columnPath(x, y, w, h, r = 4) {
    const rr = Math.min(r, w / 2, h);
    return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

/**
 * Histogram: one column per bin, either stacked segments (2px surface gap, only the top
 * segment rounded) or grouped columns. Hovering a bin shows every count in it.
 */
function Histogram({ bins, series, mode = 'stack', edgeLabel, labelEvery = 1, height = 230, label, unitNote }) {
    const [ref, width] = useWidth();
    const [hover, setHover] = useState(null);
    const m = { top: 10, right: 8, bottom: 26, left: 36 };
    const w = Math.max(0, width - m.left - m.right);
    const h = height - m.top - m.bottom;
    const band = bins.length ? w / bins.length : 0;
    const totals = bins.map((b) => (mode === 'stack' ? series.reduce((s, se) => s + (b[se.key] || 0), 0) : Math.max(...series.map((se) => b[se.key] || 0))));
    const maxY = Math.max(1, ...totals);
    const yTicks = niceTicks(0, maxY, 4).filter((v) => Number.isInteger(v));
    // Close the axis with a gridline above the tallest column.
    if (yTicks[yTicks.length - 1] < maxY) {
        yTicks.push(yTicks[yTicks.length - 1] + (yTicks.length > 1 ? yTicks[1] - yTicks[0] : maxY));
    }
    const yTop = yTicks[yTicks.length - 1] || 1;
    const y = (v) => m.top + h - (v / yTop) * h;
    const colW = mode === 'stack' ? Math.min(24, band - 6) : Math.min(14, (band - 8) / series.length);

    return (
        <div className="wx-plot" ref={ref}>
            {width > 0 && (
                <svg width={width} height={height} role="img" aria-label={label} onPointerLeave={() => setHover(null)}>
                    {yTicks.map((v) => (
                        <g key={v}>
                            <line x1={m.left} x2={m.left + w} y1={y(v)} y2={y(v)} stroke={GRID} strokeWidth="1" />
                            <text x={m.left - 8} y={y(v)} dy="0.32em" textAnchor="end" fontSize="11" fill={AXIS_TEXT} style={{ fontVariantNumeric: 'tabular-nums' }}>{v}</text>
                        </g>
                    ))}
                    {bins.map((b, i) => {
                        const left = m.left + i * band;
                        const cx = left + band / 2;
                        let shapes = [];
                        if (mode === 'stack') {
                            let base = 0;
                            const parts = series.map((se) => ({ se, v: b[se.key] || 0 })).filter((p) => p.v > 0);
                            shapes = parts.map((p, k) => {
                                const yTopPx = y(base + p.v);
                                const yBotPx = y(base) - (k > 0 ? 2 : 0);
                                base += p.v;
                                const segH = Math.max(0, yBotPx - yTopPx);
                                return k === parts.length - 1
                                    ? <path key={p.se.key} d={columnPath(cx - colW / 2, yTopPx, colW, segH)} fill={p.se.color} />
                                    : <rect key={p.se.key} x={cx - colW / 2} y={yTopPx} width={colW} height={segH} fill={p.se.color} />;
                            });
                        } else {
                            const groupW = series.length * colW + (series.length - 1) * 2;
                            shapes = series.map((se, k) => {
                                const v = b[se.key] || 0;
                                return v > 0 ? <path key={se.key} d={columnPath(cx - groupW / 2 + k * (colW + 2), y(v), colW, y(0) - y(v))} fill={se.color} /> : null;
                            });
                        }
                        return (
                            <g key={i} opacity={hover === null || hover === i ? 1 : 0.55}>
                                {shapes}
                                <rect x={left} y={m.top} width={band} height={h} fill="transparent" onPointerEnter={() => setHover(i)} />
                            </g>
                        );
                    })}
                    <line x1={m.left} x2={m.left + w} y1={y(0)} y2={y(0)} stroke={C.border} strokeWidth="1" />
                    {bins.map((b, i) => (i % labelEvery === 0 ? (
                        <text key={i} x={m.left + i * band} y={height - 6} textAnchor="middle" fontSize="11" fill={AXIS_TEXT}>{edgeLabel(b.from)}</text>
                    ) : null))}
                    {bins.length > 0 && (
                        <text x={m.left + w} y={height - 6} textAnchor="middle" fontSize="11" fill={AXIS_TEXT}>{edgeLabel(bins[bins.length - 1].to)}</text>
                    )}
                </svg>
            )}
            {hover !== null && bins[hover] && (
                <div className="wx-tip" style={{ left: Math.min(Math.max(0, m.left + (hover + 1) * band + 6), Math.max(0, width - 190)) }}>
                    <div className="wx-tip-head">{edgeLabel(bins[hover].from)} to {edgeLabel(bins[hover].to)}{unitNote ? ` ${unitNote}` : ''}</div>
                    {series.map((se) => (
                        <div className="wx-tip-row" key={se.key}><Key color={se.color} kind="bar" /><b>{bins[hover][se.key] || 0}</b><span>{se.label}</span></div>
                    ))}
                </div>
            )}
        </div>
    );
}

/**
 * Hover (or keyboard focus) help: the explanation lives in a tooltip instead of on the page,
 * so the dashboard shows only labels and numbers. Shown by the app-wide TooltipLayer (always
 * on top, centred); screen readers read it as hidden text.
 */
function Tip({ text, children, block = false, focusable = true }) {
    const Tag = block ? 'div' : 'span';
    return (
        <Tag className={`wx-tipwrap${block ? ' wx-tipwrap-block' : ''}`} tabIndex={focusable ? 0 : undefined} data-tip={text}>
            {children}
            <span className="sr-only">{text}</span>
        </Tag>
    );
}

const Info = InfoIcon;

function Tile({ label, value, sub, tip }) {
    const body = (
        <div className="wx-tile">
            <div className="wx-tile-label">{label}{tip && <Info />}</div>
            <div className="wx-tile-value">{value}</div>
            {sub && <div className="wx-tile-sub">{sub}</div>}
        </div>
    );
    return tip ? <Tip text={tip} block>{body}</Tip> : body;
}

/** Below this many checked moments a verdict would be a guess. */
const MIN_RAIN_CHECKS = 30;
const MIN_HEAT_CHECKS = 24;

function rainVerdict(s) {
    if (!s.checked || s.checked < MIN_RAIN_CHECKS) {
        return { tone: null, label: 'Collecting data', text: `${s.checked || 0} of ${MIN_RAIN_CHECKS} airport checks so far. A verdict appears once there are enough; keep the scheduler running.` };
    }
    if (s.brier_provider !== null && s.brier_model !== null && s.brier_model < s.brier_provider) {
        return { tone: 'ok', label: 'Working well', text: `Closer to what really happened than Open-Meteo's own rain chance, on ${s.checked} airport checks.` };
    }
    return { tone: 'attention', label: 'Needs a look', text: `Not closer to reality than Open-Meteo on ${s.checked} airport checks. Retrain it in the ml tool, or set WEATHER_USE_MODEL=false.` };
}

function heatVerdict(plus1) {
    if (!plus1.checked || plus1.checked < MIN_HEAT_CHECKS) {
        return { tone: null, label: 'Collecting data', text: `${plus1.checked || 0} of ${MIN_HEAT_CHECKS} airport readings so far. A verdict appears once there are enough; keep the scheduler running.` };
    }
    if (plus1.mae_provider === null || plus1.mae_model <= plus1.mae_provider) {
        return { tone: 'ok', label: 'Working well', text: `Missed the airport's heat index by ${num(plus1.mae_model, 1)} °C on average one hour ahead${plus1.mae_provider === null ? '' : ` (Open-Meteo: ${num(plus1.mae_provider, 1)} °C)`}.` };
    }
    return { tone: 'attention', label: 'Needs a look', text: `Missed by ${num(plus1.mae_model, 1)} °C on average, more than Open-Meteo's ${num(plus1.mae_provider, 1)} °C. Retrain it in the ml tool, or set WEATHER_USE_HEAT_MODEL=false.` };
}

/** Card heading: title + verdict badge; the verdict's reason is on hover. */
function CardHead({ id, title, question, verdict }) {
    return (
        <div className="wx-card-head">
            <Tip text={question} block><h2 className="ui-card-title" id={id}>{title}<Info /></h2></Tip>
            <Tip text={verdict.text}><span className={`ui-badge${verdict.tone ? ` ui-badge-${verdict.tone}` : ''}`}>{verdict.label}</span></Tip>
        </div>
    );
}

/** The latest refresh: the rain and heat numbers, each with its routing mode. */
function NowStrip({ latest }) {
    if (!latest) return null;
    const category = latest.heat_index_c === null ? null : heatLabel(heatCategory(latest.heat_index_c));
    return (
        <div className="wx-now" aria-label="Weather right now">
            <Tile label="Rain chance" value={pct(latest.rain_probability)}
                tip={`Chance of rain on campus in the next 20 minutes, ${latest.probability_source === 'model' ? 'from the campus rain model' : "from Open-Meteo's forecast (the model could not run)"}.`} />
            <Tile label="Rain mode" value={latest.rain_mode ? 'On' : 'Off'} sub={latest.rain_mode && latest.raining_now ? 'Raining now' : null}
                tip="When on, routes prefer covered paths. It turns on when rain is likely soon or it is already raining." />
            <Tile label="Heat index" value={deg(latest.heat_index_c)} sub={category}
                tip="How hot it feels (temperature and humidity together), with its PAGASA warning level." />
            <Tile label="Heat mode" value={latest.heat_mode ? 'On' : 'Off'} sub={latest.heat_mode ? 'Outdoor paths closed' : null}
                tip={`When on, outdoor (exposed) paths are closed to routing, the same as when it is raining. It turns on when the heat index is above ${latest.heat_mode_c ?? 40} °C now; a hotter prediction only takes effect once its hour arrives.`} />
        </div>
    );
}

function RainCard({ rain }) {
    const s = rain.stats;
    const points = useMemo(() => rain.series.map((p) => ({
        t: Date.parse(p.t),
        values: { model: p.model, provider: p.provider },
        outcome: p.outcome,
        note: p.outcome === null || p.outcome === undefined ? 'Airport: not checked yet' : p.outcome ? 'Airport: rained 20 min later' : 'Airport: dry 20 min later',
    })), [rain.series]);
    const closer = s.brier_model !== null && s.brier_provider !== null && s.brier_provider > 0 ? Math.round((1 - s.brier_model / s.brier_provider) * 100) : null;

    return (
        <section className="ui-card" aria-labelledby="wx-rain">
            <CardHead id="wx-rain" title="Rain" question="Will it rain on campus in the next 20 minutes? Each prediction is later checked against the Zamboanga airport report." verdict={rainVerdict(s)} />
            <div className="wx-tiles">
                <Tile label="Predictions" value={s.predictions} tip="Predictions in this period: one every 10 minutes, plus each 'Update now'." />
                <Tile label="Rain caught" value={s.rain_reports ? `${s.caught} of ${s.rain_reports}` : '-'}
                    tip="Times the airport reported rain while rain mode was already on. Shows '-' until the airport has reported rain." />
                {/* Worse is shown as a multiple: "541% further" read like a broken percentage. */}
                <Tile label="vs Open-Meteo" value={closer === null ? '-' : closer >= 0 ? `${closer}% closer` : `${(s.brier_model / s.brier_provider).toFixed(1)}× more error`}
                    tip="How much closer the model's rain chances were to what really happened, compared with Open-Meteo's own (Brier score). When the model did worse, it shows how many times Open-Meteo's error it made. Shows '-' until there are airport checks." />
            </div>
            {points.length === 0 ? <Empty /> : (
                <>
                    <ChartLegend
                        items={[
                            { label: 'Campus model', color: COLOR.model },
                            { label: 'Open-Meteo', color: COLOR.provider },
                            { label: 'Airport: rained', color: COLOR.airport, kind: 'bar' },
                            { label: 'Airport: dry', color: COLOR.dry, kind: 'bar' },
                        ]}
                        tip="Rain chance over time. The marks under the chart are what the airport reported 20 minutes later. Long straight stretches cross times with no data. Hover the chart for exact values."
                    />
                    <TimeChart
                        points={points}
                        lines={[{ key: 'model', label: 'Campus model', color: COLOR.model }, { key: 'provider', label: 'Open-Meteo', color: COLOR.provider }]}
                        rug={(p) => (p.outcome === null || p.outcome === undefined ? null : p.outcome ? 'rain' : 'dry')}
                        yDomain={[0, 100]} yFormat={(v) => `${Math.round(v)}%`}
                        label="Rain chance over time from the campus model and Open-Meteo, with what the airport reported"
                    />
                </>
            )}
        </section>
    );
}

function HeatCard({ heat }) {
    const s = heat.stats;
    const plus1 = s.horizons[0];
    const points = useMemo(() => heat.series.map((p) => ({
        t: Date.parse(p.t), values: { model: p.model, provider: p.provider, observed: p.observed },
    })), [heat.series]);
    const values = points.flatMap((p) => [p.values.model, p.values.provider, p.values.observed]).filter((v) => v !== null && v !== undefined);
    const yDomain = values.length ? [Math.floor(Math.min(...values) - 0.5), Math.ceil(Math.max(...values) + 0.5)] : [24, 36];
    const lean = plus1.bias_model === null ? null : Math.abs(plus1.bias_model) < 0.3 ? 'About right' : plus1.bias_model > 0 ? `${num(plus1.bias_model, 1)} °C warm` : `${num(-plus1.bias_model, 1)} °C cool`;

    return (
        <section className="ui-card" aria-labelledby="wx-heat">
            <CardHead id="wx-heat" title="Heat" question="How hot will it feel in 1, 2 and 3 hours? Each prediction is later checked against the airport's temperature and dew point." verdict={heatVerdict(plus1)} />
            <div className="wx-tiles">
                <Tile label="Predictions" value={s.predictions} tip="Predictions in this period: a 3-hour heat outlook every 10 minutes." />
                <Tile label="Average miss" value={plus1.mae_model === null ? '-' : `${num(plus1.mae_model, 1)} °C`}
                    tip={`How far the 1-hour-ahead heat index was from the airport's, on average. Lower is better.${plus1.mae_provider === null ? '' : ` Open-Meteo: ${num(plus1.mae_provider, 1)} °C.`}`} />
                <Tile label="Tends to run" value={lean ?? '-'} tip="Whether the model usually predicts too warm or too cool, compared with the airport." />
            </div>
            {points.length === 0 ? <Empty /> : (
                <>
                    <ChartLegend
                        items={[
                            { label: 'Campus model', color: COLOR.model },
                            { label: 'Open-Meteo', color: COLOR.provider },
                            { label: 'Airport measured', color: COLOR.airport, kind: 'dot' },
                        ]}
                        tip="Heat index 1 hour ahead, drawn at the hour each prediction was for. Dots are what the airport measured then. Long straight stretches cross times with no data."
                    />
                    <TimeChart
                        points={points}
                        lines={[{ key: 'model', label: 'Campus model', color: COLOR.model }, { key: 'provider', label: 'Open-Meteo', color: COLOR.provider }]}
                        dots={[{ key: 'observed', label: 'Airport measured', color: COLOR.airport }]}
                        yDomain={yDomain} yFormat={(v, tip) => (tip ? `${Number(v).toFixed(1)} °C` : `${v}°`)}
                        label="Heat index one hour ahead from the campus model and Open-Meteo, with the airport measurement"
                    />
                </>
            )}
        </section>
    );
}

/** Legend row with its ⓘ: the chart's explanation is on hover. */
function ChartLegend({ items, tip }) {
    return (
        <div className="wx-legend-row">
            <Legend items={items} />
            <Tip text={tip}><Info /></Tip>
        </div>
    );
}

function Empty() {
    return <div className="wx-empty">No predictions in this period yet.</div>;
}

/** Everything technical, folded away: histograms, the numbers per horizon and the latest rows. */
function Details({ data }) {
    const { rain, heat, recent } = data;
    const s = rain.stats;
    const errorLabel = (v) => (v > 0 ? `+${v}` : `${v}`).replace('-', '−');
    return (
        <details className="ui-card wx-more">
            <summary>Details</summary>
            <div className="wx-more-body">
                <div>
                    <p className="wx-chart-title">Rain chances given</p>
                    <Legend items={[
                        { label: 'Rained', color: COLOR.airport, kind: 'bar' },
                        { label: 'Stayed dry', color: COLOR.dry, kind: 'bar' },
                        { label: 'Not checked', color: COLOR.unchecked, kind: 'bar' },
                    ]} />
                    <Histogram
                        bins={rain.histogram}
                        series={[{ key: 'rained', label: 'rained', color: COLOR.airport }, { key: 'dry', label: 'stayed dry', color: COLOR.dry }, { key: 'unchecked', label: 'not checked', color: COLOR.unchecked }]}
                        edgeLabel={(v) => `${v}%`} labelEvery={2} unitNote="chance"
                        label="Histogram of the model's rain chance, split by airport outcome"
                    />
                    <ul className="wx-glossary">
                        <li>Airport checks: {s.checked} of {s.predictions} (the airport reports about hourly).</li>
                        <li>Brier score (0 = perfect): model {num(s.brier_model)}, Open-Meteo {num(s.brier_provider)}.</li>
                        <li>Rain mode turns on at {s.alert_threshold ? `${Math.round(s.alert_threshold * 100)}%` : '-'}, or when it is already raining.</li>
                    </ul>
                </div>
                <div>
                    <p className="wx-chart-title">Heat error, 1 hour ahead (°C)</p>
                    <Legend items={[{ label: 'Campus model', color: COLOR.model, kind: 'bar' }, { label: 'Open-Meteo', color: COLOR.provider, kind: 'bar' }]} />
                    <Histogram
                        bins={heat.histogram} mode="group"
                        series={[{ key: 'model', label: 'campus model', color: COLOR.model }, { key: 'provider', label: 'Open-Meteo', color: COLOR.provider }]}
                        edgeLabel={errorLabel} labelEvery={2} unitNote="°C"
                        label="Histogram of the one-hour heat index error for the campus model and Open-Meteo"
                    />
                    <ul className="wx-glossary">
                        {heat.stats.horizons.map((hz) => (
                            <li key={hz.hours_ahead}>
                                +{hz.hours_ahead} h: {hz.checked} checked, average miss {hz.mae_model === null ? '-' : `${num(hz.mae_model, 2)} °C`}
                                {hz.mae_provider === null ? '' : ` (Open-Meteo ${num(hz.mae_provider, 2)} °C)`}
                            </li>
                        ))}
                    </ul>
                </div>
            </div>
            {recent.length > 0 && (
                <div className="wx-table-wrap" style={{ marginTop: 18 }}>
                    <table className="wx-table">
                        <thead>
                            <tr>
                                <th>Time</th><th>Rain chance</th><th>Open-Meteo</th><th>Rain mode</th><th>Airport 20 min later</th>
                                <th>Heat index</th><th>Model +1 h</th><th>Open-Meteo +1 h</th><th>Airport +1 h</th>
                            </tr>
                        </thead>
                        <tbody>
                            {recent.map((r) => (
                                <tr key={r.time}>
                                    <td>{fmt.full.format(Date.parse(r.time))}</td>
                                    <td>{pct(r.rain_probability)}{r.probability_source && r.probability_source !== 'model' ? ' (forecast)' : ''}</td>
                                    <td>{pct(r.provider_probability)}</td>
                                    <td>{r.rain_mode ? (r.raining_now ? 'On (raining)' : 'On') : 'Off'}</td>
                                    <td>{r.rain_outcome === null ? '-' : r.rain_outcome ? 'Rain' : 'Dry'}</td>
                                    <td>{deg(r.heat_index_c)}</td>
                                    <td>{deg(r.heat_plus1)}</td>
                                    <td>{deg(r.heat_plus1_provider)}</td>
                                    <td>{deg(r.heat_plus1_observed)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </details>
    );
}

export default function AdminWeather({ fail }) {
    const [days, setDays] = useState(7);
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [reload, setReload] = useState(0);
    const [updating, setUpdating] = useState(false);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        api.getWeatherHistory(days)
            .then((d) => { if (!cancelled) setData(d); })
            .catch((err) => { if (!cancelled) fail?.(err.message || 'Could not load the weather history.'); })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [days, fail, reload]);

    // "Update now": the same refresh the 20-minute schedule runs, then reload this page's numbers.
    const updateNow = async () => {
        if (updating) return;
        setUpdating(true);
        try {
            await api.refreshWeather();
            setReload((n) => n + 1);
        } catch (err) {
            fail?.(/too many attempts/i.test(err.message || '')
                ? 'You can update up to 3 times a minute. Wait a moment and try again.'
                : err.message || 'The weather could not be updated.');
        } finally {
            setUpdating(false);
        }
    };

    const latest = data?.recent?.[0];

    return (
        <div className="wx-page">
            <style>{CSS}</style>
            <div className="wx-inner">
                <header className="rise" style={{ '--i': 0 }}>
                    <Tip text="The weather the app is using now, and how well its rain and heat predictions matched what the Zamboanga airport reported." block>
                        <h1 className="ui-h1">Weather Dashboard<Info /></h1>
                    </Tip>
                </header>
                {latest && <NowStrip latest={latest} />}
                <div className="wx-filters">
                    <div className="wx-seg" role="group" aria-label="Period">
                        {PERIODS.map((p) => (
                            <button key={p.days} type="button" aria-pressed={days === p.days} onClick={() => setDays(p.days)}>{p.label}</button>
                        ))}
                    </div>
                    <div className="wx-update">
                        <span className="wx-updated" role="status" aria-live="polite">
                            {updating ? 'Updating…' : latest ? `Updated ${fmt.clock.format(Date.parse(latest.time))}` : ''}
                        </span>
                        <Tip text="Get the latest forecast and airport report now. It also updates automatically every 10 minutes." focusable={false}>
                            <button type="button" className="ui-btn ui-btn-secondary" onClick={updateNow} disabled={updating} aria-busy={updating}>
                                {updating ? 'Updating…' : 'Update now'}
                            </button>
                        </Tip>
                    </div>
                </div>
                {!data ? (
                    <div className="ui-card"><div className="wx-empty">{loading ? 'Loading…' : 'The weather history could not be loaded.'}</div></div>
                ) : (
                    <div className={loading ? 'wx-loading' : undefined} style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
                        <RainCard rain={data.rain} />
                        <HeatCard heat={data.heat} />
                        <Details data={data} />
                    </div>
                )}
            </div>
        </div>
    );
}
