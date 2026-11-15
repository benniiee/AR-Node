import React, { useState } from 'react';
import { API_BASE } from '../mobileApi';
import { C, TAP, TYPE, PILL } from '../uiTokens';

/**
 * "It's raining here" for signed-in students: the fastest rain signal the app has. When enough
 * different people report within a few minutes (server: weather.reports_min_people), everyone's
 * routes switch to "raining now" on their next weather poll; the reporter's phone at once, from the
 * reply. Reports only ever turn rain ON, so a wrong tap can only send people under cover.
 *
 * Hidden while it is already raining (nothing to add). One report per person every 5 minutes
 * (server limiter); the reply says so instead of failing silently.
 */
export default function RainReportButton({ headers, onWeather }) {
    const [state, setState] = useState({ kind: 'idle', note: null });

    const send = async () => {
        if (state.kind === 'sending') return;
        setState({ kind: 'sending', note: null });
        try {
            const res = await fetch(`${API_BASE}/api/weather/rain-report`, {
                method: 'POST',
                headers: { ...headers, Accept: 'application/json' },
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) {
                setState({ kind: res.status === 429 ? 'sent' : 'error', note: body.message || 'Could not send. Try again.' });
                return;
            }
            onWeather?.(body);
            const people = Number(body.rain_reports) || 1;
            const needed = Number(body.rain_reports_min) || 2;
            setState({
                kind: 'sent',
                note: body.raining_now
                    ? 'Thanks. Rain confirmed: routes now avoid open paths.'
                    : `Thanks. ${people} of ${needed} reports needed to switch routes to covered paths.`,
            });
        } catch {
            setState({ kind: 'error', note: 'No connection. Try again when you are online.' });
        }
    };

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingTop: 6, minWidth: 0 }}>
            <button
                type="button"
                onClick={send}
                aria-busy={state.kind === 'sending'}
                style={{
                    alignSelf: 'flex-start', minHeight: TAP.minHeight, padding: '0 14px',
                    border: `1px solid ${C.fieldBorder}`, borderRadius: PILL, background: 'transparent',
                    color: C.text, font: 'inherit', fontSize: 13, fontWeight: 700, cursor: 'pointer',
                }}
            >
                {state.kind === 'sending' ? 'Sending...' : state.kind === 'sent' ? 'Sent: it is raining here' : "It's raining here"}
            </button>
            {state.note && (
                <span style={{ fontSize: TYPE.desc, color: state.kind === 'error' ? C.warning : C.muted, lineHeight: 1.4 }}>
                    {state.note}
                </span>
            )}
        </div>
    );
}
