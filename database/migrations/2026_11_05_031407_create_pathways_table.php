<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * The campus road and walkway network as drawn lines.
     *
     * A pathway is a polyline copied from an OpenStreetMap road/path or drawn by
     * an admin (new walkways, roads still under construction). It is what the
     * maps draw; routing still runs on nodes, and the admin can lay route nodes
     * along a pathway in one step (POST /api/pathways/{id}/route-nodes).
     */
    public function up(): void
    {
        Schema::create('pathways', function (Blueprint $table) {
            $table->id();
            $table->string('name')->nullable();
            // road | walkway | covered (covered walkways count as sheltered)
            $table->string('kind', 16)->default('walkway');
            // existing | under_construction | planned
            $table->string('status', 20)->default('existing');
            // [{lat, lng}, ...] in walking order.
            $table->json('coordinates');
            $table->string('source', 10)->default('custom');
            $table->string('osm_ref', 64)->nullable()->index();
            $table->foreignId('created_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestamps();
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::dropIfExists('pathways');
    }
};
