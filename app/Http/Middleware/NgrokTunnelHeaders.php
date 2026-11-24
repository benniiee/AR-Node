<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

class NgrokTunnelHeaders
{
    /**
     * Add the ngrok browser-warning bypass header to every response.
     *
     * ngrok's free plan intercepts browser requests that lack its session cookie and
     * serves an HTML warning page instead of the real resource. Static assets such as
     * the PWA manifest, service worker and PMTiles archive are requested by the browser
     * or service worker before that cookie exists, so the app cannot install or render
     * on a fresh phone. Returning this header in the *response* tells ngrok to skip the
     * interstitial regardless of whether the browser cookie is present.
     *
     * @param  Closure(Request): (Response)  $next
     */
    public function handle(Request $request, Closure $next): Response
    {
        $response = $next($request);
        $response->headers->set('ngrok-skip-browser-warning', 'true');

        return $response;
    }
}
