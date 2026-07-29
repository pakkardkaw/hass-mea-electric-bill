# PEA Electric Bill Card

A Home Assistant Lovelace card (HACS frontend plugin) that estimates your **PEA**
(Provincial Electricity Authority, Thailand) residential electric bill from
cumulative energy sensors — e.g. the energy/import sensors exposed by your
battery or energy-monitoring integration (such as Atmoce). It supports both
PEA residential rate schemes, a per-user billing cutoff day, an auto-updating
Ft (fuel adjustment) sensor, Thai holiday-aware TOU billing, and PEA's solar
buy-back (export) revenue.

> This is a rebrand + correction of the original
> [MEA Electric Bill Card](https://github.com/pakkardkaw/hass-mea-electric-bill).
> Thailand's tiered residential rates are set nationally and are identical
> between MEA and PEA, so those figures carry over unchanged. **PEA's TOU
> tariff is genuinely different** — it is split by voltage level, and the
> service charge for a normal household (24.62 ฿) is not the same figure MEA
> uses (38.22 ฿). See [Rates](#rates) below.

## Features

- **Normal (tiered / bucket) rate** — select a single cumulative energy sensor
  (kWh) and the card applies PEA's tiered/bucket pricing (type 1.1.1 ≤150
  units/month, or type 1.1.2 >150 units/month).
- **TOU (Time of Use) rate, split by voltage level** — select your single
  cumulative energy sensor; the card automatically splits usage into
  on-peak/off-peak based on the timestamp of each reading and applies PEA's
  on-peak/off-peak unit rates for your voltage level (1.2.1 at 22–33 kV, or
  1.2.2 below 22 kV — almost every household is 1.2.2).
- **Thai holiday-aware TOU billing** — optionally point the card at a
  `calendar.*` entity (e.g. Home Assistant's built-in Holiday integration for
  Thailand) and/or a static list of dates, so public holidays are billed
  off-peak the way PEA actually bills them. Correctly handles PEA's two
  exceptions: the Royal Ploughing Ceremony Day and compensatory holidays
  (วันหยุดชดเชย) are still billed **on-peak**, not off-peak.
- **Custom billing cutoff day** — set the day of the month your bill cycle
  resets (1–31); usage is calculated from the most recent cutoff to now.
- **Day / Week / Month / Bill cycle toggle** — switch the view directly on the
  card to see cost for today, this week (Mon-Sun), this calendar month, or
  the current billing cycle.
- **Auto-updating Ft** — point the card at a sensor (e.g. one built with HA's
  `scrape` integration reading PEA's published Ft page) instead of typing in
  a number every quarter.
- Includes the Ft (fuel adjustment) charge and VAT in the estimate.
- Visual editor in the Lovelace UI — no YAML required.
- Optional solar savings — set a PV Energy Total sensor plus either an export
  (electricity sold) total sensor (preferred, more accurate) or a PV Self
  Consumption Rate sensor, and the card shows how much self-consumed solar
  energy saved you, valued at the on/off-peak or tiered rate in effect when
  it was generated.
- Optional solar export (buy-back) revenue — if you're registered in PEA's
  solar rooftop buy-back programme, show how much your exported units earned
  you, as a separate line from your bill and from your self-consumption
  savings.

## Installation

### Via HACS (recommended)

1. Make sure [HACS](https://hacs.xyz/) is installed on your Home Assistant instance.
2. In Home Assistant, open **HACS** from the sidebar.
3. Click the **⋮** (three-dot) menu in the top right corner → **Custom repositories**.
4. In the dialog, paste this repository's URL:
   `https://github.com/mrkaqz/hass-pea-electric-bill`, set **Category** to
   **Lovelace**, then click **Add**.
5. Close the dialog. Search for **PEA Electric Bill Card** inside HACS
   (Frontend section) and open it.
6. Click **Download**, confirm the version, and download it.
7. **Register the Lovelace resource.** Recent HACS versions add this
   automatically. If the card isn't available when you try to add it to a
   dashboard, add the resource manually:
   - **Settings → Dashboards → ⋮ (top right) → Resources → + Add Resource**
   - URL: `/hacsfiles/hass-pea-electric-bill/pea-electric-bill-card.js`
   - Resource type: **JavaScript Module**
8. **Hard-refresh your browser** (Ctrl+F5 on Windows/Linux, Cmd+Shift+R on
   Mac) so it loads the new resource instead of a cached copy, then reload
   the dashboard.
9. Edit a dashboard → **Add Card** → search for **PEA Electric Bill Card** to
   use the visual editor, or add a manual card with
   `type: custom:pea-electric-bill-card` and configure it using the examples
   below.

> **Upgrading from the old MEA-forked card?** The resource path has changed —
> the filename is now `pea-electric-bill-card.js`, not
> `mea-electric-bill-card.js`. Remove the old resource entry and add the new
> one (step 7), or the card will render blank. Existing card configs using
> the old MEA-style `tariff_class` (`"1.1"`/`"1.2"`) or `ft_satang` values
> keep working — they're migrated automatically (see the
> [configuration reference](#all-configuration-options) below).

### Manual installation (without HACS)

1. Copy `pea-electric-bill-card.js` from this repository into your Home
   Assistant `config/www/` folder.
2. Add the resource: **Settings → Dashboards → ⋮ → Resources → + Add
   Resource**, URL `/local/pea-electric-bill-card.js`, type **JavaScript
   Module**.
3. Hard-refresh your browser, then add the card to a dashboard as in step 9
   above.

## Configuration

### Normal (tiered) scheme

```yaml
type: custom:pea-electric-bill-card
name: Electric Bill
scheme: normal
tariff_class: "1.1.2"       # "1.1.1" (≤150 units/month) or "1.1.2" (>150 units/month)
cutoff_day: 5                # your bill cycle reset day, 1-31
default_period: cycle        # day | week | month | cycle (default tab shown)
ft_baht: 0.1623               # current Ft adjustment, baht/unit (update each quarter, or use ft_entity below)
vat: 7
entities:
  total: sensor.atmoce_grid_energy_total                            # cumulative kWh sensor
  pv_total: sensor.atmoce_pv_energy_total                           # optional
  pv_export_total: sensor.atmoce_electricity_sold_total             # optional, preferred over the rate below
  pv_self_consumption_rate: sensor.atmoce_pv_self_consumption_rate  # optional, %, fallback
export_rate: 2.20    # optional, ฿/unit buy-back rate - only relevant if show_export is true
show_export: false   # optional, only enable if you're registered in PEA's solar buy-back programme
```

If you have more than one grid meter, `entities.total` also accepts a list and
sums their usage together:

```yaml
entities:
  total:
    - sensor.atmoce_grid_energy_total_a
    - sensor.atmoce_grid_energy_total_b
```

### TOU scheme

```yaml
type: custom:pea-electric-bill-card
name: Electric Bill
scheme: tou
tou_voltage_level: "1.2.2"   # "1.2.2" (below 22 kV, almost every household) or "1.2.1" (22-33 kV)
cutoff_day: 5
ft_baht: 0.1623
vat: 7
entities:
  total: sensor.atmoce_grid_energy_total                            # same single cumulative kWh sensor
  pv_total: sensor.atmoce_pv_energy_total                           # optional
  pv_export_total: sensor.atmoce_electricity_sold_total             # optional, preferred over the rate below
  pv_self_consumption_rate: sensor.atmoce_pv_self_consumption_rate  # optional, %, fallback
export_rate: 2.20    # optional, ฿/unit buy-back rate - only relevant if show_export is true
show_export: false   # optional, only enable if you're registered in PEA's solar buy-back programme
holiday_calendar: calendar.thailand_holidays   # optional, see "Holiday-aware TOU billing" below
holiday_dates: []                              # optional, extra static YYYY-MM-DD off-peak dates
```

Solar self-consumption, export revenue, and holiday-aware billing work the
same way under TOU as under Normal — they're independent of `scheme`. The
Normal example above and this one both show the same `entities` block for
that reason; use whichever fields are relevant to your setup.

On-peak/off-peak split is derived automatically from the timestamps of the
sensor's history (Mon-Fri 09:00-22:00 = on-peak; nights and all day Sat/Sun =
off-peak, unless overridden by a holiday — see below).

### All configuration options

Every option this card reads, in one place. Sections further down go into
more detail on the non-trivial ones (Ft, holidays, solar).

| Option | Type | Default | Notes |
|---|---|---|---|
| `type` | string | — | Always `custom:pea-electric-bill-card` |
| `name` | string | `"Electric Bill"` | Card title |
| `scheme` | string | `"normal"` | `"normal"` (tiered) or `"tou"` (time-of-use) |
| `tariff_class` | string | `"1.1.2"` | **Normal scheme only.** `"1.1.1"` (≤150 units/month) or `"1.1.2"` (>150 units/month). Legacy MEA-fork values `"1.1"`/`"1.2"` are migrated automatically. |
| `tou_voltage_level` | string | `"1.2.2"` | **TOU scheme only.** `"1.2.2"` (below 22 kV, virtually all households) or `"1.2.1"` (22–33 kV) |
| `cutoff_day` | number | `1` | Day of month (1–31) your PEA bill cycle resets |
| `default_period` | string | `"cycle"` | Which tab is selected on load: `"day"`, `"week"`, `"month"`, or `"cycle"` |
| `vat` | number | `7` | VAT percentage applied to the subtotal |
| `ft_baht` | number | `0.1623` | Manual Ft adjustment, **baht/unit**. Ignored whenever `ft_entity` resolves to a valid number. A legacy MEA-fork `ft_satang` value (satang/unit) is migrated automatically if present and `ft_baht` is not set. |
| `ft_entity` | string | — | Optional sensor providing Ft in baht/unit; see [Auto-updating Ft](#auto-updating-ft) |
| `holiday_calendar` | string | — | Optional `calendar.*` entity for TOU holiday billing; see [Holiday-aware TOU billing](#holiday-aware-tou-billing). TOU only. |
| `holiday_dates` | list of `"YYYY-MM-DD"` strings | `[]` | Optional static off-peak dates, in addition to (or instead of) `holiday_calendar`. TOU only. |
| `holiday_onpeak_keywords` | map | `{ ploughing: [...], compensatory: [...] }` | Optional override of the keyword lists used to classify `holiday_calendar` events. TOU only. |
| `export_rate` | number | `2.20` | PEA solar buy-back rate, baht/unit |
| `show_export` | boolean | `false` | Show the export-revenue line; only turn on if you're registered in PEA's buy-back programme |
| `entities` | map | — | See table below |
| `rates` | map | — | Optional override of the built-in tariff figures; see [Overriding rates](#overriding-rates) |

`entities` sub-options:

| Key | Required | Description |
|---|---|---|
| `entities.total` | **yes** | Cumulative grid-import kWh sensor. Also accepts a list of sensors (summed together) if you have multiple meters. |
| `entities.pv_total` | no | Cumulative PV production kWh sensor |
| `entities.pv_export_total` | no | Cumulative "electricity sold" / export kWh sensor — preferred source for both self-consumption savings and export revenue |
| `entities.pv_self_consumption_rate` | no | Self-consumption rate (%) sensor — fallback only, used if `pv_export_total` isn't set |

## Rates

PEA's tiered rates for tariff schedule 1 (residential) are numerically
identical to MEA's — Thailand's retail energy rates are set nationally by the
ERC. Only the class names differ (PEA: `1.1.1`/`1.1.2`; MEA: `1.1`/`1.2`). Old
configs carrying the MEA-style `tariff_class` values are migrated
automatically.

**PEA's TOU tariff genuinely differs** and is split by voltage level:

| Tariff | Service charge | On-peak (฿/unit) | Off-peak (฿/unit) |
|---|---|---|---|
| `1.2.1` (22–33 kV) | 312.24 ฿/month | 5.1135 | 2.6037 |
| `1.2.2` (below 22 kV — most households) | **24.62 ฿/month** | 5.7982 | 2.6369 |

If you're on TOU as a normal household (`1.2.2`), note the energy rates match
what MEA's TOU card would show, but the service charge does not — MEA's TOU
service charge is 38.22 ฿, not PEA's 24.62 ฿. This card defaults to `1.2.2`.

### Overriding rates

PEA's energy charge rates and the Ft adjustment change periodically. You can
override the built-in defaults per card:

```yaml
rates:
  normal:
    "1.1.2":
      serviceCharge: 24.62
      tiers:
        - { upTo: 150, rate: 3.2484 }
        - { upTo: 400, rate: 4.2218 }
        - { upTo: .inf, rate: 4.4217 }
  tou:
    "1.2.2":
      serviceCharge: 24.62
      onPeakRate: 5.7982
      offPeakRate: 2.6369
```

## Auto-updating Ft

PEA publishes the current Ft rate at
[pea.co.th/our-services/tariff/ft](https://www.pea.co.th/our-services/tariff/ft),
in **baht per unit** (this card's `ft_baht` option matches that unit exactly —
there is no satang conversion anywhere in this card).

The card itself **cannot** fetch that page directly: it's a Lovelace card
running in your browser, and PEA's site does not send the CORS header needed
for a cross-origin `fetch()` to succeed. Instead, have Home Assistant scrape
it server-side into a sensor, and point the card at that sensor. Add this to
`configuration.yaml`:

```yaml
scrape:
  - resource: https://www.pea.co.th/our-services/tariff/ft
    scan_interval: 86400
    sensor:
      - name: PEA Ft Rate
        unique_id: pea_ft_rate
        select: "#current-ft"
        unit_of_measurement: "THB/kWh"
```

Then set on the card:

```yaml
ft_entity: sensor.pea_ft_rate
```

If the sensor is missing, unavailable, or non-numeric, the card falls back to
the manually configured `ft_baht`. The active Ft value is always shown in the
card's "Ft adjustment" line, so a broken scrape is visible rather than silent.
This scrape depends on PEA keeping `id="current-ft"` in their page markup —
if PEA redesigns the page, the sensor goes `unknown` and the card falls back
automatically.

## Holiday-aware TOU billing

PEA's actual TOU rules:

- **On-peak:** 09:00–22:00, Monday–Friday, **and the Royal Ploughing Ceremony
  Day** (a public holiday that is still billed as a normal working day).
- **Off-peak:** 22:00–09:00 Mon–Fri; all 24h on Sat/Sun, Labour Day, and
  public holidays — **except** compensatory holidays (วันหยุดชดเชย), which
  are also billed **on-peak** like an ordinary weekday.

To get this right, set one or both of:

```yaml
holiday_calendar: calendar.thailand_holidays   # a calendar.* entity, e.g. HA's built-in Holiday integration
holiday_dates:                                  # static fallback / supplement, no calendar needed
  - "2026-04-13"
  - "2026-04-14"
```

Home Assistant's built-in **Holiday** integration (Settings → Devices &
Services → Add Integration → Holiday, country: Thailand) is the easiest
source — it creates a `calendar.*` entity with Thai public holidays already
labelled, which this card reads automatically.

Event summaries are matched against keyword lists to detect the Royal
Ploughing Ceremony and compensatory holidays (defaults cover both Thai and
English wording: `พืชมงคล`/`Ploughing`, `ชดเชย`/`Compensatory`). If your
calendar source uses different wording, override the keywords:

```yaml
holiday_onpeak_keywords:
  ploughing: ["พืชมงคล", "Ploughing"]
  compensatory: ["ชดเชย", "Compensatory"]
```

This only affects the **TOU** scheme; it's ignored under Normal.

## Solar self-consumption and export revenue

If you have solar, set `entities.pv_total` (cumulative PV production, kWh).
The card then estimates how much of that you consumed directly (offsetting
grid import) versus exported, using one of two methods:

- **`entities.pv_export_total`** (recommended) — a cumulative "electricity
  sold" sensor, e.g. Atmoce's `sensor.atmoce_electricity_sold_total`. The card
  computes `self-consumed = PV delta − export delta` per interval directly.
  This is more accurate than the percentage method below, especially over a
  full billing cycle — see the note below on why.
- **`entities.pv_self_consumption_rate`** (fallback) — a percentage sensor.
  Used only if no export sensor is configured. Home Assistant does not keep
  long-term statistics for this kind of sensor, so it relies on raw history,
  which is typically purged after ~10 days; results for the early weeks of a
  longer billing cycle fall back to the oldest available value rather than
  the true rate at that time. If neither sensor is set, the card assumes
  100% self-consumption, which overstates savings rather than showing zero.

Self-consumption savings are shown as their own line **below** the estimated
total — this is money you didn't spend, not a deduction from your bill (your
grid-import sensor already excludes that energy, so subtracting it again
would double-count).

If you're **registered in PEA's Solar Phak Prachachon (โซลาร์ภาคประชาชน)
rooftop buy-back programme**, you can also show export revenue:

```yaml
entities:
  pv_export_total: sensor.atmoce_electricity_sold_total
export_rate: 2.20   # ฿/unit, current 2569-round buy-back rate
show_export: true
```

Export revenue is:

- **Flat-rate**, not split by on/off-peak — the buy-back rate applies to all
  exported units regardless of time of day.
- **Not subject to VAT** — it's income from PEA, not a purchase.
- Shown as its own line, separate from self-consumption savings, plus an
  optional **Net cost** row (`estimated total − export revenue`). "Estimated
  total" always stays the amount PEA actually bills you.

`show_export` defaults to **off**. Exporting surplus without being registered
in the programme earns nothing — enabling this by default for everyone would
show phantom income to unregistered users, which is worse than requiring an
opt-in. The 2.20 ฿/unit rate and the 5 kW export cap are programme terms set
per annual round; treat `export_rate` as a figure to verify against your own
contract, not a fixed constant.

## Notes

- Selected entities must be **cumulative/total_increasing** energy sensors
  (kWh), not instantaneous power. Usage is computed from Home Assistant's
  recorder **long-term statistics** (retained indefinitely, hourly
  resolution, and already compensated for meter resets) for the older part
  of the period, plus raw **history** for the most recent minutes that
  haven't been aggregated into statistics yet. Statistics and history are
  on different numeric scales, so they're never spliced into a single
  series — usage is computed independently within each source and the two
  partial totals are added together. This means accurate totals even for
  billing cycles/months that extend past your recorder's history retention
  window (commonly ~10 days) — as long as long-term statistics are enabled
  for the entity (the default for energy sensors with a
  `total`/`total_increasing` state class).
- **Tiered rates and the service charge are monthly by definition**, but the
  Day/Week tabs apply the full tier stack and the full monthly service charge
  to a sub-month window. These tabs are only meaningful as rough indicators —
  only the **Bill cycle** (and Month) view is comparable to an actual bill.
- PEA's `1.1.1` vs `1.1.2` classification is driven by meter size and a
  rolling 3-month usage test that PEA applies — the card just uses whichever
  class you select, it does not reclassify you automatically.
- Solar self-consumption savings for battery systems are approximate: energy
  that charges a battery is counted as self-consumed at that moment's rate,
  even though it may actually displace grid import later (often at a
  different on/off-peak rate).
- The default rates and Ft value are illustrative; always confirm current
  rates against your actual PEA bill, since Ft is revised quarterly.
- This card is presentation/estimation only — it does not modify your actual
  bill or any integration state.
