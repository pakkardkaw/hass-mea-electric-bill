/* MEA Electric Bill Card
 * A Lovelace card that estimates a Metropolitan Electricity Authority (MEA, Thailand)
 * residential electric bill from cumulative energy sensors (e.g. exposed by a battery /
 * energy-monitoring integration), supporting both the "Normal" (tiered/bucket) tariff
 * and the "TOU" (Time of Use) tariff, with a user-configurable billing cycle cutoff day.
 */

const DEFAULT_RATES = {
  normal: {
    "1.1": {
      label: "Type 1.1 (≤150 units/month)",
      serviceCharge: 8.19,
      tiers: [
        { upTo: 15, rate: 2.3488 },
        { upTo: 25, rate: 2.9882 },
        { upTo: 35, rate: 3.2405 },
        { upTo: 100, rate: 3.6237 },
        { upTo: 150, rate: 3.7171 },
        { upTo: 400, rate: 4.2218 },
        { upTo: Infinity, rate: 4.4217 },
      ],
    },
    "1.2": {
      label: "Type 1.2 (>150 units/month)",
      serviceCharge: 24.62,
      tiers: [
        { upTo: 150, rate: 3.2484 },
        { upTo: 400, rate: 4.2218 },
        { upTo: Infinity, rate: 4.4217 },
      ],
    },
  },
  tou: {
    serviceCharge: 38.22,
    onPeakRate: 5.7982,
    offPeakRate: 2.6369,
  },
};

const VAT_DEFAULT = 7;

function tieredEnergyCharge(units, tiers) {
  let remaining = Math.max(0, units);
  let prevLimit = 0;
  let total = 0;
  for (const tier of tiers) {
    const blockSize = Math.min(remaining, tier.upTo - prevLimit);
    if (blockSize > 0) {
      total += blockSize * tier.rate;
      remaining -= blockSize;
    }
    prevLimit = tier.upTo;
    if (remaining <= 0) break;
  }
  return total;
}

function getCycleStart(cutoffDay, now) {
  let start = new Date(now.getFullYear(), now.getMonth(), cutoffDay, 0, 0, 0, 0);
  if (start > now) {
    start = new Date(now.getFullYear(), now.getMonth() - 1, cutoffDay, 0, 0, 0, 0);
  }
  return start;
}

const PERIODS = {
  day: { label: "Day" },
  week: { label: "Week" },
  month: { label: "Month" },
  cycle: { label: "Bill cycle" },
};

function getPeriodStart(period, cutoffDay, now) {
  if (period === "day") {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  }
  if (period === "week") {
    const diffToMonday = (now.getDay() + 6) % 7; // Mon=0 ... Sun=6
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - diffToMonday, 0, 0, 0, 0);
    return start;
  }
  if (period === "month") {
    return new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
  }
  return getCycleStart(cutoffDay, now);
}

// MEA residential TOU schedule: on-peak is Mon-Fri 09:00-22:00; everything else
// (nights, and all day Sat/Sun) is off-peak. Public holidays are also off-peak
// under MEA's actual rules, but aren't accounted for here since HA has no
// built-in Thai holiday calendar - see README for the limitation.
function isOnPeak(date) {
  const day = date.getDay(); // 0 = Sunday, 6 = Saturday
  if (day === 0 || day === 6) return false;
  const hour = date.getHours();
  return hour >= 9 && hour < 22;
}

async function fetchSeries(hass, entityId, start, end) {
  if (!entityId) return [];
  const path = `history/period/${start.toISOString()}?filter_entity_id=${entityId}&end_time=${end.toISOString()}&minimal_response`;
  let series;
  try {
    series = await hass.callApi("GET", path);
  } catch (err) {
    return [];
  }
  if (!series || !series[0]) return [];
  return series[0]
    .map((p) => ({
      time: new Date(p.last_changed),
      value: parseFloat(p.state),
    }))
    .filter((p) => !Number.isNaN(p.value))
    .sort((a, b) => a.time - b.time);
}

// Long-term statistics (recorder/statistics_during_period) are retained
// indefinitely at hourly resolution, unlike raw history which is typically
// purged after ~10 days. The "sum" stat already compensates for meter
// resets, so it's the more robust source whenever it's available.
async function fetchStatPoints(hass, entityId, start, end) {
  if (!entityId) return [];
  let result;
  try {
    result = await hass.callWS({
      type: "recorder/statistics_during_period",
      start_time: start.toISOString(),
      end_time: end.toISOString(),
      statistic_ids: [entityId],
      period: "hour",
      types: ["sum"],
    });
  } catch (err) {
    return [];
  }
  const series = (result && result[entityId]) || [];
  return series
    .filter((p) => p.sum != null)
    .map((p) => ({ time: new Date(p.start), value: p.sum }))
    .sort((a, b) => a.time - b.time);
}

// Combines long-term statistics (for everything older than the last
// completed hour, so the cycle/week/month total stays correct even past the
// recorder's raw-history retention window) with short-term history (for the
// most recent, not-yet-aggregated minutes) into one continuous series.
async function fetchCombinedSeries(hass, entityId, start, end) {
  if (!entityId) return [];
  const statPoints = await fetchStatPoints(hass, entityId, start, end);
  const tailStart = statPoints.length ? statPoints[statPoints.length - 1].time : start;
  const tailPoints = await fetchSeries(hass, entityId, tailStart, end);
  return [...statPoints, ...tailPoints].sort((a, b) => a.time - b.time);
}

function totalUsage(points) {
  if (!points.length) return 0;
  const first = points[0].value;
  const last = points[points.length - 1].value;
  if (last < first) {
    // meter likely reset mid-cycle; best effort: count from zero
    return last;
  }
  return last - first;
}

// Splits a single cumulative-energy series into on-peak / off-peak totals by
// classifying each delta between consecutive readings using the timestamp of
// the start of that interval.
function splitUsageByPeak(points) {
  let onPeak = 0;
  let offPeak = 0;
  for (let i = 1; i < points.length; i++) {
    let delta = points[i].value - points[i - 1].value;
    if (delta < 0) delta = points[i].value; // meter reset mid-cycle
    if (isOnPeak(points[i - 1].time)) {
      onPeak += delta;
    } else {
      offPeak += delta;
    }
  }
  return { onPeak, offPeak };
}

// Finds the most recent value in `points` at or before `time` (used to look
// up a self-consumption-rate % sensor at the timestamp of a PV energy delta).
function valueAt(points, time) {
  if (!points.length) return null;
  let result = points[0].value;
  for (const p of points) {
    if (p.time > time) break;
    result = p.value;
  }
  return result;
}

// Computes self-consumed PV energy (PV production that directly offset grid
// import, as opposed to being exported) split by on-peak/off-peak, using
// PV Energy Total deltas weighted by the self-consumption rate (%) sensor
// sampled at the start of each interval.
function splitSelfConsumedByPeak(pvPoints, ratePoints) {
  let onPeak = 0;
  let offPeak = 0;
  for (let i = 1; i < pvPoints.length; i++) {
    let delta = pvPoints[i].value - pvPoints[i - 1].value;
    if (delta < 0) delta = pvPoints[i].value; // meter reset mid-cycle
    const rate = valueAt(ratePoints, pvPoints[i - 1].time);
    const selfConsumed = delta * ((rate == null ? 100 : rate) / 100);
    if (isOnPeak(pvPoints[i - 1].time)) {
      onPeak += selfConsumed;
    } else {
      offPeak += selfConsumed;
    }
  }
  return { onPeak, offPeak };
}

function toArray(v) {
  if (!v) return [];
  return Array.isArray(v) ? v.filter(Boolean) : [v];
}

class MeaElectricBillCard extends HTMLElement {
  static getConfigElement() {
    return document.createElement("mea-electric-bill-card-editor");
  }

  static getStubConfig() {
    return {
      type: "custom:mea-electric-bill-card",
      name: "Electric Bill",
      scheme: "normal",
      tariff_class: "1.2",
      cutoff_day: 1,
      ft_satang: 0,
      vat: VAT_DEFAULT,
      default_period: "cycle",
      entities: {},
    };
  }

  setConfig(config) {
    if (!config) throw new Error("Invalid configuration");
    const scheme = config.scheme || "normal";
    if (scheme !== "normal" && scheme !== "tou") {
      throw new Error('scheme must be "normal" or "tou"');
    }
    const entities = config.entities || {};
    if (!toArray(entities.total).length) {
      throw new Error("entities.total (at least one cumulative energy sensor) is required");
    }
    const cutoffDay = Number(config.cutoff_day || 1);
    if (cutoffDay < 1 || cutoffDay > 31) {
      throw new Error("cutoff_day must be between 1 and 31");
    }
    const defaultPeriod = PERIODS[config.default_period] ? config.default_period : "cycle";
    this._config = {
      name: config.name || "Electric Bill",
      scheme,
      tariff_class: config.tariff_class === "1.1" ? "1.1" : "1.2",
      cutoff_day: cutoffDay,
      ft_satang: Number(config.ft_satang ?? 0),
      vat: Number(config.vat ?? VAT_DEFAULT),
      entities,
      rates: config.rates || {},
    };
    if (!this._period) this._period = defaultPeriod;
    this._lastFetch = 0;
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    const now = Date.now();
    // Refresh usage at most once a minute to avoid hammering the history API.
    if (now - (this._lastFetch || 0) > 60000) {
      this._lastFetch = now;
      this._updateUsage();
    } else {
      this._render();
    }
  }

  getCardSize() {
    return 4;
  }

  _setPeriod(period) {
    if (this._period === period) return;
    this._period = period;
    this._lastFetch = 0;
    this._updateUsage();
  }

  async _updateUsage() {
    if (!this._hass || !this._config) return;
    const cfg = this._config;
    const now = new Date();
    const start = getPeriodStart(this._period || "cycle", cfg.cutoff_day, now);

    const totalEntities = toArray(cfg.entities.total);
    const pointsPerEntity = await Promise.all(
      totalEntities.map((id) => fetchCombinedSeries(this._hass, id, start, now))
    );
    if (cfg.scheme === "normal") {
      this._usage = { units: pointsPerEntity.reduce((sum, pts) => sum + totalUsage(pts), 0) };
    } else {
      this._usage = pointsPerEntity.reduce(
        (acc, pts) => {
          const split = splitUsageByPeak(pts);
          return { onPeak: acc.onPeak + split.onPeak, offPeak: acc.offPeak + split.offPeak };
        },
        { onPeak: 0, offPeak: 0 }
      );
    }

    if (cfg.entities.pv_total) {
      const [pvPoints, ratePoints] = await Promise.all([
        fetchCombinedSeries(this._hass, cfg.entities.pv_total, start, now),
        fetchSeries(this._hass, cfg.entities.pv_self_consumption_rate, start, now),
      ]);
      this._selfConsumed = splitSelfConsumedByPeak(pvPoints, ratePoints);
    } else {
      this._selfConsumed = null;
    }

    this._cycleStart = start;
    this._render();
  }

  _calcBill() {
    const cfg = this._config;
    const vat = cfg.vat;
    const ft = cfg.ft_satang / 100; // satang -> baht per unit
    let units;
    let energyCharge;
    let serviceCharge;
    let savingsEnergy = 0; // baht of energy charge avoided by self-consumed PV
    let selfConsumedUnits = 0;
    const lines = [];

    if (cfg.scheme === "normal") {
      const rateSet =
        (cfg.rates.normal && cfg.rates.normal[cfg.tariff_class]) ||
        DEFAULT_RATES.normal[cfg.tariff_class];
      units = this._usage && this._usage.units != null ? this._usage.units : 0;
      energyCharge = tieredEnergyCharge(units, rateSet.tiers);
      serviceCharge = rateSet.serviceCharge;
      lines.push([`Energy (${units.toFixed(2)} units, tiered)`, energyCharge]);

      if (this._selfConsumed) {
        selfConsumedUnits = this._selfConsumed.onPeak + this._selfConsumed.offPeak;
        // Value the avoided units at their marginal (top-of-stack) rate: the
        // extra cost it would have taken to buy them from the grid on top of
        // what was actually billed.
        savingsEnergy = tieredEnergyCharge(units + selfConsumedUnits, rateSet.tiers) - energyCharge;
      }
    } else {
      const rateSet = cfg.rates.tou || DEFAULT_RATES.tou;
      const onPeak = (this._usage && this._usage.onPeak) || 0;
      const offPeak = (this._usage && this._usage.offPeak) || 0;
      units = onPeak + offPeak;
      const onPeakCharge = onPeak * rateSet.onPeakRate;
      const offPeakCharge = offPeak * rateSet.offPeakRate;
      energyCharge = onPeakCharge + offPeakCharge;
      serviceCharge = rateSet.serviceCharge;
      lines.push([`On-peak (${onPeak.toFixed(2)} units)`, onPeakCharge]);
      lines.push([`Off-peak (${offPeak.toFixed(2)} units)`, offPeakCharge]);

      if (this._selfConsumed) {
        selfConsumedUnits = this._selfConsumed.onPeak + this._selfConsumed.offPeak;
        savingsEnergy =
          this._selfConsumed.onPeak * rateSet.onPeakRate + this._selfConsumed.offPeak * rateSet.offPeakRate;
      }
    }

    const ftCharge = units * ft;
    lines.push(["Service charge", serviceCharge]);
    lines.push(["Ft adjustment", ftCharge]);
    const subtotal = energyCharge + serviceCharge + ftCharge;
    const vatAmount = subtotal * (vat / 100);
    lines.push([`VAT (${vat}%)`, vatAmount]);
    const total = subtotal + vatAmount;

    let savings = null;
    if (this._selfConsumed) {
      const savingsFt = selfConsumedUnits * ft;
      const savingsSubtotal = savingsEnergy + savingsFt;
      const savingsVat = savingsSubtotal * (vat / 100);
      savings = {
        units: selfConsumedUnits,
        total: savingsSubtotal + savingsVat,
      };
    }

    return { units, lines, total, savings };
  }

  _render() {
    if (!this._config) return;
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });

    const bill = this._calcBill();
    const period = this._period || "cycle";
    const cycleLabel = this._cycleStart
      ? `Since ${this._cycleStart.toLocaleDateString()}`
      : "Loading usage…";

    const tabs = Object.entries(PERIODS)
      .map(
        ([key, def]) =>
          `<button class="tab${key === period ? " active" : ""}" data-period="${key}">${def.label}</button>`
      )
      .join("");

    const rows = bill.lines
      .map(
        ([label, value]) =>
          `<tr><td>${label}</td><td class="num">${value.toFixed(2)}</td></tr>`
      )
      .join("");

    const savingsBlock = bill.savings
      ? `<div class="savings">
          <span>☀ Solar self-consumption (${bill.savings.units.toFixed(2)} units)</span>
          <span class="num">-${bill.savings.total.toFixed(2)} ฿</span>
        </div>`
      : "";

    this.shadowRoot.innerHTML = `
      <style>
        ha-card { padding: 16px; }
        .header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 8px; }
        .cycle { font-size: 0.85em; color: var(--secondary-text-color); }
        table { width: 100%; border-collapse: collapse; font-size: 0.95em; }
        td { padding: 4px 0; }
        td.num { text-align: right; }
        .total-row td { font-weight: bold; border-top: 1px solid var(--divider-color); padding-top: 8px; }
        .scheme-badge {
          font-size: 0.75em;
          background: var(--primary-color);
          color: var(--text-primary-color, #fff);
          border-radius: 8px;
          padding: 2px 8px;
        }
        .savings {
          display: flex;
          justify-content: space-between;
          margin-top: 8px;
          padding-top: 8px;
          border-top: 1px dashed var(--divider-color);
          font-size: 0.9em;
          color: var(--success-color, #4caf50);
        }
        .tabs { display: flex; gap: 4px; margin-bottom: 12px; }
        .tab {
          flex: 1;
          padding: 6px 0;
          border: none;
          border-radius: 6px;
          background: var(--secondary-background-color, #eee);
          color: var(--primary-text-color);
          font-size: 0.85em;
          cursor: pointer;
        }
        .tab.active {
          background: var(--primary-color);
          color: var(--text-primary-color, #fff);
        }
      </style>
      <ha-card>
        <div class="header">
          <div>
            <div>${this._config.name}</div>
            <div class="cycle">${cycleLabel}</div>
          </div>
          <span class="scheme-badge">${this._config.scheme === "tou" ? "TOU" : "Normal"}</span>
        </div>
        <div class="tabs">${tabs}</div>
        <table>
          ${rows}
          <tr class="total-row"><td>Estimated total</td><td class="num">${bill.total.toFixed(2)} ฿</td></tr>
        </table>
        ${savingsBlock}
      </ha-card>
    `;

    this.shadowRoot.querySelectorAll(".tab").forEach((btn) => {
      btn.addEventListener("click", () => this._setPeriod(btn.dataset.period));
    });
  }
}

class MeaElectricBillCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = { ...MeaElectricBillCard.getStubConfig(), ...config };
    this._rates = structuredClone(DEFAULT_RATES);
    this._mergeRates(config.rates);
    this._render();
  }

  set hass(hass) {
    // Only re-render on the first hass assignment: hass updates fire
    // continuously (every state change in the system), and rebuilding the
    // form's innerHTML on each one would wipe out in-progress typing/focus.
    const firstHass = !this._hass;
    this._hass = hass;
    if (this._config && firstHass) this._render();
  }

  _mergeRates(rates) {
    if (!rates) return;
    if (rates.normal) {
      for (const cls of Object.keys(rates.normal)) {
        if (!this._rates.normal[cls]) continue;
        Object.assign(this._rates.normal[cls], rates.normal[cls]);
        if (rates.normal[cls].tiers) {
          this._rates.normal[cls].tiers = rates.normal[cls].tiers.map((t) => ({ ...t }));
        }
      }
    }
    if (rates.tou) {
      Object.assign(this._rates.tou, rates.tou);
    }
  }

  _emit() {
    this.dispatchEvent(
      new CustomEvent("config-changed", {
        detail: { config: this._config },
        bubbles: true,
        composed: true,
      })
    );
  }

  _valueChanged(path, value) {
    const cfg = { ...this._config };
    if (path[0] === "entities") {
      cfg.entities = { ...cfg.entities, [path[1]]: value };
    } else {
      cfg[path[0]] = value;
    }
    this._config = cfg;
    this._emit();
    this._render();
  }

  _rateChanged(path, value) {
    let obj = this._rates;
    for (let i = 0; i < path.length - 1; i++) obj = obj[path[i]];
    obj[path[path.length - 1]] = value;
    this._config = { ...this._config, rates: structuredClone(this._rates) };
    this._emit();
    this._render();
  }

  _render() {
    if (!this._config) return;
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    const cfg = this._config;
    const isTou = cfg.scheme === "tou";
    const normalRates = this._rates.normal[cfg.tariff_class];
    const touRates = this._rates.tou;

    const ratesSection = !isTou
      ? `
        <div class="rates-box">
          <div class="rates-title">Energy charge rates (${normalRates.label})</div>
          <div class="two-col">
            <div class="row">
              <label>Service charge (฿/month)</label>
              <input id="normal_service_charge" type="number" step="0.01" value="${normalRates.serviceCharge}" />
            </div>
          </div>
          ${normalRates.tiers
            .map((tier, i) => {
              const prevLimit = i === 0 ? 0 : normalRates.tiers[i - 1].upTo;
              const label = tier.upTo === Infinity ? `Over ${prevLimit} units` : `${prevLimit + 1}-${tier.upTo} units`;
              return `<div class="row tier-row">
                <label>${label} (฿/unit)</label>
                <input class="tier-rate" data-idx="${i}" type="number" step="0.0001" value="${tier.rate}" />
              </div>`;
            })
            .join("")}
        </div>`
      : `
        <div class="rates-box">
          <div class="rates-title">TOU rates</div>
          <div class="two-col">
            <div class="row">
              <label>Service charge (฿/month)</label>
              <input id="tou_service_charge" type="number" step="0.01" value="${touRates.serviceCharge}" />
            </div>
          </div>
          <div class="two-col">
            <div class="row">
              <label>On-peak rate (฿/unit)</label>
              <input id="tou_on_peak_rate" type="number" step="0.0001" value="${touRates.onPeakRate}" />
            </div>
            <div class="row">
              <label>Off-peak rate (฿/unit)</label>
              <input id="tou_off_peak_rate" type="number" step="0.0001" value="${touRates.offPeakRate}" />
            </div>
          </div>
        </div>`;

    this.shadowRoot.innerHTML = `
      <style>
        .row { display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; }
        label { font-size: 0.85em; color: var(--secondary-text-color); }
        input, select { padding: 6px; border-radius: 4px; border: 1px solid var(--divider-color); background: var(--card-background-color); color: var(--primary-text-color); }
        .two-col { display: flex; gap: 12px; }
        .two-col .row { flex: 1; }
        .row.hint { font-size: 0.8em; color: var(--secondary-text-color); margin-top: -4px; }
        .entity-row { display: flex; gap: 6px; margin-bottom: 6px; }
        .entity-row input { flex: 1; }
        .remove-total {
          border: 1px solid var(--divider-color);
          background: var(--card-background-color);
          color: var(--primary-text-color);
          border-radius: 4px;
          cursor: pointer;
          padding: 0 10px;
        }
        .add-total {
          align-self: flex-start;
          border: 1px dashed var(--divider-color);
          background: none;
          color: var(--primary-color);
          border-radius: 4px;
          cursor: pointer;
          padding: 6px 10px;
          margin-bottom: 4px;
        }
        .rates-box { border: 1px solid var(--divider-color); border-radius: 8px; padding: 12px; margin: 8px 0 12px; }
        .rates-title { font-weight: 500; margin-bottom: 8px; }
        .tier-row input { max-width: 140px; }
      </style>
      <div class="row">
        <label>Name</label>
        <input id="name" type="text" value="${cfg.name}" />
      </div>
      <div class="two-col">
        <div class="row">
          <label>Scheme</label>
          <select id="scheme">
            <option value="normal" ${!isTou ? "selected" : ""}>Normal (tiered / bucket rate)</option>
            <option value="tou" ${isTou ? "selected" : ""}>TOU (Time of Use)</option>
          </select>
        </div>
        <div class="row">
          <label>Bill cutoff day (1-31)</label>
          <input id="cutoff_day" type="number" min="1" max="31" value="${cfg.cutoff_day}" />
        </div>
      </div>
      <div class="row">
        <label>Default view</label>
        <select id="default_period">
          ${Object.entries(PERIODS)
            .map(
              ([key, def]) =>
                `<option value="${key}" ${cfg.default_period === key ? "selected" : ""}>${def.label}</option>`
            )
            .join("")}
        </select>
      </div>
      ${
        !isTou
          ? `<div class="row">
              <label>Tariff class</label>
              <select id="tariff_class">
                <option value="1.1" ${cfg.tariff_class === "1.1" ? "selected" : ""}>1.1 - ≤150 units/month</option>
                <option value="1.2" ${cfg.tariff_class === "1.2" ? "selected" : ""}>1.2 - &gt;150 units/month</option>
              </select>
            </div>`
          : ""
      }
      <div class="row">
        <label>Total energy sensor(s) (cumulative kWh)</label>
        ${this._totalEntities()
          .map(
            (id, i) => `
          <div class="entity-row">
            <input class="entity-total" data-idx="${i}" type="text" list="sensor-options" value="${id}" placeholder="sensor.your_grid_energy_total" />
            <button class="remove-total" data-idx="${i}" title="Remove">✕</button>
          </div>`
          )
          .join("")}
        <button class="add-total" type="button">+ Add another sensor</button>
        <div class="row hint">Add more than one if you have multiple grid meters; their usage is summed together.</div>
      </div>
      ${
        isTou
          ? `<div class="row hint">On-peak/off-peak usage is split automatically from this single sensor based on time of day and day of week (Mon-Fri 09:00-22:00 = on-peak).</div>`
          : ""
      }
      <div class="row">
        <label>PV energy total sensor (optional, cumulative kWh)</label>
        <input id="entity_pv_total" type="text" list="sensor-options" value="${cfg.entities.pv_total || ""}" placeholder="sensor.your_pv_energy_total" />
      </div>
      <div class="row">
        <label>PV self consumption rate sensor (optional, %)</label>
        <input id="entity_pv_self_consumption_rate" type="text" list="sensor-options" value="${cfg.entities.pv_self_consumption_rate || ""}" placeholder="sensor.your_pv_self_consumption_rate" />
      </div>
      <datalist id="sensor-options">
        ${this._sensorOptions()}
      </datalist>
      <div class="row hint">If set, the card shows how much these saved you (PV Energy Total × Self Consumption Rate, valued at the on/off-peak time it was generated).</div>
      <div class="two-col">
        <div class="row">
          <label>Ft adjustment (satang/unit)</label>
          <input id="ft_satang" type="number" step="0.01" value="${cfg.ft_satang}" />
        </div>
        <div class="row">
          <label>VAT (%)</label>
          <input id="vat" type="number" step="0.1" value="${cfg.vat}" />
        </div>
      </div>
      ${ratesSection}
    `;

    const $ = (id) => this.shadowRoot.getElementById(id);

    $("name").addEventListener("change", (e) => this._valueChanged(["name"], e.target.value));
    $("scheme").addEventListener("change", (e) => this._valueChanged(["scheme"], e.target.value));
    $("cutoff_day").addEventListener("change", (e) =>
      this._valueChanged(["cutoff_day"], Number(e.target.value))
    );
    $("default_period").addEventListener("change", (e) =>
      this._valueChanged(["default_period"], e.target.value)
    );
    $("ft_satang").addEventListener("change", (e) =>
      this._valueChanged(["ft_satang"], Number(e.target.value))
    );
    $("vat").addEventListener("change", (e) => this._valueChanged(["vat"], Number(e.target.value)));

    if (!isTou) {
      $("tariff_class").addEventListener("change", (e) =>
        this._valueChanged(["tariff_class"], e.target.value)
      );
      $("normal_service_charge").addEventListener("change", (e) =>
        this._rateChanged(["normal", cfg.tariff_class, "serviceCharge"], Number(e.target.value))
      );
      this.shadowRoot.querySelectorAll(".tier-rate").forEach((input) => {
        input.addEventListener("change", (e) =>
          this._rateChanged(
            ["normal", cfg.tariff_class, "tiers", Number(e.target.dataset.idx), "rate"],
            Number(e.target.value)
          )
        );
      });
    } else {
      $("tou_service_charge").addEventListener("change", (e) =>
        this._rateChanged(["tou", "serviceCharge"], Number(e.target.value))
      );
      $("tou_on_peak_rate").addEventListener("change", (e) =>
        this._rateChanged(["tou", "onPeakRate"], Number(e.target.value))
      );
      $("tou_off_peak_rate").addEventListener("change", (e) =>
        this._rateChanged(["tou", "offPeakRate"], Number(e.target.value))
      );
    }
    const entityFields = [
      ["entity_pv_total", "pv_total"],
      ["entity_pv_self_consumption_rate", "pv_self_consumption_rate"],
    ];
    for (const [elemId, key] of entityFields) {
      const field = $(elemId);
      if (!field) continue;
      field.addEventListener("change", (e) => this._valueChanged(["entities", key], e.target.value));
    }

    this.shadowRoot.querySelectorAll(".entity-total").forEach((input) => {
      input.addEventListener("change", (e) => {
        const list = this._totalEntities();
        list[Number(e.target.dataset.idx)] = e.target.value;
        this._setTotalEntities(list);
      });
    });
    this.shadowRoot.querySelectorAll(".remove-total").forEach((btn) => {
      btn.addEventListener("click", () => {
        const list = this._totalEntities();
        list.splice(Number(btn.dataset.idx), 1);
        this._setTotalEntities(list.length ? list : [""]);
      });
    });
    const addBtn = this.shadowRoot.querySelector(".add-total");
    if (addBtn) {
      addBtn.addEventListener("click", () => {
        this._setTotalEntities([...this._totalEntities(), ""]);
      });
    }
  }

  _totalEntities() {
    const list = toArray(this._config.entities.total);
    return list.length ? [...list] : [""];
  }

  _setTotalEntities(list) {
    const cfg = { ...this._config, entities: { ...this._config.entities, total: list } };
    this._config = cfg;
    this._emit();
    this._render();
  }

  _sensorOptions() {
    if (!this._hass) return "";
    return Object.keys(this._hass.states)
      .filter((id) => id.startsWith("sensor."))
      .sort()
      .map((id) => `<option value="${id}"></option>`)
      .join("");
  }
}

customElements.define("mea-electric-bill-card", MeaElectricBillCard);
customElements.define("mea-electric-bill-card-editor", MeaElectricBillCardEditor);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "mea-electric-bill-card",
  name: "MEA Electric Bill Card",
  description:
    "Estimate your MEA (Metropolitan Electricity Authority) electric bill from energy sensors, supporting Normal (tiered) and TOU rate schemes with a custom billing cutoff day.",
});
