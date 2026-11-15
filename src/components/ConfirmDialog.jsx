import React, { useEffect, useRef, useState } from 'react';
import { C, TYPE, PANEL_RADIUS, ELEVATION } from '../uiTokens';

// ── In-app confirmation ─────────────────────────────────────────────
// Replaces window.confirm(): the browser box cannot be styled, blocks the
// page, and on phones shows the site's address instead of what is at stake.
//
//   if (!(await confirmAction({ title, message, confirmLabel, tone: 'danger' }))) return;
//
// One <ConfirmHost /> is mounted by App.jsx. Focus starts on Cancel for
// destructive confirms (error prevention: Enter never deletes by accident),
// Esc and the backdrop cancel, and focus returns to where it was.

let pushRequest = null;
const queue = [];

/**
 * @param {{ title: string, message?: string, confirmLabel?: string, cancelLabel?: string, tone?: 'danger'|'primary' }} options
 * @returns {Promise<boolean>}
 */
export function confirmAction(options) {
    return new Promise((resolve) => {
        const request = { ...options, resolve };
        if (pushRequest) pushRequest(request);
        else queue.push(request);
    });
}

const CSS = `
    .cd-backdrop {
        position: fixed; inset: 0; z-index: 5000; display: grid; place-items: center; padding: 16px;
        background: rgba(0, 0, 0, 0.55);
        animation: cdFade 0.2s var(--ease-out, ease) both;
    }
    .cd-card {
        width: min(400px, 100%); padding: 20px; border-radius: ${PANEL_RADIUS}px;
        background: rgba(16, 16, 20, 0.98); border: 1px solid ${C.hairline};
        box-shadow: ${ELEVATION.overlay}; color: ${C.text};
        animation: cdRise 0.28s var(--ease-out, ease) both;
    }
    /* No red border on destructive confirms: only the destructive button carries the colour. */
    .cd-title { margin: 0; font-size: ${TYPE.lead}; font-weight: 700; color: ${C.white}; text-wrap: balance; }
    .cd-msg { margin: 8px 0 0; font-size: ${TYPE.sub}; line-height: 1.5; color: ${C.muted}; text-wrap: pretty; }
    .cd-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 20px; }
    .cd-actions .ui-btn { min-width: 96px; }
    @keyframes cdFade { from { opacity: 0; } }
    @keyframes cdRise { from { opacity: 0; transform: translateY(8px) scale(0.98); } }
    @media (prefers-reduced-motion: reduce) { .cd-backdrop, .cd-card { animation: none; } }
    @media (max-width: 480px) {
        .cd-backdrop { place-items: end center; padding: 12px 12px max(12px, env(safe-area-inset-bottom)); }
        .cd-actions { flex-direction: column-reverse; }
        .cd-actions .ui-btn { width: 100%; }
    }
`;

export function ConfirmHost() {
    const [request, setRequest] = useState(null);
    const cancelRef = useRef(null);
    const confirmRef = useRef(null);
    const returnFocus = useRef(null);

    useEffect(() => {
        pushRequest = (r) => setRequest((cur) => (cur ? (queue.push(r), cur) : r));
        if (queue.length) setRequest(queue.shift());
        return () => { pushRequest = null; };
    }, []);

    const close = (answer) => {
        request?.resolve(answer);
        setRequest(queue.shift() || null);
        const el = returnFocus.current;
        if (el && typeof el.focus === 'function') setTimeout(() => el.focus(), 0);
    };

    useEffect(() => {
        if (!request) return undefined;
        returnFocus.current = document.activeElement;
        const target = request.tone === 'danger' ? cancelRef.current : confirmRef.current;
        target?.focus();
        const onKey = (e) => {
            if (e.key === 'Escape') { e.preventDefault(); close(false); }
            if (e.key === 'Tab') {
                // Keep focus inside the dialog.
                const items = [cancelRef.current, confirmRef.current].filter(Boolean);
                const i = items.indexOf(document.activeElement);
                e.preventDefault();
                items[(i + (e.shiftKey ? -1 : 1) + items.length) % items.length]?.focus();
            }
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [request]);

    if (!request) return <style>{CSS}</style>;
    const danger = request.tone === 'danger';
    return (
        <>
            <style>{CSS}</style>
            <div className="cd-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) close(false); }}>
                <div
                    className={`cd-card${danger ? ' is-danger' : ''}`}
                    role="alertdialog" aria-modal="true" aria-labelledby="cd-title" aria-describedby={request.message ? 'cd-msg' : undefined}
                >
                    <h2 className="cd-title" id="cd-title">{request.title}</h2>
                    {request.message && <p className="cd-msg" id="cd-msg">{request.message}</p>}
                    <div className="cd-actions">
                        <button ref={cancelRef} type="button" className="ui-btn ui-btn-secondary" onClick={() => close(false)}>
                            {request.cancelLabel || 'Cancel'}
                        </button>
                        <button ref={confirmRef} type="button" className={`ui-btn ${danger ? 'ui-btn-destroy' : 'ui-btn-primary'}`} onClick={() => close(true)}>
                            {request.confirmLabel || (danger ? 'Remove' : 'Confirm')}
                        </button>
                    </div>
                </div>
            </div>
        </>
    );
}
