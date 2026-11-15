<?php

namespace Tests\Feature;

use App\Models\Node;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

class MultiAdminTest extends TestCase
{
    use RefreshDatabase;

    public function test_an_admin_can_create_another_admin_who_can_manage_the_map(): void
    {
        Sanctum::actingAs(User::factory()->create(['role' => 'admin']));

        $this->postJson('/api/users', [
            'name' => 'Second Admin',
            'email' => 'second.admin@campus.test',
            'password' => 'password123',
            'role' => 'admin',
        ])->assertCreated()->assertJsonPath('role', 'admin');

        $second = User::where('email', 'second.admin@campus.test')->firstOrFail();
        Sanctum::actingAs($second);

        $this->getJson('/api/users')->assertOk()->assertJsonCount(2);
    }

    public function test_an_admin_can_demote_another_admin(): void
    {
        $first = User::factory()->create(['role' => 'admin']);
        $second = User::factory()->create(['role' => 'admin']);
        Sanctum::actingAs($first);

        $this->putJson("/api/users/{$second->id}", ['role' => 'faculty'])
            ->assertOk()
            ->assertJsonPath('role', 'faculty');
    }

    public function test_an_admin_can_remove_another_account_and_its_nodes_stay(): void
    {
        $admin = User::factory()->create(['role' => 'admin']);
        $faculty = User::factory()->create(['role' => 'faculty']);
        $node = new Node(['type' => 'route', 'latitude' => 6.9131, 'longitude' => 122.0611, 'path_type' => 'outside']);
        $node->created_by = $faculty->id;
        $node->save();
        Sanctum::actingAs($admin);

        $this->deleteJson("/api/users/{$faculty->id}")->assertOk();

        $this->assertModelMissing($faculty);
        $this->assertNull($node->fresh()->created_by);
    }

    public function test_an_admin_cannot_remove_their_own_account(): void
    {
        $admin = User::factory()->create(['role' => 'admin']);
        User::factory()->create(['role' => 'admin']);
        Sanctum::actingAs($admin);

        $this->deleteJson("/api/users/{$admin->id}")->assertStatus(422);
        $this->assertModelExists($admin);
    }

    public function test_staff_emails_ignore_case_at_sign_up_and_sign_in(): void
    {
        Sanctum::actingAs(User::factory()->create(['role' => 'admin']));
        $this->postJson('/api/users', ['name' => 'Juan', 'email' => 'Juan@School.edu', 'password' => 'secret-pass'])
            ->assertCreated()
            ->assertJsonPath('email', 'juan@school.edu');
        $this->postJson('/api/users', ['name' => 'Juan again', 'email' => 'JUAN@school.edu', 'password' => 'secret-pass'])
            ->assertInvalid('email');

        $this->app['auth']->shouldUse('web'); // back to the sign-in guard Sanctum::actingAs replaced
        $this->postJson('/api/login', ['email' => 'JUAN@School.EDU', 'password' => 'secret-pass'])->assertOk();
    }

    public function test_faculty_cannot_remove_accounts(): void
    {
        $other = User::factory()->create(['role' => 'faculty']);
        Sanctum::actingAs(User::factory()->create(['role' => 'faculty']));

        $this->deleteJson("/api/users/{$other->id}")->assertForbidden();
    }
}
