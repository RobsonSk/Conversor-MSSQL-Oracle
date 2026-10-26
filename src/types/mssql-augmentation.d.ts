import 'mssql';

declare module 'mssql' {
  interface Request {
    timeout?: number;
  }
}
