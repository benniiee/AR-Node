<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Bridge;
use App\Models\Building;
use App\Models\Node;
use App\Models\User;
use App\Services\GeoPoints;
use App\Services\OpeningHours;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Arr;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;

class NodeController extends Controller
{
    /** Admins keep the outdoor network (pathways, bridges); nodes in buildings are the departments'. */
    private const ADMIN_NODES_ONLY_ON_BRIDGES = 'Admins add and edit nodes only on bridges. Rooms and routes inside a building are managed by its department staff, and outdoor walks are roads and walkways (Add path).';

    /**
     * Relations every node response carries.
     *
     * @var list<string>
     */
    private const WITH = [
        'department:id,name,color',
        'creator:id,name',
        'building:id,name,short_name,floors',
        'manager:id,name',
    ];

    /**
     * List nodes with their department colour and creator. Admins see every
     * node; faculty see their own department's nodes plus the shared outdoor
     * network (nodes outside any building, laid by admins), read-only, so
     * they can see how their building connects to the rest of the campus.
     * Faculty without a department see none: they cannot place nodes either.
     */
    public function index(Request $request): JsonResponse
    {
        $user = $request->user();

        $query = Node::with(self::WITH)->orderBy('id');

        if (! $user->isAdmin()) {
            if ($user->department_id === null) {
                return response()->json([]);
            }
            // Same rule as editing (authorizeNode): rooms in their department's buildings
            // count as theirs, also ones a handover left filed under the old department.
            $query->where(fn ($q) => $q
                ->where('department_id', $user->department_id)
                ->orWhereNull('building_id')
                ->orWhereIn('building_id', Building::where('department_id', $user->department_id)->select('id')));
        }

        return response()->json($query->get());
    }

    /**
     * Store a new node. created_by is always the caller; department_id is the
     * caller's own department for faculty (admins may file under any).
     */
    public function store(Request $request): JsonResponse
    {
        $user = $request->user();

        $validated = $request->validate([
            'name' => 'nullable|string|max:255',
            'type' => 'required|in:route,location',
            'latitude' => 'required|numeric|between:-90,90',
            'longitude' => 'required|numeric|between:-180,180',
            'elevation' => 'nullable|numeric',
            'floor_level' => 'nullable|integer',
            'path_type' => 'required|in:outside,inside',
            // Optional so older clients keep working; the admin form always
            // sends it, and the column defaults to 'A' when omitted.
            'campus' => 'sometimes|in:A,B',
            'department_id' => 'sometimes|nullable|exists:departments,id',
            'building_id' => 'sometimes|nullable|exists:buildings,id',
            ...OpeningHours::rules(),
            // Only a place (location) can be shown to visitors.
            'is_public' => 'sometimes|boolean',
        ]);
        if (array_key_exists('opening_hours', $validated)) {
            $validated['opening_hours'] = OpeningHours::normalize($validated['opening_hours']);
        }

        if ($user->isAdmin()) {
            // Admins look after the outdoor network: roads and walkways (pathways) and bridges. Their
            // only nodes are on bridge decks; rooms and routes in buildings are the departments'.
            abort_unless(
                ($validated['building_id'] ?? null) === null && Bridge::covers((float) $validated['latitude'], (float) $validated['longitude']),
                403, self::ADMIN_NODES_ONLY_ON_BRIDGES,
            );
            $departmentId = null;
        } else {
            abort_unless(
                $user->department_id !== null, 422,
                'Ask an admin to assign you to a department before placing nodes.'
            );
            // Faculty always file under their own department — the map label
            // colour must stay truthful about who placed the node.
            $departmentId = $user->department_id;
            // ...and place nodes only inside their department's buildings.
            $validated['building_id'] = $this->staffBuildingFor(
                $user, $validated['building_id'] ?? null, (float) $validated['latitude'], (float) $validated['longitude'],
            )->id;
        }

        $this->assertFloorInBuilding(
            $validated['building_id'] ?? null,
            (int) ($validated['floor_level'] ?? 0),
        );

        $node = new Node(Arr::except($validated, ['department_id']));
        // A route node is never a visitor's destination.
        if ($node->type !== 'location') {
            $node->is_public = false;
        }
        $node->department_id = $departmentId;
        $node->created_by = $user->id;
        $node->save();

        return response()->json($node->load(self::WITH), 201);
    }

    /**
     * Show a single node with its department colour and creator. Same
     * visibility rule as the index — faculty outside the node's department
     * get a 403, so scoping cannot be bypassed by guessing ids.
     */
    public function show(Request $request, Node $node): JsonResponse
    {
        $user = $request->user();

        if (! $user->isAdmin()
            && $node->building_id !== null
            && ($node->department_id === null || $node->department_id !== $user->department_id)
            && ! $this->inOwnBuilding($user, $node)
        ) {
            abort(403, 'You can only view nodes from your own department.');
        }

        return response()->json($node->load(self::WITH));
    }

    /**
     * Update an existing node. Admins may edit anything; faculty may only
     * edit nodes they placed themselves, and can never move a node between
     * departments or change its creator.
     */
    public function update(Request $request, Node $node): JsonResponse
    {
        // Office staff set the hours of the places assigned to them, nothing else.
        if ($request->user()->isOfficeStaff()) {
            abort_unless($node->manager_id === $request->user()->id, 403, 'You can only set the hours of the offices assigned to you.');
            $validated = $request->validate(OpeningHours::rules());
            if (array_key_exists('opening_hours', $validated)) {
                $node->opening_hours = OpeningHours::normalize($validated['opening_hours']);
                $node->save();
            }

            return response()->json($node->load(self::WITH));
        }

        $this->authorizeNode($request, $node);

        $validated = $request->validate([
            'name' => 'nullable|string|max:255',
            'type' => 'sometimes|required|in:route,location',
            'latitude' => 'sometimes|required|numeric|between:-90,90',
            'longitude' => 'sometimes|required|numeric|between:-180,180',
            'elevation' => 'nullable|numeric',
            'floor_level' => 'nullable|integer',
            'path_type' => 'sometimes|required|in:outside,inside',
            'campus' => 'sometimes|in:A,B',
            'department_id' => 'sometimes|nullable|exists:departments,id',
            'building_id' => 'sometimes|nullable|exists:buildings,id',
            ...OpeningHours::rules(),
            // Only a place (location) can be shown to visitors.
            'is_public' => 'sometimes|boolean',
            // Office staff who run this place (the building head assigns them).
            'manager_id' => 'sometimes|nullable|integer|exists:users,id',
        ]);
        if (array_key_exists('manager_id', $validated)) {
            $node->manager_id = $this->managerFor($node, $validated['manager_id']);
        }
        if (array_key_exists('opening_hours', $validated)) {
            $validated['opening_hours'] = OpeningHours::normalize($validated['opening_hours']);
        }

        // Staff moving or re-filing a node must keep it inside one of their
        // department's buildings (admins move nodes anywhere).
        $user = $request->user();
        if ($user->isAdmin()) {
            // A bridge node stays on a bridge.
            abort_unless(
                ($validated['building_id'] ?? null) === null
                    && Bridge::covers((float) ($validated['latitude'] ?? $node->latitude), (float) ($validated['longitude'] ?? $node->longitude)),
                403, self::ADMIN_NODES_ONLY_ON_BRIDGES,
            );
        }
        if (! $user->isAdmin() && (isset($validated['latitude']) || isset($validated['longitude']) || array_key_exists('building_id', $validated))) {
            $validated['building_id'] = $this->staffBuildingFor(
                $user,
                array_key_exists('building_id', $validated) ? $validated['building_id'] : $node->building_id,
                (float) ($validated['latitude'] ?? $node->latitude),
                (float) ($validated['longitude'] ?? $node->longitude),
            )->id;
        }

        $this->assertFloorInBuilding(
            array_key_exists('building_id', $validated) ? $validated['building_id'] : $node->building_id,
            (int) (array_key_exists('floor_level', $validated) ? $validated['floor_level'] : $node->floor_level),
        );

        $node->fill(Arr::except($validated, ['department_id', 'manager_id']));
        // A route node is never a visitor's destination.
        if ($node->type !== 'location') {
            $node->is_public = false;
        }

        if ($request->user()->isAdmin() && array_key_exists('department_id', $validated)) {
            $node->department_id = $validated['department_id'];
        }

        $node->save();

        return response()->json($node->load(self::WITH));
    }

    /**
     * Delete a node. Admins may delete anything; faculty only their own.
     */
    public function destroy(Request $request, Node $node): JsonResponse
    {
        $this->authorizeNode($request, $node);

        $node->delete();

        return response()->json(['message' => 'Node deleted']);
    }

    /**
     * Swap two offices (department staff, both offices in their buildings): the two location nodes keep their spot,
     * building and floor, but trade what is there: name and department. This
     * is the "the Registrar and the Cashier swapped rooms" case, done in one
     * atomic step instead of two renames that briefly leave duplicate names.
     */
    public function swap(Request $request): JsonResponse
    {
        abort_if($request->user()->isAdmin(), 403, 'Offices are managed by the staff of the department that owns the building.');

        $validated = $request->validate([
            'node_a_id' => 'required|integer|exists:nodes,id',
            'node_b_id' => 'required|integer|exists:nodes,id|different:node_a_id',
        ]);

        $a = Node::findOrFail($validated['node_a_id']);
        $b = Node::findOrFail($validated['node_b_id']);
        // Both offices in the staff member's own department's buildings.
        $this->authorizeNode($request, $a);
        $this->authorizeNode($request, $b);

        if (! $a->isDestination() || ! $b->isDestination()) {
            throw ValidationException::withMessages([
                'node_b_id' => ['Only locations (offices, rooms) can be swapped.'],
            ]);
        }

        DB::transaction(function () use ($a, $b) {
            [$aName, $aDepartment] = [$a->name, $a->department_id];

            $a->name = $b->name;
            $a->department_id = $b->department_id;
            $a->save();

            $b->name = $aName;
            $b->department_id = $aDepartment;
            $b->save();
        });

        return response()->json([
            'nodes' => [$a->load(self::WITH), $b->load(self::WITH)],
        ]);
    }

    /**
     * The department building a staff member's node belongs in: the one they
     * chose (it must be their department's and contain the point), otherwise
     * the department building the point falls inside. Anything else is
     * refused: staff place nodes only inside their own buildings.
     */
    private function staffBuildingFor(User $user, ?int $buildingId, float $lat, float $lng): Building
    {
        $own = Building::where('department_id', $user->department_id)->get();

        if ($own->isEmpty()) {
            throw ValidationException::withMessages([
                'latitude' => ['Your department has no buildings on the map yet. Ask an admin to label one, then place nodes inside it.'],
            ]);
        }

        $chosen = $buildingId !== null ? $own->firstWhere('id', $buildingId) : null;
        if ($buildingId !== null && ! $chosen) {
            throw ValidationException::withMessages([
                'building_id' => ['You can only place nodes in your own department\'s buildings.'],
            ]);
        }

        $match = $chosen && GeoPoints::contains($chosen->polygon, $lat, $lng)
            ? $chosen
            : $own->first(fn (Building $b) => GeoPoints::contains($b->polygon, $lat, $lng));

        if (! $match) {
            $names = $own->pluck('name')->take(3)->implode(', ');
            throw ValidationException::withMessages([
                'latitude' => ["Place it inside one of your department's buildings ({$names})."],
            ]);
        }

        return $match;
    }

    /**
     * A node filed under a building must sit on one of that building's floors.
     */
    private function assertFloorInBuilding(?int $buildingId, int $floorLevel): void
    {
        if ($buildingId === null) {
            return;
        }

        $building = Building::find($buildingId);

        if ($building && ! $building->hasFloor($floorLevel)) {
            throw ValidationException::withMessages([
                'floor_level' => ["{$building->name} has floor levels {$building->lowestFloor()} to {$building->highestFloor()} (0 = ground floor)."],
            ]);
        }
    }

    /**
     * Faculty are scoped to nodes inside their department's buildings; admins are unrestricted.
     */
    /**
     * Who may run a place: a staff member of the department that owns it (the place's own department,
     * else its building's). Null clears it (the head runs it again).
     */
    private function managerFor(Node $node, ?int $managerId): ?int
    {
        if ($managerId === null) {
            return null;
        }
        abort_unless($node->type === 'location', 422, 'Only a place (an office or room) can be assigned to staff.');
        $owner = $node->department_id ?? $node->building?->department_id;
        $manager = User::find($managerId);
        abort_unless(
            $manager !== null && $manager->isFaculty() && $owner !== null && $manager->department_id === $owner,
            422, 'Assign someone from the department that owns this place.',
        );

        return $manager->id;
    }

    private function authorizeNode(Request $request, Node $node): void
    {
        $user = $request->user();

        if ($user->isAdmin()) {
            abort_unless(Bridge::holds($node), 403, self::ADMIN_NODES_ONLY_ON_BRIDGES);

            return;
        }

        // Staff manage nodes only inside their department's buildings, whoever placed them
        // (a building handed over by an admin comes with its rooms and routes). Nodes outside
        // buildings are the shared outdoor network: admins only.
        abort_unless(
            $this->inOwnBuilding($user, $node),
            403,
            $node->building_id !== null
                ? 'Only staff of the department that owns this building can edit its nodes.'
                : 'Only an admin can edit nodes outside buildings.'
        );
    }

    /**
     * The node is inside a building filed under the user's department.
     */
    private function inOwnBuilding(User $user, Node $node): bool
    {
        return $node->building_id !== null && $user->department_id !== null
            && Building::whereKey($node->building_id)->where('department_id', $user->department_id)->exists();
    }
}
