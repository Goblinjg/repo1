import { criarApp, iniciar } from './app.js';
import { brokerConectado, conectarBroker } from './broker.js';
import { config } from './config.js';
import { estado } from './db.js';
import { criarRelay } from './outbox/relay.js';
import { rotas } from './rotas.js';
import { criarOrquestrador } from './saga/orquestrador.js';

// Com a outbox, o broker deixou de ser obrigatório para a prontidão: sem ele, mobilizações
// e comandos da saga continuam sendo gravados e o relay publica quando o broker voltar.
const app = criarApp({ informativos: () => ({ broker: brokerConectado() ? 'ok' : 'desconectado' }) });
const orquestrador = criarOrquestrador(app.log);
const relay = criarRelay(app.log);
await app.register(rotas, { orquestrador });
await iniciar(app, async () => {
  orquestrador.parar();
  await relay.parar();
});

// Relay, monitor de prazos e consumo de respostas só começam depois das migrations.
const aguardarMigrations = async () => {
  while (!estado.migrado) await new Promise((r) => setTimeout(r, 500));
};
await aguardarMigrations();
relay.iniciar(config.outbox.intervaloMs);
orquestrador.iniciarMonitorDePrazos();
void conectarBroker(app.log, [{ fila: 'saga.mobilizacoes.respostas', handler: orquestrador.aoResponder, prefetch: 1 }]);
