import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { C, TYPE } from '../uiTokens';
import ScrollWindow from './ScrollWindow';

// Admins filter by who; department staff only ever get their courses' students (the server decides).
const FILTERS = [
    { value: '', label: 'Everyone' },
    { value: 'staff', label: 'Staff' },
    { value: 'student', label: 'Students' },
    { value: 'visitor', label: 'Visitors' },
];
const ROLE_LABEL = { admin: 'Admin', faculty: 'Faculty', student: 'Student', visitor: 'Visitor' };
const yearLabel = (n) => `${n}${['th', 'st', 'nd', 'rd'][n] || 'th'} year`;
// Rows shown before the list scrolls inside its card; every row is this tall (ScrollWindow).
const LIST_ROWS = { desktop: 10, phone: 6 };
const ROW_H = { desktop: 64, phone: 84 };
const when = (iso) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

const CSS = `
    .act-page {
        position: absolute; inset: 0; min-height: 0; overflow-y: auto; -webkit-overflow-scrolling: touch;
        background: ${C.page}; padding: clamp(20px, 2.5vw, 30px) clamp(16px, 2.25vw, 26px) 44px;
        animation: fadeIn var(--dur-slow) var(--ease-out) both;
    }
    .act-inner { width: 100%; max-width: 1120px; margin: 0 auto; display: flex; flex-direction: column; gap: 18px; }
    .act-tools { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin-bottom: 10px; }
    .act-tools .ui-input { flex: 1 1 220px; min-width: 0; }
    .act-chips { display: flex; gap: 6px; flex-wrap: wrap; }
    .act-chip {
        min-height: 36px; padding: 0 12px; border-radius: 10px; cursor: pointer; border: 1px solid ${C.hairline};
        background: rgba(255,255,255,0.04); color: ${C.muted}; font: inherit; font-size: 13px; font-weight: 600;
    }
    .act-chip:hover { color: #fff; background: rgba(255,255,255,0.08); }
    .act-chip[aria-pressed="true"] { background: rgba(74, 222, 128, 0.12); border-color: rgba(74, 222, 128, 0.4); color: ${C.accent}; }
    .act-chip:focus-visible { outline: 2px solid ${C.focus}; outline-offset: 2px; }
    .act-list { list-style: none; margin: 0; padding: 0; }
    .act-row {
        display: grid; grid-template-columns: 120px minmax(0, 1fr) minmax(0, 1.4fr); gap: 4px 14px; align-items: center;
        height: ${ROW_H.desktop}px; padding: 0 6px; border-top: 1px solid ${C.hairline}; box-sizing: border-box;
    }
    .act-list > .act-row:first-child { border-top-color: transparent; }
    .act-time { font-size: ${TYPE.desc}; color: ${C.muted}; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .act-who { min-width: 0; }
    .act-who { display: flex; align-items: center; gap: 6px; }
    .act-name { min-width: 0; font-size: ${TYPE.sub}; font-weight: 600; color: #fff; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .act-role { flex: none; padding: 1px 7px; border-radius: 6px; background: rgba(255,255,255,0.07);
        font-size: 12px; font-weight: 600; color: ${C.text}; }
    /* One line each (the row height is fixed for the scroll window); the full text is in the tooltip. */
    .act-what, .act-meta { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .act-what { font-size: ${TYPE.sub}; color: ${C.text}; }
    .act-meta { display: block; margin-top: 2px; font-size: ${TYPE.desc}; color: ${C.muted}; }
    .act-empty { padding: 28px 8px; text-align: center; color: ${C.muted}; font-size: ${TYPE.sub}; line-height: 1.5; }
    .act-more { display: flex; justify-content: center; padding-top: 12px; }
    @media (max-width: 720px) {
        .act-row { grid-template-columns: minmax(0, 1fr) auto; grid-template-areas: "who time" "what what"; height: ${ROW_H.phone}px; align-content: center; }
        .act-time { grid-area: time; }
        .act-who { grid-area: who; }
        .act-what { grid-area: what; }
    }
`;

/** Second line under what happened: course and year, department, or a visitor's IP and device. */
function metaOf(row) {
    if (row.role === 'student') return [row.course, row.year_level ? yearLabel(row.year_level) : null].filter(Boolean).join(' · ');
    if (row.role === 'visitor') return [row.ip, row.user_agent].filter(Boolean).join(' · ');
    return [row.department?.name, row.action === 'login' ? row.ip : null].filter(Boolean).join(' · ');
}

export default function AdminActivity({ isAdmin, fail }) {
    const [role, setRole] = useState('');
    const [query, setQuery] = useState('');
    const [search, setSearch] = useState('');
    const [rows, setRows] = useState(null); // null = loading
    const [page, setPage] = useState({ current: 1, last: 1, total: 0 });
    const [loadingMore, setLoadingMore] = useState(false);

    // Typing settles before it asks the server.
    useEffect(() => {
        const t = setTimeout(() => setSearch(query.trim()), 300);
        return () => clearTimeout(t);
    }, [query]);

    const load = useCallback(async (pageNo) => {
        try {
            const res = await api.getActivityLogs({ role, q: search, page: pageNo });
            setRows((prev) => (pageNo === 1 ? res.data : [...(prev || []), ...res.data]));
            setPage({ current: res.current_page, last: res.last_page, total: res.total });
        } catch (err) {
            if (pageNo === 1) setRows([]);
            fail(err.message);
        }
    }, [role, search, fail]);
    useEffect(() => { setRows(null); load(1); }, [load]);

    const more = async () => {
        setLoadingMore(true);
        await load(page.current + 1);
        setLoadingMore(false);
    };

    return (
        <div className="act-page">
            <style>{CSS}</style>
            <div className="act-inner">
                <header className="rise" style={{ '--i': 0 }}>
                    <h1 className="ui-h1">Activity log</h1>
                    <p className="ui-sub">
                        {isAdmin
                            ? 'Every staff sign-in and change, student sign-ins, and what visitors open on the map. Kept 180 days.'
                            : 'Sign-ins of the students in your department\'s courses. Kept 180 days.'}
                    </p>
                </header>
                <section className="ui-card rise" style={{ '--i': 1 }} aria-labelledby="act-title">
                    <h2 className="ui-card-title" id="act-title" style={{ marginTop: 0 }}>
                        Entries <span className="ui-hint ui-num">{rows === null ? '' : page.total.toLocaleString()}</span>
                    </h2>
                    <div className="act-tools">
                        <input
                            className="ui-input" type="search" value={query} onChange={(e) => setQuery(e.target.value)}
                            placeholder={isAdmin ? 'Search name, action or IP' : 'Search student name'} aria-label="Search the activity log"
                        />
                        {isAdmin && (
                            <div className="act-chips" role="group" aria-label="Show">
                                {FILTERS.map((f) => (
                                    <button key={f.value} type="button" className="act-chip" aria-pressed={role === f.value} onClick={() => setRole(f.value)}>
                                        {f.label}
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>
                    {rows === null ? (
                        <p className="act-empty" role="status">Loading the activity log</p>
                    ) : rows.length === 0 ? (
                        <p className="act-empty">
                            {search ? `Nothing matches “${search}”.`
                                : isAdmin ? 'Nothing logged yet.'
                                    : "No sign-ins yet. Only students in your department's courses show here: add or check them in the Courses tab."}
                        </p>
                    ) : (
                        <>
                            <ScrollWindow
                                as="ul" className="act-list" label="Activity log entries"
                                rows={LIST_ROWS.desktop} phoneRows={LIST_ROWS.phone} rowHeight={ROW_H.desktop} phoneRowHeight={ROW_H.phone}
                                count={rows.length} noun="more entries"
                            >
                                {rows.map((r) => (
                                    <li key={r.id} className="act-row">
                                        <time className="act-time" dateTime={r.created_at}>{when(r.created_at)}</time>
                                        <div className="act-who">
                                            <span className="act-name">{r.name || 'Visitor'}</span>
                                            <span className="act-role">{ROLE_LABEL[r.role] || r.role}</span>
                                        </div>
                                        <div className="act-what" title={[r.summary, metaOf(r)].filter(Boolean).join(' · ')}>
                                            {r.summary}
                                            {metaOf(r) && <span className="act-meta">{metaOf(r)}</span>}
                                        </div>
                                    </li>
                                ))}
                            </ScrollWindow>
                            {page.current < page.last && (
                                <div className="act-more">
                                    <button type="button" className="ui-btn ui-btn-secondary" onClick={more} disabled={loadingMore}>
                                        {loadingMore && <span className="btn-spin" aria-hidden="true" />}
                                        {loadingMore ? 'Loading' : `Load more (${(page.total - rows.length).toLocaleString()} left)`}
                                    </button>
                                </div>
                            )}
                        </>
                    )}
                </section>
            </div>
        </div>
    );
}
