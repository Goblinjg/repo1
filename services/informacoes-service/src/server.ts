import { criarApp, iniciar } from './app.js';
import { rotasAssistente } from './assistente/rotas.js';
import { criarAssistente } from './assistente/servico.js';
import { brokerConectado, conectarBroker } from './broker.js';
import { config } from './config.js';
import { estado } from './db.js';
import { criarRelay } from './outbox/relay.js';
import { rotas } from './rotas.js';
import { participanteSaga } from './saga.js';

// O LLM NÃO entra na prontidão: com o Ollama fora, o serviço segue respondendo (assistente em fallback).
const app = criarApp({ informativos: () => ({ broker: brokerConectado() ? 'ok' : 'desconectado' }) });
const relay = criarRelay(app.log);
const assistente = criarAssistente(app.log);
await app.register(rotas);
await app.register(rotasAssistente, { assistente });
await iniciar(app, () => relay.parar());

while (!estado.migrado) await new Promise((r) => setTimeout(r, 500));
relay.iniciar(config.outbox.intervaloMs);
void conectarBroker(app.log, [{ fila: 'saga.informacoes.comandos', handler: participanteSaga(app.log), prefetch: 1 }]);
void assistente.iniciar();
