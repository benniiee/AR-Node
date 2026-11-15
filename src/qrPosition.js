// QR codes for indoor positioning.
//
// GPS is weak inside buildings, so admins print a QR code for a room, stair or
// door. It holds a plain link to the student app, /map?at=<node id>. A student
// scans it with the phone's own camera app (iOS and Android read QR codes
// without any extra app); the link opens the map, which sets their position
// and floor to that node. No scanner runs inside the app.

/** Query parameter that carries the node id. */
export const QR_PARAM = 'at';

/**
 * Public address the printed codes point at. VITE_PUBLIC_URL wins (set it to
 * the real https address before printing); otherwise the admin page's own
 * origin, which is right when the admin console and /map share a host.
 */
export function qrBaseUrl(origin = typeof window !== 'undefined' ? window.location.origin : '') {
    const configured = (import.meta.env?.VITE_PUBLIC_URL || '').replace(/\/$/, '');
    return configured || String(origin || '').replace(/\/$/, '');
}

/** The link printed in the QR code for one node. */
export function qrUrlFor(nodeId, base = qrBaseUrl()) {
    return `${base}/map?${QR_PARAM}=${encodeURIComponent(String(nodeId))}`;
}

/** The node id a scanned link carries, or null. Accepts only positive whole numbers. */
export function qrNodeIdFrom(search) {
    let value = null;
    try { value = new URLSearchParams(search || '').get(QR_PARAM); } catch { return null; }
    if (!value || !/^\d{1,10}$/.test(value)) return null;
    const id = Number(value);
    return id > 0 ? id : null;
}

/**
 * Was this link printed by an admin who was not on the public address? A code
 * pointing at localhost or a private LAN address will not open on a student's
 * phone, so the print sheet warns about it.
 */
export function isLocalAddress(base) {
    try {
        const host = new URL(base).hostname;
        return host === 'localhost' || host === '127.0.0.1' || host === '[::1]'
            || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
    } catch {
        return true;
    }
}
