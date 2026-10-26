/**
 * Schema Service - Detects and manages schema information
 */

import { mssqlConnector } from '../connectors/mssql.connector';
import { Table, ColumnDefinition } from '../models/table.model';
import { logger } from '../utils/logger';

export class SchemaService {
  /**
   * Get all tables from MSSQL
   */
  async getSourceTables(): Promise<Table[]> {
    try {
      const tableNames = await mssqlConnector.getTables();
      const tables: Table[] = [];

      for (const tableName of tableNames) {
        const schema = await mssqlConnector.getTableSchema(tableName);
        const rowCount = await mssqlConnector.getRowCount(tableName);

        const table = new Table({
          name: tableName,
          schema: 'dbo',
          columns: schema,
          totalRows: rowCount,
        });

        tables.push(table);
      }

      logger.info(`Retrieved ${tables.length} tables from source database`, 'SchemaService', {
        tables: tables.map((t) => ({ name: t.name, rowCount: t.totalRows })),
      });

      return tables;
    } catch (error) {
      logger.error('Error retrieving source tables', error as Error, 'SchemaService');
      throw error;
    }
  }

  /**
   * Get specific table schema
   */
  async getTableSchema(tableName: string): Promise<Table> {
    try {
      const schema = await mssqlConnector.getTableSchema(tableName);
      const rowCount = await mssqlConnector.getRowCount(tableName);

      const table = new Table({
        name: tableName,
        schema: 'dbo',
        columns: schema,
        totalRows: rowCount,
      });

      logger.info(`Retrieved schema for table ${tableName}`, 'SchemaService', {
        columns: schema.length,
        rowCount,
      });

      return table;
    } catch (error) {
      logger.error(`Error retrieving schema for table ${tableName}`, error as Error, 'SchemaService');
      throw error;
    }
  }

  /**
   * Get column names for a table
   */
  getColumnNames(table: Table): string[] {
    return table.columns.map((col) => col.name);
  }

  /**
   * Get non-null column names (for validation)
   */
  getNonNullableColumns(table: Table): string[] {
    return table.columns.filter((col) => !col.nullable).map((col) => col.name);
  }

  /**
   * Get primary key columns
   */
  getPrimaryKeyColumns(table: Table): ColumnDefinition[] {
    return table.columns.filter((col) => col.isPrimaryKey);
  }

  /**
   * Check if schema is compatible
   */
  isSchemaCompatible(sourceTable: Table): boolean {
    // Check if all columns have compatible types
    // This is a basic check - extend as needed

    for (const column of sourceTable.columns) {
      if (!this.isTypeSupported(column.dataType)) {
        logger.warn(`Unsupported column type: ${column.dataType} in column ${column.name}`, 'SchemaService');
        return false;
      }
    }

    return true;
  }

  /**
   * Check if data type is supported
   */
  private isTypeSupported(dataType: string): boolean {
    const supportedTypes = [
      'INT',
      'BIGINT',
      'SMALLINT',
      'TINYINT',
      'DECIMAL',
      'NUMERIC',
      'FLOAT',
      'REAL',
      'MONEY',
      'SMALLMONEY',
      'VARCHAR',
      'NVARCHAR',
      'CHAR',
      'NCHAR',
      'TEXT',
      'NTEXT',
      'DATE',
      'DATETIME',
      'DATETIME2',
      'SMALLDATETIME',
      'DATETIMEOFFSET',
      'TIME',
      'BINARY',
      'VARBINARY',
      'IMAGE',
      'BIT',
      'UNIQUEIDENTIFIER',
    ];

    return supportedTypes.some((type) => dataType.toUpperCase().startsWith(type));
  }

  /**
   * Get table statistics
   */
  async getTableStatistics(tableName: string): Promise<any> {
    try {
      const table = await this.getTableSchema(tableName);

      const stats = {
        tableName: table.name,
        totalColumns: table.columns.length,
        totalRows: table.totalRows,
        nullableColumns: table.columns.filter((c) => c.nullable).length,
        nonNullableColumns: table.columns.filter((c) => !c.nullable).length,
        primaryKeyColumns: table.columns.filter((c) => c.isPrimaryKey).length,
        foreignKeyColumns: table.columns.filter((c) => c.isForeignKey).length,
        columns: table.columns.map((c) => ({
          name: c.name,
          dataType: c.dataType,
          maxLength: c.maxLength,
          nullable: c.nullable,
          isPrimaryKey: c.isPrimaryKey,
          isForeignKey: c.isForeignKey,
        })),
      };

      return stats;
    } catch (error) {
      logger.error(`Error getting table statistics for ${tableName}`, error as Error, 'SchemaService');
      throw error;
    }
  }
}

export const schemaService = new SchemaService();
