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
 * Building heads and office staff: the head of a department (the Dean of a college) runs its building
 * and assigns office staff to its places (the IT office, the CS office); office staff set the hours
 * of, and close, only the places assigned to them.
 */
class OfficeStaffTest extends TestCase
{
    use RefreshDatabase;

    private Department $college;

    private Building $building;

    private User $dean;

    private User $officeStaff;

    protected function setUp(): void
    {
        parent::setUp();
        $this->college = Department::factory()->create();
        $this->building = Building::factory()->create(['department_id' => $this->college->id]);
        $this->dean = User::factory()->create(['role' => 'faculty', 'department_id' => $this->college->id]);
        $this->officeStaff = User::factory()->create(['role' => 'faculty', 'department_id' => $this->college->id, 'is_head' => false]);
    }

    private function place(string $name): Node
    {
        $p = $this->building->polygon[0];

        return Node::create([
            'name' => $name, 'type' => 'location', 'latitude' => $p['lat'], 'longitude' => $p['lng'],
            'floor_level' => 0, 'path_type' => 'inside', 'building_id' => $this->building->id,
        ]);
    }

    /** @return array<string, mixed> */
    private function weekdays(): array
    {
        return ['opening_hours' => ['mon' => [['08:00', '17:00']]]];
    }

    public function test_the_dean_assigns_office_staff_who_then_set_their_offices_hours_only(): void
    {
        $itOffice = $this->place('IT Office');
        $csOffice = $this->place('CS Office');

        Sanctum::actingAs($this->dean);
        $this->putJson("/api/nodes/{$itOffice->id}", ['manager_id' => $this->officeStaff->id])
            ->assertOk()->assertJsonPath('manager.name', $this->officeStaff->name);

        Sanctum::actingAs($this->officeStaff);
        $this->putJson("/api/nodes/{$itOffice->id}", $this->weekdays() + ['name' => 'Renamed'])->assertOk();
        $this->assertSame([['08:00', '17:00']], $itOffice->fresh()->opening_hours['mon']);
        $this->assertSame('IT Office', $itOffice->fresh()->name, 'only the hours are theirs');

        $this->putJson("/api/nodes/{$csOffice->id}", $this->weekdays())->assertForbidden();
        $this->putJson("/api/buildings/{$this->building->id}", ['name' => 'X'])->assertForbidden();
        $this->postJson('/api/nodes', ['name' => 'X', 'type' => 'location', 'latitude' => 6.9, 'longitude' => 122.0])->assertForbidden();
        $this->getJson('/api/user')->assertOk()->assertJsonPath('is_head', false)->assertJsonPath('places', [$itOffice->id]);
    }

    public function test_once_an_office_is_assigned_its_hours_and_closures_are_its_staffs_not_the_deans(): void
    {
        $office = $this->place('IT Office');
        $now = ['starts_at' => now()->toIso8601String(), 'ends_at' => now()->addHours(2)->toIso8601String()];
        Sanctum::actingAs($this->dean);

        // Unassigned: the Dean sets its hours.
        $this->putJson("/api/nodes/{$office->id}", $this->weekdays())->assertOk();

        $office->forceFill(['manager_id' => $this->officeStaff->id])->save();
        $this->putJson("/api/nodes/{$office->id}", ['opening_hours' => ['tue' => [['09:00', '12:00']]]])->assertForbidden();
        $this->postJson('/api/closures', ['node_id' => $office->id, 'reason' => 'Meeting'] + $now)->assertForbidden();
        // Renaming it, or re-sending its current hours (the form keeps them), is still the Dean's.
        $this->putJson("/api/nodes/{$office->id}", ['name' => 'IT Department Office'] + $this->weekdays())->assertOk();
        // The whole building is still the Dean's to close.
        $this->postJson('/api/closures', ['building_id' => $this->building->id, 'reason' => 'Event'] + $now)->assertCreated();

        Sanctum::actingAs($this->officeStaff);
        $this->putJson("/api/nodes/{$office->id}", ['opening_hours' => ['tue' => [['09:00', '12:00']]]])->assertOk();
        $this->postJson('/api/closures', ['node_id' => $office->id, 'reason' => 'Meeting'] + $now)->assertCreated();
    }

    public function test_the_dean_lists_their_own_departments_staff_to_pick_from(): void
    {
        User::factory()->create(['role' => 'faculty', 'department_id' => Department::factory()->create()->id]);

        Sanctum::actingAs($this->dean);
        $this->assertEqualsCanonicalizing(
            [$this->dean->id, $this->officeStaff->id],
            collect($this->getJson('/api/users')->assertOk()->json())->pluck('id')->all(),
        );

        Sanctum::actingAs($this->officeStaff);
        $this->getJson('/api/users')->assertForbidden();
    }

    public function test_only_staff_of_the_owning_department_can_be_assigned(): void
    {
        $office = $this->place('IT Office');
        $outsider = User::factory()->create(['role' => 'faculty', 'department_id' => Department::factory()->create()->id, 'is_head' => false]);

        Sanctum::actingAs($this->dean);
        $this->putJson("/api/nodes/{$office->id}", ['manager_id' => $outsider->id])->assertStatus(422);

        // Office staff cannot hand their office on.
        $office->forceFill(['manager_id' => $this->officeStaff->id])->save();
        Sanctum::actingAs($this->officeStaff);
        $this->putJson("/api/nodes/{$office->id}", ['manager_id' => null])->assertOk();
        $this->assertSame($this->officeStaff->id, $office->fresh()->manager_id);
    }

    public function test_office_staff_close_their_office_and_the_dean_closes_the_whole_building(): void
    {
        $office = $this->place('IT Office');
        $office->forceFill(['manager_id' => $this->officeStaff->id])->save();
        $now = ['starts_at' => now()->toIso8601String(), 'ends_at' => now()->addYear()->toIso8601String()];

        Sanctum::actingAs($this->officeStaff);
        $this->postJson('/api/closures', ['node_id' => $office->id, 'reason' => 'Out for lunch'] + $now)->assertCreated();
        $this->postJson('/api/closures', ['building_id' => $this->building->id, 'reason' => 'Closed'] + $now)->assertForbidden();

        // "Close now": the head overrides the building's schedule until reopened (removing the closure).
        Sanctum::actingAs($this->dean);
        $closure = $this->postJson('/api/closures', ['building_id' => $this->building->id, 'reason' => 'Closed now'] + $now)->assertCreated();
        $this->deleteJson('/api/closures/'.$closure->json('id'))->assertOk();
    }

    public function test_the_accounts_list_says_who_heads_and_who_runs_which_office(): void
    {
        $office = $this->place('IT Office');
        $office->forceFill(['manager_id' => $this->officeStaff->id])->save();
        Sanctum::actingAs(User::factory()->create(['role' => 'admin']));

        $created = $this->postJson('/api/users', [
            'name' => 'CS Office Staff', 'email' => 'cs@example.test', 'password' => 'password123',
            'department_id' => $this->college->id, 'is_head' => false,
        ])->assertCreated()->assertJsonPath('is_head', false);

        $users = collect($this->getJson('/api/users')->assertOk()->json())->keyBy('id');
        $this->assertTrue($users[$this->dean->id]['is_head']);
        $this->assertSame('college', $users[$this->dean->id]['department']['kind']);
        $this->assertSame([['id' => $office->id, 'name' => 'IT Office']], $users[$this->officeStaff->id]['places']);

        // Made head (or moved to another department), they no longer run the office.
        $this->putJson("/api/users/{$this->officeStaff->id}", ['is_head' => true])->assertOk();
        $this->assertNull($office->fresh()->manager_id);
        $this->assertFalse(User::find($created->json('id'))->is_head);
    }
}
