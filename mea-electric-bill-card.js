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
    if (!entities.total) {
      throw new Error("entities.total (your cumulative energy sensor) is required");
    }
    const cutoffDay = Number(config.cutoff_day || 1);
    if (cutoffDay < 1 || cutoffDay > 31) {
      throw new Error("cutoff_day must be between 1 and 31");
    }
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

  async _updateUsage() {
    if (!this._hass || !this._config) return;
    const cfg = this._config;
    const now = new Date();
    const start = getCycleStart(cfg.cutoff_day, now);

    const points = await fetchSeries(this._hass, cfg.entities.total, start, now);
    if (cfg.scheme === "normal") {
      this._usage = { units: totalUsage(points) };
    } else {
      this._usage = splitUsageByPeak(points);
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
    const lines = [];

    if (cfg.scheme === "normal") {
      const rateSet =
        (cfg.rates.normal && cfg.rates.normal[cfg.tariff_class]) ||
        DEFAULT_RATES.normal[cfg.tariff_class];
      units = this._usage && this._usage.units != null ? this._usage.units : 0;
      energyCharge = tieredEnergyCharge(units, rateSet.tiers);
      serviceCharge = rateSet.serviceCharge;
      lines.push([`Energy (${units.toFixed(2)} units, tiered)`, energyCharge]);
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
    }

    const ftCharge = units * ft;
    lines.push(["Service charge", serviceCharge]);
    lines.push(["Ft adjustment", ftCharge]);
    const subtotal = energyCharge + serviceCharge + ftCharge;
    const vatAmount = subtotal * (vat / 100);
    lines.push([`VAT (${vat}%)`, vatAmount]);
    const total = subtotal + vatAmount;

    return { units, lines, total };
  }

  _render() {
    if (!this._config) return;
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });

    const bill = this._calcBill();
    const cycleLabel = this._cycleStart
      ? `Since ${this._cycleStart.toLocaleDateString()}`
      : "Loading usage…";

    const rows = bill.lines
      .map(
        ([label, value]) =>
          `<tr><td>${label}</td><td class="num">${value.toFixed(2)}</td></tr>`
      )
      .join("");

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
      </style>
      <ha-card>
        <div class="header">
          <div>
            <div>${this._config.name}</div>
            <div class="cycle">${cycleLabel}</div>
          </div>
          <span class="scheme-badge">${this._config.scheme === "tou" ? "TOU" : "Normal"}</span>
        </div>
        <table>
          ${rows}
          <tr class="total-row"><td>Estimated total</td><td class="num">${bill.total.toFixed(2)} ฿</td></tr>
        </table>
      </ha-card>
    `;
  }
}

class MeaElectricBillCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = { ...MeaElectricBillCard.getStubConfig(), ...config };
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (this._config) this._render();
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

  _entityPickerRow(label, key) {
    return `
      <div class="row">
        <label>${label}</label>
        <ha-entity-picker data-key="${key}" .hass=${"hass"} allow-custom-entity></ha-entity-picker>
      </div>
    `;
  }

  _render() {
    if (!this._config) return;
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    const cfg = this._config;
    const isTou = cfg.scheme === "tou";

    this.shadowRoot.innerHTML = `
      <style>
        .row { display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; }
        label { font-size: 0.85em; color: var(--secondary-text-color); }
        input, select { padding: 6px; border-radius: 4px; border: 1px solid var(--divider-color); background: var(--card-background-color); color: var(--primary-text-color); }
        .two-col { display: flex; gap: 12px; }
        .two-col .row { flex: 1; }
        .row.hint { font-size: 0.8em; color: var(--secondary-text-color); margin-top: -4px; }
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
        <label>Total energy sensor (cumulative kWh)</label>
        <ha-entity-picker id="entity_total"></ha-entity-picker>
      </div>
      ${
        isTou
          ? `<div class="row hint">On-peak/off-peak usage is split automatically from this single sensor based on time of day and day of week (Mon-Fri 09:00-22:00 = on-peak).</div>`
          : ""
      }
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
    `;

    const $ = (id) => this.shadowRoot.getElementById(id);

    $("name").addEventListener("change", (e) => this._valueChanged(["name"], e.target.value));
    $("scheme").addEventListener("change", (e) => this._valueChanged(["scheme"], e.target.value));
    $("cutoff_day").addEventListener("change", (e) =>
      this._valueChanged(["cutoff_day"], Number(e.target.value))
    );
    $("ft_satang").addEventListener("change", (e) =>
      this._valueChanged(["ft_satang"], Number(e.target.value))
    );
    $("vat").addEventListener("change", (e) => this._valueChanged(["vat"], Number(e.target.value)));

    if (!isTou) {
      $("tariff_class").addEventListener("change", (e) =>
        this._valueChanged(["tariff_class"], e.target.value)
      );
    }
    const totalPicker = $("entity_total");
    if (totalPicker) {
      totalPicker.hass = this._hass;
      totalPicker.value = cfg.entities.total || "";
      totalPicker.addEventListener("value-changed", (e) =>
        this._valueChanged(["entities", "total"], e.detail.value)
      );
    }
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
