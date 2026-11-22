<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Course;
use App\Models\Department;
use App\Models\User;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;

/**
 * Student courses (the Courses tab). Admins manage every course and choose its department.
 * Department staff add, rename and remove their own department's courses only; a new one
 * is always filed under their department.
 */
class CourseController extends Controller
{
    /** Admins: every course. Department staff: their department's (none without a department). */
    public function index(Request $request): JsonResponse
    {
        $user = $request->user();
        $courses = Course::with('department:id,name,color')->withCount('students')->orderBy('code')
            ->when(! $user->isAdmin(), fn ($q) => $q->where('department_id', $user->department_id ?? 0))
            ->get();

        return response()->json($courses);
    }

    public function store(Request $request): JsonResponse
    {
        $user = $request->user();
        abort_unless($user->isAdmin() || $user->department_id, 403, 'Ask an admin to assign you a department first.');
        $validated = $this->validated($request);
        if (! $user->isAdmin()) {
            $validated['department_id'] = $user->department_id;
        }
        $this->assertCollege($validated['department_id'] ?? null);

        return response()->json(Course::create($validated)->load('department:id,name,color')->loadCount('students'), 201);
    }

    public function update(Request $request, Course $course): JsonResponse
    {
        $this->authorizeCourse($request->user(), $course);
        $validated = $this->validated($request, $course);
        if (! $request->user()->isAdmin()) {
            unset($validated['department_id']);
        }
        if (array_key_exists('department_id', $validated)) {
            $this->assertCollege($validated['department_id']);
        }
        $course->update($validated);

        return response()->json($course->load('department:id,name,color')->loadCount('students'));
    }

    /** Refused while students are in it (users.course_id restricts the delete too). */
    public function destroy(Request $request, Course $course): JsonResponse
    {
        $this->authorizeCourse($request->user(), $course);
        $count = $course->students()->count();
        abort_if($count > 0, 422, "{$count} ".($count === 1 ? 'student is' : 'students are')." in {$course->code}. Move them to another course first.");
        $course->delete();

        return response()->json(['message' => 'Course removed']);
    }

    private function authorizeCourse(User $user, Course $course): void
    {
        abort_unless($user->isAdmin() || ($user->department_id && $course->department_id === $user->department_id), 403);
    }

    /** @return array{code?: string, name?: string, department_id?: int|null} */
    /** Courses belong to colleges: an office (registrar, cashier...) has none. */
    private function assertCollege(?int $departmentId): void
    {
        abort_if(
            $departmentId !== null && Department::whereKey($departmentId)->where('kind', 'office')->exists(), 422,
            'Offices have no courses: add courses to a college.',
        );
    }

    private function validated(Request $request, ?Course $course = null): array
    {
        if ($request->has('code')) {
            $request->merge(['code' => strtoupper(trim((string) $request->input('code')))]);
        }
        $required = $course ? 'sometimes' : 'required';

        return $request->validate([
            'code' => [$required, 'string', 'regex:'.Course::CODE_PATTERN, Rule::unique('courses', 'code')->ignore($course?->id)],
            'name' => [$required, 'string', 'max:255'],
            'department_id' => ['sometimes', 'nullable', 'integer', Rule::exists('departments', 'id')],
        ], ['code.regex' => 'Use 2 to 16 letters, digits or dashes, like BSIT.']);
    }
}
