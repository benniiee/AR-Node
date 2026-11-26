<?php

namespace Tests\Feature;

use App\Models\Building;
use App\Models\Department;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

/**
 * Building Studio, outside: who may change how a building looks, what is accepted, and that the
 * map everyone loads carries it.
 */
class BuildingAppearanceTest extends TestCase
{
    use RefreshDatabase;

    /** @var array<string, mixed> */
    private const LOOK = [
        'roof' => ['style' => 'curved', 'color' => '#7a2430'],
        'walls' => ['color' => '#f1eee7', 'accent' => '#7a2430'],
        'facade' => 'pillars',
        'entrance' => ['canopy' => true, 'color' => '#7a2430', 'sign' => 'COLLEGE OF COMPUTING STUDIES', 'ramp' => true],
    ];

    private function headOf(Department $department): User
    {
        return User::factory()->create(['role' => 'faculty', 'department_id' => $department->id, 'is_head' => true]);
    }

    public function test_the_building_head_sets_how_it_looks_and_the_map_carries_it(): void
    {
        $ccs = Department::factory()->create();
        $building = Building::factory()->create(['department_id' => $ccs->id]);
        Sanctum::actingAs($this->headOf($ccs));

        $this->putJson("/api/buildings/{$building->id}", ['appearance' => self::LOOK])
            ->assertOk()
            ->assertJsonPath('appearance.roof.style', 'curved')
            ->assertJsonPath('appearance.entrance.sign', 'COLLEGE OF COMPUTING STUDIES');

        $this->getJson('/api/map-data')->assertOk()->assertJsonPath('buildings.0.appearance.facade', 'pillars');

        // Back to the plain look.
        $this->putJson("/api/buildings/{$building->id}", ['appearance' => null])->assertOk()->assertJsonPath('appearance', null);
    }

    public function test_only_known_styles_colours_and_keys_are_accepted(): void
    {
        $ccs = Department::factory()->create();
        $building = Building::factory()->create(['department_id' => $ccs->id]);
        Sanctum::actingAs($this->headOf($ccs));

        $this->putJson("/api/buildings/{$building->id}", ['appearance' => ['roof' => ['style' => 'dome']]])->assertInvalid(['appearance.roof.style']);
        $this->putJson("/api/buildings/{$building->id}", ['appearance' => ['walls' => ['color' => 'red']]])->assertInvalid(['appearance.walls.color']);
        $this->putJson("/api/buildings/{$building->id}", ['appearance' => ['facade' => 'windows', 'script' => '<b>']])->assertInvalid(['appearance']);
        $this->putJson("/api/buildings/{$building->id}", ['appearance' => ['entrance' => ['sign' => str_repeat('A', Building::SIGN_MAX + 1)]]])
            ->assertInvalid(['appearance.entrance.sign']);
        $this->assertNull($building->fresh()->appearance);
    }

    public function test_an_admin_styles_only_buildings_no_department_runs(): void
    {
        $ccs = Department::factory()->create();
        $owned = Building::factory()->create(['department_id' => $ccs->id]);
        $shared = Building::factory()->create(['department_id' => null]);
        Sanctum::actingAs(User::factory()->create(['role' => 'admin']));

        $this->putJson("/api/buildings/{$owned->id}", ['appearance' => self::LOOK])->assertForbidden();
        $this->putJson("/api/buildings/{$shared->id}", ['appearance' => self::LOOK])->assertOk();
    }

    public function test_office_staff_and_other_departments_cannot_change_it(): void
    {
        $ccs = Department::factory()->create();
        $building = Building::factory()->create(['department_id' => $ccs->id]);

        Sanctum::actingAs(User::factory()->create(['role' => 'faculty', 'department_id' => $ccs->id, 'is_head' => false]));
        $this->putJson("/api/buildings/{$building->id}", ['appearance' => self::LOOK])->assertForbidden();

        Sanctum::actingAs($this->headOf(Department::factory()->create()));
        $this->putJson("/api/buildings/{$building->id}", ['appearance' => self::LOOK])->assertForbidden();

        $this->assertNull($building->fresh()->appearance);
    }
}
