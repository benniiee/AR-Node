import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { C, TYPE } from '../uiTokens';
import { confirmAction } from './ConfirmDialog';

// Same rule as Course::CODE_PATTERN (stored upper case).
const CODE_PATTERN = /^[A-Z0-9-]{2,16}$/;
const EMPTY = { code: '', name: '', department_id: '' };

const CSS = `
    .crs-page {
        position: absolute; inset: 0; min-height: 0; overflow-y: auto; -webkit-overflow-scrolling: touch;
        background: ${C.page}; padding: clamp(20px, 2.5vw, 30px) clamp(16px, 2.25vw, 26px) 44px;
        animation: fadeIn var(--dur-slow) var(--ease-out) both;
    }
    .crs-inner { width: 100%; max-width: 1120px; margin: 0 auto; display: flex; flex-direction: column; gap: 18px; }
    .crs-cols { display: grid; grid-template-columns: minmax(0, 0.8fr) minmax(0, 1.2fr); gap: 18px; align-items: start; }
    .crs-cols > .ui-card { min-width: 0; }
    .crs-form { display: flex; flex-direction: column; gap: 14px; }
    .crs-actions { display: flex; gap: 10px; justify-content: flex-end; flex-wrap: wrap; }
    .crs-list { list-style: none; margin: 0; padding: 0; }
    .crs-row {
        display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 12px; align-items: center;
        padding: 10px 6px; border-top: 1px solid ${C.hairline}; border-radius: 10px;
    }
    .crs-list > .crs-row:first-child { border-top-color: transparent; }
    .crs-row.is-editing { background: rgba(255,255,255,0.07); }
    .crs-name { font-size: ${TYPE.sub}; font-weight: 600; color: #fff; overflow-wrap: anywhere; }
    .crs-name b { margin-right: 8px; }
    .crs-sub { margin-top: 2px; font-size: ${TYPE.desc}; color: ${C.muted}; overflow-wrap: anywhere; }
    .crs-row-actions { display: flex; gap: 6px; }
    .crs-empty { padding: 24px 8px; text-align: center; color: ${C.muted}; font-size: ${TYPE.sub}; line-height: 1.5; }
    @media (max-width: 860px) { .crs-cols { grid-template-columns: minmax(0, 1fr); } }
`;

/**
 * Student courses. Department staff add, rename and remove their own department's courses
 * (a new one is filed under their department); admins manage every course and pick its
 * department. A department's courses decide which students its staff see in the Activity log.
 */
export default function AdminCourses({ currentUser, departments, notify, fail }) {
    const isAdmin = currentUser?.role === 'admin';
    const [courses, setCourses] = useState(null); // null = loading
    const [form, setForm] = useState(EMPTY);
    const [editing, setEditing] = useState(null);
    const [saving, setSaving] = useState(false);

    const load = useCallback(async () => {
        try { setCourses(await api.getCourses()); } catch (err) { setCourses([]); fail(err.message); }
    }, [fail]);
    useEffect(() => { load(); }, [load]);

    const code = form.code.trim().toUpperCase();
    const codeTaken = (courses || []).some((c) => c.code === code && c.id !== editing?.id);
    const valid = CODE_PATTERN.test(code) && !codeTaken && form.name.trim();
    const noDepartment = !isAdmin && !currentUser?.department;
    // Office staff (registrar, cashier...): an office has no courses.
    const isOffice = !isAdmin && currentUser?.department?.kind === 'office';

    const reset = () => { setForm(EMPTY); setEditing(null); };
    const edit = (c) => { setEditing(c); setForm({ code: c.code, name: c.name, department_id: c.department_id ?? '' }); };

    const save = async (e) => {
        e.preventDefault();
        if (!valid) return;
        setSaving(true);
        const data = {
            code, name: form.name.trim(),
            ...(isAdmin ? { department_id: form.department_id === '' ? null : Number(form.department_id) } : {}),
        };
        try {
            if (editing) await api.updateCourse(editing.id, data); else await api.createCourse(data);
            notify(editing ? `${code} saved` : `${code} added`);
            reset();
            await load();
        } catch (err) { fail(err.message); } finally { setSaving(false); }
    };

    const remove = async (c) => {
        if (c.students_count > 0) {
            fail(`${c.students_count} ${c.students_count === 1 ? 'student is' : 'students are'} in ${c.code}. Move them to another course first.`);
            return;
        }
        if (!(await confirmAction({ title: `Remove ${c.code}?`, message: c.name, confirmLabel: 'Remove course', tone: 'danger' }))) return;
        try {
            await api.deleteCourse(c.id);
            notify(`${c.code} removed`);
            if (editing?.id === c.id) reset();
            await load();
        } catch (err) { fail(err.message); }
    };

    const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

    return (
        <div className="crs-page">
            <style>{CSS}</style>
            <div className="crs-inner">
                <header className="rise" style={{ '--i': 0 }}>
                    <h1 className="ui-h1">Courses</h1>
                    <p className="ui-sub">
                        {isAdmin
                            ? 'Student courses and the department each belongs to. A department\'s staff manage its courses and see those students in the Activity log.'
                            : `Your department's courses${currentUser?.department ? ` (${currentUser.department.name})` : ''}. You see their students in the Activity log.`}
                    </p>
                </header>
                <div className="crs-cols">
                    <section className="ui-card rise" style={{ '--i': 1 }} aria-labelledby="crs-form-title">
                        <h2 className="ui-card-title" id="crs-form-title" style={{ marginTop: 0 }}>{editing ? `Edit ${editing.code}` : 'Add a course'}</h2>
                        {noDepartment ? (
                            <p className="crs-empty">Ask an admin to assign you a department first.</p>
                        ) : isOffice ? (
                            <p className="crs-empty">{currentUser.department.name} is an office, so it has no courses. Courses belong to colleges.</p>
                        ) : (
                            <form className="crs-form" onSubmit={save}>
                                <div className="ui-field">
                                    <label className="ui-label" htmlFor="crs-code">Code</label>
                                    <input
                                        id="crs-code" className="ui-input" value={form.code} onChange={set('code')} placeholder="e.g. BSCS"
                                        autoCapitalize="characters" maxLength={16} aria-invalid={codeTaken ? 'true' : undefined}
                                        aria-describedby={codeTaken ? 'crs-code-error' : 'crs-code-hint'}
                                    />
                                    {codeTaken
                                        ? <span className="ui-field-error" id="crs-code-error">{code} already exists.</span>
                                        : <span className="ui-hint" id="crs-code-hint">2 to 16 letters, digits or dashes.</span>}
                                </div>
                                <div className="ui-field">
                                    <label className="ui-label" htmlFor="crs-name">Full name</label>
                                    <input id="crs-name" className="ui-input" value={form.name} onChange={set('name')} placeholder="e.g. Bachelor of Science in Computer Science" maxLength={255} />
                                </div>
                                {isAdmin && (
                                    <div className="ui-field">
                                        <label className="ui-label" htmlFor="crs-dept">Department</label>
                                        <select id="crs-dept" className="ui-select" value={form.department_id} onChange={set('department_id')}>
                                            <option value="">No department</option>
                                            {/* Courses belong to colleges: offices have none. */}
                                            {(departments || []).filter((d) => d.kind !== 'office').map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                                        </select>
                                    </div>
                                )}
                                <div className="crs-actions">
                                    {editing && <button type="button" className="ui-btn ui-btn-secondary" onClick={reset} disabled={saving}>Cancel</button>}
                                    <button type="submit" className="ui-btn ui-btn-primary" disabled={!valid || saving}>
                                        {saving && <span className="btn-spin" aria-hidden="true" />}
                                        {saving ? 'Saving' : editing ? 'Save course' : 'Add course'}
                                    </button>
                                </div>
                            </form>
                        )}
                    </section>
                    <section className="ui-card rise" style={{ '--i': 2 }} aria-labelledby="crs-list-title">
                        <h2 className="ui-card-title" id="crs-list-title" style={{ marginTop: 0 }}>
                            Courses <span className="ui-hint ui-num">{courses ? courses.length : ''}</span>
                        </h2>
                        {courses === null ? (
                            <p className="crs-empty" role="status">Loading courses</p>
                        ) : courses.length === 0 ? (
                            <p className="crs-empty">No courses yet. Add the first one.</p>
                        ) : (
                            <ul className="crs-list">
                                {courses.map((c) => (
                                    <li key={c.id} className={`crs-row${editing?.id === c.id ? ' is-editing' : ''}`}>
                                        <div>
                                            <div className="crs-name"><b>{c.code}</b>{c.name}</div>
                                            <div className="crs-sub">
                                                {c.students_count} {c.students_count === 1 ? 'student' : 'students'}
                                                {isAdmin && ` · ${c.department?.name || 'No department'}`}
                                            </div>
                                        </div>
                                        <div className="crs-row-actions">
                                            <button type="button" className="ui-btn ui-btn-secondary ui-btn-sm" onClick={() => edit(c)} aria-label={`Edit ${c.code}`}>Edit</button>
                                            <button type="button" className="ui-btn ui-btn-danger ui-btn-sm" onClick={() => remove(c)} aria-label={`Remove ${c.code}`}>Remove</button>
                                        </div>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </section>
                </div>
            </div>
        </div>
    );
}
