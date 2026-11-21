<?php

namespace Tests\Feature;

use App\Models\User;
use Database\Seeders\StudentSeeder;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Hash;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

class StudentAccountsTest extends TestCase
{
    use RefreshDatabase;

    private function payload(array $overrides = []): array
    {
        return array_merge([
            'student_number' => 'AE202401622',
            'first_name' => 'Kristine Mae',
            'last_name' => 'Alvarez',
            'course' => 'BSIT',
            'year_level' => 2,
            'password' => 'password123',
        ], $overrides);
    }

    public function test_admin_creates_a_student_and_the_email_comes_from_the_school_id(): void
    {
        config(['app.student_email_domain' => 'wmsu.edu.ph']);
        Sanctum::actingAs(User::factory()->create(['role' => 'admin']));

        $this->postJson('/api/students', $this->payload())
            ->assertCreated()
            ->assertJsonPath('student_number', 'ae202401622')
            ->assertJsonPath('email', 'ae202401622@wmsu.edu.ph')
            ->assertJsonPath('name', 'Kristine Mae Alvarez')
            ->assertJsonPath('course_name', 'Bachelor of Science in Information Technology');

        $student = User::where('student_number', 'ae202401622')->firstOrFail();
        $this->assertTrue($student->isStudent());
        $this->assertTrue(Hash::check('password123', $student->password));
    }

    public function test_school_id_course_and_year_are_validated(): void
    {
        Sanctum::actingAs(User::factory()->create(['role' => 'admin']));

        $this->postJson('/api/students', $this->payload(['student_number' => '2024-01622', 'course' => 'BSXYZ', 'year_level' => 9, 'password' => 'short']))
            ->assertUnprocessable()
            ->assertInvalid(['student_number', 'course', 'year_level', 'password']);
    }

    public function test_school_id_must_be_unique(): void
    {
        Sanctum::actingAs(User::factory()->create(['role' => 'admin']));
        User::factory()->student()->create(['student_number' => 'ae202401622', 'email' => 'ae202401622@wmsu.edu.ph']);

        $this->postJson('/api/students', $this->payload())->assertUnprocessable()->assertInvalid('student_number');
    }

    public function test_admin_edits_a_student_and_can_reset_the_password(): void
    {
        Sanctum::actingAs(User::factory()->create(['role' => 'admin']));
        $student = User::factory()->student()->create();

        $this->putJson("/api/students/{$student->id}", ['year_level' => 3, 'course' => 'BSN', 'password' => 'new-password'])
            ->assertOk()
            ->assertJsonPath('year_level', 3)
            ->assertJsonPath('course', 'BSN');

        $this->assertTrue(Hash::check('new-password', $student->fresh()->password));
    }

    public function test_blank_password_on_edit_keeps_the_old_one(): void
    {
        Sanctum::actingAs(User::factory()->create(['role' => 'admin']));
        $student = User::factory()->student()->create();
        $hash = $student->password;

        $this->putJson("/api/students/{$student->id}", ['first_name' => 'Rafael', 'password' => null])->assertOk();

        $this->assertSame($hash, $student->fresh()->password);
        $this->assertStringStartsWith('Rafael ', $student->fresh()->name);
    }

    public function test_admin_removes_a_student(): void
    {
        Sanctum::actingAs(User::factory()->create(['role' => 'admin']));
        $student = User::factory()->student()->create();

        $this->deleteJson("/api/students/{$student->id}")->assertOk();
        $this->assertModelMissing($student);
    }

    public function test_student_endpoints_refuse_staff_accounts(): void
    {
        Sanctum::actingAs(User::factory()->create(['role' => 'admin']));
        $faculty = User::factory()->create(['role' => 'faculty']);

        $this->putJson("/api/students/{$faculty->id}", ['year_level' => 2])->assertNotFound();
        $this->deleteJson("/api/students/{$faculty->id}")->assertNotFound();
    }

    public function test_faculty_cannot_manage_students(): void
    {
        Sanctum::actingAs(User::factory()->create(['role' => 'faculty']));

        $this->getJson('/api/students')->assertForbidden();
        $this->postJson('/api/students', $this->payload())->assertForbidden();
    }

    public function test_students_cannot_sign_in_to_the_admin_console(): void
    {
        User::factory()->student()->create(['email' => 'ae202401622@wmsu.edu.ph', 'password' => Hash::make('password')]);

        $this->postJson('/api/login', ['email' => 'ae202401622@wmsu.edu.ph', 'password' => 'password'])
            ->assertUnprocessable()
            ->assertInvalid('email');
    }

    public function test_each_sign_in_is_throttled_after_ten_attempts_a_minute(): void
    {
        foreach (['/api/login', '/api/student/login'] as $url) {
            for ($i = 0; $i < 10; $i++) {
                $this->postJson($url, ['email' => 'nobody@campus.test', 'student_number' => 'x', 'password' => 'wrong'])
                    ->assertStatus(422);
            }
            $this->postJson($url, ['email' => 'nobody@campus.test', 'student_number' => 'x', 'password' => 'wrong'])
                ->assertStatus(429);
        }

        // Reads have their own counter: a throttled sign-in does not block the map.
        $this->getJson('/api/map-data')->assertOk();
    }

    public function test_successful_sign_ins_from_one_address_are_never_throttled(): void
    {
        // Many phones can share one public address (mobile carriers): only failed tries count.
        User::factory()->student()->create(['student_number' => 'ae202401622', 'email' => 'ae202401622@wmsu.edu.ph', 'password' => Hash::make('password')]);

        for ($i = 0; $i < 12; $i++) {
            $this->postJson('/api/student/login', ['login' => 'ae202401622', 'password' => 'password'])->assertOk();
        }
    }

    public function test_a_student_token_cannot_reach_admin_endpoints(): void
    {
        Sanctum::actingAs(User::factory()->student()->create());

        $this->getJson('/api/nodes')->assertForbidden();
        $this->postJson('/api/borders', ['latitude' => 6.9, 'longitude' => 122.0, 'group_id' => 1])->assertForbidden();
        $this->getJson('/api/students')->assertForbidden();
    }

    public function test_staff_accounts_list_leaves_students_out(): void
    {
        Sanctum::actingAs(User::factory()->create(['role' => 'admin']));
        User::factory()->student()->create();

        $this->getJson('/api/users')->assertOk()->assertJsonCount(1);
        $this->getJson('/api/students')->assertOk()->assertJsonCount(1);
    }

    public function test_seeder_adds_one_student_per_course_and_is_rerunnable(): void
    {
        $this->seed(StudentSeeder::class);
        $this->seed(StudentSeeder::class);

        $this->assertSame(3, User::where('role', 'student')->count());
        $this->assertEqualsCanonicalizing(['BSIT', 'CSM', 'BSN'], User::where('role', 'student')->with('course')->get()->pluck('course.code')->all());
        $this->assertSame('BSIT', User::where('student_number', 'ae202401622')->first()->course->code);
    }
}
