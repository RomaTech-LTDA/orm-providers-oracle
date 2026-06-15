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
 * - Auto-commit after each non-query statement
 */

import oracledb from 'oracledb';
import {
  applyClientSideQuery,
  buildDeleteSql,
  buildFindSql,
  buildInsertSql,
  buildSelectAllSql,
  buildSelectSql,
  buildUpdateSql,
  IDbProvider,
  QueryObject,
  SqlDialect,
  TableColumnInfo
} from '@romatech/orm';

type OracleConfig = string | {
  user?: string;
  password?: string;
  connectString: string;
};

const dialect: SqlDialect = {
  quoteIdentifier: identifier => `"${identifier.replace(/"/g, '""')}"`,
  parameter: index => `:${index + 1}`
};

export class OracleProvider implements IDbProvider {
  private connection!: any;

  constructor(private config: OracleConfig) {}

  async connect(connectionString = ''): Promise<void> {
    const config = typeof this.config === 'string'
      ? { connectString: connectionString || this.config }
      : { ...this.config, connectString: connectionString || this.config.connectString };
    this.connection = await oracledb.getConnection(config);
  }

  async disconnect(): Promise<void> {
    if (this.connection) {
      await this.connection.close();
    }
  }

  async add<T extends object>(entity: T, tableName: string): Promise<void> {
    const command = buildInsertSql(tableName, entity, dialect);
    await this.executeNonQuery(command.sql, command.params);
  }

  async addRange<T extends object>(entities: T[], tableName: string): Promise<void> {
    for (const entity of entities) {
      await this.add(entity, tableName);
    }
  }

  async update<T extends object>(entity: T, tableName: string): Promise<void> {
    const primaryKey = await this.getPrimaryKeyColumn(tableName);
    if (!Object.keys(entity).some(key => key !== primaryKey)) {
      return;
    }
    const command = buildUpdateSql(tableName, entity, primaryKey, dialect);
    await this.executeNonQuery(command.sql, command.params);
  }

  async remove<T extends object>(entity: T, tableName: string): Promise<void> {
    const command = buildDeleteSql(tableName, entity, await this.getPrimaryKeyColumn(tableName), dialect);
    await this.executeNonQuery(command.sql, command.params);
  }

  async removeRange<T extends object>(entities: T[], tableName: string): Promise<void> {
    for (const entity of entities) {
      await this.remove(entity, tableName);
    }
  }

  async find<T extends object>(entity: T, tableName: string): Promise<T | undefined> {
    const command = buildFindSql(tableName, entity, await this.getPrimaryKeyColumn(tableName), dialect);
    const rows = await this.executeQuery<T>(command.sql, command.params);
    return rows[0];
  }

  async getAll<T>(tableName: string): Promise<T[]> {
    return this.executeQuery<T>(buildSelectAllSql(tableName, dialect));
  }

  async saveChanges(): Promise<void> {
    return;
  }

  async addMigration(migrationName: string, migrationScript: string): Promise<void> {
    await this.ensureMigrationHistoryTable();
    await this.executeNonQuery(
      'INSERT INTO "__roma_migrations" ("migrationName", "migrationScript") VALUES (:1, :2)',
      [migrationName, migrationScript]
    );
  }

  async removeMigration(migrationName: string): Promise<void> {
    await this.ensureMigrationHistoryTable();
    await this.executeNonQuery('DELETE FROM "__roma_migrations" WHERE "migrationName" = :1', [migrationName]);
  }

  async applyMigrations(): Promise<void> {
    return;
  }

  async getMigrations(): Promise<string[]> {
    return this.getMigrationHistory();
  }

  async getMigrationHistory(): Promise<string[]> {
    await this.ensureMigrationHistoryTable();
    const rows = await this.executeQuery<{ migrationName: string }>(
      'SELECT "migrationName" FROM "__roma_migrations" ORDER BY "migrationName"'
    );
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

    await this.ignoreOracleError(
      () => this.executeNonQuery(`CREATE TABLE ${dialect.quoteIdentifier(input.tableName)} (${columns}${primaryKeySql})`),
      955
    );
  }

  async dropTable(tableName: string): Promise<void> {
    await this.ignoreOracleError(
      () => this.executeNonQuery(`DROP TABLE ${dialect.quoteIdentifier(tableName)}`),
      942
    );
  }

  async addColumn(tableName: string, column: TableColumnInfo): Promise<void> {
    await this.executeNonQuery(
      `ALTER TABLE ${dialect.quoteIdentifier(tableName)} ADD ${dialect.quoteIdentifier(column.name)} ${this.mapColumnType(column)}`
    );
  }

  async removeColumn(tableName: string, columnName: string): Promise<void> {
    await this.executeNonQuery(
      `ALTER TABLE ${dialect.quoteIdentifier(tableName)} DROP COLUMN ${dialect.quoteIdentifier(columnName)}`
    );
  }

  async scaffold(_connectionString: string): Promise<void> {
    return;
  }

  async getTables(): Promise<string[]> {
    const rows = await this.executeQuery<{ tableName: string }>(
      'SELECT table_name AS "tableName" FROM user_tables'
    );
    return rows.map(row => row.tableName);
  }

  async getColumnsForTable(table: string): Promise<TableColumnInfo[]> {
    const columns = await this.executeQuery<{ name: string; type: string }>(
      `
      SELECT column_name AS "name", data_type AS "type"
      FROM user_tab_columns
      WHERE table_name = :1
      `,
      [table.toUpperCase()]
    );

    const primaryKeys = await this.executeQuery<{ name: string }>(
      `
      SELECT cols.column_name AS "name"
      FROM all_constraints cons
      JOIN all_cons_columns cols
        ON cons.constraint_name = cols.constraint_name
       AND cons.owner = cols.owner
      WHERE cons.constraint_type = 'P'
        AND cols.table_name = :1
      `,
      [table.toUpperCase()]
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
      const rows = await this.executeQuery<T>(command.sql, command.params);
      return applyClientSideQuery(rows, paramsOrQuery);
    }

    const result = await this.connection.execute(queryOrEntityName, paramsOrQuery, {
      outFormat: oracledb.OUT_FORMAT_OBJECT
    });
    return (result.rows || []) as T[];
  }

  async executeNonQuery(sql: string, params: any[] = []): Promise<void> {
    await this.connection.execute(sql, params);
    await this.connection.commit();
  }

  private async ensureMigrationHistoryTable(): Promise<void> {
    await this.ignoreOracleError(
      () => this.executeNonQuery(`
        CREATE TABLE "__roma_migrations" (
          "migrationName" VARCHAR2(255) NOT NULL PRIMARY KEY,
          "migrationScript" CLOB NOT NULL,
          "appliedAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
        )
      `),
      955
    );
  }

  private async getPrimaryKeyColumn(tableName: string): Promise<string> {
    const primaryKey = (await this.getColumnsForTable(tableName)).find(column => column.primaryKey)?.name;
    return primaryKey || 'id';
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
