<?php

namespace App\Console\Commands;

use App\Services\MapSnapshot;
use App\Services\PublicData;
use Illuminate\Console\Command;

class SnapshotMap extends Command
{
    protected $signature = 'map:snapshot {--force : Rewrite the file even if nothing changed}';

    protected $description = 'Write the public map snapshot (storage/app/public/data/map.json) that phones download for offline use';

    public function handle(): int
    {
        $result = MapSnapshot::refresh((bool) $this->option('force'));
        $file = PublicData::read(MapSnapshot::FILE);

        if ($result === MapSnapshot::FAILED || ! is_array($file)) {
            $this->error('Could not write '.PublicData::path(MapSnapshot::FILE).' - check that storage/app/public is writable.');

            return self::FAILURE;
        }

        $this->info(sprintf(
            '%s %s (%d places, %d staircases, hash %s)',
            $result === MapSnapshot::WRITTEN ? 'Wrote' : 'Unchanged:',
            PublicData::path(MapSnapshot::FILE),
            count($file['nodes'] ?? []),
            count($file['links'] ?? []),
            $file['hash'] ?? '?',
        ));

        return self::SUCCESS;
    }
}
