<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\User;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Hash;

class UserController extends Controller
{
    /**
     * List all users with their departments (admin only).
     */
    public function index(Request $request): JsonResponse
    {
        abort_unless($request->user()->isAdmin(), 403);

        // Staff only: students are managed in their own tab (StudentController).
        $users = User::with('department:id,name,color')->whereIn('role', User::STAFF_ROLES)->orderBy('name')->get();

        return response()->json($users->map(fn (User $u) => [
            'id' => $u->id,
            'name' => $u->name,
            'email' => $u->email,
            'role' => $u->role,
            'department' => $u->department ? [
                'id' => $u->department->id,
                'name' => $u->department->name,
                'color' => $u->department->color,
            ] : null,
        ]));
    }

    /**
     * Create a faculty or admin account and assign a department (admin only).
     * Any admin may create further admins, so the map is not tied to one
     * person.
     */
    public function store(Request $request): JsonResponse
    {
        abort_unless($request->user()->isAdmin(), 403);

        // Stored lowercase so "Juan@school.edu" and "juan@school.edu" are one account (PostgreSQL compares case).
        $request->merge(['email' => strtolower(trim((string) $request->input('email')))]);
        $validated = $request->validate([
            'name' => 'required|string|max:255',
            'email' => 'required|email|unique:users,email',
            'password' => 'required|string|min:8',
            'role' => 'sometimes|in:admin,faculty',
            'department_id' => 'nullable|exists:departments,id',
        ]);

        $user = User::create([
            'name' => $validated['name'],
            'email' => $validated['email'],
            'password' => Hash::make($validated['password']),
            'role' => $validated['role'] ?? 'faculty',
            'department_id' => $validated['department_id'] ?? null,
        ]);

        return response()->json([
            'id' => $user->id,
            'name' => $user->name,
            'email' => $user->email,
            'role' => $user->role,
            'department_id' => $user->department_id,
        ], 201);
    }

    /**
     * Assign a role / department to a user (admin only).
     */
    public function update(Request $request, User $user): JsonResponse
    {
        abort_unless($request->user()->isAdmin(), 403);
        abort_if($user->isStudent(), 404);

        // An admin must not demote themselves out of the admin role — that
        // would lock everybody out of department management.
        if ($user->is($request->user()) && $request->has('role') && $request->input('role') !== 'admin') {
            abort(422, 'You cannot change your own admin role.');
        }

        $validated = $request->validate([
            'role' => 'sometimes|required|in:admin,faculty',
            'department_id' => 'nullable|exists:departments,id',
        ]);

        // Several admins may share the work, but there must always be one.
        if (($validated['role'] ?? $user->role) !== 'admin' && $user->isAdmin() && $this->isLastAdmin($user)) {
            abort(422, 'At least one admin account must remain.');
        }

        $user->update($validated);

        return response()->json([
            'id' => $user->id,
            'name' => $user->name,
            'email' => $user->email,
            'role' => $user->role,
            'department_id' => $user->department_id,
        ]);
    }

    /**
     * Remove an account (admin only). Nobody can remove their own account or
     * the last admin. Nodes the account placed stay on the map; their creator
     * simply becomes unknown (created_by nulls out).
     */
    public function destroy(Request $request, User $user): JsonResponse
    {
        abort_unless($request->user()->isAdmin(), 403);
        abort_if($user->isStudent(), 404);

        if ($user->is($request->user())) {
            abort(422, 'You cannot remove your own account.');
        }

        if ($user->isAdmin() && $this->isLastAdmin($user)) {
            abort(422, 'At least one admin account must remain.');
        }

        $user->tokens()->delete();
        $user->delete();

        return response()->json(['message' => 'Account removed']);
    }

    private function isLastAdmin(User $user): bool
    {
        return ! User::where('role', 'admin')->whereKeyNot($user->id)->exists();
    }
}
