<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Who did what, for security: staff sign-ins and every change they make, student
     * sign-ins, and what visitors (no account) look at on the map.
     *
     * The person is snapshotted (role, name, course, year level, department) so a row
     * still reads right after the account is edited or removed. `ip` and `user_agent`
     * are kept for visitors (the only way to trace them) and for sign-ins. Rows are
     * deleted after ActivityLog::KEEP_DAYS (model:prune, daily).
     */
    public function up(): void
    {
        Schema::create('activity_logs', function (Blueprint $table) {
            $table->id();
            $table->foreignId('user_id')->nullable()->constrained()->nullOnDelete();
            // admin | faculty | student | visitor
            $table->string('role', 16);
            $table->string('name')->nullable();
            $table->string('course', 16)->nullable();
            $table->unsignedTinyInteger('year_level')->nullable();
            $table->foreignId('department_id')->nullable()->constrained()->nullOnDelete();
            // Machine name: "login", "map.opened", or "PUT api/nodes/{node}" for a staff change.
            $table->string('action', 120);
            // One readable line: "Edited node #12 (Room 101)".
            $table->string('summary');
            $table->json('details')->nullable();
            $table->string('ip', 45)->nullable();
            $table->string('user_agent')->nullable();
            $table->timestamp('created_at')->useCurrent()->index();
            $table->index(['role', 'created_at']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('activity_logs');
    }
};
