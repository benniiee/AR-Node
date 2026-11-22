// ── Opening hours of buildings and places ────────────────────────────
// Stored as App\Services\OpeningHours shapes them: every day with its open ranges in campus time,
// { mon: [['08:00', '12:00'], ['13:00', '17:00']], ..., sun: [] }. An empty day is closed all day;
// no hours at all (null) means no set hours: always open. A place without its own hours follows its
// building's. Plain JS, no imports (unit-tested in src/openingHours.test.mjs).

export const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DAY_NAMES = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };

/** Campus time is UTC+8 all year (the Philippines has no daylight saving), whatever the phone's zone. */
const CAMPUS_OFFSET_MIN = 8 * 60;

/** The campus weekday ('mon'...) and minutes since campus midnight at `date`. */
export function campusClock(date = new Date()) {
    const t = new Date(date.getTime() + CAMPUS_OFFSET_MIN * 60000);
    return { day: DAYS[(t.getUTCDay() + 6) % 7], minutes: t.getUTCHours() * 60 + t.getUTCMinutes() };
}

const toMinutes = (hhmm) => {
    const [h, m] = String(hhmm).split(':').map(Number);
    return h * 60 + m;
};

/** '17:00' -> '5 pm', '08:30' -> '8:30 am', '12:00' -> '12 pm', '24:00' -> 'midnight'. */
export function formatTime(hhmm) {
    const total = toMinutes(hhmm);
    if (total >= 24 * 60 || total === 0) return 'midnight';
    const h = Math.floor(total / 60);
    const m = total % 60;
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}${m ? `:${String(m).padStart(2, '0')}` : ''} ${h < 12 ? 'am' : 'pm'}`;
}

/** Usable hours or null: at least one day key with a list of ranges. */
function valid(hours) {
    return hours && typeof hours === 'object' && DAYS.some((d) => Array.isArray(hours[d])) ? hours : null;
}

/** The hours that apply to a place: its own, else its building's, else null (no set hours). */
export function hoursOf(place, buildingsById) {
    const own = valid(place?.opening_hours);
    if (own) return own;
    const building = place?.building_id != null ? buildingsById?.get?.(place.building_id) : null;
    return valid(building?.opening_hours);
}

/**
 * Open or closed at `date`, with the words to show. Null when there are no set hours.
 * @returns {{ open: boolean, label: string, short: string } | null}
 *   label: "Open · closes 5 pm", "Closed · opens 1 pm", "Closed · opens Mon 8 am", "Closed"
 *   short: "Open" / "Closed" (badge)
 */
export function openState(hours, date = new Date()) {
    const h = valid(hours);
    if (!h) return null;
    const { day, minutes } = campusClock(date);
    const today = DAYS.indexOf(day);
    const ranges = (d) => (Array.isArray(h[d]) ? h[d] : []).map(([o, c]) => [toMinutes(o), toMinutes(c), o, c]);

    const now = ranges(day).find(([o, c]) => minutes >= o && minutes < c);
    if (now) return { open: true, short: 'Open', label: `Open · closes ${formatTime(now[3])}` };

    // The next opening: later today, then the following days (a week round).
    const later = ranges(day).find(([o]) => o > minutes);
    if (later) return { open: false, short: 'Closed', label: `Closed · opens ${formatTime(later[2])}` };
    for (let k = 1; k <= 7; k += 1) {
        const d = DAYS[(today + k) % 7];
        const [first] = ranges(d);
        if (first) {
            const when = k === 1 ? 'tomorrow' : DAY_NAMES[d];
            return { open: false, short: 'Closed', label: `Closed · opens ${when} ${formatTime(first[2])}` };
        }
    }
    return { open: false, short: 'Closed', label: 'Closed' };
}

/**
 * The week in a line: consecutive days with the same hours grouped, closed days left out.
 * "Mon–Sat 8 am–5 pm", "Mon–Fri 8 am–12 pm, 1 pm–5 pm · Sat 8 am–12 pm", "Closed every day".
 */
export function summarizeHours(hours) {
    const h = valid(hours);
    if (!h) return null;
    const text = (d) => (Array.isArray(h[d]) ? h[d] : []).map(([o, c]) => `${formatTime(o)}–${formatTime(c)}`).join(', ');
    const groups = [];
    for (const d of DAYS) {
        const t = text(d);
        const last = groups[groups.length - 1];
        if (t && last && last.text === t && DAYS.indexOf(last.to) === DAYS.indexOf(d) - 1) last.to = d;
        else if (t) groups.push({ from: d, to: d, text: t });
    }
    if (!groups.length) return 'Closed every day';
    return groups.map((g) => `${DAY_NAMES[g.from]}${g.to !== g.from ? `–${DAY_NAMES[g.to]}` : ''} ${g.text}`).join(' · ');
}

/**
 * Ids of the buildings closed at `date` (they have hours and none is open now). Routes do not pass
 * through them; the destination's own building and the one you stand in stay open to routing.
 */
export function closedBuildingIds(buildings, date = new Date()) {
    return (buildings || []).filter((b) => openState(b?.opening_hours, date)?.open === false).map((b) => b.id);
}

/** Hours from a simple weekly form: the same range (or two, around a break) on each chosen day. */
export function weeklyHours(days, open, close, lunch = null) {
    const ranges = lunch ? [[open, lunch[0]], [lunch[1], close]] : [[open, close]];
    return Object.fromEntries(DAYS.map((d) => [d, days.includes(d) ? ranges.map((r) => [...r]) : []]));
}
