<?php

namespace Database\Factories;

use App\Models\CampusArea;
use Illuminate\Database\Eloquent\Factories\Factory;

/**
 * @extends Factory<CampusArea>
 */
class CampusAreaFactory extends Factory
{
    /**
     * A small square around the demo campus centre.
     *
     * @return array<string, mixed>
     */
    public function definition(): array
    {
        return [
            'name' => 'Campus '.fake()->unique()->randomLetter(),
            'color' => fake()->hexColor(),
            'polygon' => [
                ['lat' => 6.9090, 'lng' => 122.0700],
                ['lat' => 6.9090, 'lng' => 122.0720],
                ['lat' => 6.9110, 'lng' => 122.0720],
                ['lat' => 6.9110, 'lng' => 122.0700],
            ],
        ];
    }
}
