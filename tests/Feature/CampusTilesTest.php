<?php

namespace Tests\Feature;

use PHPUnit\Framework\Attributes\DataProvider;
use Tests\TestCase;

class CampusTilesTest extends TestCase
{
    /**
     * The archives the maps can be pointed at (TILE_FILE in src/campusMap.js).
     *
     * @return array<string, array{string}>
     */
    public static function archives(): array
    {
        return ['original' => ['university']];
    }

    #[DataProvider('archives')]
    public function test_an_allowed_archive_is_served_with_byte_ranges(string $archive): void
    {
        $path = storage_path("app/{$archive}.pmtiles");
        if (! is_file($path)) {
            $this->markTestSkipped("storage/app/{$archive}.pmtiles is not on this machine.");
        }

        // The PMTiles reader asks for byte ranges; the first 7 bytes are the magic "PMTiles".
        $response = $this->get("/{$archive}.pmtiles", ['Range' => 'bytes=0-6']);

        $response->assertStatus(206);
        $this->assertSame('PMTiles', $response->streamedContent());
    }

    public function test_other_storage_files_are_not_reachable(): void
    {
        $this->get('/secret.pmtiles')->assertNotFound();
        $this->get('/..%2F.env.pmtiles')->assertNotFound();
    }
}
