import { criarApp, iniciar } from './app.js';
import { brokerConectado, consumir } from './broker.js';
import { aoCriarMobilizacao } from './eventos.js';
import { rotas } from './rotas.js';

const app = criarApp(() => ({ broker: brokerConectado() ? 'ok' : 'desconectado' }));
await app.register(rotas);
await iniciar(app);
void consumir(app.log, [
  { fila: 'comunidades.mobilizacao-criada', chave: 'mobilizacao.criada', handler: aoCriarMobilizacao(app.log) },
]);
