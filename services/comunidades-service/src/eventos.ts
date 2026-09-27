import type { FastifyBaseLogger } from 'fastify';
import type { Evento } from './broker.js';
import { pool } from './db.js';

interface MobilizacaoCriada {
  mobilizacaoId: string;
  comunidadeId: string;
  dataHora: string;
}

// Consumidor idempotente: o id do evento é registrado na mesma transação da atualização,
// então uma reentrega (at-least-once) não incrementa o contador duas vezes.
export function aoCriarMobilizacao(log: FastifyBaseLogger) {
  return async (evento: Evento): Promise<void> => {
    const dados = evento.dados as MobilizacaoCriada;
    const cliente = await pool.connect();
    try {
      await cliente.query('BEGIN');
      const novo = await cliente.query(
        'INSERT INTO eventos_processados (evento_id, tipo) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [evento.id, evento.tipo],
      );
      if (novo.rowCount) {
        const r = await cliente.query(
          'UPDATE comunidades SET total_mobilizacoes = total_mobilizacoes + 1 WHERE id = $1',
          [dados.comunidadeId],
        );
        log.info({ eventoId: evento.id, comunidadeId: dados.comunidadeId, atualizada: r.rowCount === 1 }, 'mobilizacao.criada processado');
      } else {
        log.info({ eventoId: evento.id }, 'evento duplicado ignorado');
      }
      await cliente.query('COMMIT');
    } catch (erro) {
      await cliente.query('ROLLBACK');
      throw erro;
    } finally {
      cliente.release();
    }
  };
}
