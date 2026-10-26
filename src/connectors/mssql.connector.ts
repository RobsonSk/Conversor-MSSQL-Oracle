/**
 * MSSQL Connector - Handles connections and queries to MSSQL
 */

import * as sql from 'mssql';
import { mssqlConfig, QUERY_TIMEOUT } from '../config/database.config';
import { logger } from '../utils/logger';
import { ErrorHandler } from '../utils/error-handler';
import { ColumnDefinition } from '../models/table.model';

declare module 'mssql' {
  interface Request {
    timeout?: number;
  }
}

export class MSSQLConnector {
  private pool: sql.ConnectionPool | null = null;
  private connected: boolean = false;

  /**
   * Connect to MSSQL database
   */
  async connect(): Promise<void> {
    try {
      this.pool = new sql.ConnectionPool(mssqlConfig);
      await this.pool.connect();
      this.connected = true;
      logger.info('Connected to MSSQL database', 'MSSQLConnector');
    } catch (error) {
      const migrationError = ErrorHandler.handleConnectionError('MSSQL', error as Error);
      throw migrationError;
    }
  }

  /**
   * Disconnect from MSSQL database
   */
  async disconnect(): Promise<void> {
    try {
      if (this.pool) {
        await this.pool.close();
        this.connected = false;
        logger.info('Disconnected from MSSQL database', 'MSSQLConnector');
      }
    } catch (error) {
      logger.error('Error disconnecting from MSSQL', error as Error, 'MSSQLConnector');
    }
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Get all table names in database
   */
  async getTables(): Promise<string[]> {
    try {
      const request = this.pool?.request();
      if (!request) throw new Error('Connection pool not available');

      request.timeout = QUERY_TIMEOUT;
      const result = await request
        .query(`
          SELECT TABLE_NAME 
          FROM INFORMATION_SCHEMA.TABLES 
          WHERE TABLE_SCHEMA = 'dbo' 
          AND TABLE_TYPE = 'BASE TABLE'
          ORDER BY TABLE_NAME
        `);

      return result.recordset.map((row: any) => row.TABLE_NAME);
    } catch (error) {
      logger.error('Error retrieving table list', error as Error, 'MSSQLConnector');
      throw error;
    }
  }

  /**
   * Get table schema (columns and their definitions)
   */
  async getTableSchema(tableName: string): Promise<ColumnDefinition[]> {
    try {
      const request = this.pool?.request();
      if (!request) throw new Error('Connection pool not available');

      request.timeout = QUERY_TIMEOUT;
      const result = await request
        .input('tableName', sql.VarChar, tableName)
        .query(`
          SELECT
            c.COLUMN_NAME as name,
            c.DATA_TYPE as dataType,
            c.CHARACTER_MAXIMUM_LENGTH as maxLength,
            c.NUMERIC_PRECISION as precision,
            c.NUMERIC_SCALE as scale,
            CASE WHEN c.IS_NULLABLE = 'YES' THEN 1 ELSE 0 END as nullable,
            CASE 
              WHEN pk.COLUMN_NAME IS NOT NULL THEN 1 
              ELSE 0 
            END as isPrimaryKey,
            CASE 
              WHEN fk.COLUMN_NAME IS NOT NULL THEN 1 
              ELSE 0 
            END as isForeignKey,
            c.COLUMN_DEFAULT as defaultValue
          FROM INFORMATION_SCHEMA.COLUMNS c
          LEFT JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE pk
            ON c.TABLE_NAME = pk.TABLE_NAME 
            AND c.COLUMN_NAME = pk.COLUMN_NAME
            AND pk.CONSTRAINT_NAME LIKE 'PK_%'
          LEFT JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE fk
            ON c.TABLE_NAME = fk.TABLE_NAME 
            AND c.COLUMN_NAME = fk.COLUMN_NAME
            AND fk.CONSTRAINT_NAME LIKE 'FK_%'
          WHERE c.TABLE_NAME = @tableName
          AND c.TABLE_SCHEMA = 'dbo'
          ORDER BY c.ORDINAL_POSITION
        `);

      return result.recordset.map((col: any) => ({
        name: col.name,
        dataType: col.dataType,
        maxLength: col.maxLength,
        precision: col.precision,
        scale: col.scale,
        nullable: col.nullable === 1,
        isPrimaryKey: col.isPrimaryKey === 1,
        isForeignKey: col.isForeignKey === 1,
        defaultValue: col.defaultValue,
      }));
    } catch (error) {
      logger.error(`Error retrieving schema for table ${tableName}`, error as Error, 'MSSQLConnector');
      throw error;
    }
  }

  /**
   * Get row count for a table
   */
  async getRowCount(tableName: string): Promise<number> {
    try {
      const request = this.pool?.request();
      if (!request) throw new Error('Connection pool not available');

      request.timeout = QUERY_TIMEOUT;
      const result = await request
        .input('tableName', sql.VarChar, tableName)
        .query(
          `
          SELECT COUNT(*) as count 
          FROM [${tableName}]
        `
        );

      return result.recordset[0].count;
    } catch (error) {
      logger.error(`Error getting row count for table ${tableName}`, error as Error, 'MSSQLConnector');
      throw error;
    }
  }

  /**
   * Get data from table with pagination
   */
  async getData(
    tableName: string,
    offset: number = 0,
    limit: number = 5000,
    columnNames?: string[]
  ): Promise<Record<string, any>[]> {
    try {
      const request = this.pool?.request();
      if (!request) throw new Error('Connection pool not available');

      const columns = columnNames && columnNames.length > 0 ? columnNames.join(', ') : '*';

      request.timeout = QUERY_TIMEOUT;
      const result = await request
        .input('offset', sql.Int, offset)
        .input('limit', sql.Int, limit)
        .query(
          `
          SELECT ${columns}
          FROM [${tableName}]
          ORDER BY (SELECT NULL)
          OFFSET @offset ROWS
          FETCH NEXT @limit ROWS ONLY
        `
        );

      return result.recordset;
    } catch (error) {
      logger.error(`Error retrieving data from table ${tableName}`, error as Error, 'MSSQLConnector');
      throw error;
    }
  }

  /**
   * Stream table rows continuously using TDS stream with backpressure (no OFFSET/FETCH)
   */
  async streamTableRows(
    tableName: string,
    columnNames: string[],
    options: {
      whereClause?: string;
      batchSize?: number;
      onBatch: (rows: Record<string, any>[], batchNumber: number) => Promise<void>;
    }
  ): Promise<number> {
    if (!this.pool) throw new Error('MSSQL Connection pool not available');

    const batchSize = options.batchSize || 25000;
    const columns = columnNames && columnNames.length > 0 ? columnNames.map((c) => `[${c}]`).join(', ') : '*';
    const where = options.whereClause ? `WHERE ${options.whereClause}` : '';
    const sqlQuery = `SELECT ${columns} FROM [${tableName}] WITH (NOLOCK) ${where}`;

    logger.info(`Starting high-speed stream on [${tableName}] (batch size: ${batchSize})`, 'MSSQLConnector');

    return new Promise<number>((resolve, reject) => {
      let totalStreamed = 0;
      let batchNumber = 0;
      let currentBatch: Record<string, any>[] = [];
      let isFlushing = false;
      let isDone = false;
      let streamError: Error | null = null;

      const request = this.pool!.request();
      request.stream = true;
      request.timeout = 0; // Disable timeout for long-running streaming query

      const processBatch = async () => {
        if (currentBatch.length === 0 || isFlushing) return;
        isFlushing = true;
        request.pause();

        const batchToSend = currentBatch;
        currentBatch = [];
        batchNumber++;

        try {
          await options.onBatch(batchToSend, batchNumber);
          totalStreamed += batchToSend.length;
          isFlushing = false;

          if (isDone) {
            resolve(totalStreamed);
          } else {
            request.resume();
          }
        } catch (error) {
          isFlushing = false;
          try {
            request.cancel();
          } catch (_) { }
          reject(error);
        }
      };

      request.on('row', (row: Record<string, any>) => {
        currentBatch.push(row);
        if (currentBatch.length >= batchSize && !isFlushing) {
          processBatch();
        }
      });

      request.on('error', (err: any) => {
        streamError = err;
        logger.error(`Stream error on table ${tableName}: ${err.message}`, err, 'MSSQLConnector');
        reject(err);
      });

      request.on('done', async () => {
        isDone = true;
        if (streamError) return;

        if (currentBatch.length > 0) {
          await processBatch();
        } else if (!isFlushing) {
          resolve(totalStreamed);
        }
      });

      request.query(sqlQuery).catch((err) => {
        reject(err);
      });
    });
  }

  /**
   * Get maximum value of a column (used for incremental delta)
   */
  async getMaxValue(tableName: string, columnName: string): Promise<any> {
    try {
      const request = this.pool?.request();
      if (!request) throw new Error('Connection pool not available');

      request.timeout = QUERY_TIMEOUT;
      const result = await request.query(`
        SELECT MAX([${columnName}]) as maxVal
        FROM [${tableName}] WITH (NOLOCK)
      `);

      return result.recordset && result.recordset.length > 0 ? result.recordset[0].maxVal : null;
    } catch (error) {
      logger.error(`Error getting max value for [${tableName}].[${columnName}]`, error as Error, 'MSSQLConnector');
      throw error;
    }
  }

  /**
   * Get row count with custom WHERE filter
   */
  async getRowCountWithFilter(tableName: string, whereClause: string): Promise<number> {
    try {
      const request = this.pool?.request();
      if (!request) throw new Error('Connection pool not available');

      request.timeout = QUERY_TIMEOUT;
      const result = await request.query(`
        SELECT COUNT(*) as count 
        FROM [${tableName}] WITH (NOLOCK)
        WHERE ${whereClause}
      `);

      return result.recordset[0].count;
    } catch (error) {
      logger.error(`Error getting filtered row count for [${tableName}]`, error as Error, 'MSSQLConnector');
      throw error;
    }
  }

  /**
   * Get data stream from table (for large tables)
   */
  async getDataStream(tableName: string, batchSize: number = 5000): Promise<AsyncIterableIterator<Record<string, any>[]>> {
    const self = this;
    let offset = 0;

    return (async function* () {
      while (true) {
        try {
          const data = await self.getData(tableName, offset, batchSize);
          if (data.length === 0) break;

          yield data;
          offset += data.length;

          if (data.length < batchSize) break;
        } catch (error) {
          logger.error(`Error streaming data from table ${tableName}`, error as Error, 'MSSQLConnector');
          throw error;
        }
      }
    })();
  }

  /**
   * Get primary key column names for a table
   */
  async getPrimaryKeys(tableName: string): Promise<string[]> {
    try {
      const schema = await this.getTableSchema(tableName);
      return schema.filter((col) => col.isPrimaryKey).map((col) => col.name);
    } catch (error) {
      logger.error(`Error getting primary keys for table ${tableName}`, error as Error, 'MSSQLConnector');
      throw error;
    }
  }

  /**
   * Execute custom query
   */
  async executeQuery(query: string, parameters?: Record<string, any>): Promise<Record<string, any>[]> {
    try {
      let request = this.pool?.request();
      if (!request) throw new Error('Connection pool not available');

      if (parameters) {
        for (const [key, value] of Object.entries(parameters)) {
          request = request.input(key, value);
        }
      }

      request.timeout = QUERY_TIMEOUT;
      const result = await request.query(query);
      return result.recordset;
    } catch (error) {
      logger.error('Error executing custom query', error as Error, 'MSSQLConnector');
      throw error;
    }
  }
}

export const mssqlConnector = new MSSQLConnector();
