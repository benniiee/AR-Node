import React, { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { C, RADIUS, TAP } from '../uiTokens';

// A centred dialog for the staircase editor. The edit sheet is narrow and
// short, and a staircase has many settings (preview, shape, direction, slope,
// landing), so they get their own roomy surface instead of a long scroll.
//
//  - rendered in a portal on <body>, so the sheet can't clip or stack over it
//  - Esc or a tap on the dim background closes it; focus is kept inside and
//    returns to the button that opened it; the page behind does not scroll
//  - wide screens: preview beside the controls; phones: one column, full height

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export default function StairModal({ title, subtitle, onClose, children, footer, closeLabel = 'Close staircase editor' }) {
    const dialogRef = useRef(null);
    const titleId = useId();

    useEffect(() => {
        const opener = document.activeElement;
        const prevOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        dialogRef.current?.focus();
        return () => {
            document.body.style.overflow = prevOverflow;
            if (opener && typeof opener.focus === 'function') opener.focus();
        };
    }, []);

    const onKeyDown = (ev) => {
        if (ev.key === 'Escape') {
            ev.stopPropagation();
            ev.nativeEvent?.stopImmediatePropagation?.();
            onClose();
            return;
        }
        if (ev.key !== 'Tab') return;
        const items = [...dialogRef.current.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);
        if (items.length === 0) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (ev.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
            ev.preventDefault(); last.focus();
        } else if (!ev.shiftKey && document.activeElement === last) {
            ev.preventDefault(); first.focus();
        }
    };

    return createPortal(
        <div
            className="stair-modal-backdrop"
            onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
            onClick={(e) => e.stopPropagation()}
        >
            <style>{STAIR_MODAL_CSS}</style>
            <div
                ref={dialogRef}
                className="stair-modal"
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                tabIndex={-1}
                onKeyDown={onKeyDown}
            >
                <header className="stair-modal-head">
                    <div className="stair-modal-titles">
                        <h2 id={titleId} className="stair-modal-title">{title}</h2>
                        {subtitle && <span className="stair-modal-sub">{subtitle}</span>}
                    </div>
                    <button type="button" className="stair-modal-x" onClick={onClose} aria-label={closeLabel}>&times;</button>
                </header>
                <div className="stair-modal-body">{children}</div>
                {footer && <footer className="stair-modal-foot">{footer}</footer>}
            </div>
        </div>,
        document.body,
    );
}

const STAIR_MODAL_CSS = `
    .stair-modal-backdrop { position: fixed; inset: 0; z-index: 5000; display: flex; align-items: center; justify-content: center;
        padding: 16px; background: rgba(0, 0, 0, 0.72); backdrop-filter: blur(3px); -webkit-backdrop-filter: blur(3px); }
    .stair-modal { display: flex; flex-direction: column; width: min(1040px, 100%); max-height: min(92vh, 860px);
        background: ${C.surface}; color: ${C.text}; border: 1px solid ${C.hairline}; border-radius: ${RADIUS + 8}px;
        box-shadow: 0 24px 80px rgba(0, 0, 0, 0.6); outline: none; overflow: hidden; }
    .stair-modal-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 18px;
        border-bottom: 1px solid ${C.hairline}; }
    .stair-modal-titles { display: flex; flex-direction: column; min-width: 0; }
    .stair-modal-title { margin: 0; font-size: 18px; font-weight: 800; color: #fff; }
    .stair-modal-sub { font-size: 13px; color: ${C.muted}; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .stair-modal-x { flex: none; width: ${TAP.minHeight}; height: ${TAP.minHeight}; border-radius: 10px; border: 1px solid ${C.hairline}; background: transparent;
        color: #fff; font-size: 24px; line-height: 1; cursor: pointer; }
    .stair-modal-x:hover { background: ${C.surfaceHover}; }
    .stair-modal-x:focus-visible, .stair-modal .ui-btn:focus-visible { outline: 2px solid ${C.focus}; outline-offset: 2px; }
    /* Buttons inside the dialog, styled here too: /map does not load the admin CSS. */
    .stair-modal .ui-btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: ${TAP.minHeight}; padding: 0 18px;
        border-radius: 10px; border: 1px solid ${C.border}; background: ${C.surface}; color: ${C.text};
        font: inherit; font-size: 14px; font-weight: 700; cursor: pointer; transition: background-color 160ms ease, transform 160ms ease; }
    .stair-modal .ui-btn:hover:not(:disabled) { background: ${C.surfaceHover}; }
    .stair-modal .ui-btn:active:not(:disabled) { transform: scale(0.97); }
    .stair-modal .ui-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .stair-modal .ui-btn-primary { background: ${C.primary}; border-color: rgba(74, 222, 128, 0.6); color: #fff; }
    .stair-modal .ui-btn-primary:hover:not(:disabled) { background: ${C.primaryHover}; }
    .stair-modal-body { flex: 1 1 auto; overflow-y: auto; padding: 16px 18px; overscroll-behavior: contain; }
    .stair-modal-foot { display: flex; justify-content: flex-end; gap: 10px; flex-wrap: wrap; padding: 12px 18px;
        border-top: 1px solid ${C.hairline}; background: rgba(255,255,255,0.02); }
    @media (max-width: 760px) {
        .stair-modal-backdrop { padding: 0; align-items: flex-end; }
        .stair-modal { width: 100%; max-height: 96vh; border-radius: ${RADIUS + 8}px ${RADIUS + 8}px 0 0; }
        .stair-modal-foot .ui-btn { flex: 1 1 0; }
    }
`;
