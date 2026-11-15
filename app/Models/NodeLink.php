<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * One staircase between two nodes on different floors.
 */
class NodeLink extends Model
{
    public const MIN_ANGLE = 10;

    public const MAX_ANGLE = 80;

    public const MAX_FLIGHTS = 4;

    public const MIN_LANDING = 1.0;

    public const MAX_LANDING = 4.0;

    protected $fillable = ['node_a_id', 'node_b_id', 'kind', 'angle_deg', 'yaw_deg', 'flights', 'landing_m'];

    protected $attributes = [
        'kind' => 'stairs',
        'angle_deg' => 45,
        'landing_m' => 1.4,
    ];

    protected $casts = [
        'node_a_id' => 'integer',
        'node_b_id' => 'integer',
        'angle_deg' => 'float',
        'yaw_deg' => 'float',
        'flights' => 'array',
        'landing_m' => 'float',
    ];

    public function nodeA(): BelongsTo
    {
        return $this->belongsTo(Node::class, 'node_a_id');
    }

    public function nodeB(): BelongsTo
    {
        return $this->belongsTo(Node::class, 'node_b_id');
    }
}
