import React, { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import { api } from '../api';
import { ActionBar, Sheet } from './MapControls';
import { addJoined } from '../shapeDraft';
import { confirmAction } from './ConfirmDialog';

// ── Campus area editor ──────────────────────────────────────────────
// An admin outlines a campus and names it (Campus A, Campus B, ...). Nodes and
// buildings then belong to the campus whose outline they sit in
// (src/campusAreas.js), so nothing has to be tagged one by one.
//
//   1. shape    tap the map to add corners; drag a corner to move it, tap a
//               corner to add the next ones after it; Undo steps back.
//   2. details  name and colour, then Save. Editing opens here; Reshape goes
//               back to step 1.

/** Outline colours on offer: distinct from department colours' usual greens/reds. */
export const AREA_COLORS = ['#38bdf8', '#a78bfa', '#f59e0b', '#f472b6', '#34d399', '#fb923c'];

const VERTEX_ICON = L.divIcon({
    className: '',
    html: '<div class="wall-node-pad"><div style="width:12px;height:12px;border-radius:50%;background:#fff;border:2px solid #111;box-shadow:0 1px 3px rgba(0,0,0,0.45);"></div></div>',
    iconSize: [28, 28],
    iconAnchor: [14, 14],
});
const VERTEX_ICON_SELECTED = L.divIcon({
    className: '',
    html: '<div class="wall-node-pad"><div style="width:16px;height:16px;border-radius:50%;background:#22c55e;border:3px solid #fff;box-shadow:0 0 0 3px rgba(34,197,94,0.35),0 1px 4px rgba(0,0,0,0.5);"></div></div>',
    iconSize: [28, 28],
    iconAnchor: [14, 14],
});

const AREA_CSS = `
    .ca-swatches { display: flex; flex-wrap: wrap; gap: 8px; }
    .ca-swatch {
        width: 44px; height: 44px; border-radius: 10px; border: 2px solid transparent; cursor: pointer;
        box-shadow: inset 0 0 0 1px rgba(0,0,0,0.25); -webkit-tap-highlight-color: transparent;
    }
    .ca-swatch[aria-checked="true"] { border-color: #fff; box-shadow: 0 0 0 2px rgba(255,255,255,0.25); }
    .ca-swatch:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
`;

export default function CampusAreaEditor({ map, record, areas, onSaved, onClose, onError, startStep = null }) {
    const [step, setStep] = useState(startStep || (record ? 'details' : 'shape'));
    const [points, setPoints] = useState(() => record?.polygon || []);
    const [anchor, setAnchor] = useState(null);
    const historyRef = useRef([]);
    const vertexPressAt = useRef(0);
    const layerRef = useRef(null);
    const nextName = () => {
        const taken = new Set((areas || []).map((a) => a.name));
        for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') if (!taken.has(`Campus ${letter}`)) return `Campus ${letter}`;
        return '';
    };
    const [name, setName] = useState(record?.name || nextName());
    const [color, setColor] = useState(record?.color || AREA_COLORS[(areas || []).length % AREA_COLORS.length]);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (!map) return undefined;
        const layer = L.layerGroup().addTo(map);
        layerRef.current = layer;
        return () => { layer.remove(); layerRef.current = null; };
    }, [map]);

    // The draft: outline (closed once it has 3 corners) and draggable corners.
    useEffect(() => {
        const layer = layerRef.current;
        if (!layer) return;
        layer.clearLayers();
        if (points.length === 0) return;
        const latlngs = points.map((p) => [p.lat, p.lng]);
        if (points.length >= 3) {
            L.polygon(latlngs, { color, weight: 3, dashArray: step === 'shape' ? null : '10, 6', fillColor: color, fillOpacity: 0.12, interactive: false }).addTo(layer);
        } else {
            L.polyline(latlngs, { color, weight: 3, interactive: false }).addTo(layer);
        }
        if (step !== 'shape') return;
        points.forEach((p, k) => {
            const vm = L.marker([p.lat, p.lng], {
                icon: anchor === k ? VERTEX_ICON_SELECTED : VERTEX_ICON, draggable: true, bubblingMouseEvents: false,
                zIndexOffset: anchor === k ? 1000 : 0, keyboard: true,
                title: anchor === k ? 'Selected: the next corner joins here' : 'Tap to add corners after this one, or drag to move it',
            }).addTo(layer);
            const stamp = () => { vertexPressAt.current = Date.now(); };
            vm.on('mousedown', stamp);
            vm.getElement()?.addEventListener('touchstart', stamp, { passive: true });
            vm.on('click', () => { stamp(); setAnchor((a) => (a === k ? null : k)); });
            vm.on('dragend', (e) => {
                stamp();
                const ll = e.target.getLatLng();
                setPoints((prev) => prev.map((q, i) => (i === k ? { lat: ll.lat, lng: ll.lng } : q)));
            });
        });
    }, [points, step, anchor, color]);

    // A tap on the map adds the next corner.
    useEffect(() => {
        if (!map || step !== 'shape') return undefined;
        const onClick = (e) => {
            if (Date.now() - vertexPressAt.current < 350) return;
            const next = addJoined(points, anchor, { lat: e.latlng.lat, lng: e.latlng.lng }, { closed: true });
            if (!next) return;
            historyRef.current.push({ points, anchor });
            setPoints(next.points);
            setAnchor(next.anchor);
        };
        map.on('click', onClick);
        return () => map.off('click', onClick);
    }, [map, step, points, anchor]);

    const undo = () => {
        const last = historyRef.current.pop();
        if (last) { setPoints(last.points); setAnchor(last.anchor); return; }
        setPoints((p) => p.slice(0, -1));
        setAnchor(null);
    };

    const save = async () => {
        if (!name.trim()) { onError('A campus area needs a name'); return; }
        if (points.length < 3) { onError('A campus area needs at least 3 corners'); return; }
        setSaving(true);
        try {
            const data = { name: name.trim(), color, polygon: points };
            if (record) await api.updateCampusArea(record.id, data);
            else await api.createCampusArea(data);
            onSaved(record ? `${data.name} updated` : `${data.name} drawn`);
        } catch (err) {
            onError(err.message);
        } finally {
            setSaving(false);
        }
    };

    const remove = async () => {
        if (!record) return;
        if (!(await confirmAction({
            title: `Remove ${record.name}?`,
            message: 'Only the outline goes. Nodes and buildings inside stay where they are; they simply stop belonging to this campus.',
            confirmLabel: 'Remove area', tone: 'danger',
        }))) return;
        setSaving(true);
        try {
            await api.deleteCampusArea(record.id);
            onSaved(`${record.name} removed`);
        } catch (err) {
            onError(err.message);
            setSaving(false);
        }
    };

    if (step === 'shape') {
        const ready = points.length >= 3;
        const hint = anchor !== null
            ? 'The green corner is selected: tap the map to add a corner joined to it. Tap it again to let go.'
            : points.length === 0
                ? 'Tap the map to put the first corner of the campus outline.'
                : ready
                    ? 'Tap a corner to add new ones after it, or drag one to reshape. Then press Next.'
                    : `Tap to add the next corner (${points.length} of at least 3).`;
        return (
            <ActionBar title={record ? `Reshape ${record.name}` : 'Draw a campus area'} hint={hint}>
                <button className="ui-btn ui-btn-secondary" onClick={undo} disabled={points.length === 0}>Undo</button>
                <button className="ui-btn ui-btn-primary" onClick={() => setStep('details')} disabled={!ready}>Next</button>
                <button className="ui-btn ui-btn-danger" onClick={record ? () => { setPoints(record.polygon || []); setAnchor(null); historyRef.current = []; setStep('details'); } : onClose}>
                    {record ? 'Back' : 'Cancel'}
                </button>
            </ActionBar>
        );
    }

    return (
        <Sheet
            title={record ? `Edit ${record.name}` : 'New campus area'}
            subtitle={`${points.length} corners`}
            onClose={onClose}
            footer={(
                <div className="mt-sheet-foot">
                    <button className="ui-btn ui-btn-primary" onClick={save} disabled={saving}>
                        {saving && <span className="btn-spin" aria-hidden="true" />}
                        {saving ? 'Saving' : 'Save'}
                    </button>
                    <button className="ui-btn ui-btn-secondary" onClick={() => setStep('shape')} disabled={saving}>Reshape</button>
                    {record
                        ? <button className="ui-btn ui-btn-danger" onClick={remove} disabled={saving}>Remove</button>
                        : <button className="ui-btn ui-btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>}
                </div>
            )}
        >
            <style>{AREA_CSS}</style>
            <div className="mt-form">
                <div className="ui-field">
                    <label className="ui-label" htmlFor="ca-name">Name <span className="ui-req">*</span></label>
                    <input id="ca-name" className="ui-input" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="e.g. Campus A" />
                </div>
                <div className="ui-field">
                    <span className="ui-label" id="ca-color-label">Outline colour</span>
                    <div className="ca-swatches" role="radiogroup" aria-labelledby="ca-color-label">
                        {AREA_COLORS.map((c) => (
                            <button
                                key={c} type="button" role="radio" aria-checked={color === c} aria-label={c}
                                className="ca-swatch" style={{ background: c }} onClick={() => setColor(c)}
                            />
                        ))}
                    </div>
                </div>
                <p className="ui-hint" style={{ margin: 0 }}>
                    Nodes and buildings inside this outline belong to {name.trim() || 'this campus'}: the map filter and the
                    students' campus picker use it. Nothing inside has to be tagged by hand.
                </p>
            </div>
        </Sheet>
    );
}
