/**
 * Data Transformation Service - Converts and validates data
 */

import { Table, ColumnDefinition } from '../models/table.model';
import { DataValidator, ValidationRule } from '../utils/data-validator';
import { TypeMapper } from '../utils/type-mapper';
import { ErrorHandler } from '../utils/error-handler';
import { logger } from '../utils/logger';
import { migrationConfig } from '../config/migration.config';

export class DataTransformationService {
  private validator: DataValidator;

  constructor() {
    this.validator = new DataValidator();
  }

  /**
   * Create validation rules from table schema
   */
  createValidationRules(table: Table): ValidationRule[] {
    return table.columns.map((col) => ({
      column: col.name,
      dataType: col.dataType,
      maxLength: col.maxLength,
      precision: col.precision,
      scale: col.scale,
      nullable: col.nullable,
    }));
  }

  /**
   * Transform single row
   */
  async transformRow(row: Record<string, any>, table: Table): Promise<Record<string, any> | null> {
    try {
      const transformedRow: Record<string, any> = {};

      for (const column of table.columns) {
        let value = row[column.name];

        // Handle NULL values
        if (value === null || value === undefined) {
          if (!column.nullable) {
            const error = ErrorHandler.handleValidationError(
              row.id,
              column.name,
              value,
              column.dataType,
              table.name
            );
            logger.warn(error.getSummary());
            return null; // Skip this row
          }
          transformedRow[column.name] = null;
          continue;
        }

        // Convert data type if needed
        if (TypeMapper.requiresConversion(column.dataType)) {
          try {
            value = await this.convertDataType(value, column);
          } catch (error) {
            const migrationError = ErrorHandler.handleTypeConversionError(
              row.id,
              column.name,
              value,
              column.dataType,
              table.name,
              error as Error
            );
            logger.warn(migrationError.getSummary());
            return null; // Skip this row
          }
        }

        transformedRow[column.name] = value;
      }

      return transformedRow;
    } catch (error) {
      logger.error(`Error transforming row from table ${table.name}`, error as Error, 'DataTransformationService');
      return null;
    }
  }

  /**
   * Transform batch of rows
   */
  async transformBatch(rows: Record<string, any>[], table: Table): Promise<Record<string, any>[]> {
    try {
      const transformedRows: Record<string, any>[] = [];
      let skippedRows = 0;

      for (const row of rows) {
        const transformedRow = await this.transformRow(row, table);

        if (transformedRow !== null) {
          transformedRows.push(transformedRow);
        } else {
          skippedRows++;
        }
      }

      if (skippedRows > 0) {
        logger.warn(`Skipped ${skippedRows} rows during transformation from ${table.name}`, 'DataTransformationService');
      }

      return transformedRows;
    } catch (error) {
      logger.error(`Error transforming batch from table ${table.name}`, error as Error, 'DataTransformationService');
      throw error;
    }
  }

  /**
   * Convert data type based on column definition
   */
  private async convertDataType(value: any, column: ColumnDefinition): Promise<any> {
    const dataType = column.dataType.toUpperCase();

    switch (dataType) {
      case 'BIT':
        if (typeof value === 'boolean') return value ? 1 : 0;
        if (typeof value === 'string') return value.toLowerCase() === 'true' ? 1 : 0;
        if (typeof value === 'number') return value ? 1 : 0;
        return value;

      case 'UNIQUEIDENTIFIER':
        return String(value).toLowerCase();

      case 'TEXT':
      case 'NTEXT':
        // Keep as is for CLOB mapping
        return String(value);

      case 'IMAGE':
      case 'VARBINARY':
        // Convert to base64 or hex if needed
        if (Buffer.isBuffer(value)) {
          return value.toString('hex');
        }
        return value;

      case 'DATETIMEOFFSET':
        if (value instanceof Date) return value;
        return new Date(value);

      default:
        return value;
    }
  }

  /**
   * Fast-path transform batch of rows (high-throughput, skips heavy Joi schemas)
   */
  fastTransformBatch(
    rows: Record<string, any>[],
    table: Table,
    oracleMeta?: Map<string, { name: string; nullable: boolean; dataType: string; dataLength?: number }>
  ): Record<string, any>[] {
    const bitCols: string[] = [];
    const bufferCols: string[] = [];
    const uuidCols: string[] = [];
    const dateOffsetCols: string[] = [];
    const validColNames: string[] = [];

    // Precompute NOT NULL columns to prevent ORA-01400 (empty string or NULL in NOT NULL column in Oracle)
    const notNullCols: { name: string; type: 'string' | 'number' | 'date' }[] = [];
    for (const col of table.columns) {
      validColNames.push(col.name);
      const dt = col.dataType.toUpperCase();
      if (dt === 'BIT') bitCols.push(col.name);
      else if (dt === 'IMAGE' || dt === 'VARBINARY' || dt === 'BINARY') bufferCols.push(col.name);
      else if (dt === 'UNIQUEIDENTIFIER') uuidCols.push(col.name);
      else if (dt === 'DATETIMEOFFSET') dateOffsetCols.push(col.name);

      const oMeta = oracleMeta?.get(col.name.toUpperCase());
      const isOracleNotNull = oMeta ? !oMeta.nullable : false;
      const isMssqlNotNull = !col.nullable;

      if (isOracleNotNull || isMssqlNotNull) {
        const targetType = (oMeta?.dataType || dt).toUpperCase();
        if (
          targetType.includes('CHAR') ||
          targetType.includes('CLOB') ||
          targetType.includes('TEXT') ||
          targetType.includes('VARCHAR')
        ) {
          notNullCols.push({ name: col.name, type: 'string' });
        } else if (
          targetType.includes('INT') ||
          targetType.includes('NUMBER') ||
          targetType.includes('FLOAT') ||
          targetType.includes('DECIMAL') ||
          targetType.includes('NUMERIC') ||
          targetType.includes('MONEY') ||
          targetType === 'BIT'
        ) {
          notNullCols.push({ name: col.name, type: 'number' });
        } else if (targetType.includes('DATE') || targetType.includes('TIME')) {
          notNullCols.push({ name: col.name, type: 'date' });
        }
      }
    }

    const transformed: Record<string, any>[] = new Array(rows.length);

    for (let i = 0; i < rows.length; i++) {
      const src = rows[i];
      const dest: Record<string, any> = {};

      for (let j = 0; j < validColNames.length; j++) {
        const colName = validColNames[j];
        let val = src[colName];

        if (val === undefined) {
          dest[colName] = null;
        } else {
          dest[colName] = val;
        }
      }

      // Fast conversions only for columns that need it
      for (let b = 0; b < bitCols.length; b++) {
        const c = bitCols[b];
        const v = dest[c];
        if (v !== null && v !== undefined) {
          dest[c] = typeof v === 'boolean' ? (v ? 1 : 0) : v ? 1 : 0;
        }
      }

      for (let bf = 0; bf < bufferCols.length; bf++) {
        const c = bufferCols[bf];
        const v = dest[c];
        if (Buffer.isBuffer(v)) {
          dest[c] = v.toString('hex');
        }
      }

      for (let u = 0; u < uuidCols.length; u++) {
        const c = uuidCols[u];
        const v = dest[c];
        if (v !== null && v !== undefined) {
          dest[c] = String(v).toLowerCase();
        }
      }

      for (let d = 0; d < dateOffsetCols.length; d++) {
        const c = dateOffsetCols[d];
        const v = dest[c];
        if (v !== null && v !== undefined && !(v instanceof Date)) {
          dest[c] = new Date(v);
        }
      }

      // Sanitize NOT NULL columns (in Oracle, '' is treated as NULL, causing ORA-01400)
      for (let n = 0; n < notNullCols.length; n++) {
        const { name, type } = notNullCols[n];
        const v = dest[name];
        if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) {
          if (type === 'string') {
            dest[name] = ' '; // Single space satisfies Oracle NOT NULL
          } else if (type === 'number') {
            dest[name] = 0;
          } else if (type === 'date') {
            dest[name] = new Date('1900-01-01');
          }
        }
      }

      transformed[i] = dest;
    }

    return transformed;
  }

  /**
   * Validate and transform batch
   */
  async validateAndTransform(
    rows: Record<string, any>[],
    table: Table,
    oracleMeta?: Map<string, { name: string; nullable: boolean; dataType: string; dataLength?: number }>
  ): Promise<{ valid: Record<string, any>[]; invalid: number }> {
    try {
      // Use ultra-fast path if detailed schema validation is turned off
      if (!migrationConfig.validateDataTypes) {
        const fastTransformed = this.fastTransformBatch(rows, table, oracleMeta);
        return {
          valid: fastTransformed,
          invalid: 0,
        };
      }

      const rules = this.createValidationRules(table);
      this.validator.clearRules();
      this.validator.addRules(rules);

      const validationResults = await this.validator.validateBatch(rows);
      const validRows: Record<string, any>[] = [];
      let invalidCount = 0;

      for (let i = 0; i < rows.length; i++) {
        const result = validationResults[i];

        if (result.isValid) {
          const transformedRow = await this.transformRow(rows[i], table);
          if (transformedRow) {
            validRows.push(transformedRow);
          } else {
            invalidCount++;
          }
        } else {
          invalidCount++;

          // Log validation errors
          for (const [column, errors] of result.errors) {
            logger.debug(`Validation failed for column ${column}: ${errors.join(', ')}`, 'DataTransformationService');
          }
        }
      }

      return {
        valid: validRows,
        invalid: invalidCount,
      };
    } catch (error) {
      logger.error(`Error validating and transforming batch from ${table.name}`, error as Error, 'DataTransformationService');
      throw error;
    }
  }

  /**
   * Get target column names (removing unsupported columns if needed)
   */
  getTargetColumnNames(table: Table): string[] {
    return table.columns.filter((col) => TypeMapper.isTypeCompatible(col.dataType)).map((col) => col.name);
  }
}

export const dataTransformationService = new DataTransformationService();
