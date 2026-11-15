import React, { useRef, useState } from 'react';
import BrandLogo from './BrandLogo';
import { C, TYPE, FONT_STACK, PILL, TAP } from '../uiTokens';

// Demo sign-ins for presentations: the seeded admin (DatabaseSeeder) and the
// department staff from DemoStaffSeeder (keep in step with both). Shown in
// development, and in a production build only when it is built with
// VITE_DEMO_ACCOUNTS=true, so a real deployment never advertises passwords.
// (Plain import.meta.env.X, no "?.": Vite replaces it at build time, so in a
// normal production build SHOW_DEMO is a constant false and the accounts
// below are dropped from the bundle entirely.)
const SHOW_DEMO = import.meta.env.DEV || import.meta.env.VITE_DEMO_ACCOUNTS === 'true';
const DEMO_PASSWORD = SHOW_DEMO ? 'password' : '';
const DEMO_ACCOUNTS = !SHOW_DEMO ? [] : [
    { email: 'admin@campus.test', tag: 'Admin', name: 'Campus admin' },
    { email: 'ccs.staff@campus.test', tag: 'CCS', name: 'CCS department staff' },
    { email: 'csm.staff@campus.test', tag: 'CSM', name: 'CSM department staff' },
];

const LOGIN_CSS = `
    .login { display: flex; min-height: 100vh; min-height: 100dvh; background: ${C.page}; }

    /* The route motif is the page's one decorative idea: it is what the
       product draws, so the login screen says what the app is for. */
    .login-art {
        flex: 1.1; position: relative; display: none; overflow: hidden;
        padding: 40px; border-right: 1px solid ${C.hairline};
        background: ${C.bar};
    }
    .login-art svg { position: absolute; inset: 0; width: 100%; height: 100%; }
    .login-art-copy { position: relative; max-width: 30ch; }
    .login-art-logo { margin-bottom: 20px; }
    .login-mark { font-size: ${TYPE.title}; font-weight: 800; letter-spacing: -0.02em; color: ${C.white}; }
    .login-mark b { color: ${C.brandAccent}; font-weight: 800; }
    .login-art-copy p { margin: 12px 0 0; font-size: ${TYPE.lead}; line-height: 1.5; color: ${C.muted}; }

    .login-draw { stroke-dasharray: 1; stroke-dashoffset: 1; animation: draw 2.6s var(--ease-in-out) 0.3s forwards; }
    .login-node { transform-box: fill-box; transform-origin: center; animation: popIn 0.6s var(--ease-spring) both; animation-delay: calc(1s + var(--k, 0) * 0.55s); }
    .login-dest { transform-box: fill-box; transform-origin: center; animation: popIn 0.7s var(--ease-spring) 3.1s both; }
    /* Hidden until its delayed animation starts, otherwise the ring is visible from the first frame. */
    .login-beacon { opacity: 0; transform-box: fill-box; transform-origin: center; animation: ring 2.4s var(--ease-out) 3.6s 3; } /* a few pulses, then rest: no endless decorative motion */
    .login-art-copy { animation: rise 0.9s var(--ease-out) 0.2s both; }
    .login-form .ui-btn { margin-top: 4px; }

    .login-pane { flex: 1; display: flex; align-items: center; justify-content: center; padding: 24px 20px; }
    .login-box { width: 100%; max-width: 380px; }
    .login-box .login-mark { margin-bottom: 28px; }
    .login-form { display: flex; flex-direction: column; gap: 18px; margin-top: 24px; }
    .login-pw { position: relative; }
    .login-pw .ui-input { padding-right: 64px; }
    .login-toggle {
        position: absolute; right: 4px; top: 50%; transform: translateY(-50%);
        min-height: 44px; padding: 0 10px; border: 0; border-radius: 6px; background: transparent;
        color: ${C.muted}; font: inherit; font-size: ${TYPE.desc}; font-weight: 600; cursor: pointer;
    }
    .login-toggle:hover { color: ${C.white}; }
    .login-caps { color: ${C.warning}; animation: fadeIn var(--dur-fast, 160ms) ease both; }
    .login-toggle:focus-visible { outline: 2px solid ${C.focus}; outline-offset: 1px; }

    .login-demo { margin-top: 24px; padding-top: 16px; border-top: 1px solid ${C.hairline}; animation: rise 0.6s var(--ease-out) 0.35s both; }
    .login-demo-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
    .login-demo-title { margin: 0; font-size: ${TYPE.desc}; font-weight: 700; color: ${C.text}; }
    .login-demo-note { font-size: ${TYPE.desc}; color: ${C.muted}; }
    .login-demo-list { display: grid; gap: 8px; margin-top: 10px; }
    .login-demo-btn {
        display: flex; align-items: center; gap: 12px; width: 100%; min-height: 52px; padding: 8px 16px; text-align: left;
        border-radius: ${PILL}px; border: 1px solid ${C.border}; background: transparent; color: ${C.white}; font: inherit; cursor: pointer;
        transition: background-color var(--dur-fast, 160ms) ease, border-color var(--dur-fast, 160ms) ease, transform var(--dur-fast, 160ms) var(--ease-out);
        -webkit-tap-highlight-color: transparent;
    }
    .login-demo-btn:hover { background: rgba(255,255,255,0.05); border-color: rgba(255,255,255,0.22); }
    .login-demo-btn:active { transform: scale(${TAP.activeScale}); }
    .login-demo-btn:focus-visible { outline: ${TAP.focusOutline}; outline-offset: 2px; }
    .login-demo-btn[aria-pressed="true"] { border-color: rgba(74, 222, 128, 0.55); background: rgba(74, 222, 128, 0.08); }
    .login-demo-tag { flex: none; min-width: 60px; padding: 3px 10px; border-radius: ${PILL}px; text-align: center;
        background: rgba(255,255,255,0.08); font-size: ${TYPE.desc}; font-weight: 700; color: ${C.text}; }
    .login-demo-who { min-width: 0; display: flex; flex-direction: column; }
    .login-demo-who b { font-size: ${TYPE.sub}; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .login-demo-who span { font-size: ${TYPE.desc}; color: ${C.muted}; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    @media (prefers-reduced-motion: reduce) { .login-demo { animation: none; } .login-demo-btn:active { transform: none; } }

    @media (min-width: 900px) {
        .login-art { display: flex; align-items: flex-start; }
        .login-box .login-mark { display: none; }
    }
    .login-pane .ui-input { font-size: 16px; }
    @media (max-width: 480px) {
        .login-pane {
            padding: 20px 16px max(24px, env(safe-area-inset-bottom));
            padding-top: max(20px, env(safe-area-inset-top));
            align-items: flex-start; overflow-y: auto; -webkit-overflow-scrolling: touch;
        }
        .login-box { margin: auto 0; width: 100%; }
        .login-box .login-mark { margin-bottom: 20px; font-size: 26px; }
        .login-form { gap: 14px; }
        .login-form .ui-btn-block { min-height: 48px; font-size: 15px; }
    }
    @media (max-height: 540px) and (max-width: 899px) {
        .login-pane { align-items: flex-start; overflow-y: auto; -webkit-overflow-scrolling: touch; }
        .login-box { margin: auto 0; }
    }
`;

export default function LoginForm({ onLogin, error }) {
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [demoPicked, setDemoPicked] = useState(null);
    const submitRef = useRef(null);
    const fillDemo = (account) => {
        setEmail(account.email);
        setPassword(DEMO_PASSWORD);
        setDemoPicked(account.email);
        // Ready to go: focus lands on Sign in.
        setTimeout(() => submitRef.current?.focus(), 0);
    };
    const [showPassword, setShowPassword] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    // Caps Lock is the most common cause of a failed campus login; say so
    // before the attempt instead of after it.
    const [capsOn, setCapsOn] = useState(false);
    const checkCaps = (e) => setCapsOn(Boolean(e.getModifierState && e.getModifierState('CapsLock')));

    const handleSubmit = async (e) => {
        e.preventDefault();
        setSubmitting(true);
        try {
            await onLogin(email, password);
        } catch (err) {
            // error handled by parent
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div className="login" style={{ fontFamily: FONT_STACK }}>
            <style>{LOGIN_CSS}</style>

            <aside className="login-art" aria-hidden="true">
                <svg viewBox="0 0 520 720" preserveAspectRatio="xMidYMid slice">
                    <defs>
                        <mask id="routeReveal" maskUnits="userSpaceOnUse" x="0" y="0" width="520" height="720">
                            <path
                                className="login-draw" pathLength="1" fill="none" stroke="#fff" strokeWidth="24" strokeLinecap="round"
                                d="M70 650 C 70 570, 220 570, 220 490 S 120 390, 250 340 S 400 310, 380 230 S 330 170, 400 130"
                            />
                        </mask>
                    </defs>
                    <g mask="url(#routeReveal)">
                    <path
                        d="M70 650 C 70 570, 220 570, 220 490 S 120 390, 250 340 S 400 310, 380 230 S 330 170, 400 130"
                        fill="none" stroke={C.brand} strokeOpacity="0.22" strokeWidth="16" strokeLinecap="round"
                    />
                    <path
                        d="M70 650 C 70 570, 220 570, 220 490 S 120 390, 250 340 S 400 310, 380 230 S 330 170, 400 130"
                        fill="none" stroke={C.brand} strokeWidth="4" strokeLinecap="round" strokeDasharray="2 12"
                    />
                    </g>
                    {[[220, 490], [250, 340], [380, 230]].map(([x, y], k) => (
                        <circle key={`${x}-${y}`} className="login-node" style={{ '--k': k }} cx={x} cy={y} r="6" fill={C.bar} stroke={C.brandAccent} strokeWidth="2" />
                    ))}
                    <circle className="login-dest" cx="400" cy="130" r="7" fill={C.white} />
                </svg>
                <div className="login-art-copy">
                    <BrandLogo size={72} className="login-art-logo" />
                    <div className="login-mark">AR<b>Node</b></div>
                    <p>Edit the campus map that guides visitors in augmented reality.</p>
                </div>
            </aside>

            <main className="login-pane">
                <div className="login-box">
                    <div className="login-mark brand-lockup rise" style={{ '--i': 0 }}><BrandLogo /><span>AR<b>Node</b></span></div>
                    <h1 className="ui-h1 rise" style={{ '--i': 1 }}>Sign in</h1>
                    <p className="ui-sub rise" style={{ '--i': 2 }}>Use your campus admin or faculty account.</p>

                    <form className="login-form" onSubmit={handleSubmit}>
                        {error && <div className="ui-alert" role="alert">{error}</div>}

                        <div className="ui-field rise" style={{ '--i': 3 }}>
                            <label className="ui-label" htmlFor="login-email">Email</label>
                            <input
                                id="login-email"
                                className="ui-input"
                                type="email"
                                value={email}
                                onChange={(e) => { setEmail(e.target.value); setDemoPicked(null); }}
                                autoComplete="username"
                                placeholder="you@campus.edu"
                                aria-invalid={error ? 'true' : undefined}
                                required
                                autoFocus
                            />
                        </div>

                        <div className="ui-field rise" style={{ '--i': 4 }}>
                            <label className="ui-label" htmlFor="login-password">Password</label>
                            <div className="login-pw">
                                <input
                                    id="login-password"
                                    className="ui-input"
                                    type={showPassword ? 'text' : 'password'}
                                    value={password}
                                    onChange={(e) => { setPassword(e.target.value); setDemoPicked(null); }}
                                    autoComplete="current-password"
                                    aria-invalid={error ? 'true' : undefined}
                                    aria-describedby={capsOn ? 'login-caps' : undefined}
                                    onKeyDown={checkCaps}
                                    onKeyUp={checkCaps}
                                    onBlur={() => setCapsOn(false)}
                                    required
                                />
                                <button
                                    type="button"
                                    className="login-toggle"
                                    onClick={() => setShowPassword((v) => !v)}
                                    aria-pressed={showPassword}
                                >
                                    {showPassword ? 'Hide' : 'Show'}
                                </button>
                            </div>
                            {capsOn && <span className="ui-hint login-caps" id="login-caps" role="status">Caps Lock is on.</span>}
                        </div>

                        <button ref={submitRef} className="ui-btn ui-btn-primary ui-btn-block rise" style={{ '--i': 5 }} type="submit" disabled={submitting} aria-busy={submitting}>
                            {submitting && <span className="btn-spin" aria-hidden="true" />}
                            {submitting ? 'Signing in' : 'Sign in'}
                        </button>
                    </form>

                    {SHOW_DEMO && (
                        <section className="login-demo" aria-labelledby="login-demo-title">
                            <div className="login-demo-head">
                                <h2 className="login-demo-title" id="login-demo-title">Demo accounts</h2>
                                <span className="login-demo-note">Tap to fill, then Sign in</span>
                            </div>
                            <div className="login-demo-list">
                                {DEMO_ACCOUNTS.map((account) => (
                                    <button
                                        key={account.email} type="button" className="login-demo-btn"
                                        aria-pressed={demoPicked === account.email} onClick={() => fillDemo(account)}
                                        aria-label={`Fill in ${account.name}, ${account.email}`}
                                    >
                                        <span className="login-demo-tag">{account.tag}</span>
                                        <span className="login-demo-who">
                                            <b>{account.name}</b>
                                            <span>{account.email}</span>
                                        </span>
                                    </button>
                                ))}
                            </div>
                        </section>
                    )}
                </div>
            </main>
        </div>
    );
}
