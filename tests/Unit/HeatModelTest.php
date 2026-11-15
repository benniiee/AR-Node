<?php

namespace Tests\Unit;

use App\Services\HeatIndex;
use App\Services\HeatModel;
use DateTimeImmutable;
use DateTimeZone;
use PHPUnit\Framework\TestCase;

class HeatModelTest extends TestCase
{
    private string $dir;

    protected function setUp(): void
    {
        parent::setUp();
        $this->dir = sys_get_temp_dir().'/heat-model-test-'.uniqid();
        mkdir($this->dir);
    }

    protected function tearDown(): void
    {
        array_map('unlink', glob($this->dir.'/*') ?: []);
        rmdir($this->dir);
        parent::tearDown();
    }

    /**
     * A tiny model: +h hours = heat index now + h (one feature, unscaled).
     *
     * @param  array<string, mixed>  $overrides
     */
    private function writeModel(array $overrides = []): string
    {
        $perHorizon = [];
        foreach ([1, 2, 3] as $h) {
            $perHorizon[(string) $h] = ['mean' => [0.0], 'scale' => [1.0], 'coef' => [1.0], 'intercept' => (float) $h];
        }
        $path = $this->dir.'/heat_model.json';
        file_put_contents($path, json_encode(array_merge([
            'recommended' => true,
            'features' => ['heat_index'],
            'per_horizon' => $perHorizon,
        ], $overrides)));

        return $path;
    }

    private function now(): DateTimeImmutable
    {
        return new DateTimeImmutable('2026-04-10T13:40', new DateTimeZone('Asia/Manila'));
    }

    /**
     * Hourly payload from 10:00 to 17:00 with 32 C / 60 % now and 33 C / 60 % later.
     *
     * @return array<string, mixed>
     */
    private function payload(): array
    {
        $time = [];
        $temperature = [];
        for ($hour = 10; $hour <= 17; $hour++) {
            $time[] = sprintf('2026-04-10T%02d:00', $hour);
            $temperature[] = $hour <= 13 ? 32.0 : 33.0;
        }

        return ['hourly' => [
            'time' => $time,
            'temperature_2m' => $temperature,
            'relative_humidity_2m' => array_fill(0, count($time), 60.0),
        ]];
    }

    public function test_scores_each_horizon_from_the_current_hour(): void
    {
        $outlook = HeatModel::load($this->writeModel())->forecast($this->payload(), $this->now());
        $now = HeatIndex::celsius(32.0, 60.0);

        $this->assertSame('model', $outlook['source']);
        $this->assertSame([1, 2, 3], array_column($outlook['items'], 'hours_ahead'));
        $this->assertSame('2026-04-10T14:00:00+08:00', $outlook['items'][0]['at']);
        $this->assertSame(round($now + 1, 1), $outlook['items'][0]['heat_index_c']);
        $this->assertSame(round($now + 3, 1), $outlook['items'][2]['heat_index_c']);
        $this->assertSame(HeatIndex::category(round($now + 3, 1)), $outlook['items'][2]['category']);
    }

    public function test_missing_model_file_falls_back_to_the_forecast_heat_index(): void
    {
        $outlook = HeatModel::load($this->dir.'/missing.json')->forecast($this->payload(), $this->now());

        $this->assertSame('forecast', $outlook['source']);
        $this->assertSame(round(HeatIndex::celsius(33.0, 60.0), 1), $outlook['items'][0]['heat_index_c']);
        $this->assertCount(3, $outlook['items']);
    }

    public function test_not_recommended_model_is_not_used(): void
    {
        $model = HeatModel::load($this->writeModel(['recommended' => false]));

        $this->assertFalse($model->hasModel());
        $this->assertSame('forecast', $model->forecast($this->payload(), $this->now())['source']);
    }

    public function test_invalid_model_is_not_used(): void
    {
        $this->assertFalse(HeatModel::load($this->writeModel(['features' => ['heat_index', 'temp']]))->hasModel());

        file_put_contents($this->dir.'/broken.json', '{not json');
        $this->assertFalse(HeatModel::load($this->dir.'/broken.json')->hasModel());
    }

    public function test_missing_input_falls_back_per_horizon(): void
    {
        $payload = $this->payload();
        $payload['hourly']['relative_humidity_2m'][3] = null; // 13:00, the model's "now"

        $outlook = HeatModel::load($this->writeModel())->forecast($payload, $this->now());

        $this->assertSame('forecast', $outlook['source']);
        $this->assertSame(round(HeatIndex::celsius(33.0, 60.0), 1), $outlook['items'][1]['heat_index_c']);
    }

    public function test_empty_payload_gives_an_empty_outlook_without_throwing(): void
    {
        $outlook = HeatModel::load($this->writeModel())->forecast(['hourly' => 'garbage'], $this->now());

        $this->assertSame(['source' => null, 'items' => []], $outlook);
    }

    public function test_query_is_a_separate_hourly_request_with_history(): void
    {
        $query = HeatModel::queryParams(6.9, 122.0);

        $this->assertGreaterThanOrEqual(3, $query['past_hours']);
        $this->assertGreaterThanOrEqual(4, $query['forecast_hours']);
        $this->assertStringContainsString('relative_humidity_2m', $query['hourly']);
        $this->assertSame('Asia/Manila', $query['timezone']);
    }
}
