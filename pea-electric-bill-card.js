/* PEA Electric Bill Card
 * A Lovelace card that estimates a Provincial Electricity Authority (PEA, Thailand)
 * residential electric bill from cumulative energy sensors (e.g. exposed by a battery /
 * energy-monitoring integration), supporting both the "Normal" (tiered/bucket) tariff
 * and the "TOU" (Time of Use) tariff split by voltage level, with a user-configurable
 * billing cycle cutoff day, an optional Ft sensor for auto-updating fuel adjustment,
 * Thai holiday-aware TOU billing, and PEA solar buy-back (export) revenue.
 */

const DEFAULT_RATES = {
  normal: {
    "1.1.1": {
      label: "Type 1.1.1 (≤150 units/month)",
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
    "1.1.2": {
      label: "Type 1.1.2 (>150 units/month)",
      serviceCharge: 24.62,
      tiers: [
        { upTo: 150, rate: 3.2484 },
        { upTo: 400, rate: 4.2218 },
        { upTo: Infinity, rate: 4.4217 },
      ],
    },
  },
  // PEA's TOU tariff (No. 1.2) is split by voltage level, unlike MEA's flat TOU rate.
  // Virtually every residential customer is on 1.2.2 (below 22 kV).
  tou: {
    "1.2.1": {
      label: "1.2.1 - 22-33 kV",
      serviceCharge: 312.24,
      onPeakRate: 5.1135,
      offPeakRate: 2.6037,
    },
    "1.2.2": {
      label: "1.2.2 - below 22 kV",
      serviceCharge: 24.62,
      onPeakRate: 5.7982,
      offPeakRate: 2.6369,
    },
  },
};

const VAT_DEFAULT = 7;
// Current Ft (May-Aug 2569) published at https://www.pea.co.th/our-services/tariff/ft
const FT_DEFAULT = 0.1623;
// PEA "Solar Phak Prachachon" residential rooftop buy-back rate, 2569 round.
const EXPORT_RATE_DEFAULT = 2.2;

// Keyword sets used to classify calendar-sourced holiday events for TOU billing.
// PEA bills two categories of "holiday" as on-peak rather than off-peak (see
// isOnPeak below): the Royal Ploughing Ceremony Day, and compensatory holidays.
const DEFAULT_HOLIDAY_KEYWORDS = {
  ploughing: ["พืชมงคล", "Ploughing"],
  compensatory: ["ชดเชย", "Compensatory"],
};

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

function dateKeyOf(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// PEA residential TOU schedule (Mon-Fri 09:00-22:00 = on-peak) plus PEA's actual
// holiday rules, which are easy to get wrong: most public holidays ARE off-peak,
// but the Royal Ploughing Ceremony Day and compensatory holidays (วันหยุดชดเชย)
// are billed as ordinary on-peak weekdays. `holidays` is a Map of "YYYY-MM-DD" ->
// "ploughing" | "compensatory" | "other", built by fetchHolidays(); pass null/undefined
// to fall back to plain weekday/weekend classification (used when scheme is Normal,
// where the peak split is computed but never billed).
function isOnPeak(date, holidays) {
  const day = date.getDay(); // 0 = Sunday, 6 = Saturday
  const holidayType = holidays ? holidays.get(dateKeyOf(date)) : null;
  const hour = date.getHours();
  const isWeekdayHours = hour >= 9 && hour < 22;

  if (holidayType === "ploughing") {
    // Still a holiday: off-peak if it happens to fall on a weekend, otherwise
    // billed like a normal weekday.
    if (day === 0 || day === 6) return false;
    return isWeekdayHours;
  }
  if (holidayType === "compensatory") {
    // Treated as an ordinary working day regardless of the underlying weekday.
    return isWeekdayHours;
  }
  if (holidayType === "other") return false; // any other public holiday -> off-peak all day

  if (day === 0 || day === 6) return false;
  return isWeekdayHours;
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
    .map((p) => ({ time: new Date(p.start), end: new Date(p.end), value: p.sum }))
    .sort((a, b) => a.time - b.time);
}

// Long-term statistics' "sum" and raw history's "state" are NOT on the same
// numeric scale (the recorder tracks "sum" as an independently accumulated
// growth value, not the raw entity reading), so they must never be spliced
// into a single delta series - mixing them creates one huge fake delta at
// the seam. Instead, fetch each source for its own non-overlapping time
// range and compute usage within each source independently; the two partial
// totals are summed afterward (see totalUsageMulti / splitUsageByPeakMulti).
// Each returned segment is labelled with its source so that two different
// sensors (e.g. PV total and export total, see splitSelfConsumedByExport)
// can be paired stats-with-stats and history-with-history rather than ever
// being compared across the scale boundary.
async function fetchUsageSegments(hass, entityId, start, end) {
  if (!entityId) return [];
  const statPoints = await fetchStatPoints(hass, entityId, start, end);
  const tailStart = statPoints.length ? statPoints[statPoints.length - 1].end : start;
  const tailPoints = await fetchSeries(hass, entityId, tailStart, end);
  const segments = [];
  if (statPoints.length) segments.push({ source: "stats", points: statPoints });
  if (tailPoints.length) segments.push({ source: "history", points: tailPoints });
  return segments;
}

function totalUsageMulti(segments) {
  return segments.reduce((sum, seg) => sum + totalUsage(seg.points), 0);
}

function splitUsageByPeakMulti(segments, holidays) {
  return segments.reduce(
    (acc, seg) => {
      const split = splitUsageByPeak(seg.points, holidays);
      return { onPeak: acc.onPeak + split.onPeak, offPeak: acc.offPeak + split.offPeak };
    },
    { onPeak: 0, offPeak: 0 }
  );
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
function splitUsageByPeak(points, holidays) {
  let onPeak = 0;
  let offPeak = 0;
  for (let i = 1; i < points.length; i++) {
    let delta = points[i].value - points[i - 1].value;
    if (delta < 0) delta = points[i].value; // meter reset mid-cycle
    if (isOnPeak(points[i - 1].time, holidays)) {
      onPeak += delta;
    } else {
      offPeak += delta;
    }
  }
  return { onPeak, offPeak };
}

// Finds the most recent value in `points` at or before `time` (used to look
// up a self-consumption-rate % sensor, or an export-total sensor, at the
// timestamp of a PV energy delta).
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
// sampled at the start of each interval. This is the fallback method for
// inverters that only expose a percentage rather than a cumulative export
// total - see splitSelfConsumedByExport for the preferred method.
function splitSelfConsumedByPeak(pvPoints, ratePoints, holidays) {
  let onPeak = 0;
  let offPeak = 0;
  for (let i = 1; i < pvPoints.length; i++) {
    let delta = pvPoints[i].value - pvPoints[i - 1].value;
    if (delta < 0) delta = pvPoints[i].value; // meter reset mid-cycle
    const rate = valueAt(ratePoints, pvPoints[i - 1].time);
    const selfConsumed = delta * ((rate == null ? 100 : rate) / 100);
    if (isOnPeak(pvPoints[i - 1].time, holidays)) {
      onPeak += selfConsumed;
    } else {
      offPeak += selfConsumed;
    }
  }
  return { onPeak, offPeak };
}

function splitSelfConsumedByPeakMulti(pvSegments, ratePoints, holidays) {
  return pvSegments.reduce(
    (acc, seg) => {
      const split = splitSelfConsumedByPeak(seg.points, ratePoints, holidays);
      return { onPeak: acc.onPeak + split.onPeak, offPeak: acc.offPeak + split.offPeak };
    },
    { onPeak: 0, offPeak: 0 }
  );
}

// Computes self-consumed PV energy directly: PV Energy Total delta minus the
// matching Electricity Sold (export) delta for the same interval, clamped at
// >= 0. This is the preferred method whenever a cumulative export sensor is
// available (e.g. Atmoce's "Electricity Sold Total") - it is a direct
// measurement rather than an interpolated percentage, and (being
// TOTAL_INCREASING/ENERGY) it survives in long-term statistics the way the
// self-consumption-rate % sensor typically does not.
//
// Note: with a battery in the system, PV - export also counts energy that
// went into charging the battery as "self-consumed" at that moment's TOU
// rate, even though it may actually displace grid import later (often at a
// different peak/off-peak rate). The result is therefore an approximation
// for battery systems, not an exact figure.
function splitSelfConsumedByExport(pvPoints, exportPoints, holidays) {
  let onPeak = 0;
  let offPeak = 0;
  for (let i = 1; i < pvPoints.length; i++) {
    let pvDelta = pvPoints[i].value - pvPoints[i - 1].value;
    if (pvDelta < 0) pvDelta = pvPoints[i].value; // meter reset mid-cycle

    const exportStart = valueAt(exportPoints, pvPoints[i - 1].time);
    const exportEnd = valueAt(exportPoints, pvPoints[i].time);
    let exportDelta = exportStart == null || exportEnd == null ? 0 : exportEnd - exportStart;
    if (exportDelta < 0) exportDelta = 0; // meter reset mid-cycle

    // A discharging battery can push export above PV production within a
    // single interval; self-consumed can never be negative.
    const selfConsumed = Math.max(0, pvDelta - exportDelta);
    if (isOnPeak(pvPoints[i - 1].time, holidays)) {
      onPeak += selfConsumed;
    } else {
      offPeak += selfConsumed;
    }
  }
  return { onPeak, offPeak };
}

// Pairs two labelled segment lists (see fetchUsageSegments) by source, so
// that deltas are only ever compared within the same numeric scale (stats
// with stats, history with history). Segments whose source has no match on
// the other side are dropped rather than guessed at.
function pairSegmentsBySource(aSegments, bSegments) {
  const bBySource = new Map(bSegments.map((s) => [s.source, s.points]));
  return aSegments
    .filter((s) => bBySource.has(s.source))
    .map((s) => ({ source: s.source, aPoints: s.points, bPoints: bBySource.get(s.source) }));
}

function splitSelfConsumedByExportMulti(pvSegments, exportSegments, holidays) {
  const paired = pairSegmentsBySource(pvSegments, exportSegments);
  return paired.reduce(
    (acc, { aPoints, bPoints }) => {
      const split = splitSelfConsumedByExport(aPoints, bPoints, holidays);
      return { onPeak: acc.onPeak + split.onPeak, offPeak: acc.offPeak + split.offPeak };
    },
    { onPeak: 0, offPeak: 0 }
  );
}

function toArray(v) {
  if (!v) return [];
  return Array.isArray(v) ? v.filter(Boolean) : [v];
}

// Classifies a holiday calendar event's summary text against configurable
// keyword lists (see DEFAULT_HOLIDAY_KEYWORDS) so isOnPeak() can apply PEA's
// on-peak exceptions for the Royal Ploughing Ceremony and compensatory days.
function classifyHolidayEvent(summary, keywords) {
  const text = summary || "";
  const kw = keywords || DEFAULT_HOLIDAY_KEYWORDS;
  if ((kw.ploughing || []).some((k) => text.includes(k))) return "ploughing";
  if ((kw.compensatory || []).some((k) => text.includes(k))) return "compensatory";
  return "other";
}

// Parses a "YYYY-MM-DD" all-day date string as a LOCAL date. new Date("YYYY-MM-DD")
// parses as UTC midnight, which for Thailand (UTC+7) usually lands on the same
// local day but for locations west of UTC can land a day early - splitting and
// constructing with the (y, m, d) constructor always uses local time and avoids
// that trap entirely.
function parseLocalDateOnly(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d);
}

// Expands a calendar event's start/end into a list of "YYYY-MM-DD" date keys.
// All-day calendar events conventionally use an exclusive end date; guard the
// case where a feed sends an inclusive/same-day end instead.
function expandAllDayRange(startObj, endObj) {
  const dates = [];
  if (!startObj) return dates;
  const startStr = startObj.date || (startObj.dateTime ? startObj.dateTime.slice(0, 10) : null);
  if (!startStr) return dates;
  const endStr = (endObj && (endObj.date || (endObj.dateTime ? endObj.dateTime.slice(0, 10) : null))) || startStr;

  let cur = parseLocalDateOnly(startStr);
  const end = parseLocalDateOnly(endStr);
  if (end <= cur) {
    dates.push(dateKeyOf(cur));
    return dates;
  }
  while (cur < end) {
    dates.push(dateKeyOf(cur));
    cur = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + 1);
  }
  return dates;
}

async function fetchCalendarEvents(hass, entityId, start, end) {
  if (!entityId) return [];
  const path = `calendars/${entityId}?start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(
    end.toISOString()
  )}`;
  let events;
  try {
    events = await hass.callApi("GET", path);
  } catch (err) {
    return [];
  }
  return Array.isArray(events) ? events : [];
}

// Builds the holiday Map consumed by isOnPeak(): static holiday_dates are
// classified as "other" (plain off-peak); calendar events are classified via
// classifyHolidayEvent so the Royal Ploughing Ceremony / compensatory-holiday
// on-peak exceptions apply. Errors degrade to an empty map (today's plain
// weekday/weekend behaviour) rather than breaking the card.
async function fetchHolidays(hass, cfg, start, end) {
  const holidays = new Map();
  for (const d of cfg.holiday_dates || []) {
    if (d) holidays.set(d, "other");
  }
  if (cfg.holiday_calendar) {
    const events = await fetchCalendarEvents(hass, cfg.holiday_calendar, start, end);
    for (const ev of events) {
      const type = classifyHolidayEvent(ev.summary, cfg.holiday_onpeak_keywords);
      for (const d of expandAllDayRange(ev.start, ev.end)) {
        holidays.set(d, type);
      }
    }
  }
  return holidays;
}

class PeaElectricBillCard extends HTMLElement {
  static getConfigElement() {
    return document.createElement("pea-electric-bill-card-editor");
  }

  static getStubConfig() {
    return {
      type: "custom:pea-electric-bill-card",
      name: "Electric Bill",
      scheme: "normal",
      tariff_class: "1.1.2",
      tou_voltage_level: "1.2.2",
      cutoff_day: 1,
      ft_baht: FT_DEFAULT,
      vat: VAT_DEFAULT,
      default_period: "cycle",
      entities: {},
      export_rate: EXPORT_RATE_DEFAULT,
      show_export: false,
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

    // Legacy MEA-fork tariff_class values ("1.1"/"1.2") map onto PEA's naming
    // so an existing dashboard config doesn't break on upgrade.
    let tariffClass = config.tariff_class;
    if (tariffClass === "1.1") tariffClass = "1.1.1";
    if (tariffClass === "1.2") tariffClass = "1.1.2";
    tariffClass = tariffClass === "1.1.1" ? "1.1.1" : "1.1.2";

    const touVoltageLevel = config.tou_voltage_level === "1.2.1" ? "1.2.1" : "1.2.2";

    // ft_baht (baht/unit) is the only supported unit going forward, matching
    // what PEA publishes and what the scrape sensor in the README produces.
    // A config still carrying the old MEA-fork ft_satang key (satang/unit) is
    // converted once here so an old dashboard doesn't silently produce a
    // 100x-wrong Ft charge; nothing writes satang back out.
    const ftBaht =
      config.ft_baht != null
        ? Number(config.ft_baht)
        : config.ft_satang != null
        ? Number(config.ft_satang) / 100
        : FT_DEFAULT;

    this._config = {
      name: config.name || "Electric Bill",
      scheme,
      tariff_class: tariffClass,
      tou_voltage_level: touVoltageLevel,
      cutoff_day: cutoffDay,
      ft_baht: ftBaht,
      ft_entity: config.ft_entity || "",
      vat: Number(config.vat ?? VAT_DEFAULT),
      entities,
      rates: config.rates || {},
      holiday_calendar: config.holiday_calendar || "",
      holiday_dates: Array.isArray(config.holiday_dates) ? config.holiday_dates.filter(Boolean) : [],
      holiday_onpeak_keywords: config.holiday_onpeak_keywords || DEFAULT_HOLIDAY_KEYWORDS,
      export_rate: Number(config.export_rate ?? EXPORT_RATE_DEFAULT),
      show_export: Boolean(config.show_export),
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

    // Holidays only affect TOU billing; skip the calendar/dates fetch entirely
    // for Normal-scheme users.
    const holidays = cfg.scheme === "tou" ? await fetchHolidays(this._hass, cfg, start, now) : null;

    const totalEntities = toArray(cfg.entities.total);
    const segmentsPerEntity = await Promise.all(
      totalEntities.map((id) => fetchUsageSegments(this._hass, id, start, now))
    );
    if (cfg.scheme === "normal") {
      this._usage = {
        units: segmentsPerEntity.reduce((sum, segs) => sum + totalUsageMulti(segs), 0),
      };
    } else {
      this._usage = segmentsPerEntity.reduce(
        (acc, segs) => {
          const split = splitUsageByPeakMulti(segs, holidays);
          return { onPeak: acc.onPeak + split.onPeak, offPeak: acc.offPeak + split.offPeak };
        },
        { onPeak: 0, offPeak: 0 }
      );
    }

    // Export total is fetched once and used for both the self-consumption
    // calc (preferred method, see splitSelfConsumedByExport) and the export
    // revenue line (Phase 6) - it's needed independently of pv_total.
    const exportSegments = cfg.entities.pv_export_total
      ? await fetchUsageSegments(this._hass, cfg.entities.pv_export_total, start, now)
      : null;
    this._exportUnits = exportSegments ? totalUsageMulti(exportSegments) : null;

    if (cfg.entities.pv_total) {
      const pvSegments = await fetchUsageSegments(this._hass, cfg.entities.pv_total, start, now);
      if (exportSegments) {
        this._selfConsumed = splitSelfConsumedByExportMulti(pvSegments, exportSegments, holidays);
      } else {
        const ratePoints = await fetchSeries(this._hass, cfg.entities.pv_self_consumption_rate, start, now);
        this._selfConsumed = splitSelfConsumedByPeakMulti(pvSegments, ratePoints, holidays);
      }
    } else {
      this._selfConsumed = null;
    }

    this._cycleStart = start;
    this._render();
  }

  // Resolves the Ft (fuel adjustment) rate in baht/unit: prefers a live
  // sensor (see README for the `scrape:` setup that reads PEA's published
  // page) when it's present and holds a valid number, otherwise falls back
  // to the manually configured ft_baht.
  _resolveFt() {
    const cfg = this._config;
    if (cfg.ft_entity && this._hass) {
      const state = this._hass.states[cfg.ft_entity];
      if (state && state.state != null) {
        const val = parseFloat(state.state);
        if (!Number.isNaN(val)) return val;
      }
    }
    return cfg.ft_baht;
  }

  _calcBill() {
    const cfg = this._config;
    const vat = cfg.vat;
    const ft = this._resolveFt(); // baht per unit
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
      const rateSet =
        (cfg.rates.tou && cfg.rates.tou[cfg.tou_voltage_level]) || DEFAULT_RATES.tou[cfg.tou_voltage_level];
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
    lines.push([`Ft adjustment (${ft.toFixed(4)} ฿/unit)`, ftCharge]);
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

    // Export (feed-in) revenue: flat-rate, not TOU-split, and NOT subject to
    // VAT - it is income from PEA's buy-back programme, not an avoided cost,
    // and must never be netted into "Estimated total" (which stays exactly
    // what PEA bills you). Only shown when the user has explicitly opted in
    // via show_export, since the buy-back only pays registered participants.
    let exportRevenue = null;
    if (cfg.show_export && this._exportUnits != null) {
      exportRevenue = {
        units: this._exportUnits,
        total: this._exportUnits * cfg.export_rate,
      };
    }
    const netCost = exportRevenue != null ? total - exportRevenue.total : null;

    return { units, lines, total, savings, exportRevenue, netCost };
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

    const exportBlock = bill.exportRevenue
      ? `<div class="export">
          <span>⚡ Exported to grid (${bill.exportRevenue.units.toFixed(2)} units)</span>
          <span class="num">+${bill.exportRevenue.total.toFixed(2)} ฿</span>
        </div>`
      : "";

    const netCostRow =
      bill.netCost != null
        ? `<div class="net-cost">
            <span>Net cost (after export)</span>
            <span class="num">${bill.netCost.toFixed(2)} ฿</span>
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
        .export {
          display: flex;
          justify-content: space-between;
          margin-top: 8px;
          padding-top: 8px;
          border-top: 1px dashed var(--divider-color);
          font-size: 0.9em;
          color: var(--info-color, #2196f3);
        }
        .net-cost {
          display: flex;
          justify-content: space-between;
          margin-top: 8px;
          padding-top: 8px;
          border-top: 1px solid var(--divider-color);
          font-size: 0.95em;
          font-weight: bold;
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
        ${exportBlock}
        ${netCostRow}
      </ha-card>
    `;

    this.shadowRoot.querySelectorAll(".tab").forEach((btn) => {
      btn.addEventListener("click", () => this._setPeriod(btn.dataset.period));
    });
  }
}

class PeaElectricBillCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = { ...PeaElectricBillCard.getStubConfig(), ...config };
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
      for (const level of Object.keys(rates.tou)) {
        if (!this._rates.tou[level]) continue;
        Object.assign(this._rates.tou[level], rates.tou[level]);
      }
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
    const touRates = this._rates.tou[cfg.tou_voltage_level];

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
          <div class="rates-title">TOU rates (${touRates.label})</div>
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
        .row.checkbox-row { flex-direction: row; align-items: center; gap: 8px; }
        .row.checkbox-row label { font-size: 0.9em; color: var(--primary-text-color); }
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
                <option value="1.1.1" ${cfg.tariff_class === "1.1.1" ? "selected" : ""}>1.1.1 - ≤150 units/month</option>
                <option value="1.1.2" ${cfg.tariff_class === "1.1.2" ? "selected" : ""}>1.1.2 - &gt;150 units/month</option>
              </select>
            </div>`
          : `<div class="row">
              <label>TOU voltage level</label>
              <select id="tou_voltage_level">
                <option value="1.2.2" ${cfg.tou_voltage_level === "1.2.2" ? "selected" : ""}>1.2.2 - below 22 kV (most households)</option>
                <option value="1.2.1" ${cfg.tou_voltage_level === "1.2.1" ? "selected" : ""}>1.2.1 - 22-33 kV</option>
              </select>
            </div>`
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
          ? `<div class="row hint">On-peak/off-peak usage is split automatically from this single sensor based on time of day and day of week (Mon-Fri 09:00-22:00 = on-peak). Set a holiday calendar below for accurate off-peak billing on Thai public holidays.</div>`
          : ""
      }
      ${
        isTou
          ? `<div class="row">
              <label>Holiday calendar (optional, calendar.* entity)</label>
              <input id="holiday_calendar" type="text" list="calendar-options" value="${cfg.holiday_calendar || ""}" placeholder="calendar.thailand_holidays" />
            </div>
            <div class="row">
              <label>Extra off-peak dates (optional, comma-separated YYYY-MM-DD)</label>
              <input id="holiday_dates" type="text" value="${(cfg.holiday_dates || []).join(", ")}" placeholder="2026-04-13, 2026-04-14" />
            </div>`
          : ""
      }
      <div class="row">
        <label>PV energy total sensor (optional, cumulative kWh)</label>
        <input id="entity_pv_total" type="text" list="sensor-options" value="${cfg.entities.pv_total || ""}" placeholder="sensor.your_pv_energy_total" />
      </div>
      <div class="row">
        <label>PV export/sold sensor (optional, cumulative kWh - preferred over the % rate below)</label>
        <input id="entity_pv_export_total" type="text" list="sensor-options" value="${cfg.entities.pv_export_total || ""}" placeholder="sensor.your_electricity_sold_total" />
      </div>
      <div class="row">
        <label>PV self consumption rate sensor (optional, %, fallback if no export sensor is set)</label>
        <input id="entity_pv_self_consumption_rate" type="text" list="sensor-options" value="${cfg.entities.pv_self_consumption_rate || ""}" placeholder="sensor.your_pv_self_consumption_rate" />
      </div>
      <datalist id="sensor-options">
        ${this._sensorOptions()}
      </datalist>
      <datalist id="calendar-options">
        ${this._calendarOptions()}
      </datalist>
      <div class="row hint">If a PV sensor is set, the card shows how much self-consumed solar saved you, valued at the on/off-peak time it was generated.</div>
      ${
        cfg.entities.pv_export_total
          ? `<div class="two-col">
              <div class="row">
                <label>Export buy-back rate (฿/unit)</label>
                <input id="export_rate" type="number" step="0.01" value="${cfg.export_rate}" />
              </div>
              <div class="row checkbox-row">
                <input id="show_export" type="checkbox" ${cfg.show_export ? "checked" : ""} />
                <label for="show_export">Show export revenue</label>
              </div>
            </div>
            <div class="row hint">Only enable this if you are registered in PEA's solar buy-back programme with an approved export meter - otherwise this shows income you don't actually receive.</div>`
          : ""
      }
      <div class="two-col">
        <div class="row">
          <label>Ft adjustment (฿/unit)</label>
          <input id="ft_baht" type="number" step="0.0001" value="${cfg.ft_baht}" />
        </div>
        <div class="row">
          <label>VAT (%)</label>
          <input id="vat" type="number" step="0.1" value="${cfg.vat}" />
        </div>
      </div>
      <div class="row">
        <label>Ft sensor (optional, ฿/unit - overrides the manual value above when available)</label>
        <input id="entity_ft" type="text" list="sensor-options" value="${cfg.ft_entity || ""}" placeholder="sensor.pea_ft_rate" />
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
    $("ft_baht").addEventListener("change", (e) =>
      this._valueChanged(["ft_baht"], Number(e.target.value))
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
      $("tou_voltage_level").addEventListener("change", (e) =>
        this._valueChanged(["tou_voltage_level"], e.target.value)
      );
      $("tou_service_charge").addEventListener("change", (e) =>
        this._rateChanged(["tou", cfg.tou_voltage_level, "serviceCharge"], Number(e.target.value))
      );
      $("tou_on_peak_rate").addEventListener("change", (e) =>
        this._rateChanged(["tou", cfg.tou_voltage_level, "onPeakRate"], Number(e.target.value))
      );
      $("tou_off_peak_rate").addEventListener("change", (e) =>
        this._rateChanged(["tou", cfg.tou_voltage_level, "offPeakRate"], Number(e.target.value))
      );
      const holidayCalField = $("holiday_calendar");
      if (holidayCalField) {
        holidayCalField.addEventListener("change", (e) =>
          this._valueChanged(["holiday_calendar"], e.target.value)
        );
      }
      const holidayDatesField = $("holiday_dates");
      if (holidayDatesField) {
        holidayDatesField.addEventListener("change", (e) => {
          const list = e.target.value
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
          this._valueChanged(["holiday_dates"], list);
        });
      }
    }

    const entityFT = $("entity_ft");
    if (entityFT) {
      entityFT.addEventListener("change", (e) => this._valueChanged(["ft_entity"], e.target.value));
    }
    const exportRateField = $("export_rate");
    if (exportRateField) {
      exportRateField.addEventListener("change", (e) =>
        this._valueChanged(["export_rate"], Number(e.target.value))
      );
    }
    const showExportField = $("show_export");
    if (showExportField) {
      showExportField.addEventListener("change", (e) => this._valueChanged(["show_export"], e.target.checked));
    }

    const entityFields = [
      ["entity_pv_total", "pv_total"],
      ["entity_pv_export_total", "pv_export_total"],
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

  _calendarOptions() {
    if (!this._hass) return "";
    return Object.keys(this._hass.states)
      .filter((id) => id.startsWith("calendar."))
      .sort()
      .map((id) => `<option value="${id}"></option>`)
      .join("");
  }
}

customElements.define("pea-electric-bill-card", PeaElectricBillCard);
customElements.define("pea-electric-bill-card-editor", PeaElectricBillCardEditor);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "pea-electric-bill-card",
  name: "PEA Electric Bill Card",
  description:
    "Estimate your PEA (Provincial Electricity Authority) electric bill from energy sensors, supporting Normal (tiered) and TOU (voltage-level-split) rate schemes, a custom billing cutoff day, an auto-updating Ft sensor, Thai holiday-aware TOU billing, and solar export revenue.",
});
