<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Border;
use App\Models\User;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * Walls (routing barriers). A wall is every row sharing one group_id.
 *
 * Ownership follows the node rule: admins may add, edit and remove every
 * wall; faculty may draw new walls and change only the walls they drew.
 */
class BorderController extends Controller
{
    public function index(): JsonResponse
    {
        return response()->json(Border::orderBy('id')->get());
    }

    public function store(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'latitude' => 'required|numeric|between:-90,90',
            'longitude' => 'required|numeric|between:-180,180',
            'group_id' => 'required|integer',
        ]);

        // Adding a point to an existing wall is editing that wall.
        $this->authorizeGroup($request->user(), $validated['group_id']);

        $border = new Border($validated);
        $border->created_by = $request->user()->id;
        $border->save();

        return response()->json($border, 201);
    }

    public function destroy(Request $request, Border $border): JsonResponse
    {
        $this->authorizeGroup($request->user(), $border->group_id);

        $border->delete();

        return response()->json(['message' => 'Border deleted']);
    }

    /**
     * Delete all points in a group.
     */
    public function destroyGroup(Request $request, int $groupId): JsonResponse
    {
        $this->authorizeGroup($request->user(), $groupId);

        Border::where('group_id', $groupId)->delete();

        return response()->json(['message' => "Group {$groupId} deleted"]);
    }

    /**
     * Admins pass. Faculty pass for a brand-new group id, or one whose every
     * row they drew; a wall with any row by someone else (or by nobody, i.e.
     * drawn before attribution) is not theirs to change.
     */
    private function authorizeGroup(User $user, int $groupId): void
    {
        if ($user->isAdmin()) {
            return;
        }

        $notMine = Border::where('group_id', $groupId)
            ->where(fn ($q) => $q->whereNull('created_by')->orWhere('created_by', '!=', $user->id))
            ->exists();

        abort_if($notMine, 403, 'You can only edit walls you drew yourself.');
    }
}
