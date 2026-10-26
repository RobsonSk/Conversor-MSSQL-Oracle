declare module 'oracledb' {
  interface Pool {
    getConnection(): Promise<Connection>;
    close(drainTime?: number): Promise<void>;
  }
  interface Connection {
    execute(sql: string, bindParams?: any, options?: any): Promise<any>;
    executeMany(sql: string, binds: any[] | number, options?: any): Promise<any>;
    commit(): Promise<void>;
    rollback(): Promise<void>;
    close(): Promise<void>;
  }
  function createPool(config: any): Promise<Pool>;
  function initOracleClient(options: { libDir?: string }): void;
  
  namespace oracledb {
    export { Pool, Connection, createPool, initOracleClient };
    export let autoCommit: boolean;
  }
  export = oracledb;
}
