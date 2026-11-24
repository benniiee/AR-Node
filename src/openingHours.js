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
 * @returns {{ open: boolean, label: string, short: string, opens?: string } | null}
 *   label: "Open · closes 5 pm", "Closed · opens 1 pm", "Closed · opens Mon 8 am", "Closed"
 *   short: "Open" / "Closed" (badge); opens: when it opens next ("1 pm", "Mon 8 am"), when closed
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
    if (later) return { open: false, short: 'Closed', opens: formatTime(later[2]), label: `Closed · opens ${formatTime(later[2])}` };
    for (let k = 1; k <= 7; k += 1) {
        const d = DAYS[(today + k) % 7];
        const [first] = ranges(d);
        if (first) {
            const when = `${k === 1 ? 'tomorrow' : DAY_NAMES[d]} ${formatTime(first[2])}`;
            return { open: false, short: 'Closed', opens: when, label: `Closed · opens ${when}` };
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
export function closedBuildingIds(buildings, date = new Date(), closures = []) {
    return (buildings || []).filter((b) => buildingStatus(b, closures, date)?.open === false).map((b) => b.id);
}

/** Hours from a simple weekly form: the same range (or two, around a break) on each chosen day. */
export function weeklyHours(days, open, close, lunch = null) {
    const ranges = lunch ? [[open, lunch[0]], [lunch[1], close]] : [[open, close]];
    return Object.fromEntries(DAYS.map((d) => [d, days.includes(d) ? ranges.map((r) => [...r]) : []]));
}

// ── Closures and special openings (announcements) ────────────────────
// A closure (or special opening) covers what its filled fields match, all of them: node_id, else
// building_id (the building and every room in it), department_id, building_category (every school
// building, i.e. classes, or every office building), campus. None filled: the whole school. Precedence: a closure beats a special opening,
// which beats the weekly hours.

const DAY_MS = 86400000;
const campusDayNumber = (date) => Math.floor((date.getTime() + CAMPUS_OFFSET_MIN * 60000) / DAY_MS);

/** "3 pm" today, "tomorrow 8 am", "Fri 8 am" this week, else "Dec 3". */
export function formatWhen(when, date = new Date()) {
    const at = new Date(when);
    const { day, minutes } = campusClock(at);
    const hhmm = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
    const days = campusDayNumber(at) - campusDayNumber(date);
    if (days <= 0) return formatTime(hhmm);
    if (days === 1) return `tomorrow ${formatTime(hhmm)}`;
    if (days < 7) return `${DAY_NAMES[day]} ${formatTime(hhmm)}`;
    const local = new Date(at.getTime() + CAMPUS_OFFSET_MIN * 60000);
    return `${local.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })} ${local.getUTCDate()}`;
}

/** What closures can match for a building. */
export function buildingTarget(b) {
    const dept = b?.department;
    return {
        nodeId: null, buildingId: b?.id ?? null, campus: b?.campus ?? null,
        departmentIds: [dept?.id ?? b?.department_id].filter((v) => v != null),
        // School or office building (the server keeps it in step with the owning department).
        category: b ? (b.category || 'school') : null,
    };
}

/** What closures can match for a place: itself, its building, its own and its building's department. */
export function placeTarget(n, buildingsById) {
    const b = n?.building_id != null ? buildingsById?.get?.(n.building_id) : null;
    const bt = buildingTarget(b);
    return {
        nodeId: n?.id ?? null, buildingId: n?.building_id ?? null, campus: n?.campus ?? bt.campus,
        departmentIds: [...new Set([n?.department?.id ?? n?.department_id, ...bt.departmentIds].filter((v) => v != null))],
        // A place is in a school or office building; one outside any building is neither.
        category: bt.category,
    };
}

/** Does closure `c` cover `t` (from buildingTarget / placeTarget)? */
export function covers(c, t) {
    if (!c || !t) return false;
    if (c.node_id != null && c.node_id !== t.nodeId) return false;
    if (c.building_id != null && c.building_id !== t.buildingId) return false;
    if (c.department_id != null && !t.departmentIds.includes(c.department_id)) return false;
    if (c.building_category && c.building_category !== t.category) return false;
    if (c.campus && c.campus !== t.campus) return false;
    return true;
}

const activeAt = (c, date) => new Date(c.starts_at) <= date && date < new Date(c.ends_at);

/** The first moment at or after `from` that the weekly hours are open (null hours: `from` itself). */
export function nextOpening(hours, from) {
    const h = valid(hours);
    if (!h) return from;
    const { day, minutes } = campusClock(from);
    const today = DAYS.indexOf(day);
    for (let k = 0; k <= 7; k += 1) {
        const d = DAYS[(today + k) % 7];
        for (const [o, c] of (Array.isArray(h[d]) ? h[d] : [])) {
            const open = toMinutes(o);
            const close = toMinutes(c);
            if (k === 0 && minutes >= open && minutes < close) return from;
            if (k > 0 || open > minutes) return new Date(from.getTime() + ((k * 1440 + open) - minutes) * 60000);
        }
    }
    return null;
}

/**
 * Open or closed at `date` with closures applied (same shape as openState, plus `reason` when a
 * closure is why). Null when there are no hours and nothing covers it.
 */
export function placeStatus(hours, closures, target, date = new Date()) {
    const here = (closures || []).filter((c) => activeAt(c, date) && covers(c, target));
    const closed = here.filter((c) => c.kind !== 'open').sort((a, b) => new Date(b.ends_at) - new Date(a.ends_at))[0];
    if (closed) {
        const reopens = nextOpening(hours, new Date(closed.ends_at));
        const reason = String(closed.reason || '').trim();
        const opens = reopens ? formatWhen(reopens, date) : null;
        return {
            open: false, short: 'Closed', reason, opens,
            label: `Closed${reason ? ` · ${reason}` : ''}${opens ? ` · opens ${opens}` : ''}`,
        };
    }
    const special = here.find((c) => c.kind === 'open');
    if (special) return { open: true, short: 'Open', label: `Open · special hours until ${formatWhen(special.ends_at, date)}` };
    return openState(hours, date);
}

/** A building's status (its hours and what covers it). */
export function buildingStatus(b, closures, date = new Date()) {
    return placeStatus(b?.opening_hours, closures, buildingTarget(b), date);
}

/** A place's status (its own hours or its building's, and what covers it or its building). */
export function placeStatusOf(n, buildingsById, closures, date = new Date()) {
    return placeStatus(hoursOf(n, buildingsById), closures, placeTarget(n, buildingsById), date);
}

/**
 * School-level announcements going on now (no department, building or place: the whole school, a
 * campus, every college or every office), for the banner on the map.
 * @returns {Array<{ id: *, text: string }>}
 */
export function announcements(closures, date = new Date()) {
    return (closures || [])
        .filter((c) => c.kind !== 'open' && activeAt(c, date) && c.department_id == null && c.building_id == null && c.node_id == null)
        .map((c) => {
            const who = c.building_category === 'school' ? 'All school buildings' : c.building_category === 'office' ? 'All office buildings' : 'Whole school';
            const where = c.campus ? `${who === 'Whole school' ? 'Campus' : `${who}, Campus`} ${c.campus}` : who;
            const reason = String(c.reason || '').trim() || 'Closed';
            return { id: c.id, text: `${reason} · ${where} · until ${formatWhen(c.ends_at, date)}` };
        });
}

/**
 * The sentence for a destination that is closed right now (no route is drawn to it):
 * "Misto is closed now. It opens tomorrow 8 am." / "CCS is closed now: Classes suspended. It opens Mon 8 am."
 */
export function closedMessage(name, status) {
    if (!status || status.open) return null;
    const reason = String(status.reason || '').trim();
    return `${name || 'This place'} is closed now${reason ? `: ${reason}` : ''}.${status.opens ? ` It opens ${status.opens}.` : ''}`;
}

/**
 * Is the whole campus closed at `date` (outside its daily hours, campus time)? `hours`: { opens: '06:00',
 * closes: '21:00' } from the map feed (config/campus.php); a closing time before the opening one wraps
 * past midnight. Null while open or with no hours set; else { opens: '6 am', closes: '9 pm' }.
 */
export function campusClosed(hours, date = new Date()) {
    if (!hours?.opens || !hours?.closes) return null;
    const open = toMinutes(hours.opens);
    const close = toMinutes(hours.closes);
    if (!Number.isFinite(open) || !Number.isFinite(close) || open === close) return null;
    const { minutes } = campusClock(date);
    const isOpen = open < close ? minutes >= open && minutes < close : minutes >= open || minutes < close;
    return isOpen ? null : { opens: formatTime(hours.opens), closes: formatTime(hours.closes) };
}
