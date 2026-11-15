<?php

namespace Database\Factories;

use App\Models\Pathway;
use Illuminate\Database\Eloquent\Factories\Factory;

/**
 * @extends Factory<Pathway>
 */
class PathwayFactory extends Factory
{
    /**
     * Define the model's default state: a straight ~50 m east-west walkway.
     *
     * @return array<string, mixed>
     */
    public function definition(): array
    {
        $lat = fake()->randomFloat(6, 6.9115, 6.9145);
        $lng = fake()->randomFloat(6, 122.0595, 122.0630);

        return [
            'name' => fake()->streetName(),
            'kind' => 'walkway',
            'status' => 'existing',
            'coordinates' => [
                ['lat' => $lat, 'lng' => $lng],
                ['lat' => $lat, 'lng' => $lng + 0.00045],
            ],
            'source' => 'custom',
        ];
    }

    /**
     * A covered (sheltered) walkway.
     */
    public function covered(): static
    {
        return $this->state(fn (array $attributes) => ['kind' => 'covered']);
    }
}
