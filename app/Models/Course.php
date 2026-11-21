<?php

namespace App\Models;

use Database\Factories\CourseFactory;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

/**
 * A student course (e.g. BSIT), owned by a department: that department's staff add and
 * edit it, and see its students in the activity log. Students point at it (users.course_id).
 *
 * @property string $code
 * @property string $name
 * @property int|null $department_id
 */
class Course extends Model
{
    /** @use HasFactory<CourseFactory> */
    use HasFactory;

    /** Course codes: letters, digits and dashes, stored upper case (BSIT, BS-CS). */
    public const CODE_PATTERN = '/^[A-Z0-9-]{2,16}$/';

    protected $fillable = ['code', 'name', 'department_id'];

    /** @return BelongsTo<Department, $this> */
    public function department(): BelongsTo
    {
        return $this->belongsTo(Department::class);
    }

    /** @return HasMany<User, $this> */
    public function students(): HasMany
    {
        return $this->hasMany(User::class)->where('role', 'student');
    }
}
