import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { C, TYPE, TAP } from '../uiTokens';
import { confirmAction } from './ConfirmDialog';
import ScrollWindow from './ScrollWindow';

const YEAR_LEVELS = [1, 2, 3, 4, 5, 6];
const yearLabel = (n) => `${n}${['th', 'st', 'nd', 'rd'][n] || 'th'} year`;
// Same rule as User::STUDENT_NUMBER_PATTERN: two letters + nine digits.
const ID_PATTERN = /^[a-z]{2}\d{9}$/;
const DEFAULT_DOMAIN = 'wmsu.edu.ph';
const EMPTY = { student_number: '', first_name: '', last_name: '', course: '', year_level: 1, gender: '', password: '' };

const CSS = `
    .stu-page {
        position: absolute; inset: 0; min-height: 0; overflow-y: auto; -webkit-overflow-scrolling: touch;
        background: ${C.page}; padding: clamp(20px, 2.5vw, 30px) clamp(16px, 2.25vw, 26px) 44px;
        animation: fadeIn var(--dur-slow) var(--ease-out) both;
    }
    .stu-inner { width: 100%; max-width: 1120px; margin: 0 auto; display: flex; flex-direction: column; gap: 22px; }
    .stu-cols { display: grid; grid-template-columns: minmax(0, 0.8fr) minmax(0, 1.2fr); gap: 18px; align-items: start; }
    .stu-cols > .ui-card { min-width: 0; }
    .stu-form-card { position: sticky; top: 0; }
    .stu-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
    .stu-head .ui-card-title { margin: 0; display: flex; align-items: center; gap: 8px; }
    .stu-count { display: inline-flex; min-width: 26px; justify-content: center; padding: 2px 8px; border-radius: 6px; background: rgba(255,255,255,0.07); }

    .stu-form { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 14px; }
    .stu-form .full { grid-column: 1 / -1; }
    .stu-id { display: flex; align-items: stretch; border: 1px solid ${C.fieldBorder}; border-radius: 8px; background: ${C.field}; overflow: hidden;
        transition: border-color var(--dur-fast) ease, box-shadow var(--dur-base) var(--ease-out); }
    .stu-id:focus-within { border-color: ${C.focus}; box-shadow: 0 0 0 3px rgba(255,255,255,0.22); }
    .stu-id[data-invalid="true"] { border-color: ${C.errorBorder}; }
    .stu-id input { flex: 1; min-width: 0; border: 0; background: transparent; box-shadow: none !important; font-variant-numeric: tabular-nums; letter-spacing: 0.02em; }
    .stu-id input:focus-visible { outline: none; }
    .stu-id span { display: flex; align-items: center; padding: 0 12px; border-left: 1px solid ${C.fieldBorder}; color: ${C.muted}; font-size: ${TYPE.desc}; white-space: nowrap; user-select: none; }
    .stu-pw { position: relative; }
    .stu-pw .ui-input { padding-right: 64px; }
    .stu-pw button { position: absolute; right: 4px; top: 50%; transform: translateY(-50%); min-height: 34px; padding: 0 10px; border: 0; border-radius: 6px;
        background: transparent; color: ${C.muted}; font: inherit; font-size: ${TYPE.desc}; font-weight: 600; cursor: pointer; }
    .stu-pw button:hover { color: #fff; }
    .stu-pw button:focus-visible { outline: 2px solid ${C.focus}; outline-offset: 1px; }
    .stu-actions { grid-column: 1 / -1; display: flex; gap: 10px; justify-content: flex-end; }

    .stu-tools { display: flex; flex-direction: column; gap: 10px; margin-bottom: 8px; }
    .stu-chips { display: flex; gap: 6px; flex-wrap: wrap; }
    .stu-chip {
        display: inline-flex; align-items: center; gap: 6px; min-height: 34px; padding: 0 12px; border-radius: 10px; cursor: pointer;
        border: 1px solid ${C.hairline}; background: rgba(255,255,255,0.04); color: ${C.muted};
        font: inherit; font-size: 13px; font-weight: 600; transition: background-color var(--dur-fast) ease, color var(--dur-fast) ease, border-color var(--dur-fast) ease;
    }
    .stu-chip:hover { color: #fff; background: rgba(255,255,255,0.08); }
    .stu-chip[aria-pressed="true"] { background: rgba(74, 222, 128, 0.12); border-color: rgba(74, 222, 128, 0.4); color: ${C.accent}; }
    .stu-chip:focus-visible { outline: 2px solid ${C.focus}; outline-offset: 2px; }
    .stu-chip b { font-variant-numeric: tabular-nums; font-weight: 700; }

    .stu-list { list-style: none; margin: 0 -4px; padding: 0 4px; }
    .stu-row {
        display: grid; grid-template-columns: 40px minmax(0, 1fr) auto auto; grid-template-areas: "avatar text meta actions";
        align-items: center; gap: 12px; min-height: 64px; padding: 8px 6px; border-top: 1px solid ${C.hairline}; border-radius: 10px;
        transition: background-color var(--dur-fast) ease;
    }
    .stu-list > .stu-row:first-child { border-top-color: transparent; }
    .stu-row:hover, .stu-row.is-editing { background: rgba(255,255,255,0.04); }
    .stu-row.is-editing { background: rgba(255,255,255,0.07); }
    .stu-avatar { grid-area: avatar; width: 40px; height: 40px; border-radius: 12px; display: grid; place-items: center;
        background: rgba(255,255,255,0.07); color: ${C.text}; font-size: 13px; font-weight: 700; letter-spacing: 0.02em; }
    .stu-text { grid-area: text; min-width: 0; }
    .stu-name { font-size: ${TYPE.sub}; font-weight: 600; color: #fff; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .stu-sub { margin-top: 2px; font-size: ${TYPE.desc}; color: ${C.muted}; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums; }
    .stu-meta { grid-area: meta; display: flex; align-items: center; gap: 8px; white-space: nowrap; }
    .stu-year { font-size: ${TYPE.desc}; color: ${C.muted}; font-variant-numeric: tabular-nums; }
    .stu-row-actions { grid-area: actions; display: flex; gap: 6px; }
    /* Reset password: a quiet block inside the Edit form, under the password field. */
    .stu-reset { grid-column: 1 / -1; display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap;
        padding: 12px 14px; border: 1px solid ${C.hairline}; border-radius: 10px; }
    .stu-reset p { margin: 0; font-size: ${TYPE.desc}; color: ${C.muted}; line-height: 1.5; max-width: 46ch; }
    .stu-reset b { display: block; font-size: ${TYPE.sub}; color: ${C.text}; font-weight: 600; margin-bottom: 2px; }
    .stu-temp { margin: 14px 0 6px; display: flex; align-items: center; gap: 8px; }
    .stu-temp code { flex: 1; min-width: 0; padding: 10px 12px; border-radius: 10px; background: ${C.field}; border: 1px solid ${C.fieldBorder};
        font-size: 20px; font-weight: 700; letter-spacing: 0.06em; color: #fff; text-align: center; user-select: all; }

    @media (max-width: 1080px) { .stu-cols { grid-template-columns: minmax(0, 1fr); } .stu-form-card { position: static; } }
    /* Touch screens of any width (tablets, landscape phones): 44 px targets. */
    @media (pointer: coarse) {
        .stu-pw button, .stu-chip { min-height: ${TAP.minHeight}; }
    }
    @media (max-width: 760px) {
        .stu-page { padding: 18px 12px max(32px, env(safe-area-inset-bottom)); }
        .ui-card { padding: 16px; }
        .stu-form { grid-template-columns: minmax(0, 1fr); gap: 12px; }
        .stu-actions { flex-direction: column-reverse; }
        .stu-actions .ui-btn { width: 100%; }
        .stu-row { grid-template-columns: 40px minmax(0, 1fr) auto; grid-template-areas: "avatar text actions" "avatar meta actions"; row-gap: 4px; min-height: 76px; }
        .stu-row-actions { flex-direction: column; }
    }
`;

/** "Kristine Mae Alvarez" -> "KA" */
const initials = (s) => `${(s.first_name || '').trim()[0] || ''}${(s.last_name || '').trim()[0] || ''}`.toUpperCase() || '?';

export default function AdminStudents({ notify, fail }) {
    const [students, setStudents] = useState(null); // null = loading
    const [query, setQuery] = useState('');
    const [course, setCourse] = useState('all');
    const [form, setForm] = useState(EMPTY);
    const [editing, setEditing] = useState(null); // student being edited, or null = adding
    const [touchedId, setTouchedId] = useState(false);
    const [showPw, setShowPw] = useState(false);
    const [saving, setSaving] = useState(false);
    // { name, password } right after an admin reset; shown once, never stored.
    const [tempPw, setTempPw] = useState(null);
    const [copied, setCopied] = useState(false);
    const idRef = useRef(null);

    // Courses come from the Courses tab (the courses table), not a fixed list.
    const [courses, setCourses] = useState([]);
    const load = useCallback(async () => {
        try {
            const [list, courseList] = await Promise.all([api.getStudents(), api.getCourses()]);
            setStudents(list);
            setCourses(courseList);
        } catch (err) { setStudents([]); fail(err.message); }
    }, [fail]);
    useEffect(() => { load(); }, [load]);
    useEffect(() => {
        if (form.course === '' && courses.length) setForm((f) => ({ ...f, course: courses[0].code }));
    }, [courses, form.course]);

    // The email domain the server uses, read off an existing student.
    const domain = useMemo(() => {
        const any = (students || []).find((s) => s.email?.includes('@'));
        return any ? any.email.split('@')[1] : DEFAULT_DOMAIN;
    }, [students]);

    const id = form.student_number.trim().toLowerCase();
    const idValid = ID_PATTERN.test(id);
    const idTaken = (students || []).some((s) => s.student_number === id && s.id !== editing?.id);
    const pwValid = editing ? (form.password === '' || form.password.length >= 8) : form.password.length >= 8;
    const formValid = idValid && !idTaken && form.first_name.trim() && form.last_name.trim() && pwValid;
    const idError = touchedId && id !== '' && !idValid
        ? 'Use two letters and nine digits, like ae202401622.'
        : idTaken ? 'Another student already has this ID.' : null;

    const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
    const reset = () => { setForm(EMPTY); setEditing(null); setTouchedId(false); setShowPw(false); };
    const startEdit = (s) => {
        setEditing(s);
        setForm({ student_number: s.student_number || '', first_name: s.first_name || '', last_name: s.last_name || '', course: s.course || courses[0]?.code || '', year_level: s.year_level || 1, gender: s.gender || '', password: '' });
        setTouchedId(true);
        setTimeout(() => idRef.current?.focus(), 50);
    };

    const save = async (e) => {
        e.preventDefault();
        if (!formValid) {
            setTouchedId(true);
            const [message, field] = !idValid || idTaken ? [idTaken ? 'Another student already has this school ID.' : 'Enter a school ID: two letters and nine digits.', 'stu-id']
                : !form.first_name.trim() ? ['Enter the first name.', 'stu-first']
                    : !form.last_name.trim() ? ['Enter the last name.', 'stu-last']
                        : ['The password needs at least 8 characters.', 'stu-pw'];
            fail(message);
            document.getElementById(field)?.focus();
            return;
        }
        setSaving(true);
        const data = {
            student_number: id,
            first_name: form.first_name.trim(),
            last_name: form.last_name.trim(),
            course: form.course,
            year_level: Number(form.year_level),
            gender: form.gender || null,
        };
        try {
            if (editing) {
                await api.updateStudent(editing.id, { ...data, password: form.password || null });
                notify(form.password ? `${data.first_name}'s details and password updated` : `${data.first_name}'s details updated`);
            } else {
                await api.createStudent({ ...data, password: form.password });
                notify(`${data.first_name} ${data.last_name} added`);
            }
            reset();
            await load();
        } catch (err) { fail(err.message); } finally { setSaving(false); }
    };

    const resetPassword = async (s) => {
        if (!(await confirmAction({
            title: `Reset ${s.first_name}'s password?`,
            message: `You get a one-time password to give to ${s.first_name}. Their current password stops working, they are signed out everywhere, and they choose a new password at the next sign-in.`,
            confirmLabel: 'Reset password', tone: 'primary',
        }))) return;
        try {
            const res = await api.resetStudentPassword(s.id);
            setCopied(false);
            setTempPw({ name: s.name, id: s.student_number, password: res.temporary_password });
            await load();
        } catch (err) { fail(err.message); }
    };
    const copyTemp = async () => {
        try { await navigator.clipboard.writeText(tempPw.password); setCopied(true); } catch { setCopied(false); }
    };

    const remove = async (s) => {
        if (!(await confirmAction({
            title: `Remove ${s.name}?`,
            message: `${s.email} can no longer sign in. This cannot be undone.`,
            confirmLabel: 'Remove student', tone: 'danger',
        }))) return;
        try {
            await api.deleteStudent(s.id);
            if (editing?.id === s.id) reset();
            await load();
            notify('Student removed');
        } catch (err) { fail(err.message); }
    };

    const list = students || [];
    const counts = useMemo(() => {
        const m = { all: list.length };
        for (const c of courses) m[c.code] = list.filter((s) => s.course === c.code).length;
        return m;
    }, [list]);
    const shown = useMemo(() => {
        const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
        return list.filter((s) => (course === 'all' || s.course === course)
            && words.every((w) => `${s.name} ${s.student_number} ${s.email} ${s.course} year ${s.year_level}`.toLowerCase().includes(w)));
    }, [list, query, course]);

    return (
        <div className="stu-page">
            <style>{CSS}</style>
            <div className="stu-inner">
                <header className="rise" style={{ '--i': 0 }}>
                    <h1 className="ui-h1">Students</h1>
                    <p className="ui-sub">
                        Student accounts for the campus directory. The school ID is also the sign-in email,
                        for example ae202401622@{domain}.
                    </p>
                </header>

                <div className="stu-cols">
                    {/* ── Add / edit ── */}
                    <section className="ui-card stu-form-card rise" style={{ '--i': 1 }} aria-labelledby="stu-form-title">
                        <div className="stu-head">
                            <h2 className="ui-card-title" id="stu-form-title">{editing ? `Edit ${editing.first_name}` : 'Add a student'}</h2>
                            {editing && <span className="ui-badge">Editing</span>}
                        </div>
                        <form className="stu-form" onSubmit={save} noValidate>
                            <div className="ui-field full">
                                <label className="ui-label" htmlFor="stu-id">School ID <span className="ui-req">*</span></label>
                                <div className="stu-id" data-invalid={idError ? 'true' : 'false'}>
                                    <input
                                        id="stu-id" ref={idRef} className="ui-input" value={form.student_number}
                                        onChange={(e) => setForm((f) => ({ ...f, student_number: e.target.value.replace(/\s+/g, '').toLowerCase() }))}
                                        onBlur={() => setTouchedId(true)}
                                        placeholder="ae202401622" maxLength={11} autoComplete="off" spellCheck={false}
                                        aria-invalid={idError ? 'true' : undefined} aria-describedby="stu-id-help"
                                    />
                                    <span aria-hidden="true">@{domain}</span>
                                </div>
                                {idError
                                    ? <span className="ui-field-error" id="stu-id-help">{idError}</span>
                                    : <span className="ui-hint" id="stu-id-help">Two letters and nine digits. The email becomes {id || 'ae202401622'}@{domain}.</span>}
                            </div>
                            <div className="ui-field">
                                <label className="ui-label" htmlFor="stu-first">First name <span className="ui-req">*</span></label>
                                <input id="stu-first" className="ui-input" value={form.first_name} onChange={set('first_name')} maxLength={100} autoComplete="off" />
                            </div>
                            <div className="ui-field">
                                <label className="ui-label" htmlFor="stu-last">Last name <span className="ui-req">*</span></label>
                                <input id="stu-last" className="ui-input" value={form.last_name} onChange={set('last_name')} maxLength={100} autoComplete="off" />
                            </div>
                            <div className="ui-field">
                                <label className="ui-label" htmlFor="stu-course">Course</label>
                                <select id="stu-course" className="ui-select" value={form.course} onChange={set('course')}>
                                    {courses.length === 0 && <option value="">Add a course in the Courses tab first</option>}
                                    {courses.map((c) => <option key={c.code} value={c.code}>{c.code} · {c.name}</option>)}
                                </select>
                            </div>
                            <div className="ui-field">
                                <label className="ui-label" htmlFor="stu-year">Year level</label>
                                <select id="stu-year" className="ui-select" value={form.year_level} onChange={set('year_level')}>
                                    {YEAR_LEVELS.map((n) => <option key={n} value={n}>{yearLabel(n)}</option>)}
                                </select>
                            </div>
                            <div className="ui-field">
                                <label className="ui-label" htmlFor="stu-gender">Gender</label>
                                <select id="stu-gender" className="ui-select" value={form.gender} onChange={set('gender')} aria-describedby="stu-gender-hint">
                                    <option value="">Not set</option>
                                    <option value="male">Male</option>
                                    <option value="female">Female</option>
                                </select>
                                <span className="ui-hint" id="stu-gender-hint">Picks the uniform on their figure in the 3D views.</span>
                            </div>
                            <div className="ui-field full">
                                <label className="ui-label" htmlFor="stu-pw">
                                    {editing ? 'New password' : <>Password <span className="ui-req">*</span></>}
                                </label>
                                <div className="stu-pw">
                                    <input
                                        id="stu-pw" className="ui-input" type={showPw ? 'text' : 'password'} value={form.password}
                                        onChange={set('password')} autoComplete="new-password" aria-describedby="stu-pw-hint"
                                        aria-invalid={form.password && form.password.length < 8 ? 'true' : undefined}
                                    />
                                    <button type="button" onClick={() => setShowPw((v) => !v)} aria-pressed={showPw}>{showPw ? 'Hide' : 'Show'}</button>
                                </div>
                                <span className="ui-hint" id="stu-pw-hint">
                                    {editing ? 'Leave blank to keep the current password. A new one signs the student out everywhere.' : 'At least 8 characters.'}
                                </span>
                            </div>
                            {editing && (
                                <div className="stu-reset">
                                    <p><b>Forgot their password?</b>Give {editing.first_name} a one-time password; they choose their own at the next sign-in.</p>
                                    <button type="button" className="ui-btn ui-btn-secondary" onClick={() => resetPassword(editing)} disabled={saving}>Reset password</button>
                                </div>
                            )}
                            <div className="stu-actions">
                                {editing && <button type="button" className="ui-btn ui-btn-secondary" onClick={reset} disabled={saving}>Cancel</button>}
                                <button type="submit" className="ui-btn ui-btn-primary" disabled={saving}>
                                    {saving && <span className="btn-spin" aria-hidden="true" />}
                                    {saving ? 'Saving' : editing ? 'Save changes' : 'Add student'}
                                </button>
                            </div>
                        </form>
                    </section>

                    {tempPw && (
                        <div className="cd-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setTempPw(null); }}>
                            <div className="cd-card" role="alertdialog" aria-modal="true" aria-labelledby="stu-temp-title" aria-describedby="stu-temp-msg"
                                onKeyDown={(e) => { if (e.key === 'Escape') setTempPw(null); }}>
                                <h2 className="cd-title" id="stu-temp-title">Temporary password for {tempPw.name}</h2>
                                <p className="cd-msg" id="stu-temp-msg">
                                    Give this to the student. They sign in with {tempPw.id} and this password, then choose their own.
                                    It is shown only once.
                                </p>
                                <div className="stu-temp">
                                    <code aria-label="Temporary password">{tempPw.password}</code>
                                </div>
                                <div className="cd-actions">
                                    <button type="button" className="ui-btn ui-btn-secondary" onClick={copyTemp} aria-live="polite">{copied ? 'Copied' : 'Copy'}</button>
                                    <button type="button" className="ui-btn ui-btn-primary" autoFocus onClick={() => setTempPw(null)}>Done</button>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* ── List ── */}
                    <section className="ui-card rise" style={{ '--i': 2 }} aria-labelledby="stu-list-title">
                        <div className="stu-head">
                            <h2 className="ui-card-title" id="stu-list-title">
                                All students <span className="ui-hint ui-num stu-count">{list.length}</span>
                            </h2>
                        </div>
                        <div className="stu-tools">
                            <div className="ui-field">
                                <label className="ui-label" htmlFor="stu-search">Find a student</label>
                                <input id="stu-search" className="ui-input" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Name, school ID or year" />
                            </div>
                            <div className="stu-chips" role="group" aria-label="Filter by course">
                                {[{ code: 'all', label: 'All' }, ...courses.map((c) => ({ code: c.code, label: c.code }))].map((c) => (
                                    <button
                                        key={c.code} type="button" className="stu-chip" aria-pressed={course === c.code}
                                        onClick={() => setCourse(c.code)}
                                        title={courses.find((x) => x.code === c.code)?.name}
                                    >
                                        {c.label} <b>{counts[c.code] ?? 0}</b>
                                    </button>
                                ))}
                            </div>
                        </div>

                        {students === null ? (
                            <div className="ui-empty" role="status"><span className="btn-spin" aria-hidden="true" />Loading students</div>
                        ) : list.length === 0 ? (
                            <div className="ui-empty"><strong>No students yet.</strong>Add the first one with the form.</div>
                        ) : shown.length === 0 ? (
                            <div className="ui-empty"><strong>No student matches.</strong>Try another name or ID, or choose All courses.</div>
                        ) : (
                            <ScrollWindow
                                as="ul" className="stu-list" label="Students"
                                rows={8} phoneRows={5} rowHeight={64} phoneRowHeight={76}
                                count={shown.length} noun="more students"
                            >
                                {shown.map((s, i) => (
                                    <li key={s.id} className={`stu-row rise${editing?.id === s.id ? ' is-editing' : ''}`} style={{ '--i': Math.min(i, 8) }}>
                                        <span className="stu-avatar" aria-hidden="true">{initials(s)}</span>
                                        <div className="stu-text">
                                            <div className="stu-name">{s.last_name}, {s.first_name}</div>
                                            <div className="stu-sub" title={s.email}>{s.email}</div>
                                        </div>
                                        <div className="stu-meta">
                                            <span className="ui-badge" title={s.course_name || s.course}>{s.course}</span>
                                            <span className="stu-year">{yearLabel(s.year_level)}</span>
                                        </div>
                                        <div className="stu-row-actions">
                                            <button className="ui-btn ui-btn-secondary ui-btn-sm" onClick={() => startEdit(s)} aria-label={`Edit ${s.name}`}>Edit</button>
                                            <button className="ui-btn ui-btn-danger ui-btn-sm" onClick={() => remove(s)} aria-label={`Remove ${s.name}`}>Remove</button>
                                        </div>
                                    </li>
                                ))}
                            </ScrollWindow>
                        )}
                    </section>
                </div>
            </div>
        </div>
    );
}
