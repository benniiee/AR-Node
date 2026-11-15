<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Staircases are not always one straight ramp. A link now also says which
     * way the stairs head and how they bend:
     *
     *  - yaw_deg    compass bearing (0 = north, 90 = east) of the FIRST flight,
     *               walking UP from the lower-floor node. null = not set yet
     *               (older links): clients fall back to the bearing between
     *               the two nodes.
     *  - flights    [{ angle_deg, turn_deg }, ...], 1 to 4 flights. turn_deg is
     *               the turn at the landing BEFORE that flight (right/clockwise
     *               is positive; the first flight is always 0). 90 = L-shaped,
     *               180 = U-shaped switchback. null = one straight flight at
     *               angle_deg, exactly like before.
     *  - landing_m  depth of each flat landing between flights.
     *
     * angle_deg stays as the average slope so older clients keep working.
     */
    public function up(): void
    {
        Schema::table('node_links', function (Blueprint $table) {
            $table->decimal('yaw_deg', 5, 2)->nullable()->after('angle_deg');
            $table->json('flights')->nullable()->after('yaw_deg');
            $table->decimal('landing_m', 4, 2)->default(1.4)->after('flights');
        });
    }

    public function down(): void
    {
        Schema::table('node_links', function (Blueprint $table) {
            $table->dropColumn(['yaw_deg', 'flights', 'landing_m']);
        });
    }
};
