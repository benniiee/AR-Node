<?php

namespace Tests\Unit;

use App\Services\WeatherService;
use PHPUnit\Framework\TestCase;

class GradedRainMultiplierTest extends TestCase
{
    public function test_ramp_goes_from_dry_to_the_full_penalty(): void
    {
        // from 10% to 50%, maximum penalty 2.0
        $this->assertSame(1.0, WeatherService::gradedMultiplier(0, 2.0, 10, 50));
        $this->assertSame(1.0, WeatherService::gradedMultiplier(10, 2.0, 10, 50));
        $this->assertSame(1.25, WeatherService::gradedMultiplier(20, 2.0, 10, 50));
        $this->assertSame(1.5, WeatherService::gradedMultiplier(30, 2.0, 10, 50));
        $this->assertSame(2.0, WeatherService::gradedMultiplier(50, 2.0, 10, 50));
        $this->assertSame(2.0, WeatherService::gradedMultiplier(95, 2.0, 10, 50));
    }

    public function test_it_scales_with_the_configured_penalty(): void
    {
        $this->assertSame(2.0, WeatherService::gradedMultiplier(30, 3.0, 10, 50));
    }

    public function test_it_never_penalises_when_misconfigured(): void
    {
        $this->assertSame(1.0, WeatherService::gradedMultiplier(80, 1.0, 10, 50));  // no penalty configured
        $this->assertSame(1.0, WeatherService::gradedMultiplier(80, 0.5, 10, 50));  // nonsense penalty
        $this->assertSame(1.0, WeatherService::gradedMultiplier(80, 2.0, 50, 50));  // empty ramp
        $this->assertSame(1.0, WeatherService::gradedMultiplier(80, 2.0, 60, 40));  // reversed ramp
    }
}
