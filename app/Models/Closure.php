<?php

namespace App\Models;

use Database\Factories\ClosureFactory;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * A one-off change to opening hours (see the migration): closed, or a special opening, for a scope
 * from the whole school down to one place, between starts_at and ends_at. The phone applies them
 * on top of the weekly hours (src/openingHours.js).
 */
class Closure extends Model
{
    /** @use HasFactory<ClosureFactory> */
    use HasFactory;

    public const KINDS = ['closed', 'open'];

    protected $fillable = [
        'kind',
        'reason',
        'campus',
        'department_kind',
        'department_id',
        'building_id',
        'node_id',
        'starts_at',
        'ends_at',
        // created_by is set server-side.
    ];

    /**
     * @var array<string, mixed>
     */
    protected $attributes = [
        'kind' => 'closed',
    ];

    protected function casts(): array
    {
        return [
            'starts_at' => 'datetime',
            'ends_at' => 'datetime',
        ];
    }

    /** Still to come or going on now (an ended one no longer matters). */
    public function scopeCurrent(Builder $query): Builder
    {
        return $query->where('ends_at', '>', now());
    }

    /** True when it covers more than one department's places: only an admin posts these. */
    public function isSchoolLevel(): bool
    {
        return $this->department_id === null && $this->building_id === null && $this->node_id === null;
    }

    public function department(): BelongsTo
    {
        return $this->belongsTo(Department::class);
    }

    public function building(): BelongsTo
    {
        return $this->belongsTo(Building::class);
    }

    public function node(): BelongsTo
    {
        return $this->belongsTo(Node::class);
    }

    public function creator(): BelongsTo
    {
        return $this->belongsTo(User::class, 'created_by');
    }
}
