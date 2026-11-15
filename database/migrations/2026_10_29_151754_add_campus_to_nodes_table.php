<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Which campus a node belongs to: 'A' or 'B'.
     *
     * Both node types (route and location) carry it — the column lives on the
     * shared `nodes` table, so there is nothing type-specific about it. It is
     * stored data only: routing and rendering deliberately ignore it for now.
     *
     * Existing rows default to 'A' so the column is never null and no caller
     * has to handle an unassigned campus.
     */
    public function up(): void
    {
        Schema::table('nodes', function (Blueprint $table) {
            $table->enum('campus', ['A', 'B'])->default('A')->after('path_type');
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::table('nodes', function (Blueprint $table) {
            $table->dropColumn('campus');
        });
    }
};
