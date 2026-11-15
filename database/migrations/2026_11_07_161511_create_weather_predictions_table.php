<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * One row per weather refresh (every 20 minutes): what the rain and heat
     * models predicted, next to the provider's own numbers, and later what the
     * airport actually reported. The admin Weather page and the ml/gui.py
     * History section read it to show whether the models work in real life.
     *
     * Outcomes come from the RPMZ airport reports: rain from the report nearest
     * to 20 minutes after the prediction (the training label), heat from the
     * report's temperature and dew point at each target hour. A row is "settled"
     * once every target time has passed; outcomes still null then had no report.
     */
    public function up(): void
    {
        Schema::create('weather_predictions', function (Blueprint $table) {
            $table->id();
            $table->timestamp('predicted_at')->index();
            // Rain: percentages 0-100. probability_source = model | forecast | weather_code.
            $table->unsignedTinyInteger('rain_probability')->nullable();
            $table->string('probability_source', 20)->nullable();
            $table->unsignedTinyInteger('provider_probability')->nullable();
            $table->decimal('alert_threshold', 4, 2)->nullable();
            $table->boolean('raining_now')->default(false);
            $table->boolean('rain_mode')->default(false);
            // Heat: index now, and per horizon the served value and the provider's forecast value.
            $table->decimal('heat_index_c', 5, 1)->nullable();
            $table->string('heat_source', 20)->nullable();
            // [{hours_ahead, at, heat_index_c, provider_heat_index_c}]
            $table->json('heat_forecast')->nullable();
            $table->text('airport_report')->nullable();
            // Outcomes, filled in by later refreshes.
            $table->boolean('rain_outcome')->nullable();
            // {"1": 28.4, "2": 29.1, "3": null} airport heat index at each target hour.
            $table->json('heat_outcomes')->nullable();
            $table->timestamp('outcomes_settled_at')->nullable()->index();
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('weather_predictions');
    }
};
