<?php

namespace Tests\Unit;

use App\Services\MapSnapshot;
use PHPUnit\Framework\TestCase;

class MapSnapshotTest extends TestCase
{
    private function node(int $id, string $name = 'Gate'): array
    {
        return ['id' => $id, 'name' => $name, 'latitude' => 6.9131, 'longitude' => 122.0621, 'path_type' => 'outside'];
    }

    public function test_shape_groups_borders_in_database_order(): void
    {
        $payload = MapSnapshot::shape(
            [3 => $this->node(1), 9 => $this->node(2)],
            [],
            [
                ['group_id' => '2', 'latitude' => 1.0, 'longitude' => 2.0],
                ['group_id' => 1, 'latitude' => 3.0, 'longitude' => 4.0],
                ['group_id' => 2, 'latitude' => 5.0, 'longitude' => 6.0],
            ],
            42,
        );

        $this->assertSame(42, $payload['version']);
        $this->assertSame([0, 1], array_keys($payload['nodes']));                  // lists, not keyed objects
        $this->assertSame([2, 1], array_column($payload['borders'], 'group_id'));
        $this->assertSame(
            [['lat' => 1.0, 'lng' => 2.0], ['lat' => 5.0, 'lng' => 6.0]],
            $payload['borders'][0]['coordinates'],
        );
        $this->assertSame([], $payload['links']);
    }

    public function test_snapshot_adds_a_content_hash_and_a_timestamp(): void
    {
        $snap = MapSnapshot::snapshot(MapSnapshot::shape([$this->node(1)], [], [], 5));

        $this->assertSame(16, strlen($snap['hash']));
        $this->assertNotFalse(strtotime($snap['generated_at']));
        $this->assertSame(5, $snap['version']);
        $this->assertSame([$this->node(1)], $snap['nodes']);
    }

    public function test_hash_ignores_the_version_and_timestamp_but_not_the_content(): void
    {
        $a = MapSnapshot::snapshot(MapSnapshot::shape([$this->node(1), $this->node(2)], [], [], 5));
        $sameContent = MapSnapshot::snapshot(MapSnapshot::shape([$this->node(1), $this->node(2)], [], [], 99));
        $renamed = MapSnapshot::snapshot(MapSnapshot::shape([$this->node(1), $this->node(2, 'Library')], [], [], 5));
        // Deleting an older node leaves the version (newest updated_at) unchanged, but the hash moves.
        $deleted = MapSnapshot::snapshot(MapSnapshot::shape([$this->node(2)], [], [], 5));

        $this->assertSame($a['hash'], $sameContent['hash']);
        $this->assertNotSame($a['hash'], $renamed['hash']);
        $this->assertNotSame($a['hash'], $deleted['hash']);
    }

    public function test_is_unchanged_needs_the_same_hash_and_version(): void
    {
        $a = MapSnapshot::snapshot(MapSnapshot::shape([$this->node(1)], [], [], 5));
        $newerVersion = MapSnapshot::snapshot(MapSnapshot::shape([$this->node(1)], [], [], 6));
        $other = MapSnapshot::snapshot(MapSnapshot::shape([$this->node(2)], [], [], 5));

        $this->assertTrue(MapSnapshot::isUnchanged($a, $a));
        $this->assertFalse(MapSnapshot::isUnchanged($a, $newerVersion));
        $this->assertFalse(MapSnapshot::isUnchanged($a, $other));
        $this->assertFalse(MapSnapshot::isUnchanged(null, $a));
    }
}
