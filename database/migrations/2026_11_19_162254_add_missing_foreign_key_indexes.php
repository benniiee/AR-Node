<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Foreign keys added after add_foreign_key_indexes that had no index (PostgreSQL does not
 * index them by itself): a removed account or department scanned these tables to null
 * them out. Built CONCURRENTLY on PostgreSQL, like that migration.
 */
return new class extends Migration
{
    /** CREATE INDEX CONCURRENTLY cannot run inside a transaction. */
    public $withinTransaction = false;

    /** @var array<string, array{0: string, 1: string}> index name => [table, column] */
    private const INDEXES = [
        'bridges_created_by_index' => ['bridges', 'created_by'],
        'activity_logs_user_id_index' => ['activity_logs', 'user_id'],
        'activity_logs_department_id_index' => ['activity_logs', 'department_id'],
    ];

    public function up(): void
    {
        $pgsql = DB::getDriverName() === 'pgsql';
        if ($pgsql) {
            DB::statement("SET lock_timeout = '5s'");
        }

        foreach (self::INDEXES as $name => [$table, $column]) {
            if ($pgsql) {
                DB::statement("CREATE INDEX CONCURRENTLY IF NOT EXISTS {$name} ON {$table} ({$column})");
            } elseif (! Schema::hasIndex($table, $name)) {
                Schema::table($table, fn ($t) => $t->index($column, $name));
            }
        }
    }

    public function down(): void
    {
        foreach (self::INDEXES as $name => [$table]) {
            if (DB::getDriverName() === 'pgsql') {
                DB::statement("DROP INDEX CONCURRENTLY IF EXISTS {$name}");
            } else {
                Schema::table($table, fn ($t) => $t->dropIndex($name));
            }
        }
    }
};
