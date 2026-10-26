/**
 * Post-Migration Re-insertion Script
 * Re-inserts pending adjustment rows saved during migration after DDL adjustments (e.g. column resize) have been applied.
 */

import { oracleConnector } from '../connectors/oracle.connector';
import { pendingAdjustmentsService, PendingRowAdjustment } from '../services/pending-adjustments.service';

// Load environment variables
require('dotenv').config();

async function runReinsert() {
  console.log('\n========================================================');
  console.log('   MSSQL to Oracle - Re-processador de Ajustes Pendentes');
  console.log('========================================================\n');

  const pendingList = pendingAdjustmentsService.getAllAdjustments();

  if (pendingList.length === 0) {
    console.log('Nenhum registro pendente de ajuste em logs/pending-adjustments.json.');
    return;
  }

  console.log(`Encontrados ${pendingList.length} registro(s) pendente(s) de inserção.`);

  // Connect to Oracle
  await oracleConnector.connect();

  // Group by table
  const tableGroups = new Map<string, PendingRowAdjustment[]>();
  for (const item of pendingList) {
    const tbl = item.tableName.toUpperCase();
    if (!tableGroups.has(tbl)) {
      tableGroups.set(tbl, []);
    }
    tableGroups.get(tbl)!.push(item);
  }

  const resolvedIds: string[] = [];
  let totalSuccess = 0;
  let totalFailed = 0;

  for (const [tableName, items] of tableGroups.entries()) {
    console.log(`\nProcessando tabela ${tableName} (${items.length} linhas pendentes)...`);

    const tableColumns = await oracleConnector.getTableColumns(tableName);
    if (tableColumns.length === 0) {
      console.warn(`Tabela ${tableName} não encontrada no Oracle. Pulando...`);
      totalFailed += items.length;
      continue;
    }

    const rows = items.map((i) => i.rowData);

    // Extract valid columns
    const upperCols = tableColumns.map((c) => c.toUpperCase());
    const rowSample = rows[0];
    const targetCols = Object.keys(rowSample).filter((col) => upperCols.includes(col.toUpperCase()));

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const row = item.rowData;

      const placeholders = targetCols.map((_, idx) => `:${idx + 1}`).join(', ');
      const sql = `INSERT INTO "${tableName}" (${targetCols.map((c) => `"${c.toUpperCase()}"`).join(', ')}) VALUES (${placeholders})`;
      const binds = targetCols.map((col) => (row[col] === undefined ? null : row[col]));

      try {
        await oracleConnector.executeQuery(sql, binds);
        resolvedIds.push(item.id);
        totalSuccess++;
        console.log(`  [OK] Linha ${i + 1}/${items.length} inserida com sucesso.`);
      } catch (err) {
        totalFailed++;
        console.warn(`  [FALHA] Linha ${i + 1}/${items.length} ainda falhou: ${(err as Error).message}`);
      }
    }
  }

  if (resolvedIds.length > 0) {
    pendingAdjustmentsService.removeAdjustments(resolvedIds);
    console.log(`\n${resolvedIds.length} registro(s) resolvido(s) e removido(s) de logs/pending-adjustments.json.`);
  }

  await oracleConnector.disconnect();

  console.log('\n========================================================');
  console.log(`Resumo do re-processamento:`);
  console.log(`- Total inserido com sucesso: ${totalSuccess}`);
  console.log(`- Total ainda pendente: ${totalFailed}`);
  if (totalFailed > 0) {
    console.log('Execute "npm run analyze-errors" para gerar scripts de ajuste DDL (ex: ALTER TABLE MODIFY).');
  }
  console.log('========================================================\n');
}

runReinsert().catch((err) => {
  console.error('Falha ao re-inserir dados pendentes:', err);
  process.exit(1);
});
