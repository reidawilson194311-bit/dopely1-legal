import fs from 'node:fs';
import path from 'node:path';

/**
 * Flat-file store. One JSON file per table under DATA_DIR.
 * Zero accounts required - this is what --dry-run runs against, and it is a
 * perfectly good production store for a single-operator machine.
 */
export function createJsonStore({ dataDir }) {
  const file = (table) => path.join(dataDir, `${table}.json`);

  function readAll(table) {
    const f = file(table);
    if (!fs.existsSync(f)) return [];
    try {
      const parsed = JSON.parse(fs.readFileSync(f, 'utf8'));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function writeAll(table, rows) {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file(table), JSON.stringify(rows, null, 2));
  }

  return {
    driver: 'json',

    async list(table, { where, limit, sort } = {}) {
      let rows = readAll(table);
      if (where) rows = rows.filter(where);
      if (sort) rows = [...rows].sort(sort);
      return limit ? rows.slice(0, limit) : rows;
    },

    async get(table, id) {
      return readAll(table).find((r) => r.id === id) || null;
    },

    /** Insert new rows, update existing ones by `id`. Returns the rows written. */
    async upsert(table, records) {
      const rows = readAll(table);
      const byId = new Map(rows.map((r) => [r.id, r]));
      const written = [];
      for (const rec of records) {
        const existing = byId.get(rec.id);
        if (existing) {
          Object.assign(existing, rec, { updatedAt: new Date().toISOString() });
          written.push(existing);
        } else {
          const row = { ...rec, createdAt: new Date().toISOString() };
          rows.push(row);
          byId.set(row.id, row);
          written.push(row);
        }
      }
      writeAll(table, rows);
      return written;
    },

    async patch(table, id, fields) {
      const rows = readAll(table);
      const row = rows.find((r) => r.id === id);
      if (!row) return null;
      Object.assign(row, fields, { updatedAt: new Date().toISOString() });
      writeAll(table, rows);
      return row;
    },

    async count(table, where) {
      const rows = readAll(table);
      return where ? rows.filter(where).length : rows.length;
    },
  };
}
