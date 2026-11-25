<?php

namespace Database\Seeders;

use App\Models\Building;
use App\Models\Department;
use App\Models\User;
use Illuminate\Database\Seeder;

/**
 * Demo staff accounts, one per department or office, each owning its building(s), for
 * presentations. Departments are reused by name (otherwise created with the kind and colour
 * below); a listed building is handed to its department only while nobody owns it, so a real
 * assignment is never undone. Re-running never duplicates anything (keyed on name / email) and
 * resets every demo account, the admin included, to the password "password": change or remove
 * them before deployment.
 */
class DemoStaffSeeder extends Seeder
{
    /** The seeded admin (DatabaseSeeder), reset to the demo password too. */
    public const ADMIN_EMAIL = 'admin@campus.test';

    /**
     * kind: 'college' (its buildings are school buildings) or 'office' (office buildings).
     * buildings: building names this department owns.
     *
     * @var list<array{email: string, name: string, department: string, kind: string, color: string, buildings: list<string>}>
     */
    public const STAFF = [
        // CCS: the Dean runs the building; the IT and CS office staff run the office the Dean assigns them.
        ['email' => 'ccs.dean@campus.test', 'name' => 'CCS Dean', 'department' => 'CCS', 'kind' => 'college', 'color' => '#2563eb', 'buildings' => ['College of Computing Studies']],
        ['email' => 'ccs.it@campus.test', 'name' => 'CCS IT Office', 'department' => 'CCS', 'kind' => 'college', 'color' => '#2563eb', 'buildings' => [], 'head' => false],
        ['email' => 'ccs.cs@campus.test', 'name' => 'CCS CS Office', 'department' => 'CCS', 'kind' => 'college', 'color' => '#2563eb', 'buildings' => [], 'head' => false],
        ['email' => 'csm.staff@campus.test', 'name' => 'CSM Staff', 'department' => 'CSM', 'kind' => 'college', 'color' => '#16a34a', 'buildings' => ['College of Science and Mathematics']],
        ['email' => 'ccje@campus.test', 'name' => 'CCJE Staff', 'department' => 'CCJE', 'kind' => 'college', 'color' => '#7c3aed', 'buildings' => ['College of Criminology Justice Education']],
        ['email' => 'nursing@campus.test', 'name' => 'Nursing Staff', 'department' => 'Nursing', 'kind' => 'college', 'color' => '#db2777', 'buildings' => ['College of Nursing']],
        ['email' => 'cte@campus.test', 'name' => 'CTE Staff', 'department' => 'CTE', 'kind' => 'college', 'color' => '#0891b2', 'buildings' => ['College of Teachers Education']],
        ['email' => 'ils@campus.test', 'name' => 'ILS Staff', 'department' => 'ILS', 'kind' => 'college', 'color' => '#ea580c', 'buildings' => ['ILS']],
        ['email' => 'msa@campus.test', 'name' => 'MSA Staff', 'department' => 'MSA', 'kind' => 'college', 'color' => '#65a30d', 'buildings' => ['MSA']],
        ['email' => 'cais@campus.test', 'name' => 'CAIS Staff', 'department' => 'CAIS', 'kind' => 'college', 'color' => '#0d9488', 'buildings' => ['CAIS']],
        ['email' => 'canteen@campus.test', 'name' => 'Canteen Staff', 'department' => 'Canteen', 'kind' => 'office', 'color' => '#ca8a04', 'buildings' => ['Canteen']],
        ['email' => 'cashier@campus.test', 'name' => 'Cashier Staff', 'department' => 'Cashier', 'kind' => 'office', 'color' => '#9333ea', 'buildings' => ['Cashier']],
        ['email' => 'misto@campus.test', 'name' => 'Misto Staff', 'department' => 'Misto', 'kind' => 'office', 'color' => '#b45309', 'buildings' => ['Misto']],
    ];

    public function run(): void
    {
        // Demo accounts share the password "password": never in production,
        // not even with db:seed --force. See README "First admin in production".
        if (app()->isProduction()) {
            $this->command?->warn('Skipped '.static::class.': demo accounts are never seeded in production.');

            return;
        }

        // The old CCS staff account is now the Dean: same account, so what it added keeps its owner.
        if (! User::where('email', 'ccs.dean@campus.test')->exists()) {
            User::where('email', 'ccs.staff@campus.test')->update(['email' => 'ccs.dean@campus.test', 'name' => 'CCS Dean']);
        }

        foreach (self::STAFF as $staff) {
            $department = Department::firstOrCreate(
                ['name' => $staff['department']],
                ['kind' => $staff['kind'], 'color' => $staff['color']],
            );

            // Its buildings, only while nobody owns them; the label follows the department's kind.
            foreach (Building::whereIn('name', $staff['buildings'])->whereNull('department_id')->get() as $building) {
                $building->update([
                    'department_id' => $department->id,
                    'category' => $department->isOffice() ? 'office' : 'school',
                ]);
            }

            $user = User::firstOrCreate(['email' => $staff['email']], ['name' => $staff['name'], 'password' => 'password']);
            // No forced password change on a demo account.
            $user->forceFill([
                'role' => 'faculty', 'department_id' => $department->id, 'is_head' => $staff['head'] ?? true,
                'password' => 'password', 'must_change_password' => false,
            ])->save();
        }

        User::where('email', self::ADMIN_EMAIL)->first()?->forceFill(['password' => 'password', 'must_change_password' => false])->save();
    }
}
