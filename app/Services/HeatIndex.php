<?php

namespace App\Services;

/**
 * Heat index ("feels like" temperature from heat and humidity) and its PAGASA category.
 *
 * Formula: US National Weather Service procedure (Rothfusz regression with the low- and
 * high-humidity adjustments), https://www.wpc.ncep.noaa.gov/html/heatindex_equation.shtml
 *
 * The SAME maths lives in ml/heat_common.py (training) and src/heatIndex.js (browser).
 * tests/fixtures/heat_index_grid.json (written by ml/train_heat.py) lets HeatIndexTest and
 * tests/heatIndex.test.mjs prove all three agree. Pure: no Laravel needed.
 */
class HeatIndex
{
    /**
     * PAGASA heat index levels: lower bound in deg C per category, ascending.
     * Below the first bound the category is "none". config/weather.php
     * (heat_categories) holds the values the app uses; these are the defaults.
     *
     * @var array<string, float>
     */
    public const DEFAULT_CATEGORIES = [
        'caution' => 27.0,
        'extreme_caution' => 33.0,
        'danger' => 42.0,
        'extreme_danger' => 52.0,
    ];

    /**
     * NWS heat index in deg F from air temperature (deg F) and relative humidity (%).
     */
    public static function fahrenheit(float $temperatureF, float $humidity): float
    {
        $t = $temperatureF;
        $rh = $humidity;

        // Simple formula first (it already averages with the temperature).
        $simple = 0.5 * ($t + 61.0 + ($t - 68.0) * 1.2 + $rh * 0.094);
        if ($simple < 80.0) {
            return $simple;
        }

        $hi = -42.379 + 2.04901523 * $t + 10.14333127 * $rh - 0.22475541 * $t * $rh
            - 0.00683783 * $t * $t - 0.05481717 * $rh * $rh + 0.00122874 * $t * $t * $rh
            + 0.00085282 * $t * $rh * $rh - 0.00000199 * $t * $t * $rh * $rh;

        if ($rh < 13.0 && $t >= 80.0 && $t <= 112.0) {
            $hi -= ((13.0 - $rh) / 4.0) * sqrt((17.0 - abs($t - 95.0)) / 17.0);
        } elseif ($rh > 85.0 && $t >= 80.0 && $t <= 87.0) {
            $hi += (($rh - 85.0) / 10.0) * ((87.0 - $t) / 5.0);
        }

        return $hi;
    }

    /**
     * NWS heat index in deg C from air temperature (deg C) and relative humidity (%).
     */
    public static function celsius(float $temperatureC, float $humidity): float
    {
        $temperatureF = $temperatureC * 9.0 / 5.0 + 32.0;

        return (self::fahrenheit($temperatureF, $humidity) - 32.0) * 5.0 / 9.0;
    }

    /**
     * PAGASA category key for a heat index in deg C: none, caution, extreme_caution, danger
     * or extreme_danger.
     *
     * @param  array<string, float|int>|null  $thresholds  lower bounds per key (config weather.heat_categories)
     */
    public static function category(float $heatIndexC, ?array $thresholds = null): string
    {
        $thresholds = $thresholds ?: self::DEFAULT_CATEGORIES;
        asort($thresholds);

        $key = 'none';
        foreach ($thresholds as $name => $lowerBound) {
            if ($heatIndexC >= (float) $lowerBound) {
                $key = (string) $name;
            }
        }

        return $key;
    }
}
