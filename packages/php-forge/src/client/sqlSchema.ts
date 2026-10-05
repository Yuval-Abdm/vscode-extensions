// Schéma lu dans la base MySQL / MariaDB (commande « Refresh SQL schema ») : une seule requête en lecture seule sur
// INFORMATION_SCHEMA.COLUMNS, convertie en cache `.vscode/php-forge-schema.json` que le serveur observe.
import type { SchemaCache } from '../server/sql/schema.ts';

export interface ConnectionSettings {
  host: string;
  port: number;
  user: string;
  database: string;
}

export interface ColumnRow {
  TABLE_NAME: string;
  COLUMN_NAME: string;
  COLUMN_TYPE: string;
  IS_NULLABLE: string;
  COLUMN_DEFAULT: string | null;
}

export interface Driver {
  query(sql: string, params: unknown[]): Promise<unknown[]>;
  end(): Promise<void>;
}

export const COLUMNS_QUERY =
  'SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION';

/** Réglages `phpForge.sql.connection` à renseigner avant de se connecter. */
export function missingFields(c: Partial<ConnectionSettings>): string[] {
  return (['host', 'user', 'database'] as const).filter((key) => !c[key]);
}

/** Clé du mot de passe dans le SecretStorage de VS Code. */
export function connectionKey(c: ConnectionSettings): string {
  return `phpForge.sql.password:${c.user}@${c.host}:${c.port}`;
}

export function schemaCache(database: string, rows: ColumnRow[], refreshed: string): SchemaCache {
  const tables = new Map<string, SchemaCache['tables'][number]>();
  for (const row of rows) {
    let table = tables.get(row.TABLE_NAME);
    if (!table) tables.set(row.TABLE_NAME, (table = { name: row.TABLE_NAME, columns: [] }));
    // MariaDB écrit « NULL » pour l'absence de défaut, MySQL null
    const def = row.COLUMN_DEFAULT === null || row.COLUMN_DEFAULT === 'NULL' ? undefined : String(row.COLUMN_DEFAULT);
    table.columns.push({ name: row.COLUMN_NAME, type: row.COLUMN_TYPE, nullable: row.IS_NULLABLE === 'YES', ...(def !== undefined ? { default: def } : {}) });
  }
  return { database, refreshed, tables: [...tables.values()] };
}

export async function fetchSchema(connect: () => Promise<Driver>, database: string, now: Date): Promise<SchemaCache> {
  const db = await connect();
  try {
    await db.query('SET SESSION TRANSACTION READ ONLY', []);
    const rows = (await db.query(COLUMNS_QUERY, [database])) as ColumnRow[];
    return schemaCache(database, rows, now.toISOString());
  } finally {
    await db.end();
  }
}

/** Identifiants refusés : le mot de passe enregistré est effacé. */
export function isAccessDenied(err: unknown): boolean {
  return (err as { code?: string } | undefined)?.code === 'ER_ACCESS_DENIED_ERROR';
}
