import pg from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { config } from './config.js';

export const pool = new pg.Pool({ ...config.db, max: 10, connectionTimeoutMillis: 3000 });
pool.on('error', () => {}); // conexões ociosas perdidas são recriadas sob demanda

export const estado = { migrado: false };

// Chave arbitrária do advisory lock: garante que só uma réplica aplica migrations por vez.
const LOCK_MIGRATIONS = 4104;

async function aplicarMigrations(log: FastifyBaseLogger): Promise<void> {
  const dir = path.resolve(process.cwd(), 'migrations');
  const cliente = await pool.connect();
  try {
    await cliente.query('SELECT pg_advisory_lock($1)', [LOCK_MIGRATIONS]);
    await cliente.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (versao text PRIMARY KEY, aplicada_em timestamptz NOT NULL DEFAULT now())',
    );
    const { rows } = await cliente.query<{ versao: string }>('SELECT versao FROM schema_migrations');
    const aplicadas = new Set(rows.map((r) => r.versao));
    const arquivos = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    for (const arquivo of arquivos) {
      if (aplicadas.has(arquivo)) continue;
      const sql = await readFile(path.join(dir, arquivo), 'utf8');
      await cliente.query('BEGIN');
      try {
        await cliente.query(sql);
        await cliente.query('INSERT INTO schema_migrations (versao) VALUES ($1)', [arquivo]);
        await cliente.query('COMMIT');
        log.info({ arquivo }, 'migration aplicada');
      } catch (erro) {
        await cliente.query('ROLLBACK');
        throw erro;
      }
    }
  } finally {
    await cliente.query('SELECT pg_advisory_unlock($1)', [LOCK_MIGRATIONS]).catch(() => {});
    cliente.release();
  }
}

// Tenta até conseguir: o processo sobe e responde /health mesmo sem banco,
// mas /ready só fica OK depois que as migrations forem aplicadas.
export async function migrarComRetentativas(log: FastifyBaseLogger): Promise<void> {
  for (let tentativa = 1; ; tentativa++) {
    try {
      await aplicarMigrations(log);
      estado.migrado = true;
      log.info('banco pronto');
      return;
    } catch (erro) {
      const espera = Math.min(1000 * tentativa, 10_000);
      log.warn({ err: (erro as Error).message, tentativa }, `banco indisponível, nova tentativa em ${espera}ms`);
      await new Promise((r) => setTimeout(r, espera));
    }
  }
}

export async function bancoRespondendo(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}
