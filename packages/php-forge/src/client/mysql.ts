// Connexion MySQL / MariaDB (mysql2, MIT), chargée seulement à la première commande « Refresh SQL schema ».
import type { ConnectionSettings, Driver } from './sqlSchema.ts';

export async function mysqlDriver(c: ConnectionSettings, password: string): Promise<Driver> {
  const mysql = await import('mysql2/promise');
  const connection = await mysql.createConnection({ host: c.host, port: c.port, user: c.user, password, database: c.database, connectTimeout: 10_000 });
  return {
    query: async (sql, params) => (await connection.query(sql, params))[0] as unknown[],
    end: () => connection.end(),
  };
}
