<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * How wide a pathway really is, metres: the 2D map and the 3D views draw it this wide.
     * Null = the usual width for its kind (5 m road, 2.4 m walkway; campusGeometry.js).
     */
    public function up(): void
    {
        Schema::table('pathways', function (Blueprint $table) {
            $table->decimal('width_m', 4, 1)->nullable()->after('status');
        });
    }

    public function down(): void
    {
        Schema::table('pathways', function (Blueprint $table) {
            $table->dropColumn('width_m');
        });
    }
};
