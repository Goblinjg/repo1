// Toda a configuração vem de variáveis de ambiente.
import os from 'node:os';

function obrigatoria(nome: string): string {
  const valor = process.env[nome];
  if (!valor) throw new Error(`Variável de ambiente obrigatória ausente: ${nome}`);
  return valor;
}

export const config = {
  servico: process.env.SERVICE_NAME ?? 'bff-mobile',
  porta: Number(process.env.PORT ?? 4001),
  logLevel: process.env.LOG_LEVEL ?? 'info',
  instancia: process.env.POD_NAME ?? os.hostname(),
  timeoutMs: Number(process.env.UPSTREAM_TIMEOUT_MS ?? 3000),
  urls: {
    doadores: obrigatoria('DOADORES_URL'),
    comunidades: obrigatoria('COMUNIDADES_URL'),
    mobilizacoes: obrigatoria('MOBILIZACOES_URL'),
    informacoes: obrigatoria('INFORMACOES_URL'),
  },
};
