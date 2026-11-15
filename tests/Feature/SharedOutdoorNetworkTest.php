<?php

namespace Tests\Feature;

use App\Models\Building;
use App\Models\Department;
use App\Models\Node;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

/**
 * Admins lay the outdoor network (nodes outside any building); department
 * staff work inside their own buildings. Staff see the outdoor network
 * read-only and may join their nodes to it, but never edit it.
 */
class SharedOutdoorNetworkTest extends TestCase
{
    use RefreshDatabase;

    private Department $department;

    private User $staff;

    private Building $building;

    protected function setUp(): void
    {
        parent::setUp();

        $this->department = Department::factory()->create();
        $this->staff = User::factory()->create(['role' => 'faculty', 'department_id' => $this->department->id]);
        $this->building = Building::factory()->create(['department_id' => $this->department->id, 'floors' => 3]);
    }

    private function node(array $attributes, ?User $creator = null): Node
    {
        $node = new Node(array_merge([
            'type' => 'route',
            'latitude' => 6.9120,
            'longitude' => 122.0600,
            'path_type' => 'outside',
            'floor_level' => 0,
        ], $attributes));
        $node->department_id = $attributes['department_id'] ?? null;
        $node->created_by = $creator?->id;
        $node->save();

        return $node;
    }

    private function roomOnFloor(int $floor): Node
    {
        return $this->node([
            'type' => 'location', 'name' => 'Lab', 'path_type' => 'inside', 'floor_level' => $floor,
            'building_id' => $this->building->id, 'department_id' => $this->department->id,
        ], $this->staff);
    }

    public function test_staff_see_the_outdoor_network_but_not_other_departments_buildings(): void
    {
        $admin = User::factory()->create(['role' => 'admin']);
        $outdoor = $this->node([], $admin);
        $mine = $this->roomOnFloor(0);
        $other = Department::factory()->create();
        $theirs = $this->node([
            'path_type' => 'inside', 'department_id' => $other->id,
            'building_id' => Building::factory()->create(['department_id' => $other->id])->id,
        ]);
        Sanctum::actingAs($this->staff);

        $ids = array_column($this->getJson('/api/nodes')->assertOk()->json(), 'id');

        $this->assertEqualsCanonicalizing([$outdoor->id, $mine->id], $ids);
        $this->assertNotContains($theirs->id, $ids);
        $this->getJson("/api/nodes/{$outdoor->id}")->assertOk();
    }

    public function test_staff_cannot_edit_or_remove_the_outdoor_network(): void
    {
        $outdoor = $this->node([], User::factory()->create(['role' => 'admin']));
        Sanctum::actingAs($this->staff);

        $this->putJson("/api/nodes/{$outdoor->id}", ['name' => 'Mine now'])->assertForbidden();
        $this->deleteJson("/api/nodes/{$outdoor->id}")->assertForbidden();
    }

    public function test_staff_can_join_their_node_to_an_outdoor_node_with_a_staircase(): void
    {
        $outdoor = $this->node([], User::factory()->create(['role' => 'admin']));
        $upstairs = $this->roomOnFloor(1);
        Sanctum::actingAs($this->staff);

        $this->postJson('/api/node-links', ['node_a_id' => $upstairs->id, 'node_b_id' => $outdoor->id])->assertCreated();
    }

    public function test_staff_cannot_join_two_outdoor_nodes_or_another_departments_node(): void
    {
        $admin = User::factory()->create(['role' => 'admin']);
        $ground = $this->node([], $admin);
        $raised = $this->node(['floor_level' => 1, 'latitude' => 6.9121], $admin);
        $other = Department::factory()->create();
        $theirs = $this->node([
            'floor_level' => 1, 'path_type' => 'inside', 'department_id' => $other->id,
            'building_id' => Building::factory()->create(['department_id' => $other->id])->id,
        ], User::factory()->create(['role' => 'faculty', 'department_id' => $other->id]));
        $mine = $this->roomOnFloor(0);
        Sanctum::actingAs($this->staff);

        $this->postJson('/api/node-links', ['node_a_id' => $ground->id, 'node_b_id' => $raised->id])->assertForbidden();
        $this->postJson('/api/node-links', ['node_a_id' => $mine->id, 'node_b_id' => $theirs->id])->assertForbidden();
    }
}
