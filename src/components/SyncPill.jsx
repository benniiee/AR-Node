import React, { useEffect, useState } from 'react';
import { C, TYPE, TAP, ELEVATION } from '../uiTokens';
import { describeAge } from '../offlineData';

// ── Sync status, two pieces ─────────────────────────────────────────
// SyncChip   sits in the chip row: what is saved and how old it is; tapping
//            it syncs right away (the person is never stuck waiting 20 min).
// SyncPill   the information pill: slides in at the top of the map for a few
//            seconds when something worth knowing happens, then slides out.

const CSS = `
    /* Centred in the space right of the zoom buttons (12 px margin + 44 px + gap), so a
       long or wrapped notice never covers them. */
    .sync-pill-wrap { position: absolute; z-index: 1150; top: 10px; left: 66px; right: 12px; display: flex; justify-content: center; pointer-events: none; }
    .sync-pill {
        display: flex; align-items: center; gap: 9px; padding: 9px 14px 9px 12px; border-radius: 10px; pointer-events: auto;
        background: rgba(12, 12, 16, 0.92); color: ${C.text}; border: 1px solid ${C.hairline};
        -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px);
        box-shadow: ${ELEVATION.float}; font-size: ${TYPE.sub}; line-height: 1.35; font-weight: 600;
        transition: opacity var(--dur-base) var(--ease-out), transform var(--dur-slow) var(--ease-out);
    }
    .sync-pill[data-state="in"] { opacity: 1; transform: translateY(0); }
    .sync-pill[data-state="out"] { opacity: 0; transform: translateY(-10px) scale(0.98); transition-timing-function: var(--ease-in); transition-duration: var(--dur-fast); }
    .sync-pill-spin { flex: none; width: 14px; height: 14px; border-radius: 50%; border: 2px solid rgba(255,255,255,0.25);
        border-top-color: #fff; animation: syncSpin 0.8s linear infinite; }
    .sync-pill[data-tone="attention"] { color: ${C.warning}; border-color: rgba(255, 159, 26, 0.45); }
    .sync-pill[data-tone="error"] { color: ${C.danger}; border-color: rgba(255, 85, 102, 0.45); }
    .sync-pill button {
        flex: none; margin: -6px -8px -6px 2px; min-width: ${TAP.minHeight}; min-height: ${TAP.minHeight}; border: 0; border-radius: 50%; background: transparent;
        color: ${C.muted}; font: inherit; font-size: 16px; line-height: 1; cursor: pointer;
    }
    .sync-pill button:hover { color: #fff; background: rgba(255,255,255,0.08); }
    .sync-pill .sync-pill-action { min-width: 0; padding: 0 14px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.22);
        background: rgba(255,255,255,0.1); color: #fff; font-size: 13px; font-weight: 700; }
    .sync-pill .sync-pill-action:hover { background: rgba(255,255,255,0.18); }
    .sync-pill button:focus-visible { outline: ${TAP.focusOutline}; outline-offset: 1px; }
    @media (prefers-reduced-motion: reduce) { .sync-pill { transition: opacity 200ms ease; transform: none !important; } }

    /* One quiet line: status icon, what it means, how fresh. No border while
       all is well; amber only when something needs attention. */
    .sync-chip { gap: 8px; padding: 0 12px 0 10px; background: transparent; border-color: transparent; }
    .sync-chip:hover { background: ${C.surface}; border-color: ${C.border}; }
    .sync-chip .sync-chip-icon { flex: none; display: grid; place-items: center; width: 24px; height: 24px; border-radius: 50%;
        background: rgba(74, 222, 128, 0.16); color: #4ade80; }
    .sync-chip .sync-chip-label { font-size: 13px; font-weight: 600; color: ${C.text}; }
    .sync-chip .sync-chip-age { font-size: ${TYPE.desc}; font-weight: 500; color: ${C.muted}; }
    .sync-chip[data-phase="syncing"] .sync-chip-icon { background: rgba(255,255,255,0.08); color: ${C.text}; }
    .sync-chip[data-phase="syncing"] .sync-chip-icon svg { animation: syncSpin 1s linear infinite; }
    .sync-chip[data-phase="offline"], .sync-chip[data-phase="error"] { border-color: rgba(255, 159, 26, 0.55); }
    .sync-chip[data-phase="offline"] .sync-chip-icon, .sync-chip[data-phase="error"] .sync-chip-icon { background: rgba(255, 159, 26, 0.16); color: ${C.warning}; }
    @media (max-width: 420px) { .sync-chip .sync-chip-age { display: none; } }
    @keyframes syncSpin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .sync-chip .sync-chip-icon svg { animation: none !important; } }
`;

const SHOW_MS = 4200;

export function SyncPill({ pill, onDismiss }) {
    // pill.action { label, onClick }: a button in the pill; the pill then stays
    // until it is used or dismissed (e.g. "Try again" after a failed load).
    // pill.persist: stays while it applies (e.g. "Loading the campus map");
    // passing pill = null slides it away. pill.busy: a small spinner.
    const [state, setState] = useState('out');
    const [shown, setShown] = useState(null);

    useEffect(() => {
        if (!pill) {
            setState('out');
            const gone = setTimeout(() => setShown(null), 350);
            return () => clearTimeout(gone);
        }
        setShown(pill);
        const enter = requestAnimationFrame(() => setState('in'));
        if (pill.action || pill.persist) return () => cancelAnimationFrame(enter);
        // Errors and offline notices stay a little longer.
        const leave = setTimeout(() => setState('out'), pill.tone === 'ok' || pill.tone === 'info' ? SHOW_MS : SHOW_MS + 2500);
        const gone = setTimeout(() => { setShown(null); onDismiss?.(); }, (pill.tone === 'ok' || pill.tone === 'info' ? SHOW_MS : SHOW_MS + 2500) + 350);
        return () => { cancelAnimationFrame(enter); clearTimeout(leave); clearTimeout(gone); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pill?.key]);

    return (
        <>
            <style>{CSS}</style>
            {shown && (
                <div className="sync-pill-wrap">
                    <div className="sync-pill" data-state={state} data-tone={shown.tone} role={shown.tone === 'error' ? 'alert' : 'status'}>
                        {shown.busy && <span className="sync-pill-spin" aria-hidden="true" />}
                        <span>{shown.text}</span>
                        {shown.action && (
                            <button type="button" className="sync-pill-action" onClick={shown.action.onClick}>{shown.action.label}</button>
                        )}
                        <button type="button" aria-label="Dismiss" onClick={() => { setState('out'); setTimeout(() => { setShown(null); onDismiss?.(); }, 200); }}>×</button>
                    </div>
                </div>
            )}
        </>
    );
}

export function SyncChip({ status, onSync }) {
    // Re-render once a minute so "3 min ago" stays true.
    const [, tick] = useState(0);
    useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 60000); return () => clearInterval(t); }, []);

    const { phase, savedAt, places } = status;
    const label = phase === 'syncing' ? 'Updating'
        : phase === 'offline' ? 'Offline'
            : phase === 'error' ? 'Update failed'
                : savedAt ? 'Offline ready' : 'Saving map';
    const age = savedAt && phase !== 'syncing' ? describeAge(savedAt) : null;
    const icon = phase === 'syncing' || !savedAt
        ? <path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v4h-4" />
        : phase === 'offline' || phase === 'error'
            ? <path d="M12 8v5M12 16.5v.5" />
            : <path d="m6 12.5 4 4 8-9" />;
    return (
        <button
            type="button"
            className="mnav-chip sync-chip"
            data-phase={phase}
            onClick={() => onSync('manual')}
            disabled={phase === 'syncing'}
            aria-busy={phase === 'syncing'}
            aria-label={`${label}${age ? `, updated ${age}` : ''}. Tap to update now.`}
            title={`${savedAt ? `${places ?? 0} places saved on this phone, ${describeAge(savedAt)}. ` : ''}The map and weather update by themselves every 20 minutes. Tap to update now.`}
        >
            <span className="sync-chip-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">{icon}</svg>
            </span>
            <span className="sync-chip-label">{label}</span>
            {age && <span className="sync-chip-age">{age}</span>}
        </button>
    );
}
