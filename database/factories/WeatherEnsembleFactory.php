<?php

namespace Database\Factories;

use App\Models\WeatherEnsemble;
use Illuminate\Database\Eloquent\Factories\Factory;

/**
 * @extends Factory<WeatherEnsemble>
 */
class WeatherEnsembleFactory extends Factory
{
    /**
     * One refresh with two ensembles and the current and next hour each.
     *
     * @return array<string, mixed>
     */
    public function definition(): array
    {
        $at = now()->subHours(fake()->numberBetween(1, 48))->startOfMinute();
        $hours = fn (): array => collect([0, 1])->map(fn (int $h): array => [
            'at' => $at->copy()->setTimezone('Asia/Manila')->startOfHour()->addHours($h)->format('Y-m-d\TH:i'),
            'wet_share' => fake()->randomFloat(3, 0, 1),
            'heavy_share' => fake()->randomFloat(3, 0, 0.3),
            'mean_mm' => fake()->randomFloat(2, 0, 3),
            'max_mm' => fake()->randomFloat(2, 0, 10),
        ])->all();

        return [
            'fetched_at' => $at,
            'models' => [
                'ecmwf_ifs025' => ['members' => 51, 'hours' => $hours()],
                'ncep_gefs025' => ['members' => 31, 'hours' => $hours()],
            ],
        ];
    }
}
