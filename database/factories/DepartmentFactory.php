<?php

namespace Database\Factories;

use App\Models\Department;
use Illuminate\Database\Eloquent\Factories\Factory;

/**
 * @extends Factory<Department>
 */
class DepartmentFactory extends Factory
{
    /**
     * Define the model's default state.
     *
     * @return array<string, mixed>
     */
    public function definition(): array
    {
        return [
            'name' => fake()->unique()->company().' Dept',
            'color' => fake()->hexColor(),
        ];
    }

    /** An office (registrar, cashier, canteen...): staff only, no courses. */
    public function office(): static
    {
        return $this->state(fn (): array => ['kind' => 'office']);
    }
}
