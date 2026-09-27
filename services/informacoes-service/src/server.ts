import { criarApp, iniciar } from './app.js';
import { rotas } from './rotas.js';

const app = criarApp();
await app.register(rotas);
await iniciar(app);
