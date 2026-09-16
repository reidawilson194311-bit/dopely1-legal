import { request } from '../http.js';
import { logger } from '../log.js';

const log = logger('airtable');
const API = 'https://api.airtable.com/v0';

/**
 * Airtable-backed store. Every table carries our own `ID` text field so ids
 * survive independently of Airtable's record ids, which is what lets a run
 * resume after a failure without duplicating rows.
 *
 * Field names are the JSON keys title-cased on write and lower-cased back on
 * read, so the code speaks camelCase and the base stays human-readable.
 */
export function createAirtableStore({ apiKey, baseId, tables }) {
  if (!apiKey) throw new Error('AIRTABLE_API_KEY is required for STORE_DRIVER=airtable');
  if (!baseId) throw new Error('AIRTABLE_BASE_ID is required for STORE_DRIVER=airtable');

  const headers = { authorization: `Bearer ${apiKey}` };
  const tableName = (t) => tables[t] || t;
  const url = (t, suffix = '') =>
    `${API}/${baseId}/${encodeURIComponent(tableName(t))}${suffix}`;

  /** Airtable rejects unknown fields, and stores objects/arrays as text. */
  const encode = (fields) => {
    const out = {};
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined || v === null) continue;
      out[k] = typeof v === 'object' ? JSON.stringify(v) : v;
    }
    return out;
  };

  const decode = (record) => {
    const out = { _recordId: record.id };
    for (const [k, v] of Object.entries(record.fields || {})) {
      if (typeof v === 'string' && (v.startsWith('{') || v.startsWith('['))) {
        try {
          out[k] = JSON.parse(v);
          continue;
        } catch {
          /* plain string that happens to start with a brace */
        }
      }
      out[k] = v;
    }
    return out;
  };

  async function fetchPage(table, params) {
    const qs = new URLSearchParams(params).toString();
    return request(url(table, qs ? `?${qs}` : ''), { headers });
  }

  async function findByIds(table, ids) {
    if (!ids.length) return new Map();
    const formula = `OR(${ids.map((i) => `{id}='${String(i).replace(/'/g, "\\'")}'`).join(',')})`;
    const res = await fetchPage(table, { filterByFormula: formula, pageSize: '100' });
    return new Map((res.records || []).map((r) => [r.fields.id, r.id]));
  }

  return {
    driver: 'airtable',

    async list(table, { where, limit, sort, formula, view } = {}) {
      const rows = [];
      let offset;
      do {
        const params = { pageSize: '100' };
        if (formula) params.filterByFormula = formula;
        if (view) params.view = view;
        if (offset) params.offset = offset;
        const res = await fetchPage(table, params);
        rows.push(...(res.records || []).map(decode));
        offset = res.offset;
        if (limit && !where && rows.length >= limit) break;
      } while (offset);

      let out = where ? rows.filter(where) : rows;
      if (sort) out = [...out].sort(sort);
      return limit ? out.slice(0, limit) : out;
    },

    async get(table, id) {
      const [row] = await this.list(table, {
        formula: `{id}='${String(id).replace(/'/g, "\\'")}'`,
        limit: 1,
      });
      return row || null;
    },

    async upsert(table, records) {
      if (!records.length) return [];
      const existing = await findByIds(table, records.map((r) => r.id));
      const creates = [];
      const updates = [];
      for (const rec of records) {
        const recordId = existing.get(rec.id);
        if (recordId) updates.push({ id: recordId, fields: encode(rec) });
        else creates.push({ fields: encode(rec) });
      }

      const written = [];
      for (const [method, batchSource] of [['PATCH', updates], ['POST', creates]]) {
        for (let i = 0; i < batchSource.length; i += 10) {
          const batch = batchSource.slice(i, i + 10);
          const res = await request(url(table), {
            method,
            headers: { ...headers, 'content-type': 'application/json' },
            body: JSON.stringify({ records: batch, typecast: true }),
          });
          written.push(...(res.records || []).map(decode));
        }
      }
      log.debug(`upsert ${tableName(table)}`, { created: creates.length, updated: updates.length });
      return written;
    },

    async patch(table, id, fields) {
      const row = await this.get(table, id);
      if (!row) return null;
      const res = await request(url(table), {
        method: 'PATCH',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({
          records: [{ id: row._recordId, fields: encode(fields) }],
          typecast: true,
        }),
      });
      return decode(res.records[0]);
    },

    async count(table, where) {
      return (await this.list(table, { where })).length;
    },
  };
}
