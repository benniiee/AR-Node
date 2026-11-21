<?php

namespace Tests\Feature;

use App\Services\HeatIndex;
use App\Services\Metar;
use App\Services\RainModel;
use App\Services\WeatherService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Process;
use Illuminate\Support\Sleep;
use Tests\TestCase;

class WeatherTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();

        Cache::flush();
        // Any stray request means a test forgot to fake the provider.
        Http::preventStrayRequests();
        // Provider requests retry with short pauses: no real waiting in tests.
        Sleep::fake();
    }

    /**
     * Fake one Open-Meteo forecast payload.
     *
     * @param  array<int>  $probabilities  hourly precipitation_probability entries
     * @param  array<int>  $codes  hourly weather_code entries
     */
    private function fakeForecast(array $probabilities, array $codes, float $precipitationMm = 0.0, int $currentCode = 3): void
    {
        Http::fake([
            'api.open-meteo.com/*' => Http::response([
                'current' => [
                    'temperature_2m' => 29.4,
                    'precipitation' => $precipitationMm,
                    'weather_code' => $currentCode,
                ],
                'hourly' => [
                    'precipitation_probability' => $probabilities,
                    'weather_code' => $codes,
                ],
            ]),
        ]);
    }

    public function test_probability_of_70_turns_rain_mode_on(): void
    {
        $this->fakeForecast([70, 70, 70], [3, 3, 3]);

        $state = app(WeatherService::class)->refresh();

        $this->assertIsArray($state);
        $this->assertSame('ok', $state['status']);
        $this->assertSame(70, $state['rain_probability']);
        $this->assertSame('forecast', $state['probability_source']);
        $this->assertFalse($state['raining_now']);
        $this->assertTrue($state['rain_mode']);
        $this->assertSame(2.0, $state['rain_multiplier']);
        $this->assertSame(WeatherService::ATTRIBUTION, $state['attribution']);
    }

    public function test_rain_mode_hysteresis(): void
    {
        // One mutable payload: each refresh reads a different probability so
        // the on/off thresholds can be walked through in order.
        $probability = 65;
        Http::fake(function () use (&$probability) {
            return Http::response([
                'current' => ['temperature_2m' => 29.0, 'precipitation' => 0.0, 'weather_code' => 3],
                'hourly' => [
                    'precipitation_probability' => [$probability, $probability, $probability],
                    'weather_code' => [3, 3, 3],
                ],
            ]);
        });

        $weather = app(WeatherService::class);

        // 65 >= rain_on (60) -> ON.
        $this->assertTrue($weather->refresh()['rain_mode']);
        // 50 is inside the gap (40-60) -> stays ON.
        $probability = 50;
        $this->assertTrue($weather->refresh()['rain_mode']);
        // 35 <= rain_off (40) -> OFF.
        $probability = 35;
        $this->assertFalse($weather->refresh()['rain_mode']);
        // Back to 50, but the previous state is OFF -> stays OFF.
        $probability = 50;
        $this->assertFalse($weather->refresh()['rain_mode']);
    }

    public function test_raining_now_forces_rain_mode_even_at_low_probability(): void
    {
        // 0.4 mm falling and a rain code (61) override a dry 10 % forecast.
        $this->fakeForecast([10, 10, 10], [61, 61, 61], precipitationMm: 0.4, currentCode: 61);

        $state = app(WeatherService::class)->refresh();

        $this->assertTrue($state['raining_now']);
        $this->assertTrue($state['rain_mode']);
        $this->assertSame(2.0, $state['rain_multiplier']);
        $this->assertSame(10, $state['rain_probability']);
        $this->assertSame('rain', $state['condition']);
    }

    public function test_provider_failure_keeps_the_last_good_state(): void
    {
        // One mutable fake: the provider answers well first, then falls over.
        // (Calling Http::fake() twice would append a second stub, and the
        // first match always wins, so the 500 would never be served.)
        $failing = false;
        Http::fake(function () use (&$failing) {
            return $failing
                ? Http::response(['error' => true], 500)
                : Http::response([
                    'current' => ['temperature_2m' => 29.4, 'precipitation' => 0.0, 'weather_code' => 3],
                    'hourly' => ['precipitation_probability' => [70, 70, 70], 'weather_code' => [3, 3, 3]],
                ]);
        });

        $weather = app(WeatherService::class);
        $this->assertTrue($weather->refresh()['rain_mode']);

        $failing = true;
        // A failed refresh must not throw and must not erase the good state.
        $this->assertNull($weather->refresh());

        // current() still serves the good state, unpenalised only by its age.
        $state = $weather->current();
        $this->assertSame('ok', $state['status']);
        $this->assertTrue($state['rain_mode']);
        $this->assertSame(70, $state['rain_probability']);
    }

    public function test_no_data_at_all_leaves_routing_unpenalised(): void
    {
        Http::fake(['api.open-meteo.com/*' => Http::failedConnection()]);

        $state = app(WeatherService::class)->current();

        $this->assertSame('unavailable', $state['status']);
        $this->assertFalse($state['rain_mode']);
        $this->assertFalse($state['raining_now']);
        $this->assertSame(1.0, $state['rain_multiplier']);
        $this->assertNull($state['rain_probability']);

        // Further requests in the same minute do not hammer the providers again.
        $sent = Http::recorded()->count();
        app(WeatherService::class)->current();
        app(WeatherService::class)->current();
        $this->assertSame($sent, Http::recorded()->count());
    }

    public function test_weather_endpoint_returns_the_state_shape(): void
    {
        $this->fakeForecast([70, 70, 70], [3, 3, 3]);

        $response = $this->getJson('/api/weather');

        $response->assertOk();
        // Symfony normalises the directives into this order.
        $response->assertHeader('Cache-Control', 'max-age=60, public');
        $response->assertJsonStructure([
            'status', 'rain_probability', 'probability_source', 'raining_now',
            'rain_mode', 'rain_multiplier', 'condition', 'weather_code',
            'temperature_c', 'fetched_at', 'age_minutes', 'attribution',
        ]);
        $response->assertJsonPath('rain_mode', true);
        $response->assertJsonPath('status', 'ok');
        // Compared loosely: JSON has no float/int distinction on the wire.
        $this->assertEquals(2.0, $response->json('rain_multiplier'));
    }

    public function test_there_is_no_demo_override_the_live_forecast_always_wins(): void
    {
        // The old WEATHER_FORCE demo switch is gone: even if a stale config
        // value is left behind, the served state comes from the forecast.
        config(['weather.force' => 'rain']);
        $this->fakeForecast([0, 0, 0], [0, 0, 0]);

        $this->getJson('/api/weather')
            ->assertOk()
            ->assertJsonPath('status', 'ok')
            ->assertJsonPath('rain_mode', false);
    }

    public function test_stale_state_is_served_unpenalised(): void
    {
        $this->fakeForecast([70, 70, 70], [3, 3, 3]);
        app(WeatherService::class)->refresh();

        // Pretend the last refresh was two hours ago.
        $key = config('weather.cache_key');
        $state = Cache::get($key);
        $state['fetched_at'] = now()->subHours(2)->toIso8601String();
        Cache::forever($key, $state);

        $served = app(WeatherService::class)->current();

        $this->assertSame('stale', $served['status']);
        $this->assertFalse($served['rain_mode']);
        $this->assertSame(1.0, $served['rain_multiplier']);
        $this->assertSame(70, $served['rain_probability']);
    }

    public function test_state_carries_the_heat_index_and_a_three_hour_outlook(): void
    {
        $this->travelTo(new \DateTimeImmutable('2026-04-10T13:40:00+08:00'));
        $time = array_map(fn (int $h): string => sprintf('2026-04-10T%02d:00', $h), range(13, 16));

        Http::fake(function (Request $request) use ($time) {
            // The heat model's own request asks for the past hours; answer it with a 500 so
            // the outlook must fall back to the routing payload's forecast heat index.
            if (str_contains($request->url(), 'past_hours=')) {
                return Http::response([], 500);
            }

            return Http::response([
                'current' => ['temperature_2m' => 32.0, 'relative_humidity_2m' => 70, 'apparent_temperature' => 38.1, 'precipitation' => 0.0, 'weather_code' => 1],
                'hourly' => [
                    'time' => $time,
                    'precipitation_probability' => [0, 0, 0, 0],
                    'weather_code' => [1, 1, 1, 1],
                    'temperature_2m' => [32.0, 33.0, 34.0, 33.0],
                    'relative_humidity_2m' => [70, 65, 60, 65],
                ],
            ]);
        });

        $state = app(WeatherService::class)->refresh();

        $this->assertSame(70, $state['humidity']);
        $this->assertSame(38.1, $state['apparent_temperature_c']);
        $this->assertSame(round(HeatIndex::celsius(32.0, 70.0), 1), $state['heat_index_c']);
        $this->assertSame('extreme_caution', $state['heat_category']);
        $this->assertSame('forecast', $state['heat_forecast_source']);
        $this->assertSame([1, 2, 3], array_column($state['heat_forecast'], 'hours_ahead'));
        $this->assertSame(round(HeatIndex::celsius(34.0, 60.0), 1), $state['heat_forecast'][1]['heat_index_c']);
        // 32 C at 70% feels like about 41 C: above the 40 C limit, so heat mode is on.
        $this->assertGreaterThan(40.0, $state['heat_index_c']);
        $this->assertTrue($state['heat_mode']);
        $this->assertSame(40.0, $state['heat_mode_c']);

        // The public file phones read carries the same keys.
        $this->getJson('/api/weather')->assertOk()->assertJsonPath('heat_category', 'extreme_caution');
    }

    public function test_unavailable_state_has_empty_heat_keys(): void
    {
        Http::fake(['api.open-meteo.com/*' => Http::failedConnection()]);

        $state = app(WeatherService::class)->current();

        $this->assertSame('unavailable', $state['status']);
        $this->assertNull($state['heat_index_c']);
        $this->assertNull($state['heat_category']);
        $this->assertSame([], $state['heat_forecast']);
        $this->assertFalse($state['heat_mode']);
    }

    public function test_heat_mode_turns_on_only_when_it_is_above_the_limit_now(): void
    {
        $this->assertFalse(WeatherService::resolveHeatMode(40.0, 40.0));   // exactly 40 is not above
        $this->assertTrue(WeatherService::resolveHeatMode(40.1, 40.0));    // hot now
        $this->assertFalse(WeatherService::resolveHeatMode(37.6, 40.0));   // 40.4 predicted for the next hour: not yet
        $this->assertFalse(WeatherService::resolveHeatMode(null, 40.0));   // no data never closes paths
    }

    public function test_a_hot_prediction_does_not_close_paths_ahead_of_time(): void
    {
        config(['weather.use_heat_model' => false, 'weather.use_model' => false]);
        $this->travelTo(new \DateTimeImmutable('2026-11-14T12:20:00+08:00'));
        // 31 C at 60% now (about 37 C), 33 C at 70% at 1 pm (about 46 C).
        Http::fake(['*' => Http::response([
            'current' => ['temperature_2m' => 31.0, 'relative_humidity_2m' => 60, 'precipitation' => 0, 'weather_code' => 1],
            'hourly' => ['precipitation_probability' => [5, 5, 5, 5], 'weather_code' => [1, 1, 1, 1],
                'temperature_2m' => [31.0, 33.0, 33.0, 32.0], 'relative_humidity_2m' => [60, 70, 70, 65],
                'time' => array_map(fn (int $h): string => sprintf('2026-11-14T%02d:00', $h), range(12, 15))],
        ])]);

        $state = app(WeatherService::class)->refresh();

        $this->assertLessThan(40.0, $state['heat_index_c']);
        $this->assertGreaterThan(40.0, $state['heat_forecast'][0]['heat_index_c']);
        $this->assertFalse($state['heat_mode']);
    }

    public function test_stale_state_never_keeps_heat_mode_on(): void
    {
        $this->fakeForecast([0, 0, 0], [1, 1, 1]);
        app(WeatherService::class)->refresh();

        $key = config('weather.cache_key');
        $state = Cache::get($key);
        $state['heat_mode'] = true;
        $state['fetched_at'] = now()->subHours(2)->toIso8601String();
        Cache::forever($key, $state);

        $this->assertFalse(app(WeatherService::class)->current()['heat_mode']);
    }

    /**
     * Replays a ml/model_parity.json case through the real WeatherService: the rain-model
     * forecast, the several-models forecast and the airport reports each come from their own
     * request, and the cached state carries the probability Python computed.
     */
    public function test_rain_model_combines_forecast_several_models_and_airport_report(): void
    {
        $model = RainModel::load();
        $parityPath = base_path('ml/model_parity.json');
        if ($model === null || ! is_file($parityPath) || ! $model->needsObservations() || ! $model->needsMultiModel()) {
            $this->markTestSkipped('Needs a recommended ml/model.json that uses airport reports and several models.');
        }

        $cases = json_decode((string) file_get_contents($parityPath), true, 512, JSON_THROW_ON_ERROR)['cases'];
        $case = collect($cases)->firstWhere('expected_features.obs_rain', 1.0) ?? $cases[0];
        $tz = new \DateTimeZone('Asia/Manila');
        $this->travelTo(new \DateTimeImmutable($case['now'], $tz));
        $metars = array_map(fn (array $report): array => [
            'obsTime' => (new \DateTimeImmutable($report['time'], $tz))->getTimestamp(),
            'rawOb' => $report['raw'],
        ], $case['metars']);

        Http::fake(function (Request $request) use ($case, $metars) {
            return match (true) {
                str_contains($request->url(), 'aviationweather.gov') => Http::response($metars),
                str_contains($request->url(), 'models=') => Http::response(['hourly' => $case['multi_model']]),
                str_contains($request->url(), 'minutely_15=') => Http::response(['minutely_15' => $case['minutely_15'], 'hourly' => $case['hourly']]),
                default => Http::response(['current' => ['precipitation' => 0.0, 'weather_code' => 3], 'hourly' => ['precipitation_probability' => [5, 5]]]),
            };
        });

        // A satellite model gets the case's satellite values, as `python ml/satellite.py now` would give them.
        if (isset($case['satellite_features'])) {
            Process::fake(['*satellite.py*' => Process::result(output: json_encode(['ok' => true, 'features' => $case['satellite_features']]))]);
        }

        $state = app(WeatherService::class)->refresh();

        $this->assertSame('model', $state['probability_source']);
        $this->assertSame((int) round($case['expected_probability'] * 100), $state['rain_probability']);
        Http::assertSent(fn (Request $request): bool => str_contains($request->url(), 'aviationweather.gov')
            && $request['ids'] === $model->observationStation());
    }

    public function test_a_failed_airport_report_still_gives_a_model_probability(): void
    {
        $model = RainModel::load();
        $parityPath = base_path('ml/model_parity.json');
        if ($model === null || ! is_file($parityPath) || ! $model->needsObservations()) {
            $this->markTestSkipped('Needs a recommended ml/model.json that uses airport reports.');
        }

        $case = json_decode((string) file_get_contents($parityPath), true, 512, JSON_THROW_ON_ERROR)['cases'][0];
        $this->travelTo(new \DateTimeImmutable($case['now'], new \DateTimeZone('Asia/Manila')));

        Http::fake(function (Request $request) use ($case) {
            return match (true) {
                str_contains($request->url(), 'aviationweather.gov') => Http::response('Service unavailable', 503),
                str_contains($request->url(), 'models=') => Http::response(['hourly' => $case['multi_model'] ?? []]),
                str_contains($request->url(), 'minutely_15=') => Http::response(['minutely_15' => $case['minutely_15'], 'hourly' => $case['hourly']]),
                default => Http::response(['current' => ['precipitation' => 0.0, 'weather_code' => 3], 'hourly' => ['precipitation_probability' => [5, 5]]]),
            };
        });

        $state = app(WeatherService::class)->refresh();

        // Scored as "no recent airport report" instead of falling back to the provider's 5%.
        $this->assertSame('model', $state['probability_source']);
    }

    /**
     * Fake the forecast (with the given current weather) and the airport's latest report.
     */
    private function fakeForecastAndAirport(int $currentCode, float $precipitationMm, string $metarRaw, int $reportMinutesAgo, int $probability = 5): void
    {
        Http::fake([
            'aviationweather.gov/*' => Http::response([
                ['obsTime' => now()->subMinutes($reportMinutesAgo)->getTimestamp(), 'rawOb' => $metarRaw],
            ]),
            'api.open-meteo.com/*' => Http::response([
                'current' => ['temperature_2m' => 28.5, 'precipitation' => $precipitationMm, 'weather_code' => $currentCode],
                'hourly' => ['precipitation_probability' => [$probability, $probability, $probability], 'weather_code' => [3, 3, 3]],
            ]),
        ]);
    }

    public function test_a_fresh_dry_airport_report_overrides_a_drizzle_code(): void
    {
        // The forecast model says dense drizzle; the airport 20 minutes ago saw none.
        $this->fakeForecastAndAirport(55, 0.3, 'METAR RPMZ 121100Z 26004KT 9999 FEW017 28/24 Q1011 RMK A2985', 20);

        $state = app(WeatherService::class)->refresh();

        $this->assertFalse($state['raining_now']);
        $this->assertSame('airport', $state['raining_now_source']);
        $this->assertSame('cloudy', $state['condition']);
        $this->assertFalse($state['rain_mode']);
        $this->assertSame(1.0, $state['rain_multiplier']);
    }

    public function test_a_fresh_airport_rain_report_means_raining_now(): void
    {
        $this->fakeForecastAndAirport(3, 0.0, 'METAR RPMZ 121100Z 26004KT 6000 -RA BKN015 26/24 Q1011', 15);

        $state = app(WeatherService::class)->refresh();

        $this->assertTrue($state['raining_now']);
        $this->assertSame('airport', $state['raining_now_source']);
        $this->assertTrue($state['rain_mode']);
    }

    public function test_an_old_airport_report_leaves_the_forecast_in_charge(): void
    {
        $this->fakeForecastAndAirport(55, 0.3, 'METAR RPMZ 120800Z 26004KT 9999 FEW017 28/24 Q1011', 180);

        $state = app(WeatherService::class)->refresh();

        $this->assertTrue($state['raining_now']);
        $this->assertSame('forecast', $state['raining_now_source']);
        $this->assertArrayNotHasKey('airport_report_at', $state);
        $this->assertSame('forecast', $state['heat_now_source']);
        $this->assertSame(28.5, $state['temperature_c']);
    }

    public function test_a_fresh_airport_report_gives_the_heat_index_now(): void
    {
        // The forecast says 28.5 C; the airport measured 35 C with a 27 C dew point 20 minutes ago.
        $raw = 'METAR RPMZ 120700Z 22008KT 9999 FEW020 35/27 Q1008';
        $this->fakeForecastAndAirport(3, 0.0, $raw, 20);

        $state = app(WeatherService::class)->refresh();

        $this->assertSame('airport', $state['heat_now_source']);
        $this->assertSame(35.0, $state['temperature_c']);
        $this->assertSame(Metar::heatIndex($raw), $state['heat_index_c']);
        $this->assertSame((int) round(Metar::relativeHumidity($raw)), $state['humidity']);
        $this->assertSame('danger', $state['heat_category']);
        // Heat mode follows the measured heat index (46.7 C, above the 40 C limit).
        $this->assertTrue($state['heat_mode']);
    }

    public function test_airport_verdict_needs_a_fresh_report(): void
    {
        $now = new \DateTimeImmutable('2026-11-12T19:30:00+08:00');
        $report = fn (string $time, string $raw): array => ['time' => $time, 'raw' => $raw];

        $this->assertNull(WeatherService::airportRainingNow([], $now, 75));
        $this->assertNull(WeatherService::airportRainingNow([$report('2026-11-12T17:00', 'METAR RPMZ 9999 -RA')], $now, 75));
        $this->assertFalse(WeatherService::airportRainingNow([$report('2026-11-12T19:00', 'METAR RPMZ 9999 FEW017')], $now, 75)['raining']);
        // The newest report wins, whatever the list order.
        $this->assertTrue(WeatherService::airportRainingNow([
            $report('2026-11-12T19:00', 'METAR RPMZ 4000 SHRA'),
            $report('2026-11-12T18:00', 'METAR RPMZ 9999 FEW017'),
        ], $now, 75)['raining']);
        // In the vicinity is not at the station.
        $this->assertFalse(WeatherService::airportRainingNow([$report('2026-11-12T19:00', 'METAR RPMZ 9999 VCSH FEW017CB')], $now, 75)['raining']);
    }

    /**
     * A tiny satellite model (rain now + storm-cloud share) with a fallback that has no satellite input,
     * and a forecast whose last completed 15-minute step (10:00) is dry with an 80 degree wind.
     */
    private function useSatelliteModel(string $satelliteInput = 'sat_cold_30km'): void
    {
        $path = tempnam(sys_get_temp_dir(), 'rain_model_');
        file_put_contents($path, json_encode([
            'recommended' => true, 'horizon_minutes' => 20, 'alert_threshold' => 0.2,
            'features' => ['precip_0', $satelliteInput], 'mean' => [0, 0], 'scale' => [1, 1], 'coef' => [1, 4], 'intercept' => -3,
            'fallback' => ['features' => ['precip_0'], 'mean' => [0], 'scale' => [1], 'coef' => [1], 'intercept' => -3, 'alert_threshold' => 0.3],
        ]));
        config(['weather.model_path' => $path]);
        $this->travelTo(new \DateTimeImmutable('2026-11-13 10:07', new \DateTimeZone('Asia/Manila')));

        Http::fake(function (Request $request) {
            return str_contains($request->url(), 'minutely_15=')
                ? Http::response([
                    'minutely_15' => ['time' => ['2026-11-13T09:45', '2026-11-13T10:00'], 'precipitation' => [0.0, 0.0], 'wind_direction_10m' => [75, 80]],
                    'hourly' => ['time' => ['2026-11-13T10:00']],
                ])
                : Http::response(['current' => ['precipitation' => 0.0, 'weather_code' => 3], 'hourly' => ['precipitation_probability' => [5, 5]]]);
        });
    }

    public function test_the_rain_model_reads_the_satellite_through_python(): void
    {
        $this->useSatelliteModel();
        Process::fake(['*satellite.py*' => Process::result(output: json_encode(['ok' => true, 'features' => ['sat_cold_30km' => 0.5]]))]);

        $state = app(WeatherService::class)->refresh();

        // -3 + 4 x 0.5 = -1 -> 27%
        $this->assertSame('model', $state['probability_source']);
        $this->assertSame(27, $state['rain_probability']);
        $this->assertTrue($state['model_satellite']);
        $this->assertStringContainsString(WeatherService::SATELLITE_ATTRIBUTION, $state['attribution']);
        Process::assertRan(fn ($process): bool => $process->command === ['python', 'satellite.py', 'now', '--at', '2026-11-13T10:00', '--wind-dir', '80']
            && str_ends_with(str_replace('\\', '/', (string) $process->path), '/ml'));
    }

    public function test_a_cloud_motion_model_asks_python_for_the_motion_inputs(): void
    {
        $this->useSatelliteModel('sat_adv_cold_20min');
        Process::fake(['*satellite.py*' => Process::result(output: json_encode(['ok' => true, 'features' => ['sat_adv_cold_20min' => 0.5]]))]);

        $state = app(WeatherService::class)->refresh();

        $this->assertSame(27, $state['rain_probability']);
        Process::assertRan(fn ($process): bool => $process->command === ['python', 'satellite.py', 'now', '--at', '2026-11-13T10:00', '--wind-dir', '80', '--motion']);
    }

    public function test_a_cloud_phase_model_asks_python_for_the_phase_inputs(): void
    {
        $this->useSatelliteModel('sat_phase_water_10km');
        Process::fake(['*satellite.py*' => Process::result(output: json_encode(['ok' => true, 'features' => ['sat_phase_water_10km' => 0.5]]))]);

        $state = app(WeatherService::class)->refresh();

        $this->assertSame(27, $state['rain_probability']);
        Process::assertRan(fn ($process): bool => $process->command === ['python', 'satellite.py', 'now', '--at', '2026-11-13T10:00', '--wind-dir', '80', '--cloud']);
    }

    public function test_python_gets_the_whole_environment_so_it_can_look_up_addresses_from_a_web_request(): void
    {
        $this->useSatelliteModel('sat_phase_water_10km');
        Process::fake(['*satellite.py*' => Process::result(output: json_encode(['ok' => true, 'features' => ['sat_phase_water_10km' => 0.5]]))]);

        app(WeatherService::class)->refresh();

        // Windows needs SystemRoot (and the rest) for any network call; Symfony's default drops it under a web server.
        Process::assertRan(fn ($process): bool => $process->environment === getenv());
    }

    public function test_the_uv_index_and_its_category_are_published(): void
    {
        config(['weather.use_model' => false]);
        Http::fake(['*' => Http::response(['current' => ['temperature_2m' => 29, 'precipitation' => 0, 'weather_code' => 1, 'uv_index' => 8.3],
            'hourly' => ['precipitation_probability' => [5, 5, 5], 'weather_code' => [1, 1, 1]]])]);

        $state = app(WeatherService::class)->refresh();

        $this->assertSame(8.3, $state['uv_index']);
        $this->assertSame('very_high', $state['uv_category']);
        $this->assertSame(['low', 'moderate', 'high', 'very_high', 'extreme'], array_map(
            WeatherService::uvCategory(...), [0.0, 3.0, 6.0, 8.0, 11.0],
        ));
        Http::assertSent(fn (Request $request): bool => str_contains(urldecode($request->url()), 'weather_code,uv_index'));
    }

    public function test_the_hour_model_is_scored_on_the_same_inputs(): void
    {
        $this->useSatelliteModel();
        $path = tempnam(sys_get_temp_dir(), 'rain_model_h60_');
        file_put_contents($path, json_encode([
            'recommended' => true, 'horizon_minutes' => 60, 'alert_threshold' => 0.3,
            'features' => ['precip_0', 'sat_cold_30km'], 'mean' => [0, 0], 'scale' => [1, 1], 'coef' => [1, 4], 'intercept' => -2,
        ]));
        config(['weather.hour_model_path' => $path]);
        Process::fake(['*satellite.py*' => Process::result(output: json_encode(['ok' => true, 'features' => ['sat_cold_30km' => 0.5]]))]);

        $state = app(WeatherService::class)->refresh();

        // 20-minute: -3 + 2 -> 27%. Hour: -2 + 2 = 0 -> 50%, with its own alert level. One satellite read for both.
        $this->assertSame(27, $state['rain_probability']);
        $this->assertSame(50, $state['rain_probability_hour']);
        $this->assertSame(30, $state['rain_hour_alert']);
        Process::assertRanTimes(fn ($process): bool => str_contains(implode(' ', (array) $process->command), 'satellite.py'), 1);
    }

    public function test_without_an_hour_model_no_hour_chance_is_published(): void
    {
        $this->useSatelliteModel();

        $state = app(WeatherService::class)->refresh();

        $this->assertArrayNotHasKey('rain_probability_hour', $state);
    }

    public function test_no_satellite_scan_scores_the_fallback_model(): void
    {
        $this->useSatelliteModel();
        Process::fake(['*satellite.py*' => Process::result(output: json_encode(['ok' => false, 'error' => 'no satellite scan online']))]);

        $state = app(WeatherService::class)->refresh();

        // Fallback: -3 -> 5%, still the model (not the provider's 5%), with the fallback's own threshold.
        $this->assertSame('model', $state['probability_source']);
        $this->assertSame(5, $state['rain_probability']);
        $this->assertFalse($state['model_satellite']);
        $this->assertFalse($state['rain_mode']);
        $this->assertStringNotContainsString('Himawari', $state['attribution']);
    }

    public function test_a_failed_python_run_also_scores_the_fallback_model(): void
    {
        $this->useSatelliteModel();
        Process::fake(['*satellite.py*' => Process::result(output: '', errorOutput: 'python: command not found', exitCode: 127)]);

        $state = app(WeatherService::class)->refresh();

        $this->assertSame('model', $state['probability_source']);
        $this->assertSame(5, $state['rain_probability']);
        $this->assertFalse($state['model_satellite']);
    }

    public function test_a_refresh_that_cannot_score_keeps_the_last_model_answer(): void
    {
        if (RainModel::load() === null) {
            $this->markTestSkipped('Needs a recommended ml/model.json.');
        }
        $key = config('weather.cache_key');
        $previous = fn (int $minutesAgo): array => [
            'status' => 'ok', 'probability_source' => 'model', 'rain_probability' => 4, 'rain_mode' => false,
            'model_scored_at' => now()->subMinutes($minutesAgo)->toIso8601String(),
            'fetched_at' => now()->subMinutes($minutesAgo)->toIso8601String(),
        ];
        // The provider says 70%, but the model's inputs are missing from this refresh.
        $this->fakeForecast([70, 70, 70], [3, 3, 3]);

        Cache::forever($key, $previous(15));
        $state = app(WeatherService::class)->refresh();
        $this->assertSame('model', $state['probability_source']);
        $this->assertSame(4, $state['rain_probability']);
        $this->assertFalse($state['rain_mode']);
        // Carried, not rescored: the time it really scored is kept, so it cannot live forever.
        $this->assertSame($previous(15)['model_scored_at'], $state['model_scored_at']);

        Cache::forever($key, $previous(90));
        $state = app(WeatherService::class)->refresh();
        $this->assertSame('forecast', $state['probability_source']);
        $this->assertSame(70, $state['rain_probability']);
        $this->assertTrue($state['rain_mode']);
    }
}
