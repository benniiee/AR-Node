<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Building height in metres, for the 3D (2.5D) map look and sun shadows.
     *
     * Optional on purpose: until someone measures a building, the maps estimate
     * it from the floor count (floors x 3.2 m). Fill it in to override that
     * estimate, e.g. for a gym with one tall floor.
     */
    public function up(): void
    {
        Schema::table('buildings', function (Blueprint $table) {
            $table->decimal('height_m', 5, 1)->nullable()->after('basement_floors');
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::table('buildings', function (Blueprint $table) {
            $table->dropColumn('height_m');
        });
    }
};
