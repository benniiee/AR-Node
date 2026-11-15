<?php

return [

    /*
    |--------------------------------------------------------------------------
    | Campus forecast point
    |--------------------------------------------------------------------------
    |
    | One forecast coordinate covers the whole campus: Open-Meteo grid cells
    | (~2-25 km) are far larger than any campus, so every node would receive
    | the same value anyway. Defaults match the campus centre in
    | src/campusMap.js.
    |
    */

    'latitude' => (float) env('WEATHER_LAT', 6.913164),

    'longitude' => (float) env('WEATHER_LNG', 122.061753),

    'forecast_url' => env('WEATHER_URL', 'https://api.open-meteo.com/v1/forecast'),

    'user_agent' => env('WEATHER_USER_AGENT', 'AR-Node-Campus-Navigation/1.0 (weather-aware routing)'),

    /*
    |--------------------------------------------------------------------------
    | Rain-mode thresholds
    |--------------------------------------------------------------------------
    */

    // Hours ahead that count toward "rain soon".
    'lookahead_hours' => (int) env('WEATHER_LOOKAHEAD_HOURS', 2),

    // Hysteresis: rain mode turns ON at rain_on %, OFF at rain_off %. The gap
    // stops the state flapping on every poll when the probability hovers.
    'rain_on' => (int) env('WEATHER_RAIN_ON', 60),

    'rain_off' => (int) env('WEATHER_RAIN_OFF', 40),

    // Trained rain model (ml/model.json). Its probability is a 20-minute chance with its own
    // thresholds: empty model_rain_on = the alert threshold ml/train.py chose on validation data,
    // empty model_rain_off = 60% of model_rain_on. The penalty ramps between the two ramp values.
    'use_model' => (bool) env('WEATHER_USE_MODEL', true),

    // Another trained model file (empty = ml/model.json).
    'model_path' => env('WEATHER_MODEL_PATH'),

    // Optional "rain within the next hour" model (empty = ml/model_h60.json; missing file = not shown).
    // Displayed next to the 20-minute chance; routing follows the 20-minute model only.
    'hour_model_path' => env('WEATHER_HOUR_MODEL_PATH'),

    'model_rain_on' => env('WEATHER_MODEL_RAIN_ON') === null ? null : (int) env('WEATHER_MODEL_RAIN_ON'),

    'model_rain_off' => env('WEATHER_MODEL_RAIN_OFF') === null ? null : (int) env('WEATHER_MODEL_RAIN_OFF'),

    'model_ramp_from' => (int) env('WEATHER_MODEL_RAMP_FROM', 10),

    'model_ramp_to' => (int) env('WEATHER_MODEL_RAMP_TO', 50),

    // A refresh that cannot score the model (a request timed out) keeps the model's last
    // answer for this many minutes after it really scored, instead of the raw provider chance.
    'model_carry_minutes' => (int) env('WEATHER_MODEL_CARRY_MINUTES', 40),

    // Live airport reports for the rain model (NOAA Aviation Weather Center, free, no key).
    'metar_url' => env('WEATHER_METAR_URL', 'https://aviationweather.gov/api/data/metar'),

    // Himawari cloud tops for a rain model trained with them (ml/satellite.py, run with this
    // Python; standard library only). Missing Python, a slow download or no recent scan =
    // the model's fallback without satellite inputs is scored instead.
    'use_satellite' => (bool) env('WEATHER_USE_SATELLITE', true),

    'python' => env('WEATHER_PYTHON', 'python'),

    'satellite_timeout' => (int) env('WEATHER_SATELLITE_TIMEOUT', 45),

    // Airport whose reports fill in the prediction history's outcomes (RPMZ = Zamboanga International).
    'metar_station' => env('WEATHER_METAR_STATION', 'RPMZ'),

    // An airport report at most this old (minutes) decides "raining now": what was
    // observed beats the forecast model's guess (its "drizzle" code is often wrong).
    // Reports come every 30-60 minutes. Older or missing: the model decides.
    'airport_fresh_minutes' => (int) env('WEATHER_AIRPORT_FRESH_MINUTES', 75),

    // "It's raining here" taps from signed-in students: at least this many different people within
    // this many minutes = raining now on campus (beats the airport and the forecast). Reports only
    // turn rain ON: a wrong "raining" sends people under cover, a wrong "dry" would send them into rain.
    'reports_min_people' => (int) env('WEATHER_REPORTS_MIN_PEOPLE', 2),

    'reports_window_minutes' => (int) env('WEATHER_REPORTS_WINDOW_MINUTES', 15),

    // Current precipitation (mm) that forces rain mode regardless of forecast.
    'raining_now_mm' => (float) env('WEATHER_RAINING_NOW_MM', 0.1),

    // Cost multiplier applied to a fully exposed (outside -> outside) edge.
    'rain_penalty' => (float) env('WEATHER_RAIN_PENALTY', 2.0),

    /*
    |--------------------------------------------------------------------------
    | Heat index
    |--------------------------------------------------------------------------
    |
    | PAGASA heat index classification (deg C, lower bound of each level):
    | Caution 27-32, Extreme caution 33-41, Danger 42-51, Extreme danger 52+.
    | Source: PAGASA heat index advisories (pagasa.dost.gov.ph/weather/heat-index).
    | The same bounds are in ml/heat_common.py and src/heatIndex.js.
    |
    */

    'heat_categories' => [
        'caution' => 27,
        'extreme_caution' => 33,
        'danger' => 42,
        'extreme_danger' => 52,
    ],

    // Heat mode: above this heat index (deg C, now or in the next hour) exposed outdoor
    // paths are closed to routing, the same way they close while it is raining.
    'heat_mode_c' => (float) env('WEATHER_HEAT_MODE_C', 40),

    // Score ml/heat_model.json for the 1-3 h outlook (false = forecast heat index only).
    'use_heat_model' => (bool) env('WEATHER_USE_HEAT_MODEL', true),

    /*
    |--------------------------------------------------------------------------
    | Freshness and overrides
    |--------------------------------------------------------------------------
    */

    // Older than this = weather is ignored (routing unpenalised).
    'max_stale_minutes' => (int) env('WEATHER_MAX_STALE_MINUTES', 60),

    'cache_key' => 'weather:state',

];
