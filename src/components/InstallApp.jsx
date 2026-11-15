import React, { useState } from 'react';
import { useInstallPrompt } from '../pwa';

/**
 * "Install app" on Android and desktop Chrome/Edge (opens the browser's install dialog),
 * "Add to Home Screen" on iPhone/iPad (shows Safari's steps, the only way there).
 * Renders nothing once installed or where the browser cannot install the app.
 *
 * Styling comes from the host screen (buttonClass / hintClass) so the button matches
 * its neighbours. `children(label)` may render a richer button body.
 */
export default function InstallApp({ buttonClass, hintClass, children }) {
    const { canInstall, iosHint, install } = useInstallPrompt();
    const [showSteps, setShowSteps] = useState(false);

    if (!canInstall && !iosHint) return null;

    const label = canInstall ? 'Install app' : 'Add to Home Screen';
    return (
        <>
            <button
                type="button" className={buttonClass}
                onClick={() => (canInstall ? install() : setShowSteps((v) => !v))}
                aria-expanded={canInstall ? undefined : showSteps}
            >
                {children ? children(label) : label}
            </button>
            {showSteps && (
                <p className={hintClass} role="status">
                    Tap Share
                    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" style={{ margin: '0 4px', verticalAlign: '-2px' }}>
                        <path d="M8 1.5v8M5 4.5l3-3 3 3M3.5 7.5v6h9v-6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    , then Add to Home Screen.
                </p>
            )}
        </>
    );
}
