<?php

namespace Tests;

use Illuminate\Foundation\Testing\TestCase as BaseTestCase;
use Illuminate\Support\Facades\Process;

abstract class TestCase extends BaseTestCase
{
    protected function setUp(): void
    {
        parent::setUp();

        // A rain model trained with satellite inputs runs `python ml/satellite.py now` on every
        // weather refresh: tests never download live scans. "No scan" = the model's fallback;
        // a test that needs satellite values fakes its own answer.
        Process::fake(['*satellite.py*' => Process::result(output: json_encode(['ok' => false, 'error' => 'no satellite in tests']))]);

        // No 60-minute model unless a test sets one: the real ml/model_h60.json must not change other tests.
        config(['weather.hour_model_path' => base_path('tests/no-hour-model.json')]);
    }
}
