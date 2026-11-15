<?php

namespace Database\Seeders;

use App\Models\User;
use Illuminate\Database\Seeder;
use Illuminate\Support\Facades\Hash;

/**
 * Three sample student accounts (one per course) for demos and testing the
 * Students tab. Re-running never duplicates them (keyed on the school ID).
 * All use the password "password": change or remove them before deployment.
 */
class StudentSeeder extends Seeder
{
    /**
     * @var list<array{student_number: string, first_name: string, last_name: string, course: string, year_level: int}>
     */
    private const STUDENTS = [
        ['student_number' => 'ae202401622', 'first_name' => 'Kristine Mae', 'last_name' => 'Alvarez', 'course' => 'BSIT', 'year_level' => 2],
        ['student_number' => 'ae202502307', 'first_name' => 'Rafael', 'last_name' => 'Jimenez', 'course' => 'CSM', 'year_level' => 1],
        ['student_number' => 'ae202300418', 'first_name' => 'Nur-aisa', 'last_name' => 'Hadjirul', 'course' => 'BSN', 'year_level' => 3],
    ];

    public function run(): void
    {
        // Demo accounts share the password "password": never in production,
        // not even with db:seed --force. See README "First admin in production".
        if (app()->isProduction()) {
            $this->command?->warn('Skipped '.static::class.': demo accounts are never seeded in production.');

            return;
        }

        foreach (self::STUDENTS as $student) {
            User::updateOrCreate(
                ['student_number' => $student['student_number']],
                $student + [
                    'role' => 'student',
                    'name' => "{$student['first_name']} {$student['last_name']}",
                    'email' => User::studentEmail($student['student_number']),
                    'password' => Hash::make('password'),
                ],
            );
        }
    }
}
