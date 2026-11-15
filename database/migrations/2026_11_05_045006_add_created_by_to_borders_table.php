<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Who drew each wall point. Walls follow the node rule: admins may edit
     * every wall, faculty only the walls they drew. A wall is the rows sharing
     * a group_id, so every row of one wall carries the same creator.
     *
     * Existing rows stay null (drawn before attribution) and are therefore
     * admin-only, the same way unattributed nodes are.
     */
    public function up(): void
    {
        Schema::table('borders', function (Blueprint $table) {
            $table->foreignId('created_by')->nullable()->after('group_id')->constrained('users')->nullOnDelete();
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::table('borders', function (Blueprint $table) {
            $table->dropConstrainedForeignId('created_by');
        });
    }
};
