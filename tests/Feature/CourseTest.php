<?php

namespace Tests\Feature;

use App\Models\Course;
use App\Models\Department;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

class CourseTest extends TestCase
{
    use RefreshDatabase;

    public function test_the_starting_courses_exist_after_migrating(): void
    {
        $this->assertEqualsCanonicalizing(['BSIT', 'CSM', 'BSN'], Course::pluck('code')->all());
    }

    public function test_department_staff_add_courses_to_their_own_department_only(): void
    {
        $ccs = Department::factory()->create();
        $other = Department::factory()->create();
        Sanctum::actingAs(User::factory()->create(['role' => 'faculty', 'department_id' => $ccs->id]));

        // Asking for another department changes nothing: staff file courses under their own.
        $this->postJson('/api/courses', ['code' => ' bscs ', 'name' => 'Bachelor of Science in Computer Science', 'department_id' => $other->id])
            ->assertCreated()->assertJsonPath('code', 'BSCS')->assertJsonPath('department_id', $ccs->id);
    }

    public function test_department_staff_see_rename_and_remove_only_their_own_courses(): void
    {
        $ccs = Department::factory()->create();
        $mine = Course::factory()->create(['department_id' => $ccs->id]);
        $theirs = Course::factory()->create(['department_id' => Department::factory()->create()->id]);
        Sanctum::actingAs(User::factory()->create(['role' => 'faculty', 'department_id' => $ccs->id]));

        $this->getJson('/api/courses')->assertOk()->assertJsonCount(1)->assertJsonPath('0.id', $mine->id);
        $this->putJson("/api/courses/{$mine->id}", ['name' => 'Renamed'])->assertOk()->assertJsonPath('name', 'Renamed');
        $this->putJson("/api/courses/{$theirs->id}", ['name' => 'Nope'])->assertForbidden();
        $this->deleteJson("/api/courses/{$theirs->id}")->assertForbidden();
        $this->deleteJson("/api/courses/{$mine->id}")->assertOk();
        $this->assertModelMissing($mine);
    }

    public function test_staff_without_a_department_cannot_add_courses(): void
    {
        Sanctum::actingAs(User::factory()->create(['role' => 'faculty']));

        $this->postJson('/api/courses', ['code' => 'BSCS', 'name' => 'CS'])->assertForbidden();
        $this->getJson('/api/courses')->assertOk()->assertJsonCount(0);
    }

    public function test_admins_manage_every_course_and_choose_its_department(): void
    {
        $dept = Department::factory()->create();
        Sanctum::actingAs(User::factory()->create(['role' => 'admin']));

        $this->getJson('/api/courses')->assertOk()->assertJsonCount(3);
        $bsit = Course::where('code', 'BSIT')->first();
        $this->putJson("/api/courses/{$bsit->id}", ['department_id' => $dept->id])->assertOk()->assertJsonPath('department.id', $dept->id);
    }

    public function test_codes_are_unique_and_short(): void
    {
        Sanctum::actingAs(User::factory()->create(['role' => 'admin']));

        $this->postJson('/api/courses', ['code' => 'bsit', 'name' => 'Duplicate'])->assertUnprocessable()->assertInvalid(['code']);
        $this->postJson('/api/courses', ['code' => 'B S', 'name' => 'Bad'])->assertUnprocessable()->assertInvalid(['code']);
    }

    public function test_a_course_with_students_cannot_be_removed(): void
    {
        $course = Course::factory()->create();
        User::factory()->student()->create(['course_id' => $course->id]);
        Sanctum::actingAs(User::factory()->create(['role' => 'admin']));

        $this->deleteJson("/api/courses/{$course->id}")->assertUnprocessable()->assertJsonPath('message', "1 student is in {$course->code}. Move them to another course first.");
        $this->assertModelExists($course);
    }

    public function test_admins_add_students_to_any_course_from_the_table(): void
    {
        $course = Course::factory()->create(['code' => 'BSCS']);
        Sanctum::actingAs(User::factory()->create(['role' => 'admin']));

        $this->postJson('/api/students', [
            'student_number' => 'ae202409999', 'first_name' => 'Ana', 'last_name' => 'Cruz', 'course' => 'BSCS', 'year_level' => 1, 'password' => 'password123',
        ])->assertCreated()->assertJsonPath('course', 'BSCS')->assertJsonPath('course_name', $course->name);
        $this->assertSame($course->id, User::where('student_number', 'ae202409999')->value('course_id'));

        $this->postJson('/api/students', [
            'student_number' => 'ae202409998', 'first_name' => 'Ben', 'last_name' => 'Cruz', 'course' => 'NOPE', 'year_level' => 1, 'password' => 'password123',
        ])->assertUnprocessable()->assertInvalid(['course']);
    }

    public function test_removing_a_department_keeps_its_courses_unassigned(): void
    {
        $dept = Department::factory()->create();
        $course = Course::factory()->create(['department_id' => $dept->id]);
        Sanctum::actingAs(User::factory()->create(['role' => 'admin']));

        $this->deleteJson("/api/departments/{$dept->id}")->assertOk();

        $this->assertNull($course->fresh()->department_id);
    }
}
