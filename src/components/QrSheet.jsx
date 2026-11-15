import React, { useEffect, useMemo, useState } from 'react';
import { C, TYPE } from '../uiTokens';
import { floorAria, floorOf } from '../floors';
import { qrBaseUrl, qrUrlFor, isLocalAddress } from '../qrPosition';
import StairModal from './StairModal';

// ── QR codes to print (indoor positioning) ──────────────────────────
// One card per node: the code, the place name and floor, and a one-line "how".
// Students scan it with their phone's camera app; the link opens /map with
// their position and floor set to that spot (src/qrPosition.js).
// Print shows only the cards, two per row on A4/Letter.

const CSS = `
    .qr-sheet { display: flex; flex-direction: column; gap: 14px; }
    .qr-warn { margin: 0; padding: 10px 12px; border-radius: 10px; font-size: ${TYPE.desc}; line-height: 1.5; color: ${C.text};
        background: rgba(255, 176, 46, 0.08); border: 1px solid rgba(255, 176, 46, 0.35); }
    .qr-warn b { color: ${C.warning}; }
    .qr-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
    .qr-card { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 16px 14px; border-radius: 10px;
        background: #fff; color: #111; text-align: center; break-inside: avoid; }
    .qr-card svg { width: 100%; max-width: 200px; height: auto; display: block; }
    .qr-name { font-size: 16px; font-weight: 800; line-height: 1.25; }
    .qr-place { font-size: 13px; color: #444; }
    .qr-how { font-size: 11px; color: #555; line-height: 1.4; }
    .qr-loading { padding: 24px; text-align: center; color: ${C.muted}; font-size: ${TYPE.sub}; }
    @media print {
        body * { visibility: hidden !important; }
        .qr-print, .qr-print * { visibility: visible !important; }
        .qr-print { position: absolute; left: 0; top: 0; width: 100%; }
        .qr-grid { grid-template-columns: repeat(2, 1fr); gap: 10mm; }
        .qr-card { border: 1px solid #999; }
    }
`;

/** The QR matrix as one SVG path (no innerHTML). */
function QrSvg({ text, qrcode, label }) {
    const { size, path } = useMemo(() => {
        const qr = qrcode(0, 'M');
        qr.addData(text);
        qr.make();
        const n = qr.getModuleCount();
        let d = '';
        for (let r = 0; r < n; r += 1) {
            for (let c = 0; c < n; c += 1) if (qr.isDark(r, c)) d += `M${c + 4} ${r + 4}h1v1h-1z`;
        }
        return { size: n + 8, path: d };
    }, [text, qrcode]);
    return (
        <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} shapeRendering="crispEdges">
            <rect width={size} height={size} fill="#fff" />
            <path d={path} fill="#000" />
        </svg>
    );
}

export default function QrSheet({ nodes, title, subtitle, buildingsById, onClose }) {
    // The generator is only loaded when a sheet is opened.
    const [qrcode, setQrcode] = useState(null);
    const [loadError, setLoadError] = useState(null);
    useEffect(() => {
        let alive = true;
        import('qrcode-generator')
            .then((m) => { if (alive) setQrcode(() => m.default || m); })
            .catch(() => { if (alive) setLoadError('The QR code maker could not load. Check the connection and try again.'); });
        return () => { alive = false; };
    }, []);
    const base = qrBaseUrl();
    const local = isLocalAddress(base);

    const placeOf = (n) => {
        const b = n.building_id != null ? buildingsById?.get?.(n.building_id) : null;
        return [b ? (b.short_name || b.name) : null, floorAria(floorOf(n))].filter(Boolean).join(' · ');
    };

    return (
        <StairModal
            title={title}
            subtitle={subtitle}
            onClose={onClose}
            closeLabel="Close the QR codes"
            footer={(
                <>
                    <button type="button" className="ui-btn ui-btn-secondary" onClick={onClose}>Close</button>
                    <button type="button" className="ui-btn ui-btn-primary" onClick={() => window.print()} disabled={!qrcode || nodes.length === 0}>
                        Print {nodes.length === 1 ? 'code' : `${nodes.length} codes`}
                    </button>
                </>
            )}
        >
            <style>{CSS}</style>
            <div className="qr-sheet">
                {local && (
                    <p className="qr-warn">
                        <b>These codes point at {base}.</b> Phones on campus cannot open that address. Open the admin
                        console from the public https address (or set VITE_PUBLIC_URL) before printing.
                    </p>
                )}
                {loadError && <p className="qr-warn" role="alert">{loadError}</p>}
                {!qrcode && !loadError && <div className="qr-loading" role="status">Making the codes</div>}
                {qrcode && (
                    <div className="qr-print">
                        <div className="qr-grid">
                            {nodes.map((n) => (
                                <div className="qr-card" key={n.id}>
                                    <QrSvg qrcode={qrcode} text={qrUrlFor(n.id, base)} label={`QR code for ${n.name || 'this spot'}`} />
                                    <div className="qr-name">{n.name || (n.type === 'route' ? 'Route point' : 'Location')}</div>
                                    <div className="qr-place">{placeOf(n)}</div>
                                    <div className="qr-how">Scan with your phone camera to set your position here on the ARNode campus map.</div>
                                </div>
                            ))}
                        </div>
                    </div>
                )}
            </div>
        </StairModal>
    );
}
