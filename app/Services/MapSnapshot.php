<?php

namespace App\Services;

use App\Models\Border;
use App\Models\Bridge;
use App\Models\Building;
use App\Models\CampusArea;
use App\Models\Closure;
use App\Models\Node;
use App\Models\NodeLink;
use App\Models\Pathway;
use DateTimeImmutable;
use Illuminate\Support\Facades\Log;
use Throwable;

/**
 * The public map (nodes, staircases, borders) as one payload, shared by
 * GET /api/map-data and the static file storage/app/public/data/map.json, so
 * the two can never drift apart.
 *
 * The file adds two fields the API does not have:
 *  - hash: fingerprint of the content. `version` is only the newest updated_at,
 *    so deleting an older node does not change it; the hash does.
 *  - generated_at: when the file was written.
 */
class MapSnapshot
{
    public const FILE = 'map.json';

    public const WRITTEN = 'written';

    public const UNCHANGED = 'unchanged';

    public const FAILED = 'failed';

    /**
     * The payload /api/map-data has always returned.
     *
     * @return array<string, mixed>
     */
    public static function payload(): array
    {
        return self::fullPayload() + ['audience' => 'member'];
    }

    /**
     * What a visitor (not signed in) may see: the buildings and the outdoor network that leads to them
     * (roads and walkways, walls, outdoor route nodes such as a bridge's deck and stair feet, and the
     * staircases between those), so a visitor can be routed to a building. No offices, rooms or
     * anything inside a building. This is also the content of the public static file, which anyone
     * can download.
     *
     * @return array<string, mixed>
     */
    public static function visitorPayload(): array
    {
        $full = self::fullPayload();
        // Outdoor route nodes; the important places staff showed to visitors (is_public); and, to reach
        // those, the unnamed route nodes of their buildings. No other place, nothing else inside.
        $public = array_filter($full['nodes'], fn (array $n): bool => $n['type'] === 'location' && $n['is_public']);
        $withPublic = array_flip(array_filter(array_column($public, 'building_id'), fn ($id) => $id !== null));
        $outdoor = array_values(array_map(
            fn (array $n): array => $n['type'] === 'route' ? ['name' => null] + $n : $n,
            array_filter($full['nodes'], fn (array $n): bool => ($n['type'] === 'location' && $n['is_public'])
                || ($n['type'] === 'route' && ($n['building_id'] === null || isset($withPublic[$n['building_id']])))),
        ));
        $ids = array_flip(array_column($outdoor, 'id'));
        $links = array_values(array_filter($full['links'], fn (array $l): bool => isset($ids[$l['node_a_id']], $ids[$l['node_b_id']])));

        return [
            'version' => $full['version'],
            'nodes' => $outdoor,
            'links' => $links,
            'borders' => $full['borders'],
            'buildings' => $full['buildings'],
            'pathways' => $full['pathways'],
            // Campus outlines and names are public, like the buildings; so are bridges (structures, not rooms).
            'campus_areas' => $full['campus_areas'],
            'bridges' => $full['bridges'],
            // School, campus, department and building announcements are public like the buildings; a room's are not.
            'closures' => array_values(array_filter($full['closures'], fn (array $c): bool => $c['node_id'] === null)),
            'campus_hours' => $full['campus_hours'],
            'audience' => 'visitor',
        ];
    }

    /**
     * @return array<string, mixed>
     */
    private static function fullPayload(): array
    {
        $nodes = Node::with('department:id,name,kind,color')->get();
        $borders = Border::all();
        $links = NodeLink::orderBy('id')->get();
        $buildings = Building::with('department:id,name,kind,color')->orderBy('id')->get();
        // Closures and special openings now or in the next 60 days: the phone applies them, offline too.
        $closures = Closure::current()->where('starts_at', '<', now()->addDays(60))->orderBy('starts_at')->get();
        $pathways = Pathway::orderBy('id')->get();
        $areas = CampusArea::orderBy('name')->get();
        $bridges = Bridge::orderBy('id')->get();

        // A staircase edit changes routing, so it must bump the version too;
        // building labels and pathways change what the map shows.
        // max() returns the raw column value (a string), not a date: read it as a timestamp.
        $latest = fn (string $model): int => ($at = $model::max('updated_at')) ? (int) strtotime((string) $at) : 0;
        $version = max(array_map($latest, [
            Node::class, Border::class, NodeLink::class, Building::class, Pathway::class, CampusArea::class, Bridge::class, Closure::class,
        ]));

        return [...self::shape(
            $nodes->map(fn ($n) => [
                'id' => $n->id,
                'name' => $n->name,
                'type' => $n->type,
                'latitude' => $n->latitude,
                'longitude' => $n->longitude,
                'elevation' => $n->elevation,
                'floor_level' => $n->floor_level,
                'path_type' => $n->path_type,
                'campus' => $n->campus,
                'building_id' => $n->building_id,
                // The place's own hours (null: its building's, if any).
                'opening_hours' => $n->opening_hours,
                'is_public' => (bool) $n->is_public,
                // Department label colour. Creator names stay off the public
                // feed - the admin panel reads those from GET /api/nodes.
                'department' => $n->department ? [
                    'id' => $n->department->id,
                    'name' => $n->department->name,
                    'kind' => $n->department->kind,
                    'color' => $n->department->color,
                ] : null,
            ])->all(),
            $links->map(fn ($l) => [
                'id' => $l->id,
                'node_a_id' => $l->node_a_id,
                'node_b_id' => $l->node_b_id,
                'kind' => $l->kind,
                'angle_deg' => $l->angle_deg,
                'yaw_deg' => $l->yaw_deg,
                'flights' => $l->flights,
                'landing_m' => $l->landing_m,
            ])->all(),
            $borders->map(fn ($b) => [
                'group_id' => $b->group_id,
                'latitude' => $b->latitude,
                'longitude' => $b->longitude,
            ])->all(),
            (int) $version,
            $buildings->map(fn ($b) => [
                'id' => $b->id,
                'name' => $b->name,
                'short_name' => $b->short_name,
                'floors' => $b->floors,
                'height_m' => $b->height_m,
                'status' => $b->status,
                'category' => $b->category,
                'campus' => $b->campus,
                'polygon' => $b->polygon,
                'doors' => $b->doors ?? [],
                'opening_hours' => $b->opening_hours,
                // Outline + label dot use the department colour, like nodes.
                'department' => $b->department ? [
                    'id' => $b->department->id,
                    'name' => $b->department->name,
                    'kind' => $b->department->kind,
                    'color' => $b->department->color,
                ] : null,
            ])->all(),
            $pathways->map(fn ($p) => [
                'id' => $p->id,
                'name' => $p->name,
                'kind' => $p->kind,
                'status' => $p->status,
                'width_m' => $p->width_m,
                'coordinates' => $p->coordinates,
            ])->all(),
            $areas->map(fn (CampusArea $a) => [
                'id' => $a->id,
                'name' => $a->name,
                'color' => $a->color,
                'polygon' => $a->polygon,
            ])->all(),
            $bridges->map(fn (Bridge $b) => [
                'id' => $b->id,
                'name' => $b->name,
                'short_name' => $b->short_name,
                'kind' => $b->kind,
                'polygon' => $b->polygon,
                'centre_line' => $b->centre_line,
                'doors' => $b->doors ?? [],
                'deck_floor' => $b->deck_floor,
                'deck_height_m' => $b->deck_height_m,
                'roofed' => $b->roofed,
                'status' => $b->status,
                'closed' => $b->closed,
                'closed_reason' => $b->closed_reason,
            ])->all(),
        ), 'closures' => $closures->map(fn (Closure $c) => [
            'id' => $c->id,
            'kind' => $c->kind,
            'reason' => $c->reason,
            'campus' => $c->campus,
            'building_category' => $c->building_category,
            'department_id' => $c->department_id,
            'building_id' => $c->building_id,
            'node_id' => $c->node_id,
            'starts_at' => $c->starts_at->toIso8601String(),
            'ends_at' => $c->ends_at->toIso8601String(),
        ])->all(), 'campus_hours' => self::campusHours()];
    }

    /**
     * When /map can be used (config/campus.php): outside these hours the campus is closed.
     *
     * @return array{opens: string, closes: string}
     */
    private static function campusHours(): array
    {
        return ['opens' => (string) config('campus.opens_at'), 'closes' => (string) config('campus.closes_at')];
    }

    /**
     * Pure assembly of the payload from plain arrays (unit-testable without a database).
     *
     * @param  list<array<string, mixed>>  $nodes
     * @param  list<array<string, mixed>>  $links
     * @param  list<array{group_id: mixed, latitude: mixed, longitude: mixed}>  $borderRows  in database order
     * @param  list<array<string, mixed>>  $buildings
     * @param  list<array<string, mixed>>  $pathways
     * @param  list<array<string, mixed>>  $campusAreas
     * @param  list<array<string, mixed>>  $bridges
     * @return array<string, mixed>
     */
    public static function shape(array $nodes, array $links, array $borderRows, int $version, array $buildings = [], array $pathways = [], array $campusAreas = [], array $bridges = []): array
    {
        $groups = [];

        foreach ($borderRows as $row) {
            $id = (int) $row['group_id'];
            $groups[$id]['group_id'] = $id;
            $groups[$id]['coordinates'][] = ['lat' => $row['latitude'], 'lng' => $row['longitude']];
        }

        return [
            'version' => $version,
            'nodes' => array_values($nodes),
            'links' => array_values($links),
            'borders' => array_values($groups),
            'buildings' => array_values($buildings),
            'pathways' => array_values($pathways),
            'campus_areas' => array_values($campusAreas),
            'bridges' => array_values($bridges),
        ];
    }

    /**
     * The file content: the payload plus hash and generated_at.
     *
     * @param  array<string, mixed>  $payload
     * @return array<string, mixed>
     */
    public static function snapshot(array $payload): array
    {
        $hash = substr(sha1((string) json_encode([
            $payload['nodes'], $payload['links'], $payload['borders'],
            $payload['buildings'] ?? [], $payload['pathways'] ?? [], $payload['campus_areas'] ?? [], $payload['audience'] ?? null,
            // Only when there are bridges, so an unchanged map keeps its old hash (phones do not re-download it).
            ...(($payload['bridges'] ?? []) === [] ? [] : [$payload['bridges']]),
            ...(($payload['closures'] ?? []) === [] ? [] : [$payload['closures']]),
            // Campus hours: a change reaches the phones' saved copies too.
            $payload['campus_hours'] ?? null,
        ])), 0, 16);

        return [
            'generated_at' => (new DateTimeImmutable)->format(DATE_ATOM),
            'hash' => $hash,
        ] + $payload;
    }

    /**
     * True when the file already holds this content, so rewriting it would only
     * change its Last-Modified for nothing.
     *
     * @param  array<string, mixed>|null  $current
     * @param  array<string, mixed>  $next
     */
    public static function isUnchanged(?array $current, array $next): bool
    {
        return is_array($current)
            && ($current['hash'] ?? null) === $next['hash']
            && ($current['version'] ?? null) === $next['version'];
    }

    /**
     * Rewrite map.json when (and only when) the map changed.
     *
     * @return self::WRITTEN|self::UNCHANGED|self::FAILED
     */
    public static function refresh(bool $force = false): string
    {
        try {
            // The static file is public (no sign-in), so it carries the
            // visitor view; the full map is only served by the API to members.
            $next = self::snapshot(self::visitorPayload());

            if (! $force && self::isUnchanged(PublicData::read(self::FILE), $next)) {
                return self::UNCHANGED;
            }

            return PublicData::write(self::FILE, $next) ? self::WRITTEN : self::FAILED;
        } catch (Throwable $exception) {
            Log::warning('Map snapshot failed.', ['error' => $exception->getMessage()]);

            return self::FAILED;
        }
    }

    /** A refresh is already queued for this request. */
    private static bool $queued = false;

    /**
     * Called from model events: refresh after the response is sent, so an admin
     * saving a node never waits for it. Once per request: laying 50 route nodes
     * along a road, or handing over a building with its rooms, saves many rows,
     * and each rebuild reads the whole map.
     */
    public static function refreshAfterResponse(): void
    {
        if (app()->runningUnitTests() || self::$queued) {
            return;
        }

        self::$queued = true;
        dispatch(function (): void {
            self::$queued = false;
            self::refresh();
        })->afterResponse();
    }
}
