<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * "It's raining here" taps from signed-in students (WeatherService::applyRainReports).
     */
    public function up(): void
    {
        Schema::create('rain_reports', function (Blueprint $table) {
            $table->id();
            $table->foreignId('user_id')->constrained()->cascadeOnDelete();
            $table->timestamps();

            // The live check counts distinct people in the last few minutes; PostgreSQL does not index
            // foreign keys by itself, and deleting a user looks its reports up by user_id.
            $table->index(['created_at', 'user_id']);
            $table->index('user_id');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('rain_reports');
    }
};
