<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\CampusObject;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;

/**
 * Campus objects: trees, benches, sheds and gates. Any staff member may read them; only admins
 * place, change or remove them (like campus areas).
 */
class CampusObjectController extends Controller
{
    public function index(): JsonResponse
    {
        return response()->json(CampusObject::orderBy('id')->get());
    }

    public function store(Request $request): JsonResponse
    {
        abort_unless($request->user()->isAdmin(), 403);

        $object = new CampusObject($this->validated($request));
        $object->created_by = $request->user()->id;
        $object->save();

        return response()->json($object, 201);
    }

    public function show(CampusObject $campusObject): JsonResponse
    {
        return response()->json($campusObject);
    }

    public function update(Request $request, CampusObject $campusObject): JsonResponse
    {
        abort_unless($request->user()->isAdmin(), 403);

        $campusObject->update($this->validated($request, $campusObject));

        return response()->json($campusObject);
    }

    public function destroy(Request $request, CampusObject $campusObject): JsonResponse
    {
        abort_unless($request->user()->isAdmin(), 403);

        $campusObject->delete();

        return response()->json(['message' => 'Object removed']);
    }

    /**
     * Only a tree has a form; for the other kinds it is cleared.
     *
     * @return array<string, mixed>
     */
    private function validated(Request $request, ?CampusObject $object = null): array
    {
        $required = $object ? 'sometimes' : 'required';
        $kind = $request->input('kind', $object?->kind);

        $data = $request->validate([
            'kind' => [$required, Rule::in(CampusObject::KINDS)],
            'latitude' => [$required, 'numeric', 'between:-90,90'],
            'longitude' => [$required, 'numeric', 'between:-180,180'],
            'rotation_deg' => ['sometimes', 'numeric', 'between:0,360'],
            'height_m' => ['sometimes', 'nullable', 'numeric', 'between:0.2,40'],
            'width_m' => ['sometimes', 'nullable', 'numeric', 'between:0.2,40'],
            'length_m' => ['sometimes', 'nullable', 'numeric', 'between:0.2,40'],
            'form' => ['sometimes', 'nullable', Rule::in(CampusObject::TREE_FORMS)],
            'seed' => ['sometimes', 'integer', 'between:1,2147483647'],
        ]);

        if ($kind !== 'tree') {
            $data['form'] = null;
        }

        return $data;
    }
}
