<?php

namespace App\Services;

use DateTimeImmutable;
use DateTimeZone;
use Illuminate\Support\Carbon;
use Throwable;

/**
 * Heat index outlook for the next 1-3 hours.
 *
 * Scores ml/heat_model.json (one ridge regression per horizon, written by
 * ml/train_heat.py) in plain PHP. featuresFromPayload() repeats
 * ml/heat_common.py::build_heat_features() for one hour; ml/heat_model_parity.json and
 * HeatModelParityTest prove the two agree.
 *
 * forecast() never throws and never returns nothing usable when the forecast has the
 * numbers: if the model file is missing, not "recommended", or an input is missing, each
 * horizon falls back to the heat index computed from Open-Meteo's own forecast temperature
 * and humidity at that hour (the "forecast HI" baseline in ml/HEAT_REPORT.md).
 */
class HeatModel
{
    private const KEY = 'Y-m-d\TH:i';

    private const TIMEZONE = 'Asia/Manila';

    /** @param array<string, mixed>|null $model decoded heat_model.json, null = forecast fallback only */
    private function __construct(private readonly ?array $model) {}

    /**
     * Load ml/heat_model.json. A missing, invalid or not "recommended" file still gives a
     * usable instance that serves the forecast fallback.
     */
    public static function load(?string $path = null): self
    {
        $path ??= base_path('ml/heat_model.json');

        if (! is_file($path)) {
            return new self(null);
        }

        try {
            $model = json_decode((string) file_get_contents($path), true, 512, JSON_THROW_ON_ERROR);
        } catch (Throwable) {
            return new self(null);
        }

        return new self(is_array($model) && ($model['recommended'] ?? false) === true && self::isValid($model) ? $model : null);
    }

    /** An instance without a model: forecast() serves only the forecast heat index. */
    public static function fallback(): self
    {
        return new self(null);
    }

    /** Load regardless of the "recommended" flag (parity test only). */
    public static function loadForTesting(string $path): self
    {
        $model = json_decode((string) file_get_contents($path), true);

        return new self(is_array($model) && self::isValid($model) ? $model : null);
    }

    /** True when a trained model (not only the fallback) is loaded. */
    public function hasModel(): bool
    {
        return $this->model !== null;
    }

    /**
     * Query for a SEPARATE Open-Meteo /v1/forecast request. Not merged into
     * WeatherService::forecastQuery(): past_hours shifts the hourly arrays that the rain
     * lookahead reads from index 0.
     *
     * @return array<string, mixed>
     */
    public static function queryParams(float $lat, float $lng): array
    {
        return [
            'latitude' => $lat,
            'longitude' => $lng,
            'hourly' => 'temperature_2m,relative_humidity_2m,dew_point_2m,cloud_cover,wind_speed_10m,pressure_msl,precipitation,shortwave_radiation',
            'past_hours' => 4,
            'forecast_hours' => 5,
            'timezone' => self::TIMEZONE,
        ];
    }

    /**
     * Heat index for 1, 2 and 3 hours after the current hour.
     *
     * @param  array<string, mixed>  $payload  decoded /v1/forecast response (queryParams())
     * @param  array<string, float|int>|null  $thresholds  category bounds (config weather.heat_categories)
     * @return array{source: string|null, items: list<array{hours_ahead: int, at: string, heat_index_c: float, category: string, source: string}>}
     */
    public function forecast(array $payload, ?DateTimeImmutable $now = null, ?array $thresholds = null): array
    {
        $base = $this->baseHour($now);
        $hourly = $this->indexByTime($payload['hourly'] ?? null) ?? [];
        $features = $this->model === null ? null : $this->featuresFromPayload($payload, $base);

        $items = [];
        $sources = [];
        foreach ([1, 2, 3] as $hoursAhead) {
            $at = $base->modify("+{$hoursAhead} hours");
            $value = $features === null ? null : $this->score($features, $hoursAhead);
            $source = 'model';

            if ($value === null) {
                $value = $this->forecastHeatIndex($hourly, $at);
                $source = 'forecast';
            }

            if ($value === null) {
                continue;
            }

            $rounded = round($value, 1);
            $items[] = [
                'hours_ahead' => $hoursAhead,
                'at' => $at->format(DATE_ATOM),
                'heat_index_c' => $rounded,
                'category' => HeatIndex::category($rounded, $thresholds),
                'source' => $source,
            ];
            $sources[$source] = true;
        }

        return [
            'source' => $items === [] ? null : (isset($sources['forecast']) ? (isset($sources['model']) ? 'mixed' : 'forecast') : 'model'),
            'items' => $items,
        ];
    }

    /**
     * Ridge prediction for one horizon, or null when that horizon or a feature is missing.
     *
     * @param  array<string, float>  $features
     */
    public function score(array $features, int $hoursAhead): ?float
    {
        $horizon = $this->model['per_horizon'][(string) $hoursAhead] ?? null;
        if (! is_array($horizon)) {
            return null;
        }

        $value = (float) $horizon['intercept'];
        foreach ($this->model['features'] as $i => $name) {
            if (! isset($features[$name]) || ! is_finite($features[$name])) {
                return null;
            }
            $scale = (float) $horizon['scale'][$i];
            $value += (float) $horizon['coef'][$i] * (($features[$name] - (float) $horizon['mean'][$i]) / ($scale ?: 1.0));
        }

        return $value;
    }

    /**
     * Mirror of ml/heat_common.py::build_heat_features() for the hour containing $now.
     *
     * @param  array<string, mixed>  $payload
     * @return array<string, float>|null null when any feature the model needs is missing
     */
    public function featuresFromPayload(array $payload, ?DateTimeImmutable $now = null): ?array
    {
        if ($this->model === null) {
            return null;
        }

        $h = $this->indexByTime($payload['hourly'] ?? null);
        if ($h === null) {
            return null;
        }

        $t = $this->baseHour($now);
        $at = fn (string $var, int $hoursBack): ?float => $this->num($h[$var][$t->modify("-{$hoursBack} hours")->format(self::KEY)] ?? null);
        $heatAt = function (int $hoursBack) use ($at): ?float {
            $temperature = $at('temperature_2m', $hoursBack);
            $humidity = $at('relative_humidity_2m', $hoursBack);

            return ($temperature === null || $humidity === null) ? null : HeatIndex::celsius($temperature, $humidity);
        };

        $temp = $at('temperature_2m', 0);
        $temp1 = $at('temperature_2m', 1);
        $temp3 = $at('temperature_2m', 3);
        $hi = $heatAt(0);
        $hi1 = $heatAt(1);
        $hi3 = $heatAt(3);
        $hour = (int) $t->format('G');
        $month = (int) $t->format('n');

        $all = [
            'temp' => $temp,
            'humidity' => $at('relative_humidity_2m', 0),
            'dew_point' => $at('dew_point_2m', 0),
            'heat_index' => $hi,
            'temp_change_1h' => ($temp !== null && $temp1 !== null) ? $temp - $temp1 : null,
            'temp_change_3h' => ($temp !== null && $temp3 !== null) ? $temp - $temp3 : null,
            'hi_change_1h' => ($hi !== null && $hi1 !== null) ? $hi - $hi1 : null,
            'hi_change_3h' => ($hi !== null && $hi3 !== null) ? $hi - $hi3 : null,
            'cloud_cover' => $at('cloud_cover', 0),
            'wind_speed' => $at('wind_speed_10m', 0),
            'pressure' => $at('pressure_msl', 0),
            'radiation' => $at('shortwave_radiation', 0),
            'hour_sin' => sin(2 * M_PI * $hour / 24.0),
            'hour_cos' => cos(2 * M_PI * $hour / 24.0),
            'hour2_sin' => sin(4 * M_PI * $hour / 24.0),
            'hour2_cos' => cos(4 * M_PI * $hour / 24.0),
            'month_sin' => sin(2 * M_PI * ($month - 1) / 12.0),
            'month_cos' => cos(2 * M_PI * ($month - 1) / 12.0),
        ];

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
     * @param  array<string, mixed>  $model
     */
    private static function isValid(array $model): bool
    {
        if (! isset($model['features'], $model['per_horizon']) || ! is_array($model['features']) || ! is_array($model['per_horizon'])) {
            return false;
        }

        $count = count($model['features']);
        foreach ($model['per_horizon'] as $horizon) {
            if (! is_array($horizon) || ! isset($horizon['mean'], $horizon['scale'], $horizon['coef'], $horizon['intercept'])
                || count($horizon['mean']) !== $count || count($horizon['scale']) !== $count || count($horizon['coef']) !== $count) {
                return false;
            }
        }

        return $count > 0;
    }

    /**
     * Heat index from the provider's forecast temperature and humidity at one hour.
     *
     * @param  array<string, array<string, mixed>>  $hourly
     */
    private function forecastHeatIndex(array $hourly, DateTimeImmutable $at): ?float
    {
        $key = $at->format(self::KEY);
        $temperature = $this->num($hourly['temperature_2m'][$key] ?? null);
        $humidity = $this->num($hourly['relative_humidity_2m'][$key] ?? null);

        return ($temperature === null || $humidity === null) ? null : HeatIndex::celsius($temperature, $humidity);
    }

    /** The current hour in campus time (hourly values are stamped on the hour). */
    private function baseHour(?DateTimeImmutable $now): DateTimeImmutable
    {
        $tz = new DateTimeZone(self::TIMEZONE);
        // Carbon::now() so tests can travel in time; a plain DateTimeImmutable otherwise.
        $now = ($now ?? Carbon::now()->toDateTimeImmutable())->setTimezone($tz);

        return $now->setTime((int) $now->format('G'), 0, 0);
    }

    /**
     * Turn {"time": [...], "var": [...]} into ["var" => ["2026-10-31T10:00" => value]].
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
