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
  amqp: {
    hostname: obrigatoria('AMQP_HOST'),
    port: Number(process.env.AMQP_PORT ?? 5672),
    username: obrigatoria('AMQP_USER'),
    password: obrigatoria('AMQP_PASSWORD'),
  },
  outbox: {
    intervaloMs: Number(process.env.OUTBOX_INTERVALO_MS ?? 500),
  },
  // Assistente com RAG: o LLM é uma dependência REMOTA e falível (Ollama).
  assistente: {
    ollamaUrl: process.env.OLLAMA_URL ?? 'http://ollama:11434',
    modelo: process.env.LLM_MODELO ?? 'qwen2.5:0.5b',
    modeloEmbeddings: process.env.EMBEDDINGS_MODELO ?? 'bge-m3',
    // timeout de cada tentativa e política de retry com backoff exponencial
    timeoutMs: Number(process.env.LLM_TIMEOUT_MS ?? 20_000),
    tentativas: Number(process.env.LLM_TENTATIVAS ?? 2),
    // orçamento TOTAL de uma pergunta (embedding + tools + geração, com retries). Tem de ser menor
    // que o timeout de quem chama (BFF 50 s; no Kubernetes, o Envoy do Ingress corta em 15 s):
    // estourou o orçamento → fallback, em vez de o cliente receber 504 da borda.
    orcamentoMs: Number(process.env.ASSISTENTE_ORCAMENTO_MS ?? 45_000),
    backoffMs: Number(process.env.LLM_BACKOFF_MS ?? 1_000),
    // circuit breaker: abre após N falhas seguidas e fica aberto por X ms antes de testar de novo
    circuitoFalhas: Number(process.env.LLM_CIRCUITO_FALHAS ?? 3),
    circuitoAbertoMs: Number(process.env.LLM_CIRCUITO_ABERTO_MS ?? 30_000),
    // cache das respostas: validade e similaridade mínima para o cache semântico
    cacheTtlS: Number(process.env.LLM_CACHE_TTL_S ?? 86_400),
    cacheSimilaridade: Number(process.env.LLM_CACHE_SIMILARIDADE ?? 0.95),
    // quantos trechos a recuperação devolve
    k: Number(process.env.RAG_K ?? 3),
    // ingestão é trabalho de fundo: a 1ª chamada carrega o modelo de embeddings na memória
    // (lenta num cluster frio), então usa prazo próprio e não passa pelo circuit breaker
    ingestaoTimeoutMs: Number(process.env.RAG_INGESTAO_TIMEOUT_MS ?? 120_000),
    dirConhecimento: process.env.RAG_DIR ?? 'conhecimento',
  },
};
