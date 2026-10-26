/**
 * Data Insertion Service - Inserts transformed data into Oracle
 */

import { oracleConnector } from '../connectors/oracle.connector';
import { Table } from '../models/table.model';
import { logger } from '../utils/logger';
import { migrationConfig } from '../config/migration.config';

export class DataInsertionService {
  /**
   * Insert batch of rows into Oracle
   */
  async insertBatch(tableName: string, columnNames: string[], rows: Record<string, any>[]): Promise<number> {
    try {
      if (rows.length === 0) {
        return 0;
      }

      const insertedCount = await oracleConnector.insertBatchTransaction(tableName, columnNames, rows);

      logger.debug(`Inserted ${insertedCount} rows into ${tableName}`, 'DataInsertionService');

      return insertedCount;
    } catch (error) {
      logger.error(`Error inserting batch into ${tableName}`, error as Error, 'DataInsertionService');
      throw error;
    }
  }

  /**
   * Insert row by row (safer for constraints)
   */
  async insertRowByRow(tableName: string, columnNames: string[], rows: Record<string, any>[]): Promise<{ inserted: number; failed: number }> {
    try {
      let insertedCount = 0;
      let failedCount = 0;

      for (const row of rows) {
        try {
          await oracleConnector.insertBatchTransaction(tableName, columnNames, [row]);
          insertedCount++;
        } catch (error) {
          failedCount++;
          logger.warn(`Failed to insert row into ${tableName}: ${(error as Error).message}`, 'DataInsertionService');
        }
      }

      logger.debug(
        `Inserted ${insertedCount}/${rows.length} rows into ${tableName}, ${failedCount} failed`,
        'DataInsertionService'
      );

      return { inserted: insertedCount, failed: failedCount };
    } catch (error) {
      logger.error(`Error in row-by-row insertion in ${tableName}`, error as Error, 'DataInsertionService');
      throw error;
    }
  }

  /**
   * Merge batch of rows into Oracle (Upsert)
   */
  async mergeBatch(
    tableName: string,
    columnNames: string[],
    pkColumns: string[],
    rows: Record<string, any>[]
  ): Promise<number> {
    try {
      if (rows.length === 0) {
        return 0;
      }

      const mergedCount = await oracleConnector.mergeBatchTransaction(tableName, columnNames, pkColumns, rows);

      logger.debug(`Merged ${mergedCount} rows into ${tableName}`, 'DataInsertionService');

      return mergedCount;
    } catch (error) {
      logger.error(`Error merging batch into ${tableName}`, error as Error, 'DataInsertionService');
      throw error;
    }
  }

  /**
   * Prepare table for data insertion
   */
  async prepareTableForInsertion(table: Table, shouldClearData: boolean = true): Promise<void> {
    try {
      logger.info(`Preparing table ${table.name} for insertion (clearData: ${shouldClearData})`, 'DataInsertionService');

      // Check if table exists in Oracle
      const tableExists = await oracleConnector.tableExists(table.name);
      if (!tableExists) {
        logger.warn(`Target table ${table.name} does not exist in Oracle database, skipping preparation`, 'DataInsertionService');
        return;
      }

      // Disable constraints if configured
      if (migrationConfig.disableConstraints) {
        await oracleConnector.disableConstraints(table.name);
      }

      // Clear existing table data only if requested (e.g. initial full load or fast reload)
      if (shouldClearData) {
        if (migrationConfig.useTruncate) {
          await oracleConnector.truncateTable(table.name);
        } else {
          await this.clearTable(table.name);
        }
      }

      logger.info(`Table ${table.name} prepared for insertion`, 'DataInsertionService');
    } catch (error) {
      logger.error(`Error preparing table ${table.name}`, error as Error, 'DataInsertionService');
      throw error;
    }
  }

  /**
   * Finalize table after insertion
   */
  async finalizeTableAfterInsertion(table: Table): Promise<void> {
    try {
      logger.info(`Finalizing table ${table.name} after insertion`, 'DataInsertionService');

      // Re-enable constraints if configured
      if (migrationConfig.disableConstraints) {
        await oracleConnector.enableConstraints(table.name);
      }

      // Verify row count
      const count = await oracleConnector.getRowCount(table.name);
      logger.info(`Table ${table.name} finalized. Total rows in Oracle: ${count}`, 'DataInsertionService');
    } catch (error) {
      logger.error(`Error finalizing table ${table.name}`, error as Error, 'DataInsertionService');
      throw error;
    }
  }

  /**
   * Verify data insertion
   */
  async verifyInsertion(table: Table, expectedRowCount: number): Promise<boolean> {
    try {
      const actualRowCount = await oracleConnector.getRowCount(table.name);

      if (actualRowCount >= expectedRowCount) {
        logger.info(`Data verification passed for ${table.name}. Target rows: ${actualRowCount}, Processed: ${expectedRowCount}`, 'DataInsertionService');
        return true;
      } else {
        logger.warn(
          `Data verification notice for ${table.name}. Expected at least: ${expectedRowCount}, Actual: ${actualRowCount}`,
          'DataInsertionService'
        );
        return false;
      }
    } catch (error) {
      logger.error(`Error verifying insertion for ${table.name}`, error as Error, 'DataInsertionService');
      throw error;
    }
  }

  /**
   * Clear table
   */
  async clearTable(tableName: string): Promise<void> {
    try {
      await oracleConnector.executeQuery(`DELETE FROM ${tableName}`);
      logger.info(`Table ${tableName} cleared`, 'DataInsertionService');
    } catch (error) {
      logger.error(`Error clearing table ${tableName}`, error as Error, 'DataInsertionService');
      throw error;
    }
  }
}

export const dataInsertionService = new DataInsertionService();
