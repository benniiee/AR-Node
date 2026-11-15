<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Doors of a building: points on its outline, [{lat, lng}, ...].
     *
     * Routing treats the outline as a wall with a gap at each door, so routes
     * go in and out through them. Null / empty keeps the older rule (the
     * building can be entered from any side) until doors are added.
     */
    public function up(): void
    {
        Schema::table('buildings', function (Blueprint $table) {
            $table->json('doors')->nullable()->after('polygon');
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::table('buildings', function (Blueprint $table) {
            $table->dropColumn('doors');
        });
    }
};
