// Installable app (PWA) for the /map navigation app.
//
// registerServiceWorker(): saves the app on the phone (public/sw.js, generated from
// resources/pwa/service-worker.js by `npm run build`) so it opens offline. Only in a
// production build on HTTPS or localhost: the Vite dev server never registers one,
// so hot reloading keeps working.
//
// useInstallPrompt(): whether "Install app" can be offered. Android/desktop Chrome and
// Edge fire `beforeinstallprompt`; iPhone/iPad have no prompt, only Safari's
// Share > Add to Home Screen, so there we return `iosHint: true` instead.
import { useEffect, useState } from 'react';

export function registerServiceWorker() {
    if (!import.meta.env.PROD || typeof navigator === 'undefined' || !('serviceWorker' in navigator) || !window.isSecureContext) {
        return;
    }
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js', { scope: '/map' }).catch(() => {
            // No offline copy this visit; the app itself still works online.
        });
    });
}

// The browser can fire beforeinstallprompt before React mounts, so it is caught here, once.
let deferredPrompt = null;
const listeners = new Set();
const notify = () => listeners.forEach((fn) => fn());

if (typeof window !== 'undefined') {
    window.addEventListener('beforeinstallprompt', (event) => {
        event.preventDefault(); // show our own button instead of the browser's mini bar
        deferredPrompt = event;
        notify();
    });
    window.addEventListener('appinstalled', () => {
        deferredPrompt = null;
        notify();
    });
}

/** Already running as the installed app (home-screen icon), not in a browser tab. */
export function isStandalone() {
    if (typeof window === 'undefined') return false;
    return window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

/** iPhone or iPad (iPadOS reports itself as a Mac with touch). */
export function isIos() {
    if (typeof navigator === 'undefined') return false;
    return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

/**
 * @returns {{ canInstall: boolean, iosHint: boolean, install: () => Promise<boolean> }}
 *   canInstall: the browser's install dialog is available (call install()).
 *   iosHint: iPhone/iPad in Safari, not yet installed: show the Add to Home Screen steps.
 */
export function useInstallPrompt() {
    const [, setTick] = useState(0);
    useEffect(() => {
        const update = () => setTick((n) => n + 1);
        listeners.add(update);
        return () => { listeners.delete(update); };
    }, []);

    const standalone = isStandalone();
    return {
        canInstall: Boolean(deferredPrompt) && !standalone,
        iosHint: isIos() && !standalone,
        install: async () => {
            const prompt = deferredPrompt;
            if (!prompt) return false;
            deferredPrompt = null;
            notify();
            prompt.prompt();
            const choice = await prompt.userChoice.catch(() => null);
            return choice?.outcome === 'accepted';
        },
    };
}
