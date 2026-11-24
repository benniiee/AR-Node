<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * An important place visitors may see and be routed to (the Dean's office, the registrar), marked by
     * the building's department staff. Every other place stays members-only.
     */
    public function up(): void
    {
        Schema::table('nodes', function (Blueprint $table) {
            $table->boolean('is_public')->default(false)->after('opening_hours');
        });
    }

    public function down(): void
    {
        Schema::table('nodes', function (Blueprint $table) {
            $table->dropColumn('is_public');
        });
    }
};
