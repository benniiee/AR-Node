<?php

use App\Http\Controllers\Api\AuthController;
use App\Http\Controllers\Api\BorderController;
use App\Http\Controllers\Api\BridgeController;
use App\Http\Controllers\Api\BuildingController;
use App\Http\Controllers\Api\CampusAreaController;
use App\Http\Controllers\Api\DepartmentController;
use App\Http\Controllers\Api\MapDataController;
use App\Http\Controllers\Api\NodeController;
use App\Http\Controllers\Api\NodeLinkController;
use App\Http\Controllers\Api\PathwayController;
use App\Http\Controllers\Api\RainReportController;
use App\Http\Controllers\Api\StudentAuthController;
use App\Http\Controllers\Api\StudentController;
use App\Http\Controllers\Api\UserController;
use App\Http\Controllers\Api\WeatherController;
use App\Http\Controllers\Api\WeatherHistoryController;
use App\Http\Controllers\Api\WeatherRefreshController;
use App\Http\Middleware\EnsureStaff;
use Illuminate\Support\Facades\Route;

// Public reads, throttled by the 'public-read' limiter (AppServiceProvider).
// Map data: visitors get building locations only; a member token gets the full map.
Route::get('/map-data', MapDataController::class)->middleware('throttle:public-read');

// Campus weather state for weather-aware routing. Separate from /api/map-data
// so a 20-minute refresh never invalidates the graph cache.
Route::get('/weather', WeatherController::class)->middleware('throttle:public-read');

// Student sign-in for /map (the admin console refuses student accounts).
// Throttled by the 'sign-in' limiter: 10 attempts a minute per IP.
Route::post('/student/login', [StudentAuthController::class, 'login'])->middleware('throttle:sign-in');
Route::middleware('auth:sanctum')->group(function () {
    // "It's raining here" (students and staff): one report per person every 5 minutes.
    Route::post('/weather/rain-report', RainReportController::class)->middleware('throttle:rain-report');
    Route::get('/student/me', [StudentAuthController::class, 'me']);
    Route::post('/student/password', [StudentAuthController::class, 'changePassword'])->middleware('throttle:sign-in');
    Route::post('/student/logout', [StudentAuthController::class, 'logout']);
});

// Admin console sign-in (staff accounts), throttled like the student login.
Route::post('/login', [AuthController::class, 'login'])->middleware('throttle:sign-in');

// Protected: admin console endpoints, staff (admin / faculty) only. Student
// accounts authenticate but are refused here by EnsureStaff.
Route::middleware(['auth:sanctum', EnsureStaff::class])->group(function () {
    Route::get('/user', [AuthController::class, 'user']);
    Route::post('/logout', [AuthController::class, 'logout']);

    // Swap two offices' names + departments in place (admin only). Declared
    // before the resource so "swap" is never read as a {node} id.
    Route::post('/nodes/swap', [NodeController::class, 'swap']);
    Route::apiResource('nodes', NodeController::class);

    // Labelled buildings and the road/walkway network: any staff member may
    // read. Admins create, delete and reassign buildings and edit pathways;
    // department staff edit their own department's building (shape details,
    // doors). Enforced in the controllers.
    Route::apiResource('buildings', BuildingController::class);
    Route::apiResource('pathways', PathwayController::class);
    // Campus areas (Campus A, Campus B, ...): staff read, admins edit (enforced in the controller).
    Route::apiResource('campus-areas', CampusAreaController::class);
    Route::post('/pathways/{pathway}/route-nodes', [PathwayController::class, 'generateRouteNodes']);
    // Bridges and other connectors: staff read, admins edit (enforced in the controller).
    Route::apiResource('bridges', BridgeController::class);
    Route::post('/bridges/{bridge}/route-nodes', [BridgeController::class, 'generateRouteNodes']);

    Route::get('/node-links', [NodeLinkController::class, 'index']);
    Route::post('/node-links', [NodeLinkController::class, 'store']);
    Route::put('/node-links/{nodeLink}', [NodeLinkController::class, 'update']);
    Route::delete('/node-links/{nodeLink}', [NodeLinkController::class, 'destroy']);

    Route::apiResource('borders', BorderController::class)->only(['index', 'store', 'destroy']);
    Route::delete('/borders/group/{groupId}', [BorderController::class, 'destroyGroup']);

    // Departments: anyone logged in may list (map label colours); only
    // admins may create/rename/recolour/delete (enforced in controller).
    Route::apiResource('departments', DepartmentController::class);

    // Users: admin only (enforced in controller) — list faculty, create
    // accounts, assign roles + departments.
    Route::get('/users', [UserController::class, 'index']);
    Route::post('/users', [UserController::class, 'store']);
    Route::put('/users/{user}', [UserController::class, 'update']);
    Route::delete('/users/{user}', [UserController::class, 'destroy']);

    // Students (admin only, enforced in controller): the Students tab.
    Route::get('/students', [StudentController::class, 'index']);
    Route::post('/students', [StudentController::class, 'store']);
    Route::put('/students/{student}', [StudentController::class, 'update']);
    Route::delete('/students/{student}', [StudentController::class, 'destroy']);
    // Admin password reset: returns a one-time temporary password.
    Route::post('/students/{student}/reset-password', [StudentController::class, 'resetPassword']);

    // Rain and heat model history (admin only, enforced in controller): the Weather tab.
    Route::get('/weather/history', WeatherHistoryController::class);
    // "Update now" on the Weather Dashboard (admin only): refresh without waiting for the schedule.
    Route::post('/weather/refresh', WeatherRefreshController::class)->middleware('throttle:weather-refresh');
});
