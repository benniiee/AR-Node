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
 * Doors: with doors a building is a wall with gaps, and routes go in and
 * out only through a door. Same layout as src/doors.test.mjs, so the
 * phone's router (src/doors.js) has them.
 */
class BuildingDoorsTest extends TestCase
{
    use RefreshDatabase;

    private const LAT = 6.913;

    private const LNG = 122.061;

    /** @return array{lat: float, lng: float} */
    private function at(float $eastM, float $northM): array
    {
        return [
            'lat' => self::LAT + $northM / 111320,
            'lng' => self::LNG + $eastM / (111320 * cos(deg2rad(self::LAT))),
        ];
    }

    private function node(float $east, float $north, string $type = 'route', ?string $name = null, string $pathType = 'outside'): Node
    {
        $p = $this->at($east, $north);

        return Node::create([
            'name' => $name, 'type' => $type, 'latitude' => $p['lat'], 'longitude' => $p['lng'],
            'elevation' => 0, 'floor_level' => 0, 'path_type' => $pathType,
        ]);
    }

    /** A 30 m x 30 m building, south wall 20 m north of the walker. */
    private function building(array $doors = []): Building
    {
        return Building::factory()->create(['polygon' => [
            $this->at(-15, 20), $this->at(15, 20), $this->at(15, 50), $this->at(-15, 50),
        ], 'doors' => $doors]);
    }

    public function test_admin_saves_doors_and_the_map_feed_carries_them(): void
    {
        Sanctum::actingAs(User::factory()->create(['role' => 'admin']));
        $building = $this->building();

        $this->putJson("/api/buildings/{$building->id}", ['doors' => [$this->at(0, 20) + ['junk' => 1]]])
            ->assertOk()
            ->assertJsonCount(1, 'doors');
        $this->assertSame(['lat', 'lng'], array_keys($building->fresh()->doors[0]));
        $this->getJson('/api/map-data')->assertJsonPath('buildings.0.doors.0.lat', $building->fresh()->doors[0]['lat']);

        $this->putJson("/api/buildings/{$building->id}", ['doors' => array_fill(0, Building::MAX_DOORS + 1, $this->at(0, 20))])
            ->assertUnprocessable()
            ->assertInvalid('doors');
        $this->putJson("/api/buildings/{$building->id}", ['doors' => []])->assertOk();
        $this->assertNull($building->fresh()->doors);
    }

    public function test_a_door_width_is_saved_and_range_checked(): void
    {
        Sanctum::actingAs(User::factory()->create(['role' => 'admin']));
        $building = $this->building();

        $this->putJson("/api/buildings/{$building->id}", ['doors' => [$this->at(0, 20) + ['width_m' => 1.234]]])
            ->assertOk()
            ->assertJsonPath('doors.0.width_m', 1.23);
        $this->putJson("/api/buildings/{$building->id}", ['doors' => [$this->at(0, 20) + ['width_m' => 10]]])
            ->assertUnprocessable()
            ->assertInvalid('doors.0.width_m');
        // The gap a door cuts into its wall is drawn and routed on the phone (src/doors.test.mjs).
    }

    public function test_doors_of_a_department_building_are_managed_by_its_staff_not_admins(): void
    {
        $department = Department::factory()->create();
        $building = $this->building();
        $building->update(['department_id' => $department->id]);
        $door = [$this->at(0, 20)];

        Sanctum::actingAs(User::factory()->create(['role' => 'admin']));
        $this->putJson("/api/buildings/{$building->id}", ['doors' => $door])->assertForbidden();
        // The admin can still edit the rest of it.
        $this->putJson("/api/buildings/{$building->id}", ['name' => 'Renamed'])->assertOk();

        Sanctum::actingAs(User::factory()->create(['role' => 'faculty', 'department_id' => $department->id]));
        $this->putJson("/api/buildings/{$building->id}", ['doors' => $door])->assertOk()->assertJsonCount(1, 'doors');

        Sanctum::actingAs(User::factory()->create(['role' => 'faculty', 'department_id' => Department::factory()->create()->id]));
        $this->putJson("/api/buildings/{$building->id}", ['doors' => []])->assertForbidden();
    }

    public function test_moving_a_building_moves_its_doors(): void
    {
        Sanctum::actingAs(User::factory()->create(['role' => 'admin']));
        $door = $this->at(0, 20);
        $building = $this->building([$door]);

        $this->putJson("/api/buildings/{$building->id}", [
            'polygon' => $building->polygon,
            'move_nodes_by' => ['lat' => 0.0001, 'lng' => 0],
        ])->assertOk();

        $this->assertEqualsWithDelta($door['lat'] + 0.0001, $building->fresh()->doors[0]['lat'], 1e-7);
    }
}
