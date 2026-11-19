<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Connectors: structures people walk THROUGH, not to, such as the footbridge over the
     * road between the two campuses. Drawn and labelled like a building (an outline on
     * the base map), but never a search destination and without rooms, doors or floors.
     *
     * `kind` is a short string (only "bridge" today, see Bridge::KINDS), so a future
     * connector such as a skywalk or a tunnel is one new value, not a new table.
     *
     * The deck: `deck_floor` is the floor its route nodes are on (0 = at ground level,
     * 1 = one floor up: raised over a road, reached by stairs at each end), and
     * `deck_height_m` how high it is drawn (null = deck_floor x 3.2 m, like a building
     * storey). `roofed` decks give "inside" route nodes, which rain routing prefers.
     */
    public function up(): void
    {
        Schema::create('bridges', function (Blueprint $table) {
            $table->id();
            $table->string('name');
            $table->string('short_name', 32)->nullable();
            $table->string('kind', 16)->default('bridge');
            // [{lat, lng}, ...] the deck's outline, first point not repeated at the end.
            $table->json('polygon');
            $table->unsignedTinyInteger('deck_floor')->default(1);
            $table->decimal('deck_height_m', 5, 2)->nullable();
            $table->boolean('roofed')->default(true);
            // existing | under_construction | planned (the building statuses)
            $table->string('status', 20)->default('existing');
            $table->string('source', 10)->default('custom');
            $table->foreignId('created_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('bridges');
    }
};
