import React, { useCallback, useEffect, useRef, useState } from 'react';
import { C, TYPE } from '../uiTokens';

// ── ScrollWindow: one rule for every list that can grow ─────────────
// A list shows at most `rows` items (`phoneRows` on phones), then scrolls
// inside itself, so a long list never pushes the rest of the panel or page
// off screen. Two cues say there is more (visibility of system status):
//   - the edge with hidden items fades out (CSS mask), and
//   - a hint under the list counts what is hidden: "6 more, scroll to see them".
//
// Row height is the list's own (`rowHeight` px); the window is rows x rowHeight
// so the cut always falls between two items, never through one.
//
//   <ScrollWindow as="ul" rows={4} phoneRows={3} rowHeight={30} count={items.length} label="Departments">
//       {items.map(...)}
//   </ScrollWindow>

export const LIST_CSS = `
    .sw {
        --sw-rows: var(--sw-desktop-rows);
        --sw-row-h: var(--sw-desktop-row-h);
        max-height: calc(var(--sw-rows) * var(--sw-row-h));
        overflow-y: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch;
        scrollbar-width: thin; scrollbar-color: rgba(255, 255, 255, 0.26) transparent;
        scroll-behavior: smooth;
    }
    .sw::-webkit-scrollbar { width: 8px; }
    .sw::-webkit-scrollbar-track { background: transparent; }
    .sw::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.24); border: 2px solid transparent; border-radius: 10px; background-clip: padding-box; }
    .sw:focus-visible { outline: 2px solid ${C.focus}; outline-offset: 2px; border-radius: 8px; }
    /* Fade the edge(s) that still hide items. */
    .sw[data-more="end"] { -webkit-mask-image: linear-gradient(to bottom, #000 calc(100% - 28px), transparent); mask-image: linear-gradient(to bottom, #000 calc(100% - 28px), transparent); }
    .sw[data-more="start"] { -webkit-mask-image: linear-gradient(to top, #000 calc(100% - 28px), transparent); mask-image: linear-gradient(to top, #000 calc(100% - 28px), transparent); }
    .sw[data-more="both"] {
        -webkit-mask-image: linear-gradient(to bottom, transparent, #000 28px, #000 calc(100% - 28px), transparent);
        mask-image: linear-gradient(to bottom, transparent, #000 28px, #000 calc(100% - 28px), transparent);
    }
    .sw-hint { margin: 6px 0 0; font-size: ${TYPE.desc}; line-height: 1.35; color: ${C.muted}; transition: opacity 160ms ease; }
    .sw-hint[data-done="true"] { opacity: 0.55; }
    @media (max-width: 640px) { .sw { --sw-rows: var(--sw-phone-rows); --sw-row-h: var(--sw-phone-row-h); } }
`;

export default function ScrollWindow({
    as: Tag = 'div', rows, phoneRows = rows, rowHeight, phoneRowHeight = rowHeight, count, label, noun = 'more',
    className = '', style, children, ...rest
}) {
    const ref = useRef(null);
    const [more, setMore] = useState('none');
    const [hidden, setHidden] = useState(0);

    const measure = useCallback(() => {
        const el = ref.current;
        if (!el) return;
        const overflow = el.clientHeight > 24 && el.scrollHeight - el.clientHeight > 2;
        const atTop = el.scrollTop <= 2;
        const atEnd = el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
        setMore(!overflow ? 'none' : atTop ? 'end' : atEnd ? 'start' : 'both');
        // Items below the window right now; the real row height is measured
        // (it differs between desktop and phone layouts).
        const rowH = el.firstElementChild?.offsetHeight || rowHeight;
        const visibleRows = Math.max(1, Math.floor((el.clientHeight + 2) / rowH));
        const scrolledRows = Math.round(el.scrollTop / rowH);
        setHidden(overflow ? Math.max(0, (count ?? 0) - visibleRows - scrolledRows) : 0);
    }, [count, rowHeight]);

    useEffect(() => {
        measure();
        const el = ref.current;
        if (!el || typeof ResizeObserver === 'undefined') return undefined;
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        return () => ro.disconnect();
    }, [measure, children]);

    const overflowing = more !== 'none';
    return (
        <>
            <Tag
                ref={ref}
                className={`sw ${className}`.trim()}
                data-more={more}
                onScroll={measure}
                // Keyboard users can scroll it only when there is something to scroll.
                tabIndex={overflowing ? 0 : undefined}
                aria-label={label}
                style={{
                    '--sw-desktop-rows': rows, '--sw-phone-rows': phoneRows,
                    '--sw-desktop-row-h': `${rowHeight}px`, '--sw-phone-row-h': `${phoneRowHeight}px`, ...style,
                }}
                {...rest}
            >
                {children}
            </Tag>
            {overflowing && count != null && (
                <p className="sw-hint" data-done={hidden === 0 ? 'true' : 'false'} aria-live="polite">
                    {hidden > 0 ? `${hidden} ${noun}, scroll to see them` : `Showing all ${count}`}
                </p>
            )}
        </>
    );
}

/**
 * Same edge-fade cue for a list that is not React (a Leaflet popup's HTML).
 * Give the element the `sw` class and the --sw-* variables in its style, then
 * call this once it is in the page. Returns a cleanup function.
 */
export function bindScrollCue(el) {
    if (!el) return () => {};
    const update = () => {
        // A list still being laid out (clientHeight ~0 inside an opening popup)
        // is not "overflowing": fading it would fade its only row.
        const overflow = el.clientHeight > 24 && el.scrollHeight - el.clientHeight > 2;
        const atTop = el.scrollTop <= 2;
        const atEnd = el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
        el.dataset.more = !overflow ? 'none' : atTop ? 'end' : atEnd ? 'start' : 'both';
        el.tabIndex = overflow ? 0 : -1;
    };
    update();
    const raf = requestAnimationFrame(update);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    ro?.observe(el);
    el.addEventListener('scroll', update, { passive: true });
    return () => { cancelAnimationFrame(raf); ro?.disconnect(); el.removeEventListener('scroll', update); };
}
