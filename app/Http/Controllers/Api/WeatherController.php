<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Services\WeatherService;
use Illuminate\Http\JsonResponse;

class WeatherController extends Controller
{
    /**
     * Public campus weather state.
     *
     * Kept separate from /api/map-data on purpose: that feed carries a change
     * `version`, so mixing weather into it would make every phone re-download
     * the whole graph every time the forecast refreshes.
     */
    public function __invoke(WeatherService $weather): JsonResponse
    {
        return response()->json($weather->current(), 200, [
            'Cache-Control' => 'public, max-age=60',
        ]);
    }
}
