import amqp from 'amqplib';
import type { FastifyBaseLogger } from 'fastify';
import { config } from './config.js';

export const EXCHANGE = '4life.events';

export interface Evento<T = unknown> {
  id: string;
  tipo: string;
  ocorridoEm: string;
  dados: T;
}

type Handler = (evento: Evento) => Promise<void>;
interface Assinatura {
  fila: string;
  chave: string;
  handler: Handler;
}

let conectado = false;
export const brokerConectado = () => conectado;

// Consome as filas assinadas com ack manual; reconecta sozinho se a conexão cair.
export async function consumir(log: FastifyBaseLogger, assinaturas: Assinatura[]): Promise<void> {
  for (let tentativa = 1; ; tentativa++) {
    try {
      const conexao = await amqp.connect({ protocol: 'amqp', ...config.amqp });
      conexao.on('error', (erro) => log.warn({ err: erro.message }, 'erro na conexão com o broker'));
      conexao.on('close', () => {
        conectado = false;
        log.warn('conexão com o broker encerrada; reconectando');
        setTimeout(() => void consumir(log, assinaturas), 2000);
      });
      const canal = await conexao.createChannel();
      await canal.assertExchange(EXCHANGE, 'topic', { durable: true });
      await canal.prefetch(10);
      for (const { fila, chave, handler } of assinaturas) {
        await canal.assertQueue(fila, { durable: true });
        await canal.bindQueue(fila, EXCHANGE, chave);
        await canal.consume(fila, async (msg) => {
          if (!msg) return;
          let evento: Evento;
          try {
            evento = JSON.parse(msg.content.toString());
          } catch {
            log.error({ fila }, 'mensagem inválida descartada');
            canal.nack(msg, false, false);
            return;
          }
          try {
            await handler(evento);
            canal.ack(msg);
          } catch (erro) {
            log.error({ err: (erro as Error).message, eventoId: evento.id }, 'falha ao processar; devolvendo à fila');
            setTimeout(() => canal.nack(msg, false, true), 2000);
          }
        });
        log.info({ fila, chave }, 'consumindo');
      }
      conectado = true;
      return;
    } catch (erro) {
      const espera = Math.min(1000 * tentativa, 10_000);
      log.warn({ err: (erro as Error).message }, `broker indisponível, nova tentativa em ${espera}ms`);
      await new Promise((r) => setTimeout(r, espera));
    }
  }
}
