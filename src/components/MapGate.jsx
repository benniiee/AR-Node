import React, { useEffect, useState } from 'react';
import InstallApp from './InstallApp';
import BrandLogo from './BrandLogo';
import { C, TYPE, FONT_STACK, TAP, PILL, PANEL_RADIUS, ELEVATION, INTERACTION_CSS } from '../uiTokens';
import { savedSession, signInStudent, verifySession, continueAsVisitor, signOut, changeStudentPassword } from '../studentSession';

// ── /map entry: student sign-in, or continue as a visitor ───────────
// Students sign in with their school ID (or school email) and get the full
// campus directory and directions. Visitors skip sign-in and see building
// locations only; the server filters the data, this screen only chooses.
//
//   <MapGate>{({ session, signOut, signIn }) => <MobileNav … />}</MapGate>

// Demo sign-ins for presentations: the three sample students the
// StudentSeeder creates (keep in step with database/seeders/StudentSeeder.php).
// Shown in development, and in a production build only when it is built with
// VITE_DEMO_ACCOUNTS=true, so a real deployment never advertises passwords.
// (Plain import.meta.env.X, no "?.": Vite replaces it at build time, so in a
// normal production build SHOW_DEMO is a constant false and the accounts
// below are dropped from the bundle entirely.)
const SHOW_DEMO = import.meta.env.DEV || import.meta.env.VITE_DEMO_ACCOUNTS === 'true';
const DEMO_PASSWORD = SHOW_DEMO ? 'password' : '';
const DEMO_STUDENTS = !SHOW_DEMO ? [] : [
    { id: 'ae202401622', name: 'Kristine Mae Alvarez', course: 'BSIT', year: '2nd year' },
    { id: 'ae202502307', name: 'Rafael Jimenez', course: 'CSM', year: '1st year' },
    { id: 'ae202300418', name: 'Nur-aisa Hadjirul', course: 'BSN', year: '3rd year' },
];

const CSS = `
    .gate { min-height: 100dvh; display: flex; align-items: center; justify-content: center; padding: max(24px, env(safe-area-inset-top)) 16px max(24px, env(safe-area-inset-bottom));
        background: ${C.page}; color: ${C.text}; font-family: ${FONT_STACK}; -webkit-font-smoothing: antialiased; }
    .gate *, .gate *::before, .gate *::after { box-sizing: border-box; }
    .gate-box { width: 100%; max-width: 380px; animation: gateIn var(--dur-slow) var(--ease-out) both; }
    @keyframes gateIn { from { opacity: 0; transform: translateY(12px); } }
    .gate-mark { font-size: 26px; font-weight: 800; letter-spacing: -0.02em; color: ${C.white}; }
    .gate-mark b { color: ${C.brandAccent}; font-weight: 800; }
    .gate-title { margin: 22px 0 0; font-size: ${TYPE.title}; font-weight: 700; color: ${C.white}; line-height: 1.25; }
    .gate-sub { margin: 6px 0 0; font-size: ${TYPE.sub}; line-height: 1.5; color: ${C.muted}; }
    .gate-form { display: flex; flex-direction: column; gap: 14px; margin-top: 22px; }
    .gate-field { display: flex; flex-direction: column; gap: 6px; }
    .gate-label { font-size: ${TYPE.desc}; font-weight: 600; color: ${C.muted}; transition: color var(--dur-fast) ease; }
    .gate-field:focus-within .gate-label { color: ${C.white}; }
    .gate-input {
        width: 100%; min-height: 48px; padding: 0 14px; border-radius: 8px; font: inherit; font-size: 16px; color: ${C.white};
        background: ${C.field}; border: 1px solid ${C.fieldBorder}; color-scheme: dark;
        transition: border-color var(--dur-fast) ease, box-shadow var(--dur-base) var(--ease-out);
    }
    .gate-input::placeholder { color: ${C.placeholder}; }
    .gate-input:focus-visible { outline: none; border-color: ${C.focus}; box-shadow: 0 0 0 3px rgba(255,255,255,0.22); }
    .gate-input[aria-invalid="true"] { border-color: ${C.errorBorder}; }
    .gate-pw { position: relative; }
    .gate-pw .gate-input { padding-right: 68px; }
    .gate-pw button { position: absolute; right: 4px; top: 50%; transform: translateY(-50%); min-height: ${TAP.minHeight}; padding: 0 12px; border: 0; border-radius: ${PILL}px;
        background: transparent; color: ${C.muted}; font: inherit; font-size: ${TYPE.desc}; font-weight: 600; cursor: pointer; }
    .gate-pw button:hover { color: #fff; }
    .gate-pw button:focus-visible { outline: ${TAP.focusOutline}; outline-offset: 1px; }
    .gate-hint { font-size: ${TYPE.desc}; line-height: 1.4; color: ${C.muted}; }
    .gate-caps { font-size: ${TYPE.desc}; color: ${C.warning}; }
    .gate-error { padding: 10px 12px; border-radius: 8px; background: ${C.dangerBg}; color: ${C.danger}; border: 1px solid rgba(255,35,56,0.5);
        font-size: ${TYPE.sub}; line-height: 1.45; animation: gateIn var(--dur-base) var(--ease-out) both; }
    .gate-btn {
        display: inline-flex; align-items: center; justify-content: center; gap: 8px; width: 100%; min-height: 50px; padding: 0 20px;
        border-radius: ${PILL}px; border: 1px solid transparent; font: inherit; font-size: 15px; font-weight: 700; cursor: pointer;
        transition: background-color var(--dur-fast) ease, transform var(--dur-fast) var(--ease-out), opacity var(--dur-fast) ease;
        -webkit-tap-highlight-color: transparent; touch-action: manipulation;
    }
    .gate-btn:active:not(:disabled) { transform: scale(0.97); }
    .gate-btn:focus-visible { outline: ${TAP.focusOutline}; outline-offset: 2px; }
    .gate-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .gate-btn-primary { background: ${C.primary}; color: #fff; }
    .gate-btn-primary:hover:not(:disabled) { background: ${C.primaryHover}; }
    .gate-or { display: flex; align-items: center; gap: 12px; margin: 22px 0 14px; font-size: ${TYPE.desc}; color: ${C.muted}; }
    .gate-or::before, .gate-or::after { content: ''; flex: 1; height: 1px; background: ${C.hairline}; }
    .gate-guest {
        display: flex; flex-direction: column; align-items: center; gap: 2px; width: 100%; min-height: 56px; padding: 8px 20px;
        border-radius: ${PANEL_RADIUS}px; border: 1px solid ${C.border}; background: ${C.surface}; color: ${C.white};
        font: inherit; cursor: pointer; box-shadow: ${ELEVATION.raised};
        transition: background-color var(--dur-fast) ease, border-color var(--dur-fast) ease, transform var(--dur-fast) var(--ease-out);
        -webkit-tap-highlight-color: transparent;
    }
    .gate-guest:hover { background: ${C.surfaceHover}; border-color: rgba(255,255,255,0.22); }
    .gate-guest:active { transform: scale(0.98); }
    .gate-guest:focus-visible { outline: ${TAP.focusOutline}; outline-offset: 2px; }
    .gate-guest b { font-size: 15px; font-weight: 700; }
    .gate-guest span { font-size: ${TYPE.desc}; color: ${C.muted}; }
    .gate-install { margin-top: 10px; }
    .gate-install-hint { margin: 8px 2px 0; font-size: ${TYPE.desc}; line-height: 1.5; color: ${C.text}; }
    /* Demo accounts: one tap fills the form (the person still taps Sign in). */
    .gate-demo { margin-top: 22px; padding-top: 16px; border-top: 1px solid ${C.hairline}; }
    .gate-demo-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
    .gate-demo-title { margin: 0; font-size: ${TYPE.desc}; font-weight: 700; color: ${C.text}; }
    .gate-demo-note { font-size: ${TYPE.desc}; color: ${C.muted}; }
    .gate-demo-list { display: grid; gap: 8px; margin-top: 10px; }
    .gate-demo-btn {
        display: flex; align-items: center; gap: 12px; width: 100%; min-height: 52px; padding: 8px 16px; text-align: left;
        border-radius: ${PILL}px; border: 1px solid ${C.border}; background: transparent; color: ${C.white}; font: inherit; cursor: pointer;
        transition: background-color var(--dur-fast) ease, border-color var(--dur-fast) ease, transform var(--dur-fast) var(--ease-out);
        animation: gateIn var(--dur-base) var(--ease-out) both;
        -webkit-tap-highlight-color: transparent;
    }
    .gate-demo-btn:nth-child(2) { animation-delay: 40ms; } .gate-demo-btn:nth-child(3) { animation-delay: 80ms; }
    .gate-demo-btn:hover { background: rgba(255,255,255,0.05); border-color: rgba(255,255,255,0.22); }
    .gate-demo-btn:active { transform: scale(0.98); }
    .gate-demo-btn:focus-visible { outline: ${TAP.focusOutline}; outline-offset: 2px; }
    .gate-demo-btn[aria-pressed="true"] { border-color: rgba(74, 222, 128, 0.55); background: rgba(74, 222, 128, 0.08); }
    .gate-demo-course { flex: none; min-width: 48px; padding: 3px 10px; border-radius: ${PILL}px; text-align: center;
        background: rgba(255,255,255,0.08); font-size: ${TYPE.desc}; font-weight: 700; color: ${C.text}; }
    .gate-demo-who { min-width: 0; display: flex; flex-direction: column; }
    .gate-demo-who b { font-size: ${TYPE.sub}; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .gate-demo-who span { font-size: ${TYPE.desc}; color: ${C.muted}; font-variant-numeric: tabular-nums; }
    .gate-spin { width: 16px; height: 16px; border-radius: 50%; border: 2px solid rgba(255,255,255,0.35); border-top-color: #fff; animation: gateSpin 0.7s linear infinite; }
    @keyframes gateSpin { to { transform: rotate(360deg); } }
    .gate-loading { display: flex; flex-direction: column; align-items: center; gap: 14px; color: ${C.muted}; font-size: ${TYPE.sub}; }
    @media (prefers-reduced-motion: reduce) { .gate-box, .gate-error { animation: none; } }
`;

function SignInScreen({ onSession, notice }) {
    const [login, setLogin] = useState('');
    const [password, setPassword] = useState('');
    const [showPw, setShowPw] = useState(false);
    const [capsOn, setCapsOn] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(notice || null);
    const [demoPicked, setDemoPicked] = useState(null);
    const submitRef = React.useRef(null);
    const fillDemo = (d) => {
        setLogin(d.id);
        setPassword(DEMO_PASSWORD);
        setDemoPicked(d.id);
        setError(null);
        // Ready to go: focus lands on Sign in.
        setTimeout(() => submitRef.current?.focus(), 0);
    };
    const ready = login.trim() !== '' && password !== '';
    // Red on the field that is missing; a refused sign-in (both filled) marks both.
    const loginInvalid = error && (login.trim() === '' || password !== '') ? 'true' : undefined;
    const pwInvalid = error && login.trim() !== '' ? 'true' : undefined;
    const caps = (e) => setCapsOn(Boolean(e.getModifierState?.('CapsLock')));

    const submit = async (e) => {
        e.preventDefault();
        if (busy) return;
        if (!ready) {
            setError(login.trim() === '' ? 'Enter your school ID or email.' : 'Enter your password.');
            document.getElementById(login.trim() === '' ? 'gate-login' : 'gate-pw')?.focus();
            return;
        }
        setBusy(true);
        setError(null);
        try {
            // The typed password goes along: after an admin reset it is the temporary
            // one, so the "choose a new password" step does not ask for it again.
            onSession(await signInStudent(login.trim(), password), password);
        } catch (err) {
            setError(err.message);
            setBusy(false);
        }
    };

    return (
        <main className="gate">
            <div className="gate-box">
                <div className="gate-mark brand-lockup"><BrandLogo /><span>AR<b>Node</b></span></div>
                <h1 className="gate-title">Find your way on campus</h1>
                <p className="gate-sub">Sign in with your student account to search rooms and get directions.</p>

                <form className="gate-form" onSubmit={submit} noValidate>
                    {error && <div className="gate-error" role="alert">{error}</div>}
                    <div className="gate-field">
                        <label className="gate-label" htmlFor="gate-login">School ID or email</label>
                        <input
                            id="gate-login" className="gate-input" value={login} onChange={(e) => { setLogin(e.target.value); setDemoPicked(null); }}
                            placeholder="ae202401622" autoComplete="username" autoCapitalize="none" spellCheck={false}
                            aria-invalid={loginInvalid} autoFocus
                        />
                    </div>
                    <div className="gate-field">
                        <label className="gate-label" htmlFor="gate-pw">Password</label>
                        <div className="gate-pw">
                            <input
                                id="gate-pw" className="gate-input" type={showPw ? 'text' : 'password'} value={password}
                                onChange={(e) => setPassword(e.target.value)} onKeyDown={caps} onKeyUp={caps} onBlur={() => setCapsOn(false)}
                                autoComplete="current-password" aria-invalid={pwInvalid}
                                aria-describedby={capsOn ? 'gate-caps' : undefined}
                            />
                            <button type="button" onClick={() => setShowPw((v) => !v)} aria-pressed={showPw}>{showPw ? 'Hide' : 'Show'}</button>
                        </div>
                        {capsOn && <span className="gate-caps" id="gate-caps" role="status">Caps Lock is on.</span>}
                    </div>
                    <button ref={submitRef} type="submit" className="gate-btn gate-btn-primary" disabled={busy} aria-busy={busy}>
                        {busy && <span className="gate-spin" aria-hidden="true" />}
                        {busy ? 'Signing in' : 'Sign in'}
                    </button>
                    <span className="gate-hint">Forgot your password? The campus admin office can give you a temporary one.</span>
                </form>

                {SHOW_DEMO && (
                    <section className="gate-demo" aria-labelledby="gate-demo-title">
                        <div className="gate-demo-head">
                            <h2 className="gate-demo-title" id="gate-demo-title">Demo accounts</h2>
                            <span className="gate-demo-note">Tap to fill, then Sign in</span>
                        </div>
                        <div className="gate-demo-list">
                            {DEMO_STUDENTS.map((d) => (
                                <button
                                    key={d.id} type="button" className="gate-demo-btn"
                                    aria-pressed={demoPicked === d.id} onClick={() => fillDemo(d)}
                                    aria-label={`Fill in ${d.name}, ${d.course} ${d.year}`}
                                >
                                    <span className="gate-demo-course">{d.course}</span>
                                    <span className="gate-demo-who">
                                        <b>{d.name}</b>
                                        <span>{d.id}, {d.year}</span>
                                    </span>
                                </button>
                            ))}
                        </div>
                    </section>
                )}

                <div className="gate-or" aria-hidden="true">or</div>
                <button type="button" className="gate-guest" onClick={() => onSession(continueAsVisitor())}>
                    <b>View as visitor (guest)</b>
                    <span>See where the campus buildings are, no sign-in</span>
                </button>
                <InstallApp buttonClass="gate-guest gate-install" hintClass="gate-install-hint">
                    {(label) => (<><b>{label}</b><span>Open it from your home screen, even offline</span></>)}
                </InstallApp>
            </div>
        </main>
    );
}

/**
 * After an admin reset the student signs in with a temporary password and must
 * choose their own before the map opens. `knownCurrent` is the password just
 * typed at sign-in (null when the app reopened mid-way: then it is asked for).
 */
function NewPasswordScreen({ session, knownCurrent, onDone, onSignOut }) {
    const [current, setCurrent] = useState(knownCurrent || '');
    const [password, setPassword] = useState('');
    const [confirm, setConfirm] = useState('');
    const [showPw, setShowPw] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const tooShort = password !== '' && password.length < 8;
    const mismatch = confirm !== '' && confirm !== password;
    const ready = current !== '' && password.length >= 8 && confirm === password;

    const submit = async (e) => {
        e.preventDefault();
        if (busy) return;
        if (!ready) {
            const [message, field] = current === '' ? ['Enter the temporary password from the admin office.', 'np-current']
                : password.length < 8 ? ['Your new password needs at least 8 characters.', 'np-new']
                    : ['Type the same new password twice.', 'np-confirm'];
            setError(message);
            document.getElementById(field)?.focus();
            return;
        }
        setBusy(true);
        setError(null);
        try {
            onDone(await changeStudentPassword(session, current, password, confirm));
        } catch (err) {
            setError(err.message);
            setBusy(false);
        }
    };

    return (
        <main className="gate">
            <div className="gate-box">
                <div className="gate-mark brand-lockup"><BrandLogo /><span>AR<b>Node</b></span></div>
                <h1 className="gate-title">Choose a new password</h1>
                <p className="gate-sub">
                    {session.user?.first_name ? `${session.user.first_name}, you` : 'You'} signed in with a temporary password from the admin office.
                    Choose your own to continue.
                </p>
                <form className="gate-form" onSubmit={submit} noValidate>
                    {error && <div className="gate-error" role="alert">{error}</div>}
                    {!knownCurrent && (
                        <div className="gate-field">
                            <label className="gate-label" htmlFor="np-current">Temporary password</label>
                            <input id="np-current" className="gate-input" type="password" value={current}
                                onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" autoFocus />
                        </div>
                    )}
                    <div className="gate-field">
                        <label className="gate-label" htmlFor="np-new">New password</label>
                        <div className="gate-pw">
                            <input id="np-new" className="gate-input" type={showPw ? 'text' : 'password'} value={password}
                                onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" autoFocus={Boolean(knownCurrent)}
                                aria-invalid={tooShort ? 'true' : undefined} aria-describedby="np-new-hint" />
                            <button type="button" onClick={() => setShowPw((v) => !v)} aria-pressed={showPw}>{showPw ? 'Hide' : 'Show'}</button>
                        </div>
                        <span className={tooShort ? 'gate-caps' : 'gate-hint'} id="np-new-hint">At least 8 characters.</span>
                    </div>
                    <div className="gate-field">
                        <label className="gate-label" htmlFor="np-confirm">Type it again</label>
                        <input id="np-confirm" className="gate-input" type={showPw ? 'text' : 'password'} value={confirm}
                            onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password"
                            aria-invalid={mismatch ? 'true' : undefined} aria-describedby={mismatch ? 'np-mismatch' : undefined} />
                        {mismatch && <span className="gate-caps" id="np-mismatch" role="status">The two passwords are not the same.</span>}
                    </div>
                    <button type="submit" className="gate-btn gate-btn-primary" disabled={busy} aria-busy={busy}>
                        {busy && <span className="gate-spin" aria-hidden="true" />}
                        {busy ? 'Saving' : 'Save and open the map'}
                    </button>
                </form>
                <button type="button" className="gate-guest" onClick={onSignOut}>
                    <b>Sign out</b>
                    <span>Not you? Sign out and use another account</span>
                </button>
            </div>
        </main>
    );
}

export default function MapGate({ children }) {
    const [session, setSession] = useState(() => savedSession());
    // A saved token is checked once; until then the map waits (no flash of
    // the visitor view for a signed-in student).
    const [checking, setChecking] = useState(() => savedSession()?.role === 'student');
    const [notice, setNotice] = useState(null);
    // The password typed at sign-in, kept in memory only for the new-password step.
    const [typedPassword, setTypedPassword] = useState(null);

    useEffect(() => {
        if (!checking || !session?.token) return;
        let alive = true;
        verifySession(session)
            .then((fresh) => { if (alive) { setSession(fresh); setChecking(false); } })
            .catch(() => {
                if (!alive) return;
                setSession(null);
                setNotice('Your session ended. Sign in again to continue.');
                setChecking(false);
            });
        return () => { alive = false; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const doSignOut = async () => {
        await signOut(session);
        setNotice(null);
        setSession(null);
    };

    if (checking) {
        return (
            <div className="gate"><style>{INTERACTION_CSS + CSS}</style>
                <div className="gate-loading" role="status"><span className="gate-spin" aria-hidden="true" />Signing you in</div>
            </div>
        );
    }
    if (!session) {
        return (<><style>{INTERACTION_CSS + CSS}</style><SignInScreen onSession={(s, typed) => { setNotice(null); setTypedPassword(typed || null); setSession(s); }} notice={notice} /></>);
    }
    if (session.role === 'student' && session.user?.must_change_password) {
        return (
            <><style>{INTERACTION_CSS + CSS}</style>
                <NewPasswordScreen
                    session={session} knownCurrent={typedPassword}
                    onDone={(s) => { setTypedPassword(null); setSession(s); }}
                    onSignOut={() => { setTypedPassword(null); doSignOut(); }}
                />
            </>
        );
    }
    // key: a different person (or visitor vs student) gets a fresh map screen.
    return <React.Fragment key={session.role + (session.user?.id ?? '')}>{children({ session, signOut: doSignOut, signIn: () => setSession(null) })}</React.Fragment>;
}
