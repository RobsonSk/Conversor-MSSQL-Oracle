/**
 * Error Handler Utility - Centralized error handling
 */

import { MigrationError, ErrorType } from '../models/error.model';
import { logger } from './logger';

export class ErrorHandler {
  /**
   * Handle connection error
   */
  static handleConnectionError(source: string, error: Error): MigrationError {
    const migrationError = new MigrationError({
      type: ErrorType.CONNECTION,
      severity: 'HIGH',
      message: `Failed to connect to ${source}`,
      source,
      recoverable: true,
      stack: error.stack,
    });

    logger.error(`Connection error in ${source}`, error, 'ErrorHandler', {
      errorId: migrationError.id,
      type: migrationError.type,
    });

    return migrationError;
  }

  /**
   * Handle validation error
   */
  static handleValidationError(
    rowId: string | number | undefined,
    column: string,
    value: any,
    expectedFormat: string,
    source: string
  ): MigrationError {
    const migrationError = new MigrationError({
      type: ErrorType.VALIDATION,
      severity: 'MEDIUM',
      message: `Validation failed for column ${column}`,
      source,
      rowId,
      column,
      value,
      expectedFormat,
      actualFormat: typeof value,
      recoverable: true,
    });

    logger.warn(`Validation error in ${source}`, 'ErrorHandler', {
      rowId,
      column,
      value,
      expectedFormat,
    });

    return migrationError;
  }

  /**
   * Handle type conversion error
   */
  static handleTypeConversionError(
    rowId: string | number | undefined,
    column: string,
    value: any,
    targetType: string,
    source: string,
    sourceError?: Error
  ): MigrationError {
    const migrationError = new MigrationError({
      type: ErrorType.TYPE_CONVERSION,
      severity: 'MEDIUM',
      message: `Type conversion failed for column ${column} to ${targetType}`,
      source,
      rowId,
      column,
      value,
      expectedFormat: targetType,
      recoverable: true,
      stack: sourceError?.stack,
    });

    logger.warn(`Type conversion error in ${source}`, 'ErrorHandler', {
      rowId,
      column,
      expectedFormat: targetType,
      error: sourceError?.message,
    });

    return migrationError;
  }

  /**
   * Handle constraint violation
   */
  static handleConstraintViolation(
    rowId: string | number | undefined,
    constraintName: string,
    source: string,
    error: Error
  ): MigrationError {
    const migrationError = new MigrationError({
      type: ErrorType.CONSTRAINT,
      severity: 'HIGH',
      message: `Constraint violation: ${constraintName}`,
      source,
      rowId,
      recoverable: true,
      stack: error.stack,
    });

    logger.warn(`Constraint violation in ${source}`, 'ErrorHandler', {
      rowId,
      constraint: constraintName,
      error: error.message,
    });

    return migrationError;
  }

  /**
   * Handle data integrity error
   */
  static handleDataIntegrityError(source: string, message: string, error?: Error): MigrationError {
    const migrationError = new MigrationError({
      type: ErrorType.DATA_INTEGRITY,
      severity: 'CRITICAL',
      message,
      source,
      recoverable: false,
      stack: error?.stack,
    });

    logger.error(message, error, 'ErrorHandler', {
      errorId: migrationError.id,
      source,
    });

    return migrationError;
  }

  /**
   * Handle unknown error
   */
  static handleUnknownError(source: string, error: Error): MigrationError {
    const migrationError = new MigrationError({
      type: ErrorType.UNKNOWN,
      severity: 'CRITICAL',
      message: `Unknown error occurred in ${source}`,
      source,
      recoverable: false,
      stack: error.stack,
    });

    logger.error(`Unknown error in ${source}`, error, 'ErrorHandler', {
      errorId: migrationError.id,
    });

    return migrationError;
  }

  /**
   * Determine error recovery strategy
   */
  static getRecoveryStrategy(error: MigrationError): 'skip' | 'retry' | 'skip_table' | 'stop' {
    if (!error.recoverable) {
      return error.severity === 'CRITICAL' ? 'stop' : 'skip_table';
    }

    switch (error.type) {
      case ErrorType.VALIDATION:
      case ErrorType.TYPE_CONVERSION:
        return 'skip';
      case ErrorType.CONSTRAINT:
        return 'skip';
      case ErrorType.CONNECTION:
        return 'retry';
      case ErrorType.DATA_INTEGRITY:
        return 'stop';
      default:
        return 'skip';
    }
  }

  /**
   * Log error for manual review
   */
  static logErrorForReview(error: MigrationError): void {
    const timestamp = error.timestamp.toISOString();
    const review = {
      id: error.id,
      timestamp,
      type: error.type,
      severity: error.severity,
      message: error.message,
      source: error.source,
      rowId: error.rowId,
      column: error.column,
      value: error.value,
      expectedFormat: error.expectedFormat,
      recoverable: error.recoverable,
      retryCount: error.retryCount,
    };

    logger.warn('Error logged for manual review', 'ErrorHandler', review);
  }
}
