<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Services\WeatherService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Cache;

class WeatherRefreshController extends Controller
{
    /**
     * "Update now" on the admin Weather Dashboard (admin only): the same refresh the
     * 20-minute schedule runs (rain model, heat outlook, history row), on demand.
     *
     * A lock stops double clicks and a click during a running refresh from calling the
     * providers twice; the route's throttle caps how often one admin can press it.
     */
    public function __invoke(Request $request, WeatherService $weather): JsonResponse
    {
        abort_unless($request->user()->isAdmin(), 403);

        // A refresh normally takes seconds, but network retries (DNS drop-outs) and the satellite
        // read (weather.satellite_timeout) may take longer than the web server's usual 30 s limit.
        $seconds = (int) config('weather.satellite_timeout', 120) + 60;
        set_time_limit($seconds);

        $lock = Cache::lock('weather:manual-refresh', $seconds);
        if (! $lock->get()) {
            return response()->json(['message' => 'A weather update is already running. Try again in a moment.'], 409);
        }

        try {
            $state = $weather->refresh();
        } finally {
            $lock->release();
        }

        if (! is_array($state)) {
            return response()->json(['message' => 'The weather service could not be reached. The last good forecast is still in use.'], 502);
        }

        return response()->json($state);
    }
}
