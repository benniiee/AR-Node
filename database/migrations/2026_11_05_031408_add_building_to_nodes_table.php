<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Which building a node (office, room, hallway point) is inside. Null =
     * outdoors or not filed yet. Deleting a building keeps its nodes.
     */
    public function up(): void
    {
        Schema::table('nodes', function (Blueprint $table) {
            $table->foreignId('building_id')->nullable()->after('department_id')->constrained()->nullOnDelete();
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::table('nodes', function (Blueprint $table) {
            $table->dropConstrainedForeignId('building_id');
        });
    }
};
