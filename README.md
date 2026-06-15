# @romatech/orm-providers-oracle

<p align="center">
  <img src="logo.png" width="120" alt="RomaTech ORM – Oracle Provider" />
</p>

Oracle Database provider for [@romatech/orm](https://www.npmjs.com/package/@romatech/orm).

---

## Installation

```bash
npm install @romatech/orm @romatech/orm-providers-oracle reflect-metadata
```

> **Note:** The `oracledb` package requires the Oracle Instant Client to be
> installed on the machine. See the
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
- Auto-commit after each non-query statement

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
- Oracle Instant Client (for the native `oracledb` driver)
- The [`oracledb`](https://www.npmjs.com/package/oracledb) npm package (installed automatically)

---

## License

MIT © RomaTech / Leandro Romanelli
