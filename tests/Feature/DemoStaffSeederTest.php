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
        $this->assertSame(count(array_unique(array_column(DemoStaffSeeder::STAFF, 'department'))), Department::count());
        $this->assertSame($ccs->id, User::where('email', 'ccs.dean@campus.test')->value('department_id'));
        // CCS: the Dean heads it; the IT and CS office staff are not heads.
        $this->assertTrue(User::where('email', 'ccs.dean@campus.test')->firstOrFail()->is_head);
        $this->assertSame([false, false], User::whereIn('email', ['ccs.it@campus.test', 'ccs.cs@campus.test'])->get()->pluck('is_head')->all());
        $this->assertSame([$ccs->id, $ccs->id], User::whereIn('email', ['ccs.it@campus.test', 'ccs.cs@campus.test'])->pluck('department_id')->all());
        $this->assertNotNull(User::where('email', 'csm.staff@campus.test')->value('department_id'));
        $this->assertSame('office', Department::where('name', 'Canteen')->value('kind'));
    }

    public function test_it_hands_unowned_buildings_to_their_department_and_resets_demo_passwords(): void
    {
        $canteen = Building::factory()->create(['name' => 'Canteen', 'department_id' => null, 'category' => 'school']);
        $upress = Building::factory()->create(['name' => 'UPress', 'department_id' => null, 'category' => 'school']);
        $other = Department::factory()->create(['name' => 'Someone else']);
        $taken = Building::factory()->create(['name' => 'ILS', 'department_id' => $other->id]);
        $this->seed(DemoStaffSeeder::class);

        $this->assertSame(Department::where('name', 'Canteen')->value('id'), $canteen->fresh()->department_id);
        $this->assertSame('office', $canteen->fresh()->category, 'an office owns it: an office building');
        $this->assertSame(Department::where('name', 'UPress')->value('id'), $upress->fresh()->department_id);
        $this->assertTrue(User::where('email', 'upress@campus.test')->firstOrFail()->is_head, 'UPress has its own head');
        $this->assertTrue(User::where('email', 'registrar@campus.test')->firstOrFail()->is_head, 'so has the Registrar');
        $this->assertSame($other->id, $taken->fresh()->department_id, 'a real assignment is never undone');

        // A changed demo password goes back to "password" on the next run.
        User::where('email', 'canteen@campus.test')->first()->forceFill(['password' => 'changed-it'])->save();
        $this->seed(DemoStaffSeeder::class);
        $this->postJson('/api/login', ['email' => 'canteen@campus.test', 'password' => 'password'])->assertOk();
    }

    public function test_a_seeded_staff_account_can_sign_in_and_edit_its_departments_building(): void
    {
        $this->seed(DemoStaffSeeder::class);
        $staff = User::where('email', 'ccs.dean@campus.test')->firstOrFail();
        $building = Building::factory()->create(['department_id' => $staff->department_id]);

        $token = $this->postJson('/api/login', ['email' => 'ccs.dean@campus.test', 'password' => 'password'])
            ->assertOk()
            ->json('token');

        $this->withToken($token)
            ->putJson("/api/buildings/{$building->id}", ['name' => 'CCS Annex'])
            ->assertOk()
            ->assertJsonPath('name', 'CCS Annex');
    }

    public function test_the_old_ccs_staff_account_becomes_the_dean(): void
    {
        $old = User::factory()->create(['email' => 'ccs.staff@campus.test', 'name' => 'CCS Staff', 'role' => 'faculty']);

        $this->seed(DemoStaffSeeder::class);

        $this->assertSame('ccs.dean@campus.test', $old->fresh()->email);
        $this->assertSame('CCS Dean', $old->fresh()->name);
        $this->assertFalse(User::where('email', 'ccs.staff@campus.test')->exists());
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
