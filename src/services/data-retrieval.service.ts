/**
 * Data Retrieval Service - Fetches data from MSSQL
 */

import { mssqlConnector } from '../connectors/mssql.connector';
import { Table } from '../models/table.model';
import { logger } from '../utils/logger';

export class DataRetrievalService {
  /**
   * Retrieve data from table with pagination
   */
  async getTableData(table: Table, offset: number = 0, limit: number = 5000): Promise<Record<string, any>[]> {
    try {
      const columnNames = table.columns.map((col) => col.name);
      const data = await mssqlConnector.getData(table.name, offset, limit, columnNames);

      logger.debug(`Retrieved ${data.length} rows from ${table.name} (offset: ${offset})`, 'DataRetrievalService');

      return data;
    } catch (error) {
      logger.error(`Error retrieving data from ${table.name}`, error as Error, 'DataRetrievalService');
      throw error;
    }
  }

  /**
   * Stream data from table in batches
   */
  async streamTableData(
    table: Table,
    batchSize: number = 5000,
    onBatch: (batch: Record<string, any>[], batchNumber: number) => Promise<void>
  ): Promise<void> {
    try {
      logger.info(`Starting data stream for table ${table.name} (batch size: ${batchSize})`, 'DataRetrievalService');

      const dataStream = await mssqlConnector.getDataStream(table.name, batchSize);
      let batchNumber = 0;

      for await (const batch of dataStream) {
        batchNumber++;
        await onBatch(batch, batchNumber);
      }

      logger.info(`Completed data stream for table ${table.name} (${batchNumber} batches)`, 'DataRetrievalService');
    } catch (error) {
      logger.error(`Error streaming data from ${table.name}`, error as Error, 'DataRetrievalService');
      throw error;
    }
  }

  /**
   * Get all data from table in batches
   */
  async getAllTableData(table: Table, batchSize: number = 5000): Promise<Record<string, any>[]> {
    try {
      logger.info(`Retrieving all data from ${table.name}`, 'DataRetrievalService');

      const allData: Record<string, any>[] = [];
      let offset = 0;

      while (offset < table.totalRows) {
        const batch = await this.getTableData(table, offset, batchSize);

        if (batch.length === 0) break;

        allData.push(...batch);
        offset += batch.length;

        logger.debug(`Retrieved ${offset}/${table.totalRows} rows from ${table.name}`, 'DataRetrievalService');
      }

      logger.info(`Retrieved all ${allData.length} rows from ${table.name}`, 'DataRetrievalService');

      return allData;
    } catch (error) {
      logger.error(`Error retrieving all data from ${table.name}`, error as Error, 'DataRetrievalService');
      throw error;
    }
  }

  /**
   * Get row by offset (for resuming migrations)
   */
  async getRowOffset(tableName: string, limit: number = 1): Promise<number> {
    try {
      const data = await mssqlConnector.getData(tableName, 0, limit);
      return data.length;
    } catch (error) {
      logger.error(`Error getting row offset for ${tableName}`, error as Error, 'DataRetrievalService');
      throw error;
    }
  }

  /**
   * Get data chunk for batch processing
   */
  async getDataChunk(
    table: Table,
    startOffset: number,
    batchSize: number
  ): Promise<{ data: Record<string, any>[]; nextOffset: number; hasMore: boolean }> {
    try {
      const data = await this.getTableData(table, startOffset, batchSize);

      return {
        data,
        nextOffset: startOffset + data.length,
        hasMore: data.length === batchSize,
      };
    } catch (error) {
      logger.error(`Error getting data chunk from ${table.name}`, error as Error, 'DataRetrievalService');
      throw error;
    }
  }
}

export const dataRetrievalService = new DataRetrievalService();
