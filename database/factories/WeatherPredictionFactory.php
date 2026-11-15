<?php

namespace Database\Factories;

use App\Models\WeatherPrediction;
use Illuminate\Database\Eloquent\Factories\Factory;

/**
 * @extends Factory<WeatherPrediction>
 */
class WeatherPredictionFactory extends Factory
{
    /**
     * A model-scored refresh with a three-hour heat outlook and no outcomes yet.
     *
     * @return array<string, mixed>
     */
    public function definition(): array
    {
        $at = now()->subHours(fake()->numberBetween(1, 48))->startOfMinute();
        $heat = fake()->randomFloat(1, 26, 34);

        return [
            'predicted_at' => $at,
            'rain_probability' => fake()->numberBetween(0, 60),
            'probability_source' => 'model',
            'provider_probability' => fake()->numberBetween(0, 100),
            'alert_threshold' => 0.21,
            'raining_now' => false,
            'rain_mode' => false,
            'heat_index_c' => $heat,
            'heat_source' => 'model',
            'heat_forecast' => collect([1, 2, 3])->map(fn (int $h): array => [
                'hours_ahead' => $h,
                'at' => $at->copy()->startOfHour()->addHours($h)->toIso8601String(),
                'heat_index_c' => round($heat + $h * 0.3, 1),
                'provider_heat_index_c' => round($heat + $h * 0.5, 1),
            ])->all(),
            'airport_report' => 'METAR RPMZ 071500Z 10005KT 9999 FEW015 BKN016 30/24 Q1013',
        ];
    }

    /** Outcomes filled in: it rained at the airport and each heat target was observed. */
    public function settled(bool $rained = false): static
    {
        return $this->state(fn (array $attributes): array => [
            'rain_outcome' => $rained,
            'heat_outcomes' => collect($attributes['heat_forecast'])
                ->mapWithKeys(fn (array $item): array => [(string) $item['hours_ahead'] => $item['heat_index_c'] - 0.4])
                ->all(),
            'outcomes_settled_at' => now(),
        ]);
    }
}
