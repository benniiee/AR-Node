import React from 'react';
import { ActionBar, Sheet, Segmented } from './MapControls';
import { OBJECT_KINDS, TREE_FORMS, kindLabel, newSeed } from '../campusObjects';

/** A number field in metres (or degrees), clamped on blur by the server's limits. */
function NumberField({ id, label, value, onChange, step = 0.1, min = 0.2, max = 40, unit = 'm' }) {
    return (
        <div className="ui-field">
            <label className="ui-label" htmlFor={id}>{label}</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input
                    id={id} className="ui-input" type="number" inputMode="decimal" step={step} min={min} max={max}
                    value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
                    style={{ maxWidth: 120 }}
                />
                <span className="ui-hint" style={{ margin: 0 }}>{unit}</span>
            </div>
        </div>
    );
}

/**
 * Campus objects tool (admin): pick what to place (tree, bench, shed, gate) and tap the map, like placing
 * buildings in a city-builder game. A placed object, when tapped, opens here to change its size and look;
 * a tap on the map then moves it.
 */
export default function ObjectPalette({ count, placeKind, onPlaceKind, selected, onChange, onSave, onDelete, onDeselect, onDone, saving = false, note = null }) {
    if (!selected) {
        return (
            <ActionBar
                title={`Trees, benches, sheds and gates (${count} placed)`}
                hint={note || `Tap the map to place a ${kindLabel(placeKind).toLowerCase()}${placeKind === 'gate' ? ' on a wall (it snaps onto the nearest one and opens it)' : ''}. Tap a placed one to change it.`}
            >
                <Segmented label="What to place" value={placeKind} onChange={onPlaceKind} options={OBJECT_KINDS.map((k) => ({ value: k.value, label: k.label }))} />
                <button className="ui-btn ui-btn-primary" onClick={onDone}>Done</button>
            </ActionBar>
        );
    }
    const set = (field) => (v) => onChange({ [field]: v });
    const kind = selected.kind;
    return (
        <Sheet
            title={kindLabel(kind)}
            subtitle={note || 'Tap the map to move it here.'}
            onClose={onDeselect}
            footer={(
                <div className="mt-sheet-foot">
                    <button className="ui-btn ui-btn-primary" onClick={onSave} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
                    <button className="ui-btn ui-btn-secondary" onClick={onDeselect} disabled={saving}>Cancel</button>
                    <button className="ui-btn ui-btn-danger" onClick={onDelete} disabled={saving}>Remove</button>
                </div>
            )}
        >
            {kind === 'tree' && (
                <>
                    <div className="ui-field">
                        <label className="ui-label" htmlFor="obj-form">Shape</label>
                        <select id="obj-form" className="ui-input" value={selected.form || 'round'} onChange={(e) => onChange({ form: e.target.value })}>
                            {TREE_FORMS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                        </select>
                    </div>
                    <NumberField id="obj-h" label="Height" value={selected.height_m} onChange={set('height_m')} step={0.5} />
                    <NumberField id="obj-w" label="Crown width" value={selected.width_m} onChange={set('width_m')} step={0.5} />
                    <button className="ui-btn ui-btn-secondary" onClick={() => onChange({ seed: newSeed() })}>New look (same size)</button>
                    <p className="ui-hint" style={{ margin: 0 }}>Each look is kept: the tree stays the same on every phone. Its shade counts for routes on hot days.</p>
                </>
            )}
            {kind === 'bench' && (
                <>
                    <NumberField id="obj-l" label="Length" value={selected.length_m} onChange={set('length_m')} />
                    <NumberField id="obj-r" label="Facing" value={selected.rotation_deg} onChange={set('rotation_deg')} step={5} min={0} max={360} unit="°" />
                </>
            )}
            {kind === 'shed' && (
                <>
                    <NumberField id="obj-w" label="Width" value={selected.width_m} onChange={set('width_m')} />
                    <NumberField id="obj-l" label="Length" value={selected.length_m} onChange={set('length_m')} />
                    <NumberField id="obj-h" label="Roof height" value={selected.height_m} onChange={set('height_m')} />
                    <NumberField id="obj-r" label="Facing" value={selected.rotation_deg} onChange={set('rotation_deg')} step={5} min={0} max={360} unit="°" />
                </>
            )}
            {kind === 'gate' && (
                <>
                    <NumberField id="obj-w" label="Opening width" value={selected.width_m} onChange={set('width_m')} />
                    <NumberField id="obj-h" label="Pillar height" value={selected.height_m} onChange={set('height_m')} />
                    <NumberField id="obj-r" label="Facing (along the wall)" value={selected.rotation_deg} onChange={set('rotation_deg')} step={5} min={0} max={360} unit="°" />
                    <p className="ui-hint" style={{ margin: 0 }}>Routes pass through the wall here. Moving it snaps it onto the nearest wall.</p>
                </>
            )}
        </Sheet>
    );
}
