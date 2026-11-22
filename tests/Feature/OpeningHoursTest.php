<?php

namespace Tests\Feature;

use App\Models\Building;
use App\Models\Course;
use App\Models\Department;
use App\Models\Node;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

/**
 * Offices (registrar, cashier, canteen) and weekly opening hours on buildings and places. The phone
 * reads the hours from the map feed (src/openingHours.js); here: who sets them and what is accepted.
 */
class OpeningHoursTest extends TestCase
{
    use RefreshDatabase;

    /** Mon-Sat 8 am to 5 pm, closed on Sunday (the canteen). */
    private const MON_SAT = [
        'mon' => [['08:00', '17:00']], 'tue' => [['08:00', '17:00']], 'wed' => [['08:00', '17:00']],
        'thu' => [['08:00', '17:00']], 'fri' => [['08:00', '17:00']], 'sat' => [['08:00', '17:00']],
    ];

    private function staffOf(Building $building, string $kind = 'office'): User
    {
        $department = Department::factory()->create(['kind' => $kind]);
        $building->update(['department_id' => $department->id]);

        return User::factory()->create(['role' => 'faculty', 'department_id' => $department->id]);
    }

    public function test_office_staff_set_their_building_hours_and_the_map_feed_carries_them(): void
    {
        $building = Building::factory()->create();
        Sanctum::actingAs($this->staffOf($building));

        $this->putJson("/api/buildings/{$building->id}", ['opening_hours' => self::MON_SAT])
            ->assertOk()
            ->assertJsonPath('opening_hours.mon.0', ['08:00', '17:00'])
            ->assertJsonPath('opening_hours.sun', []);

        $this->getJson('/api/map-data')->assertJsonPath('buildings.0.opening_hours.sat.0', ['08:00', '17:00']);

        $this->putJson("/api/buildings/{$building->id}", ['opening_hours' => null])->assertOk();
        $this->assertNull($building->fresh()->opening_hours);
    }

    public function test_hours_are_checked_and_stored_in_order(): void
    {
        $building = Building::factory()->create();
        Sanctum::actingAs($this->staffOf($building));
        $put = fn (array $hours) => $this->putJson("/api/buildings/{$building->id}", ['opening_hours' => $hours]);

        $put(['mon' => [['17:00', '08:00']]])->assertUnprocessable()->assertInvalid('opening_hours.mon');
        $put(['mon' => [['08:00', '12:30'], ['12:00', '17:00']]])->assertUnprocessable()->assertInvalid('opening_hours.mon');
        $put(['mon' => [['8am', '5pm']]])->assertUnprocessable()->assertInvalid('opening_hours.mon.0.0');
        $put(['funday' => [['08:00', '17:00']]])->assertUnprocessable()->assertInvalid('opening_hours');

        // A lunch break: two ranges, given in any order, stored in order.
        $put(['mon' => [['13:00', '17:00'], ['08:00', '12:00']]])
            ->assertOk()
            ->assertJsonPath('opening_hours.mon', [['08:00', '12:00'], ['13:00', '17:00']]);
    }

    public function test_admins_set_hours_only_on_buildings_without_a_department(): void
    {
        $owned = Building::factory()->create();
        $this->staffOf($owned);
        $unowned = Building::factory()->create(['department_id' => null]);
        Sanctum::actingAs(User::factory()->create(['role' => 'admin']));

        $this->putJson("/api/buildings/{$owned->id}", ['opening_hours' => self::MON_SAT])->assertForbidden();
        $this->putJson("/api/buildings/{$unowned->id}", ['opening_hours' => self::MON_SAT])->assertOk();
    }

    public function test_staff_cannot_set_hours_on_another_departments_building(): void
    {
        $building = Building::factory()->create();
        $this->staffOf($building);
        Sanctum::actingAs(User::factory()->create(['role' => 'faculty', 'department_id' => Department::factory()->create()->id]));

        $this->putJson("/api/buildings/{$building->id}", ['opening_hours' => self::MON_SAT])->assertForbidden();
    }

    public function test_a_place_in_the_building_gets_its_own_hours(): void
    {
        $building = Building::factory()->create();
        $staff = $this->staffOf($building);
        $p = $building->polygon[0];
        $cashier = Node::create([
            'name' => 'Cashier', 'type' => 'location', 'latitude' => $p['lat'], 'longitude' => $p['lng'],
            'floor_level' => 0, 'path_type' => 'inside', 'building_id' => $building->id, 'department_id' => $staff->department_id,
        ]);
        Sanctum::actingAs($staff);

        $this->putJson("/api/nodes/{$cashier->id}", ['opening_hours' => ['mon' => [['08:00', '12:00'], ['13:00', '16:00']]]])
            ->assertOk()
            ->assertJsonPath('opening_hours.mon.1', ['13:00', '16:00']);
        $this->getJson('/api/map-data')->assertJsonPath('nodes.0.opening_hours.mon.0', ['08:00', '12:00']);
    }

    public function test_offices_have_no_courses(): void
    {
        $office = Department::factory()->office()->create();
        Sanctum::actingAs(User::factory()->create(['role' => 'admin']));

        $this->postJson('/api/courses', ['code' => 'BSACC', 'name' => 'Accounting', 'department_id' => $office->id])
            ->assertUnprocessable();

        $college = Department::factory()->create();
        Course::create(['code' => 'BSX', 'name' => 'X', 'department_id' => $college->id]);
        $this->putJson("/api/departments/{$college->id}", ['kind' => 'office'])->assertUnprocessable();

        $this->postJson('/api/departments', ['name' => 'Registrar', 'kind' => 'office', 'color' => '#336699'])
            ->assertCreated()
            ->assertJsonPath('kind', 'office');
        $this->postJson('/api/departments', ['name' => 'Club', 'kind' => 'club', 'color' => '#336699'])
            ->assertUnprocessable()
            ->assertInvalid('kind');
    }
}
