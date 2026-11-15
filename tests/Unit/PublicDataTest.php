<?php

namespace Tests\Unit;

use App\Services\PublicData;
use PHPUnit\Framework\TestCase;

class PublicDataTest extends TestCase
{
    private string $dir;

    protected function setUp(): void
    {
        $this->dir = sys_get_temp_dir().DIRECTORY_SEPARATOR.'public_data_'.bin2hex(random_bytes(4));
    }

    protected function tearDown(): void
    {
        foreach (glob($this->dir.DIRECTORY_SEPARATOR.'*') ?: [] as $file) {
            @unlink($file);
        }
        @rmdir($this->dir);
    }

    public function test_it_writes_valid_json_and_leaves_no_temp_files(): void
    {
        $this->assertTrue(PublicData::write('a.json', ['name' => 'Café', 'n' => 3], $this->dir));

        $this->assertSame(['name' => 'Café', 'n' => 3], PublicData::read('a.json', $this->dir));
        $this->assertStringContainsString('Café', (string) file_get_contents($this->dir.'/a.json'));   // not \u00e9 escaped
        $this->assertSame([], glob($this->dir.'/*.tmp'));
    }

    public function test_it_replaces_an_existing_file(): void
    {
        PublicData::write('a.json', ['v' => 1], $this->dir);
        PublicData::write('a.json', ['v' => 2], $this->dir);

        $this->assertSame(['v' => 2], PublicData::read('a.json', $this->dir));
        $this->assertSame([], glob($this->dir.'/*.tmp'));
    }

    public function test_it_creates_missing_folders(): void
    {
        $nested = $this->dir.DIRECTORY_SEPARATOR.'deep';

        $this->assertTrue(PublicData::write('a.json', ['v' => 1], $nested));
        $this->assertSame(['v' => 1], PublicData::read('a.json', $nested));

        @unlink($nested.'/a.json');
        @rmdir($nested);
    }

    public function test_read_returns_null_for_missing_or_unusable_files(): void
    {
        mkdir($this->dir);
        file_put_contents($this->dir.'/bad.json', 'not json');
        file_put_contents($this->dir.'/scalar.json', '5');

        $this->assertNull(PublicData::read('missing.json', $this->dir));
        $this->assertNull(PublicData::read('bad.json', $this->dir));
        $this->assertNull(PublicData::read('scalar.json', $this->dir));
    }

    public function test_a_failed_write_returns_false_instead_of_throwing(): void
    {
        mkdir($this->dir);
        file_put_contents($this->dir.'/blocker', 'x');   // a file where a folder would have to go

        $this->assertFalse(PublicData::write('a.json', ['v' => 1], $this->dir.'/blocker/sub'));
        $this->assertFalse(PublicData::write('a.json', ['bad' => NAN], $this->dir));   // not encodable
    }
}
