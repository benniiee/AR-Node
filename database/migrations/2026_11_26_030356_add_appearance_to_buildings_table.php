<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * How a building looks outside (Building Studio): its roof style and colour, wall and accent colours,
     * the style of its front (windows, arched walkways or pillars) and its entrance (canopy, sign, ramp).
     * Null = the plain look every building had before.
     */
    public function up(): void
    {
        Schema::table('buildings', function (Blueprint $table) {
            $table->json('appearance')->nullable()->after('opening_hours');
        });
    }

    public function down(): void
    {
        Schema::table('buildings', function (Blueprint $table) {
            $table->dropColumn('appearance');
        });
    }
};
