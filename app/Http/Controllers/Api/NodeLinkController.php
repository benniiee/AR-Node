<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Building;
use App\Models\Node;
use App\Models\NodeLink;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class NodeLinkController extends Controller
{
    /**
     * Every staircase link. Same data the public /api/map-data feed carries;
     * the admin map reads it here so it stays in sync after each edit.
     */
    public function index(): JsonResponse
    {
        return response()->json(NodeLink::orderBy('id')->get());
    }

    /**
     * Join two nodes on DIFFERENT floors as the ends of one staircase.
     * The pair is normalised (smaller id first) so A-B and B-A are the same
     * link and cannot be created twice.
     */
    public function store(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'node_a_id' => 'required|integer|exists:nodes,id',
            'node_b_id' => 'required|integer|exists:nodes,id|different:node_a_id',
            'angle_deg' => 'nullable|numeric|between:'.NodeLink::MIN_ANGLE.','.NodeLink::MAX_ANGLE,
            ...$this->shapeRules(),
        ]);

        $a = Node::findOrFail($validated['node_a_id']);
        $b = Node::findOrFail($validated['node_b_id']);

        $this->authorizeBoth($request, $a, $b);

        abort_if(
            (int) $a->floor_level === (int) $b->floor_level,
            422,
            'A staircase must join two nodes on different floors.'
        );

        [$lowId, $highId] = $a->id < $b->id ? [$a->id, $b->id] : [$b->id, $a->id];

        abort_if(
            NodeLink::where('node_a_id', $lowId)->where('node_b_id', $highId)->exists(),
            422,
            'These two nodes are already connected.'
        );

        $link = NodeLink::create([
            'node_a_id' => $lowId,
            'node_b_id' => $highId,
            'kind' => 'stairs',
            'angle_deg' => $validated['angle_deg'] ?? 45,
            ...$this->shapeAttributes($validated),
        ]);

        return response()->json($link, 201);
    }

    /**
     * Change the staircase: slope, direction (yaw), shape (flights) or landing.
     * Send only the fields that changed.
     */
    public function update(Request $request, NodeLink $nodeLink): JsonResponse
    {
        $this->authorizeBoth($request, $nodeLink->nodeA, $nodeLink->nodeB);

        $validated = $request->validate([
            'angle_deg' => 'sometimes|numeric|between:'.NodeLink::MIN_ANGLE.','.NodeLink::MAX_ANGLE,
            ...$this->shapeRules(),
        ]);

        abort_if($validated === [], 422, 'Nothing to change.');

        $changes = $this->shapeAttributes($validated);
        if (isset($validated['angle_deg']) && ! array_key_exists('angle_deg', $changes)) {
            // Slope only (older clients): the per-flight slopes of a
            // multi-flight stair are left alone.
            $changes['angle_deg'] = $validated['angle_deg'];
        }

        $nodeLink->update($changes);

        return response()->json($nodeLink);
    }

    public function destroy(Request $request, NodeLink $nodeLink): JsonResponse
    {
        $this->authorizeBoth($request, $nodeLink->nodeA, $nodeLink->nodeB);

        $nodeLink->delete();

        return response()->json(['message' => 'Link removed']);
    }

    /**
     * Validation rules for the shape fields. yaw may be any angle (it is
     * wrapped to 0-360); the first flight's turn is ignored and stored as 0.
     */
    private function shapeRules(): array
    {
        return [
            'yaw_deg' => 'sometimes|nullable|numeric|between:-360,720',
            'landing_m' => 'sometimes|nullable|numeric|between:'.NodeLink::MIN_LANDING.','.NodeLink::MAX_LANDING,
            'flights' => 'sometimes|nullable|array|min:1|max:'.NodeLink::MAX_FLIGHTS,
            'flights.*.angle_deg' => 'nullable|numeric|between:'.NodeLink::MIN_ANGLE.','.NodeLink::MAX_ANGLE,
            'flights.*.turn_deg' => 'nullable|numeric|between:-180,180',
        ];
    }

    /**
     * Turn validated shape input into column values. Only the keys that were
     * sent are returned, so a partial update never wipes the rest.
     */
    private function shapeAttributes(array $validated): array
    {
        $out = [];

        if (array_key_exists('yaw_deg', $validated)) {
            if ($validated['yaw_deg'] === null) {
                $out['yaw_deg'] = null;
            } else {
                $yaw = fmod((float) $validated['yaw_deg'], 360.0);
                $out['yaw_deg'] = round($yaw < 0 ? $yaw + 360.0 : $yaw, 1);
            }
        }

        if (array_key_exists('landing_m', $validated) && $validated['landing_m'] !== null) {
            $out['landing_m'] = round((float) $validated['landing_m'], 2);
        }

        if (array_key_exists('flights', $validated)) {
            if ($validated['flights'] === null) {
                $out['flights'] = null;
            } else {
                $fallback = (float) ($validated['angle_deg'] ?? 45);
                $flights = [];
                foreach (array_values($validated['flights']) as $i => $f) {
                    $flights[] = [
                        'angle_deg' => round((float) ($f['angle_deg'] ?? $fallback), 2),
                        'turn_deg' => $i === 0 ? 0 : round((float) ($f['turn_deg'] ?? 0), 1),
                    ];
                }
                // One straight flight is the legacy shape: store it as null.
                $out['flights'] = count($flights) === 1 ? null : $flights;
                // Keep the legacy column as the average slope.
                $out['angle_deg'] = round(array_sum(array_column($flights, 'angle_deg')) / count($flights), 2);
            }
        }

        return $out;
    }

    /**
     * Same rule as NodeController: admins edit anything; faculty only when
     * they placed BOTH nodes, so nobody can wire a staircase into a node that
     * belongs to someone else.
     */
    private function authorizeBoth(Request $request, Node $a, Node $b): void
    {
        $user = $request->user();

        if ($user->isAdmin()) {
            return;
        }

        // Staff connect their own nodes, to each other or to the shared
        // outdoor network (nodes outside any building), e.g. an outside
        // stair up to a second-floor entrance. At least one end is theirs.
        // "Theirs": inside one of their department's buildings. Same rule as NodeController.
        $mine = fn (Node $node): bool => $node->building_id !== null && $user->department_id !== null
            && Building::whereKey($node->building_id)->where('department_id', $user->department_id)->exists();
        $shared = fn (Node $node): bool => $node->building_id === null;

        abort_unless(
            ($mine($a) || $mine($b)) && ($mine($a) || $shared($a)) && ($mine($b) || $shared($b)),
            403,
            'You can only connect your department\'s nodes, or one of them to an outdoor node.'
        );
    }
}
