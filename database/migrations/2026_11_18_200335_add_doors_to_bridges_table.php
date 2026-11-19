<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Doors on a bridge's outline, like a building's (BuildingDoors): [{lat, lng, width_m}].
     * With doors, routes get on and off the deck only through them (on the deck's floor;
     * the ground under a raised deck stays open). Without doors nothing changes.
     */
    public function up(): void
    {
        Schema::table('bridges', function (Blueprint $table) {
            $table->json('doors')->nullable()->after('polygon');
        });
    }

    public function down(): void
    {
        Schema::table('bridges', function (Blueprint $table) {
            $table->dropColumn('doors');
        });
    }
};
