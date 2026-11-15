import React from 'react';

/**
 * The small "i in a circle" that marks a hover explanation (the explanation itself is the
 * parent's `data-tip`, shown by TooltipLayer). 16px, centred on the text beside it.
 */
export default function InfoIcon() {
    return (
        <svg className="ui-info-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <circle cx="8" cy="8" r="6.75" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path d="M8 7.25v4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            <circle cx="8" cy="4.9" r="0.95" fill="currentColor" />
        </svg>
    );
}
