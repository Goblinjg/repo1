// O LLM é tratado como dependência remota falível: cada chamada passa por
// timeout + retry com backoff, dentro de um circuit breaker.
import type { FastifyBaseLogger } from 'fastify';

export class CircuitoAberto extends Error {
  constructor(readonly nome: string, readonly reabreEmMs: number) {
    super(`circuito ${nome} aberto; nova tentativa em ${Math.ceil(reabreEmMs / 1000)}s`);
  }
}

export class TempoEsgotado extends Error {}

type EstadoCircuito = 'FECHADO' | 'ABERTO' | 'MEIO_ABERTO';

// FECHADO: chamadas passam; conta falhas seguidas.
// ABERTO: depois de `limiteFalhas` falhas, rejeita na hora (sem esperar o timeout) por `tempoAbertoMs`.
// MEIO_ABERTO: passado esse tempo, deixa UMA chamada de teste passar; sucesso fecha, falha reabre.
export class CircuitBreaker {
  private estado: EstadoCircuito = 'FECHADO';
  private falhasSeguidas = 0;
  private abertoEm = 0;
  private testando = false;
  private totais = { sucessos: 0, falhas: 0, rejeitadas: 0 };

  constructor(
    private readonly nome: string,
    private readonly limiteFalhas: number,
    private readonly tempoAbertoMs: number,
    private readonly log: FastifyBaseLogger,
  ) {}

  async executar<T>(fn: () => Promise<T>): Promise<T> {
    if (this.estado === 'ABERTO') {
      const restante = this.tempoAbertoMs - (Date.now() - this.abertoEm);
      if (restante > 0) {
        this.totais.rejeitadas++;
        throw new CircuitoAberto(this.nome, restante);
      }
      this.estado = 'MEIO_ABERTO';
      this.log.info({ circuito: this.nome }, 'circuit breaker MEIO_ABERTO: testando o provedor');
    }
    if (this.estado === 'MEIO_ABERTO') {
      if (this.testando) {
        this.totais.rejeitadas++;
        throw new CircuitoAberto(this.nome, 1000);
      }
      this.testando = true;
    }
    try {
      const resultado = await fn();
      this.sucesso();
      return resultado;
    } catch (erro) {
      this.falha(erro as Error);
      throw erro;
    } finally {
      this.testando = false;
    }
  }

  private sucesso() {
    this.totais.sucessos++;
    if (this.estado !== 'FECHADO') this.log.info({ circuito: this.nome }, 'circuit breaker FECHADO: provedor respondeu');
    this.estado = 'FECHADO';
    this.falhasSeguidas = 0;
  }

  private falha(erro: Error) {
    this.totais.falhas++;
    this.falhasSeguidas++;
    if (this.estado === 'MEIO_ABERTO' || this.falhasSeguidas >= this.limiteFalhas) {
      this.estado = 'ABERTO';
      this.abertoEm = Date.now();
      this.log.warn({ circuito: this.nome, falhasSeguidas: this.falhasSeguidas, err: erro.message }, 'circuit breaker ABERTO');
    }
  }

  status() {
    const reabreEmMs = this.estado === 'ABERTO' ? Math.max(this.tempoAbertoMs - (Date.now() - this.abertoEm), 0) : 0;
    return { estado: this.estado, falhasSeguidas: this.falhasSeguidas, reabreEmMs, ...this.totais };
  }
}

interface OpcoesRetry {
  timeoutMs: number;
  tentativas: number;
  backoffMs: number;
  rotulo: string;
  log: FastifyBaseLogger;
}

// Cada tentativa tem seu próprio prazo (AbortSignal). Entre tentativas, espera
// backoff exponencial com jitter: backoffMs, 2×backoffMs, 4×backoffMs... (±25%).
export async function comTimeoutERetry<T>(fn: (signal: AbortSignal) => Promise<T>, o: OpcoesRetry): Promise<T> {
  for (let tentativa = 1; ; tentativa++) {
    const controle = new AbortController();
    const timer = setTimeout(() => controle.abort(new TempoEsgotado(`${o.rotulo}: sem resposta em ${o.timeoutMs}ms`)), o.timeoutMs);
    try {
      // a corrida garante o prazo mesmo se a função ignorar o sinal
      return await Promise.race([
        fn(controle.signal),
        new Promise<never>((_, rejeitar) => controle.signal.addEventListener('abort', () => rejeitar(controle.signal.reason))),
      ]);
    } catch (erro) {
      if (tentativa >= o.tentativas) throw erro;
      const espera = Math.round(o.backoffMs * 2 ** (tentativa - 1) * (0.75 + Math.random() * 0.5));
      o.log.warn({ rotulo: o.rotulo, tentativa, err: (erro as Error).message, esperaMs: espera }, 'chamada ao LLM falhou; nova tentativa');
      await new Promise((r) => setTimeout(r, espera));
    } finally {
      clearTimeout(timer);
    }
  }
}
