// Toda a configuração vem de variáveis de ambiente.
import os from 'node:os';

function obrigatoria(nome: string): string {
  const valor = process.env[nome];
  if (!valor) throw new Error(`Variável de ambiente obrigatória ausente: ${nome}`);
  return valor;
}

const segredo = obrigatoria('JWT_SECRET');
if (segredo.length < 32) throw new Error('JWT_SECRET deve ter pelo menos 32 caracteres');

export const config = {
  servico: 'gateway',
  porta: Number(process.env.PORT ?? 8080),
  logLevel: process.env.LOG_LEVEL ?? 'info',
  instancia: process.env.POD_NAME ?? os.hostname(),
  timeoutMs: Number(process.env.UPSTREAM_TIMEOUT_MS ?? 5000),
  jwt: {
    segredo: new TextEncoder().encode(segredo),
    emissor: process.env.JWT_ISSUER ?? '4life-gateway',
    expiraEmSegundos: Number(process.env.JWT_EXPIRES_IN_S ?? 3600),
  },
  bffMobile: obrigatoria('BFF_MOBILE_URL'),
  bffWeb: obrigatoria('BFF_WEB_URL'),
};
