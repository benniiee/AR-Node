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
 * An admin hands a building to another department (e.g. CCS moves to its new
 * building and CSM takes the old one): its rooms and routes go with it, and
 * the new department's staff can manage them.
 */
class BuildingHandoverTest extends TestCase
{
    use RefreshDatabase;

    private Department $ccs;

    private Department $csm;

    private Building $building;

    private User $ccsStaff;

    private Node $room;

    protected function setUp(): void
    {
        parent::setUp();
        $this->ccs = Department::factory()->create(['name' => 'CCS']);
        $this->csm = Department::factory()->create(['name' => 'CSM']);
        $this->ccsStaff = User::factory()->create(['role' => 'faculty', 'department_id' => $this->ccs->id]);
        $this->building = Building::factory()->create(['department_id' => $this->ccs->id, 'floors' => 2]);
        $p = $this->building->polygon[0];

        $this->room = new Node([
            'type' => 'location', 'name' => 'LAB1', 'path_type' => 'inside', 'floor_level' => 1,
            'latitude' => $p['lat'] + 0.00005, 'longitude' => $p['lng'] + 0.00005, 'building_id' => $this->building->id,
        ]);
        $this->room->department_id = $this->ccs->id;
        $this->room->created_by = $this->ccsStaff->id;
        $this->room->save();
    }

    public function test_admin_hands_the_building_over_with_its_nodes(): void
    {
        Sanctum::actingAs(User::factory()->create(['role' => 'admin']));

        $this->putJson("/api/buildings/{$this->building->id}", ['department_id' => $this->csm->id])
            ->assertOk()
            ->assertJsonPath('department_id', $this->csm->id)
            ->assertJsonPath('nodes_transferred', 1);

        $room = $this->room->fresh();
        $this->assertSame($this->csm->id, $room->department_id);
        // Intact: same spot, floor, name and creator.
        $this->assertSame('LAB1', $room->name);
        $this->assertSame(1, $room->floor_level);
        $this->assertEqualsWithDelta($this->room->latitude, $room->latitude, 1e-9);
        $this->assertSame($this->ccsStaff->id, $room->created_by);
    }

    public function test_the_nodes_can_be_left_with_the_old_department(): void
    {
        Sanctum::actingAs(User::factory()->create(['role' => 'admin']));

        $this->putJson("/api/buildings/{$this->building->id}", ['department_id' => $this->csm->id, 'transfer_nodes' => false])
            ->assertOk()
            ->assertJsonPath('nodes_transferred', 0);

        $this->assertSame($this->ccs->id, $this->room->fresh()->department_id);
    }

    public function test_handing_back_counts_only_the_nodes_that_change_owner(): void
    {
        Sanctum::actingAs(User::factory()->create(['role' => 'admin']));
        // A room CSM added before the building went to CCS still belongs to CSM.
        $old = $this->room->replicate();
        $old->name = 'CHEM1';
        $old->department_id = $this->csm->id;
        $old->save();

        $this->putJson("/api/buildings/{$this->building->id}", ['department_id' => $this->csm->id])
            ->assertOk()
            ->assertJsonPath('nodes_transferred', 1);

        $this->assertSame($this->csm->id, $this->room->fresh()->department_id);
        $this->assertSame($this->csm->id, $old->fresh()->department_id);
        $this->assertSame('CHEM1', $old->fresh()->name);
    }

    public function test_rooms_left_under_the_old_department_are_seen_and_edited_by_the_new_one(): void
    {
        Sanctum::actingAs(User::factory()->create(['role' => 'admin']));
        $this->putJson("/api/buildings/{$this->building->id}", ['department_id' => $this->csm->id, 'transfer_nodes' => false])->assertOk();

        // CSM manages the building, so it sees and edits the room still labelled CCS.
        Sanctum::actingAs(User::factory()->create(['role' => 'faculty', 'department_id' => $this->csm->id]));
        $this->getJson('/api/nodes')->assertOk()->assertJsonFragment(['id' => $this->room->id]);
        $this->getJson("/api/nodes/{$this->room->id}")->assertOk();
        $this->putJson("/api/nodes/{$this->room->id}", ['name' => 'Chem lab'])->assertOk();
        $this->assertSame($this->ccs->id, $this->room->fresh()->department_id);
    }

    public function test_unassigning_and_reassigning_keeps_the_nodes_intact(): void
    {
        Sanctum::actingAs(User::factory()->create(['role' => 'admin']));

        // CCS moves out: the building belongs to no department for a while.
        $this->putJson("/api/buildings/{$this->building->id}", ['department_id' => null])
            ->assertOk()
            ->assertJsonPath('department_id', null);
        $this->assertDatabaseHas('nodes', ['id' => $this->room->id, 'name' => 'LAB1', 'building_id' => $this->building->id]);

        // CSM moves in and gets the same rooms, nothing re-added.
        $this->putJson("/api/buildings/{$this->building->id}", ['department_id' => $this->csm->id])
            ->assertOk()
            ->assertJsonPath('nodes_transferred', 1);

        $room = $this->room->fresh();
        $this->assertSame($this->csm->id, $room->department_id);
        $this->assertSame('LAB1', $room->name);
        $this->assertSame(1, $room->floor_level);
        $this->assertEqualsWithDelta($this->room->latitude, $room->latitude, 1e-9);
    }

    public function test_the_new_departments_staff_manage_the_rooms_they_received(): void
    {
        Sanctum::actingAs(User::factory()->create(['role' => 'admin']));
        $this->putJson("/api/buildings/{$this->building->id}", ['department_id' => $this->csm->id])->assertOk();

        Sanctum::actingAs(User::factory()->create(['role' => 'faculty', 'department_id' => $this->csm->id]));
        $this->putJson("/api/nodes/{$this->room->id}", ['name' => 'Chem lab'])->assertOk()->assertJsonPath('name', 'Chem lab');

        // ...and the previous department no longer does.
        Sanctum::actingAs($this->ccsStaff);
        $this->putJson("/api/nodes/{$this->room->id}", ['name' => 'Mine again'])->assertForbidden();
    }

    public function test_staff_cannot_hand_a_building_to_another_department(): void
    {
        Sanctum::actingAs($this->ccsStaff);

        $this->putJson("/api/buildings/{$this->building->id}", ['department_id' => $this->csm->id])->assertForbidden();
        $this->assertSame($this->ccs->id, $this->room->fresh()->department_id);
    }
}
