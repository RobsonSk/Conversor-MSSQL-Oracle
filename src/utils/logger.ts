/**
 * Logger Utility - Centralized logging for the application
 */

import * as fs from 'fs';
import * as path from 'path';

export enum LogLevel {
  DEBUG = 'DEBUG',
  INFO = 'INFO',
  WARN = 'WARN',
  ERROR = 'ERROR',
}

export interface LogEntry {
  timestamp: Date;
  level: LogLevel;
  message: string;
  context?: string;
  data?: any;
  error?: Error;
}

export class Logger {
  private static instance: Logger;
  private logFile: string;
  private logLevel: LogLevel = LogLevel.INFO;

  private constructor() {
    this.logFile = process.env.LOG_FILE || './logs/migration.log';
    this.ensureLogDirectory();
    this.setLogLevel();
  }

  /**
   * Get logger instance (singleton)
   */
  static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  /**
   * Ensure log directory exists
   */
  private ensureLogDirectory(): void {
    const logDir = path.dirname(this.logFile);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
  }

  /**
   * Set log level from environment
   */
  private setLogLevel(): void {
    const envLevel = process.env.LOG_LEVEL?.toUpperCase();
    if (envLevel && Object.values(LogLevel).includes(envLevel as LogLevel)) {
      this.logLevel = envLevel as LogLevel;
    }
  }

  /**
   * Format log entry
   */
  private formatLog(entry: LogEntry): string {
    const timestamp = entry.timestamp.toISOString();
    const level = entry.level.padEnd(6);
    const context = entry.context ? `[${entry.context}] ` : '';
    const message = entry.message;
    let output = `${timestamp} ${level} ${context}${message}`;

    if (entry.data) {
      output += `\n${JSON.stringify(entry.data, null, 2)}`;
    }

    if (entry.error) {
      output += `\nError: ${entry.error.message}`;
      if (entry.error.stack) {
        output += `\n${entry.error.stack}`;
      }
    }

    return output;
  }

  /**
   * Write log to file
   */
  private writeToFile(entry: LogEntry): void {
    try {
      const logMessage = this.formatLog(entry);
      
      if (entry.level === LogLevel.ERROR) {
        const errorLogFile = path.join(path.dirname(this.logFile), 'errors.log');
        fs.appendFileSync(errorLogFile, logMessage + '\n');
      }
      
      fs.appendFileSync(this.logFile, logMessage + '\n');
    } catch (err) {
      console.error('Failed to write to log file:', err);
    }
  }

  /**
   * Log message to console and file
   */
  private log(level: LogLevel, message: string, context?: string, data?: any, error?: Error): void {
    const shouldLog = this.shouldLog(level);
    if (!shouldLog) return;

    const entry: LogEntry = {
      timestamp: new Date(),
      level,
      message,
      context,
      data,
      error,
    };

    this.writeToFile(entry);
    this.logToConsole(entry);
  }

  /**
   * Determine if message should be logged
   */
  private shouldLog(level: LogLevel): boolean {
    const levels = [LogLevel.DEBUG, LogLevel.INFO, LogLevel.WARN, LogLevel.ERROR];
    const currentIndex = levels.indexOf(this.logLevel);
    const entryIndex = levels.indexOf(level);
    return entryIndex >= currentIndex;
  }

  /**
   * Log to console with colors
   */
  private logToConsole(entry: LogEntry): void {
    const colors = {
      [LogLevel.DEBUG]: '\x1b[36m', // Cyan
      [LogLevel.INFO]: '\x1b[32m', // Green
      [LogLevel.WARN]: '\x1b[33m', // Yellow
      [LogLevel.ERROR]: '\x1b[31m', // Red
    };

    const reset = '\x1b[0m';
    const color = colors[entry.level] || reset;
    const timestamp = entry.timestamp.toISOString();
    const context = entry.context ? `[${entry.context}] ` : '';

    console.log(`${color}${timestamp} ${entry.level.padEnd(6)} ${context}${entry.message}${reset}`);

    if (entry.data) {
      console.log(JSON.stringify(entry.data, null, 2));
    }

    if (entry.error) {
      console.error(entry.error);
    }
  }

  /**
   * Debug level logging
   */
  debug(message: string, context?: string, data?: any): void {
    this.log(LogLevel.DEBUG, message, context, data);
  }

  /**
   * Info level logging
   */
  info(message: string, context?: string, data?: any): void {
    this.log(LogLevel.INFO, message, context, data);
  }

  /**
   * Warn level logging
   */
  warn(message: string, context?: string, data?: any): void {
    this.log(LogLevel.WARN, message, context, data);
  }

  /**
   * Error level logging
   */
  error(message: string, error?: Error, context?: string, data?: any): void {
    this.log(LogLevel.ERROR, message, context, data, error);
  }

  /**
   * Get all logs
   */
  getLogs(): string[] {
    try {
      const content = fs.readFileSync(this.logFile, 'utf-8');
      return content.split('\n').filter((line) => line.trim());
    } catch {
      return [];
    }
  }

  clearLogs(): void {
    try {
      fs.writeFileSync(this.logFile, '');
    } catch (err) {
      console.error('Failed to clear log file:', err);
    }
  }

  /**
   * Log missing columns to a separate file
   */
  logMissingColumns(tableName: string, missingColumns: { name: string; dataType: string }[]): void {
    try {
      const logDir = path.dirname(this.logFile);
      const missingLogFile = path.join(logDir, 'missing-columns.log');
      
      const timestamp = new Date().toISOString();
      let entries = '';
      for (const col of missingColumns) {
        entries += `${timestamp} - Table: ${tableName} - Column: ${col.name} (Type in MSSQL: ${col.dataType}) is missing in Oracle\n`;
      }
      
      fs.appendFileSync(missingLogFile, entries);
    } catch (err) {
      console.error('Failed to write to missing-columns log file:', err);
    }
  }
}

export const logger = Logger.getInstance();

