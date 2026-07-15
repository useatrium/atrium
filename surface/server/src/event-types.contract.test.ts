import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createTestPool } from '../test/helpers.js';
import { MESSAGE_STATE_ROW_TYPES, MODIFIER_EVENT_TYPES, REPLY_EVENT_TYPES } from './event-types.js';

let pool: pg.Pool;
let projectMessageEventDefinition: string;
let refoldMessageStateDefinition: string;

beforeAll(async () => {
  pool = await createTestPool();
  projectMessageEventDefinition = await functionDefinition('project_message_event(bigint)');
  refoldMessageStateDefinition = await functionDefinition('refold_message_state(bigint)');
});

afterAll(async () => {
  await pool.end();
});

async function functionDefinition(regprocedure: string): Promise<string> {
  const result = await pool.query<{ definition: string }>('SELECT pg_get_functiondef($1::regprocedure) AS definition', [
    regprocedure,
  ]);
  const definition = result.rows[0]?.definition;
  if (!definition) throw new Error(`No live definition found for ${regprocedure}`);
  return definition;
}

function quotedTypes(contents: string, label: string): Set<string> {
  const literals = [...contents.matchAll(/'((?:''|[^'])*)'/g)].map((match) => match[1]!.replaceAll("''", "'"));
  if (literals.length === 0) throw new Error(`Parsed no quoted event types from ${label}`);

  const unparsed = contents.replaceAll(/'((?:''|[^'])*)'/g, '').replaceAll(/[\s,]/g, '');
  if (unparsed !== '') throw new Error(`Unexpected SQL while parsing ${label}: ${unparsed}`);
  return new Set(literals);
}

function classifierBlocks(definition: string): Set<string>[] {
  const blocks = [...definition.matchAll(/\bIF\s+ev_type\s+IN\s*\(([^)]*)\)/gi)].map((match, index) =>
    quotedTypes(match[1]!, `project_message_event classifier block ${index + 1}`),
  );
  if (blocks.length !== 2) {
    throw new Error(`Expected 2 project_message_event classifier blocks, found ${blocks.length}`);
  }
  return blocks;
}

function cteTypeBlock(definition: string, cteName: string): Set<string> {
  const escapedName = cteName.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`\\b${escapedName}\\s+AS\\s*\\([\\s\\S]*?\\bx\\.type\\s+IN\\s*\\(([^)]*)\\)`, 'i').exec(
    definition,
  );
  if (!match) throw new Error(`Could not find the ${cteName} event-type IN block`);
  return quotedTypes(match[1]!, `refold_message_state ${cteName}`);
}

function expectExactTypes(actual: Set<string>, expected: readonly string[]): void {
  const expectedSet = new Set(expected);
  expect({
    missing: [...expectedSet].filter((type) => !actual.has(type)),
    unexpected: [...actual].filter((type) => !expectedSet.has(type)),
  }).toEqual({ missing: [], unexpected: [] });
}

// These functions are frozen migration snapshots. Extending either side must
// ship a CREATE OR REPLACE migration for the SQL and update the TS families;
// exact live-database equality here prevents either representation drifting.
describe('event-type SQL contract', () => {
  it('pins project_message_event classifiers to the TS families', () => {
    const [modifierTypes, rowTypes] = classifierBlocks(projectMessageEventDefinition);
    expectExactTypes(modifierTypes!, MODIFIER_EVENT_TYPES);
    expectExactTypes(rowTypes!, MESSAGE_STATE_ROW_TYPES);
  });

  it('pins refold_message_state modifiers and replies to the TS families', () => {
    expectExactTypes(cteTypeBlock(refoldMessageStateDefinition, 'direct_modifiers'), MODIFIER_EVENT_TYPES);
    expectExactTypes(cteTypeBlock(refoldMessageStateDefinition, 'reply_modifiers'), MODIFIER_EVENT_TYPES);
    expectExactTypes(cteTypeBlock(refoldMessageStateDefinition, 'replies'), REPLY_EVENT_TYPES);
  });
});
