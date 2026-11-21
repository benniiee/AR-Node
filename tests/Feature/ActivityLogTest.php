<?php

namespace Tests\Feature;

use App\Models\ActivityLog;
use App\Models\Course;
use App\Models\Department;
use App\Models\Node;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

class ActivityLogTest extends TestCase
{
    use RefreshDatabase;

    public function test_staff_and_student_sign_ins_are_logged_with_the_students_course_and_year(): void
    {
        $admin = User::factory()->create(['role' => 'admin', 'email' => 'boss@campus.test']);
        $student = User::factory()->student()->create(['course_id' => Course::where('code', 'BSIT')->value('id'), 'year_level' => 3]);

        $this->postJson('/api/login', ['email' => 'boss@campus.test', 'password' => 'password'])->assertOk();
        $this->postJson('/api/student/login', ['login' => $student->student_number, 'password' => 'password'])->assertOk();

        $this->assertDatabaseHas('activity_logs', ['user_id' => $admin->id, 'role' => 'admin', 'action' => 'login']);
        $this->assertDatabaseHas('activity_logs', [
            'user_id' => $student->id, 'role' => 'student', 'action' => 'login', 'name' => $student->name, 'course' => 'BSIT', 'year_level' => 3,
        ]);
    }

    public function test_a_failed_sign_in_is_not_logged_as_a_sign_in(): void
    {
        User::factory()->create(['role' => 'admin', 'email' => 'boss@campus.test']);

        $this->postJson('/api/login', ['email' => 'boss@campus.test', 'password' => 'wrong'])->assertUnprocessable();

        $this->assertDatabaseCount('activity_logs', 0);
    }

    public function test_every_staff_change_is_logged_with_what_was_changed_but_never_a_password(): void
    {
        $faculty = User::factory()->create(['role' => 'faculty']);
        $node = Node::create(['type' => 'route', 'latitude' => 6.913, 'longitude' => 122.061, 'floor_level' => 0, 'path_type' => 'outside', 'name' => 'Gate 3']);
        Sanctum::actingAs(User::factory()->create(['role' => 'admin']));

        $this->putJson("/api/nodes/{$node->id}", ['name' => 'Main gate'])->assertOk();
        $this->putJson("/api/users/{$faculty->id}", ['password' => 'new-secret-123'])->assertOk();
        // Reads are not changes.
        $this->getJson('/api/nodes')->assertOk();

        $edit = ActivityLog::where('action', 'PUT api/nodes/{node}')->sole();
        $this->assertSame("Edited node #{$node->id} (Main gate)", $edit->summary);
        $this->assertSame(['name'], $edit->details['fields']);
        $account = ActivityLog::where('action', 'PUT api/users/{user}')->sole();
        $this->assertStringStartsWith("Edited staff account #{$faculty->id}", $account->summary);
        $this->assertSame([], $account->details['fields'] ?? []);
        $this->assertStringNotContainsString('new-secret-123', json_encode(ActivityLog::all()));
        $this->assertSame(2, ActivityLog::count());
    }

    public function test_a_refused_change_is_not_logged(): void
    {
        Sanctum::actingAs(User::factory()->create(['role' => 'faculty']));

        $this->postJson('/api/departments', ['name' => 'X', 'color' => '#123456'])->assertForbidden();

        $this->assertDatabaseCount('activity_logs', 0);
    }

    public function test_a_visitor_opening_the_map_and_choosing_a_3d_route_is_logged_with_ip_and_device(): void
    {
        $this->withHeaders(['User-Agent' => 'TestPhone/1.0'])->postJson('/api/activity', ['action' => 'map.opened'])->assertNoContent();
        $this->postJson('/api/activity', ['action' => 'route.3d', 'subject' => 'CCS Building'])->assertNoContent();

        $this->assertDatabaseHas('activity_logs', ['role' => 'visitor', 'action' => 'map.opened', 'summary' => 'Opened the map', 'user_agent' => 'TestPhone/1.0', 'ip' => '127.0.0.1']);
        $this->assertDatabaseHas('activity_logs', ['role' => 'visitor', 'action' => 'route.3d', 'summary' => 'Opened the 3D / AR view to CCS Building']);
    }

    public function test_the_visitor_endpoint_accepts_only_known_actions_and_skips_signed_in_people(): void
    {
        $this->postJson('/api/activity', ['action' => 'nodes.destroy'])->assertUnprocessable();
        $this->postJson('/api/activity', ['action' => 'route.chosen', 'subject' => str_repeat('x', 121)])->assertUnprocessable();

        Sanctum::actingAs(User::factory()->student()->create());
        $this->postJson('/api/activity', ['action' => 'map.opened'])->assertNoContent();

        $this->assertDatabaseCount('activity_logs', 0);
    }

    public function test_admins_see_everyone_and_can_filter(): void
    {
        ActivityLog::factory()->create();
        ActivityLog::factory()->studentLogin()->create();
        ActivityLog::factory()->staffChange('faculty')->create();
        ActivityLog::factory()->staffChange('admin')->create();
        Sanctum::actingAs(User::factory()->create(['role' => 'admin']));

        $this->getJson('/api/activity-logs')->assertOk()->assertJsonPath('total', 4);
        $this->getJson('/api/activity-logs?role=staff')->assertOk()->assertJsonPath('total', 2);
        $this->getJson('/api/activity-logs?role=visitor')->assertOk()->assertJsonPath('total', 1)->assertJsonPath('data.0.role', 'visitor');
    }

    public function test_department_staff_see_only_students_of_their_departments_courses(): void
    {
        $ccs = Department::factory()->create();
        Course::where('code', 'BSIT')->update(['department_id' => $ccs->id]);
        $mine = ActivityLog::factory()->studentLogin('BSIT')->create();
        ActivityLog::factory()->studentLogin('BSN')->create();
        ActivityLog::factory()->create();
        ActivityLog::factory()->staffChange('admin')->create();
        Sanctum::actingAs(User::factory()->create(['role' => 'faculty', 'department_id' => $ccs->id]));

        // Asking for staff or visitors changes nothing: the scope is fixed by the department.
        foreach (['', '?role=staff', '?role=visitor'] as $filter) {
            $this->getJson("/api/activity-logs{$filter}")->assertOk()->assertJsonPath('total', 1)->assertJsonPath('data.0.id', $mine->id);
        }
    }

    public function test_staff_whose_department_covers_no_course_see_nothing(): void
    {
        ActivityLog::factory()->studentLogin('BSIT')->create();
        Sanctum::actingAs(User::factory()->create(['role' => 'faculty', 'department_id' => Department::factory()->create()->id]));
        $this->getJson('/api/activity-logs')->assertOk()->assertJsonPath('total', 0);

        Sanctum::actingAs(User::factory()->create(['role' => 'faculty']));
        $this->getJson('/api/activity-logs')->assertOk()->assertJsonPath('total', 0);
    }

    public function test_students_and_visitors_cannot_read_the_log(): void
    {
        $this->getJson('/api/activity-logs')->assertUnauthorized();
        Sanctum::actingAs(User::factory()->student()->create());
        $this->getJson('/api/activity-logs')->assertForbidden();
    }

    public function test_old_rows_are_pruned(): void
    {
        $old = ActivityLog::factory()->create(['created_at' => now()->subDays(ActivityLog::KEEP_DAYS + 1)]);
        $new = ActivityLog::factory()->create();

        $this->artisan('model:prune', ['--model' => [ActivityLog::class]])->assertSuccessful();

        $this->assertModelMissing($old);
        $this->assertModelExists($new);
    }
}
