<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * One-off changes to opening hours, on top of the weekly ones: a closure (maintenance, an event,
     * "classes suspended: high heat index") or a special opening (Sunday enrollment). Its scope is
     * the filled columns, all empty = the whole school: `campus` (A/B), `department_kind` (every
     * college, or every office), `department_id`, `building_id`, `node_id`. It ends on its own at
     * `ends_at`. Admins post any scope; staff only their own department's buildings and places.
     */
    public function up(): void
    {
        Schema::create('closures', function (Blueprint $table) {
            $table->id();
            $table->string('kind', 8)->default('closed');
            $table->string('reason', 160)->nullable();
            $table->string('campus', 1)->nullable();
            $table->string('department_kind', 16)->nullable();
            $table->foreignId('department_id')->nullable()->constrained()->cascadeOnDelete();
            $table->foreignId('building_id')->nullable()->constrained()->cascadeOnDelete();
            $table->foreignId('node_id')->nullable()->constrained()->cascadeOnDelete();
            $table->timestamp('starts_at');
            $table->timestamp('ends_at')->index();
            $table->foreignId('created_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('closures');
    }
};
