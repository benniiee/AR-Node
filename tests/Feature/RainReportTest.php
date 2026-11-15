<?php

namespace Tests\Feature;

use App\Models\RainReport;
use App\Models\User;
use App\Services\WeatherService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;
use Illuminate\Testing\TestResponse;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

class RainReportTest extends TestCase
{
    use RefreshDatabase;

    /** A dry cached weather state, as the last scheduled refresh left it. */
    private function dryState(): void
    {
        Cache::forever(config('weather.cache_key'), [
            'status' => 'ok', 'raining_now' => false, 'raining_now_source' => 'airport', 'rain_mode' => false,
            'rain_multiplier' => 1.0, 'rain_probability' => 3, 'fetched_at' => now()->toIso8601String(),
        ]);
    }

    private function report(User $user): TestResponse
    {
        Sanctum::actingAs($user);

        return $this->postJson('/api/weather/rain-report');
    }

    public function test_one_report_is_counted_but_does_not_turn_rain_on(): void
    {
        $this->dryState();

        $this->report(User::factory()->student()->create())
            ->assertCreated()
            ->assertJsonPath('rain_reports', 1)
            ->assertJsonPath('rain_reports_min', 2)
            ->assertJsonPath('raining_now', false);
        $this->assertSame(1, RainReport::count());
    }

    public function test_two_people_turn_rain_on_for_everyone_at_once(): void
    {
        $this->dryState();
        $this->report(User::factory()->student()->create());

        $this->report(User::factory()->student()->create())
            ->assertCreated()
            ->assertJsonPath('raining_now', true)
            ->assertJsonPath('raining_now_source', 'reports')
            ->assertJsonPath('rain_mode', true);

        // Every other phone reads the cached state (and the static file written from it).
        $this->assertTrue(app(WeatherService::class)->current()['raining_now']);
        $this->assertEquals((float) config('weather.rain_penalty'), Cache::get(config('weather.cache_key'))['rain_multiplier']);
    }

    public function test_the_same_person_cannot_report_twice_within_five_minutes(): void
    {
        $this->dryState();
        $student = User::factory()->student()->create();

        $this->report($student)->assertCreated();
        $this->report($student)->assertStatus(429)->assertJsonStructure(['message']);
        $this->assertSame(1, RainReport::count());
    }

    public function test_visitors_cannot_report(): void
    {
        $this->postJson('/api/weather/rain-report')->assertUnauthorized();
        $this->assertSame(0, RainReport::count());
    }

    public function test_the_scheduled_refresh_keeps_recent_reports_and_drops_old_ones(): void
    {
        config(['weather.use_model' => false]);
        Http::fake(['*' => Http::response(['current' => ['temperature_2m' => 28, 'precipitation' => 0, 'weather_code' => 3],
            'hourly' => ['precipitation_probability' => [5, 5, 5], 'weather_code' => [3, 3, 3]]])]);

        RainReport::factory()->count(2)->minutesAgo(5)->create();
        $state = app(WeatherService::class)->refresh();
        $this->assertTrue($state['raining_now']);
        $this->assertSame('reports', $state['raining_now_source']);

        RainReport::query()->update(['created_at' => now()->subMinutes(20)]);
        $state = app(WeatherService::class)->refresh();
        $this->assertFalse($state['raining_now']);
        $this->assertSame(0, $state['rain_reports']);
    }

    public function test_reports_never_turn_rain_off(): void
    {
        config(['weather.use_model' => false]);
        // The forecast says it is raining now; nobody reported anything.
        Http::fake(['*' => Http::response(['current' => ['temperature_2m' => 25, 'precipitation' => 2.0, 'weather_code' => 63],
            'hourly' => ['precipitation_probability' => [90, 90, 90], 'weather_code' => [63, 63, 63]]])]);

        $state = app(WeatherService::class)->refresh();

        $this->assertTrue($state['raining_now']);
        $this->assertNotSame('reports', $state['raining_now_source'] ?? null);
    }
}
