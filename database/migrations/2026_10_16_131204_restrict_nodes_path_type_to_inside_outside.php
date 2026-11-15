<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    /**
     * Nodes only carry two labels now: inside and outside.
     * Legacy 'covered' rows are folded into 'inside'.
     */
    public function up(): void
    {
        DB::table('nodes')
            ->where('path_type', 'covered')
            ->update(['path_type' => 'inside']);

        // Postgres created a CHECK constraint for the original enum;
        // replace it with the two-label version. MySQL / SQLite ignore
        // the raw statements safely via the guards below.
        $driver = DB::getDriverName();
        if ($driver === 'pgsql') {
            DB::statement(
                'ALTER TABLE nodes DROP CONSTRAINT IF EXISTS nodes_path_type_check'
            );
            DB::statement(
                "ALTER TABLE nodes ADD CONSTRAINT nodes_path_type_check CHECK (path_type IN ('outside','inside'))"
            );
        }
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        $driver = DB::getDriverName();
        if ($driver === 'pgsql') {
            DB::statement(
                'ALTER TABLE nodes DROP CONSTRAINT IF EXISTS nodes_path_type_check'
            );
            DB::statement(
                "ALTER TABLE nodes ADD CONSTRAINT nodes_path_type_check CHECK (path_type IN ('outside','inside','covered'))"
            );
        }
    }
};
