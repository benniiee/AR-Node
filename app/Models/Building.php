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

    /**
     * Building Studio: roof shapes (flat, hip, gable, shed, curved), what a roof is made of, the styles of
     * the front, the canopy's shape and what the doors are made of.
     */
    public const ROOF_STYLES = ['flat', 'hip', 'gable', 'shed', 'curved'];

    public const ROOF_MATERIALS = ['metal', 'tile', 'shingle', 'concrete'];

    public const FACADES = ['windows', 'arches', 'pillars', 'balcony', 'glass', 'louvres'];

    public const CANOPY_SHAPES = ['slab', 'curved'];

    public const DOOR_STYLES = ['glass', 'wood', 'sliding'];

    /** Individually placed Building Studio items (mirrors ITEM_TYPES in src/buildingAppearance.js). */
    public const ITEM_TYPES = [
        'window_standard', 'window_grille', 'window_awning', 'window_arch',
        'pillar_square', 'pillar_round', 'spandrel_ribbed', 'louvre_screen', 'balcony_parapet',
        'door_glass', 'door_wood', 'door_sliding', 'canopy_slab', 'canopy_curved', 'steps', 'ramp',
        'sign_board', 'banner',
        'ac_unit', 'planter', 'bunting', 'kiosk', 'bench', 'lamp', 'water_tank',
    ];

    /** Most individually placed items one building may have (mirrors MAX_ITEMS in src/buildingAppearance.js). */
    public const MAX_ITEMS = 80;

    /** The longest sign over the entrance. */
    public const SIGN_MAX = 60;

    /** A school building (classes: colleges, the high school) or an office building (cashier, registrar, canteen). */
    public const CATEGORIES = ['school', 'office'];

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
        // 'school' or 'office': follows the owning department's kind; an admin labels unowned ones.
        'category',
        'campus',
        'polygon',
        // Doors: points on the outline; routes enter and leave through them.
        'doors',
        // Weekly hours (App\Services\OpeningHours); null = no set hours.
        'opening_hours',
        // How it looks outside (Building Studio); null = the plain look.
        'appearance',
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
        'category' => 'school',
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
            'appearance' => 'array',
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
