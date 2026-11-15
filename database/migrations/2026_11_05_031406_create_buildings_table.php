<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Labelled campus buildings drawn over the OpenStreetMap base map.
     *
     * The PMTiles archive has building outlines but no building names, and it
     * cannot know about buildings that are still being built. A row here is the
     * campus's own record: its outline (`polygon`, copied from an OSM footprint
     * or drawn by hand), its name and how many floors it has.
     *
     * Floors: `floors` counts the storeys above ground including the ground
     * floor (1 = ground only), `basement_floors` the levels below it. A node
     * filed under a building must sit on a floor_level between
     * -basement_floors and floors - 1.
     *
     * `status`, `source` and `campus` are short strings, not enum(), so adding a
     * value never needs the Postgres CHECK-constraint dance (see nodes).
     */
    public function up(): void
    {
        Schema::create('buildings', function (Blueprint $table) {
            $table->id();
            $table->string('name');
            $table->string('short_name', 32)->nullable();
            $table->unsignedTinyInteger('floors')->default(1);
            $table->unsignedTinyInteger('basement_floors')->default(0);
            // existing | under_construction | planned
            $table->string('status', 20)->default('existing');
            $table->string('campus', 1)->default('A');
            // [{lat, lng}, ...] outer ring, first point not repeated at the end.
            $table->json('polygon');
            // osm = copied from a base-map footprint, custom = drawn by an admin.
            $table->string('source', 10)->default('custom');
            // Fingerprint of the OSM footprint it was copied from, so the admin
            // map stops offering that footprint once it is labelled.
            $table->string('osm_ref', 64)->nullable()->index();
            $table->foreignId('department_id')->nullable()->constrained()->nullOnDelete();
            $table->foreignId('created_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestamps();
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::dropIfExists('buildings');
    }
};
