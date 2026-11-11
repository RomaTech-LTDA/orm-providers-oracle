declare module 'oracledb' {
  export const OUT_FORMAT_OBJECT: number;

  export interface Connection {
    execute(sql: string, params?: any[] | Record<string, any>, options?: any): Promise<{ rows?: any[]; metaData?: any[] }>;
    commit(): Promise<void>;
    rollback(): Promise<void>;
    close(): Promise<void>;
  }

  export function getConnection(config: any): Promise<Connection>;

  const oracledb: {
    OUT_FORMAT_OBJECT: typeof OUT_FORMAT_OBJECT;
    getConnection: typeof getConnection;
  };

  export default oracledb;
}
