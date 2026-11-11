# Changelog

All notable changes to @romatech/orm-providers-oracle will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [2.1.0] - 2026-11-11

### Added
- Transactions: `OracleProvider` implements `ITransactionalProvider` (`supportsTransactions`, `beginTransaction`, `commitTransaction`, `rollbackTransaction`). Between begin and commit/rollback nothing is committed; raw `COMMIT`/`ROLLBACK` (sent by `Transaction` in `@romatech/orm` 2.0.0) are routed to these methods. The provider's DDL methods throw inside a transaction, because Oracle would commit it implicitly. `disconnect()` rolls back an open transaction. In 2.0.0 every statement was committed immediately, so `DbContext.beginTransaction()` could not group statements.
- `clearMetadataCache(tableName?)`.

### Fixed
- Raw `executeQuery` statements are committed (`autoCommit`) outside a transaction. Only `executeNonQuery` committed, so DML sent through `executeQuery` (for example `DbContext.deleteWhere`/`updateWhere`) stayed uncommitted, invisible to other sessions and lost on `disconnect()`.
- Query predicates re-checked in JavaScript see `NUMBER(1)` columns (the type the provider creates for `boolean`) as booleans: `where(x => x.active === true)` returned no rows although Oracle matched them. A predicate Oracle already applied that compares a date column with a string literal is no longer re-checked (always false in JS). The returned rows are unchanged driver rows. Predicates written against the driver's own values in 2.0.0 style (for example `x.active === 1` or `x.id === '5'`) keep matching the rows the database returned: when the database already applied the predicate, a row is kept if it holds on either the converted or the original value.
- `update`/`remove`/`find` throw for tables with a composite primary key instead of matching rows by the first key column only (removing one order line deleted every line of the order).
- `getColumnsForTable` reads primary keys from `user_constraints` (not `all_constraints`, which mixed in other schemas' tables) and looks the table up by its exact (quoted) name before falling back to upper case.
- `update` with only `undefined` values besides the key is a no-op instead of sending invalid SQL (`SET  WHERE`).

### Changed
- The primary key of each table is introspected once and cached: `update`/`remove`/`find` no longer run two to three introspection queries before every statement. The cache is cleared after the provider's DDL, after raw statements other than `SELECT`/`WITH`, and by `clearMetadataCache()`.
- Statements are committed in the same round trip (`autoCommit`) instead of a separate `commit()` call.
- CI: `npm ci` (the lockfile had drifted to `@romatech/orm@1.2.0`; re-synced), Node 22 and 24, read-only `permissions`. The publish workflow uses `npm ci` and no longer rewrites the `@romatech/orm` range with `sed` before publishing; the GitHub release runs in a separate job with `contents: write`.
- `npm test` (Node test runner): unit tests, plus integration tests against a real Oracle Database when `ORACLE_TEST_CONNECT` (with `ORACLE_TEST_USER`/`ORACLE_TEST_PASSWORD`) is set.
- Standardized `index.html` landing page (GitHub Pages).

## [2.0.0] and earlier

Published to npm (1.0.0, 1.2.0, 2.0.0) without changelog entries; see the git history. 1.0.0 was the initial release.
