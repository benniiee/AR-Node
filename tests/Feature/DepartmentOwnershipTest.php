<?php

namespace Tests\Feature;

use App\Models\Building;
use App\Models\Department;
use App\Models\Node;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

class DepartmentOwnershipTest extends TestCase
{
    use RefreshDatabase;

    private function admin(): User
    {
        return User::factory()->create(['role' => 'admin']);
    }

    private function faculty(?Department $department = null): User
    {
        return User::factory()->create([
            'role' => 'faculty',
            'department_id' => $department?->id ?? Department::factory()->create()->id,
        ]);
    }

    private function nodePayload(array $overrides = []): array
    {
        return array_merge([
            'type' => 'route',
            'latitude' => 6.91010,
            'longitude' => 122.07130,
            'path_type' => 'outside',
        ], $overrides);
    }

    public function test_admin_can_create_department(): void
    {
        Sanctum::actingAs($this->admin());

        $response = $this->postJson('/api/departments', [
            'name' => 'Engineering',
            'color' => '#d61b1b',
        ]);

        $response->assertCreated();
        $this->assertDatabaseHas('departments', ['name' => 'Engineering', 'color' => '#d61b1b']);
    }

    public function test_faculty_cannot_manage_departments(): void
    {
        Sanctum::actingAs($this->faculty());
        $department = Department::factory()->create();

        $this->postJson('/api/departments', ['name' => 'X', 'color' => '#ffffff'])->assertForbidden();
        $this->putJson("/api/departments/{$department->id}", ['name' => 'Y'])->assertForbidden();
        $this->deleteJson("/api/departments/{$department->id}")->assertForbidden();
    }

    public function test_department_color_must_be_hex(): void
    {
        Sanctum::actingAs($this->admin());

        $this->postJson('/api/departments', ['name' => 'Bad', 'color' => 'red'])
            ->assertUnprocessable()
            ->assertInvalid('color');
    }

    public function test_admin_can_create_faculty_and_assign_department(): void
    {
        Sanctum::actingAs($this->admin());
        $department = Department::factory()->create();

        $response = $this->postJson('/api/users', [
            'name' => 'New Faculty',
            'email' => 'new.faculty@campus.test',
            'password' => 'password123',
            'role' => 'faculty',
            'department_id' => $department->id,
        ]);

        $response->assertCreated();
        $this->assertDatabaseHas('users', [
            'email' => 'new.faculty@campus.test',
            'role' => 'faculty',
            'department_id' => $department->id,
        ]);
    }

    public function test_faculty_cannot_list_users(): void
    {
        Sanctum::actingAs($this->faculty());

        $this->getJson('/api/users')->assertForbidden();
    }

    public function test_admin_cannot_demote_themselves(): void
    {
        $admin = $this->admin();
        Sanctum::actingAs($admin);

        $this->putJson("/api/users/{$admin->id}", ['role' => 'faculty'])->assertUnprocessable();
        $this->assertEquals('admin', $admin->refresh()->role);
    }

    public function test_faculty_node_create_stamps_creator_and_own_department(): void
    {
        $department = Department::factory()->create();
        $other = Department::factory()->create();
        // Staff place nodes inside their department's buildings: one around the spot.
        Building::factory()->create(['department_id' => $department->id, 'polygon' => [
            ['lat' => 6.9100, 'lng' => 122.0712], ['lat' => 6.9100, 'lng' => 122.0714],
            ['lat' => 6.9102, 'lng' => 122.0714], ['lat' => 6.9102, 'lng' => 122.0712],
        ]]);
        Sanctum::actingAs($this->faculty($department));

        // Even when the request names another department, the node is filed
        // under the faculty member's own.
        $response = $this->postJson('/api/nodes', $this->nodePayload([
            'department_id' => $other->id,
        ]));

        $response->assertCreated();
        $response->assertJsonPath('department.id', $department->id);
        $this->assertDatabaseHas('nodes', [
            'id' => $response->json('id'),
            'department_id' => $department->id,
            'created_by' => $response->json('creator.id'),
        ]);
    }

    public function test_faculty_without_department_cannot_place_nodes(): void
    {
        $faculty = User::factory()->create(['role' => 'faculty', 'department_id' => null]);
        Sanctum::actingAs($faculty);

        $this->postJson('/api/nodes', $this->nodePayload())->assertUnprocessable();
    }

    public function test_faculty_cannot_edit_or_delete_others_nodes(): void
    {
        $department = Department::factory()->create();
        $owner = $this->faculty($department);
        $intruder = $this->faculty($department);

        $node = new Node($this->nodePayload());
        $node->department_id = $department->id;
        $node->created_by = $owner->id;
        $node->save();

        Sanctum::actingAs($intruder);

        $this->putJson("/api/nodes/{$node->id}", ['name' => 'Hijacked'])->assertForbidden();
        $this->deleteJson("/api/nodes/{$node->id}")->assertForbidden();
    }

    public function test_faculty_cannot_move_node_between_departments(): void
    {
        $department = Department::factory()->create();
        $other = Department::factory()->create();
        $faculty = $this->faculty($department);
        Sanctum::actingAs($faculty);

        $node = new Node($this->nodePayload() + ['building_id' => Building::factory()->create(['department_id' => $department->id])->id]);
        $node->department_id = $department->id;
        $node->created_by = $faculty->id;
        $node->save();

        $this->putJson("/api/nodes/{$node->id}", ['department_id' => $other->id])->assertOk();
        $this->assertEquals($department->id, $node->refresh()->department_id);
    }

    public function test_admin_can_edit_any_node_and_reassign_department(): void
    {
        $a = Department::factory()->create();
        $b = Department::factory()->create();
        $faculty = $this->faculty($a);
        Sanctum::actingAs($this->admin());

        $node = new Node($this->nodePayload());
        $node->department_id = $a->id;
        $node->created_by = $faculty->id;
        $node->save();

        $this->putJson("/api/nodes/{$node->id}", ['name' => 'Renamed', 'department_id' => $b->id])
            ->assertOk()
            ->assertJsonPath('department.id', $b->id);

        // created_by is immutable — even admins cannot rewrite attribution.
        $this->assertEquals($faculty->id, $node->refresh()->created_by);
    }

    public function test_node_responses_carry_department_and_creator(): void
    {
        $admin = $this->admin();
        Sanctum::actingAs($admin);
        $department = Department::factory()->create();
        $faculty = $this->faculty($department);

        $node = new Node($this->nodePayload(['name' => 'Gate', 'type' => 'location']));
        $node->department_id = $department->id;
        $node->created_by = $faculty->id;
        $node->save();

        $this->getJson('/api/nodes')
            ->assertOk()
            ->assertJsonPath('0.department.color', $department->color)
            ->assertJsonPath('0.creator.name', $faculty->name);
    }

    public function test_public_map_data_carries_department_colour_but_no_creator(): void
    {
        // The full map and routing are for signed-in members (visitors: buildings only).
        Sanctum::actingAs(User::factory()->student()->create());
        $department = Department::factory()->create();
        $faculty = $this->faculty($department);

        $node = new Node($this->nodePayload());
        $node->department_id = $department->id;
        $node->created_by = $faculty->id;
        $node->save();

        $this->getJson('/api/map-data')
            ->assertOk()
            ->assertJsonPath('nodes.0.department.color', $department->color)
            ->assertJsonMissingPath('nodes.0.creator');
    }

    public function test_faculty_nodes_index_scoped_to_own_department(): void
    {
        $own = Department::factory()->create();
        $other = Department::factory()->create();
        $faculty = $this->faculty($own);
        Sanctum::actingAs($faculty);

        $mine = new Node($this->nodePayload(['name' => 'Mine']));
        $mine->department_id = $own->id;
        $mine->created_by = $faculty->id;
        $mine->save();

        // Another department's room, inside that department's building.
        $theirs = new Node($this->nodePayload(['name' => 'Theirs', 'latitude' => 6.91050]));
        $theirs->department_id = $other->id;
        $theirs->building_id = Building::factory()->create(['department_id' => $other->id])->id;
        $theirs->save();

        $response = $this->getJson('/api/nodes')->assertOk();

        $ids = array_column($response->json(), 'id');
        $this->assertContains($mine->id, $ids);
        $this->assertNotContains($theirs->id, $ids);
    }

    public function test_faculty_without_department_sees_no_nodes(): void
    {
        $faculty = User::factory()->create(['role' => 'faculty', 'department_id' => null]);
        Sanctum::actingAs($faculty);

        $node = new Node($this->nodePayload());
        $node->save();

        $this->getJson('/api/nodes')->assertOk()->assertExactJson([]);
    }

    public function test_admin_nodes_index_includes_unassigned_nodes(): void
    {
        Sanctum::actingAs($this->admin());

        $node = new Node($this->nodePayload(['name' => 'Legacy']));
        $node->save();

        $this->getJson('/api/nodes')
            ->assertOk()
            ->assertJsonPath('0.name', 'Legacy')
            ->assertJsonPath('0.department', null)
            ->assertJsonPath('0.creator', null);
    }

    public function test_faculty_cannot_view_other_department_node(): void
    {
        $own = Department::factory()->create();
        $other = Department::factory()->create();
        Sanctum::actingAs($this->faculty($own));

        $node = new Node($this->nodePayload());
        $node->department_id = $other->id;
        $node->building_id = Building::factory()->create(['department_id' => $other->id])->id;
        $node->save();

        $this->getJson("/api/nodes/{$node->id}")->assertForbidden();
    }

    public function test_faculty_can_view_own_department_node(): void
    {
        $department = Department::factory()->create();
        $faculty = $this->faculty($department);
        Sanctum::actingAs($faculty);

        $node = new Node($this->nodePayload());
        $node->department_id = $department->id;
        $node->created_by = $faculty->id;
        $node->save();

        $this->getJson("/api/nodes/{$node->id}")
            ->assertOk()
            ->assertJsonPath('department.id', $department->id)
            ->assertJsonPath('creator.name', $faculty->name);
    }

    public function test_login_payload_includes_role_and_department(): void
    {
        $department = Department::factory()->create();
        $faculty = $this->faculty($department);

        $this->postJson('/api/login', [
            'email' => $faculty->email,
            'password' => 'password',
        ])->assertOk()
            ->assertJsonPath('user.role', 'faculty')
            ->assertJsonPath('user.department.id', $department->id);
    }
}
