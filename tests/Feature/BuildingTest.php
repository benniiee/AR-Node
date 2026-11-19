<?php

namespace Tests\Feature;

use App\Models\Building;
use App\Models\Department;
use App\Models\Node;
use App\Models\NodeLink;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

class BuildingTest extends TestCase
{
    use RefreshDatabase;

    private function square(): array
    {
        return [
            ['lat' => 6.9130, 'lng' => 122.0610],
            ['lat' => 6.9130, 'lng' => 122.0612],
            ['lat' => 6.9132, 'lng' => 122.0612],
            ['lat' => 6.9132, 'lng' => 122.0610],
        ];
    }

    private function nodePayload(array $overrides = []): array
    {
        return array_merge([
            'type' => 'location',
            'name' => 'Dean\'s Office',
            'latitude' => 6.9131,
            'longitude' => 122.0611,
            'path_type' => 'inside',
        ], $overrides);
    }

    public function test_admin_can_label_a_building_from_an_osm_footprint(): void
    {
        $admin = User::factory()->create(['role' => 'admin']);
        Sanctum::actingAs($admin);

        $response = $this->postJson('/api/buildings', [
            'name' => 'College of Computing Studies',
            'short_name' => 'CCS',
            'floors' => 4,
            'polygon' => array_map(fn ($p) => $p + ['junk' => 'x'], $this->square()),
            'source' => 'osm',
            'osm_ref' => 'w123',
        ]);

        $response->assertCreated()
            ->assertJsonPath('name', 'College of Computing Studies')
            ->assertJsonPath('floors', 4)
            ->assertJsonPath('status', 'existing');

        $building = Building::firstOrFail();
        $this->assertSame($admin->id, $building->created_by);
        // Only lat/lng are stored, whatever else the client sent.
        $this->assertSame(['lat', 'lng'], array_keys($building->polygon[0]));
    }

    public function test_a_building_under_construction_can_be_drawn_by_hand(): void
    {
        Sanctum::actingAs(User::factory()->create(['role' => 'admin']));

        $this->postJson('/api/buildings', [
            'name' => 'New Engineering Annex',
            'status' => 'under_construction',
            'polygon' => $this->square(),
        ])->assertCreated()->assertJsonPath('source', 'custom')->assertJsonPath('status', 'under_construction');
    }

    public function test_building_needs_a_name_and_a_polygon_of_three_points(): void
    {
        Sanctum::actingAs(User::factory()->create(['role' => 'admin']));

        $this->postJson('/api/buildings', ['polygon' => array_slice($this->square(), 0, 2)])
            ->assertUnprocessable()
            ->assertInvalid(['name', 'polygon']);
    }

    public function test_faculty_can_read_but_not_add_remove_or_edit_other_departments_buildings(): void
    {
        $building = Building::factory()->create(['department_id' => Department::factory()->create()->id]);
        $unfiled = Building::factory()->create(['department_id' => null]);
        Sanctum::actingAs(User::factory()->create(['role' => 'faculty', 'department_id' => Department::factory()->create()->id]));

        $this->getJson('/api/buildings')->assertOk()->assertJsonCount(2);
        $this->postJson('/api/buildings', ['name' => 'X', 'polygon' => $this->square()])->assertForbidden();
        $this->putJson("/api/buildings/{$building->id}", ['name' => 'Y'])->assertForbidden();
        $this->putJson("/api/buildings/{$unfiled->id}", ['name' => 'Y'])->assertForbidden();
        $this->deleteJson("/api/buildings/{$building->id}")->assertForbidden();
    }

    public function test_department_staff_can_move_and_edit_their_departments_building(): void
    {
        $department = Department::factory()->create();
        $building = Building::factory()->create(['department_id' => $department->id, 'floors' => 2]);
        Sanctum::actingAs(User::factory()->create(['role' => 'faculty', 'department_id' => $department->id]));
        $moved = array_map(fn ($p) => ['lat' => $p['lat'] + 0.0001, 'lng' => $p['lng'] - 0.0001], $building->polygon);

        $this->putJson("/api/buildings/{$building->id}", ['polygon' => $moved, 'floors' => 3, 'name' => 'CCS Annex'])
            ->assertOk()
            ->assertJsonPath('floors', 3)
            ->assertJsonPath('name', 'CCS Annex');

        $this->assertEqualsWithDelta($moved[0]['lat'], $building->fresh()->polygon[0]['lat'], 1e-7);
        // Still not theirs to delete.
        $this->deleteJson("/api/buildings/{$building->id}")->assertForbidden();
    }

    public function test_department_staff_cannot_hand_a_building_to_another_department(): void
    {
        $department = Department::factory()->create();
        $other = Department::factory()->create();
        $building = Building::factory()->create(['department_id' => $department->id]);
        Sanctum::actingAs(User::factory()->create(['role' => 'faculty', 'department_id' => $department->id]));

        $this->putJson("/api/buildings/{$building->id}", ['department_id' => $other->id])->assertForbidden();
        // Re-sending its own department (the form always sends it) is fine.
        $this->putJson("/api/buildings/{$building->id}", ['department_id' => $department->id, 'name' => 'Same'])->assertOk();
        $this->assertSame($department->id, $building->fresh()->department_id);
    }

    public function test_moving_a_building_carries_every_room_filed_in_it(): void
    {
        $department = Department::factory()->create();
        $staff = User::factory()->create(['role' => 'faculty', 'department_id' => $department->id]);
        $building = Building::factory()->create(['department_id' => $department->id]);
        // One room placed by a colleague: the move must still carry it.
        $colleague = User::factory()->create(['role' => 'faculty', 'department_id' => $department->id]);
        $room = new Node($this->nodePayload(['building_id' => $building->id, 'floor_level' => 0]));
        $room->created_by = $colleague->id;
        $room->save();
        $outside = Node::create($this->nodePayload(['name' => 'Gate', 'latitude' => 6.9140]));
        Sanctum::actingAs($staff);

        $this->putJson("/api/buildings/{$building->id}", [
            'polygon' => $building->polygon,
            'move_nodes_by' => ['lat' => 0.0002, 'lng' => -0.0001],
        ])->assertOk()->assertJsonPath('nodes_moved', 1);

        $this->assertEqualsWithDelta(6.9131 + 0.0002, $room->fresh()->latitude, 1e-7);
        $this->assertEqualsWithDelta(122.0611 - 0.0001, $room->fresh()->longitude, 1e-7);
        $this->assertEqualsWithDelta(6.9140, $outside->fresh()->latitude, 1e-9);
    }

    public function test_a_move_offset_must_be_a_short_distance(): void
    {
        Sanctum::actingAs(User::factory()->create(['role' => 'admin']));
        $building = Building::factory()->create();

        $this->putJson("/api/buildings/{$building->id}", ['move_nodes_by' => ['lat' => 0.5, 'lng' => 0]])
            ->assertUnprocessable()
            ->assertInvalid('move_nodes_by.lat');
    }

    public function test_node_floor_must_exist_in_its_building(): void
    {
        Sanctum::actingAs(User::factory()->create(['role' => 'admin']));
        $building = Building::factory()->create(['floors' => 3]);

        // Ground (0) to the top floor (floors - 1); no basements.
        $this->postJson('/api/nodes', $this->nodePayload(['building_id' => $building->id, 'floor_level' => 2]))
            ->assertCreated()
            ->assertJsonPath('building.name', $building->name);
        $this->postJson('/api/nodes', $this->nodePayload(['building_id' => $building->id, 'floor_level' => 0]))
            ->assertCreated();
        $this->postJson('/api/nodes', $this->nodePayload(['building_id' => $building->id, 'floor_level' => -1]))
            ->assertUnprocessable()
            ->assertInvalid('floor_level');

        $this->postJson('/api/nodes', $this->nodePayload(['building_id' => $building->id, 'floor_level' => 3]))
            ->assertUnprocessable()
            ->assertInvalid('floor_level');
        $this->postJson('/api/nodes', $this->nodePayload(['building_id' => $building->id, 'floor_level' => -2]))
            ->assertUnprocessable()
            ->assertInvalid('floor_level');
    }

    public function test_moving_a_node_to_another_building_checks_the_new_buildings_floors(): void
    {
        Sanctum::actingAs(User::factory()->create(['role' => 'admin']));
        $tall = Building::factory()->create(['floors' => 5]);
        $low = Building::factory()->create(['floors' => 1]);
        $node = Node::create($this->nodePayload(['building_id' => $tall->id, 'floor_level' => 4]));

        $this->putJson("/api/nodes/{$node->id}", ['building_id' => $low->id])
            ->assertUnprocessable()
            ->assertInvalid('floor_level');

        $this->putJson("/api/nodes/{$node->id}", ['building_id' => $low->id, 'floor_level' => 0])
            ->assertOk()
            ->assertJsonPath('building_id', $low->id);
    }

    public function test_floors_cannot_be_reduced_below_occupied_floors(): void
    {
        Sanctum::actingAs(User::factory()->create(['role' => 'admin']));
        $building = Building::factory()->create(['floors' => 4]);
        Node::create($this->nodePayload(['building_id' => $building->id, 'floor_level' => 3]));

        $this->putJson("/api/buildings/{$building->id}", ['floors' => 3])
            ->assertUnprocessable()
            ->assertInvalid('floors');

        $this->putJson("/api/buildings/{$building->id}", ['floors' => 6])->assertOk()->assertJsonPath('floors', 6);
    }

    public function test_height_is_optional_and_range_checked(): void
    {
        Sanctum::actingAs(User::factory()->create(['role' => 'admin']));
        $building = Building::factory()->create();

        $this->assertNull($building->fresh()->height_m);
        $this->putJson("/api/buildings/{$building->id}", ['height_m' => 14.5])->assertOk()->assertJsonPath('height_m', 14.5);
        $this->putJson("/api/buildings/{$building->id}", ['height_m' => 900])->assertUnprocessable()->assertInvalid('height_m');
        $this->putJson("/api/buildings/{$building->id}", ['height_m' => null])->assertOk()->assertJsonPath('height_m', null);
        $this->getJson('/api/map-data')->assertJsonPath('buildings.0.height_m', null);
    }

    public function test_deleting_a_building_deletes_its_nodes_and_their_stairs(): void
    {
        Sanctum::actingAs(User::factory()->create(['role' => 'admin']));
        $building = Building::factory()->create();
        $ground = Node::create($this->nodePayload(['building_id' => $building->id, 'floor_level' => 0]));
        $upstairs = Node::create($this->nodePayload(['building_id' => $building->id, 'floor_level' => 1]));
        $outside = Node::create($this->nodePayload(['floor_level' => 0]));
        NodeLink::create(['node_a_id' => $ground->id, 'node_b_id' => $upstairs->id]);

        $this->deleteJson("/api/buildings/{$building->id}")->assertOk()->assertJsonPath('nodes_deleted', 2);

        $this->assertModelMissing($ground);
        $this->assertModelMissing($upstairs);
        $this->assertSame(0, NodeLink::count());
        // Nodes of other buildings and outside stay.
        $this->assertModelExists($outside);
    }

    public function test_map_data_includes_building_labels_and_node_buildings(): void
    {
        // The full map and routing are for signed-in members (visitors: buildings only).
        Sanctum::actingAs(User::factory()->student()->create());
        $department = Department::factory()->create();
        $building = Building::factory()->create(['name' => 'Main Library', 'floors' => 3, 'department_id' => $department->id]);
        Node::create($this->nodePayload(['building_id' => $building->id, 'floor_level' => 1]));

        $response = $this->getJson('/api/map-data')->assertOk();

        $response->assertJsonPath('buildings.0.name', 'Main Library')
            ->assertJsonPath('buildings.0.floors', 3)
            ->assertJsonPath('buildings.0.department.color', $department->color)
            ->assertJsonPath('nodes.0.building_id', $building->id)
            // Internal fields stay off the public feed.
            ->assertJsonMissingPath('buildings.0.created_by')
            ->assertJsonMissingPath('buildings.0.osm_ref');
    }
}
