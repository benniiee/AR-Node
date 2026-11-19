<?php

namespace Tests\Feature;

use App\Models\WeatherEnsemble;
use App\Services\WeatherService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Sleep;
use Tests\TestCase;

class WeatherEnsembleTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();

        Cache::flush();
        Http::preventStrayRequests();
        Sleep::fake();
    }

    /**
     * Two hours of one ensemble: control run + two members.
     *
     * @return array<string, mixed>
     */
    private function ensemblePayload(): array
    {
        return ['hourly' => [
            'time' => ['2026-11-18T14:00', '2026-11-18T15:00'],
            'precipitation_ecmwf_ifs025_ensemble' => [0.0, 2.0],
            'precipitation_member01_ecmwf_ifs025_ensemble' => [0.2, 0.0],
            'precipitation_member02_ecmwf_ifs025_ensemble' => [null, 1.0],
            // Not an ensemble member, even though it starts with "precipitation_".
            'precipitation_probability' => [80, 90],
        ]];
    }

    private function fakeProviders(int $ensembleStatus = 200): void
    {
        Http::fake([
            'ensemble-api.open-meteo.com/*' => Http::response($this->ensemblePayload(), $ensembleStatus),
            'api.open-meteo.com/*' => Http::response([
                'current' => ['temperature_2m' => 29.0, 'precipitation' => 0.0, 'weather_code' => 3],
                'hourly' => ['precipitation_probability' => [10, 10, 10], 'weather_code' => [3, 3, 3]],
            ]),
        ]);
    }

    public function test_summary_counts_wet_and_heavy_members_per_hour(): void
    {
        $summary = WeatherService::ensembleSummary($this->ensemblePayload());

        $this->assertSame(['ecmwf_ifs025'], array_keys($summary));
        $this->assertSame(3, $summary['ecmwf_ifs025']['members']);
        // 14:00: member 2 has no value, so 1 of 2 values is wet (0.2 mm).
        $this->assertSame(['at' => '2026-11-18T14:00', 'wet_share' => 0.5, 'heavy_share' => 0.0, 'mean_mm' => 0.1, 'max_mm' => 0.2],
            $summary['ecmwf_ifs025']['hours'][0]);
        $this->assertSame(['at' => '2026-11-18T15:00', 'wet_share' => 0.667, 'heavy_share' => 0.667, 'mean_mm' => 1.0, 'max_mm' => 2.0],
            $summary['ecmwf_ifs025']['hours'][1]);
    }

    public function test_summary_is_null_without_members(): void
    {
        $this->assertNull(WeatherService::ensembleSummary([]));
        $this->assertNull(WeatherService::ensembleSummary(['hourly' => ['time' => ['2026-11-18T14:00'], 'precipitation_probability' => [80]]]));
    }

    public function test_each_refresh_records_the_ensemble(): void
    {
        $this->fakeProviders();

        app(WeatherService::class)->refresh();

        $this->assertSame(1, WeatherEnsemble::count());
        $this->assertSame(3, WeatherEnsemble::first()->models['ecmwf_ifs025']['members']);
        Http::assertSent(fn ($request) => str_contains($request->url(), 'ensemble-api.open-meteo.com')
            && $request['models'] === config('weather.ensemble_models') && $request['hourly'] === 'precipitation');
    }

    public function test_a_failed_ensemble_request_never_breaks_the_refresh(): void
    {
        $this->fakeProviders(500);

        $state = app(WeatherService::class)->refresh();

        $this->assertSame('ok', $state['status']);
        $this->assertSame(0, WeatherEnsemble::count());
    }

    public function test_recording_can_be_switched_off(): void
    {
        config(['weather.record_ensemble' => false]);
        $this->fakeProviders();

        app(WeatherService::class)->refresh();

        $this->assertSame(0, WeatherEnsemble::count());
    }

    public function test_export_writes_one_csv_row_per_refresh_model_and_hour(): void
    {
        WeatherEnsemble::factory()->count(2)->create();
        $path = storage_path('framework/testing/ensemble_live.csv');
        @mkdir(dirname($path), 0775, true);

        $this->artisan('weather:ensemble-export', ['--path' => $path])->assertSuccessful();

        $lines = array_map('str_getcsv', file($path, FILE_IGNORE_NEW_LINES));
        $this->assertSame(['fetched_at', 'model', 'members', 'at', 'wet_share', 'heavy_share', 'mean_mm', 'max_mm'], $lines[0]);
        // 2 refreshes x 2 models x 2 hours.
        $this->assertCount(1 + 8, $lines);
        unlink($path);
    }
}
