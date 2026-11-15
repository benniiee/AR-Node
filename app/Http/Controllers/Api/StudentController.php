<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\User;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Hash;
use Illuminate\Validation\Rule;

/**
 * Student accounts, managed by admins only (the Students tab).
 *
 * A student is a `users` row with role = 'student'. The admin types the school
 * ID (e.g. ae202401622); the email is derived from it, so the two can never
 * disagree.
 */
class StudentController extends Controller
{
    public function index(Request $request): JsonResponse
    {
        abort_unless($request->user()->isAdmin(), 403);

        $students = User::where('role', 'student')
            ->orderBy('last_name')->orderBy('first_name')
            ->get();

        return response()->json($students->map(fn (User $s) => $this->present($s)));
    }

    public function store(Request $request): JsonResponse
    {
        abort_unless($request->user()->isAdmin(), 403);

        $request->merge(['student_number' => strtolower(trim((string) $request->input('student_number')))]);
        $validated = $request->validate($this->rules() + [
            'student_number' => ['required', 'string', 'regex:'.User::STUDENT_NUMBER_PATTERN, Rule::unique('users', 'student_number')],
            'password' => 'required|string|min:8',
        ]);

        $email = User::studentEmail($validated['student_number']);
        abort_if(User::where('email', $email)->exists(), 422, "{$email} is already used by another account.");

        $student = User::create([
            'name' => $this->fullName($validated),
            'email' => $email,
            'password' => Hash::make($validated['password']),
            'role' => 'student',
            'student_number' => $validated['student_number'],
            'first_name' => $validated['first_name'],
            'last_name' => $validated['last_name'],
            'course' => $validated['course'],
            'year_level' => $validated['year_level'],
        ]);

        return response()->json($this->present($student), 201);
    }

    /**
     * Edit details; `password` is optional (blank keeps the current one, a
     * value resets it). The school ID can be corrected; the email follows it.
     */
    public function update(Request $request, User $student): JsonResponse
    {
        abort_unless($request->user()->isAdmin(), 403);
        abort_unless($student->isStudent(), 404);

        if ($request->has('student_number')) {
            $request->merge(['student_number' => strtolower(trim((string) $request->input('student_number')))]);
        }
        $validated = $request->validate([
            'first_name' => 'sometimes|required|string|max:100',
            'last_name' => 'sometimes|required|string|max:100',
            'course' => ['sometimes', 'required', Rule::in(array_keys(User::COURSES))],
            'year_level' => 'sometimes|required|integer|min:1|max:'.User::MAX_YEAR_LEVEL,
            'student_number' => ['sometimes', 'required', 'string', 'regex:'.User::STUDENT_NUMBER_PATTERN, Rule::unique('users', 'student_number')->ignore($student->id)],
            'password' => 'nullable|string|min:8',
        ]);

        if (isset($validated['student_number'])) {
            $email = User::studentEmail($validated['student_number']);
            abort_if(User::where('email', $email)->whereKeyNot($student->id)->exists(), 422, "{$email} is already used by another account.");
            $student->email = $email;
        }

        $password = $validated['password'] ?? null;
        unset($validated['password']);
        $student->fill($validated);
        $student->name = $this->fullName($student->only(['first_name', 'last_name']));
        if ($password) {
            $student->password = Hash::make($password);
            // A reset signs the student out everywhere.
            $student->tokens()->delete();
        }
        $student->save();

        return response()->json($this->present($student));
    }

    /**
     * Admin password reset: a one-time temporary password the admin hands to the
     * student. Their open sessions end, and they must choose their own password
     * at the next sign-in. The temporary password is returned once and never stored
     * in plain text.
     */
    public function resetPassword(Request $request, User $student): JsonResponse
    {
        abort_unless($request->user()->isAdmin(), 403);
        abort_unless($student->isStudent(), 404);

        $temporary = self::temporaryPassword();
        $student->forceFill([
            'password' => Hash::make($temporary),
            'must_change_password' => true,
        ])->save();
        $student->tokens()->delete();

        return response()->json([
            'temporary_password' => $temporary,
            'student' => $this->present($student),
        ]);
    }

    /**
     * Ten characters that are easy to read aloud and type: no 0/O, 1/l/I.
     */
    private static function temporaryPassword(): string
    {
        $alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
        $out = '';
        for ($i = 0; $i < 10; $i++) {
            $out .= $alphabet[random_int(0, strlen($alphabet) - 1)];
        }

        return substr($out, 0, 5).'-'.substr($out, 5);
    }

    public function destroy(Request $request, User $student): JsonResponse
    {
        abort_unless($request->user()->isAdmin(), 403);
        abort_unless($student->isStudent(), 404);

        $student->tokens()->delete();
        $student->delete();

        return response()->json(['message' => 'Student removed']);
    }

    /**
     * @return array<string, mixed>
     */
    private function rules(): array
    {
        return [
            'first_name' => 'required|string|max:100',
            'last_name' => 'required|string|max:100',
            'course' => ['required', Rule::in(array_keys(User::COURSES))],
            'year_level' => 'required|integer|min:1|max:'.User::MAX_YEAR_LEVEL,
        ];
    }

    /**
     * @param  array{first_name?: string|null, last_name?: string|null}  $parts
     */
    private function fullName(array $parts): string
    {
        return trim(($parts['first_name'] ?? '').' '.($parts['last_name'] ?? ''));
    }

    /**
     * @return array{id: int, student_number: string|null, email: string, first_name: string|null, last_name: string|null, name: string, course: string|null, course_name: string|null, year_level: int|null, must_change_password: bool, created_at: string|null}
     */
    private function present(User $s): array
    {
        return [
            'id' => $s->id,
            'student_number' => $s->student_number,
            'email' => $s->email,
            'first_name' => $s->first_name,
            'last_name' => $s->last_name,
            'name' => $s->name,
            'course' => $s->course,
            'course_name' => User::COURSES[$s->course] ?? null,
            'year_level' => $s->year_level,
            'must_change_password' => (bool) $s->must_change_password,
            'created_at' => $s->created_at?->toIso8601String(),
        ];
    }
}
