<?php

namespace Tests\Feature;

use App\Models\User;
use App\Models\WeatherPrediction;
use App\Services\HeatIndex;
use App\Services\Metar;
use App\Services\WeatherHistory;
use App\Services\WeatherService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

class WeatherHistoryTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();

        Cache::flush();
        Http::preventStrayRequests();
    }

    /** A prediction made at 20:05 Manila time with heat targets at 21:00, 22:00 and 23:00. */
    private function prediction(): WeatherPrediction
    {
        return WeatherPrediction::factory()->create([
            'predicted_at' => Carbon::parse('2026-11-07T20:05:00+08:00')->setTimezone(config('app.timezone')),
            'rain_probability' => 30,
            'heat_forecast' => collect([1, 2, 3])->map(fn (int $h): array => [
                'hours_ahead' => $h,
                'at' => sprintf('2026-11-07T%02d:00:00+08:00', 20 + $h),
                'heat_index_c' => 28.0,
                'provider_heat_index_c' => 29.0,
            ])->all(),
        ]);
    }

    public function test_outcomes_come_from_the_report_nearest_each_target(): void
    {
        $row = $this->prediction();
        $reports = [
            // 20:05 -> step 20:00 -> rain target 20:20; the 20:30 report is 10 minutes away.
            ['time' => '2026-11-07T20:30', 'raw' => 'RPMZ 071230Z 08006KT 9000 -TSRA FEW016CB 27/25 Q1012'],
            ['time' => '2026-11-07T21:00', 'raw' => 'RPMZ 071300Z 08006KT 9999 FEW016 30/24 Q1012'],
            ['time' => '2026-11-07T22:00', 'raw' => 'RPMZ 071400Z 08006KT 9999 FEW016 29/24 Q1012'],
        ];

        app(WeatherHistory::class)->fillOutcomes($reports, Carbon::parse('2026-11-07T22:40:00+08:00'));
        $row->refresh();

        $this->assertTrue($row->rain_outcome);
        $this->assertSame(Metar::heatIndex('30/24'), $row->heat_outcomes['1']);
        $this->assertSame(Metar::heatIndex('29/24'), $row->heat_outcomes['2']);
        // 23:00 is not due yet, so the row keeps waiting.
        $this->assertArrayNotHasKey('3', $row->heat_outcomes);
        $this->assertNull($row->outcomes_settled_at);

        app(WeatherHistory::class)->fillOutcomes([], Carbon::parse('2026-11-07T23:40:00+08:00'));
        $row->refresh();

        // Past the last target with no report for it: settled, and the gap stays null.
        $this->assertNull($row->heat_outcomes['3']);
        $this->assertNotNull($row->outcomes_settled_at);
    }

    public function test_airport_heat_index_uses_temperature_and_dew_point(): void
    {
        $this->assertSame([26.0, 24.0], Metar::temperatureDewPoint('RPMZ 071500Z 10005KT 9999 FEW015CB BKN016 26/24 Q1013'));
        $this->assertSame([-1.0, -3.0], Metar::temperatureDewPoint('XXXX 071500Z 00000KT 9999 M01/M03 Q1013'));
        $this->assertNull(Metar::temperatureDewPoint('RPMZ 071500Z 10005KT 9999 Q1013 RMK 26/24'));

        // 30 C with a 24 C dew point is about 70% humidity.
        $this->assertEqualsWithDelta(HeatIndex::celsius(30.0, 70.2), Metar::heatIndex('30/24'), 0.15);
    }

    public function test_summary_scores_the_model_against_the_airport(): void
    {
        WeatherPrediction::factory()->settled(rained: true)->create(['rain_probability' => 75, 'provider_probability' => 40, 'rain_mode' => true]);
        WeatherPrediction::factory()->settled(rained: false)->create(['rain_probability' => 5, 'provider_probability' => 90]);
        WeatherPrediction::factory()->create(['rain_probability' => 12]);

        $summary = app(WeatherHistory::class)->summary(7);

        $this->assertSame(3, $summary['count']);
        $rain = $summary['rain'];
        $this->assertSame(2, $rain['stats']['checked']);
        $this->assertSame(1, $rain['stats']['caught']);
        // Model: (0.75 - 1)^2 and (0.05 - 0)^2; Open-Meteo: (0.40 - 1)^2 and (0.90 - 0)^2.
        $this->assertEqualsWithDelta((0.0625 + 0.0025) / 2, $rain['stats']['brier_model'], 1e-4);
        $this->assertEqualsWithDelta((0.36 + 0.81) / 2, $rain['stats']['brier_provider'], 1e-4);
        $this->assertSame(1, $rain['histogram'][7]['rained']);
        $this->assertSame(1, $rain['histogram'][0]['dry']);
        $this->assertSame(1, $rain['histogram'][1]['unchecked']);

        // The settled() state observes 0.4 C less than predicted at every horizon.
        $plus1 = $summary['heat']['stats']['horizons'][0];
        $this->assertSame(2, $plus1['checked']);
        $this->assertEqualsWithDelta(0.4, $plus1['mae_model'], 1e-9);
        $this->assertEqualsWithDelta(0.4, $plus1['bias_model'], 1e-9);
    }

    public function test_only_admins_can_read_the_history(): void
    {
        WeatherPrediction::factory()->count(2)->create();

        Sanctum::actingAs(User::factory()->create(['role' => 'faculty']));
        $this->getJson('/api/weather/history')->assertForbidden();

        Sanctum::actingAs(User::factory()->create(['role' => 'admin']));
        $this->getJson('/api/weather/history?days=5')->assertUnprocessable();
        $this->getJson('/api/weather/history?days=30')
            ->assertOk()
            ->assertJsonPath('count', 2)
            ->assertJsonPath('period.days', 30)
            ->assertJsonStructure(['rain' => ['series', 'histogram', 'stats'], 'heat' => ['series', 'histogram', 'stats'], 'recent']);
    }

    public function test_every_refresh_is_recorded_with_the_provider_numbers(): void
    {
        Http::fake(function (Request $request) {
            if (str_contains($request->url(), 'aviationweather.gov')) {
                return Http::response([['obsTime' => now()->subMinutes(30)->getTimestamp(), 'rawOb' => 'METAR RPMZ 071500Z 10005KT 9999 FEW015CB 26/24 Q1013']]);
            }

            return Http::response([
                'current' => ['temperature_2m' => 30.0, 'relative_humidity_2m' => 70, 'precipitation' => 0.0, 'weather_code' => 3],
                'hourly' => ['precipitation_probability' => [35, 35]],
            ]);
        });

        app(WeatherService::class)->refresh();

        $row = WeatherPrediction::sole();
        $this->assertSame(35, $row->provider_probability);
        $this->assertStringContainsString('RPMZ 071500Z', (string) $row->airport_report);
    }

    private function fakeProviders(): void
    {
        Http::fake(function (Request $request) {
            if (str_contains($request->url(), 'aviationweather.gov')) {
                return Http::response([]);
            }

            return Http::response([
                'current' => ['temperature_2m' => 30.0, 'relative_humidity_2m' => 70, 'precipitation' => 0.0, 'weather_code' => 3],
                'hourly' => ['precipitation_probability' => [35, 35]],
            ]);
        });
    }

    public function test_admin_can_update_the_weather_now(): void
    {
        $this->fakeProviders();
        Sanctum::actingAs(User::factory()->create(['role' => 'admin']));

        $this->postJson('/api/weather/refresh')->assertOk()->assertJsonPath('status', 'ok');

        $this->assertSame(1, WeatherPrediction::count());
        $this->assertSame('ok', Cache::get(config('weather.cache_key'))['status']);
    }

    public function test_only_admins_can_update_the_weather(): void
    {
        Sanctum::actingAs(User::factory()->create(['role' => 'faculty']));

        $this->postJson('/api/weather/refresh')->assertForbidden();
        Http::assertNothingSent();
    }

    public function test_an_update_already_running_is_not_started_twice(): void
    {
        Sanctum::actingAs(User::factory()->create(['role' => 'admin']));
        $lock = Cache::lock('weather:manual-refresh', 30);
        $lock->get();

        $this->postJson('/api/weather/refresh')->assertConflict();
        Http::assertNothingSent();

        $lock->release();
    }

    public function test_a_failed_update_keeps_the_last_good_state(): void
    {
        Http::fake(['*' => Http::response([], 500)]);
        Sanctum::actingAs(User::factory()->create(['role' => 'admin']));

        $this->postJson('/api/weather/refresh')->assertStatus(502);
        $this->assertSame(0, WeatherPrediction::count());
    }

    public function test_manual_updates_are_rate_limited(): void
    {
        $this->fakeProviders();
        Sanctum::actingAs(User::factory()->create(['role' => 'admin']));

        foreach (range(1, 3) as $attempt) {
            $this->postJson('/api/weather/refresh')->assertOk();
        }
        $this->postJson('/api/weather/refresh')->assertTooManyRequests();
    }

    public function test_history_command_prints_json(): void
    {
        WeatherPrediction::factory()->create();

        $this->artisan('weather:history', ['--days' => 7])->assertSuccessful();
        $this->artisan('weather:history', ['--days' => 3])->assertFailed();
    }
}
