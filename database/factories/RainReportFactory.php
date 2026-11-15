<?php

namespace Database\Factories;

use App\Models\RainReport;
use App\Models\User;
use Illuminate\Database\Eloquent\Factories\Factory;

/**
 * @extends Factory<RainReport>
 */
class RainReportFactory extends Factory
{
    /**
     * @return array<string, mixed>
     */
    public function definition(): array
    {
        return [
            'user_id' => User::factory(),
        ];
    }

    /** A report made this many minutes ago. */
    public function minutesAgo(int $minutes): static
    {
        return $this->state(fn (): array => ['created_at' => now()->subMinutes($minutes), 'updated_at' => now()->subMinutes($minutes)]);
    }
}
