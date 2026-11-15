<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class Border extends Model
{
    protected $fillable = [
        'latitude',
        'longitude',
        'group_id',
    ];

    protected $casts = [
        'latitude' => 'float',
        'longitude' => 'float',
        'group_id' => 'integer',
        // Who drew the wall; set server-side, never mass-assignable.
        'created_by' => 'integer',
    ];
}
