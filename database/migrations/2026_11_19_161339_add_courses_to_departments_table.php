<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * The student courses a department (college) covers, e.g. CCS: ["BSIT"]. Its staff
     * see the activity log of students in those courses only. Codes from User::COURSES.
     */
    public function up(): void
    {
        Schema::table('departments', function (Blueprint $table) {
            $table->json('courses')->nullable()->after('color');
        });
    }

    public function down(): void
    {
        Schema::table('departments', function (Blueprint $table) {
            $table->dropColumn('courses');
        });
    }
};
