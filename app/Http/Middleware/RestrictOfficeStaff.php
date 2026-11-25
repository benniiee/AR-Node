<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * Office staff (a department's staff who are not its head, User::isOfficeStaff) may read the console
 * but change only their own offices: the hours of a place assigned to them (NodeController::update)
 * and its closures (ClosureController). Everything else is the building head's (Dean's) or an admin's.
 * The controllers check that the place is theirs.
 */
class RestrictOfficeStaff
{
    /** Routes office staff may change something through. */
    private const ALLOWED = ['nodes.update', 'closures.store', 'closures.destroy'];

    /**
     * @param  Closure(Request): (Response)  $next
     */
    public function handle(Request $request, Closure $next): Response
    {
        $user = $request->user();
        if ($user?->isOfficeStaff() && ! $request->isMethodSafe() && ! $request->routeIs(...self::ALLOWED) && ! $request->is('api/logout')) {
            abort(403, 'Only the building head can change this. You can set the hours of the offices assigned to you.');
        }

        return $next($request);
    }
}
