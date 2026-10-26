/**
 * Oracle Connector - Handles connections and queries to Oracle
 */

/// <reference path="../types/declarations.d.ts" />

import oracledb = require('oracledb');
import { oracleConfig } from '../config/database.config';
import { logger } from '../utils/logger';
import { ErrorHandler } from '../utils/error-handler';
import { pendingAdjustmentsService } from '../services/pending-adjustments.service';

oracledb.autoCommit = false;

export class OracleConnector {
  private pool: oracledb.Pool | null = null;
  private connected: boolean = false;

  /**
   * Connect to Oracle database
   */
  async connect(): Promise<void> {
    try {
      if (oracleConfig.libDir) {
        try {
          oracledb.initOracleClient({ libDir: oracleConfig.libDir });
          logger.info(`Oracle client initialized in Thick mode using: ${oracleConfig.libDir}`, 'OracleConnector');
        } catch (err) {
          if (!(err as Error).message.includes('already')) {
            throw err;
          }
        }
      }

      this.pool = await oracledb.createPool({
        connectionString: oracleConfig.connectionString,
        user: oracleConfig.user,
        password: oracleConfig.password,
        max: Math.max(30, oracleConfig.pool.max),
        min: oracleConfig.pool.min,
        queueTimeout: 300000, // 5 minutes queue timeout (default was 60s)
        poolTimeout: 120,
      });
      this.connected = true;
      logger.info('Connected to Oracle database', 'OracleConnector');
    } catch (error) {
      const migrationError = ErrorHandler.handleConnectionError('Oracle', error as Error);
      throw migrationError;
    }
  }

  /**
   * Disconnect from Oracle database
   */
  async disconnect(): Promise<void> {
    try {
      if (this.pool) {
        await this.pool.close(0);
        this.connected = false;
        logger.info('Disconnected from Oracle database', 'OracleConnector');
      }
    } catch (error) {
      logger.error('Error disconnecting from Oracle', error as Error, 'OracleConnector');
    }
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Get connection from pool
   */
  async getConnection(): Promise<oracledb.Connection> {
    try {
      if (!this.pool) throw new Error('Connection pool not available');
      return await this.pool.getConnection();
    } catch (error) {
      logger.error('Error getting connection from pool', error as Error, 'OracleConnector');
      throw error;
    }
  }

  /**
   * Insert batch of rows
   */
  async insertBatch(
    tableName: string,
    columnNames: string[],
    rows: Record<string, any>[],
    _connection?: oracledb.Connection
  ): Promise<number> {
    if (rows.length === 0) return 0;
    return await this.insertBatchTransaction(tableName, columnNames, rows);
  }

  /**
   * Insert batch with transaction and row error isolation (preserves full data fidelity)
   */
  async insertBatchTransaction(
    tableName: string,
    columnNames: string[],
    rows: Record<string, any>[]
  ): Promise<number> {
    if (rows.length === 0) return 0;
    const conn = await this.getConnection();

    try {
      const placeholders = columnNames.map((_, i) => `:${i + 1}`).join(', ');
      const sql = `INSERT INTO "${tableName.toUpperCase()}" (${columnNames.map((c) => `"${c.toUpperCase()}"`).join(', ')}) VALUES (${placeholders})`;

      const binds = rows.map((row) =>
        columnNames.map((col) => (row[col] === undefined ? null : row[col]))
      );

      // Execute with batchErrors: true so valid rows succeed while row-level errors (ORA-12899, etc.) are captured without aborting
      const result: any = await conn.executeMany(sql, binds, {
        autoCommit: false,
        batchErrors: true,
      });

      let failedCount = 0;
      if (result.batchErrors && result.batchErrors.length > 0) {
        failedCount = result.batchErrors.length;
        for (const bErr of result.batchErrors) {
          const failedRow = rows[bErr.offset];
          const parsed = pendingAdjustmentsService.parseOracleError(bErr.message);

          pendingAdjustmentsService.recordAdjustment({
            id: `${tableName}_${Date.now()}_${bErr.offset}`,
            tableName: tableName.toUpperCase(),
            columnName: parsed.columnName,
            actualLength: parsed.actualLength,
            maxLength: parsed.maxLength,
            errorNum: bErr.errorNum,
            errorMessage: bErr.message,
            rowData: failedRow,
            timestamp: new Date().toISOString(),
          });
        }
        logger.warn(
          `Batch for ${tableName} had ${failedCount} row(s) with errors. Recorded in logs/pending-adjustments.json without altering data. Committing valid rows...`,
          'OracleConnector'
        );
      }

      await conn.commit();
      const insertedCount = result.rowsAffected !== undefined ? result.rowsAffected : rows.length - failedCount;
      logger.info(
        `Batch of ${insertedCount} rows inserted into ${tableName} (${failedCount} marked for post-migration adjustment)`,
        'OracleConnector'
      );
      return insertedCount;
    } catch (error) {
      await conn.rollback();
      logger.warn(
        `Batch executeMany failed for ${tableName} (${(error as Error).message}). Retrying row-by-row to isolate and preserve error rows...`,
        'OracleConnector'
      );
      return await this.insertRowByRowFallback(conn, tableName, columnNames, rows);
    } finally {
      await conn.close();
    }
  }

  /**
   * Fallback row-by-row insertion when executeMany encounters a statement-level failure
   */
  private async insertRowByRowFallback(
    conn: oracledb.Connection,
    tableName: string,
    columnNames: string[],
    rows: Record<string, any>[]
  ): Promise<number> {
    const placeholders = columnNames.map((_, i) => `:${i + 1}`).join(', ');
    const sql = `INSERT INTO "${tableName.toUpperCase()}" (${columnNames.map((c) => `"${c.toUpperCase()}"`).join(', ')}) VALUES (${placeholders})`;

    let inserted = 0;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const bind = columnNames.map((col) => (row[col] === undefined ? null : row[col]));
      try {
        await conn.execute(sql, bind, { autoCommit: false });
        inserted++;
      } catch (rowErr) {
        const err = rowErr as Error;
        const parsed = pendingAdjustmentsService.parseOracleError(err.message);
        pendingAdjustmentsService.recordAdjustment({
          id: `${tableName}_${Date.now()}_${i}`,
          tableName: tableName.toUpperCase(),
          columnName: parsed.columnName,
          actualLength: parsed.actualLength,
          maxLength: parsed.maxLength,
          errorMessage: err.message,
          rowData: row,
          timestamp: new Date().toISOString(),
        });
        logger.warn(`Row in ${tableName} failed: ${err.message}`, 'OracleConnector');
      }
    }
    await conn.commit();
    logger.info(`Fallback row-by-row completed for ${tableName}: ${inserted}/${rows.length} inserted`, 'OracleConnector');
    return inserted;
  }

  /**
   * Merge batch of rows (Upsert: update if exists, insert if not) with error isolation
   */
  async mergeBatchTransaction(
    tableName: string,
    columnNames: string[],
    pkColumns: string[],
    rows: Record<string, any>[]
  ): Promise<number> {
    if (rows.length === 0) return 0;
    const conn = await this.getConnection();

    try {
      const upperPkCols = pkColumns.map((k) => k.toUpperCase());
      const nonPkCols = columnNames.filter((col) => !upperPkCols.includes(col.toUpperCase()));

      // Construct USING (SELECT :1 AS COL1, :2 AS COL2, ... FROM DUAL)
      const selectDualCols = columnNames.map((col, i) => `:${i + 1} AS "${col.toUpperCase()}"`).join(', ');

      // Construct ON (t.PK1 = s.PK1 AND ...)
      const onCondition = pkColumns
        .map((pk) => `t."${pk.toUpperCase()}" = s."${pk.toUpperCase()}"`)
        .join(' AND ');

      // Construct INSERT
      const insertCols = columnNames.map((col) => `"${col.toUpperCase()}"`).join(', ');
      const insertVals = columnNames.map((col) => `s."${col.toUpperCase()}"`).join(', ');

      let sql = `
        MERGE INTO "${tableName.toUpperCase()}" t
        USING (SELECT ${selectDualCols} FROM DUAL) s
        ON (${onCondition})
      `;

      // If there are non-PK columns, add WHEN MATCHED UPDATE
      if (nonPkCols.length > 0) {
        const updateSets = nonPkCols
          .map((col) => `t."${col.toUpperCase()}" = s."${col.toUpperCase()}"`)
          .join(', ');
        sql += `
          WHEN MATCHED THEN
            UPDATE SET ${updateSets}
        `;
      }

      sql += `
        WHEN NOT MATCHED THEN
          INSERT (${insertCols})
          VALUES (${insertVals})
      `;

      const binds = rows.map((row) =>
        columnNames.map((col) => (row[col] === undefined ? null : row[col]))
      );

      const result: any = await conn.executeMany(sql, binds, {
        autoCommit: false,
        batchErrors: true,
      });

      let failedCount = 0;
      if (result.batchErrors && result.batchErrors.length > 0) {
        failedCount = result.batchErrors.length;
        for (const bErr of result.batchErrors) {
          const failedRow = rows[bErr.offset];
          const parsed = pendingAdjustmentsService.parseOracleError(bErr.message);

          pendingAdjustmentsService.recordAdjustment({
            id: `${tableName}_${Date.now()}_${bErr.offset}`,
            tableName: tableName.toUpperCase(),
            columnName: parsed.columnName,
            actualLength: parsed.actualLength,
            maxLength: parsed.maxLength,
            errorNum: bErr.errorNum,
            errorMessage: bErr.message,
            rowData: failedRow,
            timestamp: new Date().toISOString(),
          });
        }
        logger.warn(
          `Merge batch for ${tableName} had ${failedCount} row(s) with errors. Recorded in logs/pending-adjustments.json.`,
          'OracleConnector'
        );
      }

      await conn.commit();
      const mergedCount = result.rowsAffected !== undefined ? result.rowsAffected : rows.length - failedCount;
      logger.info(`Batch of ${mergedCount} rows merged (upserted) into ${tableName}`, 'OracleConnector');
      return mergedCount;
    } catch (error) {
      await conn.rollback();
      logger.error(`Error merging batch into table ${tableName}`, error as Error, 'OracleConnector');
      throw error;
    } finally {
      await conn.close();
    }
  }

  /**
   * Truncate table fast (falling back to DELETE if table is referenced by active foreign key)
   */
  async truncateTable(tableName: string): Promise<void> {
    const conn = await this.getConnection();

    try {
      await conn.execute(`TRUNCATE TABLE "${tableName.toUpperCase()}"`);
      logger.info(`Table ${tableName} truncated successfully`, 'OracleConnector');
    } catch (error) {
      logger.warn(
        `Direct TRUNCATE failed for ${tableName} (${(error as Error).message}). Disabling referencing constraints and retrying...`,
        'OracleConnector'
      );
      try {
        // Find and disable any enabled foreign keys that reference this table (child foreign keys)
        const refFkSql = `
          SELECT c_child.table_name, c_child.constraint_name
          FROM user_constraints c_parent
          JOIN user_constraints c_child ON c_child.r_constraint_name = c_parent.constraint_name
          WHERE c_parent.table_name = :1
            AND c_parent.constraint_type IN ('P', 'U')
            AND c_child.constraint_type = 'R'
            AND c_child.status = 'ENABLED'
        `;
        const refResult = await conn.execute(refFkSql, [tableName.toUpperCase()]);
        if (refResult.rows && refResult.rows.length > 0) {
          for (const row of refResult.rows) {
            const childTable = (row as any)[0];
            const childFk = (row as any)[1];
            try {
              await conn.execute(`ALTER TABLE "${childTable}" DISABLE CONSTRAINT "${childFk}"`);
              logger.info(`Disabled referencing FK ${childFk} on ${childTable}`, 'OracleConnector');
            } catch (err) {
              logger.warn(`Could not disable referencing FK ${childFk}: ${(err as Error).message}`, 'OracleConnector');
            }
          }
        }

        // Retry TRUNCATE now that referencing FKs are disabled
        await conn.execute(`TRUNCATE TABLE "${tableName.toUpperCase()}"`);
        logger.info(`Table ${tableName} truncated successfully after disabling referencing FKs`, 'OracleConnector');
      } catch (truncRetryError) {
        logger.warn(
          `TRUNCATE retry failed for ${tableName} (${(truncRetryError as Error).message}). Executing fallback DELETE...`,
          'OracleConnector'
        );
        try {
          await conn.execute(`DELETE FROM "${tableName.toUpperCase()}"`);
          await conn.commit();
          logger.info(`Table ${tableName} cleared via fallback DELETE`, 'OracleConnector');
        } catch (deleteError) {
          await conn.rollback();
          throw deleteError;
        }
      }
    } finally {
      await conn.close();
    }
  }

  /**
   * Create error log table if it doesn't exist
   */
  async createErrorLogTable(): Promise<void> {
    const conn = await this.getConnection();

    try {
      await conn.execute(`
        CREATE TABLE IF NOT EXISTS migration_errors (
          error_id VARCHAR2(100) PRIMARY KEY,
          error_type VARCHAR2(50),
          severity VARCHAR2(20),
          message VARCHAR2(2000),
          source_table VARCHAR2(100),
          row_id VARCHAR2(100),
          column_name VARCHAR2(100),
          error_value VARCHAR2(2000),
          expected_format VARCHAR2(500),
          timestamp TIMESTAMP,
          recoverable NUMBER(1),
          retry_count NUMBER(3)
        )
      `);

      await conn.commit();
      logger.info('Error log table created', 'OracleConnector');
    } catch (error) {
      // Table might already exist
      logger.debug('Error log table creation skipped (may already exist)', 'OracleConnector');
    } finally {
      await conn.close();
    }
  }

  /**
   * Log error to Oracle
   */
  async logError(error: any): Promise<void> {
    const conn = await this.getConnection();

    try {
      const sql = `
        INSERT INTO migration_errors (
          error_id, error_type, severity, message, source_table, 
          row_id, column_name, error_value, expected_format, 
          timestamp, recoverable, retry_count
        ) VALUES (:1, :2, :3, :4, :5, :6, :7, :8, :9, :10, :11, :12)
      `;

      const values = [
        error.id,
        error.type,
        error.severity,
        error.message,
        error.source,
        error.rowId || null,
        error.column || null,
        JSON.stringify(error.value) || null,
        error.expectedFormat || null,
        new Date(),
        error.recoverable ? 1 : 0,
        error.retryCount || 0,
      ];

      await conn.execute(sql, values);
      await conn.commit();
    } catch (error) {
      await conn.rollback();
      logger.error('Error logging error to Oracle', error as Error, 'OracleConnector');
    } finally {
      await conn.close();
    }
  }

  /**
   * Check if table exists
   */
  async tableExists(tableName: string): Promise<boolean> {
    const conn = await this.getConnection();

    try {
      const result = await conn.execute(
        `
        SELECT COUNT(*) as count 
        FROM all_tables 
        WHERE table_name = :1
      `,
        [tableName.toUpperCase()]
      );

      return result.rows && result.rows[0][0] > 0;
    } catch (error) {
      logger.error(`Error checking if table ${tableName} exists`, error as Error, 'OracleConnector');
      throw error;
    } finally {
      await conn.close();
    }
  }

  /**
   * Get row count
   */
  async getRowCount(tableName: string): Promise<number> {
    const conn = await this.getConnection();

    try {
      const result = await conn.execute(`SELECT COUNT(*) as count FROM ${tableName}`);
      return result.rows ? result.rows[0][0] : 0;
    } catch (error) {
      logger.error(`Error getting row count from ${tableName}`, error as Error, 'OracleConnector');
      throw error;
    } finally {
      await conn.close();
    }
  }

  /**
   * Disable constraints (Triggers, Foreign Keys on table, and Foreign Keys on other tables referencing this table)
   */
  async disableConstraints(tableName: string): Promise<void> {
    const conn = await this.getConnection();
    const upperTable = tableName.toUpperCase();

    try {
      // 1. Disable triggers on table
      try {
        await conn.execute(`ALTER TABLE "${upperTable}" DISABLE ALL TRIGGERS`);
      } catch (triggerErr) {
        logger.debug(`No triggers to disable on ${upperTable}`, 'OracleConnector');
      }

      // 2. Disable Foreign Keys on this table (outgoing)
      const outgoingFkSql = `
        SELECT constraint_name 
        FROM user_constraints 
        WHERE table_name = :1 AND constraint_type = 'R' AND status = 'ENABLED'
      `;
      const outgoingResult = await conn.execute(outgoingFkSql, [upperTable]);

      if (outgoingResult.rows && outgoingResult.rows.length > 0) {
        for (const row of outgoingResult.rows) {
          const constraintName = (row as any)[0];
          try {
            await conn.execute(`ALTER TABLE "${upperTable}" DISABLE CONSTRAINT "${constraintName}"`);
          } catch (_) { }
        }
      }

      // 3. Disable Foreign Keys on OTHER tables referencing this table (incoming)
      const incomingFkSql = `
        SELECT c_child.table_name, c_child.constraint_name
        FROM user_constraints c_parent
        JOIN user_constraints c_child ON c_child.r_constraint_name = c_parent.constraint_name
        WHERE c_parent.table_name = :1
          AND c_parent.constraint_type IN ('P', 'U')
          AND c_child.constraint_type = 'R'
          AND c_child.status = 'ENABLED'
      `;
      const incomingResult = await conn.execute(incomingFkSql, [upperTable]);

      if (incomingResult.rows && incomingResult.rows.length > 0) {
        for (const row of incomingResult.rows) {
          const childTable = (row as any)[0];
          const childFk = (row as any)[1];
          try {
            await conn.execute(`ALTER TABLE "${childTable}" DISABLE CONSTRAINT "${childFk}"`);
          } catch (_) { }
        }
      }

      await conn.commit();
      logger.info(`Constraints and triggers disabled for table ${upperTable}`, 'OracleConnector');
    } catch (error) {
      logger.warn(`Could not fully disable constraints for ${upperTable}: ${(error as Error).message}`, 'OracleConnector');
    } finally {
      await conn.close();
    }
  }

  /**
   * Enable constraints (Triggers, Foreign Keys on table, and referencing Foreign Keys with NOVALIDATE for speed)
   */
  async enableConstraints(tableName: string): Promise<void> {
    const conn = await this.getConnection();
    const upperTable = tableName.toUpperCase();

    try {
      // 1. Enable Foreign Keys on this table with NOVALIDATE (fast)
      const outgoingFkSql = `
        SELECT constraint_name 
        FROM user_constraints 
        WHERE table_name = :1 AND constraint_type = 'R' AND status = 'DISABLED'
      `;
      const outgoingResult = await conn.execute(outgoingFkSql, [upperTable]);

      if (outgoingResult.rows && outgoingResult.rows.length > 0) {
        for (const row of outgoingResult.rows) {
          const constraintName = (row as any)[0];
          try {
            await conn.execute(`ALTER TABLE "${upperTable}" ENABLE NOVALIDATE CONSTRAINT "${constraintName}"`);
          } catch (_) { }
        }
      }

      // 2. Enable Foreign Keys on OTHER tables referencing this table with NOVALIDATE
      const incomingFkSql = `
        SELECT c_child.table_name, c_child.constraint_name
        FROM user_constraints c_parent
        JOIN user_constraints c_child ON c_child.r_constraint_name = c_parent.constraint_name
        WHERE c_parent.table_name = :1
          AND c_parent.constraint_type IN ('P', 'U')
          AND c_child.constraint_type = 'R'
          AND c_child.status = 'DISABLED'
      `;
      const incomingResult = await conn.execute(incomingFkSql, [upperTable]);

      if (incomingResult.rows && incomingResult.rows.length > 0) {
        for (const row of incomingResult.rows) {
          const childTable = (row as any)[0];
          const childFk = (row as any)[1];
          try {
            await conn.execute(`ALTER TABLE "${childTable}" ENABLE NOVALIDATE CONSTRAINT "${childFk}"`);
          } catch (_) { }
        }
      }

      // 3. Enable triggers on table
      try {
        await conn.execute(`ALTER TABLE "${upperTable}" ENABLE ALL TRIGGERS`);
      } catch (triggerErr) {
        logger.debug(`No triggers to enable on ${upperTable}`, 'OracleConnector');
      }

      await conn.commit();
      logger.info(`Constraints and triggers enabled for table ${upperTable}`, 'OracleConnector');
    } catch (error) {
      logger.warn(`Could not fully enable constraints for ${upperTable}: ${(error as Error).message}`, 'OracleConnector');
    } finally {
      await conn.close();
    }
  }

  /**
   * Disable ALL foreign key constraints in the entire user schema
   */
  async disableAllSchemaConstraints(): Promise<{ disabled: number; errors: number }> {
    const conn = await this.getConnection();
    let disabled = 0;
    let errors = 0;

    try {
      logger.info('Querying all enabled foreign keys across Oracle schema...', 'OracleConnector');
      const fkSql = `
        SELECT table_name, constraint_name 
        FROM user_constraints 
        WHERE constraint_type = 'R' AND status = 'ENABLED'
      `;
      const result = await conn.execute(fkSql);

      if (result.rows && result.rows.length > 0) {
        logger.info(`Found ${result.rows.length} active foreign keys to disable across schema`, 'OracleConnector');
        for (const row of result.rows) {
          const tableName = (row as any)[0];
          const constraintName = (row as any)[1];
          try {
            await conn.execute(`ALTER TABLE "${tableName}" DISABLE CONSTRAINT "${constraintName}"`);
            disabled++;
          } catch (err) {
            errors++;
            logger.debug(`Failed to disable FK ${constraintName} on ${tableName}: ${(err as Error).message}`, 'OracleConnector');
          }
        }
      }

      // Also disable all user triggers
      await this.disableAllTriggers(conn);

      await conn.commit();
      logger.info(`Schema constraints disabled: ${disabled} foreign keys disabled (${errors} errors)`, 'OracleConnector');
      return { disabled, errors };
    } catch (error) {
      logger.warn(`Could not fully disable schema constraints: ${(error as Error).message}`, 'OracleConnector');
      return { disabled, errors };
    } finally {
      await conn.close();
    }
  }

  /**
   * Enable ALL foreign key constraints in the entire user schema (with NOVALIDATE for maximum speed)
   */
  async enableAllSchemaConstraints(): Promise<{ enabled: number; errors: number }> {
    const conn = await this.getConnection();
    let enabled = 0;
    let errors = 0;

    try {
      logger.info('Querying disabled foreign keys across Oracle schema to re-enable...', 'OracleConnector');
      const fkSql = `
        SELECT table_name, constraint_name 
        FROM user_constraints 
        WHERE constraint_type = 'R' AND status = 'DISABLED'
      `;
      const result = await conn.execute(fkSql);

      if (result.rows && result.rows.length > 0) {
        logger.info(`Found ${result.rows.length} disabled foreign keys to re-enable with NOVALIDATE`, 'OracleConnector');
        for (const row of result.rows) {
          const tableName = (row as any)[0];
          const constraintName = (row as any)[1];
          try {
            await conn.execute(`ALTER TABLE "${tableName}" ENABLE NOVALIDATE CONSTRAINT "${constraintName}"`);
            enabled++;
          } catch (err) {
            errors++;
            logger.debug(`Failed to enable FK ${constraintName} on ${tableName}: ${(err as Error).message}`, 'OracleConnector');
          }
        }
      }

      // Also re-enable all user triggers
      await this.enableAllTriggers(conn);

      await conn.commit();
      logger.info(`Schema constraints enabled: ${enabled} foreign keys re-enabled with NOVALIDATE (${errors} errors)`, 'OracleConnector');
      return { enabled, errors };
    } catch (error) {
      logger.warn(`Could not fully enable schema constraints: ${(error as Error).message}`, 'OracleConnector');
      return { enabled, errors };
    } finally {
      await conn.close();
    }
  }

  /**
   * Disable all triggers in the schema
   */
  async disableAllTriggers(existingConn?: oracledb.Connection): Promise<number> {
    const conn = existingConn || (await this.getConnection());
    let disabled = 0;

    try {
      const sql = `SELECT trigger_name FROM user_triggers WHERE status = 'ENABLED'`;
      const result = await conn.execute(sql);

      if (result.rows && result.rows.length > 0) {
        for (const row of result.rows) {
          const triggerName = (row as any)[0];
          try {
            await conn.execute(`ALTER TRIGGER "${triggerName}" DISABLE`);
            disabled++;
          } catch (_) {}
        }
        logger.info(`Disabled ${disabled} schema triggers`, 'OracleConnector');
      }
      return disabled;
    } catch (error) {
      logger.debug(`No triggers disabled or query failed: ${(error as Error).message}`, 'OracleConnector');
      return 0;
    } finally {
      if (!existingConn) {
        await conn.close();
      }
    }
  }

  /**
   * Enable all triggers in the schema
   */
  async enableAllTriggers(existingConn?: oracledb.Connection): Promise<number> {
    const conn = existingConn || (await this.getConnection());
    let enabled = 0;

    try {
      const sql = `SELECT trigger_name FROM user_triggers WHERE status = 'DISABLED'`;
      const result = await conn.execute(sql);

      if (result.rows && result.rows.length > 0) {
        for (const row of result.rows) {
          const triggerName = (row as any)[0];
          try {
            await conn.execute(`ALTER TRIGGER "${triggerName}" ENABLE`);
            enabled++;
          } catch (_) {}
        }
        logger.info(`Enabled ${enabled} schema triggers`, 'OracleConnector');
      }
      return enabled;
    } catch (error) {
      logger.debug(`No triggers enabled or query failed: ${(error as Error).message}`, 'OracleConnector');
      return 0;
    } finally {
      if (!existingConn) {
        await conn.close();
      }
    }
  }

  /**
   * Get all user table names existing in the target Oracle database (1 fast query)
   */
  async getAllTableNames(): Promise<string[]> {
    const conn = await this.getConnection();

    try {
      const result = await conn.execute(`SELECT table_name FROM user_tables ORDER BY table_name`);
      return result.rows ? (result.rows as any[]).map((r) => r[0].toUpperCase()) : [];
    } catch (error) {
      logger.error('Error getting all table names from Oracle', error as Error, 'OracleConnector');
      return [];
    } finally {
      await conn.close();
    }
  }

  /**
   * Get maximum value of a column in Oracle
   */
  async getMaxValue(tableName: string, columnName: string): Promise<any> {
    const conn = await this.getConnection();

    try {
      const result = await conn.execute(`SELECT MAX("${columnName.toUpperCase()}") as max_val FROM "${tableName.toUpperCase()}"`);
      return result.rows && result.rows.length > 0 ? (result.rows as any)[0][0] : null;
    } catch (error) {
      logger.warn(`Could not get max value for ${tableName}.${columnName} from Oracle`, 'OracleConnector');
      return null;
    } finally {
      await conn.close();
    }
  }

  /**
   * Get primary key columns for a table in Oracle
   */
  async getTablePrimaryKeys(tableName: string): Promise<string[]> {
    const conn = await this.getConnection();

    try {
      const sql = `
        SELECT cols.column_name
        FROM user_constraints cons
        JOIN user_cons_columns cols ON cons.constraint_name = cols.constraint_name
        WHERE cons.constraint_type = 'P'
          AND cons.table_name = :1
        ORDER BY cols.position
      `;
      const result = await conn.execute(sql, [tableName.toUpperCase()]);
      return result.rows ? (result.rows as any[]).map((r) => r[0].toUpperCase()) : [];
    } catch (error) {
      logger.warn(`Could not get primary keys for ${tableName} from Oracle`, 'OracleConnector');
      return [];
    } finally {
      await conn.close();
    }
  }

  /**
   * Execute custom query
   */
  async executeQuery(sql: string, parameters?: any[]): Promise<any> {
    const conn = await this.getConnection();

    try {
      const result = await conn.execute(sql, parameters || []);
      console.log(sql)
      await conn.commit();
      return result;
    } catch (error) {
      await conn.rollback();
      logger.error('Error executing custom query', error as Error, 'OracleConnector', { sql, parameters });
      throw error;
    } finally {
      await conn.close();
    }
  }

  /**
   * Get detailed column metadata for a table in Oracle (nullability, data type, etc.)
   */
  async getTableColumnsMetadata(
    tableName: string
  ): Promise<Map<string, { name: string; nullable: boolean; dataType: string; dataLength: number }>> {
    const conn = await this.getConnection();
    const metaMap = new Map<string, { name: string; nullable: boolean; dataType: string; dataLength: number }>();

    try {
      // First check user_tab_columns (fastest, current schema)
      let result = await conn.execute(
        `
        SELECT column_name, nullable, data_type, COALESCE(char_length, data_length, 0) as max_len 
        FROM user_tab_columns 
        WHERE table_name = :1
      `,
        [tableName.toUpperCase()]
      );

      // Fallback to all_tab_columns if not found in user_tab_columns
      if (!result.rows || result.rows.length === 0) {
        result = await conn.execute(
          `
          SELECT column_name, nullable, data_type, COALESCE(char_length, data_length, 0) as max_len 
          FROM all_tab_columns 
          WHERE table_name = :1
        `,
          [tableName.toUpperCase()]
        );
      }

      if (result.rows && result.rows.length > 0) {
        for (const row of result.rows) {
          const colName = String((row as any)[0]).toUpperCase();
          const nullable = (row as any)[1] === 'Y';
          const dataType = String((row as any)[2] || '').toUpperCase();
          const dataLength = Number((row as any)[3] || 0);
          metaMap.set(colName, { name: colName, nullable, dataType, dataLength });
        }
      }
      return metaMap;
    } catch (error) {
      logger.error(`Error getting column metadata for table ${tableName} from Oracle`, error as Error, 'OracleConnector');
      return metaMap;
    } finally {
      await conn.close();
    }
  }

  /**
   * Get column names for a table in Oracle
   */
  async getTableColumns(tableName: string): Promise<string[]> {
    const meta = await this.getTableColumnsMetadata(tableName);
    return Array.from(meta.keys());
  }
}

export const oracleConnector = new OracleConnector();

