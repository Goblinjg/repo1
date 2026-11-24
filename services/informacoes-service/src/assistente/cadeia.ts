// Composição do fluxo com chains do LangChain (LCEL):
//
//   entrada ─┬─ ferramentas: prompt de decisão → LLM com tools → executa as tools escolhidas
//            └─ fontes:      retriever (pgvector) com os k trechos mais similares       (em paralelo)
//          → formata contexto e dados → prompt de resposta → LLM → texto
//
// Não é um agente: o fluxo é fixo (no máximo UMA rodada de ferramentas antes da resposta).
// O modelo só decide SE e QUAL ferramenta usar; não há laço de raciocínio/ação.
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { AIMessage } from '@langchain/core/messages';
import { StringOutputParser } from '@langchain/core/output_parsers';
import { ChatPromptTemplate } from '@langchain/core/prompts';
import { RunnableLambda, RunnablePassthrough, RunnableSequence } from '@langchain/core/runnables';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { FERRAMENTAS } from './ferramentas.js';
import type { PgVectorStore } from './vetores.js';

export interface EntradaCadeia {
  pergunta: string;
  usarRag: boolean;
  hoje: string;
}

export interface Fonte {
  titulo: string;
  fonte: string;
  similaridade: number;
  conteudo: string;
}

export interface UsoFerramenta {
  nome: string;
  argumentos: Record<string, unknown>;
  resultado: string;
}

export interface SaidaCadeia extends EntradaCadeia {
  ferramentas: UsoFerramenta[];
  fontes: Fonte[];
  contexto: string;
  dados: string;
  resposta: string;
}

const PROMPT_DECISAO = ChatPromptTemplate.fromMessages([
  [
    'system',
    'Você decide se é preciso consultar o banco de dados do 4Life antes de responder. Hoje é {hoje}. ' +
      'Chame uma ferramenta SOMENTE se a pergunta pedir endereço, horário ou disponibilidade de hemocentros de uma cidade. ' +
      'Para qualquer outra pergunta, não chame ferramentas e responda apenas "OK".',
  ],
  ['human', '{pergunta}'],
]);

const PROMPT_RAG = ChatPromptTemplate.fromMessages([
  [
    'system',
    'Você é o assistente do 4Life, uma plataforma que organiza doações de sangue em grupo. ' +
      'Responda em português do Brasil, direto ao ponto, em no máximo 3 frases, usando APENAS as informações do CONTEXTO e dos DADOS DO SISTEMA abaixo. ' +
      'Copie números, prazos e tipos sanguíneos exatamente como aparecem no trecho que trata do assunto perguntado. ' +
      'Se o trecho diz "não", "somente" ou "no máximo", preserve isso na resposta. ' +
      'Se a resposta não estiver neles, diga que não encontrou essa informação e oriente a confirmar com o hemocentro. ' +
      'Não invente números, prazos nem endereços.\n\n' +
      'CONTEXTO (base de conhecimento do 4Life):\n{contexto}\n\n' +
      'DADOS DO SISTEMA (consultados agora):\n{dados}',
  ],
  ['human', '{pergunta}'],
]);

// Linha de base para a avaliação: mesmo modelo, sem recuperação.
const PROMPT_SEM_RAG = ChatPromptTemplate.fromMessages([
  [
    'system',
    'Você é o assistente do 4Life, uma plataforma que organiza doações de sangue em grupo. ' +
      'Responda em português do Brasil, direto ao ponto, em no máximo 3 frases.\n\n' +
      'DADOS DO SISTEMA (consultados agora):\n{dados}',
  ],
  ['human', '{pergunta}'],
]);

const formatarFontes = (fontes: Fonte[]) =>
  fontes.length ? fontes.map((f, i) => `[${i + 1}] ${f.conteudo}`).join('\n\n') : '(nenhum trecho encontrado)';

const formatarFerramentas = (usos: UsoFerramenta[]) =>
  usos.length ? usos.map((u) => `${u.nome}(${JSON.stringify(u.argumentos)}):\n${u.resultado}`).join('\n\n') : '(nenhuma consulta necessária)';

export function criarCadeia({ llm, store, k }: { llm: BaseChatModel; store: PgVectorStore; k: number }) {
  const porNome = new Map<string, StructuredToolInterface>(FERRAMENTAS.map((f) => [f.name, f as StructuredToolInterface]));
  const decidir = PROMPT_DECISAO.pipe(llm.bindTools!(FERRAMENTAS));
  const responder = new StringOutputParser();

  // As etapas recebem o estado acumulado da sequência (RunnablePassthrough.assign).
  type Estado = Record<string, unknown>;

  const usarFerramentas = RunnableLambda.from(async (estado: Estado, cfg): Promise<UsoFerramenta[]> => {
    const e = estado as unknown as EntradaCadeia;
    const mensagem = (await decidir.invoke(e, cfg)) as AIMessage;
    const usos: UsoFerramenta[] = [];
    for (const chamada of mensagem.tool_calls ?? []) {
      const ferramenta = porNome.get(chamada.name);
      if (!ferramenta) continue;
      const resultado = await ferramenta.invoke(chamada.args, cfg);
      usos.push({ nome: chamada.name, argumentos: chamada.args, resultado: String(resultado) });
    }
    return usos;
  }).withConfig({ runName: 'ferramentas' });

  const recuperar = RunnableLambda.from(async (estado: Estado): Promise<Fonte[]> => {
    const e = estado as unknown as EntradaCadeia;
    if (!e.usarRag) return [];
    const achados = await store.similaritySearchWithScore(e.pergunta, k);
    return achados.map(([doc, similaridade]) => ({
      titulo: String(doc.metadata.titulo ?? ''),
      fonte: String(doc.metadata.fonte ?? ''),
      similaridade: Math.round(similaridade * 1000) / 1000,
      conteudo: doc.pageContent,
    }));
  }).withConfig({ runName: 'recuperacao' });

  const gerar = RunnableLambda.from((e: Estado) =>
    (e.usarRag ? PROMPT_RAG : PROMPT_SEM_RAG).pipe(llm).pipe(responder),
  ).withConfig({ runName: 'geracao' });

  return RunnableSequence.from<Estado, SaidaCadeia>([
    RunnablePassthrough.assign({ ferramentas: usarFerramentas, fontes: recuperar }),
    RunnablePassthrough.assign({
      contexto: (e: Estado) => formatarFontes(e.fontes as Fonte[]),
      dados: (e: Estado) => formatarFerramentas(e.ferramentas as UsoFerramenta[]),
    }),
    RunnablePassthrough.assign({ resposta: gerar }),
  ]);
}
