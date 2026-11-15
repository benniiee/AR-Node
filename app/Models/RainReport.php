<?php

namespace App\Models;

use Database\Factories\RainReportFactory;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Prunable;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * One "It's raining here" tap. Kept as campus-level ground truth for checking (and later
 * training) the rain model, like the airport outcomes in WeatherPrediction.
 *
 * @property int $user_id
 * @property Carbon $created_at
 */
class RainReport extends Model
{
    /** @use HasFactory<RainReportFactory> */
    use HasFactory, Prunable;

    /** Same retention as the prediction history. */
    public const KEEP_DAYS = WeatherPrediction::KEEP_DAYS;

    protected $fillable = ['user_id'];

    /** @return BelongsTo<User, $this> */
    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }

    /** How many different people reported rain since $from. */
    public static function peopleSince(Carbon $from): int
    {
        return static::query()->where('created_at', '>=', $from)->distinct()->count('user_id');
    }

    /** @return Builder<self> */
    public function prunable(): Builder
    {
        return static::where('created_at', '<', now()->subDays(self::KEEP_DAYS));
    }
}
