// Toda a configuração vem de variáveis de ambiente (ConfigMap/Secret no K8s, .env no compose).
import os from 'node:os';

function obrigatoria(nome: string): string {
  const valor = process.env[nome];
  if (!valor) throw new Error(`Variável de ambiente obrigatória ausente: ${nome}`);
  return valor;
}

export const config = {
  servico: 'informacoes-service',
  porta: Number(process.env.PORT ?? 3004),
  logLevel: process.env.LOG_LEVEL ?? 'info',
  // No K8s, POD_NAME vem da Downward API; no compose, o hostname é o id do container.
  instancia: process.env.POD_NAME ?? os.hostname(),
  db: {
    host: obrigatoria('DB_HOST'),
    port: Number(process.env.DB_PORT ?? 5432),
    database: obrigatoria('DB_NAME'),
    user: obrigatoria('DB_USER'),
    password: obrigatoria('DB_PASSWORD'),
  },
};
