import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { C, TYPE, TAP } from '../uiTokens';
import { Collapse } from '../motion';
import { confirmAction } from './ConfirmDialog';
import ScrollWindow from './ScrollWindow';

const FALLBACK_COLOR = '#22c55e';
const isHex = (v) => /^#[0-9a-fA-F]{6}$/.test(v || '');
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
// Rows shown before a list scrolls inside its card (ScrollWindow).
const LIST_ROWS = { desktop: 8, phone: 5 };

const DEPT_CSS = `
    .dept-page {
        animation: fadeIn 0.5s var(--ease-out) both;
        position: absolute; inset: 0; min-height: 0; overflow-y: auto;
        -webkit-overflow-scrolling: touch; background: ${C.page};
        padding: clamp(20px, 2.5vw, 30px) clamp(16px, 2.25vw, 26px) 44px;
    }
    .dept-inner { width: 100%; max-width: 1120px; min-width: 0; margin: 0 auto; display: flex; flex-direction: column; gap: 22px; }
    .dept-inner > header { min-width: 0; }
    .dept-cols { display: grid; grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.1fr); gap: 18px; align-items: start; }
    .dept-cols > .ui-card { min-width: 0; }

    .dept-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; min-height: 36px; margin-bottom: 12px; }
    .dept-head .ui-card-title { display: flex; align-items: center; gap: 8px; min-width: 0; margin: 0; }

    .dept-add { display: flex; align-items: flex-end; gap: 10px; padding-bottom: 16px; border-bottom: 1px solid ${C.hairline}; }
    .dept-add .ui-field { flex: 1; min-width: 0; }
    .dept-add .ui-btn { flex: none; }

    /* A fixed row rhythm makes the ten-row window predictable. Longer lists
       scroll within their card; the page and card heading remain independent. */
    .dept-list {
        list-style: none; margin: 8px -4px 0; padding: 0 4px;
        scroll-padding-block: 8px; border-radius: 10px;
    }
    .dept-row {
        display: flex; align-items: center; gap: 12px; height: 58px; min-height: 58px;
        padding: 0 8px; margin: 0; border-top: 1px solid ${C.hairline}; border-radius: 10px;
        transition: background-color 0.2s var(--ease-out);
    }
    .dept-row:hover, .acct-row:hover { background: rgba(255, 255, 255, 0.04); }
    .dept-list > .dept-row:first-child, .acct-list > .acct-row:first-child { border-top-color: transparent; }
    @media (hover: hover) {
        .dept-row .ui-btn { opacity: 0.72; transition-property: opacity, background-color, border-color, transform; }
        .dept-row:hover .ui-btn, .dept-row:focus-within .ui-btn { opacity: 1; }
    }
    .swatch { transition: transform 0.25s var(--ease-spring); }
    .swatch:hover { transform: scale(1.08); }
    .dept-count { display: inline-flex; align-items: center; justify-content: center; min-width: 26px; padding: 2px 8px; border-radius: 6px; background: rgba(255,255,255,0.07); text-align: center; }
    .dept-row-text { flex: 1; min-width: 0; }
    .dept-name { min-width: 0; font-size: ${TYPE.sub}; font-weight: 600; color: ${C.white}; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dept-sub { min-width: 0; font-size: ${TYPE.desc}; color: ${C.muted}; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    /* The swatch itself is the colour control. */
    .swatch {
        -webkit-appearance: none; appearance: none; flex: none;
        width: 28px; height: 28px; padding: 0; border-radius: 50%; cursor: pointer;
        border: 2px solid rgba(255, 255, 255, 0.85); background: none;
    }
    .swatch::-webkit-color-swatch-wrapper { padding: 0; }
    .swatch::-webkit-color-swatch { border: 0; border-radius: 50%; }
    .swatch::-moz-color-swatch { border: 0; border-radius: 50%; }
    .swatch:focus-visible { outline: 2px solid ${C.focus}; outline-offset: 2px; }
    .swatch-lg { width: 40px; height: 40px; border-radius: 10px; }
    .swatch-lg::-webkit-color-swatch { border-radius: 6px; }
    .swatch-lg::-moz-color-swatch { border-radius: 6px; }

    .acct-list {
        margin: 8px -4px 0; padding: 0 4px;
        scroll-padding-block: 8px; border-radius: 10px;
    }
    .acct-row {
        display: grid; grid-template-columns: minmax(0, 1fr) 104px minmax(132px, 0.85fr) auto;
        grid-template-areas: "text role dept remove";
        align-items: center; gap: 8px; height: 66px; min-height: 66px;
        padding: 8px 6px; margin: 0; border-top: 1px solid ${C.hairline}; border-radius: 10px;
        transition: background-color 0.2s var(--ease-out);
    }
    .acct-text { grid-area: text; min-width: 0; }
    .acct-row > .ui-select:first-of-type { grid-area: role; }
    .acct-dept { grid-area: dept; }
    .acct-remove { grid-area: remove; }
    .acct-you { display: inline-block; margin-left: 8px; padding: 1px 8px; border-radius: 6px; vertical-align: 1px;
        background: rgba(74, 222, 128, 0.12); border: 1px solid rgba(74, 222, 128, 0.35); color: ${C.accent};
        font-size: ${TYPE.desc}; font-weight: 700; }
    .acct-admins { margin-left: 2px; color: ${C.muted}; font-weight: 600; }
    .acct-search { margin: 4px 0 4px; }
    .acct-row .ui-select {
        width: 100%; min-width: 0; height: 40px; min-height: 40px;
        padding: 8px 9px; font-size: ${TYPE.desc};
    }

    .acct-form { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 14px; margin-top: 16px; padding-top: 16px; border-top: 1px solid ${C.hairline}; }
    .acct-form-actions { grid-column: 1 / -1; display: flex; gap: 10px; justify-content: flex-end; }
    .list-scroll-hint { margin: 8px 0 2px; color: ${C.muted}; font-size: ${TYPE.desc}; line-height: 1.45; }
    .dept-empty {
        margin: 12px 0 0; padding: 22px 14px; border: 1px dashed ${C.hairline};
        border-radius: 10px; background: rgba(255,255,255,0.02); text-align: center;
        font-size: ${TYPE.sub}; line-height: 1.5; color: ${C.muted};
    }

    @media (max-width: 1080px) {
        .dept-cols { grid-template-columns: minmax(0, 1fr); }
        .dept-page { padding-left: 20px; padding-right: 20px; }
    }
    /* Touch screens of any width (tablets, landscape phones): 44 px targets. */
    @media (pointer: coarse) {
        .acct-row .ui-select { height: ${TAP.minHeight}; min-height: ${TAP.minHeight}; }
        .swatch, .swatch-lg { width: ${TAP.minHeight}; height: ${TAP.minHeight}; }
    }
    @media (max-width: 760px) {
        .dept-page { padding: 18px 12px max(32px, env(safe-area-inset-bottom)); }
        .dept-inner { gap: 18px; }
        .dept-cols { gap: 14px; }
        .ui-card { padding: 16px; }
        .swatch, .swatch-lg { width: 44px; height: 44px; }
        .dept-head { align-items: center; }
        .dept-add { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; }
        .dept-add .ui-field:first-child { grid-column: 1 / -1; }
        .dept-add .ui-field { min-width: 0; }
        .dept-add .ui-btn { min-height: 44px; }
        .acct-row {
            grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
            grid-template-areas: "text text remove" "role dept dept";
            height: auto; min-height: 108px; padding: 10px 4px; gap: 8px;
        }
        .acct-row .ui-select { min-height: 44px; height: 44px; padding: 8px; font-size: ${TYPE.desc}; }
        .acct-form { grid-template-columns: minmax(0, 1fr); gap: 12px; }
        .acct-form-actions { flex-direction: column-reverse; }
        .acct-form-actions .ui-btn { width: 100%; }
        .list-scroll-hint { margin-top: 6px; }
    }
`;

export default function AdminDepartments({ departments, users, currentUser, onChanged, notify, fail }) {
    const [deptName, setDeptName] = useState('');
    const [deptColor, setDeptColor] = useState(FALLBACK_COLOR);
    const [savingDept, setSavingDept] = useState(false);
    const [showUserForm, setShowUserForm] = useState(false);
    const [userName, setUserName] = useState('');
    const [userEmail, setUserEmail] = useState('');
    const [userPassword, setUserPassword] = useState('');
    const [userDept, setUserDept] = useState('');
    // Several admins can share the map work; new accounts default to faculty.
    const [userRole, setUserRole] = useState('faculty');
    const adminCount = users.filter((u) => u.role === 'admin').length;
    // Filter accounts by name, email, role or department.
    const [accountQuery, setAccountQuery] = useState('');
    const shownUsers = users.filter((u) => {
        const words = accountQuery.trim().toLowerCase().split(/\s+/).filter(Boolean);
        const hay = `${u.name} ${u.email} ${u.role} ${u.department?.name || ''}`.toLowerCase();
        return words.every((w) => hay.includes(w));
    });
    const [savingUser, setSavingUser] = useState(false);
    // Colour pickers fire on every drag step; commit once the hand stops.
    const recolorTimers = useRef({});
    const nameRef = useRef(null);
    useEffect(() => {
        if (!showUserForm) return undefined;
        const t = setTimeout(() => nameRef.current && nameRef.current.focus(), 220);
        return () => clearTimeout(t);
    }, [showUserForm]);

    const refresh = async () => { await onChanged(); };

    // Caught before the request (error prevention): the server would refuse it.
    const deptNameTaken = departments.some((d) => d.name.trim().toLowerCase() === deptName.trim().toLowerCase());

    const createDepartment = async (e) => {
        e?.preventDefault();
        if (!deptName.trim()) { fail('Department name is required'); return; }
        if (deptNameTaken) { fail(`${deptName.trim()} already exists`); return; }
        setSavingDept(true);
        try {
            await api.createDepartment({ name: deptName.trim(), color: deptColor });
            setDeptName('');
            await refresh();
            notify('Department added');
        } catch (err) { fail(err.message); } finally { setSavingDept(false); }
    };

    const recolorDepartment = (id, color) => {
        clearTimeout(recolorTimers.current[id]);
        recolorTimers.current[id] = setTimeout(async () => {
            try {
                await api.updateDepartment(id, { color });
                await refresh();
                notify('Colour updated');
            } catch (err) { fail(err.message); }
        }, 450);
    };

    const deleteDepartment = async (d) => {
        if (!(await confirmAction({
            title: `Remove ${d.name}?`,
            message: `${d.nodes_count ? `Its ${d.nodes_count} node(s)` : 'Its nodes'} stay on the map as "Unassigned", and its faculty lose their department.`,
            confirmLabel: 'Remove department', tone: 'danger',
        }))) return;
        try {
            await api.deleteDepartment(d.id);
            await refresh();
            notify('Department removed');
        } catch (err) { fail(err.message); }
    };

    const userFormValid = userName.trim() && userEmail.trim() && userPassword.length >= 8;

    const createUser = async (e) => {
        e?.preventDefault();
        if (!userFormValid) {
            fail('Enter a name, an email and a password of at least 8 characters');
            return;
        }
        setSavingUser(true);
        try {
            await api.createUser({
                name: userName.trim(),
                email: userEmail.trim(),
                password: userPassword,
                role: userRole,
                department_id: userDept === '' ? null : Number(userDept),
            });
            setUserName(''); setUserEmail(''); setUserPassword(''); setUserDept(''); setUserRole('faculty');
            setShowUserForm(false);
            await refresh();
            notify(userRole === 'admin' ? 'Admin account added' : 'Faculty account added');
        } catch (err) { fail(err.message); } finally { setSavingUser(false); }
    };

    const removeUser = async (u) => {
        if (!(await confirmAction({
            title: `Remove ${u.name}'s account?`,
            message: 'They are signed out everywhere. The nodes they placed stay on the map.',
            confirmLabel: 'Remove account', tone: 'danger',
        }))) return;
        try {
            await api.deleteUser(u.id);
            await refresh();
            notify('Account removed');
        } catch (err) { fail(err.message); }
    };

    const updateUser = async (id, patch, doneMsg) => {
        try {
            await api.updateUser(id, patch);
            await refresh();
            notify(doneMsg);
        } catch (err) { fail(err.message); }
    };

    return (
        <div className="dept-page">
            <style>{DEPT_CSS}</style>
            <div className="dept-inner">
                <header className="rise" style={{ '--i': 0 }}>
                    <h1 className="ui-h1">Departments &amp; accounts</h1>
                    <p className="ui-sub">
                        Department colours label the map; a faculty account's nodes are filed under its department. Each department's courses (Courses tab) decide which students its staff see in the Activity log.
                    </p>
                </header>

                <div className="dept-cols">
                    {/* ── Departments ── */}
                    <section className="ui-card rise" style={{ '--i': 1 }} aria-labelledby="dept-title">
                        <div className="dept-head">
                            <h2 className="ui-card-title" id="dept-title">
                                Departments <span className="ui-hint ui-num dept-count">{departments.length}</span>
                            </h2>
                        </div>

                        <form className="dept-add" onSubmit={createDepartment}>
                            <div className="ui-field">
                                <label className="ui-label" htmlFor="dept-name">Name</label>
                                <input
                                    id="dept-name"
                                    className="ui-input"
                                    value={deptName}
                                    onChange={(e) => setDeptName(e.target.value)}
                                    placeholder="e.g. Engineering"
                                    aria-invalid={deptNameTaken ? 'true' : undefined}
                                    aria-describedby={deptNameTaken ? 'dept-name-error' : undefined}
                                />
                                {deptNameTaken && <span className="ui-field-error" id="dept-name-error">That department already exists.</span>}
                            </div>
                            <div className="ui-field">
                                <label className="ui-label" htmlFor="dept-color">Colour</label>
                                <input
                                    id="dept-color"
                                    type="color"
                                    className="swatch swatch-lg"
                                    value={deptColor}
                                    onChange={(e) => setDeptColor(e.target.value)}
                                />
                            </div>
                            <button type="submit" className="ui-btn ui-btn-primary" disabled={savingDept}>
                                {savingDept && <span className="btn-spin" aria-hidden="true" />}
                                {savingDept ? 'Adding' : 'Add department'}
                            </button>
                        </form>

                        {departments.length === 0 ? (
                            <p className="dept-empty">No departments yet. Add the first one above.</p>
                        ) : (
                            <>
                            <ScrollWindow
                                as="ul" className="dept-list" label="Departments list"
                                rows={LIST_ROWS.desktop} phoneRows={LIST_ROWS.phone} rowHeight={58}
                                count={departments.length} noun="more departments"
                            >
                                {departments.map((d, i) => (
                                    <li key={d.id} className="dept-row rise" style={{ '--i': Math.min(i, 8) }}>
                                        <input
                                            type="color"
                                            className="swatch"
                                            aria-label={`Colour for ${d.name}`}
                                            title="Change colour"
                                            defaultValue={isHex(d.color) ? d.color : FALLBACK_COLOR}
                                            onChange={(e) => recolorDepartment(d.id, e.target.value)}
                                        />
                                        <div className="dept-row-text">
                                            <div className="dept-name">{d.name}</div>
                                            <div className="dept-sub ui-num">{plural(d.nodes_count ?? 0, 'node', 'nodes')} · {plural(d.courses_count ?? 0, 'course', 'courses')}</div>
                                        </div>
                                        <button className="ui-btn ui-btn-danger ui-btn-sm" onClick={() => deleteDepartment(d)}>
                                            Remove
                                        </button>
                                    </li>
                                ))}
                            </ScrollWindow>
                            </>
                        )}
                    </section>

                    {/* ── Accounts ── */}
                    <section className="ui-card rise" style={{ '--i': 2 }} aria-labelledby="acct-title">
                        <div className="dept-head">
                            <h2 className="ui-card-title" id="acct-title">
                                Accounts <span className="ui-hint ui-num dept-count">{users.length}</span>
                                <span className="ui-hint ui-num acct-admins">{adminCount} {adminCount === 1 ? 'admin' : 'admins'}</span>
                            </h2>
                            <button
                                className="ui-btn ui-btn-secondary ui-btn-sm"
                                aria-expanded={showUserForm}
                                aria-controls="acct-form"
                                onClick={() => setShowUserForm((v) => !v)}
                            >
                                {showUserForm ? 'Close' : 'Add account'}
                            </button>
                        </div>

                        <Collapse open={showUserForm} id="acct-form">
                            <form className="acct-form" onSubmit={createUser} style={{ marginTop: 0, paddingTop: 0, borderTop: 0, marginBottom: 8 }}>
                                <div className="ui-field">
                                    <label className="ui-label" htmlFor="acct-name">Name</label>
                                    <input id="acct-name" className="ui-input" value={userName} onChange={(e) => setUserName(e.target.value)} placeholder="Jane Cruz" ref={nameRef} />
                                </div>
                                <div className="ui-field">
                                    <label className="ui-label" htmlFor="acct-email">Email</label>
                                    <input id="acct-email" className="ui-input" type="email" value={userEmail} onChange={(e) => setUserEmail(e.target.value)} placeholder="jane@campus.edu" autoComplete="off" />
                                </div>
                                <div className="ui-field">
                                    <label className="ui-label" htmlFor="acct-pass">Password</label>
                                    <input id="acct-pass" className="ui-input" type="password" value={userPassword} onChange={(e) => setUserPassword(e.target.value)} autoComplete="new-password" aria-describedby="acct-pass-hint" />
                                    <span className="ui-hint" id="acct-pass-hint">At least 8 characters</span>
                                </div>
                                <div className="ui-field">
                                    <label className="ui-label" htmlFor="acct-dept">Department</label>
                                    <select id="acct-dept" className="ui-select" value={userDept} onChange={(e) => setUserDept(e.target.value)}>
                                        <option value="">None</option>
                                        {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                                    </select>
                                </div>
                                <div className="ui-field">
                                    <label className="ui-label" htmlFor="acct-role">Role</label>
                                    <select id="acct-role" className="ui-select" value={userRole} onChange={(e) => setUserRole(e.target.value)} aria-describedby="acct-role-hint">
                                        <option value="faculty">Faculty</option>
                                        <option value="admin">Admin</option>
                                    </select>
                                    <span className="ui-hint" id="acct-role-hint">Admins manage departments, accounts, buildings and pathways</span>
                                </div>
                                <div className="acct-form-actions">
                                    <button type="button" className="ui-btn ui-btn-secondary" onClick={() => setShowUserForm(false)}>Cancel</button>
                                    <button type="submit" className="ui-btn ui-btn-primary" disabled={savingUser}>
                                        {savingUser && <span className="btn-spin" aria-hidden="true" />}
                                        {savingUser ? 'Adding' : (userRole === 'admin' ? 'Add admin' : 'Add faculty')}
                                    </button>
                                </div>
                            </form>
                        </Collapse>

                        {users.length > 4 && (
                            <div className="ui-field acct-search">
                                <label className="ui-label" htmlFor="acct-search">Find an account</label>
                                <input
                                    id="acct-search" className="ui-input" type="search" value={accountQuery}
                                    onChange={(e) => setAccountQuery(e.target.value)} placeholder="Name, email, role or department"
                                />
                            </div>
                        )}
                        {users.length === 0 ? (
                            <p className="dept-empty">No accounts yet.</p>
                        ) : shownUsers.length === 0 ? (
                            <p className="dept-empty">No account matches “{accountQuery}”.</p>
                        ) : (
                            <>
                            <ScrollWindow
                                className="acct-list" role="list" label="Accounts list"
                                rows={LIST_ROWS.desktop} phoneRows={LIST_ROWS.phone} rowHeight={66} phoneRowHeight={108}
                                count={shownUsers.length} noun="more accounts"
                            >
                                {shownUsers.map((u, i) => {
                                    const isSelf = currentUser && u.id === currentUser.id;
                                    const isLastAdmin = u.role === 'admin' && adminCount <= 1;
                                    const lockReason = isSelf ? 'You cannot change or remove your own account' : isLastAdmin ? 'At least one admin must remain' : undefined;
                                    return (
                                        <div key={u.id} className="acct-row rise" role="listitem" style={{ '--i': Math.min(i, 8) }}>
                                            <div className="acct-text">
                                                <div className="dept-name">
                                                    {u.name}
                                                    {isSelf && <span className="acct-you">You</span>}
                                                </div>
                                                <div className="dept-sub">{u.email}</div>
                                            </div>
                                            <select
                                                className="ui-select"
                                                aria-label={`Role for ${u.name}`}
                                                value={u.role}
                                                disabled={isSelf || isLastAdmin}
                                                title={lockReason}
                                                onChange={(e) => updateUser(u.id, { role: e.target.value }, 'Role updated')}
                                            >
                                                <option value="admin">Admin</option>
                                                <option value="faculty">Faculty</option>
                                            </select>
                                            <select
                                                className="ui-select acct-dept"
                                                aria-label={`Department for ${u.name}`}
                                                value={u.department ? u.department.id : ''}
                                                onChange={(e) => updateUser(u.id, { department_id: e.target.value === '' ? null : Number(e.target.value) }, 'Department updated')}
                                            >
                                                <option value="">No department</option>
                                                {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                                            </select>
                                            <button
                                                className="ui-btn ui-btn-danger ui-btn-sm acct-remove"
                                                disabled={isSelf || isLastAdmin}
                                                title={lockReason}
                                                aria-label={`Remove account of ${u.name}`}
                                                onClick={() => removeUser(u)}
                                            >
                                                Remove
                                            </button>
                                        </div>
                                    );
                                })}
                            </ScrollWindow>
                            </>
                        )}
                    </section>
                </div>
            </div>
        </div>
    );
}
