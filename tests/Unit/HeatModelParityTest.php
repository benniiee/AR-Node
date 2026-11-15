<?php

namespace Tests\Unit;

use App\Services\HeatModel;
use DateTimeImmutable;
use DateTimeZone;
use PHPUnit\Framework\TestCase;

/**
 * PHP computes the same features and heat index outlook as ml/heat_common.py, using the
 * cases ml/train_heat.py wrote to ml/heat_model_parity.json.
 */
class HeatModelParityTest extends TestCase
{
    public function test_php_features_and_predictions_match_python(): void
    {
        // HEAT_MODEL_DIR=<folder with heat_model.json + heat_model_parity.json> checks another training run.
        $dir = getenv('HEAT_MODEL_DIR') ?: dirname(__DIR__, 2).'/ml';
        $modelPath = $dir.'/heat_model.json';
        $parityPath = $dir.'/heat_model_parity.json';
        if (! is_file($modelPath) || ! is_file($parityPath)) {
            $this->markTestSkipped('Run ml/train_heat.py first.');
        }

        $model = HeatModel::loadForTesting($modelPath);
        $this->assertTrue($model->hasModel());
        $parity = json_decode((string) file_get_contents($parityPath), true, 512, JSON_THROW_ON_ERROR);
        $this->assertNotEmpty($parity['cases']);

        foreach ($parity['cases'] as $case) {
            $now = new DateTimeImmutable($case['now'], new DateTimeZone('Asia/Manila'));
            $features = $model->featuresFromPayload(['hourly' => $case['hourly']], $now);

            $this->assertNotNull($features, 'features missing for '.$case['now']);
            foreach ($case['expected_features'] as $name => $expected) {
                $this->assertEqualsWithDelta($expected, $features[$name], 1e-6, "feature {$name} at {$case['now']}");
            }
            foreach ($case['expected_heat_index'] as $hoursAhead => $expected) {
                $this->assertEqualsWithDelta($expected, $model->score($features, (int) $hoursAhead), 1e-6, "+{$hoursAhead} h at {$case['now']}");
            }
        }
    }
}
