<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\ActivityLog;
use App\Models\Course;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Validation\Rule;

class ActivityLogController extends Controller
{
    /**
     * The activity log, newest first, 50 a page. Admins see everyone (each admin sees
     * what the others did). Department staff see only the students of the courses their
     * department owns (courses.department_id): none if it owns none.
     */
    public function index(Request $request): JsonResponse
    {
        $filters = $request->validate([
            'role' => ['nullable', Rule::in([...ActivityLog::ROLES, 'staff'])],
            'q' => 'nullable|string|max:100',
        ]);
        $user = $request->user();

        $query = ActivityLog::with('department:id,name')->latest('id');
        if (! $user->isAdmin()) {
            // The codes of the courses their department owns (none without a department).
            $courses = Course::where('department_id', $user->department_id ?? 0)->pluck('code');
            $query->where('role', 'student')->whereIn('course', $courses);
        } elseif (($filters['role'] ?? null) === 'staff') {
            $query->whereIn('role', ['admin', 'faculty']);
        } elseif (! empty($filters['role'])) {
            $query->where('role', $filters['role']);
        }
        if (! empty($filters['q'])) {
            $like = '%'.str_replace(['%', '_'], ['\%', '\_'], $filters['q']).'%';
            $query->where(fn ($q) => $q->whereLike('name', $like)->orWhereLike('summary', $like)->orWhereLike('ip', $like));
        }

        return response()->json($query->paginate(50));
    }

    /**
     * What a visitor (no account) does on the public map. Signed-in people are not logged
     * here: students are logged when they sign in, staff by LogStaffActions.
     */
    public function store(Request $request): Response
    {
        $validated = $request->validate([
            'action' => ['required', Rule::in(array_keys(ActivityLog::VISITOR_ACTIONS))],
            'subject' => 'nullable|string|max:120',
        ]);
        if (auth('sanctum')->user()) {
            return response()->noContent();
        }

        $subject = trim((string) ($validated['subject'] ?? ''));
        $summary = ActivityLog::VISITOR_ACTIONS[$validated['action']].($validated['action'] !== 'map.opened' && $subject !== '' ? " {$subject}" : '');
        ActivityLog::record($request, null, $validated['action'], $summary, $subject !== '' ? ['destination' => $subject] : []);

        return response()->noContent();
    }
}
