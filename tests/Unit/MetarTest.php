<?php

namespace Tests\Unit;

use App\Services\Metar;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

class MetarTest extends TestCase
{
    /**
     * The same reports ml/common.py::metar_flags() is checked against.
     *
     * @return array<string, array{string, list<string>}>
     */
    public static function reports(): array
    {
        return [
            'storm clouds and lightning, no rain' => [
                'METAR RPMZ 071500Z 10005KT 9999 FEW015CB BKN016 26/24 Q1013 RMK A2991 CB/OCNL LTG NE,SE',
                ['convective_cloud', 'lightning'],
            ],
            'light thunderstorm with rain' => [
                'RPMZ 071300Z 08006KT 9000 -TSRA FEW016CB BKN090 27/25 Q1012 RMK A2988 CB NE-SE',
                ['rain', 'thunder', 'convective_cloud'],
            ],
            'showers now and recent showers' => [
                'RPMZ 161000Z 24003KT 210V270 9999 -SHRA FEW017 OVC090 RESHRA 28/23 Q1011 RMK A2985',
                ['rain', 'recent_rain'],
            ],
            'showers in the vicinity and towering cumulus' => [
                'RPMZ 120000Z 00000KT 9999 VCSH SCT020TCU 27/24 Q1010 NOSIG',
                ['vicinity', 'convective_cloud'],
            ],
            'thunderstorm in the vicinity' => [
                'RPMZ 120000Z 00000KT 9999 VCTS FEW018CB 27/24 Q1010',
                ['thunder', 'vicinity', 'convective_cloud'],
            ],
            'a forecast trend is not the weather now' => [
                'RPMZ 120000Z 00000KT CAVOK 27/24 Q1010 TEMPO TSRA',
                [],
            ],
            'quiet report' => [
                'RPMZ 010000Z 07006KT 040V100 9999 FEW017 BKN090 27/23 Q1011 RMK A2985',
                [],
            ],
        ];
    }

    /**
     * @param  list<string>  $expectedOn
     */
    #[DataProvider('reports')]
    public function test_flags_follow_the_report(string $raw, array $expectedOn): void
    {
        $flags = Metar::flags($raw);

        foreach (Metar::FLAGS as $flag) {
            $this->assertSame(in_array($flag, $expectedOn, true) ? 1.0 : 0.0, $flags[$flag], $flag);
        }
    }

    public function test_empty_report_has_every_flag_off(): void
    {
        $this->assertSame(array_fill_keys(Metar::FLAGS, 0.0), Metar::flags(null));
    }

    public function test_aviation_weather_reports_get_campus_time(): void
    {
        $reports = Metar::fromAviationWeather([
            ['obsTime' => 1794063600, 'rawOb' => 'METAR RPMZ 071500Z 10005KT 9999 FEW015CB 26/24 Q1013'],
            ['obsTime' => 'bad', 'rawOb' => 'ignored'],
            'not a report',
        ]);

        // 15:00 UTC is 23:00 in Manila.
        $this->assertSame([['time' => '2026-11-07T23:00', 'raw' => 'METAR RPMZ 071500Z 10005KT 9999 FEW015CB 26/24 Q1013']], $reports);
        $this->assertSame([], Metar::fromAviationWeather('<html>error</html>'));
    }
}
