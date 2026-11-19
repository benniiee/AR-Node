<?php

namespace App\Services;

use DateTimeImmutable;
use DateTimeZone;
use Throwable;

/**
 * Reads airport weather reports (METAR/SPECI) for the rain model.
 *
 * flags() MUST match ml/common.py::metar_flags(): RainModelParityTest feeds both the
 * same raw reports, and MetarTest pins the rules. Pure: no Laravel needed.
 */
class Metar
{
    /** @var list<string> */
    public const FLAGS = ['rain', 'thunder', 'vicinity', 'convective_cloud', 'lightning', 'recent_rain'];

    /** Two-letter weather codes (descriptors and phenomena, plus the VC/RE prefixes). */
    private const WEATHER_CODES = [
        'VC', 'RE', 'MI', 'PR', 'BC', 'DR', 'BL', 'SH', 'TS', 'FZ', 'DZ', 'RA', 'SN', 'SG', 'IC', 'PL',
        'GR', 'GS', 'UP', 'BR', 'FG', 'FU', 'VA', 'DU', 'SA', 'HZ', 'PY', 'PO', 'SQ', 'FC', 'SS', 'DS',
    ];

    private const RAIN_CODES = ['RA', 'DZ', 'SH', 'TS', 'UP'];

    /** Remarks and forecast trends start here: what follows is not the weather now. */
    private const BODY_END = ['RMK', 'NOSIG', 'TEMPO', 'BECMG'];

    /**
     * 0/1 weather flags from one raw report.
     *
     * rain: rain, drizzle, showers or thunderstorm at the station; thunder: TS at the station or
     * in the vicinity; vicinity: VCSH or VCTS; convective_cloud: a CB or TCU cloud group;
     * lightning: LTG in the remarks; recent_rain: RERA, RESHRA, RETSRA, ...
     *
     * @return array<string, float>
     */
    public static function flags(?string $raw): array
    {
        $out = array_fill_keys(self::FLAGS, 0.0);
        $tokens = preg_split('/\s+/', trim((string) $raw), -1, PREG_SPLIT_NO_EMPTY) ?: [];

        $stop = count($tokens);
        foreach ($tokens as $i => $token) {
            if (in_array($token, self::BODY_END, true)) {
                $stop = $i;
                break;
            }
        }
        $remarksAt = array_search('RMK', $tokens, true);
        $remarks = $remarksAt === false ? [] : array_slice($tokens, $remarksAt + 1);

        foreach (array_slice($tokens, 0, $stop) as $token) {
            if (preg_match('/^(FEW|SCT|BKN|OVC)\d{3}(CB|TCU)$/', $token)) {
                $out['convective_cloud'] = 1.0;

                continue;
            }

            $chunks = self::weatherChunks($token);
            if ($chunks === null) {
                continue;
            }

            $prefix = in_array($chunks[0], ['VC', 'RE'], true) ? $chunks[0] : '';
            $codes = $prefix === '' ? $chunks : array_slice($chunks, 1);
            $isRain = array_intersect($codes, self::RAIN_CODES) !== [];
            $isThunder = in_array('TS', $codes, true);

            if ($prefix === 'RE') {
                if ($isRain) {
                    $out['recent_rain'] = 1.0;
                }
            } elseif ($prefix === 'VC') {
                if ($isThunder || in_array('SH', $codes, true)) {
                    $out['vicinity'] = 1.0;
                }
                if ($isThunder) {
                    $out['thunder'] = 1.0;
                }
            } else {
                if ($isRain) {
                    $out['rain'] = 1.0;
                }
                if ($isThunder) {
                    $out['thunder'] = 1.0;
                }
            }
        }

        foreach ($remarks as $token) {
            if (str_contains($token, 'LTG')) {
                $out['lightning'] = 1.0;
                break;
            }
        }

        return $out;
    }

    /**
     * Air temperature and dew point (deg C) from the report's "26/24" group ("M" = minus), or null.
     *
     * @return array{0: float, 1: float}|null
     */
    public static function temperatureDewPoint(?string $raw): ?array
    {
        foreach (preg_split('/\s+/', trim((string) $raw), -1, PREG_SPLIT_NO_EMPTY) ?: [] as $token) {
            if ($token === 'RMK') {
                break;
            }
            if (preg_match('/^(M?\d{2})\/(M?\d{2})$/', $token, $m)) {
                $value = fn (string $v): float => (float) str_replace('M', '-', $v);

                return [$value($m[1]), $value($m[2])];
            }
        }

        return null;
    }

    /**
     * Heat index (deg C) the airport observed: relative humidity from temperature and dew point
     * (Magnus formula, Alduchov and Eskridge constants), then the NWS heat index.
     * METAR rounds both to whole degrees, so the value is good to about half a degree.
     */
    public static function heatIndex(?string $raw): ?float
    {
        $pair = self::temperatureDewPoint($raw);
        $humidity = self::relativeHumidity($raw);

        return ($pair === null || $humidity === null) ? null : round(HeatIndex::celsius($pair[0], $humidity), 1);
    }

    /** Relative humidity (%) from the report's temperature and dew point (Magnus formula, Alduchov and Eskridge constants), or null. */
    public static function relativeHumidity(?string $raw): ?float
    {
        $pair = self::temperatureDewPoint($raw);
        if ($pair === null) {
            return null;
        }

        [$temperature, $dewPoint] = $pair;
        $saturation = fn (float $t): float => exp(17.625 * $t / (243.04 + $t));

        return min(100.0, 100.0 * $saturation($dewPoint) / $saturation($temperature));
    }

    /**
     * Reports from the aviationweather.gov data API (format=json) as campus-time entries.
     *
     * @return list<array{time: string, raw: string}> time = 'Y-m-d\TH:i' in Asia/Manila
     */
    public static function fromAviationWeather(mixed $json): array
    {
        if (! is_array($json)) {
            return [];
        }

        $tz = new DateTimeZone('Asia/Manila');
        $reports = [];
        foreach ($json as $report) {
            if (! is_array($report) || ! is_numeric($report['obsTime'] ?? null) || ! is_string($report['rawOb'] ?? null)) {
                continue;
            }

            try {
                $time = (new DateTimeImmutable('@'.(int) $report['obsTime']))->setTimezone($tz);
            } catch (Throwable) {
                continue;
            }

            $reports[] = ['time' => $time->format('Y-m-d\TH:i'), 'raw' => $report['rawOb']];
        }

        return $reports;
    }

    /**
     * Split a present-weather group such as '-TSRA' or 'VCSH' into 2-letter codes.
     *
     * @return list<string>|null null when the token is not a weather group
     */
    private static function weatherChunks(string $token): ?array
    {
        $body = ltrim($token, '+-');
        if ($body === '' || strlen($body) % 2 !== 0 || ! ctype_upper($body)) {
            return null;
        }

        $chunks = str_split($body, 2);
        foreach ($chunks as $chunk) {
            if (! in_array($chunk, self::WEATHER_CODES, true)) {
                return null;
            }
        }

        return $chunks;
    }
}
