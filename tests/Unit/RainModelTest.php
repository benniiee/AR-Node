<?php

namespace Tests\Unit;

use App\Services\RainModel;
use DateTimeImmutable;
use DateTimeZone;
use PHPUnit\Framework\TestCase;

class RainModelTest extends TestCase
{
    private string $dir;

    protected function setUp(): void
    {
        parent::setUp();
        $this->dir = sys_get_temp_dir().'/rain-model-test-'.uniqid();
        mkdir($this->dir);
    }

    protected function tearDown(): void
    {
        array_map('unlink', glob($this->dir.'/*') ?: []);
        rmdir($this->dir);
        parent::tearDown();
    }

    /**
     * A model that reads the airport report and three forecast models (min 2 must answer).
     *
     * @param  list<string>  $features
     */
    private function model(array $features = ['obs_rain', 'mm_wet_share']): RainModel
    {
        $n = count($features);
        $path = $this->dir.'/model.json';
        file_put_contents($path, json_encode([
            'features' => $features, 'mean' => array_fill(0, $n, 0.0), 'scale' => array_fill(0, $n, 1.0),
            'coef' => array_fill(0, $n, 1.0), 'intercept' => 0.0, 'alert_threshold' => 0.21,
            'observation' => ['station' => 'RPMZ', 'lag_minutes' => 10, 'max_age_minutes' => 240, 'fresh_minutes' => 120, 'recent_minutes' => 120],
            'multi_model' => ['models' => ['a', 'b', 'c'], 'variables' => ['precipitation', 'cloud_cover', 'weather_code'], 'min_models' => 2, 'wet_mm' => 0.1],
        ]));

        return RainModel::loadForTesting($path);
    }

    private function at(string $time): DateTimeImmutable
    {
        return new DateTimeImmutable($time, new DateTimeZone('Asia/Manila'));
    }

    public function test_it_knows_which_extra_inputs_it_needs(): void
    {
        $both = $this->model();
        $forecastOnly = $this->model(['precip_0']);

        $this->assertTrue($both->needsObservations());
        $this->assertTrue($both->needsMultiModel());
        $this->assertFalse($forecastOnly->needsObservations());
        $this->assertFalse($forecastOnly->needsMultiModel());
        $this->assertSame(0.21, $both->alertThreshold());
        $this->assertSame(['ids' => 'RPMZ', 'format' => 'json', 'hours' => 6], $both->observationQueryParams());
        $this->assertSame('a,b,c', $both->multiModelQueryParams(6.9, 122.0)['models']);
    }

    public function test_a_report_too_new_to_have_arrived_is_ignored(): void
    {
        $features = $this->model()->observationFeatures($this->at('2026-11-07T23:15'), [
            ['time' => '2026-11-07T22:00', 'raw' => 'RPMZ 071400Z 10005KT 9999 FEW015 26/24 Q1013'],
            // Within the 10-minute lag: the app could not have received it yet.
            ['time' => '2026-11-07T23:10', 'raw' => 'RPMZ 071510Z 10005KT 5000 +TSRA FEW015CB 26/24 Q1013'],
        ]);

        $this->assertSame(0.0, $features['obs_rain']);
        $this->assertSame(75.0, $features['obs_age_min']);
    }

    public function test_rain_in_the_latest_report_fades_with_its_age(): void
    {
        $features = $this->model()->observationFeatures($this->at('2026-11-07T23:30'), [
            ['time' => '2026-11-07T23:00', 'raw' => 'RPMZ 071500Z 10005KT 9000 -TSRA FEW015CB 26/24 Q1013'],
        ]);

        $this->assertSame(1.0, $features['obs_rain']);
        $this->assertSame(0.75, $features['obs_rain_fresh']);
        $this->assertSame(1.0, $features['obs_rain_2h']);
        $this->assertSame(1.0, $features['obs_thunder']);
        $this->assertSame(1.0, $features['obs_convective_cloud']);
    }

    public function test_no_recent_report_reads_as_stale_not_missing(): void
    {
        $model = $this->model();
        $old = [['time' => '2026-11-07T18:00', 'raw' => 'RPMZ 071000Z 10005KT 9000 -RA 26/24 Q1013']];

        foreach ([$old, []] as $reports) {
            $features = $model->observationFeatures($this->at('2026-11-07T23:15'), $reports);
            $this->assertSame(0.0, $features['obs_rain']);
            $this->assertSame(240.0, $features['obs_age_min']);
        }
    }

    public function test_several_models_need_enough_answers(): void
    {
        $model = $this->model();
        $base = $this->at('2026-11-07T23:00');
        $hourly = [
            'time' => ['2026-11-07T23:00', '2026-11-08T00:00'],
            'precipitation_a' => [0.0, 0.4], 'precipitation_b' => [0.0, 0.0], 'precipitation_c' => [0.0, null],
            'cloud_cover_a' => [80, 90], 'cloud_cover_b' => [40, 50], 'cloud_cover_c' => [null, null],
            'weather_code_a' => [3, 95], 'weather_code_b' => [3, 3], 'weather_code_c' => [3, 3],
        ];

        $features = $model->multiModelFeatures($base, ['hourly' => $hourly]);

        $this->assertSame(0.5, $features['mm_wet_share']);
        $this->assertSame(0.2, $features['mm_precip_mean']);
        $this->assertSame(60.0, $features['mm_cloud_mean']);
        $this->assertEqualsWithDelta(1 / 3, $features['mm_thunder_share'], 1e-9);

        $hourly['precipitation_b'] = [0.0, null];
        $this->assertNull($model->multiModelFeatures($base, ['hourly' => $hourly])['mm_wet_share']);
        $this->assertNull($model->multiModelFeatures($base, null)['mm_cloud_mean']);
    }
}
