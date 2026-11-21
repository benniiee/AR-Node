<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Bridge;
use App\Models\Building;
use App\Models\Node;
use App\Models\NodeLink;
use App\Models\Pathway;
use App\Services\GeoPoints;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\Rule;

class PathwayController extends Controller
{
    /**
     * List the road/walkway network (any logged-in user).
     */
    public function index(): JsonResponse
    {
        return response()->json(Pathway::orderBy('id')->get());
    }

    /**
     * Add a pathway (admin only): a road copied from the base map or a walkway
     * drawn by hand.
     */
    public function store(Request $request): JsonResponse
    {
        abort_unless($request->user()->isAdmin(), 403);

        $pathway = new Pathway($this->validated($request, creating: true));
        $pathway->created_by = $request->user()->id;
        $pathway->save();

        return response()->json($pathway, 201);
    }

    public function show(Pathway $pathway): JsonResponse
    {
        return response()->json($pathway);
    }

    /**
     * Rename, relabel or reshape a pathway (admin only).
     */
    public function update(Request $request, Pathway $pathway): JsonResponse
    {
        abort_unless($request->user()->isAdmin(), 403);

        $pathway->update($this->validated($request, creating: false));

        return response()->json($pathway);
    }

    /**
     * Remove a pathway (admin only). Route nodes laid along it stay.
     */
    public function destroy(Request $request, Pathway $pathway): JsonResponse
    {
        abort_unless($request->user()->isAdmin(), 403);

        $pathway->delete();

        return response()->json(['message' => 'Pathway deleted']);
    }

    /**
     * Delete the route-node dots along a pathway (admin only): the pathway itself is a route now
     * (src/pathfinding.js pathwayWaypoints), so the dots laid or placed along it are duplicates.
     * Only ground-floor route nodes outside buildings within the path's half-width + 2 m (at least
     * 3 m) go; never a staircase end, a node on a bridge or a destination (rooms are not route nodes).
     */
    public function clearRouteNodes(Request $request, Pathway $pathway): JsonResponse
    {
        abort_unless($request->user()->isAdmin(), 403);

        $line = $pathway->coordinates ?? [];
        $reach = max(3.0, $pathway->widthM() / 2 + 2.0);
        $stairEnds = NodeLink::pluck('node_a_id')->merge(NodeLink::pluck('node_b_id'))->unique();
        $bridges = Bridge::all(['polygon']);

        $along = Node::where('type', 'route')->whereNull('building_id')->where('floor_level', 0)
            ->whereNotIn('id', $stairEnds)->get()
            ->filter(fn (Node $n): bool => GeoPoints::distanceToLine($line, ['lat' => (float) $n->latitude, 'lng' => (float) $n->longitude]) <= $reach
                && ! $bridges->contains(fn (Bridge $b): bool => GeoPoints::contains($b->polygon ?? [], (float) $n->latitude, (float) $n->longitude)));

        DB::transaction(fn () => Node::whereIn('id', $along->pluck('id'))->delete());

        return response()->json(['deleted' => $along->count(), 'reach_m' => round($reach, 1)]);
    }

    /**
     * @return array<string, mixed>
     */
    private function validated(Request $request, bool $creating): array
    {
        $required = $creating ? 'required' : 'sometimes|required';

        $validated = $request->validate([
            'name' => 'sometimes|nullable|string|max:255',
            'kind' => ['sometimes', Rule::in(Pathway::KINDS)],
            'status' => ['sometimes', Rule::in(Building::STATUSES)],
            // Real width in metres (null = the usual width for its kind).
            'width_m' => 'sometimes|nullable|numeric|min:1|max:30',
            'coordinates' => "{$required}|array|min:2|max:1000",
            'coordinates.*.lat' => 'required|numeric|between:-90,90',
            'coordinates.*.lng' => 'required|numeric|between:-180,180',
            'source' => ['sometimes', Rule::in(Building::SOURCES)],
            'osm_ref' => 'sometimes|nullable|string|max:64',
        ]);

        if (isset($validated['coordinates'])) {
            $validated['coordinates'] = GeoPoints::normalize($validated['coordinates']);
        }

        return $validated;
    }
}
