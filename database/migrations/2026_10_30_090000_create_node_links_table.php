<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Staircase links: "these two nodes are the two ends of one staircase".
     *
     * Routing across floors is NOT inferred from coordinates. Every route
     * between floors goes through a row here, so an admin states once which
     * two nodes are the bottom and top of a staircase and the router never
     * has to guess. Nodes on the same floor are never linked.
     *
     * `angle_deg` is the incline of the staircase (45 by default). It sets the
     * walked length of the stairs (rise / sin(angle)) and the pitch of the
     * stairs arrow shown to the student.
     *
     * A pair is stored once, with node_a_id < node_b_id, and is unique.
     */
    public function up(): void
    {
        Schema::create('node_links', function (Blueprint $table) {
            $table->id();
            $table->foreignId('node_a_id')->constrained('nodes')->cascadeOnDelete();
            $table->foreignId('node_b_id')->constrained('nodes')->cascadeOnDelete();
            $table->string('kind', 16)->default('stairs');
            $table->decimal('angle_deg', 5, 2)->default(45);
            $table->timestamps();

            $table->unique(['node_a_id', 'node_b_id']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('node_links');
    }
};
