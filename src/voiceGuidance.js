// Spoken directions for the AR / 3D navigation view, with the browser's own speech
// (Web Speech API): no library, no server. Phones speak with their installed voices, which
// work offline (Android: the Google speech voice; iPhone: Apple's built-in voices); an
// on-device ("local") English voice is preferred when the browser lists one.
//
// The turn word ("Turn left") follows where the phone points, so it flickers while the
// student turns. A direction is spoken only after it has stayed the same for STEADY_MS,
// at most once every MIN_GAP_MS, and never queued behind an older one.

export const STEADY_MS = 1500;
export const MIN_GAP_MS = 3000;

/** Whether this browser can speak at all (the Voice button is hidden otherwise). */
export function speechAvailable() {
    return typeof window !== 'undefined' && 'speechSynthesis' in window && typeof window.SpeechSynthesisUtterance === 'function';
}

/**
 * The sentence for one guidance card ({ main, sub } from routeFormat.guidanceFor): the direction only
 * ("Turn left."). The distance stays on screen; saying it every time is noise while walking.
 */
export function spokenText({ main }) {
    return `${String(main || '').trim()}.`;
}

function englishVoice() {
    const voices = window.speechSynthesis.getVoices() || [];
    const en = voices.filter((v) => /^en(-|_|$)/i.test(v.lang));
    return en.find((v) => v.localService) || en[0] || null;
}

/** Speak now, replacing anything still being said. Safe to call when speech is missing. */
export function say(text) {
    if (!speechAvailable() || !text) return;
    const synth = window.speechSynthesis;
    synth.cancel();
    const u = new window.SpeechSynthesisUtterance(text);
    const voice = englishVoice();
    if (voice) u.voice = voice;
    u.lang = voice?.lang || 'en-US';
    u.rate = 1;
    synth.speak(u);
}

/** Stop speaking at once (Voice switched off, view closed). */
export function hush() {
    if (speechAvailable()) window.speechSynthesis.cancel();
}

/**
 * Decides WHEN to speak, so it can be tested without a browser. `speak(text)` does the talking.
 * update(guidance, nowMs) is called every frame; arrive(place) once on arrival.
 */
export function createVoiceGuide(speak) {
    let pending = null;
    let pendingSince = 0;
    let spokenMain = null;
    let lastAt = -Infinity;
    let arrived = false;
    return {
        update(guidance, now) {
            if (arrived || !guidance?.main) return;
            if (guidance.main !== pending) {
                pending = guidance.main;
                pendingSince = now;
            }
            if (pending !== spokenMain && now - pendingSince >= STEADY_MS && now - lastAt >= MIN_GAP_MS) {
                spokenMain = pending;
                lastAt = now;
                speak(spokenText(guidance));
            }
        },
        arrive(place) {
            if (arrived) return;
            arrived = true;
            speak(`You've arrived at ${place || 'your destination'}.`);
        },
        /** Say the current direction again right away (the Voice button was just switched on). */
        repeat(guidance, now) {
            if (!guidance?.main) return;
            pending = spokenMain = guidance.main;
            pendingSince = lastAt = now;
            speak(spokenText(guidance));
        },
    };
}
