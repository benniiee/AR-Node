<?php

namespace App\Services;

use Throwable;

/**
 * Static JSON files in storage/app/public/data/ (served at /storage/data/<name>
 * once `php artisan storage:link` has been run).
 *
 * Why static files: a phone fetching map.json or weather.json costs the web
 * server one file read, with no PHP boot and no database query, and the files
 * keep the same URL, so a service worker can cache them later. Laravel only
 * rewrites a file when its content really changes (map) or on the 20-minute
 * weather refresh.
 *
 * Writes are atomic (temp file, then rename), so a phone can never download
 * half a file. Nothing here throws: a failed write returns false and the
 * /api endpoints keep working as before.
 */
class PublicData
{
    public static function directory(): string
    {
        return storage_path('app/public/data');
    }

    public static function path(string $name, ?string $dir = null): string
    {
        return rtrim($dir ?? self::directory(), '/\\').DIRECTORY_SEPARATOR.$name;
    }

    /**
     * @param  array<string, mixed>  $data
     * @param  string|null  $dir  explicit directory (tests); null = the real public data folder
     */
    public static function write(string $name, array $data, ?string $dir = null): bool
    {
        // `php artisan test` must never overwrite the real files with fake test data.
        if ($dir === null && self::disabled()) {
            return false;
        }

        try {
            $folder = $dir ?? self::directory();

            if (! is_dir($folder) && ! @mkdir($folder, 0775, true) && ! is_dir($folder)) {
                return false;
            }

            $json = json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);
            $target = self::path($name, $dir);
            $tmp = $target.'.'.bin2hex(random_bytes(4)).'.tmp';

            if (file_put_contents($tmp, $json) === false) {
                return false;
            }

            // rename() replaces the target atomically; some Windows setups refuse when the old
            // file is open, so fall back to copy.
            if (! @rename($tmp, $target)) {
                $copied = @copy($tmp, $target);
                @unlink($tmp);

                return $copied;
            }

            return true;
        } catch (Throwable) {
            return false;
        }
    }

    /**
     * @return array<string, mixed>|null null when missing or not valid JSON
     */
    public static function read(string $name, ?string $dir = null): ?array
    {
        $path = self::path($name, $dir);

        if (! is_file($path)) {
            return null;
        }

        try {
            $data = json_decode((string) file_get_contents($path), true, 512, JSON_THROW_ON_ERROR);
        } catch (Throwable) {
            return null;
        }

        return is_array($data) ? $data : null;
    }

    private static function disabled(): bool
    {
        if (function_exists('app') && app()->runningUnitTests()) {
            return true;
        }

        return function_exists('config') && config('weather.publish_snapshots', true) === false;
    }
}
