# MEA Electric Bill Card

A Home Assistant Lovelace card (HACS frontend plugin) that estimates your **MEA**
(Metropolitan Electricity Authority, Thailand) residential electric bill from
cumulative energy sensors — e.g. the energy/import sensors exposed by your
battery or energy-monitoring integration (such as Atmoce). It supports both
MEA residential rate schemes and a per-user billing cutoff day.

## Features

- **Normal (tiered / bucket) rate** — select a single cumulative energy sensor
  (kWh) and the card applies MEA's tiered/bucket pricing (type 1.1 ≤150
  units/month, or type 1.2 >150 units/month).
- **TOU (Time of Use) rate** — select your single cumulative energy sensor;
  the card automatically splits usage into on-peak/off-peak based on the
  timestamp of each reading (Mon-Fri 09:00-22:00 = on-peak, everything else
  off-peak) and applies MEA's on-peak/off-peak unit rates.
- **Custom billing cutoff day** — set the day of the month your bill cycle
  resets (1–31); usage is calculated from the most recent cutoff to now.
- Includes the Ft (fuel adjustment) charge and VAT in the estimate.
- Visual editor in the Lovelace UI — no YAML required.

## Installation (HACS)

1. In HACS, add this repository as a custom repository (category: "Lovelace").
2. Install **MEA Electric Bill Card**.
3. Add the resource if it isn't added automatically:
   `Settings → Dashboards → Resources → /hacsfiles/hass-mea-electric-bill/mea-electric-bill-card.js` (JavaScript Module).
4. Add the card to a dashboard, either via the visual editor or YAML.

## Configuration

### Normal (tiered) scheme

```yaml
type: custom:mea-electric-bill-card
name: Electric Bill
scheme: normal
tariff_class: "1.2"        # "1.1" (≤150 units/month) or "1.2" (>150 units/month)
cutoff_day: 5               # your bill cycle reset day, 1-31
ft_satang: 0                 # current Ft adjustment, satang/unit (update each quarter)
vat: 7
entities:
  total: sensor.atmoce_grid_energy_total   # cumulative kWh sensor
```

### TOU scheme

```yaml
type: custom:mea-electric-bill-card
name: Electric Bill
scheme: tou
cutoff_day: 5
ft_satang: 0
vat: 7
entities:
  total: sensor.atmoce_grid_energy_total   # same single cumulative kWh sensor
```

On-peak/off-peak split is derived automatically from the timestamps of the
sensor's history (Mon-Fri 09:00-22:00 = on-peak; nights and all day Sat/Sun =
off-peak). Thai public holidays (which MEA also bills as off-peak) aren't
accounted for, since Home Assistant has no built-in Thai holiday calendar.

### Overriding rates

MEA's energy charge rates and the Ft adjustment change periodically. You can
override the built-in defaults per card:

```yaml
rates:
  normal:
    "1.2":
      serviceCharge: 24.62
      tiers:
        - { upTo: 150, rate: 3.2484 }
        - { upTo: 400, rate: 4.2218 }
        - { upTo: .inf, rate: 4.4217 }
  tou:
    serviceCharge: 38.22
    onPeakRate: 5.7982
    offPeakRate: 2.6369
```

## Notes

- Selected entities must be **cumulative/total_increasing** energy sensors
  (kWh), not instantaneous power. Usage for the current cycle is computed as
  the difference between the sensor's value at the most recent cutoff day and
  now, via Home Assistant's history API.
- The default rates and Ft value are illustrative; always confirm current
  rates against your actual MEA bill, since Ft is revised quarterly.
- This card is presentation/estimation only — it does not modify your actual
  bill or any integration state.
