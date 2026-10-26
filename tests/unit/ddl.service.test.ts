import { ddlService, TableDDL } from '../../src/services/ddl.service';
import { oracleConnector } from '../../src/connectors/oracle.connector';

jest.mock('../../src/connectors/mssql.connector', () => ({
  mssqlConnector: {
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    executeQuery: jest.fn(),
  },
}));

jest.mock('../../src/connectors/oracle.connector', () => ({
  oracleConnector: {
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    getAllTableNames: jest.fn(),
    executeQuery: jest.fn().mockResolvedValue(undefined),
  },
}));

describe('DDLService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('sanitizeIdentifier', () => {
    it('deve manter identificadores com ate 30 caracteres em maiusculas', () => {
      const name = 'PK_GER_REVENDA';
      const sanitized = ddlService.sanitizeIdentifier(name);
      expect(sanitized).toBe('PK_GER_REVENDA');
      expect(sanitized.length).toBeLessThanOrEqual(30);
    });

    it('deve encurtar identificadores com mais de 30 caracteres garantindo <= 30 chars e unicidade', () => {
      const longName = 'FK_OFI_FICHA_PERIODICOS_OFI_ATENDIMENTO_ID_VERY_LONG';
      const sanitized = ddlService.sanitizeIdentifier(longName);
      expect(sanitized.length).toBeLessThanOrEqual(30);
      expect(sanitized.startsWith('FK_OFI_FICHA_PERIODICOS')).toBe(true);
      // Deve ser determinístico para o mesmo input
      const repeat = ddlService.sanitizeIdentifier(longName);
      expect(sanitized).toBe(repeat);
    });
  });

  describe('mapDataTypeToOracle', () => {
    it('deve mapear tipos numericos corretamente', () => {
      expect(ddlService.mapDataTypeToOracle({ name: 'C1', dataType: 'int', maxLength: 4, precision: 10, scale: 0, nullable: true, defaultValue: null, isIdentity: false })).toBe('NUMBER(10,0)');
      expect(ddlService.mapDataTypeToOracle({ name: 'C2', dataType: 'bigint', maxLength: 8, precision: 19, scale: 0, nullable: true, defaultValue: null, isIdentity: false })).toBe('NUMBER(19,0)');
      expect(ddlService.mapDataTypeToOracle({ name: 'C3', dataType: 'smallint', maxLength: 2, precision: 5, scale: 0, nullable: true, defaultValue: null, isIdentity: false })).toBe('NUMBER(5,0)');
      expect(ddlService.mapDataTypeToOracle({ name: 'C4', dataType: 'decimal', maxLength: 9, precision: 18, scale: 2, nullable: true, defaultValue: null, isIdentity: false })).toBe('NUMBER(18,2)');
      expect(ddlService.mapDataTypeToOracle({ name: 'C5', dataType: 'bit', maxLength: 1, precision: 1, scale: 0, nullable: true, defaultValue: null, isIdentity: false })).toBe('CHAR(1)');
    });

    it('deve mapear strings e CLOBs corretamente', () => {
      expect(ddlService.mapDataTypeToOracle({ name: 'C1', dataType: 'varchar', maxLength: 50, precision: null, scale: null, nullable: true, defaultValue: null, isIdentity: false })).toBe('VARCHAR2(50)');
      expect(ddlService.mapDataTypeToOracle({ name: 'C2', dataType: 'varchar', maxLength: -1, precision: null, scale: null, nullable: true, defaultValue: null, isIdentity: false })).toBe('CLOB');
      expect(ddlService.mapDataTypeToOracle({ name: 'C3', dataType: 'nvarchar', maxLength: 100, precision: null, scale: null, nullable: true, defaultValue: null, isIdentity: false })).toBe('NVARCHAR2(50)');
      expect(ddlService.mapDataTypeToOracle({ name: 'C4', dataType: 'text', maxLength: 16, precision: null, scale: null, nullable: true, defaultValue: null, isIdentity: false })).toBe('CLOB');
    });

    it('deve mapear datas e timestamps corretamente', () => {
      expect(ddlService.mapDataTypeToOracle({ name: 'C1', dataType: 'datetime', maxLength: 8, precision: null, scale: null, nullable: true, defaultValue: null, isIdentity: false })).toBe('TIMESTAMP');
      expect(ddlService.mapDataTypeToOracle({ name: 'C2', dataType: 'date', maxLength: 3, precision: null, scale: null, nullable: true, defaultValue: null, isIdentity: false })).toBe('DATE');
    });
  });

  describe('sanitizeDefaultValue', () => {
    it('deve desembrulhar parenteses multiplos e literais', () => {
      expect(ddlService.sanitizeDefaultValue('((0))')).toBe('0');
      expect(ddlService.sanitizeDefaultValue("('S')")).toBe("'S'");
      expect(ddlService.sanitizeDefaultValue("(N'TESTE')")).toBe("'TESTE'");
    });

    it('deve converter getdate() para SYSDATE e newid() para SYS_GUID()', () => {
      expect(ddlService.sanitizeDefaultValue('(getdate())')).toBe('SYSDATE');
      expect(ddlService.sanitizeDefaultValue('(newid())')).toBe('SYS_GUID()');
    });
  });

  describe('generateOracleDDL', () => {
    it('deve gerar CREATE TABLE, PK e FK corretamente', () => {
      const mockTables: TableDDL[] = [
        {
          tableName: 'GER_EMPRESA',
          columns: [
            { name: 'ID_EMPRESA', dataType: 'int', maxLength: 4, precision: 10, scale: 0, nullable: false, defaultValue: null, isIdentity: true },
            { name: 'NOME', dataType: 'varchar', maxLength: 100, precision: null, scale: null, nullable: true, defaultValue: null, isIdentity: false },
          ],
          primaryKey: {
            constraintName: 'PK_GER_EMPRESA',
            columns: ['ID_EMPRESA'],
          },
          uniqueKeys: [],
          foreignKeys: [],
        },
        {
          tableName: 'GER_USUARIO',
          columns: [
            { name: 'ID_USUARIO', dataType: 'int', maxLength: 4, precision: 10, scale: 0, nullable: false, defaultValue: null, isIdentity: true },
            { name: 'ID_EMPRESA', dataType: 'int', maxLength: 4, precision: 10, scale: 0, nullable: false, defaultValue: null, isIdentity: false },
            { name: 'ATIVO', dataType: 'bit', maxLength: 1, precision: 1, scale: 0, nullable: false, defaultValue: '((1))', isIdentity: false },
          ],
          primaryKey: {
            constraintName: 'PK_GER_USUARIO',
            columns: ['ID_USUARIO'],
          },
          uniqueKeys: [],
          foreignKeys: [
            {
              constraintName: 'FK_USUARIO_EMPRESA',
              sourceTable: 'GER_USUARIO',
              sourceColumns: ['ID_EMPRESA'],
              referencedTable: 'GER_EMPRESA',
              referencedColumns: ['ID_EMPRESA'],
              deleteRule: 'CASCADE',
            },
          ],
        },
      ];

      const result = ddlService.generateOracleDDL(mockTables);

      expect(result.tableStatements).toHaveLength(2);
      expect(result.pkStatements).toHaveLength(2);
      expect(result.fkStatements).toHaveLength(1);

      expect(result.tableStatements[0].sql).toContain('CREATE TABLE "GER_EMPRESA"');
      expect(result.tableStatements[0].sql).toContain('"ID_EMPRESA" NUMBER(10,0) NOT NULL');
      expect(result.tableStatements[1].sql).toContain('"ATIVO" CHAR(1) DEFAULT 1 NOT NULL');

      expect(result.pkStatements[0].sql).toBe('ALTER TABLE "GER_EMPRESA" ADD CONSTRAINT "PK_GER_EMPRESA" PRIMARY KEY ("ID_EMPRESA")');
      expect(result.fkStatements[0].sql).toContain('ALTER TABLE "GER_USUARIO" ADD CONSTRAINT "FK_USUARIO_EMPRESA" FOREIGN KEY ("ID_EMPRESA") REFERENCES "GER_EMPRESA" ("ID_EMPRESA") ON DELETE CASCADE');

      expect(result.sqlScript).toContain('CREATE TABLE "GER_EMPRESA"');
      expect(result.sqlScript).toContain('CREATE TABLE "GER_USUARIO"');
      expect(result.sqlScript).toContain('ALTER TABLE "GER_USUARIO" ADD CONSTRAINT');
    });
  });

  describe('isOracleClean', () => {
    it('deve retornar true quando getAllTableNames retornar array vazio', async () => {
      (oracleConnector.getAllTableNames as jest.Mock).mockResolvedValueOnce([]);
      const isClean = await ddlService.isOracleClean();
      expect(isClean).toBe(true);
    });

    it('deve retornar false quando existirem tabelas no Oracle', async () => {
      (oracleConnector.getAllTableNames as jest.Mock).mockResolvedValueOnce(['GER_REVENDA', 'OFI_ATENDIMENTO']);
      const isClean = await ddlService.isOracleClean();
      expect(isClean).toBe(false);
    });
  });

  describe('applyDDLToOracle', () => {
    it('deve aplicar comandos no Oracle ignorando tabelas que ja existem', async () => {
      (oracleConnector.getAllTableNames as jest.Mock).mockResolvedValueOnce(['GER_EMPRESA']);

      const ddlResult = {
        sqlScript: '',
        tableStatements: [
          { tableName: 'GER_EMPRESA', sql: 'CREATE TABLE "GER_EMPRESA" ("ID" NUMBER)' },
          { tableName: 'GER_USUARIO', sql: 'CREATE TABLE "GER_USUARIO" ("ID" NUMBER)' },
        ],
        pkStatements: [
          { tableName: 'GER_USUARIO', constraintName: 'PK_GER_USUARIO', sql: 'ALTER TABLE "GER_USUARIO" ADD CONSTRAINT "PK_GER_USUARIO" PRIMARY KEY ("ID")' },
        ],
        uqStatements: [],
        fkStatements: [],
      };

      const result = await ddlService.applyDDLToOracle(ddlResult, { filterExisting: true });

      expect(result.tablesCreated).toBe(1); // Apenas GER_USUARIO foi criada
      expect(result.pksCreated).toBe(1);
      expect(oracleConnector.executeQuery).toHaveBeenCalledWith('CREATE TABLE "GER_USUARIO" ("ID" NUMBER)');
      expect(oracleConnector.executeQuery).toHaveBeenCalledWith('ALTER TABLE "GER_USUARIO" ADD CONSTRAINT "PK_GER_USUARIO" PRIMARY KEY ("ID")');
    });
  });
});
