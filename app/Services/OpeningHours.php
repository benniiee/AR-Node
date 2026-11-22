<?php

namespace App\Services;

use Illuminate\Validation\ValidationException;

/**
 * Weekly opening hours of a building or a place, as stored: every day of the week with its open
 * ranges in campus time, e.g. {"mon": [["08:00", "12:00"], ["13:00", "17:00"]], ..., "sun": []}.
 * An empty day is closed all day; no hours at all (null) means no set hours (always open). The phone
 * reads them in src/openingHours.js (same day keys and format).
 */
class OpeningHours
{
    public const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

    /** Open ranges a single day may have (e.g. a morning and an afternoon around lunch). */
    public const MAX_RANGES = 4;

    /**
     * Validation rules for an `opening_hours` field (its shape; the order of times is checked by normalize).
     *
     * @return array<string, mixed>
     */
    public static function rules(string $field = 'opening_hours'): array
    {
        // Only the seven day keys: anything else is refused, never silently dropped (which would close every day).
        $rules = [$field => 'sometimes|nullable|array:'.implode(',', self::DAYS)];
        foreach (self::DAYS as $day) {
            $rules["{$field}.{$day}"] = 'sometimes|array|max:'.self::MAX_RANGES;
            $rules["{$field}.{$day}.*"] = 'array|size:2';
            $rules["{$field}.{$day}.*.*"] = ['string', 'regex:/^([01]\d|2[0-3]):[0-5]\d$|^24:00$/'];
        }

        return $rules;
    }

    /**
     * Hours as stored: every day present (missing ones closed), ranges in order. Null when none are
     * given. Each range must close after it opens, and a day's ranges may not overlap.
     *
     * @param  array<string, mixed>|null  $hours
     * @return array<string, list<array{0: string, 1: string}>>|null
     *
     * @throws ValidationException
     */
    public static function normalize(?array $hours, string $field = 'opening_hours'): ?array
    {
        if ($hours === null) {
            return null;
        }
        $unknown = array_diff(array_keys($hours), self::DAYS);
        if ($unknown !== []) {
            throw ValidationException::withMessages([$field => ['Unknown day: '.implode(', ', $unknown).'.']]);
        }

        $out = [];
        foreach (self::DAYS as $day) {
            $ranges = array_values($hours[$day] ?? []);
            usort($ranges, fn (array $a, array $b): int => strcmp($a[0], $b[0]));
            foreach ($ranges as $i => [$open, $close]) {
                if ($close <= $open) {
                    throw ValidationException::withMessages(["{$field}.{$day}" => ["Closing time must be after opening time ({$open}-{$close})."]]);
                }
                if ($i > 0 && $open < $ranges[$i - 1][1]) {
                    throw ValidationException::withMessages(["{$field}.{$day}" => ['Opening hours on the same day may not overlap.']]);
                }
            }
            $out[$day] = array_map(fn (array $r): array => [$r[0], $r[1]], $ranges);
        }

        return $out;
    }
}
