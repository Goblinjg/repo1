// Assistente de dúvidas do 4Life: RAG + tools, com o LLM tratado como dependência remota falível.
//
// Ordem de uma pergunta:
//   1. cache por chave (pergunta normalizada)            → origem "cache"
//   2. cache semântico (embedding da pergunta, pgvector)  → origem "cache-semantico"
//   3. cadeia LangChain, com timeout + retry + circuit breaker → origem "llm"
//   4. qualquer falha (timeout, circuito aberto, Ollama fora): fallback sem LLM,
//      com busca textual na base e dados do banco            → origem "fallback"
import { ChatOllama, OllamaEmbeddings } from '@langchain/ollama';
import type { FastifyBaseLogger } from 'fastify';
import { config } from '../config.js';
import { pool } from '../db.js';
import { criarCadeia, type Fonte, type UsoFerramenta } from './cadeia.js';
import { buscarHemocentros, cidadesComHemocentro } from './ferramentas.js';
import { estadoIngestao, ingerir, ingerirComRetentativas } from './ingestao.js';
import { CircuitBreaker, CircuitoAberto, comTimeoutERetry, TempoEsgotado } from './resiliencia.js';
import { EmbeddingsDoAssistente, PgVectorStore } from './vetores.js';

export interface Pergunta {
  pergunta: string;
  usarRag?: boolean;
  usarCache?: boolean;
}

export interface Resposta {
  pergunta: string;
  resposta: string;
  origem: 'llm' | 'cache' | 'cache-semantico' | 'fallback';
  usouRag: boolean;
  fontes: Omit<Fonte, 'conteudo'>[];
  ferramentas: UsoFerramenta[];
  modelo: string;
  duracaoMs: number;
  aviso?: string;
}

const normalizar = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim();

const vetorSql = (v: number[]) => `[${v.join(',')}]`;

function motivoDaFalha(erro: unknown): string {
  if (erro instanceof CircuitoAberto) return 'circuit breaker aberto após falhas seguidas do modelo';
  if (erro instanceof TempoEsgotado) return 'o modelo não respondeu dentro do prazo';
  return 'o modelo de linguagem está indisponível';
}

export function criarAssistente(log: FastifyBaseLogger) {
  const cfg = config.assistente;
  const circuitoLlm = new CircuitBreaker('llm', cfg.circuitoFalhas, cfg.circuitoAbertoMs, log);
  const circuitoEmbeddings = new CircuitBreaker('embeddings', cfg.circuitoFalhas, cfg.circuitoAbertoMs, log);
  const retry = { timeoutMs: cfg.timeoutMs, tentativas: cfg.tentativas, backoffMs: cfg.backoffMs, log };

  const embeddings = new EmbeddingsDoAssistente(new OllamaEmbeddings({ baseUrl: cfg.ollamaUrl, model: cfg.modeloEmbeddings }), (rotulo, fn) =>
    circuitoEmbeddings.executar(() => comTimeoutERetry(() => fn(), { ...retry, rotulo })),
    cfg.modeloEmbeddings,
  );
  // Embeddings só da ingestão (em segundo plano): prazo maior e sem circuit breaker, para que
  // o aquecimento do modelo não abra o circuito usado pelas perguntas dos usuários.
  const embeddingsIngestao = new EmbeddingsDoAssistente(
    new OllamaEmbeddings({ baseUrl: cfg.ollamaUrl, model: cfg.modeloEmbeddings }),
    (rotulo, fn) => comTimeoutERetry(() => fn(), { ...retry, timeoutMs: cfg.ingestaoTimeoutMs, tentativas: 3, rotulo }),
    cfg.modeloEmbeddings,
  );
  const store = new PgVectorStore(embeddings);
  // temperatura 0 e respostas curtas: menos variação e menos repetição num modelo pequeno
  const llm = new ChatOllama({
    baseUrl: cfg.ollamaUrl,
    model: cfg.modelo,
    temperature: 0,
    numCtx: 4096,
    numPredict: 220,
    repeatPenalty: 1.15,
    keepAlive: '24h',
  });
  const cadeia = criarCadeia({ llm, store, k: cfg.k });

  async function lerCache(chave: string) {
    const { rows } = await pool.query<{ resposta: Resposta }>(
      `UPDATE assistente_cache SET acertos = acertos + 1 WHERE chave = $1 AND expira_em > now() RETURNING resposta`,
      [chave],
    );
    return rows[0]?.resposta ?? null;
  }

  async function lerCacheSemantico(vetor: number[]) {
    const { rows } = await pool.query<{ resposta: Resposta; similaridade: number; chave: string }>(
      `SELECT chave, resposta, 1 - (embedding <=> $1::vector) AS similaridade FROM assistente_cache
        WHERE embedding IS NOT NULL AND expira_em > now() AND chave LIKE 'rag:%'
        ORDER BY embedding <=> $1::vector LIMIT 1`,
      [vetorSql(vetor)],
    );
    const achado = rows[0];
    if (!achado || achado.similaridade < cfg.cacheSimilaridade) return null;
    await pool.query('UPDATE assistente_cache SET acertos = acertos + 1 WHERE chave = $1', [achado.chave]);
    return { ...achado.resposta, similaridade: Number(achado.similaridade) };
  }

  async function gravarCache(chave: string, r: Resposta, vetor: number[] | null) {
    await pool.query(
      `INSERT INTO assistente_cache (chave, pergunta, embedding, resposta, expira_em)
       VALUES ($1, $2, $3::vector, $4, now() + make_interval(secs => $5))
       ON CONFLICT (chave) DO UPDATE SET resposta = EXCLUDED.resposta, embedding = EXCLUDED.embedding, expira_em = EXCLUDED.expira_em`,
      [chave, r.pergunta, vetor ? vetorSql(vetor) : null, JSON.stringify(r), cfg.cacheTtlS],
    );
  }

  // Fallback: sem LLM. Busca textual na base + dados do banco quando a pergunta cita uma cidade.
  async function fallback(pergunta: string, usarRag: boolean, motivo: string, inicio: number): Promise<Resposta> {
    const trechos = await store.buscaTextual(pergunta, 3).catch(() => []);
    const cidades = await cidadesComHemocentro().catch(() => []);
    const cidade = cidades.find((c) => normalizar(pergunta).includes(normalizar(c)));
    const dados = cidade ? String(await buscarHemocentros.invoke({ cidade })) : '';
    const partes = [`O assistente inteligente está indisponível no momento (${motivo}).`];
    if (trechos.length) {
      partes.push(
        'Trechos da base de conhecimento relacionados à sua pergunta:',
        ...trechos.map(([d]) => `• ${d.pageContent.replace(/\s+/g, ' ').slice(0, 300)}${d.pageContent.length > 300 ? '…' : ''}`),
      );
    } else {
      partes.push('Não encontrei trechos relacionados; consulte o FAQ do app ou o hemocentro.');
    }
    if (dados) partes.push(`Hemocentros cadastrados em ${cidade}:`, dados);
    return {
      pergunta,
      resposta: partes.join('\n'),
      origem: 'fallback',
      usouRag: usarRag,
      fontes: trechos.map(([d, rank]) => ({ titulo: String(d.metadata.titulo ?? ''), fonte: String(d.metadata.fonte ?? ''), similaridade: Math.round(rank * 1000) / 1000 })),
      ferramentas: dados ? [{ nome: 'buscar_hemocentros', argumentos: { cidade }, resultado: dados }] : [],
      modelo: 'nenhum (fallback)',
      duracaoMs: Date.now() - inicio,
      aviso: motivo,
    };
  }

  async function perguntar(entrada: Pergunta): Promise<Resposta> {
    const inicio = Date.now();
    let timer: NodeJS.Timeout | undefined;
    const orcamento = new Promise<never>((_, rejeitar) => {
      timer = setTimeout(() => rejeitar(new TempoEsgotado(`orçamento de ${cfg.orcamentoMs}ms da pergunta esgotado`)), cfg.orcamentoMs);
    });
    try {
      return await Promise.race([responder(entrada, inicio), orcamento]);
    } catch (erro) {
      log.warn({ err: (erro as Error).message }, 'assistente: orçamento de tempo esgotado; usando fallback');
      return fallback(entrada.pergunta, entrada.usarRag ?? true, motivoDaFalha(erro), inicio);
    } finally {
      clearTimeout(timer);
    }
  }

  async function responder({ pergunta, usarRag = true, usarCache = true }: Pergunta, inicio: number): Promise<Resposta> {
    const chave = `${usarRag ? 'rag' : 'llm'}:${cfg.modelo}:${normalizar(pergunta)}`;

    if (usarCache) {
      const emCache = await lerCache(chave);
      if (emCache) return { ...emCache, origem: 'cache', duracaoMs: Date.now() - inicio };
    }

    try {
      let vetor: number[] | null = null;
      if (usarRag) {
        if (estadoIngestao.status !== 'pronta') {
          return fallback(pergunta, usarRag, 'a base de conhecimento ainda está sendo preparada', inicio);
        }
        // vetoriza a pergunta uma vez: serve ao cache semântico e é reaproveitada pela recuperação
        vetor = await embeddings.embedQuery(pergunta);
        if (usarCache) {
          const parecida = await lerCacheSemantico(vetor);
          if (parecida) return { ...parecida, pergunta, origem: 'cache-semantico', duracaoMs: Date.now() - inicio };
        }
      }

      const saida = await circuitoLlm.executar(() =>
        comTimeoutERetry(
          (signal) => cadeia.invoke({ pergunta, usarRag, hoje: new Date().toISOString().slice(0, 10) }, { signal }),
          { ...retry, rotulo: 'llm' },
        ),
      );
      const resposta: Resposta = {
        pergunta,
        resposta: saida.resposta.trim(),
        origem: 'llm',
        usouRag: usarRag,
        fontes: saida.fontes.map(({ conteudo: _c, ...f }) => f),
        ferramentas: saida.ferramentas,
        modelo: cfg.modelo,
        duracaoMs: Date.now() - inicio,
      };
      // respostas que dependem de ferramentas (dados que mudam) não vão para o cache
      if (usarCache && resposta.ferramentas.length === 0) await gravarCache(chave, resposta, vetor).catch(() => {});
      return resposta;
    } catch (erro) {
      log.warn({ err: (erro as Error).message }, 'assistente: usando fallback');
      return fallback(pergunta, usarRag, motivoDaFalha(erro), inicio);
    }
  }

  async function status() {
    const cache = await pool.query<{ entradas: number; acertos: number }>(
      'SELECT count(*)::int AS entradas, COALESCE(sum(acertos), 0)::int AS acertos FROM assistente_cache WHERE expira_em > now()',
    );
    return {
      modelo: cfg.modelo,
      modeloEmbeddings: cfg.modeloEmbeddings,
      ingestao: estadoIngestao,
      circuitos: { llm: circuitoLlm.status(), embeddings: circuitoEmbeddings.status() },
      cache: cache.rows[0],
      politica: { timeoutMs: cfg.timeoutMs, tentativas: cfg.tentativas, backoffMs: cfg.backoffMs, circuitoFalhas: cfg.circuitoFalhas, circuitoAbertoMs: cfg.circuitoAbertoMs },
    };
  }

  return {
    perguntar,
    status,
    // ingestão e, em seguida, aquecimento: carrega o modelo de chat na memória do Ollama para que
    // a primeira pergunta de um usuário não pague esse custo (keep_alive mantém carregado)
    iniciar: async () => {
      await ingerirComRetentativas(embeddingsIngestao, log);
      for (let tentativa = 1; tentativa <= 5; tentativa++) {
        try {
          await comTimeoutERetry((signal) => llm.invoke('Responda apenas: ok', { signal }), { ...retry, timeoutMs: cfg.ingestaoTimeoutMs, tentativas: 1, rotulo: 'aquecimento' });
          log.info({ modelo: cfg.modelo }, 'assistente: modelo aquecido');
          return;
        } catch (erro) {
          log.warn({ err: (erro as Error).message }, 'assistente: aquecimento falhou; nova tentativa');
          await new Promise((r) => setTimeout(r, 10_000));
        }
      }
    },
    reingerir: () => ingerir(embeddingsIngestao, log, true),
    limparCache: () => pool.query('DELETE FROM assistente_cache').then((r) => r.rowCount ?? 0),
  };
}
