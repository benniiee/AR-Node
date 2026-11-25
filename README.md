# ARNode: campus wayfinding with weather-aware routes

ARNode helps students and visitors find buildings, offices and rooms on college campuses. It runs in the phone's browser and can be installed like an app. It gives walking directions on a 2D map, in 3D or in AR (through the camera), works offline after one online visit, and steers people toward covered paths when rain is likely and toward shade when it is hot. Staff keep the map up to date in an admin console.

*AR-Node: Weather AI Prediction, Offline AR Wayfinding and Routes for Campuses (Pre-Mapped Nodes).*

**Last checked against the code:** 2026-11-15.

---

## Who can do what

**Admins** (admin console at `/admin`)
- Manage buildings: label them from the base map or draw them; edit name, short name, floors, height and status (**Completed**, or **Under construction**: drawn faded and labelled, routes go around it and it is not a destination); move, reshape or remove them. Removing a building also deletes every node filed under it (rooms, offices, indoor routes on all floors) and their staircases.
- Assign a building to a department, or hand it over to another department. Its rooms and routes stay where they are, and the new department manages them.
- Manage bridges (such as the footbridge between the two campuses): draw the deck's outline like a building, set its name, deck level (at ground level, or 1 to 5 floors up), height and roof, then lay route nodes along the deck in one step. A raised deck's route nodes are on its floor (at the deck's height), so routes reach it only by stairs. **Connect to ground** (the bridge's popup or Edit panel) joins it to the existing ground routes like a building's stairs: tap a deck node at one end, then the ground route node the stairs come down to, then set the stairs' shape and slope; once per end. (Where no ground route exists yet, "Also build new stairs down to new ground nodes" makes a 35° staircase and a ground node one stair-length beyond each end.) A roofed deck counts as sheltered in rain. Bridges show on the student map and in the 3D views drawn like the campus footbridge: concrete parapet walls, a striped band along the deck's edge, square pillars, and a gable roof on posts over the deck and down over the stairs (whose sides are solid walls). **Manage entrances** (a bridge's openings; the same editor as a building's doors): with entrances, routes get on and off the deck only through them, on the deck's floor (the ground under a raised deck stays open), so a route cannot slip sideways off the deck into a building next to it. **Find entrances** places them where existing paths come in: ground paths into a staircase's foot, and paths joining the deck on its own floor (a path counts within 10 m of the outline). The same button is in a building's Manage doors, where it puts a door wherever a ground path crosses the outline. Check them, then Save. **Manage nodes** (the bridge's Edit panel or popup) lists the nodes on the deck with Edit / Remove, adds new ones on the deck's floor, and opens Connect to ground, like a building's. **Closed** (in its Edit panel, with a required reason such as "Campus A event until 5 PM") takes the whole bridge out of routing, from either side, until an admin reopens it: the map draws it grey with the reason, and when it was the only way students see "<name> is closed: <reason>." instead of a generic error. Removing a bridge also deletes the nodes on its deck and the staircases up to them (the ground routes stay). The `kind` column makes later connectors (a skywalk, a tunnel) one new value, not a new table.
- Manage campus areas (the Campus A and Campus B outlines).
- Furnish the campus (Campus menu → **Trees, benches, sheds and gates**), like a city builder: tap the map to place one. A tree has a height, a crown width, a form (round, spreading, tall, palm) and **New look** (a random seed that reshapes it); its shade counts in heat routing, moving with the sun through the day. Benches and sheds (with a bench inside) have a size and facing. A gate snaps onto the nearest wall and opens a gap in it that routes pass through. All of them show in 2D and in the 3D views.
- Manage roads and walkways (bottom bar → **Add path**): draw, edit (name, type, real width in metres) and reshape them. A pathway is a route by itself: routes follow its line, so it needs no route nodes, and a covered walkway counts as sheltered in rain. **Clear route nodes along it** (in its Edit panel) removes the old route-node dots within a few metres of it, never staircase ends, nodes in buildings or on bridges, or rooms. The 2D map and the 3D views draw each one at its real width (blank = 5 m for a road, 2.4 m for a walkway).
- Manage nodes **only on bridges** (deck nodes and the stair feet under them). Rooms, offices and routes inside buildings, and their doors, belong to each building's department staff; outdoors, routes follow roads and walkways.
- Manage every wall, and the staircases of bridges (Connect to ground). Staircases inside buildings are the department staff's.
- Manage departments: create, rename, recolour, delete, and set each one's type: a **college** (has courses and students) or an **office** (registrar, cashier, canteen and the like: staff only, no courses). A college becomes an office only once its courses are moved or removed.
- Set **opening hours** only on buildings that belong to no department or office yet; otherwise its staff set them.
- Post **announcements** (Announcements tab): close the whole school, one campus, **every school building** (classes suspended, while office buildings stay open), every office building, one department or office, one building or one room, from a start to an end time, with a reason students see. Each ends on its own; **End now** ends it early. When the heat index is in the Danger range (41°C or more), the tab offers to fill in a class suspension; posting it is always the admin's call.
- Manage every student course in the **Courses** tab (code, full name and the department it belongs to). A department's courses decide which students its staff see in the Activity log.
- Manage staff accounts: create admins, building heads (the **Dean** of a college, the head of an office building) and **office staff**, assign departments, change roles, remove accounts. The account list filters by **Colleges**, **Offices** or **Admins**, and shows which offices each staff member runs. Nobody can remove or demote themselves, and at least one admin always remains.
- Manage student accounts: add, edit, reset a password (gives a one-time temporary password), remove.
- Open the Weather Dashboard (prediction history and accuracy) and update the weather now.
- Read the **Activity log**: every staff sign-in and change (by any admin or faculty member, so admins see each other's work), student sign-ins (name, course, year level), and what visitors open on the map (the map itself, a chosen destination, the 3D / AR view), with the visitor's IP address and device. Filter by staff, students or visitors, and search. Kept 180 days.

**Building heads** (the Dean of a college, the head of an office building: admin console at `/admin`; an admin must assign them a department first). Existing department staff accounts are heads.
- Assign **office staff** to each office or room in their building (the IT office, the CS office): the room's Edit panel → **Runs this office**.
- **Close now** (the building's popup): closes the whole building straight away, separate from its opening hours, until they press **Reopen**. Students see it closed and routes go around it.
- Add, edit, move and remove nodes (rooms, offices, route nodes) only inside their own department's buildings and on those buildings' floors, including nodes other people placed there. Admins do not edit these.
- Cannot add or edit nodes outside buildings or on bridges: admins manage the outdoor network (roads, walkways, bridges).
- Edit their own department's buildings: move, reshape, rename, change floors and height, and manage their **doors** (only department staff do; a building with no department gets none until an admin assigns one). They cannot add, remove or reassign buildings.
- Post **announcements** for their own department only (Announcements tab): close the department, one of its buildings or a room for a while (maintenance, an event) with a reason, or a **special opening** (open on a day they are usually closed, such as Sunday enrollment). They never have to repeat an admin's school-wide announcement, and cannot end one.
- Set their buildings' **opening hours** (the building's Edit panel: open days, opening and closing time, an optional lunch break, or a preset such as Mon–Sat 8–5), and a room's own hours where it differs from its building (a cashier with a lunch break), in the room's Edit panel. Office staff (registrar, cashier, canteen) work the same way as college staff, without courses.
- Draw walls, and edit or remove only the walls they drew.
- Add staircases between their own nodes, or from one of their nodes to an outdoor node.
- Swap two offices in their buildings: they trade names and departments and keep their spots.
- Mark a room or office as an important place (**Show to visitors**, in its Edit panel): visitors can then find it and get a route to it.
- Preview a route to any destination they can see, and print QR codes for nodes.
- Add, rename and remove their own department's student courses in the **Courses** tab (a new course is always filed under their department). A course with students in it cannot be removed.
- Read the **Activity log** of the students in their department's courses only (their sign-ins), not other staff or visitors.
- Cannot open the Weather Dashboard, Departments & accounts, or Students.

**Office staff** (a department's staff who are not its head)
- Set the **opening hours** of the offices their head assigned them, and post closures for them (out for lunch, maintenance). Everything else (rooms, doors, the building, other offices) stays the head's; the server refuses the rest.

**Students** (`/map`, signed in with their school ID or school email)
- See the full campus map: buildings, offices, rooms and floors.
- Search for a destination and get walking directions, worked out on the phone, including stairs between floors and building doors.
- Directions go around walls and buildings, prefer sheltered paths when rain is likely, and avoid exposed paths while it rains or in heat mode.
- See whether a place is open: the destination list and a building's popup say "Open · closes 5 pm" or "Closed · opens Mon 8 am" (campus time), or the reason when it is closed by an announcement ("Closed · System maintenance · opens 3 pm"). A closed place gets no route, only why and when it opens ("Misto is closed now. It opens tomorrow 8 am."); the route appears once it opens. Routes never cut through a closed building on the way.
- School-wide announcements (classes suspended, a campus closed) show as a banner at the top of the map, for visitors too.
- See the weather in one pill at the bottom of the map (what routing is doing right now); tap it for the details: chance of rain in the next 20 minutes and within the next hour, the heat index now and 1 to 3 hours ahead, and the UV index (sunburn risk). When no route is possible, the message says whether rain or heat closed the open-air paths.
- Tap **"It's raining here"** (in the weather pill's details) when rain starts. When two or more students report rain within 15 minutes, everyone's routes switch to covered paths straight away, before any forecast or airport report notices.
- Follow the **blue** route on the 2D map, in 3D, or in AR (camera view), where the route is a blue road on the ground with white chevrons moving toward the destination. On the 2D maps white chevrons along the line point the way, and a raised blue arrow at your position points where to start walking. Tap **Voice** on the direction card to hear each new direction spoken, just the direction in everyday words ("Go straight.", "Turn left.", "Turn around.", "You've arrived at …"), the same words as on the card, so it stays short while walking. It uses the phone's own voices, so it also works offline.
- Scan a QR code on campus to set their position when GPS is weak.
- Install ARNode on the home screen. After one online visit, the map, search and directions also work offline.
- Change their own password (required after an admin reset).

**Campus hours (students and visitors):** `/map` can only be used while the campus is open, by default 6 am to 9 pm campus time (`CAMPUS_OPENS_AT` / `CAMPUS_CLOSES_AT` in `.env`, read by `config/campus.php`). Outside them the map gives way to "The campus is closed", with when it opens again; the hours travel in the map feed, so this works offline too. The admin console is not affected. For presentations, the `/map` menu has a demo switch (follow the clock / show closed / keep open), shown only where the demo accounts are (development, or a build with `VITE_DEMO_ACCOUNTS=true`).

**Visitors** (`/map`, "View as visitor", no sign-in)
- See the buildings, their names and opening hours, and the campus areas.
- See the buildings with their floor counts, and the **important places** department staff show to visitors (such as the Dean's office), listed in each building's popup.
- Pick a building or an important place as the destination and get walking directions to it (2D, 3D and AR), over the bridge and up the stairs too. Their map carries only the outdoor network (roads and walkways, walls, the bridge's deck and stairs), those places, and the unnamed indoor route nodes and stairs of their buildings: every other room and office stays hidden.

---

## How it works, in plain words

1. **The map is made of nodes.** Staff place nodes in the admin console: *rooms and offices* (places people look for) and *route nodes* (points along walkways and corridors). Walls, buildings and doors tell the router where people cannot walk. Staircases join floors.
2. **The phone plans the route.** When a student picks a destination, the phone links nearby nodes into a walking network and finds the shortest walk. Nothing is sent to the server, so directions also work offline.
3. **The phone keeps a copy.** After signing in once online, the map is saved on the phone and refreshed every 20 minutes and whenever the phone comes back online.
4. **The server watches the weather.** Every 10 minutes it reads the forecast (Open-Meteo), the nearest airport report (Zamboanga, RPMZ) and, if the trained model uses it, Himawari satellite images of cloud tops over campus. Small AI models turn these into a chance of rain in the next 20 minutes and within the next hour. When rain is likely, open-air paths cost more, so routes lean toward covered walkways. While it is raining (or dangerously hot), open-air paths are closed. Students who see rain start can tap "It's raining here", which switches routes for everyone once two people agree.
5. **If something is missing, the app still works.** No weather means normal routing; no satellite scan means the model's simpler version is used; no network means the saved map is used.

---

## Getting started (developers)

Needs PHP 8.3+, Composer, Node 18+, PostgreSQL (tests use SQLite in memory), and Python 3.11+ only for the ML tools.

```bash
composer setup              # install, .env, key, migrate, npm install, build
npm run dev                 # php artisan serve --port=8005 and vite --port=5173 together
php artisan schedule:work   # weather every 10 minutes, map every 20 (keep it running in development)
```

| Open | URL |
|---|---|
| Student map (development) | `http://localhost:5173/map` |
| Admin console (development) | `http://localhost:5173/` |
| After `npm run build` | `http://localhost:8005/map` and `http://localhost:8005/admin` |
| iPhone install check (a form for testers) | `/iphone-check` |

- The campus map tiles must exist at `storage/app/university.pmtiles`.

**Not in the repository (on purpose; see `.gitignore`), and how to get it back:**

| Left out | Why | Get it back |
|---|---|---|
| `vendor/`, `node_modules/` | dependencies | `composer install`, `npm ci` |
| `public/admin/`, `public/build/`, `public/sw.js` | build output | `npm run build` |
| `.env` and every `.env.*` except `.env.example` | secrets | copy `.env.example` to `.env`, then `php artisan key:generate` |
| `storage/app/university.pmtiles` | campus map tiles (large) | extract the campus area from a Protomaps build with the PMTiles tool, or copy it from the team's shared drive |
| `pmtiles.exe` | 59 MB tool | download from github.com/protomaps/go-pmtiles/releases |
| `ml/data/` (about 61 MB) | downloaded weather, airport and satellite history | the download buttons in `python ml/gui.py` (the satellite one takes hours) |
| `ml/reports/before-*/`, logs, live test runs | backups and personal runs | not needed |

The trained models (`ml/model.json`, `ml/model_h60.json`, `ml/heat_model.json`), their parity files and the evaluation reports (`ml/reports/metrics*.json`, `results*.csv`, `calibration*.png`, `heat_metrics.json`) **are** in the repository, so the app works without retraining.
- Vite forwards `/api`, `/sanctum` and `/university.pmtiles` to port 8005; keep the ports in `package.json` in step.
- **Demo accounts** (password `password`, never in production): admin `admin@campus.test`; staff, one per department or office, each owning its building: `ccs.staff@campus.test`, `csm.staff@campus.test`, `ccje@campus.test`, `nursing@campus.test`, `cte@campus.test`, `ils@campus.test`, `msa@campus.test`, `cais@campus.test`, and the offices `canteen@campus.test`, `cashier@campus.test`, `misto@campus.test` (`php artisan db:seed --class=DemoStaffSeeder` resets them all to the demo password); students `ae202401622`, `ae202502307`, `ae202300418`. Development builds show one-tap demo buttons; production builds only with `VITE_DEMO_ACCOUNTS=true`.
- **Testing on a phone** through an ngrok tunnel: put the tunnel host in `VITE_ALLOWED_HOSTS` and set `VITE_TUNNEL=ngrok` (skips ngrok's warning page). The app must be opened online once on each phone before it works offline.

### Tests

```bash
php artisan test --compact                  # 298 PHP tests
node --test src/*.test.mjs tests/*.test.mjs # 157 JavaScript tests (routing, pathways, walls, stairs, doors, bridges, trees and gates, route arrows, opening hours and closures, rain, heat, UV)
python ml/test_satellite.py                 # satellite, cloud-motion and cloud-phase self-check (no network)
vendor/bin/pint --format agent              # format PHP after changes
```

---

## The weather AI

- **Rain model:** trained in `ml/train.py` on archived forecasts, airport reports and (optionally) satellite inputs. It answers "will it rain on campus in the next 20 minutes?", and routing follows this answer. A second model with the same inputs answers "will it rain at any time within the next hour?" (`ml/model_h60.json`, optional); the app shows that chance under the main line, for planning. The model type is a setting: a logistic regression (one weight per input, the default since Nov 2026: it scored better on the test months for both horizons and each prediction can be explained input by input) or gradient-boosted trees ("auto" keeps logistic unless the trees score at least 0.5% better on the validation months). Training then adds a calibration so the percentage means what it says (only if that helps on validation). It is only used if it beats every simpler method on a test period it never saw; otherwise the app uses the raw forecast. Training uses only steps labelled by the routine hourly airport report, because the extra reports the airport issues when the weather changes are almost always rain and would make the test look easier than real life.
- **How good it is (Nov 19, 2026, scored on months the models never saw):** the 20-minute model warns before about 50% of rain starts while wrongly warning on about 10% of dry moments; the 1-hour model warns before 54% of rain starts. Compared with the first campus model on the same unseen steps, it catches twice as many rain starts at the same false-alarm rate (18 instead of 9). It beats every simpler method by far (Brier score 0.0351 against 0.263 for Open-Meteo's own rain chance). Limits: about half of rain starts are still missed (showers can form within minutes), most warnings end dry, and the truth used for scoring is the airport a few km away. The live record on the admin Weather Dashboard is the real-world check.
- **Heat model:** predicts the heat index 1, 2 and 3 hours ahead (`ml/train_heat.py`, write-up in `ml/HEAT_REPORT.md`). It learns from the Zamboanga airport's thermometer, the same truth the live record uses (before Nov 14, 2026 it learned from ERA5 reanalysis, which smooths out hot afternoons and made it read about 2.7 °C too cool). Since Nov 18, 2026 it also **reads the airport's latest heat index** (`obs_heat_index`, the newest report at or before the current hour, at most 90 minutes old) and how far the forecast is off from it right now (`obs_minus_forecast`). On the same test hours that cut the error from 1.52 to **1.27 °C** at +1 h and from 1.58 to 1.48 °C at +2 h (+3 h unchanged at 1.60 °C). Without a recent airport report the app scores the model trained without those inputs (the file's `fallback`), so an airport outage never stops the outlook.
- **Hot-hour warning:** a regression pulls rare 40 °C+ hours toward the usual (the +1 h model reaches 40 °C on only 18 of 110 such test hours), so each horizon also has a small logistic regression for "will the heat index reach 40 °C?". Its alert threshold is chosen on validation (best F1). On the test year it warned before 58 of the 110 hot hours at +1 h (74 at +2 h), with false alerts on about 3% of other hours (5% at +2 h). The weather chip then says "could reach 40°C by 2 pm". It is a **warning only**: paths still close on the heat index itself.
- **Heat mode** (open-air paths closed) turns on when the heat index *now* is above 40 °C. Since Nov 18, 2026 "now" (temperature, humidity and heat index) comes from the airport's latest report when it is less than 75 minutes old, and from the forecast otherwise (`heat_now_source`); the forecast's "now" ran about 1.4 °C cooler than the airport thermometer. A prediction never closes paths ahead of time: if the last update predicted over 40 °C for, say, 1 pm, the phone closes them once 1 pm arrives, until the next update decides from the new reading.
- **Satellite (optional):** `ml/satellite.py` reads two Himawari-9 images around campus, about 12 minutes behind real time: infrared (how cold, and so how tall, the cloud tops are, and whether they grew colder over the last 10 and 20 minutes) and water vapour (whether a cloud reaches the upper air, the sign of a real storm cloud rather than a thin high one). History starts in 2024. Training compares the model with and without them and keeps satellite only if it clearly helps (at least 0.5% better on validation, with at least 12 months of history). In a Nov 2026 test on the same unseen months, the water-vapour image and 10-minute cooling let the model warn about more rain starts at the same number of false alarms (16 instead of 12 at 3.5% of dry moments warned). Extra forecast inputs (lifted index, convective inhibition, freezing level, humidity aloft) were tested too and did not help, so they are not used.
- **Cloud phase (since Nov 19, 2026):** `ml/cloud_phase.py` reads NOAA's cloud-phase product for Himawari-9 and gives the share of water, supercooled and ice cloud within 10 km of campus, and of any cloud within 30 km (`sat_phase_*`, about 0.15 MB a scan over HTTP). Infrared alone sees how cold a cloud top is, not what it is made of, so warm water clouds that drizzle (the Nov 16 miss) looked harmless. NOAA's archive has no phase files from Oct 12 to Nov 25, 2025 (91% coverage of the training steps); those steps are kept with `sat_phase_missing` = 1, and live a late phase file is scored the same way instead of dropping the satellite. Needs `h5py` on the server (`ml/requirements.txt`).
- **"Raining now"** comes, in this order, from students' **"It's raining here"** reports (at least 2 different people within 15 minutes), the airport report when it is less than 75 minutes old, otherwise the forecast. Reports only ever turn rain on: a wrong "raining" sends people under cover, a wrong "dry" could send them into the rain. Each person can report once every 5 minutes. Reports are kept 180 days as campus-level ground truth for checking (and later training) the rain model.
- **Ensemble forecasts (recorded, not used yet):** every refresh saves a summary of the Open-Meteo Ensemble API (free for non-commercial use, up to 10,000 calls a day; the app makes 144): ECMWF IFS and AIFS (51 members each), GFS (31) and ICON (40). For each model and hour it keeps the share of members with at least 0.1 mm and 1 mm of rain, and their mean and largest amount (table `weather_ensembles`, never pruned). That API keeps only about 3 days of the past, so this table is the only history there will be. After a few months, `php artisan weather:ensemble-export` writes `ml/data/ensemble_live.csv` to test "how many members say rain" as a rain-model input. `WEATHER_RECORD_ENSEMBLE=false` turns it off.
- **UV index:** Open-Meteo's forecast UV index, shown from "moderate" (3) up. From "high" (6) routes prefer shade, more strongly up to "extreme" (11), the same way they do on hot days, so a clear but mild morning still steers students away from full sun.
- **Freshness:** the server refreshes every 10 minutes (the satellite's rhythm) and phones check every 5, so a new satellite image or airport report reaches students within about 15 minutes, and a rain report within 5.

### Benchmarks

Every method below is scored on months that **none** of the models trained or tuned on, against what the Zamboanga airport actually observed. Numbers measured in November 2026 (also in `ml/reports/benchmarks/benchmarks.json`; the charts and file come from `python ml/benchmark_chart.py`, which scores every saved model on the same steps).

**Rain, 20 minutes ahead.** The fairest test of "will students get a warning before the rain starts?": every method may wrongly warn on at most 5% of dry moments, and we count how many of the 82 rain starts (dry, then rain) it warned about.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="ml/reports/benchmarks/rain_benchmark_dark.png">
  <img alt="Bar chart: rain starts warned at a 5% false-alarm rate, out of 82. Open-Meteo 0, original model (Nov 7) 15, first satellite model (Nov 13) 19, + water vapour (Nov 14) 26, + cloud phase (Nov 19, current) 28." src="ml/reports/benchmarks/rain_benchmark_light.png">
</picture>

| Method (Jul 29 - Oct 30 2026, 3,550 steps, 82 rain starts) | Rain starts warned at 5% false alarms | AUC (1 = perfect) | Brier score (lower is better) |
|---|---|---|---|
| Open-Meteo's own rain chance | 0 (it says 100% on 5.3% of dry moments) | 0.852 | 0.240 |
| Original campus model (Nov 7): forecast + airport + 9 models | 15 | 0.890 | 0.0298 |
| First satellite model (Nov 13): + cloud tops | 19 | 0.914 | 0.0296 |
| Nov 14 model: + water vapour, 10-minute cooling, history from 2024 | 26 | **0.923** | 0.0293 |
| **Current model (Nov 19): + cloud phase** | **28** | 0.922 | **0.0288** |

**Cloud phase (Nov 19), like for like.** The models before and after cloud phase, scored on the same 4,772 test steps (Jun 26 - Oct 30 2026; `python ml/train.py --compare <old model.json>`), each at its own alert threshold. Kept because it was better on validation first (1.6% lower Brier at 20 minutes, 1.3% at 1 hour).

| Test steps, Jun 26 - Oct 30 2026 | Brier | AUC | Rain starts warned | Dry moments warned |
|---|---|---|---|---|
| 20 min, Nov 14 model (satellite) | 0.0354 | 0.920 | 46.6% | 9.8% |
| **20 min, Nov 19 model (+ cloud phase)** | **0.0351** | 0.920 | **50.4%** | **9.6%** |
| 1 h, Nov 14 model | 0.0390 | 0.916 | 49.0% | 10.8% |
| **1 h, Nov 19 model (+ cloud phase)** | **0.0377** | 0.916 | **54.2%** | 11.1% |

Gradient-boosted trees with the same inputs scored better on validation but worse on these test months (Brier 0.0365 and 0.0401), so the model type stays logistic, the default in `ml/gui.py` and `ml/train.py`.

The 1-hour model ("rain at any time within the next hour", 153 rain starts in the test period) has AUC 0.916 and Brier 0.038, against 0.862 and 0.260 for Open-Meteo's own chance.

**Heat index, 1 to 3 hours ahead.** Average error against the airport thermometer over a full test year.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="ml/reports/benchmarks/heat_benchmark_dark.png">
  <img alt="Grouped bar chart: heat index error at +1, +2 and +3 hours. First model (Nov 7, ERA5-trained) 3.44, 3.48, 3.51 °C; Nov 14 model 1.52, 1.58, 1.62; Nov 18 model (current) 1.27, 1.48, 1.60; Open-Meteo forecast 2.28, 2.24, 2.23." src="ml/reports/benchmarks/heat_benchmark_light.png">
</picture>

| Method (Nov 2025 - Oct 2026) | +1 h | +2 h | +3 h | Bias at +1 h |
|---|---|---|---|---|
| **Current model (Nov 18): + the airport's latest heat index** | **1.27 °C** | **1.48 °C** | **1.60 °C** | **−0.1 °C** |
| Airport heat index now + the typical change to that hour | 1.31 °C | 1.56 °C | 1.67 °C | −0.05 °C |
| Model of Nov 14 (airport thermometer as truth, forecast inputs only) | 1.52 °C | 1.58 °C | 1.62 °C | +0.1 °C |
| Typical value for that month and hour | 1.78 °C | 1.76 °C | 1.73 °C | −0.3 °C |
| Open-Meteo forecast heat index | 2.28 °C | 2.24 °C | 2.23 °C | −1.6 °C |
| First model (Nov 7, trained on ERA5 reanalysis) | 3.44 °C | 3.48 °C | 3.51 °C | −2.7 °C |

All rows except the first model are scored on the same test hours: those with an airport report in the 90 minutes before (about 6,200 to 6,500 hours per horizon; the first model's numbers are from its own write-up).

### Future work for the weather AI (built or planned, not active)

Each idea below is an extra source or method checked in Nov 2026. None of them changes the app until it is trained and **clearly** beats the current model on validation (the same rule as satellite: at least 0.5% lower Brier), then scores better on the unseen test months.

1. **JAXA GSMaP_NOW (on hold, not built).**
   - *What it is:* a satellite rain estimate (microwave + Himawari), every 30 minutes, near real time, whole globe since 2019.
   - *Why:* it is the only live estimate of rain actually falling around campus. Himawari alone gives cloud temperature, not rain, and the airport is a few km away. It should help most with drizzle and with showers already falling nearby.
   - *Why on hold:* it needs a free JAXA account; FTP details arrive by email after registering at the GSMaP site (sharaku.eorc.jaxa.jp). The site was down for maintenance when checked, so the archive dates and file format are still unconfirmed.
   - *How it would fit:* a `gsmap.py` next to `ml/satellite.py` (campus box statistics from the latest file, the same code for history and live), a `download_*.py` for history, a new variant in `ml/train.py`, and a flag on `satellite.py now`, like cloud motion below and cloud phase.
2. **Himawari cloud motion (built, pilot tested Nov 21, 2026: no benefit, not adopted).**
   - *What it is:* `ml/satellite.py` matches the band-13 box around campus (about 66 km wide) against the scan 10 minutes earlier. It finds how far the clouds moved (block matching), then looks two moves upstream for the cloud that should be over campus in 20 minutes. Inputs: `sat_motion_kmh`, `sat_adv_bt_20min`, `sat_adv_cold_20min`, `sat_adv_minus_campus` (`MOTION_FEATURES`).
   - *Why:* today's satellite inputs only describe clouds over and around campus now (plus a rough "cold cloud upwind" share), so a storm drifting in is noticed late. A 2024 study over the Maritime Continent found this kind of extrapolation of Himawari images beat "nothing moves" at every lead time. It cannot predict clouds that form on the spot; the cooling inputs cover those.
   - *Why disabled:* the saved satellite history keeps only 10 numbers per scan, not the images. Training needs every :10 and :30 scan from Apr 2024 re-read together with the scan 10 minutes before it: about 44,000 pairs, **about 140 GB and 12-20 hours** of downloading (measured Nov 2026: 48 pairs took 85 s and 150 MB).
   - *What is ready:* the code, the self-checks in `ml/test_satellite.py`, the download (`python ml/download_satellite.py --start 2024-04-01 --motion`, resumable, writes `ml/data/satellite_motion.csv`), the training variant "satellite + cloud motion" (used only once that file covers at least 98% of the satellite steps), and the app side: a model with `sat_adv_*` or `sat_motion_*` inputs makes the server call `satellite.py now --motion` (two extra downloads per refresh). Live, the inputs are only computed when the model asks for them, so nothing is wasted today.
   - *Pilot (Nov 21, 2026):* `python ml/download_satellite.py --motion --every 8 --start 2024-04-01` downloaded 1 scan pair in 8, spread evenly over every hour of the day (5,784 pairs, 17 GB, about 1.5 hours; 11% of the training steps; the rest read `sat_motion_missing` = 1). On validation, motion made the model slightly **worse**, alone and on top of cloud phase (20 minutes: 0.02338 with phase + motion against 0.02331 with phase; 1 hour: 0.02553 against 0.02547), and the test months showed no gain either, so the live model is unchanged and the full ~140 GB download is not worth it for now. `ml/train.py` also tries "cloud phase + motion" whenever the motion history exists.
3. **Time-series neural network (experiment).** `python ml/train.py --sequence` (needs PyTorch) trains a GRU, a recurrent network, on the last 2 hours of inputs (8 steps of 15 minutes) next to the logistic regression, on the same rows and split. It writes `ml/reports/sequence_comparison.json` and never touches the model files. Result on Nov 19, 2026 (3 seeds averaged): validation Brier 0.02364 against 0.02369, only 0.2% better, so it **does not clear the 0.5% bar** and the app keeps the logistic regression. On the test months it looked a little better (Brier 0.0350 against 0.0364; 49.6% of rain starts warned against 46.6%, with 9.2% of dry moments warned against 10.2%; AUC 0.916 against 0.920), but choosing a model by its test score would tune on the test. Worth retrying once there is more data (cloud phase, ensemble history, a season of student rain reports). Using it would also need a scorer in the app (the GRU weights in JSON plus a small forward pass in PHP or in `satellite.py`), which is not built.
4. **Ensemble forecasts.** Recording since Nov 18, 2026 (see above). Train with them after a few months of rows.
5. **Himawari cloud phase:** adopted on Nov 19, 2026 (see the satellite bullet and Benchmarks above).
6. **Airport temperature as a rain input (tested Nov 21, 2026, not adopted).** The rain model reads Open-Meteo's temperature, which runs 1.4-2 °C cooler than the airport thermometer, so two inputs were tried: the airport's latest temperature and dew-point gap minus the forecast's (0 without a recent report). Same data and split as the current model. Validation Brier got slightly **worse** (20 minutes 0.02353 against 0.02331, 1 hour 0.02567 against 0.02547), and the 1-hour test score too (0.0389 against 0.0377), so the code was removed again. The model gave them little weight: the forecast temperature and the satellite's cloud-top temperatures already carry it.

**Retraining** uses the training dashboard: `python ml/gui.py` (install packages once with `python -m pip install -r ml/requirements.txt`). In the Rain model section: 1 Download Open-Meteo, 2 Download METAR, 2b Download satellite (optional, many hours from 2024, resumable; the cloud-phase history is a separate command, `python ml/download_satellite.py --start 2024-04-01 --cloud`, about 9 GB and 5 hours, resumable, needs `h5py`), 3 Train and evaluate (the 20-minute model), 3b Train 60-min model (optional). The Evaluation tab compares every input set, including the share of **rain starts** each one warned about. "Run parity check" proves the PHP app computes the same numbers as Python.

---

## Putting it online (production checklist)

- **Server:** PHP 8.3+ with `pdo_pgsql`, `mbstring`, `openssl`, `curl`, `xml`, `fileinfo`; PostgreSQL; Node 18+ to build. Python 3 only if `ml/model.json` has a `satellite` block (standard library only; set `WEATHER_PYTHON` if it is not called `python`), plus the `h5py` package only if that block says `"cloud_phase": true`. Without them the app scores the model's fallback.
- **Environment (names only, never commit `.env`):** `APP_ENV=production`, `APP_DEBUG=false`, `APP_URL`, `APP_KEY`, `DB_*`, `FRONTEND_URL`, `STUDENT_EMAIL_DOMAIN`, `TRUSTED_PROXIES` behind a proxy, `WEATHER_*` as wanted. Sign-in tokens expire after 30 days by default (`SANCTUM_EXPIRATION` in minutes overrides it).
- **Build and deploy:** `composer install --no-dev --optimize-autoloader`, `npm ci && npm run build`, `php artisan migrate --force`, `php artisan storage:link`, copy `storage/app/university.pmtiles`, keep `ml/model.json`, `ml/model_h60.json` and `ml/heat_model.json`, then `php artisan config:cache && php artisan route:cache`.
- **Scheduler:** cron `* * * * * cd /path/to/app && php artisan schedule:run` (weather every 10 minutes, map every 20; expired tokens and old prediction history daily).
- **Check the build:** `grep -r "campus.test" public/admin` must find nothing (no demo accounts).
- **First admin** (seeders refuse to run in production): run `php artisan tinker` and enter
  ```php
  $u = new App\Models\User(['name' => 'Campus Admin', 'email' => 'admin@your-school.edu.ph']);
  $u->password = Illuminate\Support\Facades\Hash::make(readline('Password: '));
  $u->forceFill(['role' => 'admin'])->save();
  ```
  then create the other accounts in the admin console.

---

## Project status (against the Project Viability Assessment)

| Module | Status | Notes |
|---|---|---|
| 1. Positioning (GPS, map matching, compass, QR) | ✅ | Works online and offline. The ≥90% accuracy target is not measured yet. |
| 2. Search and routing (stairs, floors, doors) | ✅ | Routes are computed on the phone only. Lifts and ramps are not modelled. |
| 3. AR and 2D guidance | ✅ | AR uses the camera and compass; iOS has no WebXR, so AR there is the camera view. |
| 4. Admin node-mapping tool | ✅ | The 15-minute learnability test is not done yet. |
| 5. Map publishing and offline copy | ✅ | Installable app (service worker); map saved on the phone. |
| 6. Accounts and access control | ✅ | Admin, faculty, student, visitor. No per-room "restricted" flag yet. |
| 7. Security and safety | 🟡 | Hashed passwords, role checks, throttled sign-in, expiring tokens, a "look up from the screen" reminder in AR. Missing: privacy notice, screen wake lock. |
| 8. Weather AI and weather-aware routing | ✅ | Rain models (20 minutes and 1 hour), heat model, satellite, student rain reports, UV-aware shade routing. |
| 9. Usage statistics | ❌ | Not built. |

**Still to do:** privacy notice and consent (RA 10173), screen wake lock during navigation, usage statistics, measuring the objectives (GPS accuracy, AR route display speed, admin training time, live weather accuracy after a few weeks), floor-aware GPS map matching, and a view of student rain reports on the Weather Dashboard. Weather AI ideas that are built or planned but not active are under "Future work for the weather AI" above.
---

## Technical reference

### Stack

| Part | Technology |
|---|---|
| Backend | Laravel 13, PHP 8.3+ (developed on 8.5), Sanctum bearer tokens |
| Database | PostgreSQL (SQLite in memory for tests) |
| Frontend | React 18, Vite 5; two pages: `index.html` (admin console) and `map.html` (student map); built into `public/admin` |
| Maps | Leaflet 1.9 + protomaps-leaflet + a self-hosted PMTiles archive; optional Esri satellite imagery (online only) |
| 3D and AR | three.js 0.186, loaded only when a 3D view opens |
| ML | Python (pandas, scikit-learn) for training; models exported as JSON and scored in PHP |

### Main data

| Table | Holds |
|---|---|
| `users` | Admins, faculty (with a department; `is_head` = the building head, else office staff) and students (school ID, course, year level). |
| `campus_objects` | Trees (height, crown, form, seed), benches, sheds and gates placed on the campus. |
| `nodes` | Rooms, offices and route nodes: position, floor, `inside`/`outside`, building, department, who placed it, and a place's own `opening_hours` (none = its building's). |
| `node_links` | Staircases between two nodes on different floors (slope, direction, flights, landing). |
| `borders` | Walls: points sharing a `group_id`; routes never cross them. |
| `buildings` | Outline, floors, height, status, `category` (`school`: classes, or `office`: cashier, registrar, canteen; follows the owning department's kind, an admin labels unowned ones), doors, department, optional weekly `opening_hours` (`{"mon": [["08:00", "17:00"]], ..., "sun": []}`; none = always open). |
| `bridges` | Connectors people walk through (footbridges): outline, `kind`, deck floor and height, roofed, status, `closed` and `closed_reason` (an admin closure). Public in the map feed, like buildings. |
| `pathways` | Roads and walkways, each a route along its line (no stored route nodes), with an optional real `width_m`. |
| `campus_areas` | Named campus outlines. |
| `departments` | Name, label colour and `kind`: `college` (courses, students) or `office` (registrar, cashier, canteen; staff only). |
| `closures` | Announcements: `closed` or a special `open`ing, `starts_at` to `ends_at`, a `reason`, and a scope from the filled columns (all empty = the whole school): `campus`, `building_category` (every school or every office building), `department_id`, `building_id`, `node_id`. Current and upcoming ones travel in the map feed (a room's only to signed-in users). |
| `courses` | Student courses: unique `code` (BSIT), full name, owning `department_id` (indexed foreign key; a removed department leaves its courses unassigned). Students point at one with `users.course_id` (indexed foreign key; a course with students cannot be deleted). The API still sends and accepts the course code. |
| `weather_predictions` | Every 10-minute prediction and what the airport saw (kept 180 days). |
| `rain_reports` | "It's raining here" taps: who and when (kept 180 days). |
| `activity_logs` | Sign-ins, staff changes (`LogStaffActions` middleware: which fields, never their values) and visitor map activity (`POST /api/activity`, 30 a minute per IP). Snapshots the person's role, name, course, year level and department, plus IP and device. Kept 180 days. |
| `weather_ensembles` | Every refresh's ensemble-forecast summary per model and hour (never pruned; training history for a future input). |

Foreign keys and the wall `group_id` are indexed. The public static file `/storage/data/map.json` holds buildings only; signed-in users get the full map from `GET /api/map-data`.

### API (`routes/api.php`)

- **Public:** `GET /api/map-data` (buildings only without a token, the full map with one), `GET /api/weather`, `POST /api/login`, `POST /api/student/login`. Sign-in counts only failed tries (10 a minute per account and address, 100 per address).
- **Students:** `GET /api/student/me`, `POST /api/student/password`, `POST /api/student/logout`, `POST /api/weather/rain-report` (any signed-in user; once every 5 minutes; replies with the updated weather state).
- **Staff (admin and faculty; rules per role in the controllers; office staff only change their own offices, `RestrictOfficeStaff`):** `nodes` (+ `POST /api/nodes/swap`), `node-links`, `borders` (+ `DELETE /api/borders/group/{id}`), `buildings`, `pathways` (+ `POST /api/pathways/{id}/route-nodes`), `campus-areas`, `campus-objects`, `closures`, `departments`, `users`, `students` (+ `reset-password`), `GET /api/weather/history`, `POST /api/weather/refresh`.

### Routing rules (`src/pathfinding.js`)

- Every road and walkway is walkable along its line: the router lays virtual route nodes every 6 m along it (`pathwayWaypoints`, never stored or drawn), which join everything nearby like any route node. GPS snapping uses them too.
- Walking links use a Gabriel graph on each floor: two nodes are linked if no other reachable node sits between them and the line crosses no wall. Staircases are the only links between floors.
- Labelled buildings (not "planned") are obstacles; with doors, routes enter only through them.
- Drawn walls block every step that would cross them. A virtual turning point just past each open wall end (`wallEndWaypoints`) lets routes go round the end (from a street into the road behind a wall). Each turning point links to every point it can see within 60 m, not only its nearest neighbours, so a route turns there cleanly instead of bending through a third point. A start more than 6 m behind a wall gets "A wall stands between you and every path nearby" instead of a route through it; closer than that is treated as GPS drift. The first step from where you stand may go to any route point in plain sight within 150 m (not only the nearest few), costed like any other step (rain, and sun on hot days), so a walk down a street to its far end is one straight line. Walking off the mapped paths (across open ground, round a wall's end, onto the network from where you stand) costs 1.5x per metre (`OFF_PATH_FACTOR`), so routes keep to roads and walkways where there are any; reported distances stay real.
- A closed bridge's deck nodes (and so both its staircases) are left out of routing.
- A building closed right now (its `opening_hours` or an announcement covering it, campus time UTC+8, `src/openingHours.js`) is a solid wall with its doors shut and its rooms left out, except the building the route goes to and the one you are standing in. An announcement beats a special opening, which beats the weekly hours.
- Bridges with entrances are walls on the deck's floor only, with a gap at each entrance. A raised deck passes over the drawn walls under it (a road edge or fence), so they never cut the deck in half; on the ground those walls still block.
- The student 2D map draws a bridge's part of the route on the ground-floor view: up the stairs' walking line, along the deck and down again. A route that leaves the floor being shown is never joined straight across the gap.
- Dijkstra picks the cheapest walk. In rain mode an open-air link costs more (`src/weatherCost.js`); on hot days or under a high UV index, sunny links cost more than shaded ones (`src/shadeRouting.js`). Distances and walking times shown to students stay real.

### Weather settings (`config/weather.php`)

Campus point, rain-mode thresholds, the rain penalty, how old weather may be before it is ignored (60 minutes), the airport station, the heat limits, the satellite switches (`WEATHER_USE_SATELLITE`, `WEATHER_PYTHON`, `WEATHER_SATELLITE_TIMEOUT`), the optional hour model (`WEATHER_HOUR_MODEL_PATH`, default `ml/model_h60.json`), the rain reports rule (`WEATHER_REPORTS_MIN_PEOPLE` = 2, `WEATHER_REPORTS_WINDOW_MINUTES` = 15), and the ensemble recording (`WEATHER_RECORD_ENSEMBLE`, `WEATHER_ENSEMBLE_MODELS`).

---

## Credits and licences

- Weather data by **Open-Meteo.com** (CC BY 4.0).
- Airport reports (METAR) from the **NOAA Aviation Weather Center** and the **Iowa Environmental Mesonet**.
- Satellite: **Himawari-8/9 data from the Japan Meteorological Agency (JMA), distributed by NOAA** (registry.opendata.aws/noaa-himawari).
- Map data © **OpenStreetMap** contributors; tiles by **Protomaps**; map library **Leaflet**.
- Optional satellite imagery: **Esri World Imagery** (free tier terms; attribution on screen).

---

## Notes for contributors and AI assistants

- Follow `CLAUDE.md`/`AGENTS.md` (Laravel Boost): match the conventions of neighbouring files, reuse existing components, no new dependencies without approval, prefer tests over one-off scripts.
- Keep this README current instead of adding new markdown files.
- Weather must never block routing. Routing rules live only on the phone; the server provides the weather state.
- Map content is entered only through the admin console (never seed fake coordinates); `created_by` is always set by the server.
- Do not add `React.StrictMode` to `main.jsx` or `mobile.jsx`: it mounts the camera, sensors and 3D renderer twice.
- Never commit `.env` or secrets.
