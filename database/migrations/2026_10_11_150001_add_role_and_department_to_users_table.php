<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Run the migrations.
     */
    public function up(): void
    {
        Schema::table('users', function (Blueprint $table) {
            // Nullable on purpose: the app shipped as a single-admin system,
            // so every pre-existing row is that admin (backfilled below).
            // Application code always sets role explicitly; the User model
            // mirrors a 'faculty' default for unsaved instances.
            $table->string('role', 20)->nullable();
            $table->foreignId('department_id')->nullable()->constrained()->nullOnDelete();
        });

        DB::table('users')->whereNull('role')->update(['role' => 'admin']);
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::table('users', function (Blueprint $table) {
            $table->dropConstrainedForeignId('department_id');
            $table->dropColumn('role');
        });
    }
};
