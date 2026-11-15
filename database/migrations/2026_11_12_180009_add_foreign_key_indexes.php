<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Indexes for every foreign key and for the wall group filter. PostgreSQL does not index
 * foreign keys by itself, so the faculty node list,
 * the wall-ownership check on every wall save and each "set null on delete" (a removed
 * department, building or account) scanned whole tables. On PostgreSQL the indexes are
 * built CONCURRENTLY, outside a transaction, so map edits keep working meanwhile (§5).
 */
return new class extends Migration
{
    /** CREATE INDEX CONCURRENTLY cannot run inside a transaction. */
    public $withinTransaction = false;

    /** @var array<string, array{0: string, 1: string}> index name => [table, column] */
    private const INDEXES = [
        'nodes_building_id_index' => ['nodes', 'building_id'],
        'nodes_department_id_index' => ['nodes', 'department_id'],
        'nodes_created_by_index' => ['nodes', 'created_by'],
        'borders_group_id_index' => ['borders', 'group_id'],
        'borders_created_by_index' => ['borders', 'created_by'],
        'node_links_node_b_id_index' => ['node_links', 'node_b_id'],
        'buildings_department_id_index' => ['buildings', 'department_id'],
        'buildings_created_by_index' => ['buildings', 'created_by'],
        'pathways_created_by_index' => ['pathways', 'created_by'],
        'campus_areas_created_by_index' => ['campus_areas', 'created_by'],
        'users_department_id_index' => ['users', 'department_id'],
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
        foreach (array_keys(self::INDEXES) as $name) {
            if (DB::getDriverName() === 'pgsql') {
                DB::statement("DROP INDEX CONCURRENTLY IF EXISTS {$name}");
            } else {
                [$table] = self::INDEXES[$name];
                Schema::table($table, fn ($t) => $t->dropIndex($name));
            }
        }
    }
};
