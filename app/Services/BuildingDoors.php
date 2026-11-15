<?php

namespace App\Services;

/**
 * Saving building doors: the width rules and the stored shape. The phone draws
 * and routes them (src/doors.js); the limits mirror DOOR_WIDTH_M and
 * MIN/MAX_DOOR_WIDTH_M there.
 */
class BuildingDoors
{
    /** Width of a door saved without one (mirrors DOOR_WIDTH_M in src/doors.js). */
    public const DOOR_WIDTH_M = 2.0;

    public const MIN_DOOR_WIDTH_M = 0.8;

    public const MAX_DOOR_WIDTH_M = 6.0;

    /**
     * A door's width in metres: its own (clamped) or the default.
     *
     * @param  array<string, mixed>  $door
     */
    public static function width(array $door): float
    {
        $w = isset($door['width_m']) ? (float) $door['width_m'] : 0.0;

        return $w > 0 ? min(self::MAX_DOOR_WIDTH_M, max(self::MIN_DOOR_WIDTH_M, $w)) : self::DOOR_WIDTH_M;
    }

    /**
     * Doors as stored: lat/lng (7 decimals) and an optional width, nothing else.
     *
     * @param  array<int, array<string, mixed>>  $doors
     * @return list<array{lat: float, lng: float, width_m?: float}>
     */
    public static function normalize(array $doors): array
    {
        return array_values(array_map(fn (array $d): array => [
            'lat' => round((float) $d['lat'], 7),
            'lng' => round((float) $d['lng'], 7),
            ...(isset($d['width_m']) ? ['width_m' => round((float) $d['width_m'], 2)] : []),
        ], $doors));
    }
}
