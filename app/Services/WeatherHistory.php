<?php

namespace App\Services;

use App\Models\WeatherPrediction;
use DateTimeImmutable;
use DateTimeZone;
use Illuminate\Support\Carbon;
use Illuminate\Support\Collection;

/**
 * The real-world record of the rain and heat models.
 *
 * Every weather refresh saves its predictions (record()); later refreshes fill in
 * what the airport actually reported (fillOutcomes()). summary() turns a period into
 * the series, histograms and error figures shown on the admin Weather page and in the
 * ml/gui.py History section (via `php artisan weather:history`).
 */
class WeatherHistory
{
    /** Periods the dashboard offers, in days. */
    public const PERIODS = [1, 7, 30, 90];

    /** The rain question: rain at the airport this many minutes after the 15-minute step. */
    private const RAIN_HORIZON_MINUTES = 20;

    /** A report answers a target time when it is at most this far from it (the training label rule). */
    private const MATCH_MINUTES = 15;

    /** Wait this long after a target before judging it, so the report has arrived. */
    private const REPORT_DELAY_MINUTES = 25;

    /** Stop looking for outcomes after this; whatever is still null had no report. */
    private const GIVE_UP_HOURS = 8;

    /** Rain histogram: probability bands of this many percent. */
    private const RAIN_BIN = 10;

    /** Heat error histogram: bins of this many deg C, clamped to +-HEAT_ERROR_RANGE. */
    private const HEAT_BIN = 0.5;

    private const HEAT_ERROR_RANGE = 3.0;

    private const TIMEZONE = 'Asia/Manila';

    /**
     * Save one refresh.
     *
     * @param  array<string, mixed>  $state  the state WeatherService just cached
     * @param  list<array{hours_ahead: int, heat_index_c: float}>  $providerHeat  the provider's forecast heat index per horizon
     */
    public function record(array $state, ?int $providerProbability, ?float $alertThreshold, array $providerHeat, ?string $airportReport): WeatherPrediction
    {
        $provider = collect($providerHeat)->keyBy('hours_ahead');
        $heat = collect($state['heat_forecast'] ?? [])->map(fn (array $item): array => [
            'hours_ahead' => (int) $item['hours_ahead'],
            'at' => (string) $item['at'],
            'heat_index_c' => (float) $item['heat_index_c'],
            'provider_heat_index_c' => isset($provider[$item['hours_ahead']]) ? (float) $provider[$item['hours_ahead']]['heat_index_c'] : null,
        ])->values()->all();

        return WeatherPrediction::create([
            // In the app timezone: Eloquent stores a datetime's wall-clock time as it is.
            'predicted_at' => isset($state['fetched_at']) ? Carbon::parse($state['fetched_at'])->setTimezone(config('app.timezone')) : now(),
            'rain_probability' => $state['rain_probability'] ?? null,
            'probability_source' => $state['probability_source'] ?? null,
            'provider_probability' => $providerProbability,
            'alert_threshold' => ($state['probability_source'] ?? null) === 'model' ? $alertThreshold : null,
            'raining_now' => (bool) ($state['raining_now'] ?? false),
            'rain_mode' => (bool) ($state['rain_mode'] ?? false),
            'heat_index_c' => $state['heat_index_c'] ?? null,
            'heat_source' => $state['heat_forecast_source'] ?? null,
            'heat_forecast' => $heat === [] ? null : $heat,
            'airport_report' => $airportReport,
        ]);
    }

    /**
     * Fill in airport outcomes for recent rows from the reports just downloaded.
     *
     * @param  list<array{time: string, raw: string}>  $metars  campus-time reports (Metar::fromAviationWeather())
     * @return int rows updated
     */
    public function fillOutcomes(array $metars, ?Carbon $now = null): int
    {
        $now ??= now();
        $reports = $this->reportsByTimestamp($metars);
        $updated = 0;

        foreach (WeatherPrediction::query()->awaitingOutcomes($now->copy()->subHours(self::GIVE_UP_HOURS + 4))->get() as $row) {
            $due = fn (int $target): bool => $now->getTimestamp() >= $target + self::REPORT_DELAY_MINUTES * 60;

            $step = intdiv($row->predicted_at->getTimestamp(), 900) * 900;
            $rainTarget = $step + self::RAIN_HORIZON_MINUTES * 60;
            if ($row->rain_outcome === null && $due($rainTarget)) {
                $report = $this->nearest($reports, $rainTarget);
                $row->rain_outcome = $report === null ? null : Metar::flags($report)['rain'] > 0;
            }

            $outcomes = $row->heat_outcomes ?? [];
            $lastTarget = $rainTarget;
            foreach ($row->heat_forecast ?? [] as $item) {
                $target = Carbon::parse($item['at'])->getTimestamp();
                $lastTarget = max($lastTarget, $target);
                $key = (string) $item['hours_ahead'];
                if (($outcomes[$key] ?? null) === null && $due($target)) {
                    $report = $this->nearest($reports, $target);
                    $outcomes[$key] = $report === null ? null : Metar::heatIndex($report);
                }
            }
            if ($outcomes !== []) {
                $row->heat_outcomes = $outcomes;
            }

            $tooOld = $row->predicted_at->lt($now->copy()->subHours(self::GIVE_UP_HOURS));
            if ($due($lastTarget) || $tooOld) {
                $row->outcomes_settled_at = $now;
            }

            if ($row->isDirty()) {
                $row->save();
                $updated++;
            }
        }

        return $updated;
    }

    /**
     * Everything the dashboard draws for the last $days days.
     *
     * @return array<string, mixed>
     */
    public function summary(int $days): array
    {
        $tz = new DateTimeZone(self::TIMEZONE);
        $to = now();
        $rows = WeatherPrediction::query()->since($to->copy()->subDays($days))->get();
        $local = fn ($time): string => DateTimeImmutable::createFromInterface($time)->setTimezone($tz)->format(DATE_ATOM);

        return [
            'period' => ['days' => $days, 'from' => $local($to->copy()->subDays($days)), 'to' => $local($to)],
            'timezone' => self::TIMEZONE,
            'count' => $rows->count(),
            'rain' => $this->rainSummary($rows, $local),
            'heat' => $this->heatSummary($rows, $local),
            'recent' => $rows->reverse()->take(30)->values()->map(fn (WeatherPrediction $row): array => [
                'time' => $local($row->predicted_at),
                'rain_probability' => $row->rain_probability,
                'probability_source' => $row->probability_source,
                'provider_probability' => $row->provider_probability,
                'rain_mode' => $row->rain_mode,
                'raining_now' => $row->raining_now,
                // What it did to routing at that refresh: closed / covered / watch / off.
                'rain_effect' => WeatherService::rainEffect(
                    (bool) $row->raining_now, (bool) $row->rain_mode,
                    $row->rain_probability === null ? null : (int) $row->rain_probability, $row->probability_source,
                    (float) config('weather.rain_penalty'), (int) config('weather.model_ramp_from', 10), (int) config('weather.model_ramp_to', 50),
                ),
                'rain_outcome' => $row->rain_outcome,
                'heat_index_c' => $row->heat_index_c,
                'heat_plus1' => $this->horizon($row, 1)['heat_index_c'] ?? null,
                'heat_plus1_provider' => $this->horizon($row, 1)['provider_heat_index_c'] ?? null,
                'heat_plus1_observed' => $row->heat_outcomes['1'] ?? null,
                // Same rule the routing used at that refresh (WeatherService::resolveHeatMode).
                'heat_mode' => WeatherService::resolveHeatMode(
                    $row->heat_index_c === null ? null : (float) $row->heat_index_c,
                    (float) config('weather.heat_mode_c', 40),
                ),
                'heat_mode_c' => (float) config('weather.heat_mode_c', 40),
            ])->all(),
        ];
    }

    /**
     * @param  Collection<int, WeatherPrediction>  $rows
     * @return array<string, mixed>
     */
    private function rainSummary(Collection $rows, callable $local): array
    {
        $bins = [];
        for ($from = 0; $from < 100; $from += self::RAIN_BIN) {
            $bins[] = ['from' => $from, 'to' => $from + self::RAIN_BIN, 'rained' => 0, 'dry' => 0, 'unchecked' => 0];
        }

        $model = $rows->filter(fn (WeatherPrediction $r): bool => $r->probability_source === 'model' && $r->rain_probability !== null);
        foreach ($model as $row) {
            $i = min(count($bins) - 1, intdiv($row->rain_probability, self::RAIN_BIN));
            $bins[$i][$row->rain_outcome === null ? 'unchecked' : ($row->rain_outcome ? 'rained' : 'dry')]++;
        }

        $checked = $model->filter(fn (WeatherPrediction $r): bool => $r->rain_outcome !== null);
        $brier = fn (Collection $set, string $field): ?float => $set->isEmpty() ? null
            : round($set->avg(fn (WeatherPrediction $r): float => ($r->{$field} / 100 - ($r->rain_outcome ? 1 : 0)) ** 2), 4);
        $withProvider = $checked->filter(fn (WeatherPrediction $r): bool => $r->provider_probability !== null);
        $rainy = $checked->filter(fn (WeatherPrediction $r): bool => $r->rain_outcome === true);

        return [
            'series' => $rows->map(fn (WeatherPrediction $r): array => [
                't' => $local($r->predicted_at),
                'model' => $r->probability_source === 'model' ? $r->rain_probability : null,
                'provider' => $r->provider_probability,
                'outcome' => $r->rain_outcome,
                'rain_mode' => $r->rain_mode,
            ])->values()->all(),
            'histogram' => $bins,
            'stats' => [
                'predictions' => $rows->count(),
                'model_predictions' => $model->count(),
                'checked' => $checked->count(),
                'rain_reports' => $rainy->count(),
                'caught' => $rainy->filter(fn (WeatherPrediction $r): bool => $r->rain_mode)->count(),
                'brier_model' => $brier($checked, 'rain_probability'),
                'brier_provider' => $brier($withProvider, 'provider_probability'),
                'rain_mode_share' => $rows->isEmpty() ? null : round($rows->where('rain_mode', true)->count() / $rows->count(), 3),
                'alert_threshold' => $model->last()?->alert_threshold,
                // The campus model's chance starts to raise the cost of outdoor paths above cost_from %, fully at cost_to %.
                'cost_from' => (int) config('weather.model_ramp_from', 10),
                'cost_to' => (int) config('weather.model_ramp_to', 50),
            ],
        ];
    }

    /**
     * @param  Collection<int, WeatherPrediction>  $rows
     * @return array<string, mixed>
     */
    private function heatSummary(Collection $rows, callable $local): array
    {
        $edges = range(-self::HEAT_ERROR_RANGE, self::HEAT_ERROR_RANGE - self::HEAT_BIN, self::HEAT_BIN);
        $bins = array_map(fn (float $from): array => ['from' => $from, 'to' => $from + self::HEAT_BIN, 'model' => 0, 'provider' => 0], $edges);
        $binOf = fn (float $error): int => max(0, min(count($bins) - 1, (int) floor(($error + self::HEAT_ERROR_RANGE) / self::HEAT_BIN)));

        $series = [];
        $errors = [1 => ['model' => [], 'provider' => []], 2 => ['model' => [], 'provider' => []], 3 => ['model' => [], 'provider' => []]];
        foreach ($rows as $row) {
            $plus1 = $this->horizon($row, 1);
            if ($plus1 !== null) {
                $series[] = [
                    't' => $local(Carbon::parse($plus1['at'])),
                    'model' => $plus1['heat_index_c'],
                    'provider' => $plus1['provider_heat_index_c'] ?? null,
                    'observed' => $row->heat_outcomes['1'] ?? null,
                ];
            }
            foreach ([1, 2, 3] as $h) {
                $item = $this->horizon($row, $h);
                $observed = $row->heat_outcomes[(string) $h] ?? null;
                if ($item === null || $observed === null) {
                    continue;
                }
                $errors[$h]['model'][] = $item['heat_index_c'] - $observed;
                if (($item['provider_heat_index_c'] ?? null) !== null) {
                    $errors[$h]['provider'][] = $item['provider_heat_index_c'] - $observed;
                }
                if ($h === 1) {
                    $bins[$binOf($item['heat_index_c'] - $observed)]['model']++;
                    if (($item['provider_heat_index_c'] ?? null) !== null) {
                        $bins[$binOf($item['provider_heat_index_c'] - $observed)]['provider']++;
                    }
                }
            }
        }

        $mae = fn (array $e): ?float => $e === [] ? null : round(array_sum(array_map('abs', $e)) / count($e), 2);
        $bias = fn (array $e): ?float => $e === [] ? null : round(array_sum($e) / count($e), 2);

        return [
            'series' => $series,
            'histogram' => $bins,
            'histogram_range' => self::HEAT_ERROR_RANGE,
            'stats' => [
                'predictions' => count($series),
                'horizons' => collect([1, 2, 3])->map(fn (int $h): array => [
                    'hours_ahead' => $h,
                    'checked' => count($errors[$h]['model']),
                    'mae_model' => $mae($errors[$h]['model']),
                    'mae_provider' => $mae($errors[$h]['provider']),
                    'bias_model' => $bias($errors[$h]['model']),
                    'bias_provider' => $bias($errors[$h]['provider']),
                ])->all(),
            ],
        ];
    }

    /** @return array<string, mixed>|null */
    private function horizon(WeatherPrediction $row, int $hours): ?array
    {
        foreach ($row->heat_forecast ?? [] as $item) {
            if ((int) $item['hours_ahead'] === $hours) {
                return $item;
            }
        }

        return null;
    }

    /**
     * @param  list<array{time: string, raw: string}>  $metars
     * @return array<int, string> unix time => raw report
     */
    private function reportsByTimestamp(array $metars): array
    {
        $tz = new DateTimeZone(self::TIMEZONE);
        $out = [];
        foreach ($metars as $report) {
            $time = DateTimeImmutable::createFromFormat('!Y-m-d\TH:i', (string) ($report['time'] ?? ''), $tz);
            if ($time !== false) {
                $out[$time->getTimestamp()] = (string) ($report['raw'] ?? '');
            }
        }

        return $out;
    }

    /**
     * The report nearest to $target within MATCH_MINUTES, or null.
     *
     * @param  array<int, string>  $reports
     */
    private function nearest(array $reports, int $target): ?string
    {
        $best = null;
        $bestGap = self::MATCH_MINUTES * 60 + 1;
        foreach ($reports as $stamp => $raw) {
            $gap = abs($stamp - $target);
            if ($gap < $bestGap) {
                [$best, $bestGap] = [$raw, $gap];
            }
        }

        return $best;
    }
}
