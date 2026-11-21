<?php

namespace Tests\Feature;

use App\Models\Node;
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
        $this->postJson("/api/pathways/{$pathway->id}/route-nodes")->assertForbidden();
    }

    public function test_route_nodes_are_laid_along_a_pathway_without_duplicates(): void
    {
        $admin = User::factory()->create(['role' => 'admin']);
        Sanctum::actingAs($admin);
        $pathway = Pathway::factory()->covered()->create(['coordinates' => $this->line()]);

        $first = $this->postJson("/api/pathways/{$pathway->id}/route-nodes", ['spacing_m' => 10])->assertCreated();

        // 0, 10, 20, 30, 40 m and the end point at ~49 m.
        $this->assertSame(6, $first->json('created'));
        $this->assertSame(6, Node::where('type', 'route')->where('path_type', 'inside')->where('created_by', $admin->id)->count());

        // Running it again finds every spot already taken.
        $this->postJson("/api/pathways/{$pathway->id}/route-nodes", ['spacing_m' => 10])
            ->assertCreated()
            ->assertJsonPath('created', 0);
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
