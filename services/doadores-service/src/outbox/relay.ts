// Transactional Outbox: quem muda o domínio grava o evento na tabela `outbox` NA MESMA
// transação (gravarNaOutbox). Este relay publica as pendências no RabbitMQ.
// Arquivo idêntico em todos os serviços que publicam eventos.
import type { FastifyBaseLogger } from 'fastify';
import type pg from 'pg';
import { criarEvento, publicar, type Evento } from '../broker.js';
import { pool } from '../db.js';

export interface OutboxRelay {
  iniciar(intervaloMs: number): void;
  parar(): Promise<void>;
}

interface NovaMensagem<T> {
  agregado: string;
  agregadoId?: string | null;
  tipo: string;
  dados: T;
}

// Grava a mensagem usando a transação do chamador: ou o dado de negócio e a mensagem
// são confirmados juntos, ou nenhum dos dois (sem dual write).
export async function gravarNaOutbox<T>(cliente: pg.PoolClient, m: NovaMensagem<T>): Promise<Evento<T>> {
  const evento = criarEvento(m.tipo, m.dados);
  await cliente.query(
    `INSERT INTO outbox (id, agregado, agregado_id, tipo, payload, criado_em) VALUES ($1, $2, $3, $4, $5, $6)`,
    [evento.id, m.agregado, m.agregadoId ?? null, evento.tipo, JSON.stringify(evento), evento.ocorridoEm],
  );
  return evento;
}

const LOTE = 50;
const MAX_BACKOFF_MS = 30_000;

export function criarRelay(log: FastifyBaseLogger): OutboxRelay {
  let timer: NodeJS.Timeout | null = null;
  let rodando: Promise<void> = Promise.resolve();
  let ultimaLimpeza = 0;

  // Um ciclo: trava até LOTE pendências com SKIP LOCKED (outras réplicas pegam outras linhas),
  // publica uma a uma com publisher confirm e marca como publicada. Se uma falhar, o lote
  // para ali, para não publicar mensagens fora de ordem.
  async function ciclo(): Promise<void> {
    const cliente = await pool.connect();
    try {
      await cliente.query('BEGIN');
      const { rows } = await cliente.query<{ id: string; tipo: string; payload: Evento; tentativas: number }>(
        `SELECT id, tipo, payload, tentativas FROM outbox
          WHERE publicado_em IS NULL AND proxima_tentativa_em <= now()
          ORDER BY criado_em
          LIMIT ${LOTE}
          FOR UPDATE SKIP LOCKED`,
      );
      for (const linha of rows) {
        try {
          await publicar(linha.payload);
          await cliente.query('UPDATE outbox SET publicado_em = now(), ultimo_erro = NULL WHERE id = $1', [linha.id]);
          log.info({ eventoId: linha.id, tipo: linha.tipo }, 'outbox: publicado');
        } catch (erro) {
          const espera = Math.min(500 * 2 ** linha.tentativas, MAX_BACKOFF_MS);
          await cliente.query(
            `UPDATE outbox SET tentativas = tentativas + 1, ultimo_erro = $2,
                    proxima_tentativa_em = now() + ($3 || ' milliseconds')::interval
              WHERE id = $1`,
            [linha.id, (erro as Error).message, String(espera)],
          );
          log.warn({ eventoId: linha.id, tipo: linha.tipo, err: (erro as Error).message, esperaMs: espera }, 'outbox: falha ao publicar');
          break;
        }
      }
      await cliente.query('COMMIT');
    } catch (erro) {
      await cliente.query('ROLLBACK').catch(() => {});
      log.warn({ err: (erro as Error).message }, 'outbox: ciclo do relay falhou');
    } finally {
      cliente.release();
    }

    // limpeza: mensagens publicadas há mais de 7 dias (uma vez por hora)
    if (Date.now() - ultimaLimpeza > 3_600_000) {
      ultimaLimpeza = Date.now();
      await pool.query(`DELETE FROM outbox WHERE publicado_em < now() - interval '7 days'`).catch(() => {});
    }
  }

  return {
    iniciar(intervaloMs: number) {
      const agendar = () => {
        timer = setTimeout(() => {
          rodando = ciclo().finally(agendar);
        }, intervaloMs);
      };
      agendar();
    },
    async parar() {
      if (timer) clearTimeout(timer);
      await rodando;
    },
  };
}

// Consumo idempotente (inbox): registra o id da mensagem na mesma transação do efeito.
// Devolve false se este consumidor já processou a mensagem (reentrega at-least-once).
export async function primeiraVez(cliente: pg.PoolClient, evento: Evento, consumidor: string): Promise<boolean> {
  const r = await cliente.query(
    'INSERT INTO eventos_processados (evento_id, consumidor, tipo) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
    [evento.id, consumidor, evento.tipo],
  );
  return r.rowCount === 1;
}

// Executa fn numa transação e faz COMMIT/ROLLBACK.
export async function emTransacao<T>(fn: (cliente: pg.PoolClient) => Promise<T>): Promise<T> {
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    const resultado = await fn(cliente);
    await cliente.query('COMMIT');
    return resultado;
  } catch (erro) {
    await cliente.query('ROLLBACK').catch(() => {});
    throw erro;
  } finally {
    cliente.release();
  }
}
