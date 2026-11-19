<?php

namespace App\Console\Commands;

use App\Models\WeatherEnsemble;
use Illuminate\Console\Command;

class ExportWeatherEnsembles extends Command
{
    protected $signature = 'weather:ensemble-export {--path= : CSV file to write (default ml/data/ensemble_live.csv)}';

    protected $description = 'Write the recorded ensemble forecasts to a CSV for ml/ training (one row per refresh, model and hour)';

    public function handle(): int
    {
        $path = (string) ($this->option('path') ?: base_path('ml/data/ensemble_live.csv'));
        if (! is_dir(dirname($path)) || ($file = fopen($path, 'w')) === false) {
            $this->error("Cannot write {$path}");

            return self::FAILURE;
        }

        fputcsv($file, ['fetched_at', 'model', 'members', 'at', 'wet_share', 'heavy_share', 'mean_mm', 'max_mm'], escape: '');
        $rows = 0;
        WeatherEnsemble::query()->orderBy('fetched_at')->chunkById(500, function ($chunk) use ($file, &$rows): void {
            foreach ($chunk as $ensemble) {
                foreach ($ensemble->models as $model => $summary) {
                    foreach ($summary['hours'] ?? [] as $hour) {
                        fputcsv($file, [
                            // Campus time, like every other ml/data/*.csv.
                            $ensemble->fetched_at->copy()->setTimezone('Asia/Manila')->format('Y-m-d H:i'),
                            $model, $summary['members'] ?? null, $hour['at'] ?? null, $hour['wet_share'] ?? null,
                            $hour['heavy_share'] ?? null, $hour['mean_mm'] ?? null, $hour['max_mm'] ?? null,
                        ], escape: '');
                        $rows++;
                    }
                }
            }
        });
        fclose($file);

        $this->info("Wrote {$rows} rows to {$path}");

        return self::SUCCESS;
    }
}
