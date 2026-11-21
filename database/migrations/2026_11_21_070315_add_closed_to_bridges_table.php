<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * An admin can close a bridge for a while (an event on one campus): routes stop crossing
     * it and students see `closed_reason` on the map and when no other way is mapped.
     */
    public function up(): void
    {
        Schema::table('bridges', function (Blueprint $table) {
            $table->boolean('closed')->default(false)->after('status');
            $table->string('closed_reason', 160)->nullable()->after('closed');
        });
    }

    public function down(): void
    {
        Schema::table('bridges', function (Blueprint $table) {
            $table->dropColumn(['closed', 'closed_reason']);
        });
    }
};
