<?php

namespace Database\Factories;

use App\Models\CampusObject;
use Illuminate\Database\Eloquent\Factories\Factory;

/**
 * @extends Factory<CampusObject>
 */
class CampusObjectFactory extends Factory
{
    /**
     * A tree near the demo campus centre.
     *
     * @return array<string, mixed>
     */
    public function definition(): array
    {
        return [
            'kind' => 'tree',
            'latitude' => 6.9100 + fake()->randomFloat(5, -0.0005, 0.0005),
            'longitude' => 122.0710 + fake()->randomFloat(5, -0.0005, 0.0005),
            'rotation_deg' => 0,
            'height_m' => 6,
            'width_m' => 5,
            'form' => 'round',
            'seed' => fake()->numberBetween(1, 1_000_000),
        ];
    }

    /** A gate: an opening in a wall. */
    public function gate(): static
    {
        return $this->state(fn () => ['kind' => 'gate', 'height_m' => 2.2, 'width_m' => 3, 'form' => null]);
    }
}
