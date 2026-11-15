<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Building;
use App\Models\Node;
use App\Models\Pathway;
use App\Services\GeoPoints;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\Rule;

class PathwayController extends Controller
{
    /**
     * Route nodes closer than this to an existing ground-floor route node are
     * not created again, so running the generator twice, or on two pathways
     * that cross, does not stack duplicate nodes.
     */
    private const DUPLICATE_RADIUS_M = 2.0;

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
     * Lay ground-floor route nodes along a pathway every `spacing_m` metres
     * (admin only), so the router can use a road or walkway that was only
     * drawn. Covered walkways get `inside` nodes (sheltered in rain mode).
     */
    public function generateRouteNodes(Request $request, Pathway $pathway): JsonResponse
    {
        abort_unless($request->user()->isAdmin(), 403);

        $validated = $request->validate([
            'spacing_m' => 'sometimes|numeric|min:3|max:50',
            'campus' => 'sometimes|in:A,B',
        ]);

        $spacing = (float) ($validated['spacing_m'] ?? 8);
        $existing = Node::where('type', 'route')
            ->where('floor_level', 0)
            ->get(['latitude', 'longitude'])
            ->map(fn (Node $n) => ['lat' => $n->latitude, 'lng' => $n->longitude])
            ->all();

        $created = DB::transaction(function () use ($pathway, $spacing, $existing, $validated, $request) {
            $created = [];

            foreach (GeoPoints::along($pathway->coordinates, $spacing) as $point) {
                foreach ($existing as $other) {
                    if (GeoPoints::distance($point, $other) < self::DUPLICATE_RADIUS_M) {
                        continue 2;
                    }
                }

                $node = new Node([
                    'type' => 'route',
                    'latitude' => $point['lat'],
                    'longitude' => $point['lng'],
                    'elevation' => 0,
                    'floor_level' => 0,
                    'path_type' => $pathway->nodePathType(),
                    'campus' => $validated['campus'] ?? 'A',
                ]);
                $node->created_by = $request->user()->id;
                $node->save();

                $existing[] = $point;
                $created[] = $node;
            }

            return $created;
        });

        return response()->json([
            'created' => count($created),
            'nodes' => $created,
        ], 201);
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
