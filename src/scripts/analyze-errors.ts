/**
 * Error Analyzer and Fix Script Generator
 * Parses logs and pending adjustments to generate SQL corrective scripts for Oracle
 */

import * as fs from 'fs';
import * as path from 'path';
import { mssqlConnector } from '../connectors/mssql.connector';
import { TypeMapper } from '../utils/type-mapper';

// Load environment variables
require('dotenv').config();

const LOGS_DIR = path.resolve(process.cwd(), 'logs');
const FIXES_DIR = path.resolve(process.cwd(), 'fixes');
const ERRORS_LOG_PATH = path.join(LOGS_DIR, 'errors.log');
const DATA_ERRORS_LOG_PATH = path.join(LOGS_DIR, 'data-errors.log');
const PENDING_ADJUSTMENTS_PATH = path.join(LOGS_DIR, 'pending-adjustments.json');
const MISSING_COLUMNS_LOG_PATH = path.join(LOGS_DIR, 'missing-columns.log');
const MIGRATION_LOG_PATH = path.join(LOGS_DIR, 'migration.log');

interface MissingColumn {
  tableName: string;
  columnName: string;
  dataType: string;
}

interface NullColumn {
  tableName: string;
  columnName: string;
}

interface LengthOverflowColumn {
  tableName: string;
  columnName: string;
  actualLength: number;
  maxLength: number;
}

async function runAnalyzer() {
  console.log('\n========================================================');
  console.log('       MSSQL to Oracle - Gerador de Scripts de Correção  ');
  console.log('========================================================\n');

  // Ensure fixes directory exists
  if (!fs.existsSync(FIXES_DIR)) {
    fs.mkdirSync(FIXES_DIR, { recursive: true });
  }

  const missingTables: Set<string> = new Set();
  const missingColumns: Map<string, MissingColumn> = new Map(); // key: table.column
  const nullColumns: Map<string, NullColumn> = new Map(); // key: table.column
  const lengthOverflowColumns: Map<string, LengthOverflowColumn> = new Map(); // key: table.column

  // 1. Parse pending-adjustments.json (Isolated error rows from migration)
  if (fs.existsSync(PENDING_ADJUSTMENTS_PATH)) {
    console.log(`Lendo ajustes pendentes: ${PENDING_ADJUSTMENTS_PATH}`);
    try {
      const pendingContent = fs.readFileSync(PENDING_ADJUSTMENTS_PATH, 'utf-8');
      const items = JSON.parse(pendingContent);
      for (const item of items) {
        if (item.errorMessage && item.errorMessage.includes('ORA-12899')) {
          const tbl = item.tableName.toUpperCase();
          const col = item.columnName ? item.columnName.toUpperCase() : 'VALOR';
          const act = item.actualLength || 100;
          const max = item.maxLength || 30;
          const key = `${tbl}.${col}`;
          if (!lengthOverflowColumns.has(key) || lengthOverflowColumns.get(key)!.actualLength < act) {
            lengthOverflowColumns.set(key, { tableName: tbl, columnName: col, actualLength: act, maxLength: max });
          }
        } else if (item.errorMessage && item.errorMessage.includes('ORA-01400')) {
          const tbl = item.tableName.toUpperCase();
          const col = item.columnName ? item.columnName.toUpperCase() : '';
          if (col) {
            nullColumns.set(`${tbl}.${col}`, { tableName: tbl, columnName: col });
          }
        }
      }
    } catch (_) {}
  }

  // 2. Parse errors.log & data-errors.log & migration.log
  const logFilesToScan = [
    ERRORS_LOG_PATH,
    DATA_ERRORS_LOG_PATH,
    MIGRATION_LOG_PATH,
    path.resolve(process.cwd(), 'errors.log'),
    path.resolve(process.cwd(), 'log', 'migration.log'),
    path.resolve(process.cwd(), 'log', 'errors.log'),
    path.resolve(process.cwd(), 'log', 'data-errors.log'),
  ];
  for (const logPath of logFilesToScan) {
    if (!fs.existsSync(logPath)) continue;
    console.log(`Lendo arquivo de log: ${logPath}`);
    const content = fs.readFileSync(logPath, 'utf-8');
    const lines = content.split('\n');

    for (const line of lines) {
      // Detect missing tables
      const tableNotExistMatch1 = line.match(/Target table (\w+) does not exist in Oracle/i);
      const tableNotExistMatch2 = line.match(/Target table (\w+) not found in Oracle database/i);
      const missingTable = tableNotExistMatch1?.[1] || tableNotExistMatch2?.[1];
      if (missingTable) {
        missingTables.add(missingTable.toUpperCase());
      }

      // Detect ORA-01400 (Cannot insert NULL)
      const ora1400Match = line.match(/ORA-01400:\s*[^"]+(?:"[^"]+"\.)*(?:"[^"]+"\.)*"([^"]+)"/i);
      if (ora1400Match) {
        // Also try to find table name in line
        const tableMatch = line.match(/(?:table|em|into)\s+"?([A-Za-z0-9_]+)"?\."?([A-Za-z0-9_]+)"?/i);
        const tableName = tableMatch ? tableMatch[2].toUpperCase() : 'UNKNOWN';
        const columnName = ora1400Match[1].toUpperCase();
        if (tableName !== 'UNKNOWN') {
          nullColumns.set(`${tableName}.${columnName}`, { tableName, columnName });
        }
      }

      // Detect ORA-12899 (Value too large for column)
      // ORA-12899: valor muito grande para a coluna "CNP"."GER_PARAM_CORINGA"."VALOR" (real: 70, máximo: 30)
      const ora12899Match = line.match(
        /ORA-12899:\s*[^"]*(?:"[^"]+"\.)*"([A-Za-z0-9_]+)"\."([A-Za-z0-9_]+)"\s*\((?:real|actual):\s*(\d+),\s*(?:m[áa]ximo|maximum):\s*(\d+)\)/i
      );
      if (ora12899Match) {
        const tableName = ora12899Match[1].toUpperCase();
        const columnName = ora12899Match[2].toUpperCase();
        const actualLength = parseInt(ora12899Match[3], 10);
        const maxLength = parseInt(ora12899Match[4], 10);
        const key = `${tableName}.${columnName}`;

        if (!lengthOverflowColumns.has(key) || lengthOverflowColumns.get(key)!.actualLength < actualLength) {
          lengthOverflowColumns.set(key, { tableName, columnName, actualLength, maxLength });
        }
      }
    }
  }

  // 3. Parse missing-columns.log
  if (fs.existsSync(MISSING_COLUMNS_LOG_PATH)) {
    console.log(`Lendo arquivo de colunas ausentes: ${MISSING_COLUMNS_LOG_PATH}`);
    const missingColsContent = fs.readFileSync(MISSING_COLUMNS_LOG_PATH, 'utf-8');
    const lines = missingColsContent.split('\n');

    for (const line of lines) {
      const colMatch = line.match(/Table:\s*(\w+)\s*-\s*Column:\s*(\w+)\s*\(Type in MSSQL:\s*([^)]+)\)/i);
      if (colMatch) {
        const tableName = colMatch[1].toUpperCase();
        const columnName = colMatch[2].toUpperCase();
        const dataType = colMatch[3].toUpperCase();
        missingColumns.set(`${tableName}.${columnName}`, { tableName, columnName, dataType });
      }
    }
  }

  console.log(`\nResumo da análise:`);
  console.log(`- Tabelas ausentes detectadas: ${missingTables.size}`);
  console.log(`- Colunas ausentes detectadas: ${missingColumns.size}`);
  console.log(`- Erros de valores nulos (NOT NULL - ORA-01400): ${nullColumns.size}`);
  console.log(`- Erros de tamanho de string (ORA-12899): ${lengthOverflowColumns.size}`);

  if (
    missingTables.size === 0 &&
    missingColumns.size === 0 &&
    nullColumns.size === 0 &&
    lengthOverflowColumns.size === 0
  ) {
    console.log('\nNenhum erro pendente que necessite de geração de scripts SQL.');
    generateConstraintScripts();
    return;
  }

  // Connect to MSSQL to fetch original column definitions
  let mssqlConnected = false;
  try {
    console.log('\nConectando ao MSSQL para ler schemas originais...');
    await mssqlConnector.connect();
    mssqlConnected = true;
    console.log('Conectado ao MSSQL.');
  } catch (err) {
    console.warn('AVISO: Não foi possível conectar ao MSSQL. Gerando DDLs de tabelas/colunas com tipos genéricos.');
  }

  // Generate scripts
  generateConstraintScripts();

  if (missingTables.size > 0) {
    await generateCreateTablesScript(missingTables, mssqlConnected);
  }

  if (missingColumns.size > 0) {
    await generateAddColumnsScript(Array.from(missingColumns.values()), mssqlConnected);
  }

  if (nullColumns.size > 0) {
    generateMakeColumnsNullableScript(Array.from(nullColumns.values()));
  }

  if (lengthOverflowColumns.size > 0) {
    await generateAlterColumnsLengthScript(Array.from(lengthOverflowColumns.values()), mssqlConnected);
  }

  if (mssqlConnected) {
    await mssqlConnector.disconnect();
  }

  console.log('\n========================================================');
  console.log('Scripts SQL gerados com sucesso na pasta ./fixes/ :');
  console.log('1. 1_disable_constraints.sql    (Desabilita chaves estrangeiras)');
  if (missingTables.size > 0) console.log('2. 2_create_missing_tables.sql   (Cria tabelas ausentes no Oracle)');
  if (missingColumns.size > 0) console.log('3. 3_add_missing_columns.sql     (Adiciona colunas faltantes no Oracle)');
  if (nullColumns.size > 0) console.log('4. 4_make_columns_nullable.sql   (Permite valores nulos para evitar ORA-01400)');
  if (lengthOverflowColumns.size > 0) console.log('5. 5_alter_columns_length.sql    (Expande colunas para corrigir ORA-12899)');
  console.log('6. 6_enable_constraints.sql     (Reabilita chaves estrangeiras)');
  console.log('========================================================');
  console.log('DICA: Após aplicar o script 5_alter_columns_length.sql no Oracle,');
  console.log('execute "npm run retry-pending" para re-inserir os registros pendentes sem re-migrar tudo!\n');
}

/**
 * Generate scripts to disable and enable constraints
 */
function generateConstraintScripts() {
  const disableSql = `-- Script para desabilitar temporariamente todas as FKs no Oracle
BEGIN
  FOR r IN (SELECT table_name, constraint_name FROM user_constraints WHERE constraint_type = 'R' AND status = 'ENABLED') LOOP
    EXECUTE IMMEDIATE 'ALTER TABLE "' || r.table_name || '" DISABLE CONSTRAINT "' || r.constraint_name || '"';
  END LOOP;
END;
/
`;

  const enableSql = `-- Script para reabilitar todas as FKs no Oracle
BEGIN
  FOR r IN (SELECT table_name, constraint_name FROM user_constraints WHERE constraint_type = 'R' AND status = 'DISABLED') LOOP
    BEGIN
      EXECUTE IMMEDIATE 'ALTER TABLE "' || r.table_name || '" ENABLE CONSTRAINT "' || r.constraint_name || '"';
    EXCEPTION
      WHEN OTHERS THEN
        DBMS_OUTPUT.PUT_LINE('Nao foi possivel reativar a constraint ' || r.constraint_name || ' na tabela ' || r.table_name || ': ' || SQLERRM);
    END;
  END LOOP;
END;
/
`;

  fs.writeFileSync(path.join(FIXES_DIR, '1_disable_constraints.sql'), disableSql);
  fs.writeFileSync(path.join(FIXES_DIR, '6_enable_constraints.sql'), enableSql);
}

/**
 * Generate DDL for missing tables
 */
async function generateCreateTablesScript(tables: Set<string>, mssqlConnected: boolean) {
  let sqlContent = '-- Script para criar tabelas ausentes no Oracle\n\n';

  for (const tableName of tables) {
    sqlContent += `-- Tabela: ${tableName}\n`;
    let columnsDDL: string[] = [];
    let primaryKeys: string[] = [];

    if (mssqlConnected) {
      try {
        const schema = await mssqlConnector.getTableSchema(tableName);
        for (const col of schema) {
          const oracleType = TypeMapper.getMappedType(col.dataType, col.maxLength, col.precision, col.scale);
          const nullability = col.nullable ? 'NULL' : 'NOT NULL';
          columnsDDL.push(`  "${col.name.toUpperCase()}" ${oracleType} ${nullability}`);
          if (col.isPrimaryKey) {
            primaryKeys.push(col.name.toUpperCase());
          }
        }
      } catch (err) {
        console.error(`Erro ao obter schema para tabela ${tableName} do MSSQL:`, err);
        columnsDDL.push('  -- Erro ao carregar colunas do MSSQL. Defina a estrutura manualmente.');
      }
    } else {
      columnsDDL.push('  "ID" NUMBER(19,0) NOT NULL');
      columnsDDL.push('  "DESCRICAO" VARCHAR2(255)');
      primaryKeys.push('ID');
    }

    sqlContent += `CREATE TABLE "${tableName}" (\n`;
    sqlContent += columnsDDL.join(',\n');

    if (primaryKeys.length > 0) {
      sqlContent += `,\n  CONSTRAINT "PK_${tableName}" PRIMARY KEY (${primaryKeys.map((k) => `"${k}"`).join(', ')})`;
    }

    sqlContent += '\n);\n\n';
  }

  fs.writeFileSync(path.join(FIXES_DIR, '2_create_missing_tables.sql'), sqlContent);
}

/**
 * Generate DDL to add missing columns
 */
async function generateAddColumnsScript(columns: MissingColumn[], mssqlConnected: boolean) {
  let sqlContent = '-- Script para adicionar colunas faltantes no Oracle\n\n';

  const tableGroups: Map<string, MissingColumn[]> = new Map();
  for (const col of columns) {
    if (!tableGroups.has(col.tableName)) {
      tableGroups.set(col.tableName, []);
    }
    tableGroups.get(col.tableName)!.push(col);
  }

  for (const [tableName, cols] of tableGroups.entries()) {
    sqlContent += `-- Tabela: ${tableName}\n`;
    for (const col of cols) {
      let oracleType = 'VARCHAR2(255) NULL';

      if (mssqlConnected) {
        try {
          const schema = await mssqlConnector.getTableSchema(tableName);
          const colDef = schema.find((c) => c.name.toUpperCase() === col.columnName.toUpperCase());
          if (colDef) {
            oracleType = TypeMapper.getMappedType(colDef.dataType, colDef.maxLength, colDef.precision, colDef.scale);
            oracleType += colDef.nullable ? ' NULL' : ' NOT NULL';
          } else {
            oracleType = TypeMapper.getMappedType(col.dataType);
          }
        } catch (_) {
          oracleType = TypeMapper.getMappedType(col.dataType);
        }
      } else {
        oracleType = TypeMapper.getMappedType(col.dataType);
      }

      sqlContent += `ALTER TABLE "${tableName}" ADD ("${col.columnName}" ${oracleType});\n`;
    }
    sqlContent += '\n';
  }

  fs.writeFileSync(path.join(FIXES_DIR, '3_add_missing_columns.sql'), sqlContent);
}

/**
 * Generate DDL to make columns nullable (fixes ORA-01400)
 */
function generateMakeColumnsNullableScript(columns: NullColumn[]) {
  let sqlContent = '-- Script para alterar colunas NOT NULL para permitir NULL (Evita ORA-01400)\n\n';

  for (const col of columns) {
    sqlContent += `ALTER TABLE "${col.tableName}" MODIFY ("${col.columnName}" NULL);\n`;
  }

  fs.writeFileSync(path.join(FIXES_DIR, '4_make_columns_nullable.sql'), sqlContent);
}

/**
 * Generate DDL to expand column size (fixes ORA-12899)
 */
async function generateAlterColumnsLengthScript(columns: LengthOverflowColumn[], mssqlConnected: boolean) {
  let sqlContent = '-- Script para expandir tamanho de colunas no Oracle (Corrige ORA-12899)\n\n';

  for (const col of columns) {
    let targetLength = Math.max(col.actualLength, 100);

    if (mssqlConnected) {
      try {
        const schema = await mssqlConnector.getTableSchema(col.tableName);
        const colDef = schema.find((c) => c.name.toUpperCase() === col.columnName.toUpperCase());
        if (colDef && colDef.maxLength && colDef.maxLength > 0) {
          const mssqlLen = colDef.dataType.toUpperCase().startsWith('N')
            ? Math.ceil(colDef.maxLength / 2)
            : colDef.maxLength;
          targetLength = Math.max(targetLength, mssqlLen);
        }
      } catch (_) {}
    }

    sqlContent += `-- Tabela: ${col.tableName} | Coluna: ${col.columnName} (Atual no Oracle: VARCHAR2(${col.maxLength}), Conteudo real: ${col.actualLength} caracteres)\n`;
    sqlContent += `ALTER TABLE "${col.tableName}" MODIFY ("${col.columnName}" VARCHAR2(${targetLength}));\n\n`;
  }

  fs.writeFileSync(path.join(FIXES_DIR, '5_alter_columns_length.sql'), sqlContent);
}

// Run the script
runAnalyzer().catch((err) => {
  console.error('Falha ao analisar erros:', err);
  process.exit(1);
});
