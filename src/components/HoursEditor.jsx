import React, { useMemo } from 'react';
import { C, TYPE, PILL } from '../uiTokens';
import { DAYS, summarizeHours, weeklyHours } from '../openingHours';

const DAY_LABELS = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
const PRESETS = [
    { label: 'Mon–Sat 8–5', days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'] },
    { label: 'Mon–Fri 8–5', days: ['mon', 'tue', 'wed', 'thu', 'fri'] },
];

const HOURS_CSS = `
    .hours { display: flex; flex-direction: column; gap: 10px; }
    .hours-days { display: flex; flex-wrap: wrap; gap: 6px; }
    .hours-day {
        min-width: 44px; min-height: 36px; padding: 0 10px; border-radius: ${PILL}px; border: 1px solid ${C.border};
        background: transparent; color: ${C.muted}; font: inherit; font-size: ${TYPE.desc}; font-weight: 700; cursor: pointer;
        transition: background-color 160ms ease, color 160ms ease, border-color 160ms ease;
    }
    .hours-day[aria-pressed="true"] { background: rgba(255,255,255,0.12); border-color: rgba(255,255,255,0.35); color: ${C.white}; }
    .hours-day:focus-visible { outline: 2px solid ${C.focus}; outline-offset: 2px; }
    .hours-times { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .hours-presets { display: flex; flex-wrap: wrap; gap: 6px; }
    .hours-summary { margin: 0; font-size: ${TYPE.desc}; color: ${C.text}; font-weight: 600; }
`;

/**
 * The simple weekly form behind stored hours: open days, one opening and closing time, and an
 * optional lunch break. `uniform` is false when the stored hours differ between days (saving the
 * form then replaces them).
 */
function readForm(hours) {
    const open = DAYS.filter((d) => Array.isArray(hours?.[d]) && hours[d].length);
    const first = open.length ? hours[open[0]] : null;
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const uniform = open.every((d) => same(hours[d], first)) && (!first || first.length <= 2);
    return {
        days: open.length ? open : ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'],
        opens: first?.[0]?.[0] || '08:00',
        closes: first?.[first.length - 1]?.[1] || '17:00',
        lunch: first?.length === 2 ? [first[0][1], first[1][0]] : null,
        uniform,
    };
}

/**
 * Weekly opening hours of a building or a place. `value` null: no set hours (always open).
 * Sends hours in the stored shape (openingHours.js) through `onChange`.
 */
export default function HoursEditor({
    value, onChange, idPrefix = 'hours', disabled = false,
    offHint = 'Off: always open. On: students see when it is open, and routes do not pass through it while it is closed.',
}) {
    const form = useMemo(() => readForm(value), [value]);
    const enabled = value != null;
    const emit = (next) => onChange(weeklyHours(next.days, next.opens, next.closes, next.lunch));
    const set = (patch) => emit({ ...form, ...patch });
    const toggleDay = (d) => set({ days: form.days.includes(d) ? form.days.filter((x) => x !== d) : DAYS.filter((x) => x === d || form.days.includes(x)) });

    return (
        <div className="hours">
            <style>{HOURS_CSS}</style>
            <label className="mt-check">
                <input
                    type="checkbox" checked={enabled} disabled={disabled}
                    onChange={(e) => (e.target.checked ? emit(form) : onChange(null))}
                />
                <span>
                    Has opening hours
                    <small>{offHint}</small>
                </span>
            </label>
            {enabled && (
                <>
                    {!form.uniform && (
                        <p className="ui-hint" style={{ margin: 0, color: C.warning }}>
                            These hours differ from day to day. Changing them here sets the same hours on every open day.
                        </p>
                    )}
                    <div className="hours-presets" role="group" aria-label="Quick hours">
                        {PRESETS.map((p) => (
                            <button
                                key={p.label} type="button" className="ui-btn ui-btn-secondary" disabled={disabled}
                                onClick={() => emit({ days: p.days, opens: '08:00', closes: '17:00', lunch: null })}
                            >
                                {p.label}
                            </button>
                        ))}
                    </div>
                    <div className="hours-days" role="group" aria-label="Open on">
                        {DAYS.map((d) => (
                            <button
                                key={d} type="button" className="hours-day" aria-pressed={form.days.includes(d)} disabled={disabled}
                                onClick={() => toggleDay(d)}
                            >
                                {DAY_LABELS[d]}
                            </button>
                        ))}
                    </div>
                    <div className="hours-times">
                        <div className="ui-field">
                            <label className="ui-label" htmlFor={`${idPrefix}-opens`}>Opens</label>
                            <input id={`${idPrefix}-opens`} className="ui-input" type="time" value={form.opens} disabled={disabled}
                                onChange={(e) => e.target.value && set({ opens: e.target.value })} />
                        </div>
                        <div className="ui-field">
                            <label className="ui-label" htmlFor={`${idPrefix}-closes`}>Closes</label>
                            <input id={`${idPrefix}-closes`} className="ui-input" type="time" value={form.closes} disabled={disabled}
                                onChange={(e) => e.target.value && set({ closes: e.target.value })} />
                        </div>
                    </div>
                    <label className="mt-check">
                        <input
                            type="checkbox" checked={Boolean(form.lunch)} disabled={disabled}
                            onChange={(e) => set({ lunch: e.target.checked ? ['12:00', '13:00'] : null })}
                        />
                        <span>Closed for lunch</span>
                    </label>
                    {form.lunch && (
                        <div className="hours-times">
                            <div className="ui-field">
                                <label className="ui-label" htmlFor={`${idPrefix}-lunch-from`}>Lunch from</label>
                                <input id={`${idPrefix}-lunch-from`} className="ui-input" type="time" value={form.lunch[0]} disabled={disabled}
                                    onChange={(e) => e.target.value && set({ lunch: [e.target.value, form.lunch[1]] })} />
                            </div>
                            <div className="ui-field">
                                <label className="ui-label" htmlFor={`${idPrefix}-lunch-to`}>Back at</label>
                                <input id={`${idPrefix}-lunch-to`} className="ui-input" type="time" value={form.lunch[1]} disabled={disabled}
                                    onChange={(e) => e.target.value && set({ lunch: [form.lunch[0], e.target.value] })} />
                            </div>
                        </div>
                    )}
                    <p className="hours-summary" role="status">{summarizeHours(value)}</p>
                </>
            )}
        </div>
    );
}

/** Client-side check before saving (the server checks again): each range closes after it opens. */
export function hoursProblem(hours) {
    if (!hours) return null;
    for (const d of DAYS) {
        const ranges = hours[d] || [];
        for (let i = 0; i < ranges.length; i += 1) {
            if (ranges[i][1] <= ranges[i][0]) return 'Closing time must be after opening time.';
            if (i > 0 && ranges[i][0] < ranges[i - 1][1]) return 'Lunch must fall between opening and closing time.';
        }
    }
    return null;
}
