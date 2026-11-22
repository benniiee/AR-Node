<?php

namespace Tests\Feature;

use App\Models\Building;
use App\Models\Closure;
use App\Models\Department;
use App\Models\Node;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

/**
 * Closures and special openings: admins announce any scope (the whole school, a campus, every
 * college, one department, one building or place); staff only within their own department. The
 * phone applies them from the map feed (src/openingHours.js).
 */
class ClosureTest extends TestCase
{
    use RefreshDatabase;

    /** @return array{starts_at: string, ends_at: string} */
    private function today(): array
    {
        return ['starts_at' => now()->subHour()->toIso8601String(), 'ends_at' => now()->addHours(6)->toIso8601String()];
    }

    private function staff(Department $department): User
    {
        return User::factory()->create(['role' => 'faculty', 'department_id' => $department->id]);
    }

    public function test_an_admin_suspends_classes_in_every_college_and_the_map_feed_carries_it(): void
    {
        Sanctum::actingAs(User::factory()->create(['role' => 'admin']));

        $this->postJson('/api/closures', ['building_category' => 'school', 'reason' => 'Classes suspended: high heat index'] + $this->today())
            ->assertCreated()
            ->assertJsonPath('building_category', 'school')
            ->assertJsonPath('can_manage', true);

        $this->getJson('/api/map-data')
            ->assertJsonPath('closures.0.building_category', 'school')
            ->assertJsonPath('closures.0.reason', 'Classes suspended: high heat index');
    }

    public function test_a_building_is_a_school_or_office_building_by_its_owner_or_the_admin(): void
    {
        $office = Department::factory()->office()->create();
        $college = Department::factory()->create();
        $unowned = Building::factory()->create(['department_id' => null]);
        $owned = Building::factory()->create(['department_id' => $college->id]);
        Sanctum::actingAs(User::factory()->create(['role' => 'admin']));

        // Nobody owns it: the admin labels it.
        $this->putJson("/api/buildings/{$unowned->id}", ['category' => 'office'])->assertOk()->assertJsonPath('category', 'office');
        $this->putJson("/api/buildings/{$unowned->id}", ['category' => 'gym'])->assertUnprocessable()->assertInvalid('category');
        // Owned: it follows the department, whatever is sent.
        $this->putJson("/api/buildings/{$owned->id}", ['category' => 'office'])->assertOk()->assertJsonPath('category', 'school');
        $this->putJson("/api/buildings/{$owned->id}", ['department_id' => $office->id])->assertOk()->assertJsonPath('category', 'office');
        // A department turning into an office relabels its buildings.
        $other = Building::factory()->create(['department_id' => $college->id, 'category' => 'school']);
        $this->putJson("/api/departments/{$college->id}", ['kind' => 'office'])->assertOk();
        $this->assertSame('office', $other->fresh()->category);
    }

    public function test_staff_cannot_relabel_a_building(): void
    {
        $department = Department::factory()->create();
        $building = Building::factory()->create(['department_id' => $department->id, 'category' => 'school']);
        Sanctum::actingAs($this->staff($department));

        $this->putJson("/api/buildings/{$building->id}", ['category' => 'office'])->assertForbidden();
    }

    public function test_the_map_feed_says_which_buildings_are_colleges_and_has_a_real_version(): void
    {
        // The phone matches "every college" by the department's kind, so the feed must carry it.
        Building::factory()->create(['department_id' => Department::factory()->create()->id]);
        Building::factory()->create(['department_id' => Department::factory()->office()->create()->id]);

        $map = $this->getJson('/api/map-data')
            ->assertJsonPath('buildings.0.department.kind', 'college')
            ->assertJsonPath('buildings.0.category', 'school')
            ->assertJsonPath('buildings.1.department.kind', 'office');
        // The version is when the map last changed (it used to read 0 for every map).
        $this->assertGreaterThan(0, $map->json('version'));
    }

    public function test_staff_close_their_own_department_and_buildings_only(): void
    {
        $ccs = Department::factory()->create();
        $other = Department::factory()->create();
        $own = Building::factory()->create(['department_id' => $ccs->id]);
        $theirs = Building::factory()->create(['department_id' => $other->id]);
        Sanctum::actingAs($this->staff($ccs));
        $close = fn (array $scope) => $this->postJson('/api/closures', $scope + ['reason' => 'Maintenance'] + $this->today());

        $close(['department_id' => $ccs->id])->assertCreated();
        $close(['building_id' => $own->id])->assertCreated();
        $close(['building_id' => $theirs->id])->assertForbidden();
        $close(['department_id' => $other->id])->assertForbidden();
        // The whole school, a campus, or every college: an admin's call.
        $close([])->assertForbidden();
        $close(['campus' => 'A'])->assertForbidden();
        $close(['building_category' => 'school'])->assertForbidden();
    }

    public function test_staff_close_a_place_in_their_building(): void
    {
        $office = Department::factory()->office()->create();
        $building = Building::factory()->create(['department_id' => $office->id]);
        $p = $building->polygon[0];
        $cashier = Node::create([
            'name' => 'Cashier', 'type' => 'location', 'latitude' => $p['lat'], 'longitude' => $p['lng'],
            'floor_level' => 0, 'path_type' => 'inside', 'building_id' => $building->id,
        ]);
        Sanctum::actingAs($this->staff($office));

        $this->postJson('/api/closures', ['node_id' => $cashier->id, 'reason' => 'System maintenance'] + $this->today())->assertCreated();
        // A special opening (Sunday enrollment) for the same place.
        $this->postJson('/api/closures', ['node_id' => $cashier->id, 'kind' => 'open'] + $this->today())->assertCreated();
    }

    public function test_what_is_accepted(): void
    {
        $department = Department::factory()->create();
        $building = Building::factory()->create(['department_id' => $department->id]);
        Sanctum::actingAs(User::factory()->create(['role' => 'admin']));
        $post = fn (array $data) => $this->postJson('/api/closures', $data);

        // A closure says why; it ends after it starts, and not in the past.
        $post(['building_id' => $building->id] + $this->today())->assertUnprocessable()->assertInvalid('reason');
        $post(['reason' => 'x', 'starts_at' => now()->toIso8601String(), 'ends_at' => now()->subHour()->toIso8601String()])
            ->assertUnprocessable()->assertInvalid('ends_at');
        // One department, building or place at a time.
        $post(['reason' => 'x', 'department_id' => $department->id, 'building_id' => $building->id] + $this->today())
            ->assertUnprocessable()->assertInvalid('scope');
        // A special opening is for one building or place, never the whole school.
        $post(['kind' => 'open'] + $this->today())->assertUnprocessable()->assertInvalid('scope');
        $post(['kind' => 'open', 'building_id' => $building->id] + $this->today())->assertCreated();
    }

    public function test_staff_remove_their_own_but_not_an_admins_announcement(): void
    {
        $department = Department::factory()->create();
        $theirs = Closure::factory()->create(['department_id' => $department->id]);
        $schoolWide = Closure::factory()->create(['building_category' => 'school']);
        Sanctum::actingAs($this->staff($department));

        $this->getJson('/api/closures')
            ->assertOk()
            ->assertJsonFragment(['id' => $theirs->id, 'can_manage' => true])
            ->assertJsonFragment(['id' => $schoolWide->id, 'can_manage' => false]);
        $this->deleteJson("/api/closures/{$schoolWide->id}")->assertForbidden();
        $this->deleteJson("/api/closures/{$theirs->id}")->assertOk();
        $this->assertModelMissing($theirs);
    }

    public function test_ended_ones_leave_the_map_and_visitors_never_see_a_rooms(): void
    {
        $building = Building::factory()->create();
        $p = $building->polygon[0];
        $room = Node::create(['name' => 'Lab', 'type' => 'location', 'latitude' => $p['lat'], 'longitude' => $p['lng'], 'floor_level' => 0, 'path_type' => 'inside', 'building_id' => $building->id]);
        Closure::factory()->ended()->create();
        Closure::factory()->create(['building_id' => $building->id, 'reason' => 'Building inspection']);
        Closure::factory()->create(['node_id' => $room->id, 'reason' => 'Lab cleaning']);

        // Visitors: the building's announcement, not the room's (rooms are members-only).
        $this->getJson('/api/map-data')
            ->assertJsonCount(1, 'closures')
            ->assertJsonPath('closures.0.reason', 'Building inspection');
        Sanctum::actingAs(User::factory()->create(['role' => 'admin']));
        $this->getJson('/api/map-data')->assertJsonCount(2, 'closures');
    }
}
