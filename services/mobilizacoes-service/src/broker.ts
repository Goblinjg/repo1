import amqp from 'amqplib';
import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { config } from './config.js';

export const EXCHANGE = '4life.events';

export interface Evento<T = unknown> {
  id: string;
  tipo: string;
  ocorridoEm: string;
  dados: T;
}

type Canal = Awaited<ReturnType<Awaited<ReturnType<typeof amqp.connect>>['createConfirmChannel']>>;
let canal: Canal | null = null;

export const brokerConectado = () => canal !== null;

// Conecta com retentativas e reconecta sozinho se a conexão cair.
export async function conectarBroker(log: FastifyBaseLogger): Promise<void> {
  for (let tentativa = 1; ; tentativa++) {
    try {
      const conexao = await amqp.connect({ protocol: 'amqp', ...config.amqp });
      conexao.on('error', (erro) => log.warn({ err: erro.message }, 'erro na conexão com o broker'));
      conexao.on('close', () => {
        canal = null;
        log.warn('conexão com o broker encerrada; reconectando');
        setTimeout(() => void conectarBroker(log), 2000);
      });
      const novo = await conexao.createConfirmChannel();
      await novo.assertExchange(EXCHANGE, 'topic', { durable: true });
      canal = novo;
      log.info('conectado ao broker');
      return;
    } catch (erro) {
      const espera = Math.min(1000 * tentativa, 10_000);
      log.warn({ err: (erro as Error).message }, `broker indisponível, nova tentativa em ${espera}ms`);
      await new Promise((r) => setTimeout(r, espera));
    }
  }
}

export function criarEvento<T>(tipo: string, dados: T): Evento<T> {
  return { id: randomUUID(), tipo, ocorridoEm: new Date().toISOString(), dados };
}

// Publica com confirmação do broker (publisher confirms).
export async function publicar(evento: Evento): Promise<void> {
  if (!canal) throw new Error('broker indisponível');
  canal.publish(EXCHANGE, evento.tipo, Buffer.from(JSON.stringify(evento)), {
    persistent: true,
    contentType: 'application/json',
    messageId: evento.id,
    type: evento.tipo,
  });
  await canal.waitForConfirms();
}
