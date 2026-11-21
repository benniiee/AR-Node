<?php

namespace Tests\Feature;

use App\Models\Node;
use App\Models\NodeLink;
use App\Models\Pathway;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

class PathwayTest extends TestCase
{
    use RefreshDatabase;

    /** ~49 m due east along the equator-ish campus latitude. */
    private function line(): array
    {
        return [
            ['lat' => 6.9130, 'lng' => 122.0610],
            ['lat' => 6.9130, 'lng' => 122.06144],
        ];
    }

    public function test_admin_can_save_a_road_copied_from_the_base_map(): void
    {
        Sanctum::actingAs(User::factory()->create(['role' => 'admin']));

        $this->postJson('/api/pathways', [
            'name' => 'Normal Road',
            'kind' => 'road',
            'coordinates' => $this->line(),
            'source' => 'osm',
            'osm_ref' => 'r42',
        ])->assertCreated()->assertJsonPath('kind', 'road')->assertJsonPath('name', 'Normal Road');
    }

    public function test_pathway_needs_two_points_and_a_known_kind(): void
    {
        Sanctum::actingAs(User::factory()->create(['role' => 'admin']));

        $this->postJson('/api/pathways', ['kind' => 'tunnel', 'coordinates' => [$this->line()[0]]])
            ->assertUnprocessable()
            ->assertInvalid(['kind', 'coordinates']);
    }

    public function test_faculty_cannot_write_pathways(): void
    {
        $pathway = Pathway::factory()->create();
        Sanctum::actingAs(User::factory()->create(['role' => 'faculty']));

        $this->getJson('/api/pathways')->assertOk()->assertJsonCount(1);
        $this->postJson('/api/pathways', ['coordinates' => $this->line()])->assertForbidden();
        $this->putJson("/api/pathways/{$pathway->id}", ['name' => 'X'])->assertForbidden();
        $this->deleteJson("/api/pathways/{$pathway->id}")->assertForbidden();
        $this->postJson("/api/pathways/{$pathway->id}/clear-route-nodes")->assertForbidden();
    }

    public function test_clearing_a_pathway_removes_only_the_route_nodes_along_it(): void
    {
        Sanctum::actingAs(User::factory()->create(['role' => 'admin']));
        $pathway = Pathway::factory()->create(['kind' => 'walkway', 'coordinates' => $this->line()]);
        $route = fn (array $extra) => Node::create($extra + ['type' => 'route', 'floor_level' => 0, 'path_type' => 'outside', 'latitude' => 6.91301, 'longitude' => 122.0612]);

        $along = $route([]);                                             // ~1 m off the line: a duplicate
        $far = $route(['latitude' => 6.9131]);                           // ~11 m away: kept
        $stairFoot = $route(['longitude' => 122.0614]);                  // on the line but a staircase end: kept
        $upstairs = $route(['floor_level' => 1, 'longitude' => 122.0614]);
        NodeLink::create(['node_a_id' => $stairFoot->id, 'node_b_id' => $upstairs->id, 'kind' => 'stairs']);
        $room = $route(['type' => 'location', 'name' => 'Office', 'longitude' => 122.0613]); // a destination: kept

        $this->postJson("/api/pathways/{$pathway->id}/clear-route-nodes")->assertOk()->assertJsonPath('deleted', 1);

        $this->assertModelMissing($along);
        foreach ([$far, $stairFoot, $upstairs, $room] as $kept) {
            $this->assertModelExists($kept);
        }
    }

    public function test_map_data_includes_pathways(): void
    {
        // The full map and routing are for signed-in members (visitors: buildings only).
        Sanctum::actingAs(User::factory()->student()->create());
        Pathway::factory()->create(['name' => 'Covered Walk', 'kind' => 'covered']);

        $this->getJson('/api/map-data')
            ->assertOk()
            ->assertJsonPath('pathways.0.name', 'Covered Walk')
            ->assertJsonPath('pathways.0.kind', 'covered')
            ->assertJsonCount(2, 'pathways.0.coordinates');
    }

    public function test_admins_set_a_pathways_real_width_and_the_map_feed_carries_it(): void
    {
        $road = Pathway::factory()->create(['kind' => 'road']);
        Sanctum::actingAs(User::factory()->create(['role' => 'admin']));

        $this->putJson("/api/pathways/{$road->id}", ['width_m' => 6.5])->assertOk()->assertJsonPath('width_m', 6.5);
        $this->getJson('/api/map-data')->assertJsonPath('pathways.0.width_m', 6.5);

        // 1 to 30 m; blank goes back to the usual width for its kind.
        $this->putJson("/api/pathways/{$road->id}", ['width_m' => 0])->assertUnprocessable()->assertInvalid(['width_m']);
        $this->putJson("/api/pathways/{$road->id}", ['width_m' => 50])->assertUnprocessable()->assertInvalid(['width_m']);
        $this->putJson("/api/pathways/{$road->id}", ['width_m' => null])->assertOk()->assertJsonPath('width_m', null);
    }
}
