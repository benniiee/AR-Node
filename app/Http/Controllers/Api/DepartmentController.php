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
            'color' => ['sometimes', 'required', 'regex:/^#[0-9a-fA-F]{6}$/'],
        ]);

        $department->update($validated);

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
