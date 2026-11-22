import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { C, TYPE } from '../uiTokens';
import { confirmAction } from './ConfirmDialog';
import { formatWhen } from '../openingHours';

const CSS = `
    .ann-page {
        position: absolute; inset: 0; min-height: 0; overflow-y: auto; -webkit-overflow-scrolling: touch;
        background: ${C.page}; padding: clamp(20px, 2.5vw, 30px) clamp(16px, 2.25vw, 26px) 44px;
        animation: fadeIn var(--dur-slow) var(--ease-out) both;
    }
    .ann-inner { width: 100%; max-width: 1120px; margin: 0 auto; display: flex; flex-direction: column; gap: 18px; }
    .ann-cols { display: grid; grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.1fr); gap: 18px; align-items: start; }
    .ann-cols > .ui-card { min-width: 0; }
    .ann-form { display: flex; flex-direction: column; gap: 14px; }
    .ann-two { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .ann-presets { display: flex; flex-wrap: wrap; gap: 6px; }
    .ann-actions { display: flex; justify-content: flex-end; }
    .ann-list { list-style: none; margin: 0; padding: 0; }
    .ann-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 12px; align-items: center; padding: 10px 6px; border-top: 1px solid ${C.hairline}; }
    .ann-list > .ann-row:first-child { border-top-color: transparent; }
    .ann-title { font-size: ${TYPE.sub}; font-weight: 600; color: #fff; overflow-wrap: anywhere; }
    .ann-sub { margin-top: 2px; font-size: ${TYPE.desc}; color: ${C.muted}; overflow-wrap: anywhere; }
    .ann-tag { display: inline-block; margin-right: 8px; padding: 1px 8px; border-radius: 999px; font-size: ${TYPE.desc}; font-weight: 700; }
    .ann-tag.is-closed { background: rgba(251, 191, 36, 0.14); color: ${C.warning}; }
    .ann-tag.is-open { background: rgba(255, 255, 255, 0.1); color: ${C.text}; }
    .ann-tag.is-now { background: rgba(248, 113, 113, 0.16); color: #fca5a5; }
    .ann-empty { padding: 24px 8px; text-align: center; color: ${C.muted}; font-size: ${TYPE.sub}; line-height: 1.5; }
    .ann-heat { border-color: rgba(251, 191, 36, 0.45); }
    .ann-heat p { margin: 4px 0 12px; color: ${C.text}; font-size: ${TYPE.sub}; line-height: 1.5; }
    @media (max-width: 860px) { .ann-cols { grid-template-columns: minmax(0, 1fr); } }
    @media (max-width: 480px) { .ann-two { grid-template-columns: minmax(0, 1fr); } }
`;

/** Campus time is UTC+8 (no daylight saving): datetime-local values are read and written in it. */
const CAMPUS_MS = 8 * 3600 * 1000;
const toLocalInput = (date) => new Date(date.getTime() + CAMPUS_MS).toISOString().slice(0, 16);
const fromLocalInput = (value) => new Date(`${value}:00+08:00`);
/** Campus time today at hh:mm (as a Date). */
const todayAt = (hh, mm = 0, addDays = 0) => {
    const local = new Date(Date.now() + CAMPUS_MS);
    return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + addDays, hh, mm) - CAMPUS_MS);
};

/** Heat index from which an admin is asked whether to suspend classes (PAGASA "Danger"). */
const HEAT_SUSPEND_C = 41;

/**
 * Announcements: closures (maintenance, an event, classes suspended) and special openings, on top
 * of the weekly opening hours. Admins post any scope, from the whole school or every college down
 * to one room; staff only their own department, its buildings and the places in them. Each ends on
 * its own; Remove ends it early. The phone applies them (src/openingHours.js).
 */
export default function AdminAnnouncements({ currentUser, departments, buildings, nodes, closures, onChanged, notify, fail }) {
    const isAdmin = currentUser?.role === 'admin';
    const ownDept = currentUser?.department_id ?? currentUser?.department?.id ?? null;
    const ownBuildings = useMemo(
        () => (buildings || []).filter((b) => isAdmin || (ownDept != null && b.department_id === ownDept)),
        [buildings, isAdmin, ownDept],
    );
    const places = useMemo(() => {
        const ids = new Set(ownBuildings.map((b) => b.id));
        return (nodes || []).filter((n) => n.type === 'location' && n.name && (isAdmin || ids.has(n.building_id)))
            .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    }, [nodes, ownBuildings, isAdmin]);

    const SCOPES = isAdmin
        ? [['whole', 'Whole school'], ['school', 'All school buildings (classes suspended)'], ['office', 'All office buildings'], ['department', 'One department or office'], ['building', 'One building'], ['place', 'One room or office']]
        : [['department', `Our department${currentUser?.department?.name ? ` (${currentUser.department.name})` : ''}`], ['building', 'One of our buildings'], ['place', 'One room or office in them']];

    const [kind, setKind] = useState('closed');
    const [scope, setScope] = useState(SCOPES[0][0]);
    const [campus, setCampus] = useState('');
    const [departmentId, setDepartmentId] = useState('');
    const [buildingId, setBuildingId] = useState('');
    const [nodeId, setNodeId] = useState('');
    const [from, setFrom] = useState(() => toLocalInput(new Date()));
    const [to, setTo] = useState(() => toLocalInput(todayAt(17)));
    const [reason, setReason] = useState('');
    const [saving, setSaving] = useState(false);
    const [heat, setHeat] = useState(null);

    // A special opening is for one building or place.
    const canOpen = scope === 'building' || scope === 'place';
    useEffect(() => { if (!canOpen && kind === 'open') setKind('closed'); }, [canOpen, kind]);

    // Admins: when the heat index is dangerous now, offer to suspend classes (an official call: never automatic).
    useEffect(() => {
        if (!isAdmin) return undefined;
        let alive = true;
        api.getWeather().then((w) => { if (alive) setHeat(Number(w?.heat_index_c)); }).catch(() => {});
        return () => { alive = false; };
    }, [isAdmin]);
    const suspendedNow = (closures || []).some((c) => c.building_category === 'school' && c.kind !== 'open'
        && new Date(c.starts_at) <= new Date() && new Date() < new Date(c.ends_at));
    const showHeat = isAdmin && Number.isFinite(heat) && heat >= HEAT_SUSPEND_C && !suspendedNow;

    const preset = (name) => {
        const now = new Date();
        if (name === 'rest') { setFrom(toLocalInput(now)); setTo(toLocalInput(todayAt(23, 59))); }
        if (name === 'today') { setFrom(toLocalInput(todayAt(0))); setTo(toLocalInput(todayAt(23, 59))); }
        if (name === 'tomorrow') { setFrom(toLocalInput(todayAt(0, 0, 1))); setTo(toLocalInput(todayAt(23, 59, 1))); }
    };
    const fillHeat = () => {
        setKind('closed');
        setScope('school');
        setCampus('');
        setReason('Classes suspended: high heat index');
        preset('rest');
    };

    const submit = async (e) => {
        e.preventDefault();
        const start = fromLocalInput(from);
        const end = fromLocalInput(to);
        if (!(end > start)) { fail('The end must be after the start.'); return; }
        if (end <= new Date()) { fail('That time is already over.'); return; }
        if (kind === 'closed' && !reason.trim()) { fail('Say why it is closed: students see the reason.'); return; }
        const target = {
            whole: {}, school: { building_category: 'school' }, office: { building_category: 'office' },
            department: { department_id: isAdmin ? Number(departmentId) || null : ownDept },
            building: { building_id: Number(buildingId) || null },
            place: { node_id: Number(nodeId) || null },
        }[scope];
        if ((scope === 'department' && !target.department_id) || (scope === 'building' && !target.building_id) || (scope === 'place' && !target.node_id)) {
            fail('Choose which one.');
            return;
        }
        setSaving(true);
        try {
            await api.createClosure({
                kind, reason: reason.trim() || null, ...target,
                ...(isAdmin && ['whole', 'school', 'office'].includes(scope) && campus ? { campus } : {}),
                starts_at: start.toISOString(), ends_at: end.toISOString(),
            });
            setReason('');
            await onChanged();
            notify(kind === 'open' ? 'Special opening posted' : 'Closure posted: students see it on the map');
        } catch (err) { fail(err.message); } finally { setSaving(false); }
    };

    const remove = async (c) => {
        if (!(await confirmAction({
            title: 'End this now?',
            message: `${scopeLabel(c)}${c.reason ? `: ${c.reason}` : ''}. It disappears from the map.`,
            confirmLabel: 'End it now', tone: 'danger',
        }))) return;
        try {
            await api.deleteClosure(c.id);
            await onChanged();
            notify('Ended');
        } catch (err) { fail(err.message); }
    };

    function scopeLabel(c) {
        const campusTag = c.campus ? `, Campus ${c.campus}` : '';
        if (c.node_id) return c.node?.name || 'A room';
        if (c.building_id) return c.building?.short_name || c.building?.name || 'A building';
        if (c.department_id) return c.department?.name || 'A department';
        if (c.building_category === 'school') return `All school buildings${campusTag}`;
        if (c.building_category === 'office') return `All office buildings${campusTag}`;
        return c.campus ? `Campus ${c.campus}` : 'Whole school';
    }
    const when = (c) => {
        const now = new Date();
        const live = new Date(c.starts_at) <= now;
        return `${live ? 'Now' : `From ${formatWhen(c.starts_at, now)}`} until ${formatWhen(c.ends_at, now)}`;
    };

    const list = (closures || []).slice().sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));

    return (
        <div className="ann-page">
            <style>{CSS}</style>
            <div className="ann-inner">
                <header className="rise" style={{ '--i': 0 }}>
                    <h1 className="ui-h1">Announcements</h1>
                    <p className="ui-sub">
                        {isAdmin
                            ? 'Close the whole school, every school or office building, or one department, building or room for a while, with a reason students see. Routes do not pass through closed buildings. Each ends on its own.'
                            : 'Close your department, one of its buildings or a room for a while (maintenance, an event), with a reason students see, or open on a day you are usually closed. Each ends on its own.'}
                    </p>
                </header>

                {showHeat && (
                    <section className="ui-card ann-heat rise" style={{ '--i': 1 }} aria-labelledby="ann-heat-title">
                        <h2 className="ui-card-title" id="ann-heat-title" style={{ marginTop: 0 }}>Heat index {Math.round(heat)}°C right now</h2>
                        <p>That is in the Danger range. Suspending classes is your call: if you do, post it here and every school building closes on the map, while office buildings stay open.</p>
                        <button type="button" className="ui-btn ui-btn-secondary" onClick={fillHeat}>Fill in a class suspension</button>
                    </section>
                )}

                <div className="ann-cols">
                    <section className="ui-card rise" style={{ '--i': 2 }} aria-labelledby="ann-form-title">
                        <h2 className="ui-card-title" id="ann-form-title" style={{ marginTop: 0 }}>Post an announcement</h2>
                        {!isAdmin && ownDept == null ? (
                            <p className="ann-empty">Ask an admin to assign you a department first.</p>
                        ) : (
                            <form className="ann-form" onSubmit={submit}>
                                <div className="ui-field">
                                    <label className="ui-label" htmlFor="ann-scope">Applies to</label>
                                    <select id="ann-scope" className="ui-select" value={scope} onChange={(e) => setScope(e.target.value)}>
                                        {SCOPES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
                                    </select>
                                    {scope === 'school' && <span className="ui-hint">Every school building and its rooms close; office buildings (cashier, registrar, canteen) stay open.</span>}
                                </div>
                                {isAdmin && ['whole', 'school', 'office'].includes(scope) && (
                                    <div className="ui-field">
                                        <label className="ui-label" htmlFor="ann-campus">Campus</label>
                                        <select id="ann-campus" className="ui-select" value={campus} onChange={(e) => setCampus(e.target.value)}>
                                            <option value="">Both campuses</option>
                                            <option value="A">Campus A</option>
                                            <option value="B">Campus B</option>
                                        </select>
                                    </div>
                                )}
                                {isAdmin && scope === 'department' && (
                                    <div className="ui-field">
                                        <label className="ui-label" htmlFor="ann-dept">Department or office</label>
                                        <select id="ann-dept" className="ui-select" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
                                            <option value="">Choose…</option>
                                            {(departments || []).map((d) => <option key={d.id} value={d.id}>{d.name}{d.kind === 'office' ? ' (office)' : ''}</option>)}
                                        </select>
                                    </div>
                                )}
                                {scope === 'building' && (
                                    <div className="ui-field">
                                        <label className="ui-label" htmlFor="ann-building">Building</label>
                                        <select id="ann-building" className="ui-select" value={buildingId} onChange={(e) => setBuildingId(e.target.value)}>
                                            <option value="">Choose…</option>
                                            {ownBuildings.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                                        </select>
                                    </div>
                                )}
                                {scope === 'place' && (
                                    <div className="ui-field">
                                        <label className="ui-label" htmlFor="ann-place">Room or office</label>
                                        <select id="ann-place" className="ui-select" value={nodeId} onChange={(e) => setNodeId(e.target.value)}>
                                            <option value="">Choose…</option>
                                            {places.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}
                                        </select>
                                    </div>
                                )}
                                {canOpen && (
                                    <div className="ui-field">
                                        <label className="ui-label" htmlFor="ann-kind">What</label>
                                        <select id="ann-kind" className="ui-select" value={kind} onChange={(e) => setKind(e.target.value)}>
                                            <option value="closed">Closed</option>
                                            <option value="open">Special opening (open on a usually closed day)</option>
                                        </select>
                                    </div>
                                )}
                                <div className="ann-presets" role="group" aria-label="Quick times">
                                    <button type="button" className="ui-btn ui-btn-secondary ui-btn-sm" onClick={() => preset('rest')}>Rest of today</button>
                                    <button type="button" className="ui-btn ui-btn-secondary ui-btn-sm" onClick={() => preset('today')}>All day today</button>
                                    <button type="button" className="ui-btn ui-btn-secondary ui-btn-sm" onClick={() => preset('tomorrow')}>All day tomorrow</button>
                                </div>
                                <div className="ann-two">
                                    <div className="ui-field">
                                        <label className="ui-label" htmlFor="ann-from">From (campus time)</label>
                                        <input id="ann-from" className="ui-input" type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} required />
                                    </div>
                                    <div className="ui-field">
                                        <label className="ui-label" htmlFor="ann-to">Until</label>
                                        <input id="ann-to" className="ui-input" type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} required />
                                    </div>
                                </div>
                                <div className="ui-field">
                                    <label className="ui-label" htmlFor="ann-reason">{kind === 'open' ? 'Note (optional)' : 'Reason students see'}</label>
                                    <input
                                        id="ann-reason" className="ui-input" maxLength={160} value={reason} onChange={(e) => setReason(e.target.value)}
                                        placeholder={kind === 'open' ? 'e.g. Enrollment' : 'e.g. System maintenance'} required={kind === 'closed'}
                                    />
                                </div>
                                <div className="ann-actions">
                                    <button type="submit" className="ui-btn ui-btn-primary" disabled={saving}>
                                        {saving && <span className="btn-spin" aria-hidden="true" />}
                                        {saving ? 'Posting' : 'Post'}
                                    </button>
                                </div>
                            </form>
                        )}
                    </section>

                    <section className="ui-card rise" style={{ '--i': 3 }} aria-labelledby="ann-list-title">
                        <h2 className="ui-card-title" id="ann-list-title" style={{ marginTop: 0 }}>Now and upcoming</h2>
                        {list.length === 0 ? (
                            <p className="ann-empty">Nothing announced. Places follow their usual opening hours.</p>
                        ) : (
                            <ul className="ann-list">
                                {list.map((c) => {
                                    const live = new Date(c.starts_at) <= new Date();
                                    return (
                                        <li key={c.id} className="ann-row">
                                            <div>
                                                <div className="ann-title">
                                                    <span className={`ann-tag ${c.kind === 'open' ? 'is-open' : live ? 'is-now' : 'is-closed'}`}>
                                                        {c.kind === 'open' ? 'Open' : live ? 'Closed now' : 'Closed'}
                                                    </span>
                                                    {scopeLabel(c)}
                                                </div>
                                                <div className="ann-sub">
                                                    {when(c)}{c.reason ? ` · ${c.reason}` : ''}{c.creator?.name ? ` · by ${c.creator.name}` : ''}
                                                </div>
                                            </div>
                                            {c.can_manage && (
                                                <button type="button" className="ui-btn ui-btn-danger ui-btn-sm" onClick={() => remove(c)}>End now</button>
                                            )}
                                        </li>
                                    );
                                })}
                            </ul>
                        )}
                    </section>
                </div>
            </div>
        </div>
    );
}
