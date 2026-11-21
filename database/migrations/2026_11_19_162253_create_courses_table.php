<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /** The courses that were hard-coded in User::COURSES until now. */
    private const STARTING_COURSES = [
        'BSIT' => 'Bachelor of Science in Information Technology',
        'CSM' => 'College of Science and Mathematics',
        'BSN' => 'Bachelor of Science in Nursing',
    ];

    /**
     * Student courses become rows that a department owns (its staff add and edit them),
     * and each student points at one: users.course_id, a foreign key (indexed), instead
     * of the old course code string. Removing a course is refused while students are in it.
     *
     * Existing data moves over: the starting courses plus any other code a student has,
     * the departments' ticked courses (departments.courses, dropped), and every student's
     * course (users.course, dropped).
     */
    public function up(): void
    {
        Schema::create('courses', function (Blueprint $table) {
            $table->id();
            $table->string('code', 16)->unique();
            $table->string('name');
            $table->foreignId('department_id')->nullable()->index()->constrained()->nullOnDelete();
            $table->timestamps();
        });

        $now = now();
        $codes = self::STARTING_COURSES + DB::table('users')->whereNotNull('course')->distinct()->pluck('course', 'course')->all();
        foreach ($codes as $code => $name) {
            DB::table('courses')->insert(['code' => $code, 'name' => $name, 'created_at' => $now, 'updated_at' => $now]);
        }
        if (Schema::hasColumn('departments', 'courses')) {
            foreach (DB::table('departments')->whereNotNull('courses')->orderBy('id')->get(['id', 'courses']) as $dept) {
                DB::table('courses')->whereIn('code', json_decode($dept->courses, true) ?: [])->whereNull('department_id')
                    ->update(['department_id' => $dept->id]);
            }
            Schema::table('departments', fn (Blueprint $table) => $table->dropColumn('courses'));
        }

        Schema::table('users', function (Blueprint $table) {
            $table->foreignId('course_id')->nullable()->after('last_name')->index()->constrained()->restrictOnDelete();
        });
        DB::statement('UPDATE users SET course_id = (SELECT id FROM courses WHERE courses.code = users.course) WHERE course IS NOT NULL');
        Schema::table('users', fn (Blueprint $table) => $table->dropColumn('course'));
    }

    public function down(): void
    {
        Schema::table('users', fn (Blueprint $table) => $table->string('course', 100)->nullable()->after('last_name'));
        DB::statement('UPDATE users SET course = (SELECT code FROM courses WHERE courses.id = users.course_id) WHERE course_id IS NOT NULL');
        Schema::table('users', function (Blueprint $table) {
            $table->dropForeign(['course_id']);
            $table->dropIndex(['course_id']);
            $table->dropColumn('course_id');
        });

        Schema::table('departments', fn (Blueprint $table) => $table->json('courses')->nullable()->after('color'));
        foreach (DB::table('courses')->whereNotNull('department_id')->get(['code', 'department_id'])->groupBy('department_id') as $deptId => $rows) {
            DB::table('departments')->where('id', $deptId)->update(['courses' => json_encode($rows->pluck('code')->all())]);
        }
        Schema::dropIfExists('courses');
    }
};
