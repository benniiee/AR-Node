<?php

namespace Database\Factories;

use App\Models\Bridge;
use Illuminate\Database\Eloquent\Factories\Factory;

/**
 * @extends Factory<Bridge>
 */
class BridgeFactory extends Factory
{
    /**
     * A roofed footbridge one floor up: a deck about 30 m long and 3 m wide on the pilot campus.
     *
     * @return array<string, mixed>
     */
    public function definition(): array
    {
        $lat = fake()->randomFloat(6, 6.9115, 6.9145);
        $lng = fake()->randomFloat(6, 122.0595, 122.0638);

        return [
            'name' => fake()->unique()->words(2, true).' Footbridge',
            'kind' => 'bridge',
            'polygon' => [
                ['lat' => $lat, 'lng' => $lng],
                ['lat' => $lat, 'lng' => $lng + 0.00027],
                ['lat' => $lat + 0.000027, 'lng' => $lng + 0.00027],
                ['lat' => $lat + 0.000027, 'lng' => $lng],
            ],
            'deck_floor' => 1,
            'roofed' => true,
            'status' => 'existing',
            'source' => 'custom',
        ];
    }

    /** A crossing at road level, without a roof. */
    public function atGround(): static
    {
        return $this->state(fn (array $attributes) => ['deck_floor' => 0, 'roofed' => false]);
    }
}
