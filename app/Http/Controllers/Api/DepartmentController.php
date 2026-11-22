<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Department;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;

class DepartmentController extends Controller
{
    /**
     * List all departments with their node counts (any logged-in user — the
     * map needs the colours to paint labels).
     */
    public function index(): JsonResponse
    {
        return response()->json(
            Department::withCount(['nodes', 'courses'])->orderBy('name')->get()
        );
    }

    /**
     * Create a department (admin only).
     */
    public function store(Request $request): JsonResponse
    {
        abort_unless($request->user()->isAdmin(), 403);

        $validated = $request->validate([
            'name' => 'required|string|max:255|unique:departments,name',
            'kind' => ['sometimes', Rule::in(Department::KINDS)],
            'color' => ['required', 'regex:/^#[0-9a-fA-F]{6}$/'],
        ]);

        return response()->json(Department::create($validated), 201);
    }

    /**
     * Show a single department.
     */
    public function show(Department $department): JsonResponse
    {
        return response()->json($department->loadCount('nodes'));
    }

    /**
     * Rename / recolour a department (admin only).
     */
    public function update(Request $request, Department $department): JsonResponse
    {
        abort_unless($request->user()->isAdmin(), 403);

        $validated = $request->validate([
            'name' => ['sometimes', 'required', 'string', 'max:255', Rule::unique('departments', 'name')->ignore($department->id)],
            'kind' => ['sometimes', Rule::in(Department::KINDS)],
            'color' => ['sometimes', 'required', 'regex:/^#[0-9a-fA-F]{6}$/'],
        ]);

        // An office has no courses: a college becomes one only once its courses are moved or removed.
        abort_if(
            ($validated['kind'] ?? null) === 'office' && $department->courses()->exists(), 422,
            "Move or remove this department's courses before making it an office.",
        );

        $department->update($validated);
        // Its buildings follow: a college's are school buildings, an office's office buildings.
        // One by one, so the map snapshot refreshes (model events).
        if ($department->wasChanged('kind')) {
            foreach ($department->buildings()->get() as $building) {
                $building->update(['category' => $department->isOffice() ? 'office' : 'school']);
            }
        }

        return response()->json($department);
    }

    /**
     * Delete a department (admin only). Its nodes and users keep existing —
     * both foreign keys null out, so affected nodes show as "Unassigned".
     */
    public function destroy(Request $request, Department $department): JsonResponse
    {
        abort_unless($request->user()->isAdmin(), 403);

        $department->delete();

        return response()->json(['message' => 'Department deleted']);
    }
}
