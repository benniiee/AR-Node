<?php

namespace Tests\Feature;

use App\Models\CampusArea;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

class CampusAreaTest extends TestCase
{
    use RefreshDatabase;

    /** @return array<int, array{lat: float, lng: float}> */
    private function square(): array
    {
        return [
            ['lat' => 6.9090, 'lng' => 122.0700], ['lat' => 6.9090, 'lng' => 122.0720],
            ['lat' => 6.9110, 'lng' => 122.0720], ['lat' => 6.9110, 'lng' => 122.0700],
        ];
    }

    public function test_admin_draws_renames_and_removes_a_campus_area(): void
    {
        Sanctum::actingAs(User::factory()->create(['role' => 'admin']));

        $id = $this->postJson('/api/campus-areas', ['name' => 'Campus A', 'color' => '#22c55e', 'polygon' => $this->square()])
            ->assertCreated()
            ->assertJsonPath('name', 'Campus A')
            ->json('id');

        $this->putJson("/api/campus-areas/{$id}", ['name' => 'Main campus'])->assertOk()->assertJsonPath('name', 'Main campus');
        $this->deleteJson("/api/campus-areas/{$id}")->assertOk();
        $this->assertDatabaseMissing('campus_areas', ['id' => $id]);
    }

    public function test_faculty_can_read_but_not_edit_campus_areas(): void
    {
        $area = CampusArea::factory()->create();
        Sanctum::actingAs(User::factory()->create(['role' => 'faculty']));

        $this->getJson('/api/campus-areas')->assertOk()->assertJsonCount(1);
        $this->postJson('/api/campus-areas', ['name' => 'Campus Z', 'polygon' => $this->square()])->assertForbidden();
        $this->putJson("/api/campus-areas/{$area->id}", ['name' => 'Renamed'])->assertForbidden();
        $this->deleteJson("/api/campus-areas/{$area->id}")->assertForbidden();
    }

    public function test_an_area_needs_three_corners_and_a_unique_name(): void
    {
        CampusArea::factory()->create(['name' => 'Campus A']);
        Sanctum::actingAs(User::factory()->create(['role' => 'admin']));

        $this->postJson('/api/campus-areas', ['name' => 'Campus B', 'polygon' => array_slice($this->square(), 0, 2)])
            ->assertUnprocessable()->assertJsonValidationErrors('polygon');
        $this->postJson('/api/campus-areas', ['name' => 'Campus A', 'polygon' => $this->square()])
            ->assertUnprocessable()->assertJsonValidationErrors('name');
    }

    public function test_membership_is_by_position(): void
    {
        $area = CampusArea::factory()->create(['polygon' => $this->square()]);

        $this->assertTrue($area->contains(6.9100, 122.0710));
        $this->assertFalse($area->contains(6.9120, 122.0710));
    }

    public function test_visitors_and_students_get_the_campus_outlines_in_the_map_feed(): void
    {
        CampusArea::factory()->create(['name' => 'Campus A']);

        $this->getJson('/api/map-data')->assertOk()->assertJsonPath('campus_areas.0.name', 'Campus A');

        Sanctum::actingAs(User::factory()->student()->create());
        $this->getJson('/api/map-data')->assertOk()->assertJsonPath('campus_areas.0.name', 'Campus A');
    }
}
