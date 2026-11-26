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
    { email: 'ccs.dean@campus.test', tag: 'CCS', name: 'CCS Dean (building head)' },
    { email: 'ccs.it@campus.test', tag: 'CCS', name: 'CCS IT office staff' },
    { email: 'ccs.cs@campus.test', tag: 'CCS', name: 'CCS CS office staff' },
    { email: 'csm.staff@campus.test', tag: 'CSM', name: 'CSM department staff' },
    { email: 'ccje@campus.test', tag: 'CCJE', name: 'CCJE department staff' },
    { email: 'nursing@campus.test', tag: 'BSN', name: 'Nursing department staff' },
    { email: 'cte@campus.test', tag: 'CTE', name: 'CTE department staff' },
    { email: 'ils@campus.test', tag: 'ILS', name: 'ILS (high school) staff' },
    { email: 'msa@campus.test', tag: 'MSA', name: 'MSA staff' },
    { email: 'cais@campus.test', tag: 'CAIS', name: 'CAIS staff' },
    { email: 'canteen@campus.test', tag: 'Office', name: 'Canteen staff' },
    { email: 'cashier@campus.test', tag: 'Office', name: 'Cashier staff' },
    { email: 'misto@campus.test', tag: 'Office', name: 'Misto staff' },
    { email: 'upress@campus.test', tag: 'Office', name: 'UPress staff' },
    { email: 'registrar@campus.test', tag: 'Office', name: 'Registrar staff' },
];

// The route the art panel draws, and the one its walker follows: up through the campus, then round to
// the door of the building beside it (BUILDINGS[4]), its destination.
// The last piece is one curve (no joint at the bend): it leaves the middle stretch on the same heading, so
// the turn round the swamp is a single smooth arc.
const ROUTE = 'M70 710 C 70 630, 220 630, 220 550 S 120 450, 250 400 C 345 363, 330 315, 265 290';
const DEST = [265, 290];
// A small swamp in the pocket between the route's middle stretch and its last one, which bends round
// its right side (its shore clears the route by 5+, and stays 40 below the door): centre, radii.
const LAKE = { cx: 234, cy: 352, rx: 54, ry: 23 };
const LAKE_WOBBLE = [1, 0.9, 1.06, 0.94, 1.08, 0.9, 1.02, 0.95, 1.05, 0.92];

/** A smooth irregular closed shape: an ellipse whose radius wobbles by `wobble` around it. */
function blob(cx, cy, rx, ry, wobble = LAKE_WOBBLE) {
    const n = wobble.length;
    const p = wobble.map((f, i) => {
        const a = (i / n) * Math.PI * 2;
        return [cx + Math.cos(a) * rx * f, cy + Math.sin(a) * ry * f];
    });
    const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const f = (q) => `${q[0].toFixed(1)} ${q[1].toFixed(1)}`;
    let d = `M${f(mid(p[n - 1], p[0]))}`;
    p.forEach((q, i) => { d += ` Q${f(q)} ${f(mid(q, p[(i + 1) % n]))}`; });
    return `${d} Z`;
}
// Reed tufts on the shore ([x, y] of each tuft's foot) and lily pads ([x, y, r]).
const REEDS = [[184, 344], [190, 363], [277, 366], [279, 352], [212, 332]];
const LILIES = [[220, 355, 4.2], [251, 345, 3.4], [258, 360, 2.8]];
// Campus buildings beside the route, in the student map's 2.5D look: [centre x, centre y, width, depth,
// rotation (deg), storeys]. Kept off the route and away from the copy in the top-left corner.
const BUILDINGS = [[400, 530, 130, 70, -12, 2], [80, 425, 96, 58, 8, 3], [462, 405, 70, 100, 4, 4], [305, 625, 90, 58, 10, 1], [262, 262, 84, 50, -6, 2], [42, 600, 56, 78, -4, 2]];
const DOOR_W = 8;
const DOOR_H = 9;
const STOREY_PX = 12;
const ROOF = '#f6f5f2';
const WALL_LIT = '#d9d5ce';
const WALL_SHADE = '#8f8b85';

/** One 2.5D building: its roof lifted by its height, the walls facing the viewer (south), storey lines. */
function building([cx, cy, w, d, rot, storeys]) {
    const t = (rot * Math.PI) / 180;
    const at = (x, y) => [cx + x * Math.cos(t) - y * Math.sin(t), cy + x * Math.sin(t) + y * Math.cos(t)];
    const base = [at(-w / 2, -d / 2), at(w / 2, -d / 2), at(w / 2, d / 2), at(-w / 2, d / 2)];
    const h = storeys * STOREY_PX;
    const up = ([x, y], f = 1) => [x, y - h * f];
    const pts = (ps) => ps.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
    const walls = base.map((a, i) => {
        const b = base[(i + 1) % base.length];
        const mid = [(a[0] + b[0]) / 2 - cx, (a[1] + b[1]) / 2 - cy];
        if (mid[1] <= 0.5) return null; // faces away (north): hidden behind the building
        return { a, b, lit: mid[0] < 0 };
    }).filter(Boolean);
    return { roof: pts(base.map((q) => up(q))), walls: walls.map((wl) => ({
        face: pts([wl.a, wl.b, up(wl.b), up(wl.a)]),
        lit: wl.lit,
        lines: Array.from({ length: storeys - 1 }, (_, k) => [up(wl.a, (k + 1) / storeys), up(wl.b, (k + 1) / storeys)]),
        door: doorway(wl.a, wl.b, h),
    })) };
}

/** A door in the middle of the wall a-b (when it is long enough): its opening, and its frame. */
function doorway(a, b, h) {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 40) return null;
    const along = (t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    const p0 = along(0.5 - DOOR_W / 2 / len);
    const p1 = along(0.5 + DOOR_W / 2 / len);
    const top = Math.min(DOOR_H, h * 0.8);
    const pts = (ps) => ps.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
    return {
        opening: pts([p0, p1, [p1[0], p1[1] - top], [p0[0], p0[1] - top]]),
        frame: pts([p0, [p0[0], p0[1] - top], [p1[0], p1[1] - top], p1]),
        sill: [p0, p1],
    };
}
// The walker: draws on after the route, walks it, rests at the destination, again.
const WALK_START = 3.6;
const WALK_S = 6;
// Reduced motion: no walker at all (SMIL animations ignore the CSS media query).
const REDUCED = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

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
    /* Reduced motion (animations off): the route is simply there. */
    @media (prefers-reduced-motion: reduce) { .login-draw { stroke-dashoffset: 0; } }
    .login-dest { transform-box: fill-box; transform-origin: center; animation: loginDrop 0.8s var(--ease-spring) 3.1s both; }

    /* The campus around the route: 2.5D buildings rising in one after another. */
    .login-bldg { animation: loginBldg 0.9s var(--ease-out) both; animation-delay: calc(0.15s + var(--k, 0) * 0.12s); }
    /* The swamp: reeds sway from their feet, ripples drift and fade on the water. */
    .login-reed { transform-box: fill-box; transform-origin: 50% 100%; animation: loginReed 3.2s ease-in-out infinite alternate; animation-delay: calc(var(--k, 0) * -0.7s); }
    .login-ripple { animation: loginRipple 4.5s ease-in-out infinite alternate; animation-delay: calc(var(--k, 0) * -2.2s); }

    /* The walker: legs and arms swing in turn as it goes. */
    .login-limb { transform-box: fill-box; transform-origin: 50% 0%; animation: loginStride 0.42s ease-in-out infinite alternate; }
    .login-limb.is-back { animation-delay: -0.42s; }
    .login-arm { animation-name: loginSwing; }

    /* The copy: logo spins in, then the name, then the line; "Node" catches the light once. */
    .login-art-logo { animation: loginLogo 0.9s var(--ease-spring) 0.1s both; }
    .login-art-copy .login-mark { animation: rise 0.7s var(--ease-out) 0.3s both; }
    .login-art-copy p { animation: rise 0.7s var(--ease-out) 0.45s both; }
    .login-art-copy .login-mark b {
        background: linear-gradient(100deg, ${C.brandAccent} 40%, #ffffff 50%, ${C.brandAccent} 60%);
        background-size: 250% 100%; background-position: 0% 0;
        -webkit-background-clip: text; background-clip: text; color: transparent;
        animation: loginSheen 1.6s var(--ease-in-out) 1.2s both;
    }

    @keyframes loginBldg { from { opacity: 0; transform: translateY(16px); } }
    @keyframes loginReed { from { transform: rotate(-5deg); } to { transform: rotate(5deg); } }
    @keyframes loginRipple { from { opacity: 0.1; transform: translateX(-3px); } to { opacity: 0.35; transform: translateX(3px); } }
    @keyframes loginStride { from { transform: rotate(26deg); } to { transform: rotate(-26deg); } }
    @keyframes loginSwing { from { transform: rotate(-20deg); } to { transform: rotate(20deg); } }
    @keyframes loginDrop { 0% { opacity: 0; transform: translateY(-18px) scale(0.6); } 60% { opacity: 1; } }
    @keyframes loginLogo { from { opacity: 0; transform: scale(0.6) rotate(-35deg); } }
    @keyframes loginSheen { from { background-position: 100% 0; } }

    /* Sign in: a light sweep across on hover. */
    .login-form .ui-btn-primary { position: relative; overflow: hidden; isolation: isolate; }
    .login-form .ui-btn-primary::after {
        content: ''; position: absolute; inset: 0; z-index: -1; pointer-events: none;
        background: linear-gradient(100deg, transparent 30%, rgba(255,255,255,0.28) 50%, transparent 70%);
        transform: translateX(-120%); transition: transform 0.7s var(--ease-out);
    }
    .login-form .ui-btn-primary:hover:not(:disabled)::after { transform: translateX(120%); }
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
    /* One per department and office: about five rows show, the rest scroll. */
    .login-demo-list { display: grid; gap: 8px; margin-top: 10px; max-height: 296px; overflow-y: auto; padding-right: 4px; overscroll-behavior: contain; }
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
                            <path className="login-draw" pathLength="1" fill="none" stroke="#fff" strokeWidth="24" strokeLinecap="round" d={ROUTE} />
                        </mask>
                    </defs>
                    {BUILDINGS.map((spec, k) => {
                        const b = building(spec);
                        return (
                            <g key={spec.join()} className="login-bldg" style={{ '--k': k }} opacity="0.88">
                                {b.walls.map((wl, i) => (
                                    <g key={i}>
                                        <polygon points={wl.face} fill={wl.lit ? WALL_LIT : WALL_SHADE} stroke="#16161b" strokeWidth="0.8" strokeLinejoin="round" />
                                        {wl.lines.map(([a, c], j) => (
                                            <line key={j} x1={a[0]} y1={a[1]} x2={c[0]} y2={c[1]} stroke="#16161b" strokeOpacity="0.35" strokeWidth="0.8" />
                                        ))}
                                        {wl.door && (
                                            <>
                                                <polygon points={wl.door.opening} fill="#2a2420" />
                                                <polyline points={wl.door.frame} fill="none" stroke="#ffffff" strokeWidth="1.2" strokeLinejoin="round" />
                                                <line x1={wl.door.sill[0][0]} y1={wl.door.sill[0][1]} x2={wl.door.sill[1][0]} y2={wl.door.sill[1][1]} stroke="#ffffff" strokeWidth="1.6" strokeLinecap="round" />
                                            </>
                                        )}
                                    </g>
                                ))}
                                <polygon points={b.roof} fill={ROOF} stroke="#16161b" strokeWidth="1.2" strokeLinejoin="round" />
                            </g>
                        );
                    })}
                    {/* The swamp: a muddy shore, dark water, lily pads, reeds and a couple of ripples. */}
                    <g className="login-bldg" style={{ '--k': BUILDINGS.length }}>
                        <path d={blob(LAKE.cx, LAKE.cy + 1.5, LAKE.rx + 7, LAKE.ry + 5)} fill="#24302a" fillOpacity="0.9" />
                        <path d={blob(LAKE.cx, LAKE.cy, LAKE.rx, LAKE.ry)} fill="#10303c" stroke="#2d5e6b" strokeWidth="1.2" />
                        <path d={blob(LAKE.cx - 6, LAKE.cy - 4, LAKE.rx * 0.55, LAKE.ry * 0.45)} fill="#174552" fillOpacity="0.7" />
                        {[[212, 347, 20], [246, 362, 16]].map(([x, y, w], k) => (
                            <path key={k} className="login-ripple" style={{ '--k': k }} d={`M${x} ${y} q${w / 2} -3 ${w} 0`} fill="none" stroke="#ffffff" strokeWidth="1.1" strokeLinecap="round" />
                        ))}
                        {LILIES.map(([x, y, r]) => (
                            <path key={`${x}-${y}`} d={`M${x} ${y} L${x + r} ${y - r * 0.35} A${r} ${r * 0.6} 0 1 0 ${x + r} ${y + r * 0.2} Z`} fill="#3d7a4f" stroke="#244d33" strokeWidth="0.6" />
                        ))}
                        {REEDS.map(([x, y], k) => (
                            <g key={`${x}-${y}`} className="login-reed" style={{ '--k': k }}>
                                {[[-2.5, 11, -2], [0, 14, 0], [2.5, 10, 2]].map(([dx, h, lean], j) => (
                                    <path key={j} d={`M${x + dx} ${y} q${lean} ${-h / 2} ${lean * 1.6} ${-h}`} fill="none" stroke={j === 1 ? '#6b8f4e' : '#4e7340'} strokeWidth="1.4" strokeLinecap="round" />
                                ))}
                                <ellipse cx={x + 0.3} cy={y - 13.5} rx="1.1" ry="2.4" fill="#7a5a36" />
                            </g>
                        ))}
                    </g>
                    <g mask="url(#routeReveal)">
                        <path d={ROUTE} fill="none" stroke={C.brand} strokeOpacity="0.22" strokeWidth="16" strokeLinecap="round" />
                        <path d={ROUTE} fill="none" stroke={C.brand} strokeWidth="4" strokeLinecap="round" strokeDasharray="2 12" />
                    </g>
                    {!REDUCED && (
                        <>
                            {/* Arrival: the destination pulses each time the walker reaches it. */}
                            <circle cx={DEST[0]} cy={DEST[1]} r="7" fill="none" stroke={C.white} strokeWidth="1.5" opacity="0">
                                <animate attributeName="r" values="7;7;26;26" keyTimes="0;0.74;0.95;1" dur={`${WALK_S}s`} begin={`${WALK_START}s`} repeatCount="indefinite" />
                                <animate attributeName="opacity" values="0;0;0.9;0;0" keyTimes="0;0.74;0.76;0.95;1" dur={`${WALK_S}s`} begin={`${WALK_START}s`} repeatCount="indefinite" />
                            </circle>
                            {/* The walker: a person like the 3D view's, its feet on the route, ringed like "you". */}
                            <g opacity="0">
                                <animateMotion path={ROUTE} keyPoints="0;1;1" keyTimes="0;0.74;1" calcMode="linear" dur={`${WALK_S}s`} begin={`${WALK_START}s`} repeatCount="indefinite" />
                                <animate attributeName="opacity" values="0;1;1;0;0" keyTimes="0;0.06;0.7;0.78;1" dur={`${WALK_S}s`} begin={`${WALK_START}s`} repeatCount="indefinite" />
                                <ellipse cx="0" cy="0" rx="12" ry="4.5" fill="none" stroke="#ffffff" strokeOpacity="0.55" strokeWidth="1.6" />
                                <ellipse cx="2" cy="0.5" rx="6.5" ry="2.2" fill="#000000" fillOpacity="0.45" />
                                <line className="login-limb" x1="-1.6" y1="-11" x2="-1.6" y2="-0.5" stroke="#cfd2d8" strokeWidth="3" strokeLinecap="round" />
                                <line className="login-limb is-back" x1="1.6" y1="-11" x2="1.6" y2="-0.5" stroke="#e5e7eb" strokeWidth="3" strokeLinecap="round" />
                                <line className="login-limb login-arm is-back" x1="-4.6" y1="-19.5" x2="-4.6" y2="-12" stroke="#cfd2d8" strokeWidth="2.4" strokeLinecap="round" />
                                <rect x="-4" y="-21" width="8" height="11.5" rx="3.2" fill="#e5e7eb" />
                                <line className="login-limb login-arm" x1="4.6" y1="-19.5" x2="4.6" y2="-12" stroke="#f3f4f6" strokeWidth="2.4" strokeLinecap="round" />
                                <circle cx="0" cy="-25.5" r="4.2" fill="#f3f4f6" />
                            </g>
                        </>
                    )}
                    <circle className="login-dest" cx={DEST[0]} cy={DEST[1]} r="6" fill={C.white} />
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
