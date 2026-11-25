<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Things placed on the campus besides buildings and paths, so the model looks like the real
     * campus: trees (which also shade the paths), benches, sheds and gates (openings in a wall).
     * One point each; size and look per kind.
     */
    public function up(): void
    {
        Schema::create('campus_objects', function (Blueprint $table) {
            $table->id();
            // tree, bench, shed or gate (CampusObject::KINDS).
            $table->string('kind', 16);
            $table->decimal('latitude', 10, 8);
            $table->decimal('longitude', 11, 8);
            // Facing, degrees clockwise from north (a bench's long side, a gate's opening).
            $table->decimal('rotation_deg', 5, 1)->default(0);
            // Metres. Tree: height and crown width. Shed: roof height, width and length.
            // Bench: length. Gate: opening width and post height.
            $table->decimal('height_m', 4, 1)->nullable();
            $table->decimal('width_m', 4, 1)->nullable();
            $table->decimal('length_m', 4, 1)->nullable();
            // A tree's shape (CampusObject::TREE_FORMS); empty for the other kinds.
            $table->string('form', 16)->nullable();
            // Varies a tree's exact look (crown lumps, lean) so no two trees are identical.
            $table->unsignedInteger('seed')->default(1);
            $table->foreignId('created_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestamps();
            $table->index('kind');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('campus_objects');
    }
};
