<?php

namespace Tests\Feature;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Hash;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

class StudentPasswordResetTest extends TestCase
{
    use RefreshDatabase;

    public function test_admin_reset_gives_a_temporary_password_and_ends_open_sessions(): void
    {
        $student = User::factory()->student()->create();
        $student->createToken('student-map');
        Sanctum::actingAs(User::factory()->create(['role' => 'admin']));

        $response = $this->postJson("/api/students/{$student->id}/reset-password")
            ->assertOk()
            ->assertJsonPath('student.must_change_password', true);

        $temporary = $response->json('temporary_password');
        $this->assertMatchesRegularExpression('/^[a-z2-9]{5}-[a-z2-9]{5}$/', $temporary);

        $student->refresh();
        $this->assertTrue(Hash::check($temporary, $student->password));
        $this->assertTrue($student->must_change_password);
        $this->assertSame(0, $student->tokens()->count());
    }

    public function test_only_admins_can_reset_a_student_password(): void
    {
        $student = User::factory()->student()->create();
        Sanctum::actingAs(User::factory()->create(['role' => 'faculty']));

        $this->postJson("/api/students/{$student->id}/reset-password")->assertForbidden();
        $this->assertFalse((bool) $student->refresh()->must_change_password);
    }

    public function test_the_student_signs_in_with_the_temporary_password_and_must_choose_a_new_one(): void
    {
        $student = User::factory()->student()->create(['password' => Hash::make('temp1-pass2'), 'must_change_password' => true]);

        $login = $this->postJson('/api/student/login', ['login' => $student->student_number, 'password' => 'temp1-pass2'])
            ->assertOk()
            ->assertJsonPath('user.must_change_password', true);

        $this->withToken($login->json('token'))
            ->postJson('/api/student/password', [
                'current_password' => 'temp1-pass2',
                'password' => 'my-own-pass',
                'password_confirmation' => 'my-own-pass',
            ])
            ->assertOk()
            ->assertJsonPath('user.must_change_password', false);

        $student->refresh();
        $this->assertTrue(Hash::check('my-own-pass', $student->password));
        $this->assertFalse($student->must_change_password);
    }

    public function test_changing_the_password_needs_the_current_one_and_a_new_value(): void
    {
        $student = User::factory()->student()->create(['password' => Hash::make('temp1-pass2'), 'must_change_password' => true]);
        Sanctum::actingAs($student);

        $this->postJson('/api/student/password', [
            'current_password' => 'wrong',
            'password' => 'my-own-pass',
            'password_confirmation' => 'my-own-pass',
        ])->assertUnprocessable()->assertJsonValidationErrors('current_password');

        $this->postJson('/api/student/password', [
            'current_password' => 'temp1-pass2',
            'password' => 'temp1-pass2',
            'password_confirmation' => 'temp1-pass2',
        ])->assertUnprocessable()->assertJsonValidationErrors('password');

        $this->assertTrue($student->refresh()->must_change_password);
    }
}
