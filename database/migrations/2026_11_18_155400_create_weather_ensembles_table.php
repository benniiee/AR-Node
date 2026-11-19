<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * One row per weather refresh: a summary of the Open-Meteo Ensemble API forecasts
     * (ECMWF IFS and AIFS, GFS, ICON members) for the campus point, recorded live
     * because that API keeps only about 3 days of the past. Months of rows become the
     * training history for an "ensemble" rain-model input (weather:ensemble-export).
     * Never pruned, unlike weather_predictions.
     */
    public function up(): void
    {
        Schema::create('weather_ensembles', function (Blueprint $table) {
            $table->id();
            $table->timestamp('fetched_at')->index();
            // {"ecmwf_ifs025": {"members": 51, "hours": [{"at", "wet_share", "heavy_share", "mean_mm", "max_mm"}]}}
            $table->json('models');
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('weather_ensembles');
    }
};
