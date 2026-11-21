<?php

namespace Tests\Feature;

use App\Models\Bridge;
use App\Models\Node;
use App\Models\NodeLink;
use App\Models\User;
use App\Services\GeoPoints;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

class BridgeTest extends TestCase
{
    use RefreshDatabase;

    /** A deck about 30 m long (east-west) and 3 m wide. */
    private function deck(): array
    {
        return [
            ['lat' => 6.91300, 'lng' => 122.06100],
            ['lat' => 6.91300, 'lng' => 122.06127],
            ['lat' => 6.913027, 'lng' => 122.06127],
            ['lat' => 6.913027, 'lng' => 122.06100],
        ];
    }

    public function test_admin_can_label_a_raised_roofed_footbridge(): void
    {
        Sanctum::actingAs(User::factory()->create(['role' => 'admin']));

        $this->postJson('/api/bridges', [
            'name' => 'Campus A to B Footbridge',
            'short_name' => 'Footbridge',
            'polygon' => $this->deck(),
            'deck_floor' => 1,
            'deck_height_m' => 5.5,
            'roofed' => true,
        ])->assertCreated()
            ->assertJsonPath('kind', 'bridge')
            ->assertJsonPath('deck_floor', 1)
            ->assertJsonPath('deck_height_m', 5.5)
            ->assertJsonPath('roofed', true);
    }

    public function test_doors_are_saved_published_and_limited(): void
    {
        $bridge = Bridge::factory()->create(['polygon' => $this->deck()]);
        Sanctum::actingAs(User::factory()->create(['role' => 'admin']));

        // A door at the east end (the editor snaps it onto the outline before saving).
        $this->putJson("/api/bridges/{$bridge->id}", ['doors' => [['lat' => 6.9130135, 'lng' => 122.061272]]])
            ->assertOk()->assertJsonCount(1, 'doors');
        $this->getJson('/api/map-data')->assertJsonCount(1, 'bridges.0.doors');

        $this->putJson("/api/bridges/{$bridge->id}", ['doors' => array_fill(0, 21, ['lat' => 6.913, 'lng' => 122.061])])
            ->assertUnprocessable()->assertInvalid(['doors']);
        $this->putJson("/api/bridges/{$bridge->id}", ['doors' => null])->assertOk()->assertJsonPath('doors', null);
    }

    public function test_a_bridge_needs_a_name_an_outline_and_a_known_kind(): void
    {
        Sanctum::actingAs(User::factory()->create(['role' => 'admin']));

        $this->postJson('/api/bridges', ['kind' => 'zipline', 'polygon' => array_slice($this->deck(), 0, 2), 'deck_floor' => 9])
            ->assertUnprocessable()
            ->assertInvalid(['name', 'kind', 'polygon', 'deck_floor']);
    }

    public function test_only_admins_draw_change_or_remove_bridges_but_staff_can_read_them(): void
    {
        $bridge = Bridge::factory()->create();
        Sanctum::actingAs(User::factory()->create(['role' => 'faculty']));

        $this->getJson('/api/bridges')->assertOk()->assertJsonCount(1);
        $this->postJson('/api/bridges', ['name' => 'X', 'polygon' => $this->deck()])->assertForbidden();
        $this->putJson("/api/bridges/{$bridge->id}", ['name' => 'Renamed'])->assertForbidden();
        $this->deleteJson("/api/bridges/{$bridge->id}")->assertForbidden();
        $this->postJson("/api/bridges/{$bridge->id}/route-nodes")->assertForbidden();
    }

    public function test_admin_can_edit_and_remove_a_bridge(): void
    {
        $bridge = Bridge::factory()->create();
        Sanctum::actingAs(User::factory()->create(['role' => 'admin']));

        $this->putJson("/api/bridges/{$bridge->id}", ['roofed' => false, 'deck_floor' => 0])
            ->assertOk()->assertJsonPath('roofed', false)->assertJsonPath('deck_floor', 0);
        $this->deleteJson("/api/bridges/{$bridge->id}")->assertOk();
        $this->assertModelMissing($bridge);
    }

    public function test_route_nodes_go_along_the_deck_on_its_floor_and_sheltered_under_a_roof(): void
    {
        $bridge = Bridge::factory()->create(['polygon' => $this->deck(), 'deck_floor' => 1, 'roofed' => true]);
        Sanctum::actingAs(User::factory()->create(['role' => 'admin']));

        $this->postJson("/api/bridges/{$bridge->id}/route-nodes", ['spacing_m' => 6])->assertCreated();

        // The deck's own nodes (the staircases add one ground node at each end).
        $nodes = Node::where('type', 'route')->where('floor_level', 1)->get();
        // ~30 m deck, 1 m short of each end: 28 m at 6 m spacing.
        $this->assertGreaterThanOrEqual(5, $nodes->count());
        $this->assertTrue($nodes->every(fn (Node $n) => $n->path_type === 'inside'));
        // Along the middle of the deck, never outside the outline.
        $this->assertTrue($nodes->every(fn (Node $n) => GeoPoints::contains($this->deck(), $n->latitude, $n->longitude)));

        // Running it again stacks nothing.
        $this->postJson("/api/bridges/{$bridge->id}/route-nodes")->assertCreated()->assertJsonPath('created', 0);
    }

    public function test_a_raised_deck_gets_a_staircase_down_to_the_ground_at_each_end(): void
    {
        $bridge = Bridge::factory()->create(['polygon' => $this->deck(), 'deck_floor' => 1, 'deck_height_m' => 5.0]);
        Sanctum::actingAs(User::factory()->create(['role' => 'admin']));

        $this->postJson("/api/bridges/{$bridge->id}/route-nodes", ['stairs' => true])->assertCreated()->assertJsonPath('stairs_created', 2);

        $links = NodeLink::with(['nodeA', 'nodeB'])->get();
        $this->assertCount(2, $links);
        // 35 degree stairs climbing 5 m: the ground node is 5 / tan(35) = 7.1 m beyond the deck end.
        $run = 5.0 / tan(deg2rad(35));
        foreach ($links as $link) {
            [$ground, $deck] = $link->nodeA->floor_level === 0 ? [$link->nodeA, $link->nodeB] : [$link->nodeB, $link->nodeA];
            $this->assertSame(0, $ground->floor_level);
            $this->assertSame('outside', $ground->path_type);
            $this->assertSame(1, $deck->floor_level);
            $this->assertEqualsWithDelta(5.0, $deck->elevation, 1e-6);
            $this->assertSame(35.0, $link->angle_deg);
            $this->assertEqualsWithDelta($run, GeoPoints::distance(
                ['lat' => $ground->latitude, 'lng' => $ground->longitude], ['lat' => $deck->latitude, 'lng' => $deck->longitude]), 0.3);
            // Outside the deck, beyond its end: on the ground the routes already use.
            $this->assertFalse(GeoPoints::contains($this->deck(), $ground->latitude, $ground->longitude));
        }

        // Again: nothing is doubled.
        $this->postJson("/api/bridges/{$bridge->id}/route-nodes", ['stairs' => true])->assertCreated()->assertJsonPath('stairs_created', 0);
        $this->assertSame(2, NodeLink::count());
    }

    public function test_removing_a_bridge_removes_its_deck_nodes_and_stairs_but_not_the_ground_routes(): void
    {
        $bridge = Bridge::factory()->create(['polygon' => $this->deck(), 'deck_floor' => 1]);
        Sanctum::actingAs(User::factory()->create(['role' => 'admin']));
        $this->postJson("/api/bridges/{$bridge->id}/route-nodes", ['stairs' => true])->assertCreated();
        // A node typed in on another raised floor, inside the outline, is on the bridge too.
        $line = $bridge->walkingLine();
        Node::create(['type' => 'route', 'latitude' => ($line[0]['lat'] + $line[1]['lat']) / 2, 'longitude' => ($line[0]['lng'] + $line[1]['lng']) / 2 + 0.00001, 'floor_level' => 2, 'path_type' => 'inside']);
        $deck = Node::where('floor_level', '>', 0)->count();
        // A node on the same floor elsewhere (another structure) is not the bridge's.
        $elsewhere = Node::create(['type' => 'route', 'latitude' => 6.9200, 'longitude' => 122.0700, 'floor_level' => 1, 'path_type' => 'inside']);

        $this->deleteJson("/api/bridges/{$bridge->id}")->assertOk()->assertJsonPath('nodes_deleted', $deck);

        $this->assertSame(1, Node::where('floor_level', '>', 0)->count());
        $this->assertModelExists($elsewhere);
        $this->assertSame(0, NodeLink::count());
        // The two ground nodes the stairs came down to are part of the ground routes: they stay.
        $this->assertSame(2, Node::where('floor_level', 0)->count());
    }

    public function test_a_staircase_lands_on_an_existing_ground_node_when_one_is_there(): void
    {
        $bridge = Bridge::factory()->create(['polygon' => $this->deck(), 'deck_floor' => 1, 'deck_height_m' => null]);
        $line = $bridge->walkingLine();
        // Where the west stairs reach the ground (3.2 m rise at 35 degrees, westwards along the deck).
        $run = 3.2 / tan(deg2rad(35));
        $k = $run / GeoPoints::distance($line[0], $line[1]);
        $path = Node::create([
            'type' => 'route', 'floor_level' => 0, 'path_type' => 'outside',
            'latitude' => $line[0]['lat'] + ($line[0]['lat'] - $line[1]['lat']) * $k,
            'longitude' => $line[0]['lng'] + ($line[0]['lng'] - $line[1]['lng']) * $k,
        ]);
        Sanctum::actingAs(User::factory()->create(['role' => 'admin']));

        $this->postJson("/api/bridges/{$bridge->id}/route-nodes", ['stairs' => true])->assertCreated()->assertJsonPath('stairs_created', 2);

        $this->assertTrue(NodeLink::where('node_a_id', $path->id)->orWhere('node_b_id', $path->id)->exists());
        $this->assertSame(1, Node::where('floor_level', 0)->count() - 1, 'only the east end got a new ground node');
    }

    public function test_no_stairs_are_built_unless_asked(): void
    {
        $bridge = Bridge::factory()->create(['polygon' => $this->deck()]);
        Sanctum::actingAs(User::factory()->create(['role' => 'admin']));

        $this->postJson("/api/bridges/{$bridge->id}/route-nodes")->assertCreated()->assertJsonPath('stairs_created', 0);
        $this->assertSame(0, NodeLink::count());
    }

    public function test_a_ground_level_crossing_without_a_roof_gets_open_air_ground_nodes(): void
    {
        $bridge = Bridge::factory()->atGround()->create(['polygon' => $this->deck()]);
        Sanctum::actingAs(User::factory()->create(['role' => 'admin']));

        $this->postJson("/api/bridges/{$bridge->id}/route-nodes")->assertCreated();

        $this->assertTrue(Node::all()->every(fn (Node $n) => $n->floor_level === 0 && $n->path_type === 'outside'));
        // At ground level there is nothing to climb.
        $this->assertSame(0, NodeLink::count());
    }

    public function test_the_centre_line_runs_along_the_longest_side(): void
    {
        $line = (new Bridge(['polygon' => $this->deck()]))->walkingLine();

        $this->assertCount(2, $line);
        // East-west deck: the line keeps the middle latitude and spans ~28 m of longitude.
        $this->assertEqualsWithDelta(6.9130135, $line[0]['lat'], 1e-6);
        $this->assertEqualsWithDelta(28.0, GeoPoints::distance($line[0], $line[1]), 0.5);
    }

    public function test_visitors_and_students_get_bridges_in_the_map_feed(): void
    {
        Bridge::factory()->create(['name' => 'Footbridge']);

        $this->getJson('/api/map-data')->assertOk()->assertJsonPath('bridges.0.name', 'Footbridge')
            ->assertJsonCount(2, 'bridges.0.centre_line');
        Sanctum::actingAs(User::factory()->student()->create());
        $this->getJson('/api/map-data')->assertOk()
            ->assertJsonPath('bridges.0.deck_floor', 1)->assertJsonPath('bridges.0.roofed', true);
    }

    public function test_admins_close_a_bridge_with_a_reason_students_see_and_reopen_it(): void
    {
        $bridge = Bridge::factory()->create(['polygon' => $this->deck()]);
        Sanctum::actingAs(User::factory()->create(['role' => 'admin']));

        // Closing needs the reason students will see.
        $this->putJson("/api/bridges/{$bridge->id}", ['closed' => true])->assertUnprocessable()->assertInvalid(['closed_reason']);
        $this->putJson("/api/bridges/{$bridge->id}", ['closed' => true, 'closed_reason' => 'Campus A event until 5 PM'])
            ->assertOk()->assertJsonPath('closed', true);

        // Visitors and students get it in the map feed (the app then routes around it).
        Sanctum::actingAs(User::factory()->student()->create());
        $this->getJson('/api/map-data')->assertJsonPath('bridges.0.closed', true)
            ->assertJsonPath('bridges.0.closed_reason', 'Campus A event until 5 PM');

        // Reopening clears the reason.
        Sanctum::actingAs(User::factory()->create(['role' => 'admin']));
        $this->putJson("/api/bridges/{$bridge->id}", ['closed' => false])->assertOk()
            ->assertJsonPath('closed', false)->assertJsonPath('closed_reason', null);
    }

    public function test_only_admins_close_a_bridge(): void
    {
        $bridge = Bridge::factory()->create();
        Sanctum::actingAs(User::factory()->create(['role' => 'faculty']));

        $this->putJson("/api/bridges/{$bridge->id}", ['closed' => true, 'closed_reason' => 'x'])->assertForbidden();
        $this->assertFalse($bridge->fresh()->closed);
    }
}
