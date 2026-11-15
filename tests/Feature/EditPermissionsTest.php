<?php

namespace Tests\Feature;

use App\Models\Border;
use App\Models\Building;
use App\Models\Department;
use App\Models\Node;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

/**
 * Who may change what on the map:
 *  - admins: every node, wall, building and pathway (add, move, edit, remove)
 *  - faculty: only the nodes and walls they placed themselves
 */
class EditPermissionsTest extends TestCase
{
    use RefreshDatabase;

    private Department $department;

    protected function setUp(): void
    {
        parent::setUp();
        $this->department = Department::factory()->create();
    }

    private function faculty(): User
    {
        return User::factory()->create(['role' => 'faculty', 'department_id' => $this->department->id]);
    }

    private function nodeBy(?User $creator): Node
    {
        $node = new Node(['type' => 'route', 'latitude' => 6.9131, 'longitude' => 122.0611, 'path_type' => 'outside']);
        $node->department_id = $this->department->id;
        $node->created_by = $creator?->id;
        $node->save();

        return $node;
    }

    private function wallBy(?User $creator, int $groupId = 3): void
    {
        foreach ([[6.9130, 122.0610], [6.9132, 122.0612]] as [$lat, $lng]) {
            $border = new Border(['latitude' => $lat, 'longitude' => $lng, 'group_id' => $groupId]);
            $border->created_by = $creator?->id;
            $border->save();
        }
    }

    /** A department building around the test area (6.9128-6.9138, 122.0608-122.0618). */
    private function departmentBuilding(?Department $department = null): Building
    {
        return Building::factory()->create([
            'department_id' => ($department ?? $this->department)->id,
            'polygon' => [
                ['lat' => 6.9128, 'lng' => 122.0608], ['lat' => 6.9128, 'lng' => 122.0618],
                ['lat' => 6.9138, 'lng' => 122.0618], ['lat' => 6.9138, 'lng' => 122.0608],
            ],
        ]);
    }

    public function test_faculty_can_move_and_edit_their_own_node(): void
    {
        $building = $this->departmentBuilding();
        $me = $this->faculty();
        $node = $this->nodeBy($me);
        $node->update(['building_id' => $building->id]);
        Sanctum::actingAs($me);

        $this->putJson("/api/nodes/{$node->id}", ['latitude' => 6.9135, 'longitude' => 122.0615, 'name' => 'Lab'])
            ->assertOk()
            ->assertJsonPath('latitude', 6.9135);
    }

    public function test_faculty_cannot_edit_a_node_outside_buildings_even_one_they_placed(): void
    {
        // Outdoor nodes are the shared network: admins only (staff work inside their buildings).
        $this->departmentBuilding();
        $me = $this->faculty();
        $node = $this->nodeBy($me);
        Sanctum::actingAs($me);

        $this->putJson("/api/nodes/{$node->id}", ['name' => 'Gate'])->assertForbidden();
        $this->deleteJson("/api/nodes/{$node->id}")->assertForbidden();
    }

    public function test_faculty_cannot_move_a_colleagues_node(): void
    {
        $node = $this->nodeBy($this->faculty());
        Sanctum::actingAs($this->faculty());

        $this->putJson("/api/nodes/{$node->id}", ['latitude' => 6.9135, 'longitude' => 122.0615])->assertForbidden();
        $this->assertSame(6.9131, $node->fresh()->latitude);
    }

    public function test_admin_can_move_and_remove_any_node_including_unattributed_ones(): void
    {
        $byFaculty = $this->nodeBy($this->faculty());
        $unattributed = $this->nodeBy(null);
        Sanctum::actingAs(User::factory()->create(['role' => 'admin']));

        $this->putJson("/api/nodes/{$byFaculty->id}", ['latitude' => 6.9140, 'longitude' => 122.0620])->assertOk();
        $this->deleteJson("/api/nodes/{$unattributed->id}")->assertOk();
    }

    public function test_staff_place_nodes_only_inside_their_departments_buildings(): void
    {
        $building = $this->departmentBuilding();
        Sanctum::actingAs($this->faculty());
        $payload = ['type' => 'location', 'name' => 'Faculty room', 'path_type' => 'inside'];

        // Inside: accepted, and filed under the building it was placed in.
        $this->postJson('/api/nodes', $payload + ['latitude' => 6.9131, 'longitude' => 122.0611])
            ->assertCreated()
            ->assertJsonPath('building_id', $building->id);

        // Outside every building of the department: refused with a clear reason.
        $this->postJson('/api/nodes', $payload + ['latitude' => 6.9150, 'longitude' => 122.0630])
            ->assertUnprocessable()
            ->assertInvalid('latitude');
    }

    public function test_staff_cannot_place_nodes_in_another_departments_building(): void
    {
        $this->departmentBuilding();
        $theirs = $this->departmentBuilding(Department::factory()->create());
        Sanctum::actingAs($this->faculty());

        $this->postJson('/api/nodes', [
            'type' => 'location', 'name' => 'X', 'path_type' => 'inside',
            'latitude' => 6.9131, 'longitude' => 122.0611, 'building_id' => $theirs->id,
        ])->assertUnprocessable()->assertInvalid('building_id');
    }

    public function test_staff_without_department_buildings_are_told_why(): void
    {
        Sanctum::actingAs($this->faculty());

        $this->postJson('/api/nodes', ['type' => 'route', 'path_type' => 'outside', 'latitude' => 6.9131, 'longitude' => 122.0611])
            ->assertUnprocessable()
            ->assertInvalid(['latitude' => 'no buildings']);
    }

    public function test_staff_cannot_move_their_node_out_of_their_buildings(): void
    {
        $building = $this->departmentBuilding();
        $me = $this->faculty();
        $node = $this->nodeBy($me);
        $node->update(['building_id' => $building->id]);
        Sanctum::actingAs($me);

        $this->putJson("/api/nodes/{$node->id}", ['latitude' => 6.9150, 'longitude' => 122.0630])
            ->assertUnprocessable()
            ->assertInvalid('latitude');
        $this->assertSame(6.9131, $node->fresh()->latitude);
    }

    public function test_admins_place_nodes_anywhere(): void
    {
        Sanctum::actingAs(User::factory()->create(['role' => 'admin']));

        $this->postJson('/api/nodes', ['type' => 'route', 'path_type' => 'outside', 'latitude' => 6.9150, 'longitude' => 122.0630])
            ->assertCreated()
            ->assertJsonPath('building_id', null);
    }

    public function test_faculty_wall_is_stamped_with_its_creator(): void
    {
        $me = $this->faculty();
        Sanctum::actingAs($me);

        $this->postJson('/api/borders', ['latitude' => 6.913, 'longitude' => 122.061, 'group_id' => 9])->assertCreated();

        $this->assertSame($me->id, Border::where('group_id', 9)->value('created_by'));
    }

    public function test_faculty_can_remove_their_own_wall(): void
    {
        $me = $this->faculty();
        $this->wallBy($me);
        Sanctum::actingAs($me);

        $this->deleteJson('/api/borders/group/3')->assertOk();
        $this->assertSame(0, Border::where('group_id', 3)->count());
    }

    public function test_faculty_cannot_remove_or_extend_someone_elses_wall(): void
    {
        $this->wallBy($this->faculty());
        Sanctum::actingAs($this->faculty());

        $this->deleteJson('/api/borders/group/3')->assertForbidden();
        $this->postJson('/api/borders', ['latitude' => 6.914, 'longitude' => 122.062, 'group_id' => 3])->assertForbidden();
        $this->assertSame(2, Border::where('group_id', 3)->count());
    }

    public function test_faculty_cannot_change_a_wall_drawn_before_attribution(): void
    {
        $this->wallBy(null);
        Sanctum::actingAs($this->faculty());

        $this->deleteJson('/api/borders/group/3')->assertForbidden();
    }

    public function test_admin_can_remove_any_wall(): void
    {
        $this->wallBy($this->faculty(), 3);
        $this->wallBy(null, 4);
        Sanctum::actingAs(User::factory()->create(['role' => 'admin']));

        $this->deleteJson('/api/borders/group/3')->assertOk();
        $this->deleteJson('/api/borders/group/4')->assertOk();
    }

    public function test_admin_can_move_a_building_by_rewriting_its_outline(): void
    {
        $building = Building::factory()->create();
        Sanctum::actingAs(User::factory()->create(['role' => 'admin']));
        $moved = array_map(fn ($p) => ['lat' => $p['lat'] + 0.0001, 'lng' => $p['lng'] + 0.0001], $building->polygon);

        $this->putJson("/api/buildings/{$building->id}", ['polygon' => $moved])->assertOk();

        $this->assertEqualsWithDelta($moved[0]['lat'], $building->fresh()->polygon[0]['lat'], 1e-7);
    }

    public function test_faculty_cannot_move_a_building(): void
    {
        $building = Building::factory()->create();
        Sanctum::actingAs($this->faculty());

        $this->putJson("/api/buildings/{$building->id}", ['polygon' => $building->polygon])->assertForbidden();
    }
}
