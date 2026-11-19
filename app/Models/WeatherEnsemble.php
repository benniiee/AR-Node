<?php

namespace App\Models;

use Database\Factories\WeatherEnsembleFactory;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;

/**
 * One refresh's summary of the ensemble forecasts for campus (WeatherService::ensembleSummary()).
 *
 * @property Carbon $fetched_at
 * @property array<string, array{members: int, hours: list<array{at: string, wet_share: float, heavy_share: float, mean_mm: float, max_mm: float}>}> $models
 */
class WeatherEnsemble extends Model
{
    /** @use HasFactory<WeatherEnsembleFactory> */
    use HasFactory;

    protected $fillable = ['fetched_at', 'models'];

    protected function casts(): array
    {
        return [
            'fetched_at' => 'datetime',
            'models' => 'array',
        ];
    }
}
