<?php

namespace App\Models;

use Database\Factories\BuildingFactory;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

/**
 * A labelled campus building: outline, name and floor count.
 */
class Building extends Model
{
    /** @use HasFactory<BuildingFactory> */
    use HasFactory;

    public const STATUSES = ['existing', 'under_construction', 'planned'];

    public const SOURCES = ['osm', 'custom'];

    public const MAX_FLOORS = 50;

    /** Height limits (metres) for the optional measured height. */
    public const MIN_HEIGHT_M = 2;

    public const MAX_HEIGHT_M = 200;

    /** Most doors one building may have (mirrors MAX_DOORS in src/doors.js). */
    public const MAX_DOORS = 20;

    protected $fillable = [
        'name',
        'short_name',
        'floors',
        // Optional measured height (m); null = estimated from floors on the maps.
        'height_m',
        'status',
        'campus',
        'polygon',
        // Doors: points on the outline; routes enter and leave through them.
        'doors',
        // Weekly hours (App\Services\OpeningHours); null = no set hours.
        'opening_hours',
        'source',
        'osm_ref',
        'department_id',
        // created_by is set server-side, like on nodes.
    ];

    /**
     * Mirrors the column defaults so a freshly created model reports them.
     *
     * @var array<string, mixed>
     */
    protected $attributes = [
        'floors' => 1,
        'status' => 'existing',
        'campus' => 'A',
        'source' => 'custom',
    ];

    /**
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return [
            'floors' => 'integer',
            'height_m' => 'float',
            'polygon' => 'array',
            'doors' => 'array',
            'opening_hours' => 'array',
        ];
    }

    public function department(): BelongsTo
    {
        return $this->belongsTo(Department::class);
    }

    public function creator(): BelongsTo
    {
        return $this->belongsTo(User::class, 'created_by');
    }

    /**
     * Offices, rooms and hallway points inside this building.
     */
    public function nodes(): HasMany
    {
        return $this->hasMany(Node::class);
    }

    /**
     * Lowest valid floor_level: the ground floor (buildings record no basements).
     */
    public function lowestFloor(): int
    {
        return 0;
    }

    /**
     * Highest valid floor_level (ground is 0, so N floors end at N - 1).
     */
    public function highestFloor(): int
    {
        return max(0, $this->floors - 1);
    }

    public function hasFloor(int $floorLevel): bool
    {
        return $floorLevel >= $this->lowestFloor() && $floorLevel <= $this->highestFloor();
    }
}
