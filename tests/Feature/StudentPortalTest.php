<?php

namespace Tests\Feature;

use App\Models\Border;
use App\Models\Building;
use App\Models\Department;
use App\Models\Node;
use App\Models\Pathway;
use App\Models\User;
use App\Services\MapSnapshot;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Hash;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

/**
 * The /map portal: students sign in for the full map; visitors (guests) see the buildings and the
 * outdoor network to route to them, never a room or office, filtered on the server.
 */
class StudentPortalTest extends TestCase
{
    use RefreshDatabase;

    private function seedMap(): void
    {
        Building::factory()->create(['name' => 'College of Computing Studies']);
        Node::create(['name' => 'Dean\'s Office', 'type' => 'location', 'latitude' => 6.9131, 'longitude' => 122.0611, 'path_type' => 'inside']);
        Node::create(['type' => 'route', 'latitude' => 6.9132, 'longitude' => 122.0612, 'path_type' => 'outside']);
        Border::create(['latitude' => 6.913, 'longitude' => 122.061, 'group_id' => 1]);
        Pathway::factory()->create();
    }

    private function student(): User
    {
        return User::factory()->student()->create([
            'student_number' => 'ae202401622', 'email' => 'ae202401622@wmsu.edu.ph', 'password' => Hash::make('password123'),
        ]);
    }

    public function test_a_visitor_sees_buildings_and_the_outdoor_network_but_no_rooms(): void
    {
        $this->seedMap();
        $room = Node::where('type', 'location')->first();
        $inside = Node::create(['type' => 'route', 'latitude' => 6.9133, 'longitude' => 122.0613, 'path_type' => 'inside',
            'building_id' => Building::first()->id]);

        $map = $this->getJson('/api/map-data')
            ->assertOk()
            ->assertJsonPath('audience', 'visitor')
            ->assertJsonCount(1, 'buildings')
            ->assertJsonPath('buildings.0.name', 'College of Computing Studies')
            ->assertJsonCount(1, 'borders')
            ->assertJsonCount(1, 'pathways');
        // The outdoor route node only (to route to a building): never the room, nothing inside a building.
        $outdoor = Node::where('type', 'route')->whereNull('building_id')->value('id');
        $this->assertSame([$outdoor], array_column($map->json('nodes'), 'id'));
        $this->assertNotContains($room->id, array_column($map->json('nodes'), 'id'));
        $this->assertNotContains($inside->id, array_column($map->json('nodes'), 'id'));
    }

    public function test_visitors_see_the_important_places_staff_mark_and_the_way_to_them_only(): void
    {
        $department = Department::factory()->create();
        $ccs = Building::factory()->create(['department_id' => $department->id]);
        $other = Building::factory()->create();
        $place = fn (array $over) => Node::create($over + ['latitude' => 6.9131, 'longitude' => 122.0611, 'path_type' => 'inside']);
        $dean = $place(['name' => "Dean's Office", 'type' => 'location', 'building_id' => $ccs->id, 'floor_level' => 1]);
        $lab = $place(['name' => 'Server Room', 'type' => 'location', 'building_id' => $ccs->id]);
        $corridor = $place(['name' => 'Corridor 2F', 'type' => 'route', 'building_id' => $ccs->id, 'floor_level' => 1]);
        $elsewhere = $place(['type' => 'route', 'building_id' => $other->id]);
        $staff = User::factory()->create(['role' => 'faculty', 'department_id' => $department->id]);

        // Staff mark it; a route node is never a visitor's destination.
        Sanctum::actingAs($staff);
        $this->putJson("/api/nodes/{$dean->id}", ['is_public' => true])->assertOk()->assertJsonPath('is_public', true);
        $this->putJson("/api/nodes/{$corridor->id}", ['is_public' => true])->assertOk()->assertJsonPath('is_public', false);

        // A visitor: the Dean's office and the way to it inside its building, nothing else.
        $this->app['auth']->forgetGuards();
        $nodes = collect(MapSnapshot::visitorPayload()['nodes'])->keyBy('id');
        $this->assertTrue($nodes->has($dean->id));
        $this->assertTrue($nodes->has($corridor->id), 'the indoor way to it');
        $this->assertNull($nodes[$corridor->id]['name'], 'route points carry no names for visitors');
        $this->assertFalse($nodes->has($lab->id), 'other rooms stay hidden');
        $this->assertFalse($nodes->has($elsewhere->id), 'nothing inside other buildings');
    }

    public function test_the_map_says_when_the_campus_is_open_to_students_and_visitors(): void
    {
        config(['campus.opens_at' => '06:00', 'campus.closes_at' => '21:00']);

        // Visitors: /map is closed outside these hours (the phone applies them, offline too).
        $this->getJson('/api/map-data')->assertJsonPath('campus_hours', ['opens' => '06:00', 'closes' => '21:00']);
        Sanctum::actingAs($this->student());
        $this->getJson('/api/map-data')->assertJsonPath('campus_hours.closes', '21:00');
    }

    public function test_a_signed_in_student_gets_the_full_map(): void
    {
        $this->seedMap();
        Sanctum::actingAs($this->student());

        $this->getJson('/api/map-data')
            ->assertOk()
            ->assertJsonPath('audience', 'member')
            ->assertJsonCount(2, 'nodes')
            ->assertJsonCount(1, 'borders')
            ->assertJsonCount(1, 'pathways');
    }

    public function test_the_public_static_file_carries_the_visitor_view(): void
    {
        $this->seedMap();

        $snapshot = MapSnapshot::snapshot(MapSnapshot::visitorPayload());

        // The public file: outdoor route nodes only, never a place.
        $this->assertSame(['route'], array_values(array_unique(array_column($snapshot['nodes'], 'type'))));
        $this->assertSame('visitor', $snapshot['audience']);
        $this->assertCount(1, $snapshot['buildings']);
    }

    public function test_student_signs_in_with_school_id_or_email(): void
    {
        $this->student();

        $this->postJson('/api/student/login', ['login' => 'AE202401622', 'password' => 'password123'])
            ->assertOk()
            ->assertJsonPath('user.student_number', 'ae202401622')
            ->assertJsonStructure(['token', 'user' => ['name', 'course', 'year_level']]);

        $this->postJson('/api/student/login', ['login' => 'ae202401622@wmsu.edu.ph', 'password' => 'password123'])->assertOk();
    }

    public function test_a_sign_in_token_stops_working_after_30_days(): void
    {
        $this->student();
        $token = $this->postJson('/api/student/login', ['login' => 'ae202401622', 'password' => 'password123'])->json('token');

        $this->travel(29)->days();
        $this->withToken($token)->getJson('/api/student/me')->assertOk();

        $this->travel(2)->days();
        $this->app['auth']->forgetGuards();
        $this->withToken($token)->getJson('/api/student/me')->assertUnauthorized();
    }

    public function test_wrong_password_and_unknown_id_get_the_same_message(): void
    {
        $this->student();

        $wrong = $this->postJson('/api/student/login', ['login' => 'ae202401622', 'password' => 'nope-nope'])->assertUnprocessable();
        $unknown = $this->postJson('/api/student/login', ['login' => 'ae209999999', 'password' => 'nope-nope'])->assertUnprocessable();

        $this->assertSame($wrong->json('errors.login'), $unknown->json('errors.login'));
    }

    public function test_staff_cannot_use_the_student_sign_in(): void
    {
        User::factory()->create(['role' => 'admin', 'email' => 'admin@campus.test', 'password' => Hash::make('password')]);

        $this->postJson('/api/student/login', ['login' => 'admin@campus.test', 'password' => 'password'])->assertUnprocessable();
    }

    public function test_a_student_token_reads_its_profile_and_signs_out(): void
    {
        $student = $this->student();
        $token = $student->createToken('student-map')->plainTextToken;

        $this->withToken($token)->getJson('/api/student/me')->assertOk()->assertJsonPath('student_number', 'ae202401622');
        $this->withToken($token)->postJson('/api/student/logout')->assertOk();

        $this->assertSame(0, $student->tokens()->count());
    }
}
