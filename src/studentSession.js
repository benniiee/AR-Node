// Who is using /map: a signed-in student, or a visitor (guest).
//
// The student token lives in localStorage (it should survive closing the
// tab); the "view as visitor" choice only for this browser session, so a
// shared phone asks again next time. Every call is wrapped: storage can be
// blocked (private mode) and the map must still work as a visitor.

import { API_BASE, TUNNEL_HEADERS } from './mobileApi.js';
import { offlineStore } from './offlineStore.js';
import { clearOfflineData } from './offlineData.js';

const TOKEN_KEY = 'student_token';
const PROFILE_KEY = 'student_profile';
const GUEST_KEY = 'map_guest';

const read = (store, key) => { try { return store.getItem(key); } catch { return null; } };
const write = (store, key, value) => { try { if (value === null) store.removeItem(key); else store.setItem(key, value); } catch { /* blocked */ } };

/** The session saved on this browser, or null (show the sign-in screen). */
export function savedSession() {
    const token = read(localStorage, TOKEN_KEY);
    if (token) {
        let user = null;
        try { user = JSON.parse(read(localStorage, PROFILE_KEY) || 'null'); } catch { user = null; }
        return { role: 'student', token, user };
    }
    return read(sessionStorage, GUEST_KEY) === '1' ? { role: 'visitor' } : null;
}

/** Request headers for map calls: the bearer token when signed in. */
export function sessionHeaders(session) {
    return session?.token ? { ...TUNNEL_HEADERS, Authorization: `Bearer ${session.token}`, Accept: 'application/json' } : TUNNEL_HEADERS;
}

async function call(path, { method = 'GET', body, token } = {}) {
    let res;
    try {
        res = await fetch(`${API_BASE}/api${path}`, {
            method,
            headers: {
                ...TUNNEL_HEADERS, Accept: 'application/json', 'Content-Type': 'application/json',
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            body: body ? JSON.stringify(body) : undefined,
        });
    } catch {
        const err = new Error('Cannot reach the campus server. Check your connection, or continue as a visitor.');
        err.offline = true;
        throw err;
    }
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    if (!res.ok) {
        const first = data?.errors && Object.values(data.errors).flat()[0];
        const err = new Error(res.status === 429
            ? 'Too many attempts. Wait a minute, then try again.'
            : first || data?.message || 'Sign-in did not work. Check your school ID and password, then try again.');
        err.status = res.status;
        throw err;
    }
    return data;
}

/** Sign in with a school ID (ae202401622) or school email. */
export async function signInStudent(login, password) {
    const data = await call('/student/login', { method: 'POST', body: { login, password } });
    write(localStorage, TOKEN_KEY, data.token);
    write(localStorage, PROFILE_KEY, JSON.stringify(data.user));
    write(sessionStorage, GUEST_KEY, null);
    return { role: 'student', token: data.token, user: data.user };
}

/**
 * Check a saved token is still valid. Resolves the fresh session; rejects with
 * status 401 when the token was revoked or expired. Offline keeps the saved
 * profile (the saved map still works without a network).
 */
export async function verifySession(session) {
    try {
        const user = await call('/student/me', { token: session.token });
        write(localStorage, PROFILE_KEY, JSON.stringify(user));
        return { ...session, user };
    } catch (err) {
        if (err.offline) return session;
        if (err.status === 401 || err.status === 403) await forgetStudent();
        throw err;
    }
}

/**
 * Choose a new password (required after an admin reset). Resolves the session
 * with the updated profile.
 */
export async function changeStudentPassword(session, currentPassword, password, confirmation) {
    const data = await call('/student/password', {
        method: 'POST',
        token: session.token,
        body: { current_password: currentPassword, password, password_confirmation: confirmation },
    });
    write(localStorage, PROFILE_KEY, JSON.stringify(data.user));
    return { ...session, user: data.user };
}

export function continueAsVisitor() {
    write(sessionStorage, GUEST_KEY, '1');
    return { role: 'visitor' };
}

async function forgetStudent() {
    write(localStorage, TOKEN_KEY, null);
    write(localStorage, PROFILE_KEY, null);
    // The full map must not stay readable on the phone after sign-out.
    await clearOfflineData(offlineStore);
}

/** Sign out: revoke the token on the server (best effort) and wipe local data. */
export async function signOut(session) {
    if (session?.token) {
        try { await call('/student/logout', { method: 'POST', token: session.token }); } catch { /* offline: local wipe still happens */ }
    }
    await forgetStudent();
    write(sessionStorage, GUEST_KEY, null);
}
