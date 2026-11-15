<?php

namespace App\Services;

use App\Models\RainReport;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Http\Client\RequestException;
use Illuminate\Http\Client\Response;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Process;
use Throwable;

/**
 * Campus-wide weather state for weather-aware routing.
 *
 * Design decisions (see AR-Node-Weather-Spec.md, section A2):
 *  - ONE campus-wide state, never per-node flags. Forecast grid cells are
 *    larger than the campus, so every node would get the same value.
 *  - Exposure comes from the existing `path_type`: 'outside' is exposed,
 *    everything else is sheltered. No new node column.
 *  - The SERVER calls the provider and phones only ever call our own
 *    /api/weather, so all phones share a single upstream request.
 *  - Rain is a PROBABILITY, not a yes/no — tropical rain timing is hard for
 *    any model, so the UI and the routing both deal in likelihood.
 */
class WeatherService
{
    /**
     * Open-Meteo weather codes that mean rain. Ranges 51-67 (drizzle/rain),
     * 80-82 (rain showers) and 95+ (thunderstorm).
     */
    public const RAIN_CODES = [51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99];

    /**
     * Attribution is a licence requirement of the free Open-Meteo tier.
     */
    public const ATTRIBUTION = 'Weather data by Open-Meteo.com';

    public const SATELLITE_ATTRIBUTION = 'Satellite: Himawari-9 (JMA) via NOAA';

    /**
     * What this refresh learned beyond the cached state, for the prediction history:
     * the provider's own rain chance and heat outlook, the model's alert threshold and
     * the airport reports already downloaded (so they are fetched once per refresh).
     *
     * @var array{provider_probability?: int|null, alert_threshold?: float|null, provider_heat?: list<array<string, mixed>>, metars?: list<array{time: string, raw: string}>|null}
     */
    private array $history = [];

    /**
     * The current campus weather state.
     *
     * Never throws and never blocks: on any failure it degrades to a state
     * that leaves routing unpenalised (multiplier 1.0, rain mode off).
     */
    public function current(): array
    {
        $state = Cache::get(config('weather.cache_key'));

        // Cold cache only — the scheduler owns the normal refresh loop. One attempt a minute:
        // with the providers down, every request retrying the slow refresh froze the site.
        if (! is_array($state) && Cache::add('weather:cold-refresh', true, 60)) {
            $state = $this->refresh();
        }

        if (! is_array($state) || ! isset($state['fetched_at'])) {
            return $this->unavailableState();
        }

        $ageMinutes = $this->ageMinutes($state['fetched_at']);

        if ($ageMinutes === null || $ageMinutes > (int) config('weather.max_stale_minutes')) {
            return $this->staleState($state);
        }

        return $state + ['age_minutes' => $ageMinutes];
    }

    /**
     * Fetch a fresh forecast and cache the rebuilt state.
     *
     * Returns null on failure and deliberately leaves the previous good state
     * in the cache: a provider outage must not erase the last known answer.
     */
    public function refresh(): ?array
    {
        try {
            $response = Http::withHeaders(['User-Agent' => (string) config('weather.user_agent')])
                ->connectTimeout(3)
                ->timeout(8)
                // GET is idempotent, so retrying transient failures is safe.
                ->retry([200, 600], 0, function (Throwable $exception): bool {
                    return $exception instanceof ConnectionException
                        || ($exception instanceof RequestException
                            && ($exception->response->serverError() || $exception->response->status() === 429));
                }, throw: false)
                ->get($this->forecastUrl(), $this->forecastQuery());
        } catch (Throwable $exception) {
            Log::warning('Weather refresh failed.', ['error' => $exception->getMessage()]);

            return null;
        }

        if ($response->failed()) {
            Log::warning('Weather provider returned an error.', [
                'status' => $response->status(),
            ]);

            return null;
        }

        $payload = $response->json() ?? [];
        $base = $this->buildState($payload);
        $this->history = ['provider_probability' => $base['rain_probability'], 'alert_threshold' => null, 'provider_heat' => [], 'metars' => null];
        $state = $this->applyHeatOutlook($this->applyRainModel($this->applyRainReports($this->applyAirportReport($base))), $payload);

        // No expiry: staleness is judged by fetched_at, not by the cache TTL.
        Cache::forever(config('weather.cache_key'), $state);

        // Static copy for phones (storage/app/public/data/weather.json): one file read per
        // phone instead of a PHP request, and the file the offline download saves.
        PublicData::write('weather.json', $state);

        $this->recordHistory($state);

        return $state;
    }

    /**
     * Save this refresh to the prediction history and fill in airport outcomes for earlier ones.
     * Never throws: the history is a report, so it must not break the weather itself.
     *
     * @param  array<string, mixed>  $state
     */
    private function recordHistory(array $state): void
    {
        try {
            $metars = $this->history['metars'] ?? $this->fetchAirportReports([
                'ids' => (string) config('weather.metar_station'),
                'format' => 'json',
                'hours' => 6,
            ]);
            $latest = collect($metars)->sortBy('time')->last();

            $history = app(WeatherHistory::class);
            $history->record(
                $state,
                $this->history['provider_probability'] ?? null,
                $this->history['alert_threshold'] ?? null,
                $this->history['provider_heat'] ?? [],
                $latest['raw'] ?? null,
            );
            $history->fillOutcomes($metars);
        } catch (Throwable $exception) {
            Log::warning('Weather history was not recorded.', ['error' => $exception->getMessage()]);
        }
    }

    /**
     * "Raining now" from the airport's latest report when it is fresh, instead of the forecast
     * model's current weather code. The model often says "drizzle" under a dry sky; the airport
     * (RPMZ, a few km from campus) reports what is really falling. Without a fresh report the
     * model's answer stands. Rain mode and the multiplier follow the corrected answer.
     *
     * @param  array<string, mixed>  $state
     * @return array<string, mixed>
     */
    private function applyAirportReport(array $state): array
    {
        $reports = $this->fetchAirportReports([
            'ids' => (string) config('weather.metar_station'),
            'format' => 'json',
            'hours' => 6,
        ]);
        // Fetched once per refresh: the history outcomes reuse them.
        $this->history['metars'] = $reports;

        $verdict = self::airportRainingNow($reports, now(), (int) config('weather.airport_fresh_minutes', 75));
        if ($verdict === null) {
            return $state + ['raining_now_source' => 'forecast'];
        }

        $state['raining_now'] = $verdict['raining'];
        $state['raining_now_source'] = 'airport';
        $state['airport_report_at'] = $verdict['time'];
        // The forecast's "drizzle" or "rain" word is wrong when the airport sees none.
        if (! $verdict['raining'] && in_array($state['condition'] ?? null, ['drizzle', 'rain', 'showers', 'thunderstorm'], true)) {
            $state['condition'] = 'cloudy';
        }
        $state['rain_mode'] = $this->resolveRainMode($state['raining_now'], (int) ($state['rain_probability'] ?? 0));
        $state['rain_multiplier'] = $state['rain_mode'] ? (float) config('weather.rain_penalty') : 1.0;

        return $state;
    }

    /**
     * "Raining now" from students' "It's raining here" taps: at least weather.reports_min_people
     * different people within weather.reports_window_minutes. Campus reports beat the airport (a few
     * km away) and the forecast, but only ever turn rain ON (config/weather.php says why).
     *
     * @param  array<string, mixed>  $state
     * @return array<string, mixed>
     */
    private function applyRainReports(array $state): array
    {
        $state['rain_reports'] = RainReport::peopleSince(now()->subMinutes((int) config('weather.reports_window_minutes', 15)));
        $state['rain_reports_min'] = max(1, (int) config('weather.reports_min_people', 2));
        if (($state['raining_now'] ?? false) || $state['rain_reports'] < $state['rain_reports_min']) {
            return $state;
        }

        return array_merge($state, [
            'raining_now' => true,
            'raining_now_source' => 'reports',
            'rain_mode' => true,
            'rain_multiplier' => (float) config('weather.rain_penalty'),
        ]);
    }

    /**
     * Re-check the cached state right after a new rain report, without calling any provider, so
     * every phone's next poll (at most 5 minutes) sees "raining now". The next scheduled refresh
     * applies the same rule again, and drops it once the reports are older than the window.
     *
     * @return array<string, mixed>
     */
    public function applyNewRainReport(): array
    {
        $state = Cache::get(config('weather.cache_key'));
        if (is_array($state) && isset($state['fetched_at'])) {
            $updated = $this->applyRainReports($state);
            if ($updated !== $state) {
                Cache::forever(config('weather.cache_key'), $updated);
                PublicData::write('weather.json', $updated);
            }
        }

        return $this->current();
    }

    /**
     * Whether the newest airport report says rain is falling, or null when there is no report
     * at most $freshMinutes old. Pure, so it is unit-testable.
     *
     * @param  list<array{time: string, raw: string}>  $reports  time = 'Y-m-d\TH:i' in Asia/Manila
     * @return array{raining: bool, time: string}|null
     */
    public static function airportRainingNow(array $reports, \DateTimeInterface $now, int $freshMinutes): ?array
    {
        $latest = collect($reports)->sortBy('time')->last();
        if (! is_array($latest) || ! is_string($latest['time'] ?? null)) {
            return null;
        }

        try {
            $at = new \DateTimeImmutable($latest['time'], new \DateTimeZone('Asia/Manila'));
        } catch (Throwable) {
            return null;
        }

        $ageMinutes = ($now->getTimestamp() - $at->getTimestamp()) / 60;
        if ($ageMinutes < -5 || $ageMinutes > $freshMinutes) {
            return null;
        }

        return ['raining' => Metar::flags($latest['raw'] ?? '')['rain'] === 1.0, 'time' => $at->format(DATE_ATOM)];
    }

    /**
     * Rain penalty that grows with the model's probability instead of switching on at one line.
     *
     * 0 at or below $from percent, the full $penalty at or above $to percent, a straight line between.
     * The trained model rarely says more than 40-50%, so a single high threshold would leave its
     * information unused; a ramp lets a 25% chance nudge routes toward cover and a 50% chance
     * push hard. Pure, so it is unit-testable without Laravel.
     */
    public static function gradedMultiplier(float $probabilityPercent, float $penalty, int $from, int $to): float
    {
        if ($penalty <= 1.0 || $to <= $from) {
            return 1.0;
        }

        $ramp = max(0.0, min(1.0, ($probabilityPercent - $from) / ($to - $from)));

        return round(1.0 + ($penalty - 1.0) * $ramp, 3);
    }

    /**
     * Swap the provider's rain probability for the trained campus model's.
     *
     * Needs a SECOND forecast request (RainModel::queryParams) because the model
     * reads 15-minute history that the routing query does not ask for. Any problem
     * (request failed, missing inputs) keeps the model's last answer for up to
     * weather.model_carry_minutes (carryModelForward); without one, or with no model
     * file, the state is returned unchanged (the provider probability), so weather
     * can never block navigation. Set weather.use_model = false to switch it off.
     *
     * @param  array<string, mixed>  $state
     * @return array<string, mixed>
     */
    private function applyRainModel(array $state): array
    {
        if (! config('weather.use_model', true)) {
            return $state;
        }

        $model = RainModel::load();

        if ($model === null) {
            return $state;
        }

        // Optional second model: rain at any time within the next hour (ml/model_h60.json), same inputs.
        $hour = RainModel::load(config('weather.hour_model_path') ?: base_path('ml/model_h60.json'));
        $needs = fn (string $what): bool => $model->{$what}() || ($hour !== null && $hour->{$what}());

        $this->history['alert_threshold'] = $model->alertThreshold();

        try {
            $response = $this->providerGet($this->forecastUrl(), RainModel::queryParams(
                (float) config('weather.latitude'),
                (float) config('weather.longitude'),
            ));
        } catch (Throwable $exception) {
            Log::warning('Rain model request failed.', ['error' => $exception->getMessage()]);

            return $this->carryModelForward($state, $model);
        }

        if ($response->failed()) {
            Log::warning('Rain model request returned an error.', ['status' => $response->status()]);

            return $this->carryModelForward($state, $model);
        }

        $multiModel = $needs('needsMultiModel') ? $this->fetchMultiModel($model->needsMultiModel() ? $model : $hour) : null;
        // The airport reports applyAirportReport() already downloaded (same station, enough
        // hours); a second download only when that one failed.
        $metars = null;
        if ($needs('needsObservations')) {
            $metars = $this->history['metars'] ?? [];
            if ($metars === []) {
                $metars = $this->fetchAirportReports($model->observationQueryParams());
                $this->history['metars'] = $metars;
            }
        }

        $payload = $response->json() ?? [];
        $satellite = $needs('needsSatellite') ? $this->fetchSatellite($model->satelliteArguments($payload)) : null;
        [$p, $scored] = $this->scoreModel($model, $payload, $multiModel, $metars, $satellite);
        if ($scored !== $model) {
            $this->history['alert_threshold'] = $scored->alertThreshold();
        }

        if ($p === null) {
            Log::warning('Rain model inputs were incomplete.');

            return $this->carryModelForward($state, $model);
        }

        $usedSatellite = $model->needsSatellite() && $scored === $model;
        [$pHour, $scoredHour] = $hour === null ? [null, null] : $this->scoreModel($hour, $payload, $multiModel, $metars, $satellite);

        return array_merge(
            $this->withModelProbability($state, $scored, (int) round($p * 100), now()->toIso8601String()),
            $model->needsSatellite() ? ['model_satellite' => $usedSatellite] : [],
            // Shown next to the 20-minute chance; routing still follows the 20-minute model only.
            $pHour === null ? [] : [
                'rain_probability_hour' => (int) round($pHour * 100),
                'rain_hour_alert' => (int) round($scoredHour->alertThreshold() * 100),
            ],
            // NOAA and JMA ask for attribution of Himawari data (registry.opendata.aws/noaa-himawari).
            $usedSatellite ? ['attribution' => ($state['attribution'] ?? self::ATTRIBUTION).'; '.self::SATELLITE_ATTRIBUTION] : [],
        );
    }

    /**
     * Score one rain model; with no recent satellite scan, the same model trained without satellite
     * inputs (its "fallback"). Returns the probability (null = inputs incomplete) and the model scored.
     *
     * @param  array<string, mixed>  $payload
     * @param  array<string, mixed>|null  $multiModel
     * @param  list<array{time: string, raw: string}>|null  $metars
     * @param  array<string, float>|null  $satellite
     * @return array{0: float|null, 1: RainModel}
     */
    private function scoreModel(RainModel $model, array $payload, ?array $multiModel, ?array $metars, ?array $satellite): array
    {
        $p = $model->probability($payload, null, $multiModel, $metars, $satellite);
        if ($p === null && $model->needsSatellite() && $satellite === null && ($fallback = $model->fallback()) !== null) {
            return [$fallback->probability($payload, null, $multiModel, $metars), $fallback];
        }

        return [$p, $model];
    }

    /**
     * Satellite inputs for the rain model from `python ml/satellite.py now` (the same code that
     * built them for training), or null when Python, the download or the scan is not available.
     *
     * @param  array{at: string, wind_dir: float|null}  $arguments
     * @return array<string, float>|null
     */
    private function fetchSatellite(array $arguments): ?array
    {
        if (! config('weather.use_satellite', true)) {
            return null;
        }

        $command = [(string) config('weather.python', 'python'), 'satellite.py', 'now', '--at', $arguments['at']];
        if ($arguments['wind_dir'] !== null) {
            $command = [...$command, '--wind-dir', (string) $arguments['wind_dir']];
        }

        try {
            $result = Process::path(base_path('ml'))
                ->timeout((int) config('weather.satellite_timeout', 45))
                ->run($command);
        } catch (Throwable $exception) {
            Log::warning('Satellite inputs could not be read.', ['error' => $exception->getMessage()]);

            return null;
        }

        $answer = json_decode(trim($result->output()), true);
        if (! $result->successful() || ! is_array($answer) || ($answer['ok'] ?? false) !== true || ! is_array($answer['features'] ?? null)) {
            Log::warning('Satellite inputs unavailable.', [
                'error' => is_array($answer) ? ($answer['error'] ?? null) : trim($result->errorOutput()),
            ]);

            return null;
        }

        return array_map('floatval', array_filter($answer['features'], 'is_numeric'));
    }

    /**
     * This refresh could not score the model (a request timed out, an input was missing). The
     * model's last answer is still the best estimate for a while: its 20-minute chance moves
     * slowly, and the raw provider chance it replaces scored far worse on the test period
     * (Brier 0.27 against the model's 0.04). Kept up to weather.model_carry_minutes after the
     * model really scored; older, the provider chance is used and says so.
     *
     * @param  array<string, mixed>  $state
     * @return array<string, mixed>
     */
    private function carryModelForward(array $state, RainModel $model): array
    {
        $previous = Cache::get(config('weather.cache_key'));
        $scoredAt = is_array($previous) && ($previous['probability_source'] ?? null) === 'model'
            ? ($previous['model_scored_at'] ?? $previous['fetched_at'] ?? null)
            : null;
        $age = $this->ageMinutes($scoredAt);

        if ($age === null || $age > (int) config('weather.model_carry_minutes', 40) || ! is_numeric($previous['rain_probability'] ?? null)) {
            Log::warning('Rain model could not score; using the provider probability.');

            return $state;
        }

        return $this->withModelProbability($state, $model, (int) $previous['rain_probability'], (string) $scoredAt);
    }

    /**
     * The state with the model's probability and the rain mode and multiplier that follow from it.
     *
     * @param  array<string, mixed>  $state
     * @return array<string, mixed>
     */
    private function withModelProbability(array $state, RainModel $model, int $probability, string $scoredAt): array
    {
        $rainingNow = (bool) ($state['raining_now'] ?? false);
        $penalty = (float) config('weather.rain_penalty');

        // The model's probability is a 20-minute chance with its own calibration, so it has its own
        // thresholds instead of the provider's rain_on/rain_off: by default the alert threshold that
        // ml/train.py chose on the validation period, switching off again at 60% of it.
        $rainOn = config('weather.model_rain_on') ?? (int) round($model->alertThreshold() * 100);
        $rainOff = config('weather.model_rain_off') ?? (int) round($rainOn * 0.6);
        $rainMode = $this->resolveRainMode($rainingNow, $probability, (int) $rainOn, (int) $rainOff);

        $multiplier = $rainingNow
            ? $penalty
            : self::gradedMultiplier(
                $probability,
                $penalty,
                (int) config('weather.model_ramp_from', 10),
                (int) config('weather.model_ramp_to', 50),
            );

        return array_merge($state, [
            'rain_probability' => $probability,
            'probability_source' => 'model',
            'probability_horizon_minutes' => $model->horizonMinutes(),
            'model_scored_at' => $scoredAt,
            'rain_mode' => $rainMode,
            'rain_multiplier' => $multiplier,
        ]);
    }

    /**
     * GET from a weather provider with short timeouts and two retries on a dropped connection,
     * a server error or rate limiting (the requests are idempotent). One slow answer must not
     * cost the model its inputs: that is what turned a dry evening into "raining" before.
     */
    private function providerGet(string $url, array $query): Response
    {
        return Http::withHeaders(['User-Agent' => (string) config('weather.user_agent')])
            ->connectTimeout(4)
            ->timeout(8)
            ->retry([300, 900], 0, function (Throwable $exception): bool {
                return $exception instanceof ConnectionException
                    || ($exception instanceof RequestException
                        && ($exception->response->serverError() || $exception->response->status() === 429));
            }, throw: false)
            ->get($url, $query);
    }

    /**
     * The several-models forecast the rain model reads, or null on any failure (the model then
     * cannot score and the provider probability is used).
     *
     * @return array<string, mixed>|null
     */
    private function fetchMultiModel(RainModel $model): ?array
    {
        try {
            $response = $this->providerGet($this->forecastUrl(), $model->multiModelQueryParams(
                (float) config('weather.latitude'),
                (float) config('weather.longitude'),
            ));
        } catch (Throwable $exception) {
            Log::warning('Several-models forecast request failed.', ['error' => $exception->getMessage()]);

            return null;
        }

        if ($response->failed()) {
            Log::warning('Several-models forecast request returned an error.', ['status' => $response->status()]);

            return null;
        }

        return $response->json() ?? [];
    }

    /**
     * Recent airport reports, for the rain model and the history outcomes. On any failure an
     * empty list: the model then scores with "no recent report", a state it was trained on,
     * instead of not scoring at all.
     *
     * @param  array<string, mixed>  $query  aviationweather.gov METAR API query (ids, format=json, hours)
     * @return list<array{time: string, raw: string}>
     */
    private function fetchAirportReports(array $query): array
    {
        try {
            $response = $this->providerGet((string) config('weather.metar_url'), $query);
        } catch (Throwable $exception) {
            Log::warning('Airport report request failed; scoring without it.', ['error' => $exception->getMessage()]);

            return [];
        }

        if ($response->failed()) {
            Log::warning('Airport report request returned an error; scoring without it.', ['status' => $response->status()]);

            return [];
        }

        return Metar::fromAviationWeather($response->json());
    }

    /**
     * Add the 1-3 hour heat index outlook (heat_forecast) from the trained heat model.
     *
     * Uses its OWN request (HeatModel::queryParams) because the model needs the past hours.
     * Any problem falls back, per horizon, to the heat index of the provider's forecast
     * temperature and humidity, which the routing query already carries. Never throws.
     *
     * @param  array<string, mixed>  $state
     * @param  array<string, mixed>  $routingPayload  the main forecast response (fallback source)
     * @return array<string, mixed>
     */
    private function applyHeatOutlook(array $state, array $routingPayload): array
    {
        $thresholds = $this->heatThresholds();
        $fallback = HeatModel::fallback()->forecast($routingPayload, null, $thresholds);
        $this->history['provider_heat'] = $fallback['items'];
        $model = config('weather.use_heat_model', true) ? HeatModel::load() : null;

        if ($model === null || ! $model->hasModel()) {
            return $this->withHeatMode(array_merge($state, ['heat_forecast' => $fallback['items'], 'heat_forecast_source' => $fallback['source']]));
        }

        try {
            $response = $this->providerGet($this->forecastUrl(), HeatModel::queryParams(
                (float) config('weather.latitude'),
                (float) config('weather.longitude'),
            ));
            $outlook = $response->failed() ? $fallback : $model->forecast($response->json() ?? [], null, $thresholds);
        } catch (Throwable $exception) {
            Log::warning('Heat model request failed; using the forecast heat index.', ['error' => $exception->getMessage()]);
            $outlook = $fallback;
        }

        if ($outlook['items'] === []) {
            $outlook = $fallback;
        }

        return $this->withHeatMode(array_merge($state, ['heat_forecast' => $outlook['items'], 'heat_forecast_source' => $outlook['source']]));
    }

    /**
     * @param  array<string, mixed>  $state
     * @return array<string, mixed>
     */
    private function withHeatMode(array $state): array
    {
        $limit = $this->heatModeLimit();
        $now = is_numeric($state['heat_index_c'] ?? null) ? (float) $state['heat_index_c'] : null;

        return array_merge($state, [
            'heat_mode' => self::resolveHeatMode($now, $limit),
            'heat_mode_c' => $limit,
        ]);
    }

    private function heatModeLimit(): float
    {
        return (float) config('weather.heat_mode_c', 40);
    }

    /**
     * Heat mode is on when the heat index NOW is above the limit (40 C by default). A prediction
     * (heat_forecast) never closes paths ahead of time: the phone closes them once a predicted hot
     * hour has actually begun, until the next refresh decides again (src/weatherCost.js heatModeActive).
     */
    public static function resolveHeatMode(?float $heatIndexNow, float $limit): bool
    {
        return $heatIndexNow !== null && $heatIndexNow > $limit;
    }

    /**
     * @return array<string, float|int>
     */
    private function heatThresholds(): array
    {
        $thresholds = config('weather.heat_categories');

        return is_array($thresholds) && $thresholds !== [] ? $thresholds : HeatIndex::DEFAULT_CATEGORIES;
    }

    /**
     * Build the cached state from an Open-Meteo /v1/forecast payload.
     *
     * @param  array<string, mixed>  $payload
     * @return array<string, mixed>
     */
    private function buildState(array $payload): array
    {
        $current = is_array($payload['current'] ?? null) ? $payload['current'] : [];
        $hourly = is_array($payload['hourly'] ?? null) ? $payload['hourly'] : [];

        $precipitationMm = is_numeric($current['precipitation'] ?? null) ? (float) $current['precipitation'] : null;
        $currentCode = is_numeric($current['weather_code'] ?? null) ? (int) $current['weather_code'] : null;
        $temperature = is_numeric($current['temperature_2m'] ?? null) ? round((float) $current['temperature_2m'], 1) : null;
        $humidity = is_numeric($current['relative_humidity_2m'] ?? null) ? (int) round((float) $current['relative_humidity_2m']) : null;
        $apparent = is_numeric($current['apparent_temperature'] ?? null) ? round((float) $current['apparent_temperature'], 1) : null;
        $heatIndex = ($temperature !== null && $humidity !== null)
            ? round(HeatIndex::celsius((float) $current['temperature_2m'], (float) $current['relative_humidity_2m']), 1)
            : null;
        $uvIndex = is_numeric($current['uv_index'] ?? null) ? round(max(0.0, (float) $current['uv_index']), 1) : null;

        [$probability, $source] = $this->probabilityFromHourly($hourly);

        if ($probability === null) {
            [$probability, $source] = $this->probabilityFromCodes($hourly, $currentCode);
        }

        $rainingNow = ($precipitationMm !== null && $precipitationMm >= (float) config('weather.raining_now_mm'))
            || ($currentCode !== null && $this->isRainCode($currentCode));

        $rainMode = $this->resolveRainMode($rainingNow, $probability);

        return [
            'status' => 'ok',
            'rain_probability' => $probability,
            'probability_source' => $source,
            'raining_now' => $rainingNow,
            'rain_mode' => $rainMode,
            'rain_multiplier' => $rainMode ? (float) config('weather.rain_penalty') : 1.0,
            'rain_penalty' => (float) config('weather.rain_penalty'),
            'probability_horizon_minutes' => null,
            'condition' => $this->conditionOf($currentCode),
            'weather_code' => $currentCode,
            'temperature_c' => $temperature,
            'humidity' => $humidity,
            'apparent_temperature_c' => $apparent,
            'heat_index_c' => $heatIndex,
            'heat_category' => $heatIndex === null ? null : HeatIndex::category($heatIndex, $this->heatThresholds()),
            'heat_mode' => self::resolveHeatMode($heatIndex, $this->heatModeLimit()),
            'heat_mode_c' => $this->heatModeLimit(),
            'heat_forecast' => [],
            'heat_forecast_source' => null,
            // Sunburn risk (Open-Meteo's forecast UV index, WHO scale); routes prefer shade from "high".
            'uv_index' => $uvIndex,
            'uv_category' => self::uvCategory($uvIndex),
            'fetched_at' => now()->toIso8601String(),
            'attribution' => self::ATTRIBUTION,
        ];
    }

    /** WHO UV index category: low < 3, moderate < 6, high < 8, very high < 11, extreme 11+. */
    public static function uvCategory(?float $uv): ?string
    {
        return match (true) {
            $uv === null => null,
            $uv < 3 => 'low',
            $uv < 6 => 'moderate',
            $uv < 8 => 'high',
            $uv < 11 => 'very_high',
            default => 'extreme',
        };
    }

    /**
     * Rain chance over the lookahead window, or null when the provider gave
     * no usable probabilities.
     *
     * @param  array<string, mixed>  $hourly
     * @return array{0: int|null, 1: string|null}
     */
    private function probabilityFromHourly(array $hourly): array
    {
        $values = is_array($hourly['precipitation_probability'] ?? null) ? $hourly['precipitation_probability'] : [];
        $window = array_slice($values, 0, max(1, (int) config('weather.lookahead_hours')));

        $numbers = array_values(array_filter($window, 'is_numeric'));
        if ($numbers === []) {
            return [null, null];
        }

        return [(int) max(array_map('floatval', $numbers)), 'forecast'];
    }

    /**
     * Fallback when the provider sends no probabilities: read the weather
     * codes instead. "Rain soon" is worth 70, otherwise a dry 10.
     *
     * @param  array<string, mixed>  $hourly
     * @return array{0: int, 1: string}
     */
    private function probabilityFromCodes(array $hourly, ?int $currentCode): array
    {
        $codes = is_array($hourly['weather_code'] ?? null) ? $hourly['weather_code'] : [];
        $window = array_slice($codes, 0, max(1, (int) config('weather.lookahead_hours')));

        foreach ($window as $code) {
            if (is_numeric($code) && $this->isRainCode((int) $code)) {
                return [70, 'weather_code'];
            }
        }

        if ($currentCode !== null && $this->isRainCode($currentCode)) {
            return [70, 'weather_code'];
        }

        return [10, 'weather_code'];
    }

    /**
     * Rain mode with hysteresis: ON when it is raining or the probability
     * reaches rain_on; OFF when it drops to rain_off; otherwise the previous
     * state is kept. The gap stops the flag flapping between two polls.
     */
    private function resolveRainMode(bool $rainingNow, int $probability, ?int $on = null, ?int $off = null): bool
    {
        if ($rainingNow) {
            return true;
        }

        if ($probability >= ($on ?? (int) config('weather.rain_on'))) {
            return true;
        }

        if ($probability <= ($off ?? (int) config('weather.rain_off'))) {
            return false;
        }

        $previous = Cache::get(config('weather.cache_key'));

        return is_array($previous) ? (bool) ($previous['rain_mode'] ?? false) : false;
    }

    private function isRainCode(int $code): bool
    {
        return in_array($code, self::RAIN_CODES, true);
    }

    /**
     * Human-facing condition word for the UI chip.
     */
    private function conditionOf(?int $code): string
    {
        return match ($code) {
            0 => 'clear',
            1, 2, 3 => 'cloudy',
            45, 48 => 'fog',
            51, 53, 55, 56, 57 => 'drizzle',
            61, 63, 65, 66, 67 => 'rain',
            80, 81, 82 => 'showers',
            95, 96, 99 => 'thunderstorm',
            default => 'unknown',
        };
    }

    /**
     * Fresh enough to serve, but from a previous process run.
     *
     * @param  array<string, mixed>  $state
     * @return array<string, mixed>
     */
    private function staleState(array $state): array
    {
        // array_merge, NOT `+`: the cached array already carries status /
        // rain_mode / rain_multiplier keys, and `+` keeps the LEFT side, so
        // the stale overrides would silently never apply.
        return array_merge($state, [
            'status' => 'stale',
            // Stale data must never change routing, so it is served as "dry".
            'rain_mode' => false,
            'rain_multiplier' => 1.0,
            'heat_mode' => false,
            'age_minutes' => $this->ageMinutes($state['fetched_at'] ?? null),
        ]);
    }

    /**
     * Nothing has ever been fetched (cold cache with no network).
     *
     * @return array<string, mixed>
     */
    private function unavailableState(): array
    {
        return [
            'status' => 'unavailable',
            'rain_probability' => null,
            'probability_source' => null,
            'raining_now' => false,
            'rain_mode' => false,
            'rain_multiplier' => 1.0,
            'rain_penalty' => (float) config('weather.rain_penalty'),
            'probability_horizon_minutes' => null,
            'condition' => 'unknown',
            'weather_code' => null,
            'temperature_c' => null,
            'humidity' => null,
            'apparent_temperature_c' => null,
            'heat_index_c' => null,
            'heat_category' => null,
            'heat_forecast' => [],
            'heat_forecast_source' => null,
            'heat_mode' => false,
            'heat_mode_c' => $this->heatModeLimit(),
            'fetched_at' => null,
            'age_minutes' => null,
            'attribution' => self::ATTRIBUTION,
        ];
    }

    private function ageMinutes(?string $fetchedAt): ?int
    {
        if (! $fetchedAt) {
            return null;
        }

        try {
            $then = new \DateTimeImmutable($fetchedAt);
        } catch (Throwable) {
            return null;
        }

        return max(0, (int) round((time() - $then->getTimestamp()) / 60));
    }

    private function forecastUrl(): string
    {
        return (string) config('weather.forecast_url');
    }

    /**
     * @return array<string, mixed>
     */
    private function forecastQuery(): array
    {
        return [
            'latitude' => config('weather.latitude'),
            'longitude' => config('weather.longitude'),
            'current' => 'temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,uv_index',
            // temperature/humidity: the heat outlook fallback. Adding variables does not shift
            // the arrays; forecast_hours 4 = this hour + 3 (the rain lookahead reads the first 2).
            'hourly' => 'precipitation_probability,weather_code,temperature_2m,relative_humidity_2m',
            'forecast_hours' => 4,
            'timezone' => 'auto',
        ];
    }
}
