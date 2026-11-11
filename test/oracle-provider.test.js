'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { QueryBuilder, Transaction, isTransactionalProvider } = require('@romatech/orm');
const { OracleProvider } = require('../dist');

/**
 * Provider whose oracledb connection is replaced by a stub. `tables` maps an
 * exact table name to its columns ({ name, type, pk }); `select` ({ rows,
 * metaData }) answers `SELECT * FROM` statements. Every statement is recorded
 * with its `autoCommit` option; commit/rollback calls are recorded in `events`.
 */
function stubProvider(tables, select = { rows: [], metaData: [] }) {
  const statements = [];
  const events = [];
  const provider = new OracleProvider({ connectString: 'unused' });
  provider.connection = {
    async execute(sql, params, options = {}) {
      statements.push({ sql, params, autoCommit: options.autoCommit });
      if (/^SELECT \* FROM/.test(sql)) return { rows: select.rows.map(row => ({ ...row })), metaData: select.metaData };
      const table = tables[params?.[0]] ?? [];
      if (/COUNT\(\*\)/.test(sql)) return { rows: [{ found: table.length }] };
      if (/FROM user_tab_columns/.test(sql)) return { rows: table.map(c => ({ name: c.name, type: c.type })) };
      if (/FROM user_constraints/.test(sql)) return { rows: table.filter(c => c.pk).map(c => ({ name: c.name })) };
      return { rows: [] };
    },
    async commit() { events.push('commit'); },
    async rollback() { events.push('rollback'); },
    async close() { events.push('close'); }
  };
  return { provider, statements, events };
}

const dml = statements => statements.filter(s => /^(INSERT|UPDATE|DELETE)/.test(s.sql.trim()));

test('introspects a quoted lower-case table by its exact name', async () => {
  const { provider } = stubProvider({ users: [{ name: 'id', type: 'NUMBER', pk: true }, { name: 'name', type: 'CLOB' }] });
  const columns = await provider.getColumnsForTable('users');
  assert.deepEqual(columns.map(c => [c.name, c.primaryKey]), [['id', true], ['name', false]]);
});

test('falls back to the upper-case name for tables created unquoted', async () => {
  const { provider } = stubProvider({ USERS: [{ name: 'ID', type: 'NUMBER', pk: true }] });
  const columns = await provider.getColumnsForTable('users');
  assert.deepEqual(columns.map(c => c.name), ['ID']);
});

test('primary keys come from the current schema only (user_constraints)', async () => {
  const { provider, statements } = stubProvider({ users: [{ name: 'id', type: 'NUMBER', pk: true }] });
  await provider.getColumnsForTable('users');
  assert.ok(statements.some(s => /FROM user_constraints/.test(s.sql)));
  assert.ok(statements.every(s => !/all_constraints|all_cons_columns/.test(s.sql)));
});

const tables = {
  lines: [{ name: 'orderId', type: 'NUMBER', pk: true }, { name: 'lineNo', type: 'NUMBER', pk: true }],
  items: [{ name: 'id', type: 'NUMBER', pk: true }, { name: 'name', type: 'CLOB' }]
};

describe('primary key handling', () => {
  for (const method of ['update', 'remove', 'find']) {
    test(`${method}() refuses a composite primary key`, async () => {
      const { provider, statements } = stubProvider(tables);
      await assert.rejects(() => provider[method]({ orderId: 1, lineNo: 1 }, 'lines'), /composite primary key/);
      assert.ok(statements.every(s => /user_/.test(s.sql)), 'no DML must be sent');
    });
  }

  test('update() with only undefined values besides the key sends nothing', async () => {
    const { provider, statements } = stubProvider(tables);
    await provider.update({ id: 1, name: undefined }, 'items');
    assert.ok(statements.every(s => !s.sql.startsWith('UPDATE')));
  });

  test('the primary key is introspected once per table, not on every operation', async () => {
    const { provider, statements } = stubProvider(tables);
    await provider.update({ id: 1, name: 'a' }, 'items');
    await provider.remove({ id: 1 }, 'items');
    await provider.find({ id: 1 }, 'items');
    assert.equal(statements.filter(s => /FROM user_constraints/.test(s.sql)).length, 1);
  });

  test('DDL and raw non-SELECT statements invalidate the cached key', async () => {
    const { provider, statements } = stubProvider(tables);
    const lookups = () => statements.filter(s => /FROM user_constraints/.test(s.sql)).length;
    await provider.remove({ id: 1 }, 'items');
    await provider.executeQuery('SELECT 1 FROM dual', []);
    await provider.remove({ id: 1 }, 'items');
    assert.equal(lookups(), 1);
    await provider.addColumn('items', { name: 'x', tsType: 'string' });
    await provider.remove({ id: 1 }, 'items');
    assert.equal(lookups(), 2);
    await provider.executeNonQuery('ALTER TABLE "items" DROP PRIMARY KEY');
    await provider.remove({ id: 1 }, 'items');
    assert.equal(lookups(), 3);
  });
});

describe('commits and transactions', () => {
  test('the provider is an ITransactionalProvider', () => {
    const { provider } = stubProvider(tables);
    assert.equal(isTransactionalProvider(provider), true);
  });

  test('outside a transaction every statement auto-commits, raw executeQuery DML included', async () => {
    const { provider, statements } = stubProvider(tables);
    await provider.add({ id: 1, name: 'a' }, 'items');
    await provider.executeQuery('DELETE FROM "items" WHERE "id" = :1', [1]);
    await provider.executeNonQuery('UPDATE "items" SET "name" = :1', ['b']);
    assert.deepEqual(dml(statements).map(s => s.autoCommit), [true, true, true]);
  });

  test('inside a transaction nothing auto-commits until commitTransaction()', async () => {
    const { provider, statements, events } = stubProvider(tables);
    await provider.beginTransaction();
    await provider.add({ id: 1, name: 'a' }, 'items');
    await provider.update({ id: 1, name: 'b' }, 'items');
    await provider.executeQuery('DELETE FROM "items" WHERE "id" = :1', [2]);
    assert.deepEqual(dml(statements).map(s => s.autoCommit), [false, false, false]);
    assert.deepEqual(events, []);
    await provider.commitTransaction();
    assert.deepEqual(events, ['commit']);
    await provider.add({ id: 3, name: 'c' }, 'items');
    assert.equal(dml(statements).at(-1).autoCommit, true);
  });

  test('rollback; nested begin rejected; rollback without a transaction is a no-op', async () => {
    const { provider, events } = stubProvider(tables);
    await provider.beginTransaction();
    await assert.rejects(() => provider.beginTransaction(), /already active/);
    await provider.rollbackTransaction();
    await provider.rollbackTransaction();
    assert.deepEqual(events, ['rollback']);
    await assert.rejects(() => provider.commitTransaction(), /No active transaction/);
  });

  test('raw COMMIT/ROLLBACK (what @romatech/orm 2.0.0 Transaction sends) are routed to the transaction', async () => {
    const { provider, statements, events } = stubProvider(tables);
    await provider.beginTransaction();
    await new Transaction(provider).commit();
    await provider.beginTransaction();
    await new Transaction(provider).rollback();
    assert.deepEqual(events, ['commit', 'rollback']);
    assert.ok(statements.every(s => !/^(COMMIT|ROLLBACK)/.test(s.sql)));
  });

  test('DDL is refused inside a transaction (Oracle would commit it implicitly)', async () => {
    const { provider, statements } = stubProvider(tables);
    await provider.beginTransaction();
    await assert.rejects(() => provider.createTable({ tableName: 't', columns: [{ name: 'id', tsType: 'number', primaryKey: true }] }), /inside a transaction/);
    await assert.rejects(() => provider.dropTable('t'), /inside a transaction/);
    assert.ok(statements.every(s => !/CREATE|DROP/.test(s.sql)));
  });

  test('disconnect() rolls back an open transaction', async () => {
    const { provider, events } = stubProvider(tables);
    await provider.beginTransaction();
    await provider.disconnect();
    assert.deepEqual(events, ['rollback', 'close']);
  });
});

test('NUMBER(1) columns match boolean predicates; the driver rows are returned', async () => {
  const metaData = [
    { name: 'id', dbTypeName: 'NUMBER', precision: 10, scale: 0 },
    { name: 'active', dbTypeName: 'NUMBER', precision: 1, scale: 0 },
    { name: 'born', dbTypeName: 'TIMESTAMP', precision: 6 }
  ];
  const rows = [{ id: 1, active: 1, born: new Date(2024, 0, 2) }, { id: 2, active: 0, born: new Date(2023, 0, 1) }];
  const { provider } = stubProvider(tables, { rows, metaData });
  const query = () => new QueryBuilder(class Item {}, provider, 'items');
  const active = await query().where(x => x.active === true).toList();
  assert.deepEqual(active, [{ id: 1, active: 1, born: rows[0].born }]);
  assert.deepEqual((await query().where(x => x.born >= '2024-01-01').toList()).map(r => r.id), [1, 2], 'left to Oracle');
});

// ─── Integration (ORACLE_TEST_CONNECT=host:port/service, ORACLE_TEST_USER, ORACLE_TEST_PASSWORD) ─

const connectString = process.env.ORACLE_TEST_CONNECT;

describe('integration with a real Oracle Database', { skip: !connectString && 'set ORACLE_TEST_CONNECT to run' }, () => {
  const config = { connectString, user: process.env.ORACLE_TEST_USER, password: process.env.ORACLE_TEST_PASSWORD };

  test('transactions, raw DML commits, composite keys and booleans', async () => {
    const provider = new OracleProvider(config);
    const observer = new OracleProvider(config);
    await provider.connect();
    await observer.connect();
    const count = async () => (await observer.getAll('roma_items')).length;
    try {
      await provider.dropTable('roma_items');
      await provider.dropTable('roma_lines');
      await provider.createTable({ tableName: 'roma_items', columns: [{ name: 'id', tsType: 'number', primaryKey: true }, { name: 'active', tsType: 'boolean' }] });
      await provider.executeQuery('CREATE TABLE "roma_lines" ("orderId" NUMBER, "lineNo" NUMBER, PRIMARY KEY ("orderId", "lineNo"))', []);

      // Raw executeQuery DML is committed (visible to another session).
      await provider.executeQuery('INSERT INTO "roma_items" ("id", "active") VALUES (:1, :2)', [1, 1]);
      assert.equal(await count(), 1);

      // Rolled back: invisible; committed: visible.
      await provider.beginTransaction();
      await provider.add({ id: 2, active: 0 }, 'roma_items');
      assert.equal(await count(), 1, 'uncommitted rows are not visible to other sessions');
      await provider.rollbackTransaction();
      assert.equal(await count(), 1);
      await provider.beginTransaction();
      await provider.add({ id: 3, active: 0 }, 'roma_items');
      await new Transaction(provider).commit();
      assert.equal(await count(), 2);

      const q = new QueryBuilder(class Item {}, provider, 'roma_items');
      assert.deepEqual((await q.where(x => x.active === true).toList()).map(r => r.id), [1]);

      await provider.addRange([{ orderId: 1, lineNo: 1 }, { orderId: 1, lineNo: 2 }], 'roma_lines');
      await assert.rejects(() => provider.remove({ orderId: 1, lineNo: 1 }, 'roma_lines'), /composite primary key/);
      assert.equal((await provider.getAll('roma_lines')).length, 2);

      await provider.addMigration('m1', 'script');
      assert.deepEqual(await observer.getMigrationHistory(), ['m1']);
      await provider.removeMigration('m1');
    } finally {
      await provider.rollbackTransaction();
      await provider.dropTable('roma_items');
      await provider.dropTable('roma_lines');
      await provider.dropTable('__roma_migrations');
      await observer.disconnect();
      await provider.disconnect();
    }
  });
});
