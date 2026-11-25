<?php

namespace App\Models;

use Database\Factories\CampusObjectFactory;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;

/**
 * A thing placed on the campus besides buildings and paths: a tree (casts shade for heat routing),
 * a bench, a shed or a gate (an opening in a wall that routes pass through). Placed by an admin,
 * like a building in a city-builder game. src/campusObjects.js draws and uses them.
 *
 * @property int $id
 * @property string $kind
 * @property float $latitude
 * @property float $longitude
 * @property float $rotation_deg
 * @property float|null $height_m
 * @property float|null $width_m
 * @property float|null $length_m
 * @property string|null $form
 * @property int $seed
 */
class CampusObject extends Model
{
    /** @use HasFactory<CampusObjectFactory> */
    use HasFactory;

    /** The kinds of object (src/campusObjects.js OBJECT_KINDS). */
    public const KINDS = ['tree', 'bench', 'shed', 'gate'];

    /** A tree's shape (src/campusObjects.js TREE_FORMS). */
    public const TREE_FORMS = ['round', 'spreading', 'tall', 'palm'];

    protected $fillable = ['kind', 'latitude', 'longitude', 'rotation_deg', 'height_m', 'width_m', 'length_m', 'form', 'seed'];

    /**
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return [
            'latitude' => 'float',
            'longitude' => 'float',
            'rotation_deg' => 'float',
            'height_m' => 'float',
            'width_m' => 'float',
            'length_m' => 'float',
            'seed' => 'integer',
        ];
    }
}
