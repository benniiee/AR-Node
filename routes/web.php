<?php

use Illuminate\Support\Facades\Route;

// The app has no landing page: the root opens the campus map.
Route::redirect('/', '/map');

// 2D navigate/map page. The extensionless URL is routed here on purpose: the
// Vite dev server resolves /map via its own HTML fallback, and this route makes
// the same URL resolve through Laravel once the frontend has been built.
Route::get('/map', function () {
    $path = public_path('admin/map.html');
    abort_unless(is_file($path), 404);

    return response()->file($path, [
        'Content-Type' => 'text/html; charset=UTF-8',
    ]);
});

// Admin console (built index.html), same serving rule as /map.
Route::get('/admin', function () {
    $path = public_path('admin/index.html');
    abort_unless(is_file($path), 404);

    return response()->file($path, [
        'Content-Type' => 'text/html; charset=UTF-8',
    ]);
});

// iPhone install check: a form an iPhone user fills in when ARNode will not install
// or open; it builds a report they copy back into chat (built iphone-check.html).
Route::get('/iphone-check', function () {
    $path = public_path('admin/iphone-check.html');
    abort_unless(is_file($path), 404);

    return response()->file($path, [
        'Content-Type' => 'text/html; charset=UTF-8',
    ]);
});

// Campus vector tiles (PMTiles archive). Served through an explicit route
// (not public/) so responses go through BinaryFileResponse, which supports
// HTTP Range requests, required by the pmtiles reader. The PHP dev server
// serves public/ files directly WITHOUT range support, which would break
// tile loading in local development.
//
// Which archive the maps use is TILE_FILE in src/campusMap.js; only the names
// listed here are served (no other storage/app file is reachable).
Route::get('/{archive}.pmtiles', function (string $archive) {
    $path = storage_path("app/{$archive}.pmtiles");
    abort_unless(is_file($path), 404);

    return response()->file($path, [
        'Content-Type' => 'application/octet-stream',
    ]);
})->whereIn('archive', ['university']);
