<?php

namespace App\Services;

/**
 * Small geometry helpers for building outlines and pathway lines stored as
 * [{lat, lng}, ...] JSON. Distances use a local flat-earth approximation,
 * which is well under a centimetre off across a campus.
 */
class GeoPoints
{
    private const EARTH_RADIUS_M = 6371000.0;

    /**
     * Keep only lat/lng (as floats) from validated input, so stray keys sent
     * by a client never end up stored in the JSON column.
     *
     * @param  array<int, array{lat: mixed, lng: mixed}>  $points
     * @return list<array{lat: float, lng: float}>
     */
    public static function normalize(array $points): array
    {
        return array_values(array_map(
            fn (array $p): array => ['lat' => round((float) $p['lat'], 7), 'lng' => round((float) $p['lng'], 7)],
            $points,
        ));
    }

    /**
     * Ground distance in metres between two points.
     *
     * @param  array{lat: float, lng: float}  $a
     * @param  array{lat: float, lng: float}  $b
     */
    public static function distance(array $a, array $b): float
    {
        [$east, $north] = self::offset($a, $b);

        return sqrt($east ** 2 + $north ** 2);
    }

    /**
     * Points every `$spacing` metres along a polyline, always including both
     * ends (a pathway's start and end are where people join it).
     *
     * @param  list<array{lat: float, lng: float}>  $line
     * @return list<array{lat: float, lng: float}>
     */
    public static function along(array $line, float $spacing): array
    {
        if (count($line) === 0) {
            return [];
        }

        $spacing = max(1.0, $spacing);
        $out = [$line[0]];
        $carried = 0.0;

        for ($i = 1; $i < count($line); $i++) {
            $from = $line[$i - 1];
            $to = $line[$i];
            $length = self::distance($from, $to);

            if ($length < 1e-6) {
                continue;
            }

            $at = $spacing - $carried;
            while ($at < $length) {
                $t = $at / $length;
                $out[] = [
                    'lat' => $from['lat'] + ($to['lat'] - $from['lat']) * $t,
                    'lng' => $from['lng'] + ($to['lng'] - $from['lng']) * $t,
                ];
                $at += $spacing;
            }
            $carried = $length - ($at - $spacing);
        }

        $last = $line[count($line) - 1];
        // Skip the end point when the last spaced point already sits on it.
        if (self::distance($out[count($out) - 1], $last) > $spacing * 0.25) {
            $out[] = $last;
        }

        return $out;
    }

    /**
     * Whether a point lies inside a polygon outline (ray casting). Points on
     * the very edge may fall either way, which is fine for "is this room in
     * the building".
     *
     * @param  list<array{lat: float, lng: float}>  $polygon
     */
    public static function contains(array $polygon, float $lat, float $lng): bool
    {
        $inside = false;
        $n = count($polygon);

        for ($i = 0, $j = $n - 1; $i < $n; $j = $i++) {
            $a = $polygon[$i];
            $b = $polygon[$j];
            if ((($a['lat'] > $lat) !== ($b['lat'] > $lat))
                && $lng < ($b['lng'] - $a['lng']) * ($lat - $a['lat']) / ($b['lat'] - $a['lat']) + $a['lng']) {
                $inside = ! $inside;
            }
        }

        return $inside;
    }

    /**
     * East/north offset in metres of $b from $a.
     *
     * @param  array{lat: float, lng: float}  $a
     * @param  array{lat: float, lng: float}  $b
     * @return array{0: float, 1: float}
     */
    /**
     * Shortest distance in metres from a point to a polyline (any of its segments).
     *
     * @param  list<array{lat: float, lng: float}>  $line
     * @param  array{lat: float, lng: float}  $point
     */
    public static function distanceToLine(array $line, array $point): float
    {
        $best = INF;
        for ($i = 1; $i < count($line); $i++) {
            [$ax, $ay] = self::offset($point, $line[$i - 1]);
            [$bx, $by] = self::offset($point, $line[$i]);
            $dx = $bx - $ax;
            $dy = $by - $ay;
            $len2 = $dx ** 2 + $dy ** 2;
            $t = $len2 > 0 ? max(0.0, min(1.0, -($ax * $dx + $ay * $dy) / $len2)) : 0.0;
            $best = min($best, hypot($ax + $t * $dx, $ay + $t * $dy));
        }

        return count($line) === 1 ? self::distance($line[0], $point) : $best;
    }

    private static function offset(array $a, array $b): array
    {
        $north = deg2rad($b['lat'] - $a['lat']) * self::EARTH_RADIUS_M;
        $east = deg2rad($b['lng'] - $a['lng']) * self::EARTH_RADIUS_M * cos(deg2rad(($a['lat'] + $b['lat']) / 2));

        return [$east, $north];
    }
}
