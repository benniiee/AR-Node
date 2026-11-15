<?php

namespace App\Console\Commands;

use App\Services\WeatherService;
use Illuminate\Console\Command;

class RefreshWeather extends Command
{
    protected $signature = 'weather:refresh';

    protected $description = 'Refresh the cached campus weather state used by weather-aware routing';

    public function handle(WeatherService $weather): int
    {
        $state = $weather->refresh();

        if (! is_array($state)) {
            $this->error('Weather refresh failed — keeping the last good state.');

            return self::FAILURE;
        }

        $this->info(sprintf(
            'Weather: %s · raining now %s (%s) · rain %s%% (%s) · rain mode %s · heat index %s °C · heat mode %s',
            $state['status'],
            ($state['raining_now'] ?? false) ? 'YES' : 'no',
            ($state['raining_now_source'] ?? null) === 'airport' ? 'airport report' : 'forecast model',
            $state['rain_probability'] ?? '—',
            $state['probability_source'] === 'model' ? 'campus AI model' : ($state['probability_source'] ?? 'no source'),
            $state['rain_mode'] ? 'ON' : 'OFF',
            $state['heat_index_c'] ?? '—',
            ($state['heat_mode'] ?? false) ? 'ON' : 'OFF',
        ));

        return self::SUCCESS;
    }
}
