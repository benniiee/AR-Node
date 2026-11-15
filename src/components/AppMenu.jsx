import React, { useEffect, useId, useRef, useState } from 'react';
import { SyncChip } from './SyncPill';
import InstallApp from './InstallApp';
import { C, TYPE, TAP, PANEL_RADIUS, PILL, ELEVATION } from '../uiTokens';

/*
 * The student app's menu (☰ at the end of the header): offline copy status, Install app and
 * the account. One button instead of a row of chips, so the map keeps the screen
 * (FRONTEND.md §7 and §8: hamburger on small screens, popover for a few actions).
 * Esc, a tap outside or choosing an item closes it; focus goes in and comes back.
 */
const CSS = `
    .amenu-wrap { position: relative; flex: none; display: flex; }
    .amenu-btn {
        display: grid; place-items: center; width: ${TAP.minHeight}; min-height: ${TAP.minHeight}; align-self: stretch;
        border: 1px solid ${C.border}; border-radius: ${PILL}px; background: ${C.surface}; color: ${C.white};
        cursor: pointer; -webkit-tap-highlight-color: transparent; touch-action: manipulation;
        transition: background-color var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out);
    }
    .amenu-btn:hover { background: ${C.surfaceHover}; }
    .amenu-btn:active { transform: scale(${TAP.activeScale}); }
    .amenu-btn:focus-visible { outline: ${TAP.focusOutline}; outline-offset: 2px; }
    .amenu-btn[data-attention="true"]::after {
        content: ''; position: absolute; top: 7px; right: 7px; width: 8px; height: 8px; border-radius: 50%;
        background: ${C.warning}; box-shadow: 0 0 0 2px ${C.bar};
    }
    .amenu-panel {
        position: absolute; top: calc(100% + 8px); right: 0; z-index: 2100; width: min(300px, calc(100vw - 20px));
        display: flex; flex-direction: column; gap: 4px; padding: 8px;
        background: ${C.bar}; border: 1px solid ${C.border}; border-radius: ${PANEL_RADIUS}px; box-shadow: ${ELEVATION.float};
        transform-origin: top right; animation: amenuIn var(--dur-fast) var(--ease-out) both;
    }
    @keyframes amenuIn { from { opacity: 0; transform: scale(0.98) translateY(-4px); } }
    @media (prefers-reduced-motion: reduce) { .amenu-panel { animation: none; } }
    .amenu-who { padding: 6px 8px 10px; border-bottom: 1px solid ${C.hairline}; margin-bottom: 4px; min-width: 0; }
    .amenu-name { font-size: ${TYPE.sub}; font-weight: 700; color: ${C.white}; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .amenu-mail { margin-top: 2px; font-size: ${TYPE.desc}; color: ${C.muted}; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .amenu-panel .mnav-chip { width: 100%; justify-content: flex-start; }
    .amenu-item {
        display: flex; align-items: center; gap: 10px; width: 100%; min-height: ${TAP.minHeight}; padding: 0 12px;
        border: 0; border-radius: ${PANEL_RADIUS - 8}px; background: transparent; color: ${C.text};
        font: inherit; font-size: ${TYPE.sub}; font-weight: 600; text-align: left; cursor: pointer;
        -webkit-tap-highlight-color: transparent;
    }
    .amenu-item:hover { background: rgba(255, 255, 255, 0.06); }
    .amenu-item:focus-visible { outline: ${TAP.focusOutline}; outline-offset: -2px; }
    .amenu-item svg { flex: none; color: ${C.muted}; }
    .amenu-hint { margin: 2px 12px 6px; font-size: ${TYPE.desc}; line-height: 1.5; color: ${C.text}; }
`;

export default function AppMenu({ session, isVisitor, sync, showInstall, onSignOut }) {
    const [open, setOpen] = useState(false);
    const btnRef = useRef(null);
    const panelRef = useRef(null);
    const panelId = useId();
    const close = (refocus = true) => { setOpen(false); if (refocus) btnRef.current?.focus(); };

    useEffect(() => {
        if (!open) return undefined;
        panelRef.current?.querySelector('button')?.focus();
        const onKey = (e) => { if (e.key === 'Escape') close(); };
        const onDown = (e) => {
            if (!panelRef.current?.contains(e.target) && !btnRef.current?.contains(e.target)) close(false);
        };
        document.addEventListener('keydown', onKey);
        document.addEventListener('pointerdown', onDown);
        return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('pointerdown', onDown); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    if (isVisitor && !showInstall) return null;
    const needsAttention = !isVisitor && (sync?.status?.phase === 'offline' || sync?.status?.phase === 'error');
    const name = session?.user?.name || [session?.user?.first_name, session?.user?.last_name].filter(Boolean).join(' ') || 'Student';

    return (
        <div className="amenu-wrap">
            <style>{CSS}</style>
            <button
                ref={btnRef} type="button" className="amenu-btn" onClick={() => setOpen((v) => !v)}
                aria-label="Menu" aria-expanded={open} aria-controls={panelId}
                data-attention={needsAttention ? 'true' : undefined}
            >
                <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><path d="M3 5.5h14M3 10h14M3 14.5h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
            </button>
            {open && (
                <div ref={panelRef} id={panelId} className="amenu-panel" role="dialog" aria-label="Menu">
                    {!isVisitor && (
                        <div className="amenu-who">
                            <div className="amenu-name">{name}</div>
                            {session?.user?.email && <div className="amenu-mail">{session.user.email}</div>}
                        </div>
                    )}
                    {!isVisitor && <SyncChip status={sync.status} onSync={(why) => { sync.syncNow(why); }} />}
                    <InstallApp buttonClass="amenu-item" hintClass="amenu-hint">
                        {(label) => (
                            <>
                                <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path d="M9 2.5v9M5.5 8 9 11.5 12.5 8M3 13.5v2h12v-2" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
                                {label}
                            </>
                        )}
                    </InstallApp>
                    {!isVisitor && (
                        <button type="button" className="amenu-item" onClick={() => { close(false); onSignOut(); }}>
                            <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path d="M7 3.5H4.5v11H7M11 6l3 3-3 3M14 9H7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
                            Sign out
                        </button>
                    )}
                </div>
            )}
        </div>
    );
}
