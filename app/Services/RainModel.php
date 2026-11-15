<?php

namespace App\Services;

use DateTimeImmutable;
use DateTimeZone;
use Illuminate\Support\Carbon;
use Throwable;

/**
 * Scores the trained rain predictor (ml/model.json) in plain PHP.
 *
 * No Python runs on the server: ml/train.py exports a logistic regression
 * (mean, scale, coef, intercept) and this class repeats the exact feature
 * maths of ml/common.py::build_features(). The two MUST stay identical -
 * ml/model_parity.json + RainModelParityTest prove they agree.
 *
 * Satellite inputs (sat_*) are NOT computed here: WeatherService runs
 * `python ml/satellite.py now` (the same code training used) and passes them in.
 * A model trained with them carries a "fallback" model without them, used when
 * no satellite scan is recent enough.
 *
 * Never throws. Every failure returns null so WeatherService can fall back to
 * the raw Open-Meteo probability (weather must never block navigation).
 */
class RainModel
{
    private const KEY = 'Y-m-d\TH:i';

    /** Same as WeatherService::RAIN_CODES / ml/common.py::RAIN_CODES. */
    private const RAIN_CODES = [51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99];

    /** Thunderstorm weather codes (ml/common.py::THUNDER_CODES). */
    private const THUNDER_CODES = [95, 96, 99];

    /** The 0/1 airport-report features (obs_age_min is the ninth). */
    private const OBSERVATION_FEATURES = [
        'obs_rain', 'obs_rain_fresh', 'obs_rain_2h', 'obs_thunder', 'obs_vicinity',
        'obs_convective_cloud', 'obs_lightning', 'obs_recent_rain',
    ];

    /** @param array<string, mixed> $model decoded model.json */
    private function __construct(private readonly array $model) {}

    /** Load ml/model.json (or weather.model_path). Returns null when missing, invalid or not "recommended". */
    public static function load(?string $path = null): ?self
    {
        $path ??= config('weather.model_path') ?: base_path('ml/model.json');

        try {
            $model = json_decode((string) file_get_contents($path), true, 512, JSON_THROW_ON_ERROR);
        } catch (Throwable) {
            return null;
        }

        $ok = is_array($model) && ($model['recommended'] ?? false) === true && self::scorable($model);

        return $ok ? new self($model) : null;
    }

    /** The fields that turn inputs into a score (ml/train.py export_of): kept apart when merging a fallback. */
    private const SCORING_KEYS = ['kind', 'features', 'mean', 'scale', 'coef', 'intercept', 'C', 'baseline', 'trees', 'tree_params', 'calibration', 'importance'];

    /**
     * A logistic model (mean/scale/coef/intercept per feature) or gradient-boosted trees (baseline + trees).
     *
     * @param  array<string, mixed>  $m
     */
    private static function scorable(array $m): bool
    {
        if (! isset($m['features']) || ! is_array($m['features']) || $m['features'] === []) {
            return false;
        }
        if (($m['kind'] ?? 'logistic') === 'trees') {
            return isset($m['baseline']) && is_array($m['trees'] ?? null) && $m['trees'] !== [];
        }

        return isset($m['mean'], $m['scale'], $m['coef'], $m['intercept'])
            && count($m['features']) === count($m['coef'])
            && count($m['features']) === count($m['mean'])
            && count($m['features']) === count($m['scale']);
    }

    /** Load regardless of the "recommended" flag (used by the parity test only). */
    public static function loadForTesting(string $path): ?self
    {
        $model = json_decode((string) file_get_contents($path), true);

        return is_array($model) ? new self($model) : null;
    }

    public function horizonMinutes(): int
    {
        return (int) ($this->model['horizon_minutes'] ?? 20);
    }

    /** Probability (0..1) at which the model's evaluation turned rain mode on (chosen on validation data). */
    public function alertThreshold(): float
    {
        return (float) ($this->model['alert_threshold'] ?? 0.6);
    }

    /** Whether the model reads the latest airport report (obs_* features). */
    public function needsObservations(): bool
    {
        return $this->usesFeaturesStartingWith('obs_');
    }

    /** Whether the model reads Himawari cloud-top inputs (sat_* features, from ml/satellite.py). */
    public function needsSatellite(): bool
    {
        return $this->usesFeaturesStartingWith('sat_');
    }

    /**
     * The model trained WITHOUT satellite inputs, exported next to a satellite model by ml/train.py,
     * for refreshes where no scan was recent enough. Null when the model has none.
     */
    public function fallback(): ?self
    {
        $fb = $this->model['fallback'] ?? null;
        if (! is_array($fb) || ! self::scorable($fb)) {
            return null;
        }

        // Settings (airport, several models, horizon) from the main model; HOW to score only from the
        // fallback, so the main model's trees or calibration never leak into it.
        $model = array_merge(array_diff_key($this->model, array_flip(self::SCORING_KEYS)), $fb);
        unset($model['fallback'], $model['satellite']);

        return new self($model);
    }

    /**
     * Arguments for `python ml/satellite.py now`: the 15-minute step the model scores and the
     * forecast wind direction there (for the upwind storm-cloud share), like ml/common.py.
     *
     * @param  array<string, mixed>  $payload  decoded /v1/forecast response (queryParams())
     * @return array{at: string, wind_dir: float|null}
     */
    public function satelliteArguments(array $payload, ?DateTimeImmutable $now = null): array
    {
        $t = $this->stepFor($now);
        $m = $this->indexByTime($payload['minutely_15'] ?? null);

        return [
            'at' => $t->format(self::KEY),
            'wind_dir' => $m === null ? null : $this->num($m['wind_direction_10m'][$t->format(self::KEY)] ?? null),
        ];
    }

    /** Whether the model reads several forecast models (mm_* features). */
    public function needsMultiModel(): bool
    {
        return $this->usesFeaturesStartingWith('mm_');
    }

    /** ICAO code of the airport whose reports the model learned from. */
    public function observationStation(): string
    {
        return (string) ($this->model['observation']['station'] ?? 'RPMZ');
    }

    /**
     * Query for the aviationweather.gov METAR API: enough hours to cover the oldest report the model still reads.
     *
     * @return array<string, mixed>
     */
    public function observationQueryParams(): array
    {
        $minutes = $this->observationSetting('max_age_minutes', 240) + $this->observationSetting('lag_minutes', 10);

        return [
            'ids' => $this->observationStation(),
            'format' => 'json',
            'hours' => (int) ceil($minutes / 60) + 1,
        ];
    }

    /**
     * Query for the several-models request (its own /v1/forecast call: `models=` renames every variable).
     *
     * @return array<string, mixed>
     */
    public function multiModelQueryParams(float $lat, float $lng): array
    {
        return [
            'latitude' => $lat,
            'longitude' => $lng,
            'hourly' => implode(',', $this->model['multi_model']['variables'] ?? ['precipitation', 'cloud_cover', 'weather_code']),
            'models' => implode(',', $this->multiModelNames()),
            'past_hours' => 2,
            'forecast_hours' => 3,
            'timezone' => 'Asia/Manila',
        ];
    }

    /**
     * Query for a SEPARATE Open-Meteo /v1/forecast request. Do not merge it into
     * WeatherService::forecastQuery(): past_hours shifts the hourly arrays and
     * would break the existing "first N hours" lookahead logic.
     *
     * @return array<string, mixed>
     */
    public static function queryParams(float $lat, float $lng): array
    {
        return [
            'latitude' => $lat,
            'longitude' => $lng,
            'minutely_15' => 'precipitation,temperature_2m,relative_humidity_2m,dew_point_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m,cape,weather_code',
            'hourly' => 'pressure_msl,cloud_cover,precipitation_probability,precipitation',
            'past_minutely_15' => 12,
            'forecast_minutely_15' => 4,
            'past_hours' => 4,
            'forecast_hours' => 2,
            'timezone' => 'Asia/Manila',
        ];
    }

    /**
     * Probability (0..1) of rain within the model horizon, or null when any
     * required input is missing.
     *
     * @param  array<string, mixed>  $payload  decoded /v1/forecast response (queryParams())
     * @param  array<string, mixed>|null  $multiModel  decoded response of multiModelQueryParams()
     * @param  list<array{time: string, raw: string}>|null  $metars  airport reports (Metar::fromAviationWeather())
     * @param  array<string, float>|null  $satellite  sat_* inputs from ml/satellite.py (null = none)
     */
    public function probability(array $payload, ?DateTimeImmutable $now = null, ?array $multiModel = null, ?array $metars = null, ?array $satellite = null): ?float
    {
        $features = $this->featuresFromPayload($payload, $now, $multiModel, $metars, $satellite);

        return $features === null ? null : $this->score($features);
    }

    /**
     * @param  array<string, float>  $features
     */
    public function score(array $features): ?float
    {
        $x = [];
        foreach ($this->model['features'] as $name) {
            if (! isset($features[$name]) || ! is_finite($features[$name])) {
                return null;
            }
            // Same rounding as ml/common.py INPUT_DECIMALS (training too): PHP and numpy differ in the
            // 16th digit, which flipped tree splits sitting exactly on a value.
            $x[] = round((float) $features[$name], 9);
        }

        if (($this->model['kind'] ?? 'logistic') === 'trees') {
            // Gradient-boosted trees (ml/train.py export_of): walk each tree to its leaf and add the leaves.
            $z = (float) $this->model['baseline'];
            foreach ($this->model['trees'] as $tree) {
                $i = 0;
                while ($tree['f'][$i] >= 0) {
                    $i = $x[$tree['f'][$i]] <= (float) $tree['t'][$i] ? $tree['l'][$i] : $tree['r'][$i];
                }
                $z += (float) $tree['v'][$i];
            }
        } else {
            $z = (float) $this->model['intercept'];
            foreach ($x as $i => $value) {
                $scale = (float) $this->model['scale'][$i];
                $z += (float) $this->model['coef'][$i] * (($value - (float) $this->model['mean'][$i]) / ($scale ?: 1.0));
            }
        }

        // Platt calibration fitted on the validation period: the percentage means what it says.
        $cal = $this->model['calibration'] ?? null;
        if (is_array($cal)) {
            $z = (float) $cal['a'] * $z + (float) $cal['b'];
        }

        return 1.0 / (1.0 + exp(-$z));
    }

    /**
     * Mirror of ml/common.py::build_features() (+ build_obs_features() and
     * build_multimodel_features() when the model uses them) for ONE time step.
     *
     * An empty $metars list means "no recent airport report", which the model was trained on
     * (stale flags), so a failed report download still gives a prediction. A missing or
     * incomplete $multiModel answer returns null like any other missing input.
     *
     * @param  array<string, mixed>  $payload
     * @param  array<string, mixed>|null  $multiModel
     * @param  list<array{time: string, raw: string}>|null  $metars
     * @param  array<string, float>|null  $satellite  sat_* inputs from ml/satellite.py, passed on unchanged
     * @return array<string, float>|null null when any feature the model needs is missing
     */
    public function featuresFromPayload(array $payload, ?DateTimeImmutable $now = null, ?array $multiModel = null, ?array $metars = null, ?array $satellite = null): ?array
    {
        $t = $this->stepFor($now);
        $base = $t->setTime((int) $t->format('G'), 0, 0);

        $m = $this->indexByTime($payload['minutely_15'] ?? null);
        $h = $this->indexByTime($payload['hourly'] ?? null);
        if ($m === null || $h === null) {
            return null;
        }

        $at = fn (string $var, int $stepsBack): ?float => $this->num($m[$var][$t->modify('-'.(15 * $stepsBack).' minutes')->format(self::KEY)] ?? null);
        $hr = fn (string $var, int $hoursOffset): ?float => $this->num($h[$var][$base->modify(($hoursOffset >= 0 ? '+' : '').$hoursOffset.' hours')->format(self::KEY)] ?? null);

        $sum = function (int $count) use ($at): ?float {
            $total = 0.0;
            for ($k = 0; $k < $count; $k++) {
                $v = $at('precipitation', $k);
                if ($v === null) {
                    return null;
                }
                $total += $v;
            }

            return $total;
        };

        $temp = $at('temperature_2m', 0);
        $temp4 = $at('temperature_2m', 4);
        $dew = $at('dew_point_2m', 0);
        $dir = $at('wind_direction_10m', 0);
        $code = $at('weather_code', 0);
        $pressure = $hr('pressure_msl', 0);
        $pressure3 = $hr('pressure_msl', -3);

        $hourFrac = (int) $t->format('G') + ((int) $t->format('i')) / 60.0;
        $doy = (int) $t->format('z') + 1; // 'z' is 0-based; pandas dayofyear is 1-based

        $all = [
            'precip_0' => $at('precipitation', 0),
            'precip_1' => $at('precipitation', 1),
            'precip_2' => $at('precipitation', 2),
            'precip_sum_1h' => $sum(4),
            'precip_sum_3h' => $sum(12),
            'rain_code_now' => $code === null ? null : (in_array((int) $code, self::RAIN_CODES, true) ? 1.0 : 0.0),
            'temp' => $temp,
            'temp_change_1h' => ($temp !== null && $temp4 !== null) ? $temp - $temp4 : null,
            'humidity' => $at('relative_humidity_2m', 0),
            'dewpoint_depression' => ($temp !== null && $dew !== null) ? $temp - $dew : null,
            'wind_speed' => $at('wind_speed_10m', 0),
            'wind_gust' => $at('wind_gusts_10m', 0),
            'wind_dir_sin' => $dir === null ? null : sin(deg2rad($dir)),
            'wind_dir_cos' => $dir === null ? null : cos(deg2rad($dir)),
            'cape' => $at('cape', 0),
            'pressure' => $pressure,
            'pressure_change_3h' => ($pressure !== null && $pressure3 !== null) ? $pressure - $pressure3 : null,
            'cloud_cover' => $hr('cloud_cover', 0),
            'precip_prob_next_hour' => $hr('precipitation_probability', 1),
            'fcst_precip_next_hour' => $hr('precipitation', 1),
            'hour_sin' => sin(2 * M_PI * $hourFrac / 24.0),
            'hour_cos' => cos(2 * M_PI * $hourFrac / 24.0),
            'doy_sin' => sin(2 * M_PI * $doy / 365.25),
            'doy_cos' => cos(2 * M_PI * $doy / 365.25),
        ];

        if ($this->needsObservations()) {
            $all += $this->observationFeatures($t, $metars ?? []);
        }
        if ($this->needsMultiModel()) {
            $all += $this->multiModelFeatures($base, $multiModel);
        }
        if ($this->needsSatellite()) {
            foreach ($satellite ?? [] as $name => $value) {
                if (str_starts_with((string) $name, 'sat_') && is_numeric($value) && is_finite((float) $value)) {
                    $all[(string) $name] = (float) $value;
                }
            }
        }

        $out = [];
        foreach ($this->model['features'] as $name) {
            if (! array_key_exists($name, $all) || $all[$name] === null) {
                return null;
            }
            $out[$name] = $all[$name];
        }

        return $out;
    }

    /**
     * Mirror of ml/common.py::build_obs_features() for the step $t: only reports issued at or
     * before $t - lag count (they must have reached the app). No report within max_age =
     * every flag 0 and the age capped at max_age.
     *
     * @param  list<array{time: string, raw: string}>  $metars
     * @return array<string, float>
     */
    public function observationFeatures(DateTimeImmutable $t, array $metars): array
    {
        $lag = $this->observationSetting('lag_minutes', 10);
        $maxAge = $this->observationSetting('max_age_minutes', 240);
        $fresh = $this->observationSetting('fresh_minutes', 120);
        $recent = $this->observationSetting('recent_minutes', 120);
        $tz = $t->getTimezone();
        $cut = $t->getTimestamp() - $lag * 60;

        // One report per minute (the last one wins, like pandas drop_duplicates(keep="last")).
        $byTime = [];
        foreach ($metars as $report) {
            $time = DateTimeImmutable::createFromFormat('!Y-m-d\TH:i', (string) ($report['time'] ?? ''), $tz);
            if ($time !== false) {
                $byTime[$time->getTimestamp()] = (string) ($report['raw'] ?? '');
            }
        }
        ksort($byTime);

        $latest = null;
        $rainInWindow = false;
        foreach ($byTime as $stamp => $raw) {
            if ($stamp > $cut) {
                break;
            }
            $latest = $stamp;
            if ($stamp >= $cut - $recent * 60 && Metar::flags($raw)['rain'] > 0) {
                $rainInWindow = true;
            }
        }

        $age = $latest === null ? null : ($t->getTimestamp() - $latest) / 60.0;
        if ($age === null || $age > $maxAge) {
            return array_fill_keys(self::OBSERVATION_FEATURES, 0.0) + ['obs_age_min' => (float) $maxAge];
        }

        $flags = Metar::flags($byTime[$latest]);

        return [
            'obs_rain' => $flags['rain'],
            'obs_rain_fresh' => $flags['rain'] * max(0.0, min(1.0, 1.0 - $age / $fresh)),
            'obs_rain_2h' => $rainInWindow ? 1.0 : 0.0,
            'obs_thunder' => $flags['thunder'],
            'obs_vicinity' => $flags['vicinity'],
            'obs_convective_cloud' => $flags['convective_cloud'],
            'obs_lightning' => $flags['lightning'],
            'obs_recent_rain' => $flags['recent_rain'],
            'obs_age_min' => $age,
        ];
    }

    /**
     * Mirror of ml/common.py::build_multimodel_features() for the hour $base (= floor of the step).
     * Rain and weather code are read at $base + 1 h, cloud cover at $base. Each feature is null
     * when fewer than min_models models answered.
     *
     * @param  array<string, mixed>|null  $payload  decoded response of multiModelQueryParams()
     * @return array<string, float|null>
     */
    public function multiModelFeatures(DateTimeImmutable $base, ?array $payload): array
    {
        $h = $this->indexByTime($payload['hourly'] ?? null) ?? [];
        $next = $base->modify('+1 hour')->format(self::KEY);
        $now = $base->format(self::KEY);
        $minModels = (int) ($this->model['multi_model']['min_models'] ?? 5);
        $wetMm = (float) ($this->model['multi_model']['wet_mm'] ?? 0.1);

        $precip = $codes = $clouds = [];
        foreach ($this->multiModelNames() as $name) {
            $p = $this->num($h["precipitation_{$name}"][$next] ?? null);
            $code = $this->num($h["weather_code_{$name}"][$next] ?? null);
            $cloud = $this->num($h["cloud_cover_{$name}"][$now] ?? null);
            if ($p !== null) {
                $precip[] = $p;
            }
            if ($code !== null) {
                $codes[] = (int) $code;
            }
            if ($cloud !== null) {
                $clouds[] = $cloud;
            }
        }

        $enough = fn (array $values): bool => count($values) >= $minModels;
        $mean = fn (array $values): ?float => $enough($values) ? array_sum($values) / count($values) : null;

        return [
            'mm_wet_share' => $mean(array_map(fn (float $p): float => $p >= $wetMm ? 1.0 : 0.0, $precip)),
            'mm_precip_mean' => $mean($precip),
            'mm_cloud_mean' => $mean($clouds),
            'mm_thunder_share' => $mean(array_map(fn (int $c): float => in_array($c, self::THUNDER_CODES, true) ? 1.0 : 0.0, $codes)),
        ];
    }

    /**
     * @return list<string>
     */
    private function multiModelNames(): array
    {
        return array_values(array_map('strval', $this->model['multi_model']['models'] ?? []));
    }

    private function observationSetting(string $key, int $default): int
    {
        return (int) ($this->model['observation'][$key] ?? $default);
    }

    /** Latest COMPLETED 15-minute step (Asia/Manila): Open-Meteo stamps a value with the END of its interval. */
    private function stepFor(?DateTimeImmutable $now): DateTimeImmutable
    {
        // Carbon::now() so tests can travel in time; a plain DateTimeImmutable otherwise.
        $now = ($now ?? Carbon::now()->toDateTimeImmutable())->setTimezone(new DateTimeZone('Asia/Manila'));

        return $now->setTime((int) $now->format('G'), intdiv((int) $now->format('i'), 15) * 15, 0);
    }

    private function usesFeaturesStartingWith(string $prefix): bool
    {
        foreach ($this->model['features'] as $name) {
            if (str_starts_with((string) $name, $prefix)) {
                return true;
            }
        }

        return false;
    }

    /**
     * Turn {"time": [...], "var": [...]} into ["var" => ["2026-10-31T10:45" => value]].
     *
     * @return array<string, array<string, mixed>>|null
     */
    private function indexByTime(mixed $block): ?array
    {
        if (! is_array($block) || ! isset($block['time']) || ! is_array($block['time'])) {
            return null;
        }

        $out = [];
        foreach ($block as $var => $values) {
            if ($var === 'time' || ! is_array($values)) {
                continue;
            }
            foreach ($block['time'] as $i => $time) {
                $out[$var][(string) $time] = $values[$i] ?? null;
            }
        }

        return $out;
    }

    private function num(mixed $value): ?float
    {
        return is_numeric($value) ? (float) $value : null;
    }
}
