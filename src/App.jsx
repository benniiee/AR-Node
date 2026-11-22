import React, { useState, useEffect, useRef } from 'react';
import { api, setToken, getToken } from './api';
import LoginForm from './components/LoginForm';
import BrandLogo from './components/BrandLogo';
import AdminMap from './components/AdminMap';
import { ConfirmHost } from './components/ConfirmDialog';
import TooltipLayer from './components/TooltipLayer';
import { LIST_CSS } from './components/ScrollWindow';
import { C, TYPE, FONT_STACK, TAP, ADMIN_CSS, INTERACTION_CSS } from './uiTokens';

const SHELL_CSS = `
    .shell { display: flex; height: 100vh; height: 100dvh; background: ${C.page}; }

    /* Left rail on desktop; on phones the same rail is a slide-in drawer (below). */
    .rail {
        width: 232px; flex: none; display: flex; flex-direction: column; gap: 4px;
        padding: 20px 12px 12px; background: ${C.page};
        border-right: 1px solid ${C.hairline}; z-index: 1200;
    }
    .brand { padding: 0 10px 18px; font-size: ${TYPE.title}; font-weight: 800; letter-spacing: -0.02em; color: ${C.white}; }
    .brand b { color: ${C.brandAccent}; font-weight: 800; }

    .nav-link {
        position: relative; display: flex; align-items: center; width: 100%;
        min-height: 40px; padding: 0 12px 0 14px; border-radius: 10px;
        border: 0; background: transparent; color: ${C.muted};
        font: inherit; font-size: ${TYPE.sub}; font-weight: 600; text-align: left; cursor: pointer;
        transition: background-color 0.3s var(--ease-out), color 0.3s var(--ease-out);
        -webkit-tap-highlight-color: transparent;
    }
    .nav-link > span { transition: transform 0.45s var(--ease-out); }
    .nav-link:hover > span { transform: translateX(4px); }
    .nav-link:hover { background: rgba(255, 255, 255, 0.05); color: ${C.white}; }
    .nav-link:focus-visible { outline: ${TAP.focusOutline}; outline-offset: 2px; }
    /* Current page: a filled row and a bolder label, so it never depends on colour alone. */
    .nav-link[aria-current="page"] { background: rgba(229, 24, 43, 0.14); color: ${C.white}; font-weight: 700; }
    .brand { animation: rise 0.8s var(--ease-out) both; }
    .brand b { display: inline-block; transition: transform 0.5s var(--ease-spring); }
    .brand:hover b { transform: translateY(-2px) rotate(-4deg); }

    .rail-spacer { flex: 1; }
    .who { display: flex; flex-direction: column; gap: 10px; padding: 14px 4px 0; border-top: 1px solid ${C.hairline}; }
    .who-name { font-size: ${TYPE.sub}; font-weight: 600; color: ${C.white}; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .who-meta { font-size: ${TYPE.desc}; color: ${C.muted}; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: 2px; }

    .main { flex: 1; min-width: 0; min-height: 0; position: relative; display: flex; flex-direction: column; }

    .splash { display: flex; flex-direction: column; gap: 14px; align-items: center; justify-content: center; height: 100vh; height: 100dvh; background: ${C.page}; }
    .splash-mark { font-size: ${TYPE.title}; font-weight: 800; letter-spacing: -0.02em; color: ${C.white}; animation: fadeIn 0.6s var(--ease-out) both; }
    .splash-mark b { color: ${C.brandAccent}; }
    .splash-logo { animation: fadeIn 0.6s var(--ease-out) both; }
    .splash-bar { width: 120px; height: 3px; }
    .splash-text { font-size: ${TYPE.sub}; color: ${C.muted}; animation: fadeIn 0.6s var(--ease-out) 0.2s both; }
    .main-enter { animation: fadeIn 0.5s var(--ease-out) both; }

    /* Phones and narrow windows: a slim top bar with a menu button; the rail becomes a
       drawer that slides in from the left. */
    .menu-btn, .menu-close {
        flex: none; display: grid; place-items: center; width: ${TAP.minHeight}; height: ${TAP.minHeight};
        border: 1px solid ${C.hairline}; border-radius: 10px; background: rgba(255, 255, 255, 0.04); color: ${C.white};
        cursor: pointer; -webkit-tap-highlight-color: transparent; transition: background-color var(--dur-fast) var(--ease-out);
    }
    .menu-btn:hover, .menu-close:hover { background: rgba(255, 255, 255, 0.09); }
    .menu-btn:focus-visible, .menu-close:focus-visible { outline: ${TAP.focusOutline}; outline-offset: 2px; }
    .rail-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .topbar, .drawer-backdrop, .menu-close { display: none; }

    @media (max-width: 760px) {
        .shell { flex-direction: column; min-height: 100dvh; overflow: hidden; }
        .topbar {
            display: flex; align-items: center; gap: 10px; flex: none; z-index: 1200;
            min-height: calc(56px + env(safe-area-inset-top));
            padding: env(safe-area-inset-top) max(10px, env(safe-area-inset-right)) 0 max(10px, env(safe-area-inset-left));
            background: ${C.page}; border-bottom: 1px solid ${C.hairline};
        }
        .topbar .brand { padding: 0; font-size: 18px; animation: none; flex: none; white-space: nowrap; }
        .topbar-page { margin-left: auto; min-width: 0; font-size: ${TYPE.sub}; font-weight: 600; color: ${C.muted}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .rail {
            position: fixed; top: 0; bottom: 0; left: 0; z-index: 1400; width: min(300px, 86vw);
            padding: max(12px, env(safe-area-inset-top)) 12px max(12px, env(safe-area-inset-bottom)) max(12px, env(safe-area-inset-left));
            box-shadow: 16px 0 40px rgba(0, 0, 0, 0.5); overflow-y: auto;
            transform: translateX(-104%); visibility: hidden;
            transition: transform var(--dur-slow) var(--ease-out), visibility 0s linear var(--dur-slow);
        }
        .rail.is-open { transform: none; visibility: visible; transition: transform var(--dur-slow) var(--ease-out), visibility 0s; }
        .rail .brand { padding: 0 6px; font-size: 18px; animation: none; }
        .rail-head { padding-bottom: 14px; }
        .menu-close { display: grid; }
        .drawer-backdrop { display: block; position: fixed; inset: 0; z-index: 1300; background: rgba(0, 0, 0, 0.55); animation: fadeIn var(--dur-base) var(--ease-out) both; }
        .nav-link { min-height: ${TAP.minHeight}; }
        .who .ui-btn { min-height: ${TAP.minHeight}; }
        .main { min-height: 0; overflow: hidden; }
        .ui-root .ui-btn, .ui-root .nav-link, .ui-root .login-toggle { min-height: ${TAP.minHeight}; }
        .ui-root .ui-input, .ui-root .ui-select, .ui-root textarea { min-height: ${TAP.minHeight}; font-size: 16px; }
        .ui-root button, .ui-root [role="button"] { -webkit-tap-highlight-color: transparent; touch-action: manipulation; }
    }
    @media (pointer: coarse) {
        .ui-root .ui-btn, .ui-root .nav-link, .ui-root .login-toggle { min-height: ${TAP.minHeight}; }
        .ui-root .ui-input, .ui-root .ui-select, .ui-root textarea { min-height: ${TAP.minHeight}; font-size: 16px; }
    }
    @media (max-height: 540px) and (max-width: 760px) {
        .login { min-height: 100dvh; }
        .login-pane { align-items: flex-start; overflow-y: auto; -webkit-overflow-scrolling: touch; padding: 18px 16px max(20px, env(safe-area-inset-bottom)); }
        .login-box { margin: auto 0; }
    }
`;

export default function App() {
    const [user, setUser] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [tab, setTab] = useState('map');
    // Phone menu (drawer). Esc and the backdrop close it; focus goes in and comes back.
    const [menuOpen, setMenuOpen] = useState(false);
    const menuBtnRef = useRef(null);
    const drawerRef = useRef(null);
    const closeMenu = () => { setMenuOpen(false); menuBtnRef.current?.focus(); };
    useEffect(() => {
        if (!menuOpen) return undefined;
        const drawer = drawerRef.current;
        (drawer?.querySelector('.nav-link[aria-current="page"]') || drawer?.querySelector('.nav-link'))?.focus();
        const onKey = (e) => { if (e.key === 'Escape') closeMenu(); };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [menuOpen]);

    useEffect(() => {
        const token = getToken();
        if (token) {
            api.getUser()
                .then(u => { setUser(u); setLoading(false); })
                .catch(() => { setToken(null); setLoading(false); });
        } else {
            setLoading(false);
        }
    }, []);

    const handleLogin = async (email, password) => {
        setError(null);
        try {
            const data = await api.login(email, password);
            setToken(data.token);
            setUser(data.user);
        } catch (err) {
            setError(err.message);
            throw err;
        }
    };

    const handleLogout = async () => {
        try {
            await api.logout();
        } catch (e) {
            // ignore
        }
        setToken(null);
        setUser(null);
        setError(null);
        setTab('map');
        setMenuOpen(false);
    };

    const frame = (children) => (
        <div className="ui-root" style={{ minHeight: '100vh', background: C.page, fontFamily: FONT_STACK }}>
            <style>{ADMIN_CSS + SHELL_CSS + LIST_CSS + INTERACTION_CSS}</style>
            {children}
            <ConfirmHost />
            <TooltipLayer />
        </div>
    );

    if (loading) return frame(<div className="splash" role="status" aria-label="Loading"><BrandLogo size={64} className="splash-logo" /><div className="splash-mark">AR<b>Node</b></div><div className="splash-bar skeleton" /><div className="splash-text">Loading your workspace</div></div>);

    if (!user) return frame(<LoginForm onLogin={handleLogin} error={error} />);

    const isAdmin = user?.role === 'admin';
    // Faculty never see the Departments tab - the backend would 403 them
    // anyway, so fall back to the map rather than showing a dead tab.
    const effectiveTab = (tab === 'departments' || tab === 'students' || tab === 'weather') && !isAdmin ? 'map' : tab;

    const PAGE_NAMES = { weather: 'Weather Dashboard', map: 'Map', departments: 'Departments & accounts', students: 'Students', courses: 'Courses', announcements: 'Announcements', activity: 'Activity log' };
    const navLink = (id, label) => (
        <button
            key={id}
            className="nav-link"
            aria-current={effectiveTab === id ? 'page' : undefined}
            onClick={() => { setTab(id); setMenuOpen(false); }}
        >
            <span>{label}</span>
        </button>
    );

    const roleLabel = user.role ? user.role.charAt(0).toUpperCase() + user.role.slice(1) : '';
    const meta = [roleLabel, user.department?.name].filter(Boolean).join(' · ');

    return frame(
        <div className="shell">
            {/* Phones: top bar with the menu button (the rail below is the drawer). */}
            <header className="topbar">
                <button
                    ref={menuBtnRef} type="button" className="menu-btn" onClick={() => setMenuOpen(true)}
                    aria-label="Open menu" aria-expanded={menuOpen} aria-controls="admin-nav"
                >
                    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><path d="M3 5.5h14M3 10h14M3 14.5h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
                </button>
                <div className="brand brand-lockup"><BrandLogo /><span>AR<b>Node</b></span></div>
                {/* Pages with their own heading do not repeat it here; the map has none. */}
                {effectiveTab === 'map' && <span className="topbar-page">{PAGE_NAMES[effectiveTab]}</span>}
            </header>
            {menuOpen && <div className="drawer-backdrop" onClick={closeMenu} aria-hidden="true" />}
            <nav id="admin-nav" ref={drawerRef} className={`rail${menuOpen ? ' is-open' : ''}`} aria-label="Main">
                <div className="rail-head">
                    <div className="brand brand-lockup"><BrandLogo /><span>AR<b>Node</b></span></div>
                    <button type="button" className="menu-close" onClick={closeMenu} aria-label="Close menu">
                        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path d="M4.5 4.5l9 9M13.5 4.5l-9 9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
                    </button>
                </div>
                {isAdmin && navLink('weather', PAGE_NAMES.weather)}
                {navLink('map', PAGE_NAMES.map)}
                {isAdmin && navLink('departments', PAGE_NAMES.departments)}
                {isAdmin && navLink('students', PAGE_NAMES.students)}
                {/* Department staff manage their own department's courses; admins every course. */}
                {navLink('courses', PAGE_NAMES.courses)}
                {/* Closures and special openings: admins any scope, staff their own department. */}
                {navLink('announcements', PAGE_NAMES.announcements)}
                {/* Admins see everyone; department staff see their courses' students. */}
                {navLink('activity', PAGE_NAMES.activity)}
                <div className="rail-spacer" />
                <div className="who">
                    <div className="who-text" title={user.email}>
                        <div className="who-name">{user.name || user.email}</div>
                        {meta && <div className="who-meta">{meta}</div>}
                    </div>
                    <button className="ui-btn ui-btn-secondary" onClick={handleLogout}>Sign out</button>
                </div>
            </nav>
            <main className="main main-enter">
                {/* Errors from every tab show in the map's notification pill. */}
                <AdminMap currentUser={user} tab={effectiveTab} />
            </main>
        </div>
    );
}
