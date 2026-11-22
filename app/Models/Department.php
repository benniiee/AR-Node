<?php

namespace App\Models;

use Database\Factories\DepartmentFactory;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;

class Department extends Model
{
    /** @use HasFactory<DepartmentFactory> */
    use HasFactory;

    /** A college has courses and students; an office (registrar, cashier, canteen...) has staff only. */
    public const KINDS = ['college', 'office'];

    protected $fillable = [
        'name',
        'kind',
        'color',
    ];

    /**
     * Mirrors the column default so a freshly created model reports it.
     *
     * @var array<string, mixed>
     */
    protected $attributes = [
        'kind' => 'college',
    ];

    public function isOffice(): bool
    {
        return $this->kind === 'office';
    }

    /**
     * Student courses this department owns: its staff add and edit them and see their students' activity.
     *
     * @return HasMany<Course, $this>
     */
    public function courses(): HasMany
    {
        return $this->hasMany(Course::class);
    }

    /**
     * Faculty members assigned to this department.
     */
    public function users(): HasMany
    {
        return $this->hasMany(User::class);
    }

    /**
     * Buildings this department owns (its staff manage their rooms, doors and hours).
     *
     * @return HasMany<Building, $this>
     */
    public function buildings(): HasMany
    {
        return $this->hasMany(Building::class);
    }

    /**
     * Nodes wearing this department's map label colour.
     */
    public function nodes(): HasMany
    {
        return $this->hasMany(Node::class);
    }
}
