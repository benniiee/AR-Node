<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Student accounts live in `users` with role = 'student', so they share
     * hashed passwords and Sanctum with staff. These columns are only filled
     * for students:
     *
     *  - student_number  school ID, e.g. "ae202401622" (also the email's local
     *                    part: ae202401622@<STUDENT_EMAIL_DOMAIN>), unique
     *  - first_name / last_name   kept apart for sorting and display; `name`
     *                    still holds "First Last" like every other account
     *  - course          e.g. "BSIT" (short code; the admin page shows the full name)
     *  - year_level      1 to 6
     */
    public function up(): void
    {
        Schema::table('users', function (Blueprint $table) {
            $table->string('student_number', 32)->nullable()->unique()->after('email');
            $table->string('first_name', 100)->nullable()->after('student_number');
            $table->string('last_name', 100)->nullable()->after('first_name');
            $table->string('course', 100)->nullable()->after('last_name');
            $table->unsignedTinyInteger('year_level')->nullable()->after('course');
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::table('users', function (Blueprint $table) {
            $table->dropUnique(['student_number']);
            $table->dropColumn(['student_number', 'first_name', 'last_name', 'course', 'year_level']);
        });
    }
};
