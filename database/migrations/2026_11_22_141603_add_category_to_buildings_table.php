<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Every building is a 'school' building (classes: colleges, the high school) or an 'office'
     * building (cashier, registrar, canteen). A building owned by a department follows its kind
     * (college -> school, office -> office); an admin labels the ones nobody owns. Announcements
     * target them by it ("all school buildings": classes suspended), so closures.department_kind
     * becomes closures.building_category with the same two values.
     */
    public function up(): void
    {
        Schema::table('buildings', function (Blueprint $table) {
            $table->string('category', 16)->default('school')->after('status');
        });
        DB::table('buildings')
            ->whereIn('department_id', DB::table('departments')->where('kind', 'office')->select('id'))
            ->update(['category' => 'office']);

        Schema::table('closures', function (Blueprint $table) {
            $table->renameColumn('department_kind', 'building_category');
        });
        DB::table('closures')->where('building_category', 'college')->update(['building_category' => 'school']);
    }

    public function down(): void
    {
        DB::table('closures')->where('building_category', 'school')->update(['building_category' => 'college']);
        Schema::table('closures', function (Blueprint $table) {
            $table->renameColumn('building_category', 'department_kind');
        });
        Schema::table('buildings', function (Blueprint $table) {
            $table->dropColumn('category');
        });
    }
};
