<?php

namespace App\Models;

use Database\Factories\CampusAreaFactory;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;

/**
 * One named campus outline (Campus A, Campus B, ...), drawn by an admin.
 * Membership is by position: a node or building is on the campus whose
 * outline contains it (src/campusAreas.js does the same test on the phone).
 *
 * @property int $id
 * @property string $name
 * @property string $color
 * @property array<int, array{lat: float, lng: float}> $polygon
 */
class CampusArea extends Model
{
    /** @use HasFactory<CampusAreaFactory> */
    use HasFactory;

    protected $fillable = ['name', 'color', 'polygon'];

    /**
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return [
            'polygon' => 'array',
        ];
    }

    /**
     * Is this point inside the outline? Ray casting on lat/lng, exact enough at campus scale.
     */
    public function contains(float $lat, float $lng): bool
    {
        $ring = $this->polygon ?? [];
        $count = count($ring);
        $inside = false;

        for ($i = 0, $j = $count - 1; $i < $count; $j = $i++) {
            $yi = (float) $ring[$i]['lat'];
            $xi = (float) $ring[$i]['lng'];
            $yj = (float) $ring[$j]['lat'];
            $xj = (float) $ring[$j]['lng'];

            if ((($yi > $lat) !== ($yj > $lat)) && ($lng < ($xj - $xi) * ($lat - $yi) / ($yj - $yi) + $xi)) {
                $inside = ! $inside;
            }
        }

        return $inside;
    }
}
