<?php

return [

    /*
    |--------------------------------------------------------------------------
    | Campus hours (the student and visitor map)
    |--------------------------------------------------------------------------
    |
    | Outside these hours (campus time, Asia/Manila) the campus is closed and
    | /map shows a "campus is closed" notice instead of the map, for students and
    | visitors alike; the admin console is not affected. "HH:MM", 24-hour. They
    | travel in the map feed, so phones apply them offline too.
    |
    */

    'opens_at' => env('CAMPUS_OPENS_AT', '06:00'),

    'closes_at' => env('CAMPUS_CLOSES_AT', '21:00'),

];
