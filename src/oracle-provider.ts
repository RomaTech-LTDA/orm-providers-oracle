/**
 * @module oracle-provider
 *
 * Oracle Database implementation of {@link IDbProvider}.
 *
 * Uses the [`oracledb`](https://www.npmjs.com/package/oracledb) package for
 * connection management and query execution.
 *
 * SQL Dialect:
 * - Identifiers quoted with double quotes: `"columnName"`
 * - Positional parameters: `:1`, `:2`, ...
 * - ORA-00955 silently caught for `CREATE TABLE` idempotency
 * - Every statement auto-commits, except inside a transaction started with
 *   `beginTransaction()` (see {@link OracleProvider.beginTransaction})
 */

import oracledb from 'oracledb';
import {
  buildDeleteSql,
  buildFindSql,
  buildInsertSql,
  buildSelectAllSql,
  buildSelectSql,
  buildUpdateSql,
  ITransactionalProvider,
  QueryObject,
  SqlDialect,
  TableColumnInfo
} from '@romatech/orm';
import { applyQueryToDriverRows, DriverColumns, toBoolean, toDate, ValueConverter } from './driver-rows';

/** Exactly `BEGIN`/`COMMIT`/`ROLLBACK` [`WORK`|`TRAN`|`TRANSACTION`] with an optional `;`. */
const TRANSACTION_CONTROL = /^\s*(BEGIN|COMMIT|ROLLBACK)(?:\s+(?:WORK|TRAN|TRANSACTION))?\s*;?\s*$/i;

/** Raw statements that cannot change the schema (they keep the key cache). */
const READ_ONLY_STATEMENT = /^\s*(SELECT|WITH)\b/i;

type OracleConfig = string | {
  user?: string;
  password?: string;
  connectString: string;
};

const dialect: SqlDialect = {
  quoteIdentifier: identifier => `"${identifier.replace(/"/g, '""')}"`,
  parameter: index => `:${index + 1}`
};

/**
 * Oracle provider. It uses one connection; every statement auto-commits
 * unless a transaction is open (see {@link beginTransaction}).
 */
export class OracleProvider implements ITransactionalProvider {
  /** This provider implements {@link ITransactionalProvider}. */
  readonly supportsTransactions = true;

  private connection!: any;

  /** Whether a transaction started with {@link beginTransaction} is open. */
  private inTransaction = false;

  /** Primary-key columns per table, so DML does not introspect on every call. */
  private readonly primaryKeyCache = new Map<string, Promise<string[]>>();

  constructor(private config: OracleConfig) {}

  async connect(connectionString = ''): Promise<void> {
    const config = typeof this.config === 'string'
      ? { connectString: connectionString || this.config }
      : { ...this.config, connectString: connectionString || this.config.connectString };
    this.connection = await oracledb.getConnection(config);
  }

  async disconnect(): Promise<void> {
    if (this.inTransaction) {
      // Never leave an open transaction behind (closing would roll it back anyway).
      await this.rollbackTransaction().catch(() => undefined);
    }
    if (this.connection) {
      await this.connection.close();
    }
  }

  /**
   * Opens a transaction: until {@link commitTransaction} or
   * {@link rollbackTransaction}, statements of this provider are not
   * auto-committed.
   *
   * The provider has a single connection, so the transaction covers every
   * statement sent through this provider instance meanwhile: use one
   * provider (one `DbContext`) per unit of work when requests run
   * concurrently. Oracle commits implicitly before and after DDL, so the
   * provider's DDL methods refuse to run inside a transaction; do not send
   * raw DDL inside one either.
   *
   * @throws {Error} If a transaction is already open (no nesting) or the
   *   provider is not connected.
   */
  async beginTransaction(): Promise<void> {
    if (this.inTransaction) {
      throw new Error('A transaction is already active on this provider; nested transactions are not supported.');
    }
    if (!this.connection) {
      throw new Error('The provider is not connected; call connect() first.');
    }
    this.inTransaction = true;
  }

  /**
   * Commits the open transaction.
   *
   * @throws {Error} If no transaction is open.
   */
  async commitTransaction(): Promise<void> {
    if (!this.inTransaction) {
      throw new Error('No active transaction to commit.');
    }
    try {
      await this.connection.commit();
    } finally {
      this.inTransaction = false;
    }
  }

  /**
   * Rolls back the open transaction. A no-op when none is open, so it is
   * always safe to call from a `catch` block.
   */
  async rollbackTransaction(): Promise<void> {
    if (!this.inTransaction) {
      return;
    }
    try {
      await this.connection.rollback();
    } finally {
      this.inTransaction = false;
    }
  }

  /**
   * Forgets the cached primary-key metadata (of one table, or of all).
   * The provider already does this after its own DDL and after raw
   * statements that are not `SELECT`/`WITH`; call it when the schema is
   * changed by another process while this provider is connected.
   */
  clearMetadataCache(tableName?: string): void {
    if (tableName === undefined) {
      this.primaryKeyCache.clear();
    } else {
      this.primaryKeyCache.delete(tableName);
    }
  }

  async add<T extends object>(entity: T, tableName: string): Promise<void> {
    const command = buildInsertSql(tableName, entity, dialect);
    await this.send(command.sql, command.params);
  }

  async addRange<T extends object>(entities: T[], tableName: string): Promise<void> {
    for (const entity of entities) {
      await this.add(entity, tableName);
    }
  }

  async update<T extends object>(entity: T, tableName: string): Promise<void> {
    const primaryKey = await this.getPrimaryKeyColumn(tableName);
    if (!Object.entries(entity).some(([key, value]) => key !== primaryKey && value !== undefined)) {
      return;
    }
    const command = buildUpdateSql(tableName, entity, primaryKey, dialect);
    await this.send(command.sql, command.params);
  }

  async remove<T extends object>(entity: T, tableName: string): Promise<void> {
    const command = buildDeleteSql(tableName, entity, await this.getPrimaryKeyColumn(tableName), dialect);
    await this.send(command.sql, command.params);
  }

  async removeRange<T extends object>(entities: T[], tableName: string): Promise<void> {
    for (const entity of entities) {
      await this.remove(entity, tableName);
    }
  }

  async find<T extends object>(entity: T, tableName: string): Promise<T | undefined> {
    const command = buildFindSql(tableName, entity, await this.getPrimaryKeyColumn(tableName), dialect);
    const rows = (await this.send(command.sql, command.params)).rows as T[];
    return rows[0];
  }

  async getAll<T>(tableName: string): Promise<T[]> {
    return (await this.send(buildSelectAllSql(tableName, dialect), [])).rows as T[];
  }

  async saveChanges(): Promise<void> {
    return;
  }

  async addMigration(migrationName: string, migrationScript: string): Promise<void> {
    await this.ensureMigrationHistoryTable();
    await this.send(
      'INSERT INTO "__roma_migrations" ("migrationName", "migrationScript") VALUES (:1, :2)',
      [migrationName, migrationScript]
    );
  }

  async removeMigration(migrationName: string): Promise<void> {
    await this.ensureMigrationHistoryTable();
    await this.send('DELETE FROM "__roma_migrations" WHERE "migrationName" = :1', [migrationName]);
  }

  async applyMigrations(): Promise<void> {
    return;
  }

  async getMigrations(): Promise<string[]> {
    return this.getMigrationHistory();
  }

  async getMigrationHistory(): Promise<string[]> {
    await this.ensureMigrationHistoryTable();
    const rows = (await this.send(
      'SELECT "migrationName" FROM "__roma_migrations" ORDER BY "migrationName"', []
    )).rows as { migrationName: string }[];
    return rows.map(row => row.migrationName);
  }

  async updateDatabase(_targetMigration?: string): Promise<void> {
    return;
  }

  async downgradeDatabase(_targetMigration?: string): Promise<void> {
    return;
  }

  async createTable(input: { tableName: string; columns: TableColumnInfo[]; primaryKey?: string }): Promise<void> {
    const primaryKey = input.primaryKey || input.columns.find(column => column.primaryKey)?.name;
    const columns = input.columns
      .map(column => `${dialect.quoteIdentifier(column.name)} ${this.mapColumnType(column)}${column.primaryKey ? ' NOT NULL' : ''}`)
      .join(', ');
    const primaryKeySql = primaryKey ? `, PRIMARY KEY (${dialect.quoteIdentifier(primaryKey)})` : '';

    this.assertNoTransaction('createTable');
    await this.ignoreOracleError(
      () => this.sendDdl(`CREATE TABLE ${dialect.quoteIdentifier(input.tableName)} (${columns}${primaryKeySql})`),
      955
    );
    this.clearMetadataCache(input.tableName);
  }

  async dropTable(tableName: string): Promise<void> {
    this.assertNoTransaction('dropTable');
    await this.ignoreOracleError(
      () => this.sendDdl(`DROP TABLE ${dialect.quoteIdentifier(tableName)}`),
      942
    );
    this.clearMetadataCache(tableName);
  }

  async addColumn(tableName: string, column: TableColumnInfo): Promise<void> {
    this.assertNoTransaction('addColumn');
    await this.sendDdl(
      `ALTER TABLE ${dialect.quoteIdentifier(tableName)} ADD ${dialect.quoteIdentifier(column.name)} ${this.mapColumnType(column)}`
    );
    this.clearMetadataCache(tableName);
  }

  async removeColumn(tableName: string, columnName: string): Promise<void> {
    this.assertNoTransaction('removeColumn');
    await this.sendDdl(
      `ALTER TABLE ${dialect.quoteIdentifier(tableName)} DROP COLUMN ${dialect.quoteIdentifier(columnName)}`
    );
    this.clearMetadataCache(tableName);
  }

  async scaffold(_connectionString: string): Promise<void> {
    return;
  }

  async getTables(): Promise<string[]> {
    const rows = (await this.send(
      'SELECT table_name AS "tableName" FROM user_tables', []
    )).rows as { tableName: string }[];
    return rows.map(row => row.tableName);
  }

  async getColumnsForTable(table: string): Promise<TableColumnInfo[]> {
    // The provider quotes table names in DML ("users"), so the exact name is
    // tried first; the upper-case form covers tables created unquoted.
    const tableName = (await this.tableExists(table)) ? table : table.toUpperCase();
    const columns = await this.query<{ name: string; type: string }>(
      `
      SELECT column_name AS "name", data_type AS "type"
      FROM user_tab_columns
      WHERE table_name = :1
      ORDER BY column_id
      `,
      [tableName]
    );

    // user_* views only: a same-named table owned by another schema must not
    // contribute primary-key columns.
    const primaryKeys = await this.query<{ name: string }>(
      `
      SELECT cols.column_name AS "name"
      FROM user_constraints cons
      JOIN user_cons_columns cols
        ON cons.constraint_name = cols.constraint_name
       AND cons.table_name = cols.table_name
      WHERE cons.constraint_type = 'P'
        AND cons.table_name = :1
      `,
      [tableName]
    );
    const primaryKeyNames = new Set(primaryKeys.map(row => row.name));

    return columns.map(column => ({
      name: column.name,
      primaryKey: primaryKeyNames.has(column.name),
      tsType: this.mapDbTypeToTsType(column.type)
    }));
  }

  async executeQuery<T = any>(query: string, params?: any[]): Promise<T[]>;
  async executeQuery<T, TResult = T>(entityName: string, query: QueryObject<T, TResult>): Promise<TResult[]>;
  async executeQuery<T, TResult = T>(
    queryOrEntityName: string,
    paramsOrQuery: any[] | QueryObject<T, TResult> = []
  ): Promise<T[] | TResult[]> {
    if (!Array.isArray(paramsOrQuery)) {
      const command = buildSelectSql(queryOrEntityName, paramsOrQuery, dialect);
      const result = await this.send(command.sql, command.params);
      return applyQueryToDriverRows((result.rows || []) as T[], paramsOrQuery, driverColumns(result.metaData));
    }

    if (paramsOrQuery.length === 0 && await this.routeTransactionControl(queryOrEntityName)) {
      return [];
    }
    if (!READ_ONLY_STATEMENT.test(queryOrEntityName)) {
      // The statement may change the schema (keys included).
      this.clearMetadataCache();
    }
    return ((await this.send(queryOrEntityName, paramsOrQuery)).rows || []) as T[];
  }

  /**
   * Executes a statement. Outside a transaction it is committed in the same
   * round trip (`autoCommit`); inside one it waits for
   * {@link commitTransaction}. Raw `COMMIT`/`ROLLBACK` (sent by
   * `Transaction` of `@romatech/orm` 2.0) and `BEGIN` are routed to the
   * transaction methods.
   */
  async executeNonQuery(sql: string, params: any[] = []): Promise<void> {
    if (params.length === 0 && await this.routeTransactionControl(sql)) {
      return;
    }
    if (!READ_ONLY_STATEMENT.test(sql)) {
      // The statement may change the schema (keys included).
      this.clearMetadataCache();
    }
    await this.send(sql, params);
  }

  /**
   * Sends one statement on the connection: auto-committed unless a
   * transaction is open. Raw `executeQuery` DML used to stay uncommitted
   * (and was lost on disconnect) because only `executeNonQuery` committed.
   */
  private send(sql: string, params: any[]): Promise<{ rows?: any[]; metaData?: OracleColumnMetaData[] }> {
    return this.connection.execute(sql, params, {
      outFormat: oracledb.OUT_FORMAT_OBJECT,
      autoCommit: !this.inTransaction
    });
  }

  /** Runs a DDL statement (always outside a transaction; Oracle commits DDL implicitly). */
  private async sendDdl(sql: string): Promise<void> {
    await this.send(sql, []);
  }

  /** Rows of a metadata query. */
  private async query<R>(sql: string, params: any[]): Promise<R[]> {
    return ((await this.send(sql, params)).rows || []) as R[];
  }

  /** Oracle commits an open transaction implicitly on DDL: refuse instead. */
  private assertNoTransaction(operation: string): void {
    if (this.inTransaction) {
      throw new Error(`${operation}() cannot run inside a transaction: Oracle would implicitly commit it. Commit or roll back first.`);
    }
  }

  /**
   * Handles a raw transaction-control statement. Returns `false` when `sql`
   * is not one, so the caller sends it as usual.
   */
  private async routeTransactionControl(sql: string): Promise<boolean> {
    const match = TRANSACTION_CONTROL.exec(sql);
    if (!match) {
      return false;
    }
    const verb = match[1].toUpperCase();
    if (verb === 'BEGIN') {
      await this.beginTransaction();
    } else if (verb === 'COMMIT') {
      if (this.inTransaction) {
        await this.commitTransaction();
      }
    } else {
      await this.rollbackTransaction();
    }
    return true;
  }

  private async ensureMigrationHistoryTable(): Promise<void> {
    // Checked first: a CREATE TABLE attempt is DDL, which would implicitly
    // commit an open transaction even when it fails with ORA-00955.
    const existing = await this.query<{ found: number }>(
      'SELECT COUNT(*) AS "found" FROM user_tables WHERE table_name = :1',
      ['__roma_migrations']
    );
    if (Number(existing[0]?.found) > 0) {
      return;
    }
    this.assertNoTransaction('the first addMigration/getMigrationHistory');
    await this.ignoreOracleError(
      () => this.sendDdl(`
        CREATE TABLE "__roma_migrations" (
          "migrationName" VARCHAR2(255) NOT NULL PRIMARY KEY,
          "migrationScript" CLOB NOT NULL,
          "appliedAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
        )
      `),
      955
    );
  }

  private async tableExists(table: string): Promise<boolean> {
    const rows = await this.query<{ found: number }>(
      'SELECT COUNT(*) AS "found" FROM user_tab_columns WHERE table_name = :1',
      [table]
    );
    return Number(rows[0]?.found) > 0;
  }

  /**
   * Resolves the single primary-key column (falls back to `id`). Composite
   * keys are rejected: matching rows by only one of their key columns would
   * update or delete every row sharing that value.
   *
   * The key columns are cached per table (see {@link clearMetadataCache}):
   * `update`/`remove`/`find` used to cost three introspection round trips.
   */
  private async getPrimaryKeyColumn(tableName: string): Promise<string> {
    let cached = this.primaryKeyCache.get(tableName);
    if (!cached) {
      const lookup = this.getColumnsForTable(tableName)
        .then(columns => columns.filter(column => column.primaryKey).map(column => column.name));
      cached = lookup;
      this.primaryKeyCache.set(tableName, lookup);
      // A failed lookup is not cached.
      lookup.catch(() => {
        if (this.primaryKeyCache.get(tableName) === lookup) {
          this.primaryKeyCache.delete(tableName);
        }
      });
    }
    const keys = await cached;
    if (keys.length > 1) {
      throw new Error(`Table '${tableName}' has a composite primary key (${keys.join(', ')}); update/remove/find by entity support a single-column key only.`);
    }
    return keys[0] || 'id';
  }

  private mapColumnType(column: TableColumnInfo): string {
    const type = column.tsType.toLowerCase();
    if (type.includes('number')) return 'NUMBER';
    if (type.includes('boolean')) return 'NUMBER(1)';
    if (type.includes('date')) return 'TIMESTAMP';
    return column.primaryKey ? 'VARCHAR2(255)' : 'CLOB';
  }

  private mapDbTypeToTsType(type: string): string {
    const normalized = type.toLowerCase();
    if (/(number|float|double|decimal|integer)/.test(normalized)) return 'number';
    if (/(date|timestamp)/.test(normalized)) return 'Date';
    if (/(clob|blob|json)/.test(normalized)) return 'unknown';
    return 'string';
  }

  private async ignoreOracleError(action: () => Promise<void>, errorNumber: number): Promise<void> {
    try {
      await action();
    } catch (error: any) {
      if (error?.errorNum !== errorNumber) {
        throw error;
      }
    }
  }
}

/** Column metadata of an `oracledb` result (`result.metaData`). */
interface OracleColumnMetaData {
  name: string;
  dbTypeName?: string;
  precision?: number;
  scale?: number;
}

/**
 * Converters for the columns of an `oracledb` result: `NUMBER(1)` (the type
 * this provider creates for `boolean`) to booleans; `DATE`/`TIMESTAMP` are
 * temporal (and date strings become `Date`).
 */
function driverColumns(metaData: OracleColumnMetaData[] | undefined): DriverColumns {
  const converters: Record<string, ValueConverter> = {};
  const temporal = new Set<string>();
  for (const column of metaData || []) {
    const type = (column.dbTypeName || '').toUpperCase();
    if (type === 'NUMBER' && column.precision === 1 && (column.scale ?? 0) === 0) {
      converters[column.name] = toBoolean;
    } else if (type === 'DATE' || type.startsWith('TIMESTAMP')) {
      converters[column.name] = toDate;
      temporal.add(column.name);
    }
  }
  return { converters, temporal };
}
