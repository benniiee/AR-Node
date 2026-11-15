<?php

namespace Tests\Unit;

use App\Services\HeatIndex;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

class HeatIndexTest extends TestCase
{
    /**
     * Points read off the NWS heat index chart (deg F, % RH, chart value deg F).
     * https://www.weather.gov/safety/heat-index
     *
     * @return array<string, array{0: float, 1: float, 2: float}>
     */
    public static function nwsChartPoints(): array
    {
        return [
            '80F 40%' => [80.0, 40.0, 80.0],
            '86F 90%' => [86.0, 90.0, 105.0],
            '88F 60%' => [88.0, 60.0, 95.0],
            '90F 50%' => [90.0, 50.0, 95.0],
            '94F 75%' => [94.0, 75.0, 124.0],
            '96F 65%' => [96.0, 65.0, 121.0],
            '100F 40%' => [100.0, 40.0, 109.0],
            '104F 55%' => [104.0, 55.0, 137.0],
        ];
    }

    #[DataProvider('nwsChartPoints')]
    public function test_matches_the_nws_chart(float $temperatureF, float $humidity, float $chart): void
    {
        // The chart prints whole degrees, so allow rounding either way.
        $this->assertEqualsWithDelta($chart, HeatIndex::fahrenheit($temperatureF, $humidity), 1.0);
    }

    public function test_cool_air_uses_the_simple_formula(): void
    {
        // 70 F at 50 %: simple formula 0.5 * (70 + 61 + 2.4 + 4.7) = 69.05 F.
        $this->assertEqualsWithDelta(69.05, HeatIndex::fahrenheit(70.0, 50.0), 1e-9);
    }

    public function test_low_humidity_adjustment_lowers_the_value(): void
    {
        $regression = -42.379 + 2.04901523 * 100 + 10.14333127 * 10 - 0.22475541 * 100 * 10
            - 0.00683783 * 100 * 100 - 0.05481717 * 10 * 10 + 0.00122874 * 100 * 100 * 10
            + 0.00085282 * 100 * 10 * 10 - 0.00000199 * 100 * 100 * 10 * 10;
        $adjustment = ((13 - 10) / 4) * sqrt((17 - abs(100 - 95)) / 17);

        $this->assertEqualsWithDelta($regression - $adjustment, HeatIndex::fahrenheit(100.0, 10.0), 1e-9);
    }

    public function test_high_humidity_adjustment_raises_the_value(): void
    {
        $t = 84.0;
        $rh = 95.0;
        $regression = -42.379 + 2.04901523 * $t + 10.14333127 * $rh - 0.22475541 * $t * $rh
            - 0.00683783 * $t * $t - 0.05481717 * $rh * $rh + 0.00122874 * $t * $t * $rh
            + 0.00085282 * $t * $rh * $rh - 0.00000199 * $t * $t * $rh * $rh;
        $adjustment = (($rh - 85) / 10) * ((87 - $t) / 5);

        $this->assertEqualsWithDelta($regression + $adjustment, HeatIndex::fahrenheit($t, $rh), 1e-9);
    }

    public function test_celsius_converts_both_ways(): void
    {
        // 32.2 C = 90 F; 90 F at 50 % is about 95 F = 35 C on the chart.
        $this->assertEqualsWithDelta(35.0, HeatIndex::celsius((90 - 32) * 5 / 9, 50.0), 0.6);
    }

    public function test_pagasa_categories_and_bounds(): void
    {
        $this->assertSame('none', HeatIndex::category(26.9));
        $this->assertSame('caution', HeatIndex::category(27.0));
        $this->assertSame('caution', HeatIndex::category(32.9));
        $this->assertSame('extreme_caution', HeatIndex::category(33.0));
        $this->assertSame('extreme_caution', HeatIndex::category(41.9));
        $this->assertSame('danger', HeatIndex::category(42.0));
        $this->assertSame('danger', HeatIndex::category(51.9));
        $this->assertSame('extreme_danger', HeatIndex::category(52.0));
    }

    public function test_custom_thresholds_are_used_in_any_order(): void
    {
        $this->assertSame('danger', HeatIndex::category(40.0, ['danger' => 40, 'caution' => 30]));
    }

    public function test_matches_the_python_grid_shared_with_javascript(): void
    {
        $grid = json_decode((string) file_get_contents(dirname(__DIR__).'/fixtures/heat_index_grid.json'), true, 512, JSON_THROW_ON_ERROR);
        $this->assertNotEmpty($grid['cases']);

        foreach ($grid['cases'] as $case) {
            $label = "{$case['t_c']} C {$case['rh']} %";
            $value = HeatIndex::celsius((float) $case['t_c'], (float) $case['rh']);
            $this->assertEqualsWithDelta($case['heat_index_c'], $value, 1e-5, $label);
            $this->assertSame($case['category'], HeatIndex::category($value), $label);
        }
    }
}
