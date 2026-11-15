<?php

namespace Database\Seeders;

use App\Models\Department;
use App\Models\User;
use Illuminate\Database\Seeder;

/**
 * Two sample department staff (faculty) accounts for demos: one for CCS and
 * one for CSM. The departments are reused by name when they already exist
 * (otherwise created), so the staff can edit whichever buildings the admin
 * assigned to them. Re-running never duplicates them (keyed on the email).
 * All use the password "password": change or remove them before deployment.
 */
class DemoStaffSeeder extends Seeder
{
    /**
     * @var list<array{email: string, name: string, department: string, color: string}>
     */
    public const STAFF = [
        ['email' => 'ccs.staff@campus.test', 'name' => 'CCS Staff', 'department' => 'CCS', 'color' => '#2563eb'],
        ['email' => 'csm.staff@campus.test', 'name' => 'CSM Staff', 'department' => 'CSM', 'color' => '#16a34a'],
    ];

    public function run(): void
    {
        // Demo accounts share the password "password": never in production,
        // not even with db:seed --force. See README "First admin in production".
        if (app()->isProduction()) {
            $this->command?->warn('Skipped '.static::class.': demo accounts are never seeded in production.');

            return;
        }

        foreach (self::STAFF as $staff) {
            $department = Department::firstOrCreate(
                ['name' => $staff['department']],
                ['color' => $staff['color']],
            );

            $user = User::firstOrCreate(
                ['email' => $staff['email']],
                ['name' => $staff['name'], 'password' => 'password'],
            );
            $user->forceFill(['role' => 'faculty', 'department_id' => $department->id])->save();
        }
    }
}
