// Conexão com o RabbitMQ: publicação com confirmação (usada só pelo relay da outbox)
// e consumo com ack manual. Arquivo idêntico em todos os serviços que usam mensageria.
import amqp from 'amqplib';
import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { config } from './config.js';

export const EXCHANGE = '4life.events';

// Topologia COMPLETA do sistema. Todo serviço declara todas as filas e bindings ao conectar
// (declarar é idempotente): numa exchange topic, mensagem sem fila ligada é descartada, então
// nenhum evento ou comando se perde por causa da ordem em que os serviços sobem.
export const TOPOLOGIA: { fila: string; chaves: string[] }[] = [
  // evento de integração: contador de mobilizações da comunidade
  { fila: 'comunidades.mobilizacao-criada', chaves: ['mobilizacao.criada'] },
  // CQRS: projeção do painel da comunidade
  {
    fila: 'comunidades.painel',
    chaves: [
      'comunidade.criada',
      'membro.entrou',
      'membro.saiu',
      'mobilizacao.criada',
      'mobilizacao.cancelada',
      'mobilizacao.sincronizada',
      'doador.cadastrado',
      'doador.atualizado',
    ],
  },
  // SAGA: comandos para os participantes e respostas para o orquestrador
  { fila: 'saga.comunidades.comandos', chaves: ['saga.comunidades.*'] },
  { fila: 'saga.informacoes.comandos', chaves: ['saga.informacoes.*'] },
  { fila: 'saga.mobilizacoes.respostas', chaves: ['saga.resposta.*'] },
];

export interface Evento<T = unknown> {
  id: string;
  tipo: string;
  ocorridoEm: string;
  dados: T;
}

export interface Assinatura {
  fila: string;
  handler: (evento: Evento) => Promise<void>;
  // 1 = processa uma mensagem por vez e preserva a ordem da fila (necessário nos comandos da SAGA)
  prefetch?: number;
}

type Conexao = Awaited<ReturnType<typeof amqp.connect>>;
type CanalConfirmacao = Awaited<ReturnType<Conexao['createConfirmChannel']>>;

let canalPublicacao: CanalConfirmacao | null = null;
export const brokerConectado = () => canalPublicacao !== null;

export function criarEvento<T>(tipo: string, dados: T): Evento<T> {
  return { id: randomUUID(), tipo, ocorridoEm: new Date().toISOString(), dados };
}

// Conecta com retentativas, declara a topologia, abre o canal de publicação e começa a
// consumir as filas assinadas. Se a conexão cair, refaz tudo sozinho.
export async function conectarBroker(log: FastifyBaseLogger, assinaturas: Assinatura[] = []): Promise<void> {
  for (let tentativa = 1; ; tentativa++) {
    try {
      const conexao = await amqp.connect({ protocol: 'amqp', ...config.amqp });
      conexao.on('error', (erro) => log.warn({ err: erro.message }, 'erro na conexão com o broker'));
      conexao.on('close', () => {
        canalPublicacao = null;
        log.warn('conexão com o broker encerrada; reconectando');
        setTimeout(() => void conectarBroker(log, assinaturas), 2000);
      });

      const canal = await conexao.createConfirmChannel();
      await canal.assertExchange(EXCHANGE, 'topic', { durable: true });
      for (const { fila, chaves } of TOPOLOGIA) {
        await canal.assertQueue(fila, { durable: true });
        for (const chave of chaves) await canal.bindQueue(fila, EXCHANGE, chave);
      }

      for (const { fila, handler, prefetch = 10 } of assinaturas) {
        const consumo = await conexao.createChannel();
        await consumo.prefetch(prefetch);
        await consumo.consume(fila, async (msg) => {
          if (!msg) return;
          let evento: Evento;
          try {
            evento = JSON.parse(msg.content.toString());
          } catch {
            log.error({ fila }, 'mensagem inválida descartada');
            consumo.nack(msg, false, false);
            return;
          }
          try {
            await handler(evento);
            consumo.ack(msg);
          } catch (erro) {
            log.error({ err: (erro as Error).message, eventoId: evento.id, tipo: evento.tipo }, 'falha ao processar; devolvendo à fila');
            setTimeout(() => consumo.nack(msg, false, true), 2000);
          }
        });
        log.info({ fila }, 'consumindo');
      }

      canalPublicacao = canal;
      log.info('conectado ao broker');
      return;
    } catch (erro) {
      const espera = Math.min(1000 * tentativa, 10_000);
      log.warn({ err: (erro as Error).message }, `broker indisponível, nova tentativa em ${espera}ms`);
      await new Promise((r) => setTimeout(r, espera));
    }
  }
}

// Publica uma mensagem persistente e espera o publisher confirm do broker.
// A routing key é o próprio tipo do evento/comando.
export async function publicar(evento: Evento): Promise<void> {
  const canal = canalPublicacao;
  if (!canal) throw new Error('broker indisponível');
  canal.publish(EXCHANGE, evento.tipo, Buffer.from(JSON.stringify(evento)), {
    persistent: true,
    contentType: 'application/json',
    messageId: evento.id,
    type: evento.tipo,
  });
  await canal.waitForConfirms();
}
