import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

process.env.TZ = "Asia/Bangkok";

const now = Date.parse("2026-11-25T04:35:00Z");
const hour = 60 * 60 * 1000;
const gridImport = "sensor.grid_import";
const gridExport = "sensor.grid_export";
const pvTotal = "sensor.pv_total";
const pvSelfConsumption = "sensor.pv_self_consumption";

class FixedDate extends Date {
  constructor(...args) {
    super(...(args.length ? args : [now]));
  }

  static now() {
    return now;
  }
}

class Element {
  attachShadow() {
    const fields = new Map();
    this.shadowRoot = {
      querySelectorAll: () => [],
      querySelector: () => null,
      getElementById(id) {
        if (!this.innerHTML.includes(`id="${id}"`)) return null;
        if (!fields.has(id)) {
          fields.set(id, {
            reportValidity: () => true,
            addEventListener(type, listener) { this[type] = listener; },
          });
        }
        return fields.get(id);
      },
    };
  }

  dispatchEvent(event) {
    this.event = event;
  }
}

const components = new Map();
runInNewContext(readFileSync(new URL("../mea-electric-bill-card.js", import.meta.url), "utf8"), {
  Date: FixedDate,
  HTMLElement: Element,
  CustomEvent: class {
    constructor(type, options) { this.type = type; this.detail = options.detail; }
  },
  customElements: { define: (name, component) => components.set(name, component) },
  structuredClone,
  window: {},
});

const Card = components.get("mea-electric-bill-card");
const Editor = components.get("mea-electric-bill-card-editor");

function history(...values) {
  return [values.map((value, index) => ({
    state: String(value),
    last_changed: new Date(now - (values.length - index) * 60_000).toISOString(),
  }))];
}

function recorder({ statistics = () => [], histories = {} } = {}) {
  const requests = [];
  const historyRequests = [];
  return {
    requests,
    historyRequests,
    async callWS(request) {
      requests.push(request);
      const [entity] = request.statistic_ids;
      return { [entity]: statistics(entity, request) };
    },
    async callApi(_method, path) {
      const url = new URL(path, "http://hass.local/");
      const entity = url.searchParams.get("filter_entity_id");
      historyRequests.push({ entity, start: url.pathname.split("/").at(-1) });
      return histories[entity] ?? [];
    },
  };
}

function createCard(hass, { entities = {}, ...options } = {}) {
  const card = new Card();
  card.setConfig({ ...options, entities: { total: gridImport, ...entities } });
  card.hass = hass;
  return card;
}

for (const scheme of ["normal", "tou"]) {
  test(`grid export combines hourly changes and raw history with the ${scheme} tariff`, async () => {
    const hass = recorder({
      statistics(entity, { start_time }) {
        if (entity !== gridExport) return [];
        const start = Date.parse(start_time);
        return [
          { start, end: start + hour, change: 3 },
          { start: start + hour, end: start + 2 * hour, change: 1 },
          { start: now - 60_000, end: now + hour, change: 100 },
        ];
      },
      histories: {
        [gridImport]: history(100, 112),
        [gridExport]: history(20, 23, "unavailable", 0, 5),
        [pvTotal]: history(20, 30),
        [pvSelfConsumption]: history(50),
      },
    });
    const solar = { pv_total: pvTotal, pv_self_consumption_rate: pvSelfConsumption };
    const legacy = createCard(hass, { scheme, entities: solar });
    await setImmediate();
    assert.equal(hass.requests.some(({ statistic_ids }) => statistic_ids.includes(gridExport)), false);
    assert.doesNotMatch(legacy.shadowRoot.innerHTML, /Estimated export revenue/);

    const card = createCard(hass, { scheme, entities: { ...solar, export: gridExport } });
    await setImmediate();
    assert.match(card.shadowRoot.innerHTML, /Estimated export revenue \(12\.00 kWh\)/);
    assert.match(card.shadowRoot.innerHTML, /26\.40 ฿/);
    assert.equal(card._calcBill().units, 12);
    assert.equal(card._calcBill().total, legacy._calcBill().total);
    assert.equal(card._calcBill().savings.units, 5);
    assert.equal(card._calcBill().savings.total, legacy._calcBill().savings.total);
    const request = hass.requests.find(({ statistic_ids }) => statistic_ids.includes(gridExport));
    assert.equal(request.types[0], "change");
    assert.equal(hass.historyRequests.find(({ entity }) => entity === gridExport).start,
      new Date(Date.parse(request.start_time) + 2 * hour).toISOString());
  });
}

test("export follows each selected period and applies the configured rate to raw history", async () => {
  const hass = recorder({ histories: { [gridExport]: history(30, 41) } });
  const card = createCard(hass, { cutoff_day: 5, export_rate: 1.75, entities: { export: gridExport } });

  for (const [period, start] of [
    ["cycle", "2026-11-04T17:00:00.000Z"],
    ["day", "2026-11-24T17:00:00.000Z"],
    ["week", "2026-11-22T17:00:00.000Z"],
    ["month", "2026-10-31T17:00:00.000Z"],
  ]) {
    card._setPeriod(period);
    await setImmediate();
    assert.match(card.shadowRoot.innerHTML, /Estimated export revenue \(11\.00 kWh\)/);
    assert.match(card.shadowRoot.innerHTML, /19\.25 ฿/);
    for (const entity of [gridImport, gridExport]) {
      assert.equal(hass.requests.findLast(({ statistic_ids }) => statistic_ids.includes(entity)).start_time, start);
      assert.equal(hass.historyRequests.findLast((request) => request.entity === entity).start, start);
    }
  }
});

test("the card distinguishes missing export data from zero revenue", async () => {
  const options = { export_rate: 0, entities: { export: gridExport } };
  const missing = createCard(recorder(), options);
  const zero = createCard(recorder({ histories: { [gridExport]: history(10, 15) } }), options);
  await setImmediate();
  assert.match(missing.shadowRoot.innerHTML, /No export data/);
  assert.match(zero.shadowRoot.innerHTML, /Estimated export revenue \(5\.00 kWh\)/);
  assert.match(zero.shadowRoot.innerHTML, /0\.00 ฿/);
  assert.throws(() => createCard(recorder(), { ...options, export_rate: -1 }), /export_rate/);
  assert.throws(() => createCard(recorder(), { ...options, export_rate: "invalid" }), /export_rate/);
});

test("a late response from the old period cannot replace the new export estimate", async () => {
  const hass = recorder({ histories: { [gridExport]: history(10, 15) } });
  const oldResponse = Promise.withResolvers();
  const callApi = hass.callApi.bind(hass);
  hass.callApi = (method, path) => path.includes(gridExport) && path.includes("2026-10-31")
    ? oldResponse.promise
    : callApi(method, path);

  const card = createCard(hass, { entities: { export: gridExport } });
  await setImmediate();
  card._setPeriod("day");
  await setImmediate();
  assert.match(card.shadowRoot.innerHTML, /Estimated export revenue \(5\.00 kWh\)/);

  oldResponse.resolve(history(10, 80));
  await setImmediate();
  assert.match(card.shadowRoot.innerHTML, /Estimated export revenue \(5\.00 kWh\)/);
});

test("the visual editor saves the optional sensor and its rate", () => {
  const editor = new Editor();
  editor.setConfig({ entities: { total: gridImport } });
  const field = (id) => editor.shadowRoot.getElementById(id);
  assert.equal(field("export_rate"), null);

  field("entity_export").change({ target: { value: gridExport } });
  assert.equal(editor.event.type, "config-changed");
  assert.equal(editor.event.detail.config.entities.export, gridExport);
  assert.equal(editor.event.detail.config.entities.total, gridImport);

  const rate = field("export_rate");
  assert.equal(rate.value, 2.20);
  rate.change({ target: { value: "1.75", valueAsNumber: 1.75, reportValidity: () => true } });
  assert.equal(editor.event.detail.config.export_rate, 1.75);
  rate.change({ target: { value: "", reportValidity: () => true } });
  assert.equal(editor.event.detail.config.export_rate, 2.20);

  field("entity_export").change({ target: { value: "" } });
  assert.equal(editor.event.detail.config.entities.export, "");
  assert.equal(field("export_rate"), null);
});
