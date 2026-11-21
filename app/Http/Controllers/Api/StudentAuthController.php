<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\ActivityLog;
use App\Models\User;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Hash;
use Illuminate\Validation\ValidationException;

/**
 * Student sign-in for the campus map (/map).
 *
 * Students sign in with their school ID (ae202401622) or school email. The
 * token they get unlocks the full map feed and routing; it is refused by every
 * admin-console endpoint (EnsureStaff). Staff use the admin console sign-in.
 */
class StudentAuthController extends Controller
{
    public function login(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'login' => 'required|string|max:255',
            'password' => 'required|string',
        ]);

        $login = strtolower(trim($validated['login']));
        $student = User::where('role', 'student')
            ->where(fn ($q) => $q->where('student_number', $login)->orWhere('email', $login))
            ->first();

        // One message for "no such student" and "wrong password", so the form
        // never reveals which school IDs exist.
        if (! $student || ! Hash::check($validated['password'], $student->password)) {
            throw ValidationException::withMessages([
                'login' => ['That school ID or password is not right.'],
            ]);
        }

        ActivityLog::record($request, $student, 'login', 'Signed in to the campus map');

        return response()->json([
            'user' => self::profile($student),
            'token' => $student->createToken('student-map')->plainTextToken,
        ]);
    }

    public function me(Request $request): JsonResponse
    {
        $user = $request->user();
        abort_unless($user->isStudent(), 403, 'This is the student sign-in.');

        return response()->json(self::profile($user));
    }

    /**
     * The student chooses their own password: after an admin reset (required) or
     * any time. The current (or temporary) password must be given.
     */
    public function changePassword(Request $request): JsonResponse
    {
        $student = $request->user();
        abort_unless($student->isStudent(), 403, 'This is the student sign-in.');

        $validated = $request->validate([
            'current_password' => 'required|string',
            'password' => 'required|string|min:8|confirmed|different:current_password',
        ], [
            'password.different' => 'Choose a password that is different from the temporary one.',
        ]);

        if (! Hash::check($validated['current_password'], $student->password)) {
            throw ValidationException::withMessages([
                'current_password' => ['That is not your current password.'],
            ]);
        }

        $student->forceFill([
            'password' => Hash::make($validated['password']),
            'must_change_password' => false,
        ])->save();
        // Other devices sign out; this one keeps its session.
        $current = $student->currentAccessToken();
        $student->tokens()->when($current?->id, fn ($q, $id) => $q->whereKeyNot($id))->delete();

        return response()->json(['user' => self::profile($student)]);
    }

    public function logout(Request $request): JsonResponse
    {
        $request->user()->currentAccessToken()?->delete();

        return response()->json(['message' => 'Signed out']);
    }

    /**
     * @return array{id: int, name: string, first_name: string|null, student_number: string|null, email: string, course: string|null, course_name: string|null, year_level: int|null, must_change_password: bool}
     */
    private static function profile(User $student): array
    {
        return [
            'id' => $student->id,
            'name' => $student->name,
            'first_name' => $student->first_name,
            'student_number' => $student->student_number,
            'email' => $student->email,
            'course' => $student->course?->code,
            'course_name' => $student->course?->name,
            'year_level' => $student->year_level,
            'must_change_password' => (bool) $student->must_change_password,
        ];
    }
}
