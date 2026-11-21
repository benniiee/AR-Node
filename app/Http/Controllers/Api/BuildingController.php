<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Building;
use App\Models\User;
use App\Services\BuildingDoors;
use App\Services\GeoPoints;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\Rule;
use Illuminate\Validation\ValidationException;

class BuildingController extends Controller
{
    /**
     * List every building with its node count (any logged-in user: the admin
     * map labels buildings and the node form files nodes under them).
     */
    public function index(): JsonResponse
    {
        return response()->json(
            Building::with('department:id,name,color')->withCount('nodes')->orderBy('name')->get()
        );
    }

    /**
     * Label a new building (admin only): either an OSM footprint copied from
     * the base map or an outline drawn by hand for a new building.
     */
    public function store(Request $request): JsonResponse
    {
        abort_unless($request->user()->isAdmin(), 403);

        $validated = $this->validated($request, creating: true);

        $building = new Building($validated);
        $building->created_by = $request->user()->id;
        $building->save();

        return response()->json($this->present($building), 201);
    }

    public function show(Building $building): JsonResponse
    {
        return response()->json($this->present($building));
    }

    /**
     * Move, reshape, rename or re-floor a building. Admins may edit every
     * building; department staff may edit the buildings filed under their own
     * department, so a building never has to be drawn again just to move it.
     * Only admins can file a building under a different department.
     *
     * Lowering the floor count is refused while nodes still sit on the floors
     * that would vanish, so no office silently ends up on a floor the building
     * no longer has.
     *
     * `move_nodes_by` {lat, lng}: when the outline was moved as a whole, the
     * offices and rooms filed in the building move by the same offset, in the
     * same transaction (it is one building move, whoever placed each room).
     */
    public function update(Request $request, Building $building): JsonResponse
    {
        $user = $request->user();
        abort_unless($this->canEdit($user, $building), 403, 'You can only edit buildings of your own department.');

        if (! $user->isAdmin() && $request->has('department_id')
            && (int) $request->input('department_id') !== (int) $building->department_id) {
            abort(403, 'Only an admin can move a building to another department.');
        }

        // Doors belong to the building's department: its staff manage them, never an admin (a whole-
        // building move still carries the doors along, see below). No department yet: assign one first.
        if ($user->isAdmin() && $request->has('doors')) {
            abort(403, 'Doors are managed by the staff of the department that owns this building.');
        }

        $validated = $this->validated($request, creating: false);
        // Admin moving the building to another department: hand the rooms and
        // routes inside over with it (default), or leave them with the old one.
        $transfer = $request->boolean('transfer_nodes', true);
        $shift = $request->validate([
            'transfer_nodes' => 'sometimes|boolean',
            'move_nodes_by' => 'sometimes|nullable|array',
            // A whole-building move is metres, never kilometres (0.005 deg ~ 550 m).
            'move_nodes_by.lat' => 'required_with:move_nodes_by|numeric|between:-0.005,0.005',
            'move_nodes_by.lng' => 'required_with:move_nodes_by|numeric|between:-0.005,0.005',
        ])['move_nodes_by'] ?? null;
        unset($validated['move_nodes_by'], $validated['transfer_nodes']);

        $building->fill($validated);

        // A whole-building move carries its doors along when the client did
        // not send them already moved.
        if ($shift && ! array_key_exists('doors', $validated) && is_array($building->doors)) {
            $building->doors = array_map(fn (array $d): array => [
                ...$d,
                'lat' => round($d['lat'] + (float) $shift['lat'], 7),
                'lng' => round($d['lng'] + (float) $shift['lng'], 7),
            ], $building->doors);
        }

        if ($building->isDirty('floors')) {
            $stranded = $building->nodes()
                ->where(fn ($q) => $q
                    ->where('floor_level', '>', $building->highestFloor())
                    ->orWhere('floor_level', '<', $building->lowestFloor()))
                ->count();

            if ($stranded > 0) {
                throw ValidationException::withMessages([
                    'floors' => ["{$stranded} node(s) in this building are on floors it would no longer have. Move them first."],
                ]);
            }
        }

        $handOver = $user->isAdmin() && $building->isDirty('department_id') && $transfer;
        $transferred = 0;

        $moved = DB::transaction(function () use ($building, $shift, $handOver, &$transferred) {
            $building->save();

            if ($handOver) {
                // One by one, so model events fire as for any other node edit.
                foreach ($building->nodes()->get() as $node) {
                    if ($node->department_id === $building->department_id) {
                        continue;
                    }
                    $node->department_id = $building->department_id;
                    $node->save();
                    $transferred++;
                }
            }

            if (! $shift) {
                return 0;
            }

            // Each node saved individually so model events (map snapshot,
            // updated_at for the map version) fire as for any other edit.
            $nodes = $building->nodes()->get();
            foreach ($nodes as $node) {
                $node->latitude += (float) $shift['lat'];
                $node->longitude += (float) $shift['lng'];
                $node->save();
            }

            return $nodes->count();
        });

        return response()->json($this->present($building) + ['nodes_moved' => $moved, 'nodes_transferred' => $transferred]);
    }

    /**
     * Admins edit every building; staff edit their own department's buildings.
     */
    private function canEdit(User $user, Building $building): bool
    {
        return $user->isAdmin()
            || ($user->department_id !== null && $building->department_id === $user->department_id);
    }

    /**
     * Remove a building (admin only) together with every node filed under it: its rooms,
     * offices and indoor route nodes, on all floors. Their staircases go with them (the
     * node_links foreign keys cascade). One transaction, so nothing is left half-removed.
     */
    public function destroy(Request $request, Building $building): JsonResponse
    {
        abort_unless($request->user()->isAdmin(), 403);

        $removed = DB::transaction(function () use ($building): int {
            $count = $building->nodes()->delete();
            $building->delete();

            return $count;
        });

        return response()->json(['message' => 'Building deleted', 'nodes_deleted' => $removed]);
    }

    /**
     * @return array<string, mixed>
     */
    private function validated(Request $request, bool $creating): array
    {
        $validated = $request->validate($this->rules($creating));

        if (isset($validated['polygon'])) {
            $validated['polygon'] = GeoPoints::normalize($validated['polygon']);
        }
        if (array_key_exists('doors', $validated)) {
            $validated['doors'] = $validated['doors'] ? BuildingDoors::normalize($validated['doors']) : null;
        }

        return $validated;
    }

    /**
     * @return array<string, mixed>
     */
    private function rules(bool $creating): array
    {
        $required = $creating ? 'required' : 'sometimes|required';

        return [
            'name' => "{$required}|string|max:255",
            'short_name' => 'sometimes|nullable|string|max:32',
            'floors' => 'sometimes|integer|min:1|max:'.Building::MAX_FLOORS,
            'height_m' => 'sometimes|nullable|numeric|min:'.Building::MIN_HEIGHT_M.'|max:'.Building::MAX_HEIGHT_M,
            'status' => ['sometimes', Rule::in(Building::STATUSES)],
            'campus' => 'sometimes|in:A,B',
            'polygon' => "{$required}|array|min:3|max:500",
            'polygon.*.lat' => 'required|numeric|between:-90,90',
            'polygon.*.lng' => 'required|numeric|between:-180,180',
            'doors' => 'sometimes|nullable|array|max:'.Building::MAX_DOORS,
            'doors.*.lat' => 'required|numeric|between:-90,90',
            'doors.*.lng' => 'required|numeric|between:-180,180',
            'doors.*.width_m' => 'sometimes|nullable|numeric|between:'.BuildingDoors::MIN_DOOR_WIDTH_M.','.BuildingDoors::MAX_DOOR_WIDTH_M,
            'source' => ['sometimes', Rule::in(Building::SOURCES)],
            'osm_ref' => 'sometimes|nullable|string|max:64',
            'department_id' => 'sometimes|nullable|exists:departments,id',
        ];
    }

    /**
     * @return array<string, mixed>
     */
    private function present(Building $building): array
    {
        return $building->load('department:id,name,color')->loadCount('nodes')->toArray();
    }
}
