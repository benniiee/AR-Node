<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Services\MapSnapshot;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class MapDataController extends Controller
{
    /**
     * The campus map, filtered by who is asking (server-side, never trusted
     * to the page):
     *  - signed in (student, faculty, admin bearer token): the full map, i.e.
     *    offices, rooms, route nodes, staircases, walls, buildings, pathways
     *  - visitor (no token): building locations only
     *
     * The route stays outside auth:sanctum so visitors can still call it; the
     * token is read when one is sent.
     */
    public function __invoke(Request $request): JsonResponse
    {
        $member = $request->user('sanctum') !== null;

        return response()
            ->json($member ? MapSnapshot::payload() : MapSnapshot::visitorPayload())
            // Two audiences behind one URL: caches must key on the token.
            ->header('Vary', 'Authorization');
    }
}
