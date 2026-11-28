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
        'roof' => ['style' => 'gable', 'color' => '#7a2430', 'material' => 'metal'],
        'walls' => ['color' => '#f1eee7', 'accent' => '#7a2430', 'band' => '#e3957a'],
        'facade' => 'pillars',
        'windows' => ['awning' => true, 'frame' => '#2f6fb3'],
        'entrance' => [
            'canopy' => true, 'canopyShape' => 'curved', 'color' => '#7a2430', 'sign' => 'COLLEGE OF COMPUTING STUDIES',
            'ramp' => true, 'steps' => true, 'door' => 'sliding', 'doorColor' => '#26404f',
        ],
        'decor' => ['planters' => true, 'ac' => true, 'tank' => true, 'bunting' => true],
        'items' => [
            [
                'id' => 'it_win1', 'type' => 'window_standard', 'edge' => 0, 't' => 0.35, 'floor' => 1,
                'rx' => 0, 'rz' => 0, 'width_m' => 1.6, 'height_m' => 1.5, 'depth_m' => 0.16,
                'color' => '#1f2937', 'accent' => '#2f6fb3', 'awning' => true, 'label' => '',
            ],
        ],
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
            ->assertJsonPath('appearance.roof.style', 'gable')
            ->assertJsonPath('appearance.roof.material', 'metal')
            ->assertJsonPath('appearance.entrance.sign', 'COLLEGE OF COMPUTING STUDIES')
            ->assertJsonPath('appearance.entrance.door', 'sliding')
            ->assertJsonPath('appearance.windows.frame', '#2f6fb3')
            ->assertJsonPath('appearance.decor.tank', true)
            ->assertJsonPath('appearance.items.0.type', 'window_standard');

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
        $this->putJson("/api/buildings/{$building->id}", ['appearance' => ['roof' => ['material' => 'thatch']]])->assertInvalid(['appearance.roof.material']);
        $this->putJson("/api/buildings/{$building->id}", ['appearance' => ['entrance' => ['door' => 'trapdoor']]])->assertInvalid(['appearance.entrance.door']);
        $this->putJson("/api/buildings/{$building->id}", ['appearance' => ['decor' => ['flagpole' => true]]])->assertInvalid(['appearance.decor']);
        $this->putJson("/api/buildings/{$building->id}", ['appearance' => ['items' => [['id' => 'x', 'type' => 'unknown_gadget']]]])
            ->assertInvalid(['appearance.items.0.type']);
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
