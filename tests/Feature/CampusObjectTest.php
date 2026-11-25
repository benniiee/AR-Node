<?php

namespace Tests\Feature;

use App\Models\CampusObject;
use App\Models\User;
use App\Services\MapSnapshot;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

class CampusObjectTest extends TestCase
{
    use RefreshDatabase;

    public function test_admin_places_changes_and_removes_a_tree(): void
    {
        Sanctum::actingAs(User::factory()->create(['role' => 'admin']));

        $id = $this->postJson('/api/campus-objects', [
            'kind' => 'tree', 'latitude' => 6.91, 'longitude' => 122.07, 'height_m' => 7, 'width_m' => 6, 'form' => 'spreading', 'seed' => 42,
        ])->assertCreated()->assertJsonPath('form', 'spreading')->json('id');

        $this->putJson("/api/campus-objects/{$id}", ['height_m' => 9.5, 'seed' => 7])
            ->assertOk()->assertJsonPath('height_m', 9.5)->assertJsonPath('seed', 7);

        $this->deleteJson("/api/campus-objects/{$id}")->assertOk();
        $this->assertDatabaseMissing('campus_objects', ['id' => $id]);
    }

    public function test_only_a_tree_keeps_a_form(): void
    {
        Sanctum::actingAs(User::factory()->create(['role' => 'admin']));

        $this->postJson('/api/campus-objects', ['kind' => 'bench', 'latitude' => 6.91, 'longitude' => 122.07, 'form' => 'round'])
            ->assertCreated()->assertJsonPath('form', null);
    }

    public function test_kind_form_and_sizes_are_validated(): void
    {
        Sanctum::actingAs(User::factory()->create(['role' => 'admin']));

        $this->postJson('/api/campus-objects', ['kind' => 'statue', 'latitude' => 6.91, 'longitude' => 122.07])
            ->assertUnprocessable()->assertJsonValidationErrors('kind');
        $this->postJson('/api/campus-objects', ['kind' => 'tree', 'latitude' => 6.91, 'longitude' => 122.07, 'form' => 'cube'])
            ->assertUnprocessable()->assertJsonValidationErrors('form');
        $this->postJson('/api/campus-objects', ['kind' => 'tree', 'latitude' => 6.91, 'longitude' => 122.07, 'height_m' => 400])
            ->assertUnprocessable()->assertJsonValidationErrors('height_m');
        $this->postJson('/api/campus-objects', ['kind' => 'gate'])
            ->assertUnprocessable()->assertJsonValidationErrors(['latitude', 'longitude']);
    }

    public function test_faculty_can_read_but_not_place_objects(): void
    {
        $tree = CampusObject::factory()->create();
        Sanctum::actingAs(User::factory()->create(['role' => 'faculty']));

        $this->getJson('/api/campus-objects')->assertOk()->assertJsonCount(1);
        $this->postJson('/api/campus-objects', ['kind' => 'tree', 'latitude' => 6.91, 'longitude' => 122.07])->assertForbidden();
        $this->putJson("/api/campus-objects/{$tree->id}", ['height_m' => 3])->assertForbidden();
        $this->deleteJson("/api/campus-objects/{$tree->id}")->assertForbidden();
    }

    public function test_objects_reach_students_and_visitors_with_the_map(): void
    {
        $tree = CampusObject::factory()->create(['seed' => 99]);
        CampusObject::factory()->gate()->create();

        $this->getJson('/api/map-data')->assertOk()
            ->assertJsonCount(2, 'objects')
            ->assertJsonPath('objects.0.id', $tree->id)
            ->assertJsonPath('objects.0.seed', 99);
        $this->assertSame(['tree', 'gate'], array_column(MapSnapshot::visitorPayload()['objects'], 'kind'));
    }
}
