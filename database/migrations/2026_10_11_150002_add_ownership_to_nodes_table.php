<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Run the migrations.
     */
    public function up(): void
    {
        Schema::table('nodes', function (Blueprint $table) {
            // Department whose map label colour this node wears. Null = the
            // node predates departments ("Unassigned" in the admin panel).
            $table->foreignId('department_id')->nullable()->constrained()->nullOnDelete();
            // Faculty member who placed the node. Null = placed before
            // attribution existed. Never mass-assignable — set server-side.
            $table->foreignId('created_by')->nullable()->constrained('users')->nullOnDelete();
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::table('nodes', function (Blueprint $table) {
            $table->dropConstrainedForeignId('department_id');
            $table->dropConstrainedForeignId('created_by');
        });
    }
};
