<?php

namespace App\Http\Middleware;

use App\Models\ActivityLog;
use Closure;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Str;
use Symfony\Component\HttpFoundation\Response;

/**
 * Logs every successful change a staff member makes through the API (POST, PUT, PATCH,
 * DELETE on the staff routes), so each feature is covered without code of its own.
 * It records which fields were sent, never their values (passwords stay out).
 */
class LogStaffActions
{
    /** The URL segment as people say it. */
    private const NOUNS = [
        'node-links' => 'staircase', 'borders' => 'wall', 'campus-areas' => 'campus area', 'users' => 'staff account',
        'students' => 'student account', 'weather' => 'weather',
    ];

    /** Actions that are not add / edit / remove. */
    private const VERBS = [
        'route-nodes' => 'Laid route nodes along', 'reset-password' => 'Reset the password of', 'swap' => 'Swapped two nodes',
        'refresh' => 'Refreshed the weather', 'logout' => 'Signed out',
    ];

    private const SECRET_FIELDS = ['password', 'password_confirmation', 'current_password', 'token'];

    public function handle(Request $request, Closure $next): Response
    {
        $response = $next($request);

        if (in_array($request->method(), ['POST', 'PUT', 'PATCH', 'DELETE'], true) && $response->isSuccessful() && $request->user()) {
            $uri = (string) $request->route()?->uri();
            ActivityLog::record($request, $request->user(), "{$request->method()} {$uri}", $this->summary($request, $uri, $response),
                ['fields' => array_slice(array_keys($request->except(self::SECRET_FIELDS)), 0, 30)]);
        }

        return $response;
    }

    private function summary(Request $request, string $uri, Response $response): string
    {
        $parts = explode('/', Str::after($uri, 'api/'));
        $noun = self::NOUNS[$parts[0]] ?? str_replace('-', ' ', Str::singular($parts[0]));
        $last = end($parts);
        $verb = self::VERBS[$last] ?? match (true) {
            $request->method() === 'DELETE' => 'Removed',
            in_array($request->method(), ['PUT', 'PATCH'], true) => 'Edited',
            count($parts) === 1 => 'Added',
            default => ucfirst(str_replace('-', ' ', $last)),
        };
        if (in_array($last, ['swap', 'refresh', 'logout'], true)) {
            return $verb;
        }

        return trim("{$verb} {$this->subject($request, $noun, $response)}");
    }

    /** "node #12 (Room 101)": the route's model, or for an add the new row in the response. */
    private function subject(Request $request, string $noun, Response $response): string
    {
        $model = collect($request->route()?->parameters() ?? [])->first(fn ($p) => $p instanceof Model);
        if ($model) {
            return $this->label($noun, $model->getKey(), $model->getAttribute('name') ?? $model->getAttribute('short_name'));
        }
        $data = $response instanceof JsonResponse ? $response->getData(true) : null;

        return is_array($data) && isset($data['id']) ? $this->label($noun, $data['id'], $data['name'] ?? null) : $noun;
    }

    private function label(string $noun, mixed $id, mixed $name): string
    {
        return "{$noun} #{$id}".(is_string($name) && $name !== '' ? " ({$name})" : '');
    }
}
