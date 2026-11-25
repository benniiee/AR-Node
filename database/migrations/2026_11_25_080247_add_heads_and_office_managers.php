<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Building heads and office staff. A department's staff account is its head (the Dean of a college,
     * the head of an office building) unless `is_head` is false: then it is office staff, who only set
     * the hours of the places assigned to them (`nodes.manager_id`), e.g. the IT office or CS office.
     * Existing staff accounts stay heads, so nobody loses what they could do.
     */
    public function up(): void
    {
        Schema::table('users', function (Blueprint $table) {
            $table->boolean('is_head')->default(true)->after('department_id');
        });
        Schema::table('nodes', function (Blueprint $table) {
            $table->foreignId('manager_id')->nullable()->after('department_id')->constrained('users')->nullOnDelete();
        });
    }

    public function down(): void
    {
        Schema::table('nodes', function (Blueprint $table) {
            $table->dropConstrainedForeignId('manager_id');
        });
        Schema::table('users', function (Blueprint $table) {
            $table->dropColumn('is_head');
        });
    }
};
