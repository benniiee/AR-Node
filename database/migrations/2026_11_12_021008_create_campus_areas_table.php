<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Campus areas: an admin draws an outline and names it (Campus A, Campus B, ...).
 * A node or building belongs to the campus whose outline it sits in; that is
 * worked out from the position, so moving a node or redrawing an area never
 * leaves a stale tag behind.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('campus_areas', function (Blueprint $table) {
            $table->id();
            $table->string('name', 60)->unique();
            $table->string('color', 7)->default('#38bdf8');
            $table->json('polygon');
            $table->foreignId('created_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('campus_areas');
    }
};
