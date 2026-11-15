<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::dropIfExists('edges');
    }

    public function down(): void
    {
        Schema::create('edges', function (Blueprint $table) {
            $table->id();
            $table->foreignId('from_node_id')->constrained('nodes')->cascadeOnDelete();
            $table->foreignId('to_node_id')->constrained('nodes')->cascadeOnDelete();
            $table->float('distance_meters')->default(0);
            $table->boolean('bidirectional')->default(true);
            $table->timestamps();

            $table->unique(['from_node_id', 'to_node_id']);
            $table->index('to_node_id');
        });
    }
};
