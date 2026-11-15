<?php

use App\Models\RainReport;
use App\Models\WeatherPrediction;
use Illuminate\Foundation\Inspiring;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\Schedule;

Artisan::command('inspire', function () {
    $this->comment(Inspiring::quote());
})->purpose('Display an inspiring quote');

// Every 10 minutes, the Himawari scan interval: a new satellite image (and any new airport
// report) reaches students within 10 minutes, and every 15-minute model step gets scored.
// Open-Meteo's own numbers change more slowly (hourly output, interpolated to 15 minutes here).
// Each refresh makes about five provider calls (routing state, rain model inputs, several
// models, airport reports, heat model inputs), so ~720 calls/day, well inside the free tier,
// plus two new satellite strips (~2.5 MB) per refresh (earlier ones are cached).
// withoutOverlapping() guards the slow cases (provider timeouts, an uncached satellite read).
Schedule::command('weather:refresh')
    ->cron('*/10 * * * *')
    ->withoutOverlapping(15);

// Remove sign-in tokens that expired more than a day ago (config/sanctum.php: 30 days).
Schedule::command('sanctum:prune-expired --hours=24')->daily();

// Delete prediction history and rain reports older than their KEEP_DAYS (180 days).
Schedule::command('model:prune', ['--model' => [WeatherPrediction::class, RainReport::class]])->daily();

// Public map file (nodes, staircases, walls, buildings, pathways) on the same
// 20-minute beat, so a phone's automatic sync always finds both files fresh.
// Model events already rewrite it after normal edits; this catches bulk
// inserts and raw queries. Cheap: it rewrites only when the map changed.
Schedule::command('map:snapshot')
    ->cron('*/20 * * * *')
    ->withoutOverlapping(10);
