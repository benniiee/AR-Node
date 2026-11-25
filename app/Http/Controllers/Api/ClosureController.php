<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Building;
use App\Models\Closure;
use App\Models\Department;
use App\Models\Node;
use App\Models\User;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;
use Illuminate\Validation\ValidationException;

/**
 * Closures and special openings (announcements). Admins post any scope, from the whole school or
 * every college ("classes suspended") down to one room; staff only their own department, its
 * buildings and the places in them. They end on their own; removing one ends it early.
 */
class ClosureController extends Controller
{
    private const RELATIONS = ['department:id,name', 'building:id,name,short_name', 'node:id,name', 'creator:id,name'];

    /**
     * Current and upcoming ones (they are public on the map anyway), each saying whether the caller
     * may remove it.
     */
    public function index(Request $request): JsonResponse
    {
        $user = $request->user();

        return response()->json(
            Closure::current()->with(self::RELATIONS)->orderBy('starts_at')->get()
                ->map(fn (Closure $c): array => $c->toArray() + ['can_manage' => $this->canManage($user, $c)])
        );
    }

    public function store(Request $request): JsonResponse
    {
        $user = $request->user();
        $validated = $request->validate([
            'kind' => ['sometimes', Rule::in(Closure::KINDS)],
            'reason' => ['required_unless:kind,open', 'nullable', 'string', 'max:160'],
            'campus' => ['sometimes', 'nullable', 'in:A,B'],
            'building_category' => ['sometimes', 'nullable', Rule::in(Building::CATEGORIES)],
            'department_id' => ['sometimes', 'nullable', 'integer', 'exists:departments,id'],
            'building_id' => ['sometimes', 'nullable', 'integer', 'exists:buildings,id'],
            'node_id' => ['sometimes', 'nullable', 'integer', 'exists:nodes,id'],
            'starts_at' => ['required', 'date'],
            'ends_at' => ['required', 'date', 'after:starts_at', 'after:now'],
        ]);
        $closure = new Closure($validated);

        $targets = array_filter([$closure->department_id, $closure->building_id, $closure->node_id], fn ($v) => $v !== null);
        if (count($targets) > 1) {
            throw ValidationException::withMessages(['scope' => ['Choose one department, building or place (or none, for a wider announcement).']]);
        }
        if ($closure->kind === 'open' && $closure->building_id === null && $closure->node_id === null) {
            throw ValidationException::withMessages(['scope' => ['A special opening is for one building or place.']]);
        }
        $this->authorizeScope($user, $closure);

        $closure->created_by = $user->id;
        $closure->save();

        return response()->json($closure->load(self::RELATIONS)->toArray() + ['can_manage' => true], 201);
    }

    /** Remove one (ends it now): admins any; staff the ones within their own department. */
    public function destroy(Request $request, Closure $closure): JsonResponse
    {
        abort_unless($this->canManage($request->user(), $closure), 403, 'You can only remove closures of your own department.');
        $closure->delete();

        return response()->json(['message' => 'Closure removed']);
    }

    /**
     * Staff post only inside their own department: the department itself, one of its buildings, or a
     * place in one of them. The whole school, a campus, or every college / office is an admin's call.
     */
    private function authorizeScope(User $user, Closure $closure): void
    {
        if ($user->isAdmin()) {
            return;
        }
        if ($user->isOfficeStaff()) {
            abort_unless($this->ownOffice($user, $closure), 403, 'You can only close the offices assigned to you.');

            return;
        }
        abort_unless($user->department_id !== null, 403, 'Ask an admin to assign you a department first.');
        abort_if(
            $closure->campus !== null || $closure->building_category !== null || $closure->isSchoolLevel(), 403,
            'Only an admin can close the whole school, a campus, or every school or office building.',
        );
        abort_unless($this->withinDepartment($user, $closure), 403, 'You can only close your own department, its buildings and places.');
    }

    private function canManage(User $user, Closure $closure): bool
    {
        if ($user->isOfficeStaff()) {
            return $this->ownOffice($user, $closure);
        }

        return $user->isAdmin()
            || ($user->department_id !== null && ! $closure->isSchoolLevel()
                && $closure->campus === null && $closure->building_category === null
                && $this->withinDepartment($user, $closure));
    }

    /** A closure of one of the places this office staff member runs. */
    private function ownOffice(User $user, Closure $closure): bool
    {
        return $closure->node_id !== null && Node::whereKey($closure->node_id)->where('manager_id', $user->id)->exists();
    }

    private function withinDepartment(User $user, Closure $closure): bool
    {
        $own = $user->department_id;
        if ($closure->department_id !== null) {
            return $closure->department_id === $own;
        }
        if ($closure->building_id !== null) {
            return Building::whereKey($closure->building_id)->where('department_id', $own)->exists();
        }
        if ($closure->node_id !== null) {
            $node = Node::find($closure->node_id);

            return $node !== null && ($node->department_id === $own
                || ($node->building_id !== null && Building::whereKey($node->building_id)->where('department_id', $own)->exists()));
        }

        return false;
    }
}
