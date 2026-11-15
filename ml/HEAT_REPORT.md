# Heat index model: evaluation report

What the app shows: the heat index now ("Feels like 38°C, Extreme caution"), plus a
1 to 3 hour outlook ("41°C expected at 2 pm"). This report covers the outlook model.

## Update, November 2026: the truth is now the airport thermometer

Sections 1 to 6 below describe the first version (Nov 7), which learned from **ERA5** as the
truth. The app's live record then checked the outlook against the **Zamboanga airport (RPMZ)
thermometer** and found it read about 1.4 °C too cool. Scored on the airport over the last
12 months, that first model was 2.7 °C too cool on average (error 3.4 °C at +1 h, category
right only 42% of the time): ERA5, a ~25 km model cell, never goes above 36.6 °C here, while the
airport reached 43.3 °C, with 110 hours at 40 °C or more and 14 hours of Danger (42 °C or more).

`train_heat.py` now learns from the airport's heat index at the target hour (`--labels airport`,
the default; computed exactly like the app's live record, `heat_common.airport_heat_index` =
`Metar::heatIndex` in PHP). Inputs, model type and the PHP scorer are unchanged.

Test year 2025-11-02 to 2026-11-01, truth = airport thermometer:

| Horizon | Method | MAE °C | Bias °C | Category accuracy |
|---|---|---|---|---|
| +1 h | **Model, airport labels (shipped)** | **1.50** | **+0.02** | **80.1 %** |
| | Model, ERA5 labels (first version) | 3.44 | −2.67 | 42.2 % |
| | Typical for month and hour | 1.74 | −0.25 | 79.3 % |
| | Forecast heat index at the target hour | 2.19 | −1.37 | 70.2 % |
| | Persistence (forecast heat index now) | 2.42 | −1.50 | 65.8 % |
| +2 h | **Model, airport labels** | **1.60** | −0.01 | **78.3 %** |
| +3 h | **Model, airport labels** | **1.64** | −0.03 | **77.2 %** |

It beats every deployable baseline at every horizon, so it is shipped as `"recommended": true`.

Still weak at the extremes: of the 110 hours at 40 °C or more, the +1 h model reached 40 °C for
7 % of them (none of the baselines reached it at all), and none of the 14 Danger hours was
predicted as Danger. A regression pulls rare extremes toward the usual. The "now" heat index
still comes from the forecast, which runs about 1.4 °C cooler than the airport (next step:
use the airport's own reading for "now" when it is fresh, as the app already does for rain).

## 1. Definitions

- **Heat index:** US National Weather Service procedure. The simple formula is used below
  80 °F. At 80 °F and above, the Rothfusz regression is used, with the low-humidity
  (RH < 13 %) and high-humidity (RH > 85 %) adjustments
  (https://www.wpc.ncep.noaa.gov/html/heatindex_equation.shtml).
  - The same code exists three times: `ml/heat_common.py`, `app/Services/HeatIndex.php`
    and `src/heatIndex.js`.
  - Their results are checked against each other on an 88-point temperature × humidity
    grid (`tests/fixtures/heat_index_grid.json`), and against NWS chart values.
- **Categories:** PAGASA levels in °C. Caution 27–32, Extreme caution 33–41, Danger 42–51,
  Extreme danger 52 and above.
  - The values are in `config/weather.php` (`heat_categories`).
  - Source: PAGASA heat index advisories (pagasa.dost.gov.ph/weather/heat-index). That page
    shows the table only as an image, so the values were cross-checked against 2024–2026
    news reports quoting PAGASA.
- **Truth ("observed"):** the heat index computed from ERA5 reanalysis temperature and
  humidity at the target hour.
  - ERA5 is a ~25 km model grid cell, not a thermometer on campus (see Limitations).

## 2. Data

| File | Source | Period | Rows | Used for |
|---|---|---|---|---|
| `data/heat_era5_hourly.csv` | Open-Meteo Historical Weather API, `models=era5` | 2016-01-01 to 2026-10-31 | 94,968 (0 missing) | labels, diurnal baseline, the `--train-on era5` comparison |
| `data/heat_forecast_hourly.csv` | Open-Meteo Historical Forecast API (archived forecasts) | 2022-01-01 to 2026-10-31 | 42,360 (0 missing) | model inputs, persistence and forecast baselines |

- **Variables (both files):** temperature, relative humidity, dew point, cloud cover, wind
  speed, sea-level pressure, precipitation, shortwave radiation.
- **Location:** campus point 6.9131 N, 122.0622 E, Asia/Manila time.
- **What the heat index looks like here, 2016–2026 (ERA5):**
  - mean 28.9 °C, maximum 36.6 °C;
  - 24 % of hours below Caution, 73 % Caution, 3 % Extreme caution;
  - **no Danger hours at all**.
- **The forecast archive runs warmer:** mean 30.1 °C, maximum 38.9 °C, 19.8 % Extreme
  caution.

### The input mismatch (why the model learns from forecasts)

On the live server the model can only see the forecast API, never ERA5. Over the test year,
the forecast heat index is on average **1.22 °C warmer** than ERA5 at the same hour.

| Model trained on | Test MAE with forecast inputs (+1 / +2 / +3 h) | Bias |
|---|---|---|
| ERA5 inputs | 1.66 / 1.58 / 1.54 °C | +1.0 °C |
| **Archived forecast inputs (default, shipped)** | **0.83 / 0.85 / 0.87 °C** | **+0.2 °C** |

A model trained on ERA5 inherits the warm bias once it receives forecast inputs. Training on
the forecast archive removes most of that bias. To see the ERA5 version, run
`python train_heat.py --train-on era5`.

## 3. Model and splits

- **Model:** one ridge regression per horizon (+1, +2, +3 h). Inputs are standardised, and
  the coefficients are stored in `ml/heat_model.json` and scored by
  `app/Services/HeatModel.php` (no Python on the server).
- **Features at hour t** (only information known at t):
  - temperature, humidity, dew point, heat index;
  - 1 h and 3 h changes in temperature and in heat index;
  - cloud cover, wind speed, pressure, shortwave radiation;
  - hour of day (two harmonics) and month, both cyclic.
- **Split by time, never randomly:**

| Set | Period | Rows (+3 h) | Use |
|---|---|---|---|
| Train | 2022-01-01 to 2024-10-31 | 24,837 | fit |
| Validation | 2024-11-01 to 2025-10-31 | 8,760 | choose ridge strength (alpha 0.01 to 100; 100 chosen at every horizon) |
| **Test** | **2025-11-01 to 2026-10-31** | **8,757** | **scored once, never used for tuning** |

After choosing alpha, the model is refit on train + validation. The diurnal baseline uses
the same train + validation period.

## 4. Test results (last 12 months, scored once)

"Deployable" means the live app could actually compute it. The model rows use forecast
inputs, which is what the app receives.

| Horizon | Method | MAE °C | RMSE °C | Bias °C | Category accuracy |
|---|---|---|---|---|---|
| +1 h | **Model (forecast inputs, shipped)** | **0.83** | **1.08** | +0.19 | **82.9 %** |
| | Persistence (forecast heat index now) | 1.79 | 2.14 | +1.22 | 64.3 % |
| | Diurnal average (month × hour) | 1.21 | 1.47 | −0.14 | 76.2 % |
| | Forecast heat index at the target hour | 1.72 | 2.09 | +1.22 | 66.0 % |
| +2 h | **Model** | **0.85** | **1.10** | +0.20 | **82.7 %** |
| | Persistence | 1.95 | 2.32 | +1.22 | 61.5 % |
| | Diurnal average | 1.21 | 1.47 | −0.14 | 76.2 % |
| | Forecast heat index | 1.72 | 2.09 | +1.22 | 66.0 % |
| +3 h | **Model** | **0.87** | **1.13** | +0.20 | **82.2 %** |
| | Persistence | 2.22 | 2.62 | +1.22 | 57.8 % |
| | Diurnal average | 1.21 | 1.47 | −0.14 | 76.2 % |
| | Forecast heat index | 1.72 | 2.09 | +1.22 | 66.0 % |

**Reference (not deployable):** persistence of the ERA5 heat index scores 0.48 / 0.88 / 1.25 °C.
The live app never sees ERA5, so this is shown only as a lower bound.

### Confusion matrix (+1 h, model; rows = truth, columns = predicted)

| | none | caution | extreme caution | danger | extreme danger |
|---|---|---|---|---|---|
| none | 787 | 1,026 | 0 | 0 | 0 |
| caution | 213 | 6,325 | 53 | 0 | 0 |
| extreme caution | 0 | 209 | 146 | 0 | 0 |
| danger | 0 | 0 | 0 | 0 | 0 |
| extreme danger | 0 | 0 | 0 | 0 | 0 |

The +2 h and +3 h matrices look the same; all three are in `reports/heat_metrics.json`.

- **Extreme caution:** recall is 146 / 355 = 41 % at +1 h (39 % at +2 h, 35 % at +3 h).
- **Danger and above:** recall is **undefined**. The test year has zero Danger hours, and so
  do all ten ERA5 years. The model has never seen Danger heat, so nothing can be claimed
  about it.

## 5. Recommendation

**Ship the model.** It beats every deployable baseline at every horizon:

- at +1 h, its MAE is about 50 % lower than the forecast heat index and 31 % lower than the
  diurnal average;
- it has the best category accuracy at each horizon.

`heat_model.json` has `"recommended": true`. When the model cannot run (missing file, not
recommended, failed request, missing inputs), the server falls back, per horizon, to the
forecast heat index. The response field `heat_forecast_source` says which one was used.

## 6. Limitations (read before trusting the categories)

1. **ERA5 is not a campus thermometer.** A 25 km reanalysis cell smooths out the hot
   afternoons that a ground station records. PAGASA's own station readings for Zamboanga
   sometimes reach 40 °C or more, while ERA5 never passes 36.6 °C here. The model therefore
   learns the ERA5 scale and probably **underestimates real peaks**.
   - The "Feels like" now value comes from the live forecast, not the model, so it is not
     affected.
   - Better truth data would be a PAGASA or METAR station series (RPMZ temperature and dew
     point) as labels.
2. **No Danger examples.** The model is a linear fit to 27–37 °C conditions. Above that it
   extrapolates, untested.
3. **Extreme caution is missed more often than caught** (41 % recall at +1 h). The warm-biased
   forecast heat index catches more of those hours, but it also raises many false alarms.
   - If missing a warning matters more than a false alarm, one option is to show the higher
     of the model and the forecast heat index for the warning colour. This is a product
     decision and is not implemented.
4. **Short training history:** the forecast archive starts in 2022, so the model trains on
   about 3.8 years. Retrain each year as more archive becomes available.
5. **One campus point:** the forecast cell is larger than the campus. Shade and building
   effects are not modelled.

## 7. Heat-aware routing (now implemented)

Added after this report was first written:

- **Shade routing** (`src/shadeRouting.js`): from a heat index of 27 °C (or a UV index of 6),
  sunny exposed paths cost more than ones in building shadows, up to 1.6 times at 38 °C (or UV 11).
  It uses the heat index *now*, not the outlook.
- **Heat mode** (`WeatherService::resolveHeatMode`): at 40 °C or more, now or in the +1 h outlook,
  exposed paths are closed, like in rain. So the outlook model does affect routing through the
  +1 h value, which is why its cool bias against the airport mattered.

## 8. Reproduce

```bash
cd ml
pip install -r requirements.txt               # pandas, numpy, scikit-learn, requests
python download_heat.py --start 2016-01-01    # ~2 min; cached in data/raw/heat_*.json
python download_metar.py --start 2022-01-01   # the airport thermometer (labels)
python train_heat.py                          # airport labels; writes heat_model.json, heat_model_parity.json,
                                              # reports/heat_metrics.json, tests/fixtures/heat_index_grid.json
python train_heat.py --train-on era5          # comparison only (overwrites the files above;
                                              # re-run the default afterwards)
cd ..
php artisan test --compact --filter=Heat      # formula, parity and fallback tests
node --test src/heatIndex.test.mjs            # browser formula against the same grid
```

Data: Open-Meteo.com (CC BY 4.0). ERA5: Copernicus Climate Change Service.
