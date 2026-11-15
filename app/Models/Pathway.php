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
        ];
    }

    public function creator(): BelongsTo
    {
        return $this->belongsTo(User::class, 'created_by');
    }

    /**
     * Route nodes laid along this pathway get the matching shelter label:
     * covered walkways are sheltered from rain, everything else is outside.
     */
    public function nodePathType(): string
    {
        return $this->kind === 'covered' ? 'inside' : 'outside';
    }
}
