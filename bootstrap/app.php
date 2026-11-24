<?php

use Illuminate\Auth\Middleware\Authenticate;
use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\Exceptions;
use Illuminate\Foundation\Configuration\Middleware;
use Illuminate\Http\Request;

return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        web: __DIR__.'/../routes/web.php',
        api: __DIR__.'/../routes/api.php',
        commands: __DIR__.'/../routes/console.php',
        health: '/up',
    )
    ->withMiddleware(function (Middleware $middleware): void {
        // Add ngrok's skip-warning header to every response so the free-plan interstitial
        // is never shown on fresh mobile visits (PWA manifest, service worker, tiles).
        $middleware->append(\App\Http\Middleware\NgrokTunnelHeaders::class);

        // API-only app: return 401 JSON instead of redirecting to a
        // non-existent "login" route when auth:sanctum rejects a request.
        Authenticate::redirectUsing(
            fn () => null,
        );

        // Behind a reverse proxy or load balancer (TLS terminated in front of
        // PHP), list its address(es) in TRUSTED_PROXIES (comma-separated, or *),
        // so request IPs (login throttling) and https URLs are the client's.
        // Unset: no proxy is trusted.
        $trustedProxies = env('TRUSTED_PROXIES');
        if (is_string($trustedProxies) && $trustedProxies !== '') {
            $middleware->trustProxies(at: $trustedProxies === '*'
                ? '*'
                : array_map('trim', explode(',', $trustedProxies)));
        }
    })
    ->withExceptions(function (Exceptions $exceptions): void {
        $exceptions->shouldRenderJsonWhen(
            fn (Request $request) => $request->is('api/*') || $request->expectsJson(),
        );
    })->create();
