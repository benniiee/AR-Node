<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * The admin console API is for staff (admin, faculty) only. Student accounts
 * exist for the campus directory, not for editing the map, so a student token
 * must never reach node, wall, building or account endpoints.
 */
class EnsureStaff
{
    /**
     * @param  Closure(Request): (Response)  $next
     */
    public function handle(Request $request, Closure $next): Response
    {
        abort_unless($request->user()?->isStaff(), 403, 'Student accounts cannot use the admin console.');

        return $next($request);
    }
}
