import type { FastifyRequest } from 'fastify';
import { config } from './config.js';

// Serviço respondeu com erro HTTP (4xx é repassado ao cliente; 5xx vira 502).
export class ErroServico extends Error {
  constructor(readonly servico: string, readonly status: number, readonly corpo: unknown) {
    super(`${servico} respondeu ${status}`);
  }
}

// Serviço não respondeu (conexão recusada, DNS, timeout) → 503.
export class ServicoIndisponivel extends Error {
  constructor(readonly servico: string, readonly causa: unknown) {
    super(`${servico} indisponível`);
  }
}

interface Opcoes {
  metodo?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  corpo?: unknown;
  usuario?: string;
}

function servico(nome: string, base: string) {
  return async function chamar<T = any>(caminho: string, { metodo = 'GET', corpo, usuario }: Opcoes = {}): Promise<T> {
    const headers: Record<string, string> = {};
    if (corpo !== undefined) headers['content-type'] = 'application/json';
    if (usuario) headers['x-user-id'] = usuario;
    let resposta: Response;
    try {
      resposta = await fetch(base + caminho, {
        method: metodo,
        headers,
        body: corpo !== undefined ? JSON.stringify(corpo) : undefined,
        signal: AbortSignal.timeout(config.timeoutMs),
      });
    } catch (erro) {
      throw new ServicoIndisponivel(nome, erro);
    }
    const texto = await resposta.text();
    const dados = texto ? JSON.parse(texto) : null;
    if (!resposta.ok) throw new ErroServico(nome, resposta.status, dados);
    return dados as T;
  };
}

export const svc = {
  doadores: servico('doadores-service', config.urls.doadores),
  comunidades: servico('comunidades-service', config.urls.comunidades),
  mobilizacoes: servico('mobilizacoes-service', config.urls.mobilizacoes),
  informacoes: servico('informacoes-service', config.urls.informacoes),
};

// Para dados secundários de uma agregação: se falhar, devolve null e registra um aviso
// em vez de derrubar a tela inteira (degradação graciosa).
export async function opcional<T>(promessa: Promise<T>, avisos: string[], rotulo: string): Promise<T | null> {
  try {
    return await promessa;
  } catch {
    avisos.push(`${rotulo} indisponível no momento`);
    return null;
  }
}

// O gateway injeta x-user-id a partir do JWT validado.
export function usuarioId(req: FastifyRequest): string {
  const id = req.headers['x-user-id'];
  if (typeof id !== 'string' || !id) throw Object.assign(new Error('não autenticado'), { statusCode: 401 });
  return id;
}

export const qs = (params: Record<string, string | boolean | undefined | null>) => {
  const pares = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '');
  return pares.length ? '?' + new URLSearchParams(pares.map(([k, v]) => [k, String(v)])).toString() : '';
};
