<?php

namespace Database\Seeders;

use App\Models\User;
use Illuminate\Database\Seeder;
use Illuminate\Support\Facades\Hash;

class DatabaseSeeder extends Seeder
{
    public function run(): void
    {
        // Demo accounts share the password "password": never in production,
        // not even with db:seed --force. See README "First admin in production".
        if (app()->isProduction()) {
            $this->command?->warn('Skipped '.static::class.': demo accounts are never seeded in production.');

            return;
        }

        // Primary admin account (change credentials as needed). firstOrCreate
        // keeps re-seeds from duplicating it; the role is forced so a legacy
        // row from before roles existed still ends up an admin. Map content
        // (buildings, nodes, routes) is created through the admin panel, never
        // seeded.
        $admin = User::firstOrCreate(
            ['email' => 'admin@campus.test'],
            ['name' => 'Admin', 'password' => Hash::make('password')]
        );
        $admin->forceFill(['role' => 'admin', 'department_id' => null])->save();

        // Sample students (BSIT, CSM, BSN) for the Students tab.
        $this->call(StudentSeeder::class);

        // Sample department staff (CCS, CSM) for demoing staff permissions.
        $this->call(DemoStaffSeeder::class);
    }
}
