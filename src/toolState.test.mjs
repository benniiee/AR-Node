import assert from 'node:assert/strict';
import { IDLE, resolveTool, resolveMode, surfaceFor } from './toolState.js';
let t = IDLE;
// starting any tool replaces the active one
t = resolveTool(t, 'walls', true); assert.equal(t, 'walls');
t = resolveTool(t, 'pin', true);   assert.equal(t, 'pin');
// turning off a tool that is NOT active must not touch the active one
t = resolveTool(t, 'walls', false); assert.equal(t, 'pin');
t = resolveTool(t, 'pin', false);   assert.equal(t, IDLE);
// legacy mode shim
t = resolveMode(IDLE, 'addNode'); assert.equal(t, 'add');
t = resolveMode(t, 'navigate');   assert.equal(t, IDLE);
t = resolveMode('walls', 'navigate'); assert.equal(t, 'walls'); // navigate never kills another tool
// handler sequences from AdminMap, applied in order (React batches them the same way)
const seq = (start, ops) => ops.reduce((cur, f) => f(cur), start);
// toggleWallDrawing start: setMode('navigate'); ...; setIsSettingUserLoc(false); setIsDrawingBorder(true)
assert.equal(seq('pin', [c => resolveMode(c,'navigate'), c => resolveTool(c,'pin',false), c => resolveTool(c,'walls',true)]), 'walls');
// enterAddNodeMode: cancel walls, move off, pin off, then add on
assert.equal(seq('walls', [c => resolveTool(c,'walls',false), c => resolveTool(c,'move',false), c => resolveTool(c,'pin',false), c => resolveMode(c,'addNode')]), 'add');
// enterNavigateMode ends everything
assert.equal(seq('move', [c => resolveTool(c,'walls',false), c => resolveTool(c,'move',false), c => resolveTool(c,'pin',false), c => resolveMode(c,'navigate')]), IDLE);
// surfaces: exactly one for every state
for (const tool of ['idle','add','move','pin','walls','building','pathway'])
  for (const hasPending of [false,true]) for (const hasEditing of [false,true])
    assert.ok(typeof surfaceFor({ tool, hasPending, hasEditing }) === 'string');
assert.equal(surfaceFor({ tool:'add', hasPending:false, hasEditing:false }), 'add-place');
// Manage nodes sits under the tools it opens: they win, idle shows it.
assert.equal(surfaceFor({ tool:'idle', hasPending:false, hasEditing:false, hasManaging:true }), 'manage');
assert.equal(surfaceFor({ tool:'idle', hasPending:false, hasEditing:true, hasManaging:true }), 'edit-form');
assert.equal(surfaceFor({ tool:'add', hasPending:false, hasEditing:false, hasManaging:true }), 'add-place');
assert.equal(surfaceFor({ tool:'idle', hasPending:false, hasEditing:false }), 'dock');
assert.equal(surfaceFor({ tool:'add', hasPending:true,  hasEditing:false }), 'add-form');
assert.equal(surfaceFor({ tool:'move', hasPending:false, hasEditing:true }), 'move');
assert.equal(surfaceFor({ tool:'idle', hasPending:false, hasEditing:true }), 'edit-form');
assert.equal(surfaceFor({ tool:'idle', hasPending:false, hasEditing:false }), 'dock');
assert.equal(surfaceFor({ tool:'building', hasPending:false, hasEditing:true }), 'campus');
assert.equal(surfaceFor({ tool:'pathway', hasPending:false, hasEditing:false }), 'campus');
assert.equal(resolveTool('walls', 'building', true), 'building');
// Campus areas: managing them and drawing one are two surfaces; neither is the dock.
assert.equal(surfaceFor({ tool:'areas', hasPending:false, hasEditing:false }), 'areas');
assert.equal(surfaceFor({ tool:'area', hasPending:false, hasEditing:false }), 'area');
assert.equal(surfaceFor({ tool:'areas', hasPending:false, hasEditing:false, hasManaging:true }), 'areas');
console.log('toolState: all assertions passed');
