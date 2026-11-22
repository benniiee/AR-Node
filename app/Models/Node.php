<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class Node extends Model
{
    protected $fillable = [
        'name',
        'type',
        'latitude',
        'longitude',
        'elevation',
        'floor_level',
        'path_type',
        // 'A' | 'B' — which campus the node sits on. Stored only; routing and
        // rendering ignore it (see the migration for why existing rows are 'A').
        'campus',
        'department_id',
        // Building the node is inside (null = outdoors / not filed).
        'building_id',
        // A place's own weekly hours (App\Services\OpeningHours); null = its building's.
        'opening_hours',
        // NOTE: created_by is deliberately NOT fillable — the controller sets
        // it server-side from the authenticated user on create, and nothing
        // may change it afterwards.
    ];

    protected $attributes = [
        // DB-level default too, but declared here so a freshly created model
        // reports 'A' in its own response instead of null — Eloquent does not
        // re-read column defaults after INSERT, which would otherwise make
        // the API say null while the row says 'A'.
        'campus' => 'A',
    ];

    protected $casts = [
        'opening_hours' => 'array',
        'latitude' => 'float',
        'longitude' => 'float',
        'elevation' => 'float',
        'floor_level' => 'integer',
        'building_id' => 'integer',
    ];

    /**
     * Department whose map label colour this node wears (null = placed
     * before departments existed).
     */
    public function department(): BelongsTo
    {
        return $this->belongsTo(Department::class);
    }

    /**
     * Building this node is inside (null = outdoors or not filed yet).
     */
    public function building(): BelongsTo
    {
        return $this->belongsTo(Building::class);
    }

    /**
     * Faculty member who placed this node (null = predates attribution).
     */
    public function creator(): BelongsTo
    {
        return $this->belongsTo(User::class, 'created_by');
    }

    /**
     * Check if this node is a place or room (i.e. a destination).
     */
    public function isDestination(): bool
    {
        return $this->type === 'location';
    }
}
