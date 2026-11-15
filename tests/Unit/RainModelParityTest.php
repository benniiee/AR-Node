<?php

// Proves PHP computes the same features and probability as ml/common.py, using
// the cases ml/train.py wrote to ml/model_parity.json (20-minute model) and
// ml/model_h60_parity.json (60-minute model). Run:
//   php artisan test --compact --filter=RainModelParityTest
// RAIN_MODEL_DIR=<folder with model.json + model_parity.json> checks another training run.

namespace Tests\Unit;

use App\Services\RainModel;
use DateTimeImmutable;
use DateTimeZone;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

class RainModelParityTest extends TestCase
{
    /** @return array<string, array{string}> */
    public static function models(): array
    {
        return ['20-minute model' => ['model'], '60-minute model' => ['model_h60']];
    }

    #[DataProvider('models')]
    public function test_php_features_and_probability_match_python(string $name): void
    {
        $dir = getenv('RAIN_MODEL_DIR') ?: dirname(__DIR__, 2).'/ml';
        $modelPath = "{$dir}/{$name}.json";
        $parityPath = "{$dir}/{$name}_parity.json";
        if (! is_file($modelPath) || ! is_file($parityPath)) {
            $this->markTestSkipped("No {$name}.json yet: train it in ml/gui.py first.");
        }

        $model = RainModel::loadForTesting($modelPath);
        $this->assertNotNull($model);
        $parity = json_decode((string) file_get_contents($parityPath), true, 512, JSON_THROW_ON_ERROR);
        $this->assertNotEmpty($parity['cases']);

        foreach ($parity['cases'] as $case) {
            $now = new DateTimeImmutable($case['now'], new DateTimeZone('Asia/Manila'));
            $payload = ['minutely_15' => $case['minutely_15'], 'hourly' => $case['hourly']];
            $multiModel = isset($case['multi_model']) ? ['hourly' => $case['multi_model']] : null;
            $features = $model->featuresFromPayload($payload, $now, $multiModel, $case['metars'] ?? null, $case['satellite_features'] ?? null);

            $this->assertNotNull($features, 'features missing for '.$case['now']);
            foreach ($case['expected_features'] as $name => $expected) {
                $this->assertEqualsWithDelta($expected, $features[$name], 1e-6, "feature {$name} at {$case['now']}");
            }
            $this->assertEqualsWithDelta($case['expected_probability'], $model->score($features), 1e-6, 'probability at '.$case['now']);

            if (isset($case['expected_fallback_probability'])) {
                // No satellite scan: the model alone cannot score, its fallback must give Python's answer.
                $this->assertNull($model->probability($payload, $now, $multiModel, $case['metars'] ?? null));
                $fallback = $model->fallback();
                $this->assertNotNull($fallback);
                $this->assertFalse($fallback->needsSatellite());
                $this->assertEqualsWithDelta(
                    $case['expected_fallback_probability'],
                    $fallback->probability($payload, $now, $multiModel, $case['metars'] ?? null),
                    1e-6,
                    'fallback probability at '.$case['now'],
                );
            }
        }
    }
}
