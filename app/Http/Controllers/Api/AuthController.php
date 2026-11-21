<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\ActivityLog;
use App\Models\User;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Validation\ValidationException;

class AuthController extends Controller
{
    /**
     * Login — returns a Sanctum bearer token.
     */
    public function login(Request $request): JsonResponse
    {
        // Emails are stored lowercase (UserController), so sign-in ignores case.
        $request->merge(['email' => strtolower(trim((string) $request->input('email')))]);
        $request->validate([
            'email' => 'required|email',
            'password' => 'required|string',
        ]);

        if (! Auth::attempt($request->only('email', 'password'))) {
            throw ValidationException::withMessages([
                'email' => ['The provided credentials do not match our records.'],
            ]);
        }

        /** @var User $user */
        $user = Auth::user();

        // The admin console is for staff. Students have accounts for the campus
        // directory; they get no admin token.
        if ($user->isStudent()) {
            Auth::guard('web')->logout();
            throw ValidationException::withMessages([
                'email' => ['Student accounts cannot sign in to the admin console.'],
            ]);
        }

        $token = $user->createToken('admin-token')->plainTextToken;
        ActivityLog::record($request, $user, 'login', 'Signed in to the admin console');

        return response()->json([
            'user' => self::userPayload($user),
            'token' => $token,
        ]);
    }

    /**
     * Logout — revoke the current token.
     */
    public function logout(Request $request): JsonResponse
    {
        $request->user()->currentAccessToken()->delete();

        return response()->json(['message' => 'Logged out']);
    }

    /**
     * Get the authenticated user.
     */
    public function user(Request $request): JsonResponse
    {
        return response()->json(self::userPayload($request->user()));
    }

    /**
     * Shared shape for login + me: role and department drive what the admin
     * panel lets this user do (departments panel, node edit scope).
     *
     * @return array{id: int, name: string, email: string, role: string, department: array{id: int, name: string, color: string}|null}
     */
    private static function userPayload(User $user): array
    {
        $user->loadMissing('department:id,name,color');

        return [
            'id' => $user->id,
            'name' => $user->name,
            'email' => $user->email,
            'role' => $user->role,
            'department' => $user->department ? [
                'id' => $user->department->id,
                'name' => $user->department->name,
                'color' => $user->department->color,
            ] : null,
        ];
    }
}
