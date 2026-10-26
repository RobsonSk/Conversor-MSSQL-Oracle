/**
 * DDL Service - Extracts MSSQL schema and generates Oracle-compatible DDL (Tables, PKs, FKs, Unique Constraints)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { mssqlConnector } from '../connectors/mssql.connector';
import { oracleConnector } from '../connectors/oracle.connector';
import { logger } from '../utils/logger';

export interface ColumnDDL {
  name: string;
  dataType: string;
  maxLength: number;
  precision: number | null;
  scale: number | null;
  nullable: boolean;
  defaultValue: string | null;
  isIdentity: boolean;
}

export interface PrimaryKeyDDL {
  constraintName: string;
  columns: string[];
}

export interface UniqueKeyDDL {
  constraintName: string;
  columns: string[];
}

export interface ForeignKeyDDL {
  constraintName: string;
  sourceTable: string;
  sourceColumns: string[];
  referencedTable: string;
  referencedColumns: string[];
  deleteRule?: string;
}

export interface TableDDL {
  tableName: string;
  columns: ColumnDDL[];
  primaryKey?: PrimaryKeyDDL;
  uniqueKeys: UniqueKeyDDL[];
  foreignKeys: ForeignKeyDDL[];
}

export interface DDLGenerationResult {
  sqlScript: string;
  tableStatements: { tableName: string; sql: string }[];
  pkStatements: { tableName: string; constraintName: string; sql: string }[];
  uqStatements: { tableName: string; constraintName: string; sql: string }[];
  fkStatements: { tableName: string; constraintName: string; sql: string }[];
}

export interface DDLApplyResult {
  tablesCreated: number;
  pksCreated: number;
  uqsCreated: number;
  fksCreated: number;
  errors: { stage: string; target: string; error: string; sql: string }[];
}

export class DDLService {
  /**
   * Sanitizes an identifier name for Oracle (Oracle 11g limit: 30 bytes)
   */
  sanitizeIdentifier(name: string): string {
    const upper = name.toUpperCase().replace(/[^A-Z0-9_$#]/g, '_');
    if (upper.length <= 30) {
      return upper;
    }
    // Truncate and append 6-char MD5 hash to guarantee uniqueness under 30 chars
    const hash = crypto.createHash('md5').update(upper).digest('hex').substring(0, 6).toUpperCase();
    const prefix = upper.substring(0, 23); // 23 + 1 ('_') + 6 = 30 chars
    return `${prefix}_${hash}`;
  }

  /**
   * Maps MSSQL data types to Oracle equivalents for table creation
   */
  mapDataTypeToOracle(col: ColumnDDL): string {
    const rawType = col.dataType.toUpperCase().trim();

    switch (rawType) {
      // Numerics
      case 'BIT':
        return 'CHAR(1)';
      case 'TINYINT':
        return 'NUMBER(3,0)';
      case 'SMALLINT':
        return 'NUMBER(5,0)';
      case 'INT':
        return 'NUMBER(10,0)';
      case 'BIGINT':
        return 'NUMBER(19,0)';
      case 'DECIMAL':
      case 'NUMERIC':
        if (col.precision !== null && col.precision !== undefined) {
          const s = col.scale !== null && col.scale !== undefined ? col.scale : 0;
          return `NUMBER(${col.precision},${s})`;
        }
        return 'NUMBER';
      case 'MONEY':
        return 'NUMBER(19,4)';
      case 'SMALLMONEY':
        return 'NUMBER(10,4)';
      case 'FLOAT':
        return 'BINARY_DOUBLE';
      case 'REAL':
        return 'BINARY_FLOAT';

      // Character / Strings
      case 'VARCHAR':
        if (col.maxLength === -1 || col.maxLength > 4000) {
          return 'CLOB';
        }
        return `VARCHAR2(${col.maxLength > 0 ? col.maxLength : 1})`;
      case 'NVARCHAR':
        // In MSSQL, NVARCHAR max_length is reported in bytes (2 bytes per char)
        const nvarLen = col.maxLength > 0 ? Math.floor(col.maxLength / 2) : col.maxLength;
        if (nvarLen === -1 || nvarLen > 2000) {
          return 'NCLOB';
        }
        return `NVARCHAR2(${nvarLen > 0 ? nvarLen : 1})`;
      case 'CHAR':
        return `CHAR(${col.maxLength > 0 ? col.maxLength : 1})`;
      case 'NCHAR':
        const ncharLen = col.maxLength > 0 ? Math.floor(col.maxLength / 2) : col.maxLength;
        return `NCHAR(${ncharLen > 0 ? ncharLen : 1})`;
      case 'TEXT':
        return 'CLOB';
      case 'NTEXT':
        return 'NCLOB';

      // Dates / Times
      case 'DATE':
        return 'DATE';
      case 'TIME':
        return 'VARCHAR2(16)';
      case 'DATETIME':
      case 'DATETIME2':
      case 'SMALLDATETIME':
        return 'TIMESTAMP';
      case 'DATETIMEOFFSET':
        return 'TIMESTAMP WITH TIME ZONE';

      // Binary / Large Objects
      case 'BINARY':
        if (col.maxLength > 2000) return 'BLOB';
        return `RAW(${col.maxLength > 0 ? col.maxLength : 1})`;
      case 'VARBINARY':
        if (col.maxLength === -1 || col.maxLength > 2000) {
          return 'BLOB';
        }
        return `RAW(${col.maxLength > 0 ? col.maxLength : 1})`;
      case 'IMAGE':
        return 'BLOB';

      // UUID
      case 'UNIQUEIDENTIFIER':
        return 'VARCHAR2(36)';

      // XML / Others
      case 'XML':
        return 'CLOB';

      default:
        return 'VARCHAR2(4000)';
    }
  }

  /**
   * Sanitizes MSSQL default values for Oracle syntax
   */
  sanitizeDefaultValue(defaultValue: string | null): string | null {
    if (!defaultValue) return null;

    let val = defaultValue.trim();

    // Remove outermost matched wrapping parentheses, e.g. (((0))) -> 0
    while (val.startsWith('(') && val.endsWith(')')) {
      const inner = val.substring(1, val.length - 1).trim();
      // Ensure it wasn't a case of (a) + (b)
      let depth = 0;
      let safeToRemove = true;
      for (let i = 0; i < inner.length; i++) {
        if (inner[i] === '(') depth++;
        else if (inner[i] === ')') depth--;
        if (depth < 0) {
          safeToRemove = false;
          break;
        }
      }
      if (safeToRemove) {
        val = inner;
      } else {
        break;
      }
    }

    const upperVal = val.toUpperCase();

    // Map common MSSQL functions to Oracle equivalents
    if (upperVal === 'GETDATE()' || upperVal === 'GETUTCDATE()' || upperVal === 'CURRENT_TIMESTAMP') {
      return 'SYSDATE';
    }
    if (upperVal === 'SYSDATETIME()') {
      return 'SYSTIMESTAMP';
    }
    if (upperVal === 'NEWID()') {
      return 'SYS_GUID()';
    }
    if (upperVal === 'NULL') {
      return 'NULL';
    }
    if (upperVal === "''" || upperVal === "N''") {
      return "''";
    }

    // Numbers: 0, 1, 123.45
    if (/^-?\d+(\.\d+)?$/.test(val)) {
      return val;
    }

    // String literals: 'abc' or N'abc'
    if (val.startsWith("N'") && val.endsWith("'")) {
      return val.substring(1); // Remove leading N
    }
    if (val.startsWith("'") && val.endsWith("'")) {
      return val;
    }

    // Complex or unsupported MSSQL expression - skip default to avoid Oracle DDL syntax error
    logger.debug(`Skipping unmapped MSSQL default expression: ${defaultValue}`, 'DDLService');
    return null;
  }

  /**
   * Extract comprehensive DDL metadata from MSSQL
   */
  async extractMetadata(targetTable?: string): Promise<TableDDL[]> {
    logger.info('Extracting metadata from MSSQL for DDL generation...', 'DDLService');

    const tableFilter = targetTable ? `AND t.name = '${targetTable.replace(/'/g, "''")}'` : '';
    const tableFilterFk = targetTable
      ? `AND (tp.name = '${targetTable.replace(/'/g, "''")}' OR tr.name = '${targetTable.replace(/'/g, "''")}')`
      : '';

    // 1. Extract Columns
    const columnsQuery = `
      SELECT 
        t.name AS table_name,
        c.name AS column_name,
        c.column_id AS ordinal_position,
        ty.name AS data_type,
        c.max_length,
        c.precision,
        c.scale,
        c.is_nullable,
        c.is_identity,
        OBJECT_DEFINITION(c.default_object_id) AS default_value
      FROM sys.tables t
      JOIN sys.columns c ON t.object_id = c.object_id
      JOIN sys.types ty ON c.user_type_id = ty.user_type_id
      WHERE t.is_ms_shipped = 0
        ${tableFilter}
      ORDER BY t.name, c.column_id
    `;

    // 2. Extract Primary Keys
    const pkQuery = `
      SELECT 
        t.name AS table_name,
        k.name AS constraint_name,
        c.name AS column_name,
        ic.key_ordinal
      FROM sys.tables t
      JOIN sys.key_constraints k ON t.object_id = k.parent_object_id AND k.type = 'PK'
      JOIN sys.index_columns ic ON k.parent_object_id = ic.object_id AND k.unique_index_id = ic.index_id
      JOIN sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id
      WHERE t.is_ms_shipped = 0
        ${tableFilter}
      ORDER BY t.name, k.name, ic.key_ordinal
    `;

    // 3. Extract Unique Constraints
    const uqQuery = `
      SELECT 
        t.name AS table_name,
        k.name AS constraint_name,
        c.name AS column_name,
        ic.key_ordinal
      FROM sys.tables t
      JOIN sys.key_constraints k ON t.object_id = k.parent_object_id AND k.type = 'UQ'
      JOIN sys.index_columns ic ON k.parent_object_id = ic.object_id AND k.unique_index_id = ic.index_id
      JOIN sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id
      WHERE t.is_ms_shipped = 0
        ${tableFilter}
      ORDER BY t.name, k.name, ic.key_ordinal
    `;

    // 4. Extract Foreign Keys
    const fkQuery = `
      SELECT 
        fk.name AS constraint_name,
        tp.name AS table_name,
        cp.name AS column_name,
        tr.name AS referenced_table_name,
        cr.name AS referenced_column_name,
        fkc.constraint_column_id AS ordinal,
        fk.delete_referential_action_desc AS delete_rule
      FROM sys.foreign_keys fk
      JOIN sys.tables tp ON fk.parent_object_id = tp.object_id
      JOIN sys.tables tr ON fk.referenced_object_id = tr.object_id
      JOIN sys.foreign_key_columns fkc ON fk.object_id = fkc.constraint_object_id
      JOIN sys.columns cp ON fkc.parent_object_id = cp.object_id AND fkc.parent_column_id = cp.column_id
      JOIN sys.columns cr ON fkc.referenced_object_id = cr.object_id AND fkc.referenced_column_id = cr.column_id
      WHERE tp.is_ms_shipped = 0
        ${tableFilterFk}
      ORDER BY tp.name, fk.name, fkc.constraint_column_id
    `;

    const [columnsRows, pkRows, uqRows, fkRows] = await Promise.all([
      mssqlConnector.executeQuery(columnsQuery),
      mssqlConnector.executeQuery(pkQuery),
      mssqlConnector.executeQuery(uqQuery),
      mssqlConnector.executeQuery(fkQuery),
    ]);

    const tableMap = new Map<string, TableDDL>();

    // Process columns
    for (const row of columnsRows) {
      const tableName = String(row.table_name).toUpperCase();
      if (!tableMap.has(tableName)) {
        tableMap.set(tableName, {
          tableName,
          columns: [],
          uniqueKeys: [],
          foreignKeys: [],
        });
      }

      tableMap.get(tableName)!.columns.push({
        name: String(row.column_name).toUpperCase(),
        dataType: String(row.data_type),
        maxLength: Number(row.max_length),
        precision: row.precision !== null ? Number(row.precision) : null,
        scale: row.scale !== null ? Number(row.scale) : null,
        nullable: Boolean(row.is_nullable),
        defaultValue: row.default_value ? String(row.default_value) : null,
        isIdentity: Boolean(row.is_identity),
      });
    }

    // Process Primary Keys
    for (const row of pkRows) {
      const tableName = String(row.table_name).toUpperCase();
      const table = tableMap.get(tableName);
      if (table) {
        if (!table.primaryKey) {
          table.primaryKey = {
            constraintName: String(row.constraint_name),
            columns: [],
          };
        }
        table.primaryKey.columns.push(String(row.column_name).toUpperCase());
      }
    }

    // Process Unique Keys
    const uqMap = new Map<string, UniqueKeyDDL>();
    for (const row of uqRows) {
      const tableName = String(row.table_name).toUpperCase();
      const constraintName = String(row.constraint_name);
      const key = `${tableName}:${constraintName}`;

      if (!uqMap.has(key)) {
        uqMap.set(key, {
          constraintName,
          columns: [],
        });
      }
      uqMap.get(key)!.columns.push(String(row.column_name).toUpperCase());
    }

    for (const [key, uq] of uqMap.entries()) {
      const tableName = key.split(':')[0];
      const table = tableMap.get(tableName);
      if (table) {
        table.uniqueKeys.push(uq);
      }
    }

    // Process Foreign Keys
    const fkGroupMap = new Map<string, ForeignKeyDDL>();
    for (const row of fkRows) {
      const sourceTable = String(row.table_name).toUpperCase();
      const constraintName = String(row.constraint_name);
      const groupKey = `${sourceTable}:${constraintName}`;

      if (!fkGroupMap.has(groupKey)) {
        fkGroupMap.set(groupKey, {
          constraintName,
          sourceTable,
          sourceColumns: [],
          referencedTable: String(row.referenced_table_name).toUpperCase(),
          referencedColumns: [],
          deleteRule: String(row.delete_rule || 'NO_ACTION'),
        });
      }

      const fkDef = fkGroupMap.get(groupKey)!;
      fkDef.sourceColumns.push(String(row.column_name).toUpperCase());
      fkDef.referencedColumns.push(String(row.referenced_column_name).toUpperCase());
    }

    for (const fkDef of fkGroupMap.values()) {
      const table = tableMap.get(fkDef.sourceTable);
      if (table) {
        table.foreignKeys.push(fkDef);
      }
    }

    const tables = Array.from(tableMap.values());
    logger.info(`Extracted DDL metadata for ${tables.length} tables from MSSQL`, 'DDLService');
    return tables;
  }

  /**
   * Generates Oracle-compatible DDL statements from extracted metadata
   */
  generateOracleDDL(tables: TableDDL[]): DDLGenerationResult {
    const tableStatements: { tableName: string; sql: string }[] = [];
    const pkStatements: { tableName: string; constraintName: string; sql: string }[] = [];
    const uqStatements: { tableName: string; constraintName: string; sql: string }[] = [];
    const fkStatements: { tableName: string; constraintName: string; sql: string }[] = [];

    const scriptParts: string[] = [
      '--',
      '-- Oracle DDL Generated by Conversor-MSSQL-Oracle',
      `-- Generated on: ${new Date().toISOString()}`,
      `-- Total Tables: ${tables.length}`,
      '--',
      'WHENEVER SQLERROR CONTINUE;',
      '',
    ];

    // 1. Generate CREATE TABLE statements
    scriptParts.push('-- ========================================================');
    scriptParts.push('-- 1. CREATE TABLES');
    scriptParts.push('-- ========================================================');

    for (const table of tables) {
      const colDefs: string[] = [];

      for (const col of table.columns) {
        const oracleType = this.mapDataTypeToOracle(col);
        const parts: string[] = [`  "${col.name}" ${oracleType}`];

        const sanitizedDefault = this.sanitizeDefaultValue(col.defaultValue);
        if (sanitizedDefault !== null) {
          parts.push(`DEFAULT ${sanitizedDefault}`);
        }

        if (!col.nullable) {
          parts.push('NOT NULL');
        }

        colDefs.push(parts.join(' '));
      }

      const createSql = `CREATE TABLE "${table.tableName}" (\n${colDefs.join(',\n')}\n)`;
      tableStatements.push({ tableName: table.tableName, sql: createSql });
      scriptParts.push(`${createSql};`);
      scriptParts.push('');
    }

    // 2. Generate Primary Key Constraints
    scriptParts.push('-- ========================================================');
    scriptParts.push('-- 2. PRIMARY KEY CONSTRAINTS');
    scriptParts.push('-- ========================================================');

    for (const table of tables) {
      if (table.primaryKey && table.primaryKey.columns.length > 0) {
        const rawPkName = table.primaryKey.constraintName || `PK_${table.tableName}`;
        const sanitizedPkName = this.sanitizeIdentifier(rawPkName);
        const colList = table.primaryKey.columns.map((c) => `"${c}"`).join(', ');

        const pkSql = `ALTER TABLE "${table.tableName}" ADD CONSTRAINT "${sanitizedPkName}" PRIMARY KEY (${colList})`;
        pkStatements.push({
          tableName: table.tableName,
          constraintName: sanitizedPkName,
          sql: pkSql,
        });
        scriptParts.push(`${pkSql};`);
      }
    }
    scriptParts.push('');

    // 3. Generate Unique Constraints
    scriptParts.push('-- ========================================================');
    scriptParts.push('-- 3. UNIQUE CONSTRAINTS');
    scriptParts.push('-- ========================================================');

    for (const table of tables) {
      for (const uq of table.uniqueKeys) {
        if (uq.columns.length > 0) {
          const rawUqName = uq.constraintName || `UQ_${table.tableName}`;
          const sanitizedUqName = this.sanitizeIdentifier(rawUqName);
          const colList = uq.columns.map((c) => `"${c}"`).join(', ');

          const uqSql = `ALTER TABLE "${table.tableName}" ADD CONSTRAINT "${sanitizedUqName}" UNIQUE (${colList})`;
          uqStatements.push({
            tableName: table.tableName,
            constraintName: sanitizedUqName,
            sql: uqSql,
          });
          scriptParts.push(`${uqSql};`);
        }
      }
    }
    scriptParts.push('');

    // 4. Generate Foreign Key Constraints
    scriptParts.push('-- ========================================================');
    scriptParts.push('-- 4. FOREIGN KEY CONSTRAINTS');
    scriptParts.push('-- ========================================================');

    for (const table of tables) {
      for (const fk of table.foreignKeys) {
        if (fk.sourceColumns.length > 0 && fk.referencedColumns.length > 0) {
          const rawFkName = fk.constraintName || `FK_${fk.sourceTable}_${fk.referencedTable}`;
          const sanitizedFkName = this.sanitizeIdentifier(rawFkName);
          const srcCols = fk.sourceColumns.map((c) => `"${c}"`).join(', ');
          const refCols = fk.referencedColumns.map((c) => `"${c}"`).join(', ');

          let onDel = '';
          if (fk.deleteRule === 'CASCADE') {
            onDel = ' ON DELETE CASCADE';
          } else if (fk.deleteRule === 'SET_NULL') {
            onDel = ' ON DELETE SET NULL';
          }

          const fkSql = `ALTER TABLE "${fk.sourceTable}" ADD CONSTRAINT "${sanitizedFkName}" FOREIGN KEY (${srcCols}) REFERENCES "${fk.referencedTable}" (${refCols})${onDel}`;
          fkStatements.push({
            tableName: fk.sourceTable,
            constraintName: sanitizedFkName,
            sql: fkSql,
          });
          scriptParts.push(`${fkSql};`);
        }
      }
    }
    scriptParts.push('');

    const sqlScript = scriptParts.join('\n');

    return {
      sqlScript,
      tableStatements,
      pkStatements,
      uqStatements,
      fkStatements,
    };
  }

  /**
   * Save DDL script to a file
   */
  saveDDLToFile(filePath: string, ddlContent: string): string {
    const resolvedPath = path.resolve(process.cwd(), filePath);
    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(resolvedPath, ddlContent, 'utf-8');
    logger.info(`DDL script successfully saved to: ${resolvedPath}`, 'DDLService');
    return resolvedPath;
  }

  /**
   * Check if Oracle user schema is completely clean (0 tables)
   */
  async isOracleClean(): Promise<boolean> {
    try {
      const existingTables = await oracleConnector.getAllTableNames();
      return existingTables.length === 0;
    } catch (error) {
      logger.error('Error checking if Oracle schema is clean', error as Error, 'DDLService');
      return false;
    }
  }

  /**
   * Applies the generated DDL statements to Oracle
   */
  async applyDDLToOracle(
    ddlResult: DDLGenerationResult,
    options: { filterExisting?: boolean } = { filterExisting: true }
  ): Promise<DDLApplyResult> {
    const result: DDLApplyResult = {
      tablesCreated: 0,
      pksCreated: 0,
      uqsCreated: 0,
      fksCreated: 0,
      errors: [],
    };

    const existingTables = new Set(await oracleConnector.getAllTableNames());
    logger.info(
      `Applying DDL to Oracle (${existingTables.size} tables already exist in Oracle schema)...`,
      'DDLService'
    );

    // 1. Create Tables
    for (const stmt of ddlResult.tableStatements) {
      if (options.filterExisting && existingTables.has(stmt.tableName)) {
        logger.debug(`Table ${stmt.tableName} already exists in Oracle. Skipping CREATE.`, 'DDLService');
        continue;
      }

      try {
        await oracleConnector.executeQuery(stmt.sql);
        result.tablesCreated++;
        existingTables.add(stmt.tableName);
        logger.info(`[DDL] Table created: ${stmt.tableName}`, 'DDLService');
      } catch (error) {
        const msg = (error as Error).message;
        logger.error(`[DDL] Failed to create table ${stmt.tableName}: ${msg}`, error as Error, 'DDLService');
        result.errors.push({
          stage: 'CREATE_TABLE',
          target: stmt.tableName,
          error: msg,
          sql: stmt.sql,
        });
      }
    }

    // 2. Add Primary Keys
    for (const stmt of ddlResult.pkStatements) {
      if (!existingTables.has(stmt.tableName)) continue;

      try {
        await oracleConnector.executeQuery(stmt.sql);
        result.pksCreated++;
        logger.info(`[DDL] PK added: ${stmt.constraintName} on ${stmt.tableName}`, 'DDLService');
      } catch (error) {
        const msg = (error as Error).message;
        // Ignore if constraint already exists (ORA-02260 or ORA-02261)
        if (msg.includes('ORA-02260') || msg.includes('ORA-02261')) {
          logger.debug(`PK on ${stmt.tableName} already exists`, 'DDLService');
        } else {
          logger.warn(`[DDL] Failed to add PK ${stmt.constraintName} on ${stmt.tableName}: ${msg}`, 'DDLService');
          result.errors.push({
            stage: 'PRIMARY_KEY',
            target: stmt.constraintName,
            error: msg,
            sql: stmt.sql,
          });
        }
      }
    }

    // 3. Add Unique Constraints
    for (const stmt of ddlResult.uqStatements) {
      if (!existingTables.has(stmt.tableName)) continue;

      try {
        await oracleConnector.executeQuery(stmt.sql);
        result.uqsCreated++;
        logger.info(`[DDL] Unique constraint added: ${stmt.constraintName} on ${stmt.tableName}`, 'DDLService');
      } catch (error) {
        const msg = (error as Error).message;
        if (msg.includes('ORA-02261')) {
          logger.debug(`Unique constraint on ${stmt.tableName} already exists`, 'DDLService');
        } else {
          logger.warn(`[DDL] Failed to add UQ ${stmt.constraintName} on ${stmt.tableName}: ${msg}`, 'DDLService');
          result.errors.push({
            stage: 'UNIQUE_KEY',
            target: stmt.constraintName,
            error: msg,
            sql: stmt.sql,
          });
        }
      }
    }

    // 4. Add Foreign Keys
    for (const stmt of ddlResult.fkStatements) {
      if (!existingTables.has(stmt.tableName)) continue;

      try {
        await oracleConnector.executeQuery(stmt.sql);
        result.fksCreated++;
        logger.info(`[DDL] FK added: ${stmt.constraintName} on ${stmt.tableName}`, 'DDLService');
      } catch (error) {
        const msg = (error as Error).message;
        if (msg.includes('ORA-02275')) {
          logger.debug(`FK ${stmt.constraintName} already exists`, 'DDLService');
        } else {
          logger.warn(`[DDL] Failed to add FK ${stmt.constraintName} on ${stmt.tableName}: ${msg}`, 'DDLService');
          result.errors.push({
            stage: 'FOREIGN_KEY',
            target: stmt.constraintName,
            error: msg,
            sql: stmt.sql,
          });
        }
      }
    }

    logger.info(
      `DDL Application completed: ${result.tablesCreated} tables, ${result.pksCreated} PKs, ${result.uqsCreated} UQs, ${result.fksCreated} FKs created. (${result.errors.length} errors)`,
      'DDLService'
    );

    return result;
  }
}

export const ddlService = new DDLService();
