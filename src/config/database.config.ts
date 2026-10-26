/**
 * Database Configuration
 */

require('dotenv').config();

// Query timeout
export const QUERY_TIMEOUT = parseInt(process.env.QUERY_TIMEOUT || '300000', 10);

export interface MSSQLConfig {
  server: string;
  port: number;
  database: string;
  user: string;
  password: string;
  requestTimeout?: number;
  connectionTimeout?: number;
  pool: {
    min: number;
    max: number;
  };
  options: {
    encrypt: boolean;
    trustServerCertificate: boolean;
  };
}

export interface OracleConfig {
  connectionString?: string;
  user?: string;
  password?: string;
  host?: string;
  port?: number;
  database?: string;
  libDir?: string;
  pool: {
    min: number;
    max: number;
  };
}

export const mssqlConfig: MSSQLConfig = {
  server: process.env.MSSQL_HOST || 'localhost',
  port: parseInt(process.env.MSSQL_PORT || '1433', 10),
  database: process.env.MSSQL_DATABASE || '',
  user: process.env.MSSQL_USER || '',
  password: process.env.MSSQL_PASSWORD || '',
  requestTimeout: QUERY_TIMEOUT,
  connectionTimeout: 30000,
  pool: {
    min: parseInt(process.env.CONNECTION_POOL_MIN || '5', 10),
    max: parseInt(process.env.CONNECTION_POOL_MAX || '20', 10),
  },
  options: {
    encrypt: true,
    trustServerCertificate: true,
  },
};

export const oracleConfig: OracleConfig = {
  connectionString: process.env.ORACLE_CONNECTION_STRING || 'localhost:1521/ORCL',
  user: process.env.ORACLE_USER || 'system',
  password: process.env.ORACLE_PASSWORD || 'oracle',
  libDir: process.env.ORACLE_CLIENT_DIR || '',
  pool: {
    min: parseInt(process.env.CONNECTION_POOL_MIN || '5', 10),
    max: parseInt(process.env.CONNECTION_POOL_MAX || '20', 10),
  },
};

// Validate configuration
export function validateConfig(): boolean {
  const required = [
    'MSSQL_HOST',
    'MSSQL_DATABASE',
    'MSSQL_USER',
    'MSSQL_PASSWORD',
    'ORACLE_CONNECTION_STRING',
    'ORACLE_USER',
    'ORACLE_PASSWORD',
  ];

  const missing = required.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    console.error('Missing required environment variables:', missing);
    return false;
  }

  return true;
}

