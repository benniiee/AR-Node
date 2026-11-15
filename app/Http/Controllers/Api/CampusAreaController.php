<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\CampusArea;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;

/**
 * Campus areas: named outlines (Campus A, Campus B, ...). Any staff member may
 * read them; only admins draw, rename, reshape or remove them.
 */
class CampusAreaController extends Controller
{
    public function index(): JsonResponse
    {
        return response()->json(CampusArea::orderBy('name')->get());
    }

    public function store(Request $request): JsonResponse
    {
        abort_unless($request->user()->isAdmin(), 403);

        $area = new CampusArea($this->validated($request));
        $area->created_by = $request->user()->id;
        $area->save();

        return response()->json($area, 201);
    }

    public function show(CampusArea $campusArea): JsonResponse
    {
        return response()->json($campusArea);
    }

    public function update(Request $request, CampusArea $campusArea): JsonResponse
    {
        abort_unless($request->user()->isAdmin(), 403);

        $campusArea->update($this->validated($request, $campusArea));

        return response()->json($campusArea);
    }

    /**
     * Remove an outline (admin only). Nodes and buildings stay; they simply
     * stop belonging to that campus.
     */
    public function destroy(Request $request, CampusArea $campusArea): JsonResponse
    {
        abort_unless($request->user()->isAdmin(), 403);

        $campusArea->delete();

        return response()->json(['message' => 'Campus area deleted']);
    }

    /**
     * @return array<string, mixed>
     */
    private function validated(Request $request, ?CampusArea $area = null): array
    {
        $required = $area ? 'sometimes' : 'required';

        return $request->validate([
            'name' => [$required, 'string', 'max:60', Rule::unique('campus_areas', 'name')->ignore($area?->id)],
            'color' => ['sometimes', 'string', 'regex:/^#[0-9a-fA-F]{6}$/'],
            'polygon' => [$required, 'array', 'min:3', 'max:200'],
            'polygon.*.lat' => ['required_with:polygon', 'numeric', 'between:-90,90'],
            'polygon.*.lng' => ['required_with:polygon', 'numeric', 'between:-180,180'],
        ], [
            'polygon.min' => 'An area needs at least 3 corners.',
            'name.unique' => 'Another campus area already has this name.',
        ]);
    }
}
