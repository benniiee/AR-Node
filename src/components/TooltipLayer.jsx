import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/*
 * One tooltip for the whole app, mounted once (App.jsx, mobile.jsx).
 *
 * Any element with a `title` or `data-tip` attribute gets it: the browser's own tooltip
 * (tiny, slow, mouse-only) is replaced by a readable one. The `title` is moved to `data-tip`
 * the first time so the two never show together.
 *
 * - Mouse/pen hover after HOVER_DELAY, keyboard focus at once (focus-visible only); never on
 *   touch taps. Esc, scrolling or leaving hides it.
 * - Drawn in a portal on <body>, so no animation, card or overflow can hide it behind other
 *   content. Centred over the element, flipped below near the top, kept inside the screen.
 */
const HOVER_DELAY = 300;
const GAP = 8;
const EDGE = 8;

export default function TooltipLayer() {
    const [tip, setTip] = useState(null); // { text, rect }
    const boxRef = useRef(null);
    const [pos, setPos] = useState(null);

    useEffect(() => {
        let host = null;
        let timer = 0;

        const tipText = (el) => {
            if (el.hasAttribute('title')) {
                const t = el.getAttribute('title');
                el.removeAttribute('title');
                if (t) el.dataset.tip = t;
            }
            return el.dataset.tip || '';
        };
        const findHost = (target) => (target instanceof Element ? target.closest('[title], [data-tip]') : null);
        const show = (el, delay) => {
            const text = tipText(el);
            clearTimeout(timer);
            host = el;
            if (!text) { setTip(null); return; }
            timer = setTimeout(() => {
                if (host !== el || !el.isConnected) return;
                // Point at the ⓘ when there is one: a wide card or heading row would otherwise
                // put the tooltip far from what the user is looking at.
                const anchor = el.querySelector('.ui-info-icon') || el;
                setTip({ text, rect: anchor.getBoundingClientRect() });
            }, delay);
        };
        const hide = () => { clearTimeout(timer); host = null; setTip(null); };

        const onOver = (e) => {
            if (e.pointerType === 'touch') return;
            const el = findHost(e.target);
            if (el === host) return;
            if (el) show(el, HOVER_DELAY); else if (host) hide();
        };
        const onOut = (e) => {
            if (host && !(e.relatedTarget instanceof Node && host.contains(e.relatedTarget))) hide();
        };
        const onFocus = (e) => {
            const el = findHost(e.target);
            if (el && e.target.matches?.(':focus-visible')) show(el, 0);
        };
        const onKey = (e) => { if (e.key === 'Escape') hide(); };

        document.addEventListener('pointerover', onOver);
        document.addEventListener('pointerout', onOut);
        document.addEventListener('focusin', onFocus);
        document.addEventListener('focusout', hide);
        document.addEventListener('keydown', onKey);
        window.addEventListener('scroll', hide, true);
        window.addEventListener('resize', hide);
        return () => {
            clearTimeout(timer);
            document.removeEventListener('pointerover', onOver);
            document.removeEventListener('pointerout', onOut);
            document.removeEventListener('focusin', onFocus);
            document.removeEventListener('focusout', hide);
            document.removeEventListener('keydown', onKey);
            window.removeEventListener('scroll', hide, true);
            window.removeEventListener('resize', hide);
        };
    }, []);

    // Measure, then centre over the element (below it when there is no room above).
    useLayoutEffect(() => {
        if (!tip || !boxRef.current) { setPos(null); return; }
        const { width, height } = boxRef.current.getBoundingClientRect();
        const r = tip.rect;
        const above = r.top - GAP - height;
        const top = above >= EDGE ? above : Math.min(r.bottom + GAP, window.innerHeight - height - EDGE);
        const left = Math.max(EDGE, Math.min(r.left + r.width / 2 - width / 2, window.innerWidth - width - EDGE));
        setPos({ top, left });
    }, [tip]);

    if (!tip) return null;
    return createPortal(
        <div ref={boxRef} role="tooltip" className="ui-tooltip" style={pos ? { top: pos.top, left: pos.left } : { top: -9999, left: -9999 }}>
            {tip.text}
        </div>,
        document.body,
    );
}
