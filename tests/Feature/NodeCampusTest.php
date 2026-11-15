<?php

namespace Tests\Feature;

use App\Models\Node;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

class NodeCampusTest extends TestCase
{
    use RefreshDatabase;

    private function payload(array $overrides = []): array
    {
        return array_merge([
            'type' => 'route',
            'latitude' => 6.91010,
            'longitude' => 122.07130,
            'path_type' => 'outside',
        ], $overrides);
    }

    public function test_admin_can_create_a_node_on_campus_b(): void
    {
        Sanctum::actingAs(User::factory()->create(['role' => 'admin']));

        $response = $this->postJson('/api/nodes', $this->payload(['campus' => 'B']));

        $response->assertCreated();
        $response->assertJsonPath('campus', 'B');
        $this->assertDatabaseHas('nodes', ['id' => $response->json('id'), 'campus' => 'B']);
    }

    public function test_campus_defaults_to_a_when_omitted(): void
    {
        Sanctum::actingAs(User::factory()->create(['role' => 'admin']));

        // Older clients that never send the field keep working: the column
        // default fills it in rather than rejecting the request.
        $response = $this->postJson('/api/nodes', $this->payload());

        $response->assertCreated();
        $response->assertJsonPath('campus', 'A');
    }

    public function test_campus_must_be_a_or_b(): void
    {
        Sanctum::actingAs(User::factory()->create(['role' => 'admin']));

        $this->postJson('/api/nodes', $this->payload(['campus' => 'C']))
            ->assertUnprocessable()
            ->assertInvalid('campus');
    }

    public function test_campus_can_be_changed_on_update(): void
    {
        Sanctum::actingAs(User::factory()->create(['role' => 'admin']));
        $node = Node::create($this->payload(['campus' => 'A']));

        $this->putJson("/api/nodes/{$node->id}", ['campus' => 'B'])
            ->assertOk()
            ->assertJsonPath('campus', 'B');

        $this->assertDatabaseHas('nodes', ['id' => $node->id, 'campus' => 'B']);
    }

    public function test_campus_applies_to_locations_too(): void
    {
        Sanctum::actingAs(User::factory()->create(['role' => 'admin']));

        $response = $this->postJson('/api/nodes', $this->payload([
            'type' => 'location',
            'name' => 'Library',
            'campus' => 'B',
        ]));

        $response->assertCreated();
        $response->assertJsonPath('type', 'location');
        $response->assertJsonPath('campus', 'B');
    }

    public function test_public_map_feed_exposes_campus(): void
    {
        // The full map and routing are for signed-in members (visitors: buildings only).
        Sanctum::actingAs(User::factory()->student()->create());
        Node::create($this->payload(['campus' => 'B']));

        $nodes = $this->getJson('/api/map-data')->assertOk()->json('nodes');

        $this->assertNotEmpty($nodes);
        $this->assertArrayHasKey('campus', $nodes[0]);
        $this->assertSame('B', $nodes[0]['campus']);
    }

    public function test_all_existing_nodes_default_to_campus_a(): void
    {
        // The migration backfills every pre-existing row to 'A' so the column
        // is never null and callers need no null handling.
        $node = Node::create($this->payload());

        $this->assertSame('A', $node->fresh()->campus);
    }
}
