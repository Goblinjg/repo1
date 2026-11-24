import type { FastifyBaseLogger } from 'fastify';
import type { Evento } from './broker.js';
import { emTransacao, primeiraVez } from './outbox/relay.js';

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
    await emTransacao(async (c) => {
      if (!(await primeiraVez(c, evento, 'contador'))) {
        log.info({ eventoId: evento.id }, 'evento duplicado ignorado');
        return;
      }
      const r = await c.query('UPDATE comunidades SET total_mobilizacoes = total_mobilizacoes + 1 WHERE id = $1', [dados.comunidadeId]);
      log.info({ eventoId: evento.id, comunidadeId: dados.comunidadeId, atualizada: r.rowCount === 1 }, 'mobilizacao.criada processado');
    });
  };
}
