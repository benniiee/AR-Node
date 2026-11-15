<?php

namespace Database\Factories;

use App\Models\Building;
use Illuminate\Database\Eloquent\Factories\Factory;

/**
 * @extends Factory<Building>
 */
class BuildingFactory extends Factory
{
    /**
     * Define the model's default state: a ~30 m square on the pilot campus.
     *
     * @return array<string, mixed>
     */
    public function definition(): array
    {
        $lat = fake()->randomFloat(6, 6.9115, 6.9145);
        $lng = fake()->randomFloat(6, 122.0595, 122.0638);
        $d = 0.00014;

        return [
            'name' => fake()->unique()->words(2, true).' Building',
            'short_name' => strtoupper(fake()->lexify('???')),
            'floors' => 3,
            'status' => 'existing',
            'campus' => 'A',
            'polygon' => [
                ['lat' => $lat, 'lng' => $lng],
                ['lat' => $lat, 'lng' => $lng + $d],
                ['lat' => $lat + $d, 'lng' => $lng + $d],
                ['lat' => $lat + $d, 'lng' => $lng],
            ],
            'source' => 'custom',
        ];
    }

    /**
     * A building that is still being built.
     */
    public function underConstruction(): static
    {
        return $this->state(fn (array $attributes) => ['status' => 'under_construction']);
    }
}
