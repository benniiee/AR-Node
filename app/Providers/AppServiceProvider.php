<?php

namespace App\Providers;

use App\Models\Border;
use App\Models\Bridge;
use App\Models\Building;
use App\Models\CampusArea;
use App\Models\Node;
use App\Models\NodeLink;
use App\Models\Pathway;
use App\Services\MapSnapshot;
use Illuminate\Cache\RateLimiting\Limit;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Support\ServiceProvider;

class AppServiceProvider extends ServiceProvider
{
    /**
     * Register any application services.
     */
    public function register(): void
    {
        //
    }

    /**
     * Bootstrap any application services.
     */
    public function boot(): void
    {
        // Keep storage/app/public/data/map.json in step with the database. The rewrite runs
        // after the admin's response is sent and is skipped when nothing really changed.
        foreach ([Node::class, Border::class, NodeLink::class, Building::class, Pathway::class, CampusArea::class, Bridge::class] as $model) {
            $model::saved(fn () => MapSnapshot::refreshAfterResponse());
            $model::deleted(fn () => MapSnapshot::refreshAfterResponse());
        }

        // Named limiters, so each has its own counter. (A plain throttle:10,1 keys only on
        // the IP, so every throttled route shared ONE counter: map reads used up logins.)
        // Sign-in, against password guessing: only FAILED tries count (a 422), 10 a minute per
        // account per address, and 100 a minute per address across accounts. Successful sign-ins
        // never count, because many phones can share one public address (mobile carriers do this).
        RateLimiter::for('sign-in', function (Request $request) {
            $failed = fn ($response): bool => $response->getStatusCode() === 422;
            $account = strtolower(trim((string) ($request->input('login') ?? $request->input('email') ?? '')));

            return [
                Limit::perMinute(10)->by($request->path().'|'.$account.'|'.$request->ip())->after($failed),
                Limit::perMinute(100)->by($request->path().'|'.$request->ip())->after($failed),
            ];
        });
        // Public reads (/api/map-data, /api/weather): phones normally read the static files
        // in /storage/data/, so these are fallbacks. Generous, because many phones can share
        // one public address.
        RateLimiter::for('public-read', fn (Request $request) => Limit::perMinute(120)->by($request->ip()));
        // Visitor activity from the public map: a few events per route, so 30 a minute per IP is plenty.
        RateLimiter::for('activity', fn (Request $request) => Limit::perMinute(30)->by('activity|'.$request->ip()));
        // Manual weather refresh from the admin Weather Dashboard: each one makes 4-5 calls to the
        // free Open-Meteo and aviationweather.gov services, so a few per minute is plenty.
        RateLimiter::for('weather-refresh', fn (Request $request) => Limit::perMinute(3)->by((string) ($request->user()?->id ?? $request->ip())));
        // "It's raining here": one report per person every 5 minutes. Several people are needed to
        // turn rain on (weather.reports_min_people), so one account tapping again changes nothing.
        RateLimiter::for('rain-report', fn (Request $request) => Limit::perMinutes(5, 1)->by('rain-report|'.$request->user()?->id)
            ->response(fn () => response()->json(['message' => 'Thanks, your rain report is already counted. You can send another in a few minutes.'], 429)));
    }
}
