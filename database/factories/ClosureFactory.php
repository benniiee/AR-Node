<?php

namespace Database\Factories;

use App\Models\Closure;
use Illuminate\Database\Eloquent\Factories\Factory;

/**
 * @extends Factory<Closure>
 */
class ClosureFactory extends Factory
{
    /**
     * Define the model's default state.
     *
     * @return array<string, mixed>
     */
    public function definition(): array
    {
        return [
            'kind' => 'closed',
            'reason' => fake()->sentence(3),
            'starts_at' => now()->subHour(),
            'ends_at' => now()->addHours(3),
        ];
    }

    /** Already over. */
    public function ended(): static
    {
        return $this->state(fn (): array => ['starts_at' => now()->subDays(2), 'ends_at' => now()->subDay()]);
    }
}
