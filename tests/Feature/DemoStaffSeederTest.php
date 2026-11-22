<?php

namespace Tests\Feature;

use App\Models\Building;
use App\Models\Department;
use App\Models\User;
use Database\Seeders\DatabaseSeeder;
use Database\Seeders\DemoStaffSeeder;
use Database\Seeders\StudentSeeder;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class DemoStaffSeederTest extends TestCase
{
    use RefreshDatabase;

    public function test_it_seeds_department_staff_into_existing_departments_and_is_rerunnable(): void
    {
        $ccs = Department::factory()->create(['name' => 'CCS']);

        $this->seed(DemoStaffSeeder::class);
        $this->seed(DemoStaffSeeder::class);

        $this->assertSame(count(DemoStaffSeeder::STAFF), User::where('role', 'faculty')->count());
        $this->assertSame(count(DemoStaffSeeder::STAFF), Department::count());
        $this->assertSame($ccs->id, User::where('email', 'ccs.staff@campus.test')->value('department_id'));
        $this->assertNotNull(User::where('email', 'csm.staff@campus.test')->value('department_id'));
        $this->assertSame('office', Department::where('name', 'Canteen')->value('kind'));
    }

    public function test_it_hands_unowned_buildings_to_their_department_and_resets_demo_passwords(): void
    {
        $canteen = Building::factory()->create(['name' => 'Canteen', 'department_id' => null, 'category' => 'school']);
        $other = Department::factory()->create(['name' => 'Someone else']);
        $taken = Building::factory()->create(['name' => 'ILS', 'department_id' => $other->id]);
        $this->seed(DemoStaffSeeder::class);

        $this->assertSame(Department::where('name', 'Canteen')->value('id'), $canteen->fresh()->department_id);
        $this->assertSame('office', $canteen->fresh()->category, 'an office owns it: an office building');
        $this->assertSame($other->id, $taken->fresh()->department_id, 'a real assignment is never undone');

        // A changed demo password goes back to "password" on the next run.
        User::where('email', 'canteen@campus.test')->first()->forceFill(['password' => 'changed-it'])->save();
        $this->seed(DemoStaffSeeder::class);
        $this->postJson('/api/login', ['email' => 'canteen@campus.test', 'password' => 'password'])->assertOk();
    }

    public function test_a_seeded_staff_account_can_sign_in_and_edit_its_departments_building(): void
    {
        $this->seed(DemoStaffSeeder::class);
        $staff = User::where('email', 'ccs.staff@campus.test')->firstOrFail();
        $building = Building::factory()->create(['department_id' => $staff->department_id]);

        $token = $this->postJson('/api/login', ['email' => 'ccs.staff@campus.test', 'password' => 'password'])
            ->assertOk()
            ->json('token');

        $this->withToken($token)
            ->putJson("/api/buildings/{$building->id}", ['name' => 'CCS Annex'])
            ->assertOk()
            ->assertJsonPath('name', 'CCS Annex');
    }

    public function test_no_seeder_creates_demo_accounts_in_production(): void
    {
        $this->app->detectEnvironment(fn (): string => 'production');

        // --force skips Laravel's own "are you sure?" prompt: the seeders must still refuse.
        foreach ([DatabaseSeeder::class, StudentSeeder::class, DemoStaffSeeder::class] as $seeder) {
            $this->artisan('db:seed', ['--class' => $seeder, '--force' => true])->assertSuccessful();
        }

        $this->assertSame(0, User::count());
    }
}
