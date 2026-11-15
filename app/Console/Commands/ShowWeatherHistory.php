<?php

namespace App\Console\Commands;

use App\Services\WeatherHistory;
use Illuminate\Console\Command;

class ShowWeatherHistory extends Command
{
    protected $signature = 'weather:history {--days=7 : 1, 7, 30 or 90}';

    protected $description = 'Print the rain and heat prediction history as JSON (read by the ml/gui.py History section)';

    public function handle(WeatherHistory $history): int
    {
        $days = (int) $this->option('days');

        if (! in_array($days, WeatherHistory::PERIODS, true)) {
            $this->error('--days must be one of: '.implode(', ', WeatherHistory::PERIODS));

            return self::INVALID;
        }

        $this->line((string) json_encode($history->summary($days), JSON_UNESCAPED_SLASHES));

        return self::SUCCESS;
    }
}
