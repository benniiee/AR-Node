<?php

namespace App\Models;

use Database\Factories\WeatherPredictionFactory;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Prunable;
use Illuminate\Support\Carbon;

/**
 * One weather refresh: the rain and heat predictions and, later, what the airport reported.
 *
 * @property Carbon $predicted_at
 * @property int|null $rain_probability
 * @property string|null $probability_source
 * @property int|null $provider_probability
 * @property float|null $alert_threshold
 * @property bool $raining_now
 * @property bool $rain_mode
 * @property float|null $heat_index_c
 * @property string|null $heat_source
 * @property list<array{hours_ahead: int, at: string, heat_index_c: float, provider_heat_index_c: float|null}>|null $heat_forecast
 * @property string|null $airport_report
 * @property bool|null $rain_outcome
 * @property array<string, float|null>|null $heat_outcomes
 * @property Carbon|null $outcomes_settled_at
 */
class WeatherPrediction extends Model
{
    /** @use HasFactory<WeatherPredictionFactory> */
    use HasFactory, Prunable;

    /** Days of history kept (model:prune deletes older rows). */
    public const KEEP_DAYS = 180;

    protected $fillable = [
        'predicted_at', 'rain_probability', 'probability_source', 'provider_probability', 'alert_threshold',
        'raining_now', 'rain_mode', 'heat_index_c', 'heat_source', 'heat_forecast', 'airport_report',
        'rain_outcome', 'heat_outcomes', 'outcomes_settled_at',
    ];

    protected function casts(): array
    {
        return [
            'predicted_at' => 'datetime',
            'rain_probability' => 'integer',
            'provider_probability' => 'integer',
            'alert_threshold' => 'float',
            'raining_now' => 'boolean',
            'rain_mode' => 'boolean',
            'heat_index_c' => 'float',
            'heat_forecast' => 'array',
            'rain_outcome' => 'boolean',
            'heat_outcomes' => 'array',
            'outcomes_settled_at' => 'datetime',
        ];
    }

    /** @param Builder<self> $query */
    public function scopeSince(Builder $query, Carbon $from): void
    {
        $query->where('predicted_at', '>=', $from)->orderBy('predicted_at');
    }

    /**
     * Recent rows still waiting for an airport outcome.
     *
     * @param  Builder<self>  $query
     */
    public function scopeAwaitingOutcomes(Builder $query, Carbon $from): void
    {
        $query->whereNull('outcomes_settled_at')->where('predicted_at', '>=', $from)->orderBy('predicted_at');
    }

    /** @return Builder<self> */
    public function prunable(): Builder
    {
        return static::where('predicted_at', '<', now()->subDays(self::KEEP_DAYS));
    }
}
