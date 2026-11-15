<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\RainReport;
use App\Services\WeatherService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class RainReportController extends Controller
{
    /**
     * "It's raining here" from a signed-in student (or staff member). Saves the report, re-checks
     * the cached weather state at once and returns it, so the reporter's own phone updates now.
     * The route's 'rain-report' limiter allows one report per person every 5 minutes.
     */
    public function __invoke(Request $request, WeatherService $weather): JsonResponse
    {
        RainReport::create(['user_id' => $request->user()->id]);

        return response()->json($weather->applyNewRainReport(), 201);
    }
}
