#!/usr/bin/env node
/**
 * Build the machine's Airtable base.
 *
 *   node scripts/setup-airtable.js            # add missing tables/fields to AIRTABLE_BASE_ID
 *   node scripts/setup-airtable.js --create   # create a new base in AIRTABLE_WORKSPACE_ID
 *   node scripts/setup-airtable.js --dry-run  # print what it would do, touch nothing
 *
 * Four tables and ~74 fields by hand is a lot of clicking, and one mistyped
 * `id` field breaks the whole pipeline silently - Airtable drops unknown
 * fields on write rather than erroring. So the schema lives in code and this
 * builds it.
 *
 * Idempotent: run it again after changing the schema and it adds what is
 * missing. It never deletes or retypes an existing field - if a field is
 * already there with the wrong type, it says so and leaves it alone, because
 * silently retyping a column with data in it is not a thing a script should do.
 *
 * The token needs `schema.bases:write` (and `schema.bases:read`), plus
 * `workspace.bases:write` for --create. That is a *different* scope set from
 * the data token the machine itself uses - it is fine to use one token with
 * all of them, or to use a throwaway token here and a narrower one in CI.
 */
import { TABLES, diffTable } from './airtable-schema.js';

const API = 'https://api.airtable.com/v0/meta';
const args = new Set(process.argv.slice(2));
const DRY = args.has('--dry-run');
const CREATE = args.has('--create');

const KEY = process.env.AIRTABLE_API_KEY;
const BASE = process.env.AIRTABLE_BASE_ID;
const WORKSPACE = process.env.AIRTABLE_WORKSPACE_ID;

const c = { dim: '\x1b[90m', ok: '\x1b[32m', warn: '\x1b[33m', err: '\x1b[31m', off: '\x1b[0m' };
const say = (msg) => console.log(msg);

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${KEY}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }
  if (!res.ok) {
    const detail = parsed?.error?.message || parsed?.error?.type || text.slice(0, 300);
    throw new Error(`Airtable ${res.status} on ${method} ${path}: ${detail}`);
  }
  return parsed;
}

function fail(message, hint) {
  console.error(`\n${c.err}${message}${c.off}`);
  if (hint) console.error(`  ${hint}`);
  console.error('');
  process.exit(1);
}

async function createBase() {
  if (!WORKSPACE) {
    fail(
      'AIRTABLE_WORKSPACE_ID is required for --create',
      'Open your workspace in Airtable; the URL contains wspXXXXXXXX.',
    );
  }
  say(`Creating a new base in workspace ${WORKSPACE}...`);
  if (DRY) {
    say(`${c.dim}  would create "The Machine" with ${TABLES.length} tables${c.off}`);
    return null;
  }
  const res = await api('/bases', {
    method: 'POST',
    body: { name: 'The Machine', workspaceId: WORKSPACE, tables: TABLES },
  });
  say(`\n${c.ok}Created base ${res.id}${c.off}`);
  say(`\nAdd this as a repository secret:\n  AIRTABLE_BASE_ID = ${res.id}\n`);
  return res.id;
}

async function syncBase() {
  if (!BASE) {
    fail(
      'AIRTABLE_BASE_ID is required',
      'Open the base; its URL contains appXXXXXXXX. Or pass --create to make a new one.',
    );
  }

  const { tables: existing } = await api(`/bases/${BASE}/tables`);
  const byName = new Map(existing.map((t) => [t.name, t]));
  say(`Base ${BASE} has ${existing.length} table(s): ${existing.map((t) => t.name).join(', ') || '(none)'}\n`);

  let created = 0;
  let added = 0;
  let mismatched = 0;

  for (const spec of TABLES) {
    const table = byName.get(spec.name);

    if (!table) {
      say(`${spec.name}: not present, creating with ${spec.fields.length} fields`);
      if (!DRY) await api(`/bases/${BASE}/tables`, { method: 'POST', body: spec });
      created++;
      continue;
    }

    // Never retype a column that already holds data; report and move on.
    const { missing, wrongType, missingChoices } = diffTable(spec, table);

    if (!missing.length && !wrongType.length && !missingChoices.length) {
      say(`${spec.name}: ${c.ok}up to date${c.off} (${table.fields.length} fields)`);
      continue;
    }

    if (missing.length) {
      say(`${spec.name}: adding ${missing.length} field(s): ${missing.map((f) => f.name).join(', ')}`);
      for (const field of missing) {
        if (!DRY) await api(`/bases/${BASE}/tables/${table.id}/fields`, { method: 'POST', body: field });
        added++;
      }
    }
    if (missingChoices.length) {
      // A select silently rejects a value outside its choices, and adding a
      // field never fixes that - without this the base reports "up to date"
      // while every write of the new value still fails.
      //
      // The PATCH must carry the EXISTING choices with their ids alongside the
      // new ones: sending only the additions replaces the list and orphans
      // every row already holding one of the old values.
      say(`${spec.name}: adding ${missingChoices.length} choice(s): ${missingChoices.join(', ')}`);
      const byFieldName = new Map((table.fields || []).map((f) => [f.name, f]));
      for (const field of spec.fields) {
        const want = field.options?.choices?.map((c) => c.name);
        const live = byFieldName.get(field.name);
        if (!want || !live) continue;
        const have = live.options?.choices || [];
        const haveNames = new Set(have.map((c) => c.name));
        const additions = want.filter((n) => !haveNames.has(n)).map((name) => ({ name }));
        if (!additions.length) continue;
        if (!DRY) {
          // `type` must be echoed back. A body of only `options` is read as a
          // type change and rejected with "Changing a field's type ... is not
          // currently supported", which is a confusing way to say "say what
          // the type still is".
          await api(`/bases/${BASE}/tables/${table.id}/fields/${live.id}`, {
            method: 'PATCH',
            body: { type: live.type, options: { choices: [...have, ...additions] } },
          });
        }
        added += additions.length;
      }
    }
    if (wrongType.length) {
      const described = wrongType.map((w) => `${w.name} (want ${w.want}, have ${w.have})`);
      say(`${spec.name}: ${c.warn}type mismatch, left alone${c.off} - ${described.join('; ')}`);
      mismatched += wrongType.length;
    }
  }

  say('');
  say(`${DRY ? 'Would create' : 'Created'} ${created} table(s), ${DRY ? 'would add' : 'added'} ${added} field(s).`);
  if (mismatched) {
    say(`${c.warn}${mismatched} field(s) have a different type than the schema expects.${c.off}`);
    say('  Fix those by hand if the machine misbehaves - this script will not retype a column with data in it.');
  }

  // The primary field is what makes a re-run update rather than duplicate.
  for (const spec of TABLES) {
    const table = byName.get(spec.name);
    if (table && table.fields[0]?.name !== 'id') {
      say(`\n${c.warn}${spec.name}: the primary (first) field is "${table.fields[0]?.name}", not "id".${c.off}`);
      say('  Airtable cannot change which field is primary via the API. Either rename that');
      say('  field to "id" in the UI, or delete the table and re-run this script.');
    }
  }
  say('');
}

async function main() {
  if (!KEY) {
    fail(
      'AIRTABLE_API_KEY is not set',
      'airtable.com -> avatar -> Builder hub -> Personal access tokens. ' +
        'Needs schema.bases:read + schema.bases:write (+ workspace.bases:write for --create).',
    );
  }
  if (DRY) say(`${c.dim}DRY RUN - nothing will be changed${c.off}\n`);
  if (CREATE) await createBase();
  else await syncBase();
}

main().catch((err) => {
  fail(err.message, 'Check the token scopes and that the token has access to this base.');
});
