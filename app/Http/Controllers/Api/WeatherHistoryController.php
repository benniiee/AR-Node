<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Services\WeatherHistory;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;

class WeatherHistoryController extends Controller
{
    /**
     * The rain and heat models' real-world record for the admin Weather page (admin only).
     */
    public function __invoke(Request $request, WeatherHistory $history): JsonResponse
    {
        abort_unless($request->user()->isAdmin(), 403);

        $validated = $request->validate([
            'days' => ['sometimes', 'integer', Rule::in(WeatherHistory::PERIODS)],
        ]);

        return response()->json($history->summary((int) ($validated['days'] ?? 7)));
    }
}
