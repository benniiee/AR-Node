<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Bridge;
use App\Models\Building;
use App\Models\Node;
use App\Models\NodeLink;
use App\Services\BuildingDoors;
use App\Services\GeoPoints;
use App\Services\RouteNodes;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\Rule;

/**
 * Bridges and other connectors (Bridge::KINDS), managed like buildings: any logged-in
 * user reads them, only admins draw, change or remove them.
 */
class BridgeController extends Controller
{
    /** Slope (degrees) of the staircases built at a raised deck's ends: an outdoor stair; edit it in the stairs tool. */
    private const STAIR_ANGLE = 35.0;

    public function index(): JsonResponse
    {
        return response()->json(Bridge::orderBy('name')->get());
    }

    public function store(Request $request): JsonResponse
    {
        abort_unless($request->user()->isAdmin(), 403);

        $bridge = new Bridge($this->validated($request, creating: true));
        $bridge->created_by = $request->user()->id;
        $bridge->save();

        return response()->json($bridge, 201);
    }

    public function show(Bridge $bridge): JsonResponse
    {
        return response()->json($bridge);
    }

    public function update(Request $request, Bridge $bridge): JsonResponse
    {
        abort_unless($request->user()->isAdmin(), 403);

        $bridge->update($this->validated($request, creating: false));

        return response()->json($bridge);
    }

    /**
     * Remove a bridge (admin only) together with the nodes on its deck (Bridge::deckNodes) and,
     * through the node_links foreign keys, the staircases up to them. The ground nodes those
     * stairs came down to stay: they are part of the ground routes.
     */
    public function destroy(Request $request, Bridge $bridge): JsonResponse
    {
        abort_unless($request->user()->isAdmin(), 403);

        $removed = DB::transaction(function () use ($bridge): int {
            $ids = $bridge->deckNodes()->pluck('id');
            Node::whereKey($ids)->delete();
            $bridge->delete();

            return $ids->count();
        });

        return response()->json(['message' => 'Bridge deleted', 'nodes_deleted' => $removed]);
    }

    /**
     * Lay route nodes along the deck (admin only), on the deck's floor and at its height:
     * sheltered on a roofed deck. A raised deck is joined to the ground routes with staircases
     * (the admin map's "Connect to ground", or the stairs tool); `stairs: true` instead builds a
     * new staircase down to a new ground route node at each end. Running it again adds only what is missing.
     */
    public function generateRouteNodes(Request $request, Bridge $bridge): JsonResponse
    {
        abort_unless($request->user()->isAdmin(), 403);

        $validated = $request->validate([
            'spacing_m' => 'sometimes|numeric|min:3|max:50',
            'campus' => 'sometimes|in:A,B',
            'stairs' => 'sometimes|boolean',
        ]);
        $campus = $validated['campus'] ?? 'A';
        $line = $bridge->walkingLine();

        $created = RouteNodes::layAlong(
            $line,
            (float) ($validated['spacing_m'] ?? 6),
            $bridge->deck_floor,
            $bridge->nodePathType(),
            $campus,
            $request->user()->id,
            $bridge->deckHeightM(),
        );

        $stairs = [];
        if ($bridge->deck_floor > 0 && ($validated['stairs'] ?? false) && count($line) === 2) {
            $stairs = DB::transaction(fn (): array => array_values(array_filter([
                $this->endStairs($bridge, $line[0], $line[1], $campus, $request->user()->id),
                $this->endStairs($bridge, $line[1], $line[0], $campus, $request->user()->id),
            ])));
        }

        return response()->json(['created' => count($created), 'nodes' => $created, 'stairs_created' => count($stairs), 'stairs' => $stairs], 201);
    }

    /**
     * One staircase at the deck end `$end` (the walking line runs on to `$other`): from a
     * ground-floor route node one stair-length beyond the end, up to the deck's end node.
     * The ground node is an existing one when one is that close. Null when the end has no
     * deck node or already has a staircase down.
     *
     * @param  array{lat: float, lng: float}  $end
     * @param  array{lat: float, lng: float}  $other
     */
    private function endStairs(Bridge $bridge, array $end, array $other, string $campus, int $userId): ?NodeLink
    {
        $nearest = fn (int $floor, array $at, float $within): ?Node => Node::where('type', 'route')->where('floor_level', $floor)->get()
            ->filter(fn (Node $n): bool => GeoPoints::distance($at, ['lat' => $n->latitude, 'lng' => $n->longitude]) <= $within)
            ->sortBy(fn (Node $n): float => GeoPoints::distance($at, ['lat' => $n->latitude, 'lng' => $n->longitude]))
            ->first();

        $top = $nearest($bridge->deck_floor, $end, 3.0);
        if ($top === null) {
            return null;
        }
        $hasStairsDown = NodeLink::query()
            ->where(fn ($q) => $q->where('node_a_id', $top->id)->orWhere('node_b_id', $top->id))
            ->with(['nodeA', 'nodeB'])->get()
            ->contains(fn (NodeLink $l): bool => ($l->node_a_id === $top->id ? $l->nodeB : $l->nodeA)?->floor_level < $bridge->deck_floor);
        if ($hasStairsDown) {
            return null;
        }

        $height = $bridge->deckHeightM();
        if ($top->elevation < $height - 0.01) {
            // Deck nodes from before heights were stored: the staircase reads its rise from them.
            $top->elevation = $height;
            $top->save();
        }

        // One straight flight at the stair slope ends exactly at the deck: run = rise / tan(slope).
        $run = $height / tan(deg2rad(self::STAIR_ANGLE));
        $length = max(0.01, GeoPoints::distance($end, $other));
        $foot = [
            'lat' => $end['lat'] + ($end['lat'] - $other['lat']) * $run / $length,
            'lng' => $end['lng'] + ($end['lng'] - $other['lng']) * $run / $length,
        ];

        $bottom = $nearest(0, $foot, RouteNodes::DUPLICATE_RADIUS_M);
        if ($bottom === null) {
            $bottom = new Node([
                'type' => 'route', 'latitude' => round($foot['lat'], 7), 'longitude' => round($foot['lng'], 7),
                'elevation' => 0, 'floor_level' => 0, 'path_type' => 'outside', 'campus' => $campus,
            ]);
            $bottom->created_by = $userId;
            $bottom->save();
        }

        [$low, $high] = $top->id < $bottom->id ? [$top->id, $bottom->id] : [$bottom->id, $top->id];

        return NodeLink::create(['node_a_id' => $low, 'node_b_id' => $high, 'kind' => 'stairs', 'angle_deg' => self::STAIR_ANGLE]);
    }

    /**
     * @return array<string, mixed>
     */
    private function validated(Request $request, bool $creating): array
    {
        $required = $creating ? 'required' : 'sometimes|required';

        $validated = $request->validate([
            'name' => "{$required}|string|max:255",
            'short_name' => 'sometimes|nullable|string|max:32',
            'kind' => ['sometimes', Rule::in(Bridge::KINDS)],
            'polygon' => "{$required}|array|min:3|max:200",
            'polygon.*.lat' => 'required|numeric|between:-90,90',
            'polygon.*.lng' => 'required|numeric|between:-180,180',
            'doors' => 'sometimes|nullable|array|max:'.Building::MAX_DOORS,
            'doors.*.lat' => 'required|numeric|between:-90,90',
            'doors.*.lng' => 'required|numeric|between:-180,180',
            'doors.*.width_m' => 'sometimes|nullable|numeric|between:'.BuildingDoors::MIN_DOOR_WIDTH_M.','.BuildingDoors::MAX_DOOR_WIDTH_M,
            'deck_floor' => 'sometimes|integer|min:0|max:'.Bridge::MAX_DECK_FLOOR,
            'deck_height_m' => 'sometimes|nullable|numeric|min:0|max:'.Bridge::MAX_DECK_HEIGHT_M,
            'roofed' => 'sometimes|boolean',
            // Closing needs a reason: students see why routes no longer cross.
            'closed' => 'sometimes|boolean',
            'closed_reason' => 'required_if:closed,true|nullable|string|max:160',
            'status' => ['sometimes', Rule::in(Building::STATUSES)],
            'source' => ['sometimes', Rule::in(Building::SOURCES)],
        ]);

        if (isset($validated['polygon'])) {
            $validated['polygon'] = GeoPoints::normalize($validated['polygon']);
        }
        if (array_key_exists('closed', $validated) && ! $validated['closed']) {
            $validated['closed_reason'] = null; // reopened: the old reason goes too
        }
        if (array_key_exists('doors', $validated)) {
            $validated['doors'] = $validated['doors'] ? BuildingDoors::normalize($validated['doors']) : null;
        }

        return $validated;
    }
}
