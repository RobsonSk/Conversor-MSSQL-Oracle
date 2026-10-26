import { DataConversionMigration } from '../../src/migrations/data-conversion.migration';
import { dataInsertionService } from '../../src/services/data-insertion.service';
import { schemaService } from '../../src/services/schema.service';
import { Table } from '../../src/models/table.model';
import { migrationConfig } from '../../src/config/migration.config';
import { oracleConnector } from '../../src/connectors/oracle.connector';
import { mssqlConnector } from '../../src/connectors/mssql.connector';

jest.mock('../../src/connectors/mssql.connector', () => ({
  mssqlConnector: {
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    getTables: jest.fn().mockResolvedValue(['test_table']),
    getAllTableCounts: jest.fn().mockResolvedValue(new Map([['test_table', 40]])),
    getTableSchema: jest.fn().mockResolvedValue([
      { name: 'id', dataType: 'int', nullable: false, isPrimaryKey: true, isForeignKey: false },
      { name: 'name', dataType: 'varchar', nullable: true, isPrimaryKey: false, isForeignKey: false },
    ]),
    streamTableRows: jest.fn(),
  },
}));

jest.mock('../../src/connectors/oracle.connector', () => ({
  oracleConnector: {
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    getConnection: jest.fn().mockResolvedValue({ close: jest.fn() }),
    getTableColumns: jest.fn().mockResolvedValue(['ID', 'NAME']),
    getTableColumnsMetadata: jest.fn().mockResolvedValue(
      new Map([
        ['ID', { name: 'ID', nullable: false, dataType: 'NUMBER' }],
        ['NAME', { name: 'NAME', nullable: true, dataType: 'VARCHAR2' }],
      ])
    ),
    getAllTableNames: jest.fn().mockResolvedValue(['TEST_TABLE']),
    tableExists: jest.fn().mockResolvedValue(true),
    executeQuery: jest.fn().mockResolvedValue(undefined),
    disableAllSchemaConstraints: jest.fn().mockResolvedValue({ disabled: 0, errors: 0 }),
    enableAllSchemaConstraints: jest.fn().mockResolvedValue({ enabled: 0, errors: 0 }),
    disableConstraints: jest.fn().mockResolvedValue(undefined),
    enableConstraints: jest.fn().mockResolvedValue(undefined),
    truncateTable: jest.fn().mockResolvedValue(undefined),
    getRowCount: jest.fn().mockResolvedValue(40),
    getMaxValue: jest.fn().mockResolvedValue(null),
  },
}));

jest.mock('../../src/services/data-insertion.service', () => ({
  dataInsertionService: {
    prepareTableForInsertion: jest.fn().mockResolvedValue(undefined),
    finalizeTableAfterInsertion: jest.fn().mockResolvedValue(undefined),
    verifyInsertion: jest.fn().mockResolvedValue(true),
    insertBatch: jest.fn(),
    mergeBatch: jest.fn(),
  },
}));

jest.mock('../../src/services/schema.service', () => ({
  schemaService: {
    getTableSchema: jest.fn(),
    getSourceTables: jest.fn(),
    ensureTableColumns: jest.fn().mockResolvedValue(undefined),
  },
}));

describe('DataConversionMigration - Streaming e Concorrência', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('deve processar lotes via streamTableRows chamando insertBatch', async () => {
    migrationConfig.mode = 'test';
    migrationConfig.targetTable = 'test_table';
    migrationConfig.batchSize = 10;
    migrationConfig.concurrency = 2;

    const mockTable = new Table({
      name: 'test_table',
      columns: [
        { name: 'id', dataType: 'int', nullable: false, isPrimaryKey: true, isForeignKey: false },
        { name: 'name', dataType: 'varchar', nullable: true, isPrimaryKey: false, isForeignKey: false },
      ],
      totalRows: 40,
    });

    (schemaService.getTableSchema as jest.Mock).mockResolvedValue(mockTable);

    (mssqlConnector.streamTableRows as jest.Mock).mockImplementation(
      async (_tableName: string, _columnNames: string[], options: any) => {
        for (let b = 1; b <= 4; b++) {
          const mockRows = Array.from({ length: 10 }, (_, i) => ({
            id: (b - 1) * 10 + i + 1,
            name: `Item ${(b - 1) * 10 + i + 1}`,
          }));
          await options.onBatch(mockRows, b);
        }
        return 40;
      }
    );

    (dataInsertionService.insertBatch as jest.Mock).mockResolvedValue(10);

    const migration = new DataConversionMigration();
    await migration.execute();

    expect(schemaService.getTableSchema).toHaveBeenCalledWith('test_table');
    expect(mssqlConnector.streamTableRows).toHaveBeenCalledTimes(1);
    expect(dataInsertionService.insertBatch).toHaveBeenCalledTimes(4);
  });

  it('deve executar ALTER TABLE ADD se houver colunas faltantes e autoAddColumns for true', async () => {
    migrationConfig.mode = 'test';
    migrationConfig.targetTable = 'test_table';
    migrationConfig.batchSize = 10;
    migrationConfig.concurrency = 1;
    migrationConfig.autoAddColumns = true;

    const mockTable = new Table({
      name: 'test_table',
      columns: [
        { name: 'id', dataType: 'int', nullable: false, isPrimaryKey: true, isForeignKey: false },
        { name: 'name', dataType: 'varchar', maxLength: 100, nullable: true, isPrimaryKey: false, isForeignKey: false },
        { name: 'age', dataType: 'int', nullable: true, isPrimaryKey: false, isForeignKey: false },
      ],
      totalRows: 10,
    });

    (schemaService.getTableSchema as jest.Mock).mockResolvedValue(mockTable);
    (oracleConnector.getTableColumns as jest.Mock).mockResolvedValue(['ID', 'NAME']);

    (mssqlConnector.streamTableRows as jest.Mock).mockImplementation(
      async (_tableName: string, _columnNames: string[], options: any) => {
        await options.onBatch([{ id: 1, name: 'Alice', age: 30 }], 1);
        return 1;
      }
    );

    (dataInsertionService.insertBatch as jest.Mock).mockResolvedValue(1);

    const migration = new DataConversionMigration();
    await migration.execute();

    expect(oracleConnector.executeQuery).toHaveBeenCalledWith(
      'ALTER TABLE "TEST_TABLE" ADD ("AGE" NUMBER(10,0))'
    );
  });

  it('deve ignorar colunas faltantes e nao alterar tabela se autoAddColumns for false', async () => {
    migrationConfig.mode = 'test';
    migrationConfig.targetTable = 'test_table';
    migrationConfig.batchSize = 10;
    migrationConfig.concurrency = 1;
    migrationConfig.autoAddColumns = false;

    const mockTable = new Table({
      name: 'test_table',
      columns: [
        { name: 'id', dataType: 'int', nullable: false, isPrimaryKey: true, isForeignKey: false },
        { name: 'name', dataType: 'varchar', maxLength: 100, nullable: true, isPrimaryKey: false, isForeignKey: false },
        { name: 'age', dataType: 'int', nullable: true, isPrimaryKey: false, isForeignKey: false },
      ],
      totalRows: 10,
    });

    (schemaService.getTableSchema as jest.Mock).mockResolvedValue(mockTable);
    (oracleConnector.getTableColumns as jest.Mock).mockResolvedValue(['ID', 'NAME']);

    (mssqlConnector.streamTableRows as jest.Mock).mockImplementation(
      async (_tableName: string, _columnNames: string[], options: any) => {
        await options.onBatch([{ id: 1, name: 'Alice', age: 30 }], 1);
        return 1;
      }
    );

    (dataInsertionService.insertBatch as jest.Mock).mockResolvedValue(1);

    const migration = new DataConversionMigration();
    await migration.execute();

    expect(oracleConnector.executeQuery).not.toHaveBeenCalled();
    expect(mockTable.columns.map((c) => c.name)).toEqual(['id', 'name']);
  });

  it('deve executar mergeBatch em modo incremental quando tabela tem coluna de data e PK', async () => {
    migrationConfig.mode = 'incremental';
    migrationConfig.targetTable = 'test_table';
    migrationConfig.batchSize = 10;
    migrationConfig.concurrency = 1;
    migrationConfig.incrementalCutoff = '2026-07-26 15:00:00';
    migrationConfig.fastReloadThreshold = 0;

    const mockTable = new Table({
      name: 'test_table',
      columns: [
        { name: 'id', dataType: 'int', nullable: false, isPrimaryKey: true, isForeignKey: false },
        { name: 'name', dataType: 'varchar', nullable: true, isPrimaryKey: false, isForeignKey: false },
        { name: 'DATA_ALTERACAO', dataType: 'datetime', nullable: true, isPrimaryKey: false, isForeignKey: false },
      ],
      totalRows: 10,
    });

    (schemaService.getSourceTables as jest.Mock).mockResolvedValue([mockTable]);
    (oracleConnector.getAllTableNames as jest.Mock).mockResolvedValue(['TEST_TABLE']);
    (oracleConnector.getTableColumns as jest.Mock).mockResolvedValue(['ID', 'NAME', 'DATA_ALTERACAO']);
    (oracleConnector.getTableColumnsMetadata as jest.Mock).mockResolvedValue(
      new Map([
        ['ID', { name: 'ID', nullable: false, dataType: 'NUMBER' }],
        ['NAME', { name: 'NAME', nullable: true, dataType: 'VARCHAR2' }],
        ['DATA_ALTERACAO', { name: 'DATA_ALTERACAO', nullable: true, dataType: 'DATE' }],
      ])
    );

    (mssqlConnector.streamTableRows as jest.Mock).mockImplementation(
      async (_tableName: string, _columnNames: string[], options: any) => {
        expect(options.whereClause).toContain('[DATA_ALTERACAO] >=');
        await options.onBatch([{ id: 1, name: 'Alice Updated', DATA_ALTERACAO: new Date() }], 1);
        return 1;
      }
    );

    (dataInsertionService.mergeBatch as jest.Mock).mockResolvedValue(1);

    const migration = new DataConversionMigration();
    await migration.execute();

    expect(dataInsertionService.mergeBatch).toHaveBeenCalledTimes(1);
    expect(dataInsertionService.insertBatch).not.toHaveBeenCalled();
  });
});
