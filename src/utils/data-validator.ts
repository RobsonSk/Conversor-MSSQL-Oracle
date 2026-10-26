/**
 * Data Validator Utility - Validates data before insertion
 */

import { logger } from './logger';

export interface ValidationRule {
  column: string;
  dataType: string;
  maxLength?: number;
  precision?: number;
  scale?: number;
  nullable: boolean;
  pattern?: RegExp;
  customValidator?: (value: any) => boolean | Promise<boolean>;
}

export interface ValidationResult {
  isValid: boolean;
  errors: Map<string, string[]>;
  warnings: string[];
}

export class DataValidator {
  private rules: ValidationRule[] = [];

  /**
   * Add validation rule
   */
  addRule(rule: ValidationRule): void {
    this.rules.push(rule);
  }

  /**
   * Add multiple rules
   */
  addRules(rules: ValidationRule[]): void {
    this.rules.push(...rules);
  }

  /**
   * Clear all rules
   */
  clearRules(): void {
    this.rules = [];
  }

  /**
   * Validate single row
   */
  async validateRow(row: Record<string, any>): Promise<ValidationResult> {
    const errors = new Map<string, string[]>();
    const warnings: string[] = [];

    for (const rule of this.rules) {
      const value = row[rule.column];
      const columnErrors: string[] = [];

      // Check null values
      if (value === null || value === undefined) {
        if (!rule.nullable) {
          columnErrors.push('NULL value not allowed');
        }
        continue;
      }

      // Validate based on data type
      switch (rule.dataType.toUpperCase()) {
        case 'INT':
        case 'BIGINT':
        case 'SMALLINT':
        case 'TINYINT':
          if (!Number.isInteger(value)) {
            columnErrors.push(`Expected integer, got ${typeof value}`);
          }
          break;

        case 'DECIMAL':
        case 'NUMERIC':
        case 'FLOAT':
        case 'REAL':
        case 'MONEY':
        case 'SMALLMONEY':
          if (typeof value !== 'number') {
            columnErrors.push(`Expected number, got ${typeof value}`);
          } else if (rule.precision && Math.abs(value).toString().replace('.', '').length > rule.precision) {
            columnErrors.push(`Exceeds precision of ${rule.precision}`);
          }
          break;

        case 'VARCHAR':
        case 'NVARCHAR':
        case 'CHAR':
        case 'NCHAR':
        case 'TEXT':
        case 'NTEXT':
          if (typeof value !== 'string') {
            columnErrors.push(`Expected string, got ${typeof value}`);
          } else if (rule.maxLength && value.length > rule.maxLength) {
            columnErrors.push(`Exceeds max length of ${rule.maxLength}`);
          }
          if (rule.pattern && !rule.pattern.test(value)) {
            columnErrors.push(`Does not match pattern ${rule.pattern}`);
          }
          break;

        case 'DATE':
        case 'DATETIME':
        case 'DATETIME2':
        case 'SMALLDATETIME':
          if (!(value instanceof Date) && isNaN(Date.parse(value))) {
            columnErrors.push('Invalid date format');
          }
          break;

        case 'BIT':
          if (typeof value !== 'boolean' && value !== 0 && value !== 1) {
            columnErrors.push('Expected boolean or 0/1');
          }
          break;

        case 'UNIQUEIDENTIFIER':
          if (!this.isValidUUID(value)) {
            columnErrors.push('Invalid UUID format');
          }
          break;

        case 'BINARY':
        case 'VARBINARY':
        case 'IMAGE':
          if (!Buffer.isBuffer(value) && typeof value !== 'string') {
            columnErrors.push('Expected buffer or base64 string');
          }
          break;
      }

      // Custom validator
      if (rule.customValidator) {
        try {
          const isValid = await rule.customValidator(value);
          if (!isValid) {
            columnErrors.push('Custom validation failed');
          }
        } catch (err) {
          columnErrors.push(`Custom validator error: ${err}`);
        }
      }

      if (columnErrors.length > 0) {
        errors.set(rule.column, columnErrors);
      }
    }

    return {
      isValid: errors.size === 0,
      errors,
      warnings,
    };
  }

  /**
   * Validate multiple rows
   */
  async validateBatch(rows: Record<string, any>[]): Promise<ValidationResult[]> {
    const results: ValidationResult[] = [];

    for (const row of rows) {
      const result = await this.validateRow(row);
      results.push(result);
    }

    return results;
  }

  /**
   * Check if value is valid UUID
   */
  private isValidUUID(value: string): boolean {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    return uuidRegex.test(value);
  }

  /**
   * Sanitize string value
   */
  static sanitizeString(value: string, maxLength?: number): string {
    let sanitized = value;

    // Remove null characters
    sanitized = sanitized.replace(/\0/g, '');

    // Trim whitespace
    sanitized = sanitized.trim();

    // Truncate if exceeds max length
    if (maxLength && sanitized.length > maxLength) {
      sanitized = sanitized.substring(0, maxLength);
      logger.warn(`String truncated to ${maxLength} characters`);
    }

    return sanitized;
  }

  /**
   * Convert to correct type
   */
  static convertType(value: any, targetType: string): any {
    if (value === null || value === undefined) {
      return null;
    }

    switch (targetType.toUpperCase()) {
      case 'BIT':
        if (typeof value === 'boolean') return value ? 1 : 0;
        if (typeof value === 'string') return value.toLowerCase() === 'true' ? 1 : 0;
        return value ? 1 : 0;

      case 'UNIQUEIDENTIFIER':
        return String(value).toLowerCase();

      case 'DATE':
        if (value instanceof Date) return value;
        return new Date(value);

      case 'INT':
      case 'BIGINT':
      case 'SMALLINT':
      case 'TINYINT':
        return parseInt(value, 10);

      case 'FLOAT':
      case 'REAL':
      case 'DECIMAL':
      case 'NUMERIC':
        return parseFloat(value);

      default:
        return value;
    }
  }
}
