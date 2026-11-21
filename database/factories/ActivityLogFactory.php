<?php

namespace Database\Factories;

use App\Models\ActivityLog;
use Illuminate\Database\Eloquent\Factories\Factory;

/**
 * @extends Factory<ActivityLog>
 */
class ActivityLogFactory extends Factory
{
    /**
     * A visitor opening the map; states for a student sign-in and a staff change.
     *
     * @return array<string, mixed>
     */
    public function definition(): array
    {
        return [
            'role' => 'visitor',
            'action' => 'map.opened',
            'summary' => 'Opened the map',
            'ip' => fake()->ipv4(),
            'user_agent' => fake()->userAgent(),
        ];
    }

    public function studentLogin(string $course = 'BSIT', int $yearLevel = 2): static
    {
        return $this->state(fn () => [
            'role' => 'student', 'name' => fake()->name(), 'course' => $course, 'year_level' => $yearLevel,
            'action' => 'login', 'summary' => 'Signed in to the campus map',
        ]);
    }

    public function staffChange(string $role = 'faculty'): static
    {
        return $this->state(fn () => [
            'role' => $role, 'name' => fake()->name(), 'action' => 'PUT api/nodes/{node}', 'summary' => 'Edited node #1',
        ]);
    }
}
