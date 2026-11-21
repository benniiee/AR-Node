<?php

namespace App\Models;

use Database\Factories\ActivityLogFactory;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Prunable;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Http\Request;
use Illuminate\Support\Str;

/**
 * One line of the activity log (see the create_activity_logs_table migration).
 *
 * Admins read every row; department staff read the sign-ins of students in their
 * department's courses only (ActivityLogController).
 */
class ActivityLog extends Model
{
    /** @use HasFactory<ActivityLogFactory> */
    use HasFactory, Prunable;

    /** Same retention as rain reports and the prediction history. */
    public const KEEP_DAYS = WeatherPrediction::KEEP_DAYS;

    public const ROLES = ['admin', 'faculty', 'student', 'visitor'];

    /** What the public map may report for a visitor (POST /api/activity). */
    public const VISITOR_ACTIONS = [
        'map.opened' => 'Opened the map',
        'route.chosen' => 'Chose a route to',
        'route.3d' => 'Opened the 3D / AR view to',
        'route.model3d' => 'Opened the route in 3D to',
    ];

    public const UPDATED_AT = null;

    protected $fillable = ['user_id', 'role', 'name', 'course', 'year_level', 'department_id', 'action', 'summary', 'details', 'ip', 'user_agent'];

    protected function casts(): array
    {
        return ['details' => 'array', 'year_level' => 'integer'];
    }

    /** @return BelongsTo<Department, $this> */
    public function department(): BelongsTo
    {
        return $this->belongsTo(Department::class);
    }

    /**
     * Write one row for $user (null = a visitor), with the person snapshotted as they are now.
     *
     * @param  array<string, mixed>  $details
     */
    public static function record(Request $request, ?User $user, string $action, string $summary, array $details = []): self
    {
        return static::create([
            'user_id' => $user?->id,
            'role' => $user->role ?? 'visitor',
            'name' => $user?->name,
            'course' => $user?->isStudent() ? $user->course?->code : null,
            'year_level' => $user?->isStudent() ? $user->year_level : null,
            'department_id' => $user?->department_id,
            'action' => Str::limit($action, 120, ''),
            'summary' => Str::limit($summary, 255, ''),
            'details' => $details ?: null,
            'ip' => $request->ip(),
            'user_agent' => Str::limit((string) $request->userAgent(), 255, ''),
        ]);
    }

    /** @return Builder<self> */
    public function prunable(): Builder
    {
        return static::where('created_at', '<', now()->subDays(self::KEEP_DAYS));
    }
}
