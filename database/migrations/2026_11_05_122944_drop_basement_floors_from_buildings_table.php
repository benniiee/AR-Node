<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Buildings no longer record basements: campus buildings are counted from
     * the ground floor up (`floors`), so a building's valid floor levels are
     * 0 (ground) to floors - 1.
     */
    public function up(): void
    {
        Schema::table('buildings', function (Blueprint $table) {
            $table->dropColumn('basement_floors');
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::table('buildings', function (Blueprint $table) {
            $table->unsignedTinyInteger('basement_floors')->default(0)->after('floors');
        });
    }
};
