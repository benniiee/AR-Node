import React, { useId, useState } from 'react';
import { Sheet, Segmented } from './MapControls';
import ScrollWindow from './ScrollWindow';
import { C, TYPE, PILL, TAP } from '../uiTokens';
import { buildingFloors } from '../campusGeometry';
import { floorOf, floorTag, floorAria } from '../floors';

// ── Manage nodes: one building's rooms and route nodes, floor by floor ──
// Opened from a building's (or a bridge's: `belongs`, `floors`, `note`) Edit panel. The map shows the chosen floor cut
// away inside the building (lower floors grey), the list shows that floor's
// nodes with Edit / Remove, and department staff add new ones on that floor.
// Editing or adding a node returns here when it is done.

export const MANAGE_NODES_CSS = `
    .mn-floors { margin-bottom: 12px; display: flex; flex-direction: column; gap: 6px; }
    .mn-floors .seg > button { min-height: 40px; }
    .mn-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
    .mn-row {
        display: flex; align-items: center; gap: 10px; min-height: 52px; padding: 6px 6px 6px 12px;
        border: 1px solid ${C.hairline}; border-radius: 12px; background: rgba(255,255,255,0.03);
        animation: uiFadeUp var(--dur-base, 220ms) var(--ease-out, ease) both;
    }
    .mn-group { padding: 6px 2px 0; font-size: ${TYPE.desc}; font-weight: 700; color: ${C.muted}; }
    .mn-group:first-child { padding-top: 0; }
    .mn-name { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: flex-start; justify-content: center; min-height: 40px;
        padding: 0; border: 0; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; border-radius: 6px; }
    .mn-name:hover b { text-decoration: underline; text-underline-offset: 3px; }
    .mn-name:focus-visible { outline: ${TAP.focusOutline}; outline-offset: 2px; }
    .mn-name b { max-width: 100%; font-size: ${TYPE.sub}; font-weight: 600; color: ${C.white}; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .mn-name span { max-width: 100%; font-size: ${TYPE.desc}; color: ${C.muted}; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .mn-actions { flex: none; display: flex; gap: 6px; }
    .mn-view-only { flex: none; padding-right: 8px; font-size: ${TYPE.desc}; color: ${C.muted}; }
    .mn-empty { margin: 0; padding: 14px 12px; border: 1px dashed ${C.hairline}; border-radius: 12px; font-size: ${TYPE.desc}; line-height: 1.45; color: ${C.muted}; }
    .mn-warn { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; margin-bottom: 12px; padding: 10px 12px;
        border: 1px solid rgba(255, 176, 46, 0.45); border-radius: 12px; background: rgba(255, 176, 46, 0.08);
        animation: uiFadeUp var(--dur-base, 220ms) var(--ease-out, ease) both; }
    .mn-warn b { font-size: ${TYPE.sub}; font-weight: 700; color: ${C.white}; }
    .mn-warn span { font-size: ${TYPE.desc}; line-height: 1.45; color: ${C.text}; }
    @media (prefers-reduced-motion: reduce) { .mn-warn { animation: none; } }
    .mn-stair { display: flex; flex-direction: column; gap: 6px; margin-top: 12px; padding-top: 12px; border-top: 1px solid ${C.hairline}; }
    .mn-foot { display: flex; gap: 8px; }
    .mn-foot .ui-btn-primary { flex: 1; }
    @media (max-width: 640px) { .mn-floors .seg > button { min-height: ${TAP.minHeight}; } }
    @media (prefers-reduced-motion: reduce) { .mn-row { animation: none; } }
`;

export default function ManageNodes({
    building, nodes, links = [], floor, setFloor, canEditNode, canAdd, onAdd, onEdit, onRemove, onShow, onAddStair, onClose,
    onPrintQr = null,
    // Which nodes are this place's (default: filed under the building), its floors and the closing hint:
    // a bridge passes "on its deck", [its deck floor] and its own wording.
    belongs = null, floors: floorList = null, note = null, addStairLabel = 'Add staircase',
    // Staircases of the nodes shown: onEditStair(link, nodeHere) opens it, onRemoveStair(link) deletes it.
    onEditStair = null, onRemoveStair = null,
}) {
    const id = useId();
    // Which kinds the list shows: everything (in two groups), rooms or route nodes.
    const [kind, setKind] = useState('all');
    const floors = floorList || buildingFloors(building);
    const isMine = belongs || ((n) => n.building_id === building.id);
    const onFloor = nodes
        .filter((n) => isMine(n) && floorOf(n) === floor)
        .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')) || a.id - b.id);
    const rooms = onFloor.filter((n) => n.type === 'location');
    const routeNodes = onFloor.filter((n) => n.type !== 'location');
    const groups = [
        ...(kind !== 'route' ? [{ key: 'rooms', label: 'Rooms', items: rooms }] : []),
        ...(kind !== 'location' ? [{ key: 'route', label: 'Route nodes', items: routeNodes }] : []),
    ].filter((g) => g.items.length > 0);
    const rowCount = groups.reduce((sum, g) => sum + g.items.length + (kind === 'all' ? 1 : 0), 0);
    // An upper floor with nodes but no staircase touching any of them is cut
    // off: routing only changes floors through staircase links, so students
    // could never be routed to those rooms.
    const onFloorIds = new Set(onFloor.map((n) => n.id));
    const cutOff = floor > 0 && onFloor.length > 0
        && !links.some((l) => onFloorIds.has(l.node_a_id) || onFloorIds.has(l.node_b_id));
    const emptyWhat = kind === 'location' ? 'rooms' : kind === 'route' ? 'route nodes' : 'nodes';
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const stairs = links
        .filter((l) => onFloorIds.has(l.node_a_id) || onFloorIds.has(l.node_b_id))
        .map((l) => {
            const here = byId.get(onFloorIds.has(l.node_a_id) ? l.node_a_id : l.node_b_id);
            const other = byId.get(here?.id === l.node_a_id ? l.node_b_id : l.node_a_id);
            return { link: l, here, other };
        })
        .filter((s) => s.here && s.other);

    const row = (n, index) => {
        const editable = canEditNode(n);
        const isRoom = n.type === 'location';
        // Route nodes have no names: number them on this floor.
        const title = n.name || (isRoom ? 'Unnamed room' : `Route node ${index + 1}`);
        return (
            <li key={n.id} className="mn-row">
                <button type="button" className="mn-name" onClick={() => onShow(n)} aria-label={`Show ${title} on the map`}>
                    <b>{title}</b>
                    {n.creator?.name && <span>Placed by {n.creator.name}</span>}
                </button>
                {editable ? (
                    <span className="mn-actions">
                        <button type="button" className="ui-btn ui-btn-secondary ui-btn-sm" onClick={() => onEdit(n)} aria-label={`Edit ${title}`}>Edit</button>
                        <button type="button" className="ui-btn ui-btn-danger ui-btn-sm" onClick={() => onRemove(n)} aria-label={`Remove ${title}`}>Remove</button>
                    </span>
                ) : (
                    <span className="mn-view-only">View only</span>
                )}
            </li>
        );
    };

    return (
        <Sheet
            title="Manage nodes"
            subtitle={building.short_name || building.name}
            onClose={onClose}
            footer={(
                <div className="mt-sheet-foot mn-foot">
                    {canAdd && (
                        <button type="button" className="ui-btn ui-btn-primary" onClick={() => onAdd(floor)}>
                            Add node on {floorAria(floor).toLowerCase()}
                        </button>
                    )}
                    <button type="button" className="ui-btn ui-btn-secondary" onClick={onClose}>Done</button>
                </div>
            )}
        >
            <div className="mn-floors">
                <span className="ui-label" id={`${id}-floor`}>Floor</span>
                {floors.length <= 6 ? (
                    <div className="seg" role="radiogroup" aria-labelledby={`${id}-floor`} style={{ '--seg-i': Math.max(0, floors.indexOf(floor)), '--seg-n': floors.length }}>
                        <span className="seg-thumb" aria-hidden="true" />
                        {floors.map((f) => (
                            <button key={f} type="button" role="radio" aria-checked={f === floor} aria-label={floorAria(f)} onClick={() => setFloor(f)}>
                                {floorTag(f)}
                            </button>
                        ))}
                    </div>
                ) : (
                    <select className="ui-select" aria-labelledby={`${id}-floor`} value={floor} onChange={(e) => setFloor(Number(e.target.value))}>
                        {floors.map((f) => <option key={f} value={f}>{floorAria(f)}</option>)}
                    </select>
                )}
            </div>
            <div className="mn-floors">
                <Segmented
                    label="Show" value={kind} onChange={setKind}
                    options={[{ value: 'all', label: 'All' }, { value: 'location', label: 'Rooms' }, { value: 'route', label: 'Route nodes' }]}
                />
            </div>

            {cutOff && (
                <div className="mn-warn" role="status">
                    <b>No staircase reaches {floorAria(floor).toLowerCase()} yet.</b>
                    <span>Students can't be routed here until one does. Add a staircase from a route node below.</span>
                    {onAddStair && <button type="button" className="ui-btn ui-btn-secondary ui-btn-sm" onClick={onAddStair}>{addStairLabel}</button>}
                </div>
            )}

            {groups.length > 0 ? (
                <ScrollWindow
                    as="ul" className="mn-list" rows={5} phoneRows={4} rowHeight={58}
                    count={rowCount} label={`Nodes on ${floorAria(floor).toLowerCase()}`}
                >
                    {groups.map((g) => (
                        <React.Fragment key={g.key}>
                            {kind === 'all' && <li className="mn-group" role="presentation">{g.label}</li>}
                            {g.items.map(row)}
                        </React.Fragment>
                    ))}
                </ScrollWindow>
            ) : (
                <p className="mn-empty">
                    No {emptyWhat} on {floorAria(floor).toLowerCase()} yet.
                    {canAdd ? ' Add one and place its pin on the highlighted floor.' : ''}
                </p>
            )}

            {onEditStair && stairs.length > 0 && (
                <div className="mn-stair">
                    <span className="ui-label" style={{ margin: 0 }}>Staircases</span>
                    <ul className="mn-list">
                        {stairs.map(({ link, here, other }) => {
                            const up = floorOf(other) > floorOf(here);
                            const title = `${up ? 'Up' : 'Down'} to ${floorAria(floorOf(other)).toLowerCase()}`;
                            return (
                                <li key={link.id} className="mn-row">
                                    <button type="button" className="mn-name" onClick={() => onShow(other)} aria-label={`Show where these stairs ${up ? 'arrive' : 'come down'}`}>
                                        <b>{title}</b>
                                        <span>{other.name || (other.type === 'location' ? 'Location' : 'Route node')} #{other.id}</span>
                                    </button>
                                    {canEditNode(here) ? (
                                        <span className="mn-actions">
                                            <button type="button" className="ui-btn ui-btn-secondary ui-btn-sm" onClick={() => onEditStair(link, here)} aria-label={`Edit the staircase ${title.toLowerCase()}`}>Edit</button>
                                            {onRemoveStair && (
                                                <button type="button" className="ui-btn ui-btn-danger ui-btn-sm" onClick={() => onRemoveStair(link)} aria-label={`Remove the staircase ${title.toLowerCase()}`}>Remove</button>
                                            )}
                                        </span>
                                    ) : <span className="mn-view-only">View only</span>}
                                </li>
                            );
                        })}
                    </ul>
                </div>
            )}

            {onAddStair && nodes.some((n) => isMine(n) && canEditNode(n)) && (
                <div className="mn-stair">
                    <button type="button" className="ui-btn ui-btn-secondary ui-btn-block" onClick={onAddStair}>{addStairLabel}</button>
                    <span className="ui-hint">Tap the node at one end, then the other end on another floor; shape and slope come last.</span>
                </div>
            )}

            {onPrintQr && onFloor.length > 0 && (
                <div className="mn-stair">
                    <button type="button" className="ui-btn ui-btn-secondary ui-btn-block" onClick={() => onPrintQr(onFloor, floor)}>
                        Print QR codes for this floor ({onFloor.length})
                    </button>
                    <span className="ui-hint">Stick one at each room or stair: scanning it sets a student's position and floor exactly, where GPS is weak.</span>
                </div>
            )}

            <p className="ui-hint" style={{ margin: '10px 0 0' }}>
                {note || (canAdd
                    ? 'The map shows this floor inside the building; lower floors are grey.'
                    : 'The map shows this floor inside the building. Rooms are added by the building’s department staff.')}
            </p>
        </Sheet>
    );
}
