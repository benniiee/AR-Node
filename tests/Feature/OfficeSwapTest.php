<?php

namespace Tests\Feature;

use App\Models\Department;
use App\Models\Node;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

class OfficeSwapTest extends TestCase
{
    use RefreshDatabase;

    private function office(string $name, ?Department $department, array $overrides = []): Node
    {
        $node = new Node(array_merge([
            'type' => 'location',
            'name' => $name,
            'latitude' => 6.9131,
            'longitude' => 122.0611,
            'floor_level' => 1,
            'path_type' => 'inside',
        ], $overrides));
        $node->department_id = $department?->id;
        $node->save();

        return $node;
    }

    public function test_admin_swaps_two_offices_names_and_departments_in_place(): void
    {
        Sanctum::actingAs(User::factory()->create(['role' => 'admin']));
        $registrar = Department::factory()->create();
        $cashier = Department::factory()->create();
        $a = $this->office('Registrar', $registrar, ['floor_level' => 1]);
        $b = $this->office('Cashier', $cashier, ['floor_level' => 2, 'latitude' => 6.9135]);

        $this->postJson('/api/nodes/swap', ['node_a_id' => $a->id, 'node_b_id' => $b->id])
            ->assertOk()
            ->assertJsonPath('nodes.0.name', 'Cashier')
            ->assertJsonPath('nodes.1.name', 'Registrar');

        $a->refresh();
        $b->refresh();
        $this->assertSame(['Cashier', $cashier->id, 1, 6.9131], [$a->name, $a->department_id, $a->floor_level, $a->latitude]);
        $this->assertSame(['Registrar', $registrar->id, 2, 6.9135], [$b->name, $b->department_id, $b->floor_level, $b->latitude]);
    }

    public function test_route_nodes_cannot_be_swapped(): void
    {
        Sanctum::actingAs(User::factory()->create(['role' => 'admin']));
        $a = $this->office('Registrar', null);
        $b = $this->office('', null, ['type' => 'route', 'name' => null]);

        $this->postJson('/api/nodes/swap', ['node_a_id' => $a->id, 'node_b_id' => $b->id])
            ->assertUnprocessable()
            ->assertInvalid('node_b_id');
    }

    public function test_a_node_cannot_be_swapped_with_itself(): void
    {
        Sanctum::actingAs(User::factory()->create(['role' => 'admin']));
        $a = $this->office('Registrar', null);

        $this->postJson('/api/nodes/swap', ['node_a_id' => $a->id, 'node_b_id' => $a->id])
            ->assertUnprocessable()
            ->assertInvalid('node_b_id');
    }

    public function test_faculty_cannot_swap_offices(): void
    {
        $department = Department::factory()->create();
        Sanctum::actingAs(User::factory()->create(['role' => 'faculty', 'department_id' => $department->id]));
        $a = $this->office('Registrar', $department);
        $b = $this->office('Cashier', $department);

        $this->postJson('/api/nodes/swap', ['node_a_id' => $a->id, 'node_b_id' => $b->id])->assertForbidden();
        $this->assertSame('Registrar', $a->fresh()->name);
    }
}
