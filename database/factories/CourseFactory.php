<?php

namespace Database\Factories;

use App\Models\Course;
use Illuminate\Database\Eloquent\Factories\Factory;

/**
 * @extends Factory<Course>
 */
class CourseFactory extends Factory
{
    /**
     * A course with a unique made-up code and no department.
     *
     * @return array<string, mixed>
     */
    public function definition(): array
    {
        return [
            'code' => strtoupper('T'.fake()->unique()->bothify('??##')),
            'name' => 'Bachelor of '.fake()->words(2, true),
        ];
    }
}
