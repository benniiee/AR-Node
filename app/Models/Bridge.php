<?php

namespace App\Models;

use App\Services\GeoPoints;
use Database\Factories\BridgeFactory;
use Illuminate\Database\Eloquent\Casts\Attribute;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Collection;

/**
 * A connector people walk through, such as the footbridge between the two campuses
 * (see the create_bridges_table migration). Mirrors Building: an outline plus a label.
 */
class Bridge extends Model
{
    /** @use HasFactory<BridgeFactory> */
    use HasFactory;

    /** Kinds of connector. Add a value (and its label in src/campusGeometry.js) for a new one. */
    public const KINDS = ['bridge'];

    /** Highest deck floor (0 = at ground level). */
    public const MAX_DECK_FLOOR = 5;

    /** Height limits (metres) for the optional measured deck height. */
    public const MAX_DECK_HEIGHT_M = 30;

    /** A storey's height when none is measured (the same 3.2 m as buildings on the maps). */
    public const STOREY_M = 3.2;

    protected $fillable = [
        'name',
        'short_name',
        'kind',
        'polygon',
        // Doors: points on the outline; routes get on and off the deck only through them.
        'doors',
        'deck_floor',
        'deck_height_m',
        'roofed',
        'status',
        // Closed by an admin (an event): routes do not cross it; the reason is shown to students.
        'closed',
        'closed_reason',
        'source',
        // created_by is set server-side, like on buildings.
    ];

    /** Sent with every bridge, so the maps draw the same walking line the route nodes are laid on. */
    protected $appends = ['centre_line'];

    /** @var array<string, mixed> */
    protected $attributes = [
        'kind' => 'bridge',
        'deck_floor' => 1,
        'roofed' => true,
        'status' => 'existing',
        'source' => 'custom',
    ];

    /**
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return [
            'polygon' => 'array',
            'doors' => 'array',
            'deck_floor' => 'integer',
            'deck_height_m' => 'float',
            'roofed' => 'boolean',
            'closed' => 'boolean',
        ];
    }

    public function creator(): BelongsTo
    {
        return $this->belongsTo(User::class, 'created_by');
    }

    /** @return Attribute<list<array{lat: float, lng: float}>, never> */
    protected function centreLine(): Attribute
    {
        return Attribute::get(fn (): array => $this->walkingLine());
    }

    /** Deck height above the ground (m): the measured one, else deck_floor x STOREY_M (src/campusGeometry.js bridgeDeckHeightM). */
    public function deckHeightM(): float
    {
        return $this->deck_height_m > 0 ? (float) $this->deck_height_m : $this->deck_floor * self::STOREY_M;
    }

    /**
     * Whether a point is on any bridge (inside its outline): its deck and the stair feet under it.
     * Admins manage the nodes and staircases there; everywhere else nodes belong to department staff.
     */
    public static function covers(float $lat, float $lng): bool
    {
        return static::all(['polygon'])->contains(fn (self $b): bool => GeoPoints::contains($b->polygon ?? [], $lat, $lng));
    }

    /** A node outside every building, on a bridge. */
    public static function holds(Node $node): bool
    {
        return $node->building_id === null && static::covers((float) $node->latitude, (float) $node->longitude);
    }

    /**
     * The nodes on the deck: inside its outline, in no building, and raised (any floor above the
     * ground) for a raised deck, or on the ground for a deck at ground level. Any raised floor,
     * not only deck_floor: a node typed in on another floor still sits on this bridge. Bridges
     * have no node column, so this is where they are (src/components/AdminMap.jsx onDeckOf).
     *
     * @return Collection<int, Node>
     */
    public function deckNodes(): Collection
    {
        $query = Node::whereNull('building_id');
        $this->deck_floor > 0 ? $query->where('floor_level', '>', 0) : $query->where('floor_level', 0);

        return $query->get()
            ->filter(fn (Node $n): bool => GeoPoints::contains($this->polygon ?? [], $n->latitude, $n->longitude))
            ->values();
    }

    /** Route nodes on a roofed deck are sheltered ("inside"), so rain routing prefers them. */
    public function nodePathType(): string
    {
        return $this->roofed ? 'inside' : 'outside';
    }

    /**
     * The deck's walking line: through the middle of the outline along its longest
     * direction, from one end to the other, 1 m short of each end. A footbridge is
     * a long, thin outline, so this is the line people walk along it.
     *
     * @return list<array{lat: float, lng: float}>
     */
    public function walkingLine(): array
    {
        $points = $this->polygon ?? [];
        if (count($points) < 3) {
            return [];
        }

        $lat0 = array_sum(array_column($points, 'lat')) / count($points);
        $lng0 = array_sum(array_column($points, 'lng')) / count($points);
        $mLat = 111_320.0;
        $mLng = 111_320.0 * cos(deg2rad($lat0));
        $local = array_map(fn (array $p): array => [((float) $p['lng'] - $lng0) * $mLng, ((float) $p['lat'] - $lat0) * $mLat], $points);

        // Longest direction: the principal axis of the corners.
        [$sxx, $syy, $sxy] = [0.0, 0.0, 0.0];
        foreach ($local as [$x, $y]) {
            $sxx += $x * $x;
            $syy += $y * $y;
            $sxy += $x * $y;
        }
        $angle = 0.5 * atan2(2 * $sxy, $sxx - $syy);
        [$ux, $uy] = [cos($angle), sin($angle)];
        $along = array_map(fn (array $p): float => $p[0] * $ux + $p[1] * $uy, $local);
        $from = min($along) + 1.0;
        $to = max($along) - 1.0;
        if ($to <= $from) {
            [$from, $to] = [($from + $to) / 2, ($from + $to) / 2];
        }

        $toLatLng = fn (float $t): array => ['lat' => round($lat0 + ($t * $uy) / $mLat, 7), 'lng' => round($lng0 + ($t * $ux) / $mLng, 7)];

        return GeoPoints::normalize([$toLatLng($from), $toLatLng($to)]);
    }
}
