<?php

namespace App\Models;

use Database\Factories\PathwayFactory;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * One road or walkway of the campus network, as a drawn polyline.
 */
class Pathway extends Model
{
    /** @use HasFactory<PathwayFactory> */
    use HasFactory;

    public const KINDS = ['road', 'walkway', 'covered'];

    protected $fillable = [
        'name',
        'kind',
        'status',
        'width_m',
        'coordinates',
        'source',
        'osm_ref',
    ];

    /**
     * @var array<string, mixed>
     */
    protected $attributes = [
        'kind' => 'walkway',
        'status' => 'existing',
        'source' => 'custom',
    ];

    /**
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return [
            'coordinates' => 'array',
            'width_m' => 'float',
        ];
    }

    public function creator(): BelongsTo
    {
        return $this->belongsTo(User::class, 'created_by');
    }

    /** Usual width in metres when a pathway has none of its own (same as src/campusGeometry.js). */
    public const DEFAULT_WIDTH_M = ['road' => 5.0, 'walkway' => 2.4, 'covered' => 2.4];

    /** How wide the pathway really is: its own width, else the usual one for its kind. */
    public function widthM(): float
    {
        return $this->width_m > 0 ? (float) $this->width_m : (self::DEFAULT_WIDTH_M[$this->kind] ?? self::DEFAULT_WIDTH_M['walkway']);
    }
}
