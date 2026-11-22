<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Offices (registrar, cashier, canteen...) beside the colleges: a department's `kind` is 'college'
     * (has courses and students) or 'office' (staff only). Buildings and places (location nodes) get
     * optional weekly `opening_hours` (App\Services\OpeningHours); null means no set hours (always open).
     * A place without its own hours follows its building's.
     */
    public function up(): void
    {
        Schema::table('departments', function (Blueprint $table) {
            $table->string('kind', 16)->default('college')->after('name');
        });
        Schema::table('buildings', function (Blueprint $table) {
            $table->json('opening_hours')->nullable()->after('doors');
        });
        Schema::table('nodes', function (Blueprint $table) {
            $table->json('opening_hours')->nullable()->after('building_id');
        });
    }

    public function down(): void
    {
        Schema::table('nodes', function (Blueprint $table) {
            $table->dropColumn('opening_hours');
        });
        Schema::table('buildings', function (Blueprint $table) {
            $table->dropColumn('opening_hours');
        });
        Schema::table('departments', function (Blueprint $table) {
            $table->dropColumn('kind');
        });
    }
};
