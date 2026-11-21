<?php

namespace App\Models;

// use Illuminate\Contracts\Auth\MustVerifyEmail;
use Database\Factories\UserFactory;
use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Attributes\Hidden;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Foundation\Auth\User as Authenticatable;
use Illuminate\Notifications\Notifiable;
use Laravel\Sanctum\HasApiTokens;

#[Fillable(['name', 'email', 'password', 'role', 'department_id', 'student_number', 'first_name', 'last_name', 'course_id', 'year_level'])]
#[Hidden(['password', 'remember_token'])]
class User extends Authenticatable
{
    /** @use HasFactory<UserFactory> */
    use HasApiTokens, HasFactory, Notifiable;

    /** Staff roles: may sign in to the admin console. */
    public const STAFF_ROLES = ['admin', 'faculty'];

    public const MAX_YEAR_LEVEL = 6;

    /** School ID format: two letters + nine digits, e.g. ae202401622. */
    public const STUDENT_NUMBER_PATTERN = '/^[a-z]{2}\d{9}$/';

    /**
     * Student email from the school ID: ae202401622@wmsu.edu.ph (the domain is
     * config('app.student_email_domain'), env STUDENT_EMAIL_DOMAIN).
     */
    public static function studentEmail(string $studentNumber): string
    {
        return strtolower($studentNumber).'@'.config('app.student_email_domain', 'wmsu.edu.ph');
    }

    /**
     * Mirrors the application default for new faculty accounts. The column
     * itself stays nullable so the migration can backfill the pre-existing
     * single admin (see add_role_and_department_to_users_table).
     *
     * @var array<string, string>
     */
    protected $attributes = [
        'role' => 'faculty',
    ];

    /**
     * Department this faculty member places nodes for (null for admins or
     * unassigned faculty).
     */
    public function department(): BelongsTo
    {
        return $this->belongsTo(Department::class);
    }

    /**
     * A student's course (null for staff).
     *
     * @return BelongsTo<Course, $this>
     */
    public function course(): BelongsTo
    {
        return $this->belongsTo(Course::class);
    }

    /**
     * Nodes this user placed on the map.
     */
    public function createdNodes(): HasMany
    {
        return $this->hasMany(Node::class, 'created_by');
    }

    public function isAdmin(): bool
    {
        return $this->role === 'admin';
    }

    public function isFaculty(): bool
    {
        return $this->role === 'faculty';
    }

    public function isStudent(): bool
    {
        return $this->role === 'student';
    }

    public function isStaff(): bool
    {
        return in_array($this->role, self::STAFF_ROLES, true);
    }

    /**
     * Get the attributes that should be cast.
     *
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return [
            'email_verified_at' => 'datetime',
            'password' => 'hashed',
            'year_level' => 'integer',
            'must_change_password' => 'boolean',
        ];
    }
}
