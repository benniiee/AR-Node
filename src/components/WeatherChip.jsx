import React from 'react';
import { C, TAP, TYPE } from '../uiTokens';
import { heatSummary } from '../heatIndex';
import { heatModeActive } from '../weatherCost';

/**
 * One-line weather readout for the 2D screen, next to the distance/time
 * chips. It only ever DESCRIBES what routing is already doing — it is not a
 * weather app, and it never blocks or gates anything.
 *
 * Stale or unavailable: no forecast is shown (a confident "Dry" off two-hour-old
 * data would mislead), only a neutral line saying routing ignores the weather,
 * which is exactly what it does then.
 *
 * Next line, when the 60-minute rain model ran and it is not raining yet: the chance
 * of rain at any time within the next hour, amber from that model's alert level.
 *
 * Last line: the heat index ("Feels like 38°C, Extreme caution") and the
 * 1-3 hour outlook from the heat model, amber from Extreme caution up.
 *
 * The Open-Meteo credit is a licence requirement of the free tier, so it
 * rides along in the tooltip of every variant.
 */
/** WHO UV index words (WeatherService::uvCategory). */
const UV_WORDS = { low: 'low', moderate: 'moderate', high: 'high', very_high: 'very high', extreme: 'extreme' };

export default function WeatherChip({ weather, inline = false, shadeActive = false, compact = false, detailsOnly = false }) {
    if (!weather) return null;
    if (weather.status === 'unavailable' || weather.status === 'stale') {
        return (
            <div role={inline ? undefined : 'status'} title={weather.attribution || undefined}
                style={{ padding: inline ? '4px 0 0' : '0 4px', color: C.muted, fontSize: TYPE.desc, fontWeight: 500 }}>
                Weather not available: normal routing
            </div>
        );
    }

    const raining = Boolean(weather.raining_now);
    const rainMode = Boolean(weather.rain_mode);
    // Heat mode closes outdoor paths too: too hot now, or a predicted hot hour has begun (same rule as routing).
    const heatMode = heatModeActive(weather) && !raining;
    const heatNow = Number(weather.heat_index_c);
    const probability = Number.isFinite(Number(weather.rain_probability))
        ? Math.round(Number(weather.rain_probability))
        : null;

    // The words carry the state; colour sits only on a small icon that means
    // something (no status dots). Dry and normal: no icon.
    const kind = raining ? 'rain' : heatMode ? 'heat' : rainMode ? 'cloud' : shadeActive ? 'sun' : null;
    const iconColor = raining || heatMode ? C.error : C.warning;

    const reported = weather.raining_now_source === 'reports';
    const uv = Number(weather.uv_index);
    const uvShown = weather.uv_index != null && Number.isFinite(uv) && uv >= 3;
    const uvLine = uvShown ? `UV ${Math.round(uv)}, ${UV_WORDS[weather.uv_category] || 'high'}${uv >= 6 ? ': use shade' : ''}` : null;

    // "Raining now" is what was seen, not a chance: no percentage on it.
    const label = raining
        ? `Raining now${reported ? ' (reported on campus)' : ''}: outdoor paths closed`
        : heatMode
            ? `Extreme heat: outdoor paths closed${Number.isFinite(heatNow) ? ` (feels like ${Math.round(heatNow)}°C)` : ''}`
        : rainMode
            ? `Rain possible: routes lean toward covered paths${probability !== null ? ` (${probability}%)` : ''}`
            : shadeActive
                ? `${Number(weather.heat_index_c) > 27 ? 'Hot' : 'Strong sun'}: routes prefer shaded paths`
                : 'Dry: normal routing';

    // Offline: the last good state is still being used, so say how old it is.
    const cached = weather.status === 'cached' && Number.isFinite(Number(weather.age_minutes));
    const horizon = Number(weather.probability_horizon_minutes);
    const sourceNote = weather.probability_source === 'model' && probability !== null
        ? `Campus AI model: ${probability}% chance of rain${Number.isFinite(horizon) && horizon > 0 ? ` in the next ${horizon} min` : ''}`
        : weather.probability_source === 'forecast' ? 'Open-Meteo forecast probability' : null;

    // Where "raining now" (or dry) comes from: the airport's latest report when it is
    // fresh, otherwise the forecast model's current weather.
    const reportAt = weather.airport_report_at ? new Date(weather.airport_report_at) : null;
    const rainSource = reported
        ? `Rain now: reported by ${Number(weather.rain_reports) || 'several'} people on campus in the last few minutes`
        : weather.raining_now_source === 'airport' && reportAt && !Number.isNaN(reportAt.getTime())
            ? `Rain now: airport report at ${reportAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
            : weather.raining_now_source === 'forecast' ? 'Rain now: forecast model (no fresh airport report)' : null;

    const hourChance = Number(weather.rain_probability_hour);
    const hourLine = !raining && weather.rain_probability_hour != null && Number.isFinite(hourChance)
        ? `Next hour: ${Math.round(hourChance)}% chance of rain`
        : null;
    const hourWarn = hourLine !== null && hourChance >= Number(weather.rain_hour_alert ?? 101);

    const heat = heatSummary(weather);
    const heatParts = [heat?.short, heat?.outlook, uvLine].filter(Boolean);
    const heatLine = heatParts.length ? heatParts.join(' · ') : null;
    const heatWarn = Boolean(heat?.warning) || (uvShown && uv >= 6);

    const title = [
        label,
        hourLine ? `${hourLine} (campus AI model, rain at any time in the next 60 min)` : null,
        heatLine,
        rainSource,
        sourceNote,
        cached ? `Offline: last update ${weather.age_minutes} min ago` : null,
        weather.condition && weather.condition !== 'unknown' ? `Condition: ${weather.condition}` : null,
        Number.isFinite(Number(weather.temperature_c)) ? `${Number(weather.temperature_c)}°C` : null,
        weather.attribution || null,
    ].filter(Boolean).join(' · ');

    // Compact (inside the map's weather pill button): a span, since a button holds only phrasing content.
    const Root = compact ? 'span' : 'div';
    return (
        <Root
            role={inline && !compact ? undefined : 'status'}
            aria-live={inline && !compact ? undefined : 'polite'}
            title={compact ? undefined : title}
            style={{
                display: 'flex', alignItems: 'center', gap: 8, flex: compact ? '1 1 auto' : undefined,
                minHeight: inline ? 0 : TAP.minHeight, padding: compact ? 0 : inline ? '4px 0 0' : '0 4px',
                color: C.text, fontSize: 13, fontWeight: 600,
                whiteSpace: inline && !compact ? 'normal' : 'nowrap', maxWidth: '100%', minWidth: 0,
            }}
        >
            {kind && !detailsOnly && (
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ flex: 'none', color: iconColor, alignSelf: compact ? 'center' : 'flex-start', marginTop: compact ? 0 : 1 }}>
                    {(kind === 'rain' || kind === 'cloud') && <path d="M4.5 10.5a3 3 0 0 1 .4-6 4 4 0 0 1 7.6 1.2A2.5 2.5 0 0 1 12 10.5H4.5z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />}
                    {kind === 'rain' && <path d="M5.5 12.5l-.8 1.8M8.5 12.5l-.8 1.8M11.5 12.5l-.8 1.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />}
                    {kind === 'heat' && <path d="M8 2.5v6.6a2.6 2.6 0 1 1-2 0V3.5a1 1 0 0 1 2 0M10.5 4.5h2M10.5 7h2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />}
                    {kind === 'sun' && <><circle cx="8" cy="8" r="2.8" stroke="currentColor" strokeWidth="1.4" /><path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></>}
                </svg>
            )}
            <span style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
                {/* detailsOnly: the map pill's panel; the pill itself already shows this line. */}
                {!detailsOnly && (
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {label}{cached ? ` · ${weather.age_minutes} min ago` : ''}
                    </span>
                )}
                {!compact && hourLine && (
                    <span
                        style={{
                            overflow: 'hidden', textOverflow: 'ellipsis',
                            fontSize: TYPE.desc, fontWeight: 500,
                            color: hourWarn ? C.warning : C.muted,
                        }}
                    >
                        {hourLine}
                    </span>
                )}
                {!compact && heatLine && (
                    <span
                        style={{
                            overflow: 'hidden', textOverflow: 'ellipsis',
                            fontSize: TYPE.desc, fontWeight: 500,
                            color: heatWarn ? C.warning : C.muted,
                        }}
                    >
                        {heatLine}
                    </span>
                )}
            </span>
        </Root>
    );
}
