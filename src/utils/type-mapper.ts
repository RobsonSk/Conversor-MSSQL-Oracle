/**
 * Type Mapper Utility - Maps MSSQL data types to Oracle equivalents
 */

export interface TypeMapping {
  mssqlType: string;
  oracleType: string;
  requiresConversion: boolean;
  conversionFunction?: (value: any) => any;
}

export class TypeMapper {
  private static readonly TYPE_MAPPINGS: Map<string, TypeMapping> = new Map([
    // Numeric types
    ['TINYINT', { mssqlType: 'TINYINT', oracleType: 'NUMBER(3,0)', requiresConversion: false }],
    ['SMALLINT', { mssqlType: 'SMALLINT', oracleType: 'NUMBER(5,0)', requiresConversion: false }],
    ['INT', { mssqlType: 'INT', oracleType: 'NUMBER(10,0)', requiresConversion: false }],
    ['BIGINT', { mssqlType: 'BIGINT', oracleType: 'NUMBER(19,0)', requiresConversion: false }],
    ['DECIMAL', { mssqlType: 'DECIMAL', oracleType: 'NUMBER', requiresConversion: false }],
    ['NUMERIC', { mssqlType: 'NUMERIC', oracleType: 'NUMBER', requiresConversion: false }],
    ['FLOAT', { mssqlType: 'FLOAT', oracleType: 'BINARY_DOUBLE', requiresConversion: false }],
    ['REAL', { mssqlType: 'REAL', oracleType: 'BINARY_FLOAT', requiresConversion: false }],
    ['MONEY', { mssqlType: 'MONEY', oracleType: 'NUMBER(19,4)', requiresConversion: false }],
    ['SMALLMONEY', { mssqlType: 'SMALLMONEY', oracleType: 'NUMBER(10,4)', requiresConversion: false }],

    // Character types
    ['CHAR', { mssqlType: 'CHAR', oracleType: 'CHAR', requiresConversion: false }],
    ['VARCHAR', { mssqlType: 'VARCHAR', oracleType: 'VARCHAR2', requiresConversion: false }],
    ['TEXT', { mssqlType: 'TEXT', oracleType: 'CLOB', requiresConversion: true }],
    ['NCHAR', { mssqlType: 'NCHAR', oracleType: 'NCHAR', requiresConversion: false }],
    ['NVARCHAR', { mssqlType: 'NVARCHAR', oracleType: 'NVARCHAR2', requiresConversion: false }],
    ['NTEXT', { mssqlType: 'NTEXT', oracleType: 'NCLOB', requiresConversion: true }],

    // Date/Time types
    ['DATE', { mssqlType: 'DATE', oracleType: 'DATE', requiresConversion: false }],
    ['TIME', { mssqlType: 'TIME', oracleType: 'TIMESTAMP', requiresConversion: true }],
    ['DATETIME', { mssqlType: 'DATETIME', oracleType: 'TIMESTAMP', requiresConversion: false }],
    ['DATETIME2', { mssqlType: 'DATETIME2', oracleType: 'TIMESTAMP', requiresConversion: false }],
    ['DATETIMEOFFSET', { mssqlType: 'DATETIMEOFFSET', oracleType: 'TIMESTAMP WITH TIME ZONE', requiresConversion: true }],
    ['SMALLDATETIME', { mssqlType: 'SMALLDATETIME', oracleType: 'TIMESTAMP', requiresConversion: false }],

    // Binary types
    ['BINARY', { mssqlType: 'BINARY', oracleType: 'RAW', requiresConversion: false }],
    ['VARBINARY', { mssqlType: 'VARBINARY', oracleType: 'RAW', requiresConversion: false }],
    ['IMAGE', { mssqlType: 'IMAGE', oracleType: 'BLOB', requiresConversion: true }],

    // Special types
    ['BIT', { mssqlType: 'BIT', oracleType: 'CHAR(1)', requiresConversion: true }],
    ['UNIQUEIDENTIFIER', { mssqlType: 'UNIQUEIDENTIFIER', oracleType: 'CHAR(36)', requiresConversion: true }],
  ]);

  /**
   * Get Oracle type for MSSQL type
   */
  static getMappedType(mssqlType: string, maxLength?: number, precision?: number, scale?: number): string {
    const cleanType = mssqlType.toUpperCase().split('(')[0];
    const mapping = this.TYPE_MAPPINGS.get(cleanType);

    if (!mapping) {
      return 'VARCHAR2(4000)'; // Default fallback
    }

    let oracleType = mapping.oracleType;

    // Handle variable length types
    if (cleanType === 'VARCHAR' || cleanType === 'NVARCHAR' || cleanType === 'CHAR' || cleanType === 'NCHAR') {
      if (maxLength && maxLength > 0) {
        const size = cleanType.startsWith('N') ? Math.ceil(maxLength / 2) : maxLength;
        const maxSize = cleanType.startsWith('N') ? 2000 : 4000;
        if (size > maxSize) {
          oracleType = cleanType.startsWith('N') ? 'NCLOB' : 'CLOB';
        } else {
          oracleType = `${oracleType}(${size})`;
        }
      } else if (maxLength === -1) {
        oracleType = cleanType.startsWith('N') ? 'NCLOB' : 'CLOB';
      } else {
        oracleType = cleanType.startsWith('N') ? 'NVARCHAR2(2000)' : 'VARCHAR2(4000)';
      }
    }

    // Handle numeric precision and scale
    if ((cleanType === 'DECIMAL' || cleanType === 'NUMERIC') && precision) {
      const sc = scale || 0;
      oracleType = `NUMBER(${precision},${sc})`;
    }

    return oracleType;
  }

  /**
   * Check if type requires conversion during data transformation
   */
  static requiresConversion(mssqlType: string): boolean {
    const cleanType = mssqlType.toUpperCase().split('(')[0];
    const mapping = this.TYPE_MAPPINGS.get(cleanType);
    return mapping ? mapping.requiresConversion : false;
  }

  /**
   * Get all mapped types
   */
  static getAllMappings(): Map<string, TypeMapping> {
    return new Map(this.TYPE_MAPPINGS);
  }

  /**
   * Validate type compatibility
   */
  static isTypeCompatible(mssqlType: string): boolean {
    const cleanType = mssqlType.toUpperCase().split('(')[0];
    return this.TYPE_MAPPINGS.has(cleanType);
  }
}
