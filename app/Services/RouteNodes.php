<?php

namespace App\Services;

use App\Models\Node;
use Illuminate\Support\Facades\DB;

/**
 * Lays route nodes along a drawn line (a pathway, a bridge deck) so the router can use it.
 */
class RouteNodes
{
    /**
     * Route nodes closer than this to an existing route node on the same floor are not
     * created again, so running it twice, or on two lines that cross, stacks no duplicates.
     */
    public const DUPLICATE_RADIUS_M = 2.0;

    /**
     * One route node every `$spacing` metres along `$line`, on `$floor`, in one transaction.
     *
     * @param  list<array{lat: float, lng: float}>  $line
     * @param  float  $elevation  metres above the ground (a bridge deck's height; staircases read their rise from it)
     * @return list<Node> the nodes created
     */
    public static function layAlong(array $line, float $spacing, int $floor, string $pathType, string $campus, int $createdBy, float $elevation = 0.0): array
    {
        $existing = Node::where('type', 'route')
            ->where('floor_level', $floor)
            ->get(['latitude', 'longitude'])
            ->map(fn (Node $n) => ['lat' => $n->latitude, 'lng' => $n->longitude])
            ->all();

        return DB::transaction(function () use ($line, $spacing, $floor, $pathType, $campus, $createdBy, $existing, $elevation) {
            $created = [];

            foreach (GeoPoints::along($line, $spacing) as $point) {
                foreach ($existing as $other) {
                    if (GeoPoints::distance($point, $other) < self::DUPLICATE_RADIUS_M) {
                        continue 2;
                    }
                }

                $node = new Node([
                    'type' => 'route',
                    'latitude' => $point['lat'],
                    'longitude' => $point['lng'],
                    'elevation' => $elevation,
                    'floor_level' => $floor,
                    'path_type' => $pathType,
                    'campus' => $campus,
                ]);
                $node->created_by = $createdBy;
                $node->save();

                $existing[] = $point;
                $created[] = $node;
            }

            return $created;
        });
    }
}
