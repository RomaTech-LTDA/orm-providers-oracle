# @romatech/orm-providers-oracle

[![npm](https://img.shields.io/npm/v/@romatech%2Form-providers-oracle)](https://www.npmjs.com/package/@romatech/orm-providers-oracle)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/RomaTech-LTDA/orm-providers-oracle/blob/main/LICENSE)

<p align="center">
  <img src="logo.png" width="120" alt="RomaTech ORM – Oracle Provider" />
</p>

Oracle Database provider for [@romatech/orm](https://www.npmjs.com/package/@romatech/orm).

---

## Installation

```bash
npm install @romatech/orm @romatech/orm-providers-oracle reflect-metadata
```

> **Note:** `oracledb` 6 connects in Thin mode by default, without the
> Oracle Instant Client (the integration tests of this package run that way).
> Thick mode, which some features need, requires the Instant Client. See the
> [node-oracledb installation guide](https://node-oracledb.readthedocs.io/en/latest/user_guide/installation.html).

---

## Quick Start

```ts
import 'reflect-metadata';
import { DbContext, DbContextOptions } from '@romatech/orm';
import { OracleProvider } from '@romatech/orm-providers-oracle';

class AppDbContext extends DbContext {
    users = this.set(User);

    constructor() {
        super(
            new DbContextOptions().useProvider(
                new OracleProvider({
                    user: 'myuser',
                    password: 'yourPassword',
                    connectString: 'localhost/XEPDB1'
                })
            )
        );
    }
}
```

---

## Configuration Options

### Object-style (recommended)

```ts
new OracleProvider({
    user: 'myuser',
    password: 'yourPassword',
    connectString: 'localhost:1521/XEPDB1'
})
```

### Connection string only

```ts
new OracleProvider('localhost:1521/XEPDB1')
```

---

## SQL Dialect

| Feature | Syntax |
|---------|--------|
| Identifier quoting | `"columnName"` |
| Parameters | `:1`, `:2`, ... (positional) |
| Table exists check | ORA-00955 error is silently caught |

---

## Supported Features

- Full CRUD (add, addRange, update, remove, removeRange, find, getAll)
- Server-side WHERE clause generation from predicates
- Server-side ORDER BY generation
- Migration history table (`"__roma_migrations"`)
- Schema management (createTable, dropTable, addColumn, removeColumn)
- Scaffold (introspect via `user_tables` and `user_tab_columns`)
- Parameterised queries (SQL injection safe)
- Every statement auto-commits outside a transaction (raw `executeQuery` included)
- Transactions (`ITransactionalProvider`, since 2.1.0, see below)

---

## Transactions

```ts
const tx = await db.beginTransaction();
try {
    db.orders.add(order);
    await db.saveChanges();
    await tx.commit();
} catch (err) {
    await tx.rollback();
    throw err;
}
```

- Outside a transaction every statement is committed in the same round trip
  (`autoCommit`). Between `beginTransaction()` and `commit()`/`rollback()`
  nothing is committed.
- The provider uses **one connection**: the transaction covers every statement
  sent through the provider meanwhile, so use one `DbContext` per unit of work
  when requests run concurrently.
- Oracle commits implicitly before and after any DDL. `createTable`,
  `dropTable`, `addColumn` and `removeColumn` therefore throw inside a
  transaction, and so does the first `addMigration` when the migration history
  table does not exist yet. Do not send raw DDL inside a transaction either.
- Nested transactions are rejected; `rollback()` is a no-op when no transaction
  is open; `disconnect()` rolls back an open transaction.

In 2.0.0 the provider committed after every statement, so
`DbContext.beginTransaction()` could not group statements (and raw
`executeQuery` DML was never committed).

### Notes

- `update`, `remove` and `find` locate the row by the table's single-column
  primary key (or `id` when the table has none). Tables with a **composite**
  primary key are rejected with an error, instead of matching every row that
  shares the first key column.
- The primary key of each table is introspected once and cached. The cache is
  cleared after the provider's own DDL and after raw statements that are not
  `SELECT`/`WITH`; call `provider.clearMetadataCache()` if another process
  changes the schema while the provider is connected.
- Query predicates are evaluated by Oracle and then re-checked in JavaScript
  on converted copies of the rows: `NUMBER(1)` (the type the provider creates
  for `boolean`) is compared as a boolean, so `x => x.active === true` works.
  The rows you get back are the driver's rows, unchanged. A comparison of a
  date column with a string literal is left to Oracle. A `NUMBER(1)` used for
  small integers is therefore compared as a boolean in predicates.

---

## Type Mappings

| TypeScript Type | Oracle Type |
|-----------------|-------------|
| `number` | `NUMBER` |
| `boolean` | `NUMBER(1)` |
| `Date` | `TIMESTAMP` |
| `string` (PK) | `VARCHAR2(255)` |
| `string` | `CLOB` |

---

## Requirements

- Node.js >= 18
- Oracle Database 12c or later (or Oracle XE)
- Oracle Instant Client only if you enable `oracledb` Thick mode
- The [`oracledb`](https://www.npmjs.com/package/oracledb) npm package (installed automatically)

---

## License

MIT © RomaTech / Leandro Romanelli
