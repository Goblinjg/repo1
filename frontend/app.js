const app = document.querySelector('#app');
const TOKEN_KEY = '4life.token';
const esc = (value = '') => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const token = () => localStorage.getItem(TOKEN_KEY);
const bloodTypes = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
const categories = { requisitos: 'Requisitos', preparo: 'Preparo', documentos: 'Documentos', mitos: 'Mitos', dica: 'Dicas' };
let profile = null;
let toastState = null;
let assistantHistory = [];
let assistantBusy = false;
let mobilizationDraft = null;
let pollTimer = null;

function go(path) {
  location.hash = `#${path}`;
}

function routeParts() {
  const raw = location.hash.replace(/^#/, '') || '/login';
  const [path, query = ''] = raw.split('?');
  return { path: path.startsWith('/') ? path : `/${path}`, params: new URLSearchParams(query) };
}

function messageFrom(body, fallback) {
  if (typeof body === 'string') return body;
  return body?.erro || body?.message || body?.detail || fallback;
}

async function api(path, { method = 'GET', body, timeout = 20000 } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token()) headers.Authorization = `Bearer ${token()}`;
  let response;
  try {
    response = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
  } catch (error) {
    if (error.name === 'TimeoutError') throw new Error('A solicitação demorou demais. Tente novamente.');
    throw new Error('Não foi possível conectar ao 4Life. Verifique se o backend está em execução.');
  }
  const text = await response.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }
  if (!response.ok) {
    if (response.status === 401 && token()) {
      localStorage.removeItem(TOKEN_KEY);
      profile = null;
      go('/login');
    }
    throw new Error(messageFrom(data, `Não foi possível concluir a solicitação (${response.status}).`));
  }
  return data;
}

function showToast(message, error = false) {
  toastState = { message, error };
  renderToast();
  window.setTimeout(() => {
    toastState = null;
    renderToast();
  }, 3800);
}

function renderToast() {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  if (!toastState) return;
  const toast = document.createElement('div');
  toast.className = `toast${toastState.error ? ' error' : ''}`;
  toast.setAttribute('role', toastState.error ? 'alert' : 'status');
  toast.textContent = toastState.message;
  document.body.append(toast);
}

const logo = '<img src="/assets/logo-horizontal.svg" alt="4Life" />';
function header(active = '') {
  const nav = [
    ['/dashboard', 'Meu painel'],
    ['/mobilizacoes', 'Mobilizações'],
    ['/comunidades', 'Comunidades'],
    ['/informacoes', 'Informações'],
    ['/hemocentros', 'Hemocentros'],
    ['/assistente', 'Assistente 4Life'],
  ];
  return `<header class="topbar"><div class="topbar-inner">
    <a class="brand" href="#/dashboard" aria-label="4Life, início">${logo}</a>
    <button class="mobile-nav-toggle" type="button" data-action="toggle-menu" aria-label="Abrir menu" aria-expanded="false">☰</button>
    <nav class="main-nav" aria-label="Navegação principal">${nav.map(([href, label]) => `<a class="nav-link${active === href ? ' active' : ''}" href="#${href}">${label}</a>`).join('')}</nav>
    <div class="account-actions">${profile?.nome ? `<span class="user-greeting">Olá, ${esc(profile.nome.split(' ')[0])}</span>` : ''}<button class="btn" data-action="logout" type="button">Sair</button></div>
  </div></header>`;
}

function layout(content, active = '') {
  return `${header(active)}<main class="container">${content}<footer class="footer">O 4Life facilita mobilizações e acesso à informação. A avaliação para doar e o atendimento são feitos pelo hemocentro.</footer></main>`;
}

function pageHeader(eyebrow, title, subtitle, extra = '') {
  return `<div class="page-heading"><p class="eyebrow">${esc(eyebrow)}</p><h1>${esc(title)}</h1><p class="subtitle">${esc(subtitle)}</p>${extra}</div>`;
}

function callout(text, kind = 'info', heading = '') {
  return `<div class="callout ${kind}" role="note">${heading ? `<strong>${esc(heading)}</strong>` : ''}<p>${esc(text)}</p></div>`;
}

function emptyState(title, copy, action = '') {
  return `<div class="empty-state"><h3>${esc(title)}</h3><p class="muted">${esc(copy)}</p>${action}</div>`;
}

function loading(text = 'Carregando informações…') {
  return `<div class="loading"><div><div class="spinner" aria-hidden="true"></div><p>${esc(text)}</p></div></div>`;
}

function formatDate(iso, includeTime = true) {
  if (!iso) return 'Data não informada';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'Data não informada';
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo', day: '2-digit', month: 'short', year: 'numeric',
    ...(includeTime ? { hour: '2-digit', minute: '2-digit' } : {}),
  }).format(date).replace(' às ', ' · ');
}

function statusBadge(state) {
  const normalized = String(state || '').toUpperCase();
  const label = normalized === 'CONFIRMADA' ? 'Confirmada' : normalized === 'CANCELADA' ? 'Cancelada' : 'Aguardando confirmação';
  const cls = normalized === 'CONFIRMADA' ? 'confirmed' : normalized === 'CANCELADA' ? 'cancelled' : 'pending';
  return `<span class="badge ${cls}">${label}</span>`;
}

function mobilizationCard(m, options = {}) {
  const place = [m.cidade, m.uf].filter(Boolean).join(' · ');
  const remaining = m.vagas == null ? 'vagas não informadas' : `${Math.max(0, m.vagas - (m.totalInteressados || 0))} vagas restantes`;
  const interest = options.interest ? `<button class="btn ${m.tenhoInteresse ? 'btn-soft' : 'btn-primary'}" data-action="${m.tenhoInteresse ? 'cancel-interest' : 'interest'}" data-id="${esc(m.id)}">${m.tenhoInteresse ? 'Retirar interesse' : 'Tenho interesse'}</button>` : '';
  return `<article class="card mobilization-card">
    <span class="date-line">${esc(formatDate(m.dataHora))}</span>
    <h3><a class="text-link" href="#/mobilizacoes/${encodeURIComponent(m.id)}">${esc(m.titulo)}</a></h3>
    <p class="location">${esc(place || 'Local não informado')}</p>
    <p class="muted small">${esc(m.local || 'Local a confirmar')} · ${esc(remaining)}</p>
    ${m.estado && m.estado !== 'CONFIRMADA' ? `<div>${statusBadge(m.estado)}</div>` : ''}
    <div class="card-actions"><a class="btn" href="#/mobilizacoes/${encodeURIComponent(m.id)}">Ver detalhes</a>${interest}</div>
  </article>`;
}

async function loadProfile() {
  if (profile) return profile;
  const panel = await api('/api/web/painel');
  profile = panel.perfil;
  return profile;
}

function renderAuth(isSignup = false, error = '') {
  const intro = `<section class="auth-intro"><p class="eyebrow">Bem-vindo ao 4Life</p><h1>Juntos, a gente mobiliza a vida.</h1><p class="body-copy muted">Aproxime-se de comunidades, encontre mobilizações e tenha informação para dar o próximo passo.</p>
    <div class="auth-step"><b>01</b><span>Encontre pessoas da sua cidade</span></div><div class="auth-step"><b>02</b><span>Acompanhe mobilizações</span></div><div class="auth-step"><b>03</b><span>Tire dúvidas com acolhimento</span></div>
    <p class="small muted" style="margin:22px 0 0">Uma plataforma para conectar. A avaliação para doar é sempre feita pelo hemocentro.</p></section>`;
  const signupFields = isSignup ? `<div class="field full"><label for="nome">Nome completo</label><input id="nome" name="nome" autocomplete="name" required minlength="2" placeholder="Como você prefere ser chamado?" /></div>
    <div class="field"><label for="cidade">Cidade</label><input id="cidade" name="cidade" required minlength="2" autocomplete="address-level2" placeholder="Sua cidade" /></div>
    <div class="field"><label for="uf">Estado (UF)</label><input id="uf" name="uf" required minlength="2" maxlength="2" autocomplete="address-level1" placeholder="MG" /></div>
    <div class="field"><label for="tipoSanguineo">Tipo sanguíneo <span class="muted">(opcional)</span></label><select id="tipoSanguineo" name="tipoSanguineo"><option value="">Não informar agora</option>${bloodTypes.map((type) => `<option>${type}</option>`).join('')}</select></div>` : '';
  app.innerHTML = `<header class="auth-top"><a class="brand" href="#/login">${logo}</a>${isSignup ? '<a class="btn" href="#/login">Entrar</a>' : '<a class="btn" href="#/signup">Criar conta</a>'}</header>
    <main class="auth-layout">${intro}<section class="card auth-form"><h2>${isSignup ? 'Crie seu espaço no 4Life' : 'Entre e sinta-se parte'}</h2><p class="muted">${isSignup ? 'Faça parte de uma rede de cuidado da sua cidade.' : 'Acesse suas comunidades e mobilizações de interesse.'}</p>
    ${error ? callout(error, 'error', 'Não foi possível continuar') : ''}
    <form id="${isSignup ? 'signup-form' : 'login-form'}"><div class="form-grid">${signupFields}<div class="field full"><label for="email">E-mail</label><input id="email" name="email" type="email" autocomplete="email" required placeholder="seuemail@exemplo.com.br" /></div>
    <div class="field full"><label for="senha">Senha</label><input id="senha" name="senha" type="password" autocomplete="${isSignup ? 'new-password' : 'current-password'}" required minlength="${isSignup ? '8' : '1'}" placeholder="${isSignup ? 'Mínimo de 8 caracteres' : 'Sua senha'}" /></div>
    ${isSignup ? '' : '<div class="field full"><button class="btn" type="button" data-action="forgot-password">Esqueci minha senha</button></div>'}</div>
    <div class="form-actions"><button class="btn btn-primary btn-block" type="submit">${isSignup ? 'Criar conta' : 'Entrar'}</button></div></form>
    <p class="auth-note">${isSignup ? 'O tipo sanguíneo é opcional. O cadastro não representa uma avaliação médica.' : 'Sua conta dá acesso seguro às comunidades e mobilizações.'}</p>
    <p class="small muted">${isSignup ? 'Já participa?' : 'Ainda não faz parte dessa rede?'} <a class="text-link" href="#/${isSignup ? 'login' : 'signup'}">${isSignup ? 'Entrar' : 'Quero criar uma conta'}</a></p></section></main>`;
}

async function renderDashboard() {
  const panel = await api('/api/web/painel');
  profile = panel.perfil;
  const communities = panel.comunidades || [];
  const interests = panel.mobilizacoesComInteresse || [];
  const next = interests.length ? interests : communities.flatMap((c) => c.proximasMobilizacoes || []).slice(0, 4);
  const name = esc(profile?.nome || 'doador');
  const blood = profile?.tipoSanguineo ? `Tipo sanguíneo: ${esc(profile.tipoSanguineo)}` : 'Tipo sanguíneo: não informado · dado opcional';
  const communityCards = communities.slice(0, 3).map((c) => `<article class="card"><p class="eyebrow">Comunidade local</p><h3>${esc(c.nome)}</h3><p class="muted small">${esc(c.cidade)}, ${esc(c.uf)}</p>${c.meuPapel === 'admin' ? '<span class="badge admin">Administrador</span>' : ''}<p class="card-actions"><a class="btn" href="#/comunidades/${encodeURIComponent(c.id)}">Conhecer comunidade</a></p></article>`).join('');
  const mobilizationCards = next.slice(0, 4).map((m) => mobilizationCard(m)).join('');
  const quickLinks = [
    ['/mobilizacoes', 'Encontrar mobilizações', 'Veja oportunidades de participação'],
    ['/comunidades', 'Explorar comunidades', 'Faça parte de uma rede de cuidado'],
    ['/informacoes', 'Informações para doar', 'Prepare-se com informação'],
    ['/assistente', 'Conversar com o assistente', 'Tire suas dúvidas gerais'],
  ];
  const warnings = (panel.avisos || []).length ? callout(`Algumas informações estão temporariamente indisponíveis: ${panel.avisos.join(', ')}.`, 'warning', 'Aviso') : '';
  app.innerHTML = layout(`${pageHeader('Seu espaço no 4Life', `Olá, ${profile?.nome?.split(' ')[0] || 'doador'}. Que bom ter você aqui.`, 'Pequenas conexões podem mobilizar grandes gestos.')}
    <section class="card profile-summary soft-green"><div><h2>${name}</h2><p>${esc(profile?.cidade || '')}${profile?.uf ? `, ${esc(profile.uf)}` : ''} · Perfil de doador</p><p class="muted small">${blood}</p></div><div class="stat"><strong>${communities.length}</strong><span>comunidades</span></div><div class="stat"><strong>${interests.length}</strong><span>interesses</span></div></section>
    <section class="section"><h2>Por onde você quer começar?</h2><div class="card-grid grid-4">${quickLinks.map(([href, title, text]) => `<a class="card quick-card" href="#${href}"><strong>${title} →</strong><span>${text}</span></a>`).join('')}</div></section>
    ${warnings}<section class="section dashboard-columns"><div><div class="section-heading"><h2>${interests.length ? 'Suas próximas mobilizações' : 'Mobilizações da sua rede'}</h2><a class="text-link" href="#/mobilizacoes">Explorar todas</a></div>${mobilizationCards || emptyState('Ainda não há mobilizações', 'Encontre uma oportunidade ou acompanhe as atividades da sua comunidade.', '<a class="btn" href="#/mobilizacoes">Encontrar mobilizações</a>')}</div>
    <aside><div class="section-heading"><h2>Sua rede de cuidado</h2><a class="text-link" href="#/comunidades">Explorar</a></div>${communityCards || emptyState('Encontre sua primeira comunidade', 'Conecte-se a pessoas da sua cidade.', '<a class="btn" href="#/comunidades">Explorar comunidades</a>')}</aside></section>`, '/dashboard');
}

async function renderMobilizations(params) {
  const filters = { cidade: params.get('cidade') || '', uf: params.get('uf') || '', q: params.get('q') || '', data: params.get('data') || '' };
  const listQuery = new URLSearchParams();
  if (filters.cidade) listQuery.set('cidade', filters.cidade);
  if (params.get('comunidadeId')) listQuery.set('comunidadeId', params.get('comunidadeId'));
  const [items, communities] = await Promise.all([
    api(`/api/web/mobilizacoes${listQuery.size ? `?${listQuery}` : ''}`),
    api('/api/web/comunidades').catch(() => []),
  ]);
  const filtered = items.filter((m) => {
    const text = `${m.titulo} ${m.local || ''} ${m.cidade || ''} ${(communities.find((c) => c.id === m.comunidadeId) || {}).nome || ''}`.toLocaleLowerCase('pt-BR');
    return (!filters.q || text.includes(filters.q.toLocaleLowerCase('pt-BR')))
      && (!filters.uf || String(m.uf || '').toLocaleLowerCase('pt-BR') === filters.uf.toLocaleLowerCase('pt-BR'))
      && (!filters.data || String(m.dataHora || '').startsWith(filters.data));
  });
  const communityOptions = communities.map((c) => `<option value="${esc(c.id)}">${esc(c.nome)}</option>`).join('');
  const cards = filtered.map((m) => mobilizationCard(m, { interest: String(m.estado || 'CONFIRMADA').toUpperCase() === 'CONFIRMADA' })).join('');
  app.innerHTML = layout(`${pageHeader('Mobilizações', 'Encontre seu próximo gesto de cuidado', 'Explore encontros organizados por comunidades perto de você.')}
    ${callout('Esta lista vem das mobilizações confirmadas no sistema. Registre ou retire seu interesse para acompanhar a participação.', 'info', 'Mobilizações reais')}
    <form id="mobilization-search" class="card search-panel"><div class="field"><label for="q">Buscar mobilizações</label><input id="q" name="q" class="search-control" value="${esc(filters.q)}" placeholder="Busque por título, local ou comunidade" /></div>
    <div class="search-row"><div class="field"><label for="cidade">Cidade</label><input id="cidade" name="cidade" value="${esc(filters.cidade)}" placeholder="Ex.: Belo Horizonte" /></div><div class="field"><label for="uf">Estado</label><input id="uf" name="uf" value="${esc(filters.uf)}" maxlength="2" placeholder="MG" /></div>
    <div class="field"><label for="data">Mês</label><input id="data" name="data" type="month" value="${esc(filters.data)}" /></div><div class="field"><label for="comunidade">Comunidade</label><select id="comunidade" name="comunidade"><option value="">Todas as comunidades</option>${communityOptions}</select></div></div>
    <div class="form-actions"><button class="btn btn-primary" type="submit">Aplicar filtros</button><button class="btn" type="button" data-action="clear-mobilization-filters">Limpar filtros</button></div></form>
    <section class="section"><div class="section-heading"><h2>${filtered.length} mobilizaç${filtered.length === 1 ? 'ão' : 'ões'}</h2></div>${cards ? `<div class="card-grid grid-3">${cards}</div>` : emptyState('Nenhuma mobilização encontrada', 'Tente mudar os filtros ou volte mais tarde para ver novas oportunidades.')}</section>`, '/mobilizacoes');
  const select = document.querySelector('#comunidade');
  if (select && params.get('comunidadeId')) select.value = params.get('comunidadeId');
}

async function renderMobilizationDetail(id) {
  const mob = await api(`/api/web/mobilizacoes/${encodeURIComponent(id)}`);
  const community = mob.comunidade || {};
  const hospital = mob.hemocentro || null;
  const confirmed = String(mob.estado || 'CONFIRMADA').toUpperCase() === 'CONFIRMADA';
  const interestButton = confirmed ? `<button class="btn ${mob.tenhoInteresse ? 'btn-soft' : 'btn-primary'} btn-block" data-action="${mob.tenhoInteresse ? 'cancel-interest' : 'interest'}" data-id="${esc(mob.id)}">${mob.tenhoInteresse ? 'Retirar meu interesse' : 'Tenho interesse'}</button>` : '';
  const locationInfo = hospital ? `<a class="text-link" href="#/hemocentros/${encodeURIComponent(hospital.id)}">${esc(hospital.nome)}</a><p class="muted small">${esc(hospital.endereco)}, ${esc(hospital.cidade)} · ${esc(hospital.uf)}</p>` : `<p>${esc(mob.local || 'Local a confirmar')}</p>`;
  const stateNote = !confirmed ? callout(mob.estado === 'CANCELADA' ? `Mobilização cancelada${mob.motivoCancelamento ? `: ${mob.motivoCancelamento}` : '.'}` : 'A mobilização está aguardando confirmação. Ela não deve ser divulgada como confirmada.', mob.estado === 'CANCELADA' ? 'error' : 'warning', 'Status') : '';
  app.innerHTML = layout(`${pageHeader('Mobilizações / detalhe', mob.titulo, 'Confira os detalhes e fale com a comunidade organizadora.', `<a class="btn" href="#/mobilizacoes">← Voltar às mobilizações</a>`)}
    ${stateNote}<div class="split-layout section"><section class="card"><p class="date-line">${esc(formatDate(mob.dataHora))}</p><h2>${esc(mob.titulo)}</h2>${mob.descricao ? `<p class="body-copy">${esc(mob.descricao)}</p>` : ''}<div class="section"><h3>Onde acontece</h3>${locationInfo}<p>${esc(mob.cidade)}, ${esc(mob.uf)}</p></div>
    <div class="section"><h3>Comunidade responsável</h3><p><a class="text-link" href="#/comunidades/${encodeURIComponent(community.id || mob.comunidadeId)}">${esc(community.nome || 'Ver comunidade')}</a></p></div>
    <div class="section"><h3>Participação</h3><p class="muted">${mob.vagas == null ? 'O número de vagas não foi informado.' : `${mob.totalInteressados || 0} de ${mob.vagas} pessoas interessadas.`}</p>${mob.tenhoInteresse ? callout('Seu interesse está registrado. Isso não representa avaliação de aptidão nem agendamento.', 'success', 'Você faz parte') : ''}${interestButton}</div>
    ${mob.avisos?.length ? callout(`Alguns detalhes estão indisponíveis: ${mob.avisos.join(', ')}.`, 'warning', 'Aviso') : ''}</section>
    <aside class="card soft-teal sticky-card"><h3>Uma informação importante</h3><p>O 4Life facilita a mobilização e a comunicação. A triagem e a avaliação para doar são feitas pelo hemocentro.</p>${hospital ? `<a class="btn btn-block" href="#/hemocentros/${encodeURIComponent(hospital.id)}">Ver hemocentro</a>` : '<a class="btn btn-block" href="#/hemocentros">Encontrar hemocentros</a>'}</aside></div>`, '/mobilizacoes');
}

async function renderCommunities(params) {
  const city = params.get('cidade') || '';
  const uf = params.get('uf') || '';
  const q = params.get('q') || '';
  const query = new URLSearchParams();
  if (city) query.set('cidade', city);
  if (uf) query.set('uf', uf);
  const communities = await api(`/api/web/comunidades${query.size ? `?${query}` : ''}`);
  const list = communities.filter((c) => !q || `${c.nome} ${c.descricao || ''} ${c.cidade} ${c.uf}`.toLocaleLowerCase('pt-BR').includes(q.toLocaleLowerCase('pt-BR')));
  const cards = list.map((c) => `<article class="card"><p class="eyebrow">Comunidade local</p><h3>${esc(c.nome)}</h3><p>${esc(c.cidade)}, ${esc(c.uf)}</p><p class="muted">${esc(c.descricao || 'Uma rede para incentivar a doação e compartilhar informações.')}</p><p class="small muted">${Number(c.totalMembros || 0)} membros · ${Number(c.totalMobilizacoes || 0)} mobilizações</p><a class="btn btn-block" href="#/comunidades/${encodeURIComponent(c.id)}">Conhecer comunidade</a></article>`).join('');
  app.innerHTML = layout(`${pageHeader('Comunidades', 'A doação conecta. A comunidade aproxima.', 'Encontre pessoas que compartilham a vontade de ajudar.')}
    <section class="card soft-green community-hero"><h2>Tem espaço para o seu jeito de ajudar.</h2><p class="body-copy">Participe de uma comunidade ou comece uma nova conexão na sua cidade.</p><a class="btn" href="#/comunidades/nova">Criar uma comunidade</a></section>
    <form id="community-search" class="card search-panel"><div class="field"><label for="q">Buscar pelo nome</label><input id="q" name="q" value="${esc(q)}" placeholder="Qual comunidade você procura?" /></div><div class="search-row" style="grid-template-columns:1fr 1fr"><div class="field"><label for="cidade">Cidade</label><input id="cidade" name="cidade" value="${esc(city)}" placeholder="Sua cidade" /></div><div class="field"><label for="uf">Estado</label><input id="uf" name="uf" value="${esc(uf)}" maxlength="2" placeholder="MG" /></div></div><div class="form-actions"><button class="btn btn-primary" type="submit">Buscar comunidades</button><button class="btn" type="button" data-action="clear-community-filters">Limpar filtros</button></div></form>
    <section class="section"><div class="section-heading"><h2>Comunidades para conhecer</h2><span class="muted">${list.length} encontradas</span></div>${cards ? `<div class="card-grid grid-3">${cards}</div>` : emptyState('Nenhuma comunidade encontrada', 'Tente uma cidade diferente ou crie uma comunidade para sua região.', '<a class="btn" href="#/comunidades/nova">Criar comunidade</a>')}</section>`, '/comunidades');
}

async function renderCommunityDetail(id) {
  const [community, panel] = await Promise.all([api(`/api/web/comunidades/${encodeURIComponent(id)}`), api('/api/web/painel')]);
  profile = panel.perfil;
  const members = community.membros || [];
  const membership = members.find((m) => m.doadorId === profile?.id);
  const isAdmin = membership?.papel === 'admin';
  const isMember = Boolean(membership);
  const upcoming = community.mobilizacoes || community.proximasMobilizacoes || [];
  const memberList = members.slice(0, 12).map((m) => `<div class="member-row"><strong>${esc(m.nome || (m.doadorId === profile?.id ? profile.nome : 'Pessoa da comunidade'))}</strong>${m.papel === 'admin' ? '<span class="badge admin">Administrador</span>' : '<span class="badge">Membro</span>'}</div>`).join('');
  const actions = isMember ? `<span class="badge ${isAdmin ? 'admin' : ''}">${isAdmin ? 'Administrador' : 'Membro'}</span>${isAdmin ? `<a class="btn btn-primary btn-block" href="#/comunidades/${encodeURIComponent(id)}/admin">Administrar comunidade</a>` : '<p class="small muted">Você acompanha as atividades desta comunidade.</p>'}` : `<button class="btn btn-primary btn-block" data-action="join-community" data-id="${esc(id)}">Entrar na comunidade</button><p class="small muted">Participar não obriga a doar e não representa avaliação médica.</p>`;
  app.innerHTML = layout(`${pageHeader('Comunidades / você faz parte', community.nome, 'Seu espaço para acompanhar encontros e mobilizações.', '<a class="btn" href="#/comunidades">← Explorar comunidades</a>')}
    ${isMember ? callout('Acompanhe as próximas mobilizações e convide outras pessoas para conhecer a rede.', 'success', 'Você faz parte desta comunidade') : ''}
    <div class="community-details"><section class="card soft-green community-hero"><h2>Cuidado que começa perto.</h2><p class="body-copy">${esc(community.descricao || 'Uma comunidade para incentivar a doação de sangue com informação, acolhimento e mobilizações locais.')}</p><p><strong>${esc(community.cidade)}, ${esc(community.uf)}</strong></p><p class="small muted">${Number(community.totalMembros || members.length)} membros · ${upcoming.length} mobilizações</p></section><aside class="card">${actions}</aside></div>
    <section class="section"><div class="section-heading"><h2>Próximas mobilizações</h2>${isAdmin ? `<a class="btn btn-primary" href="#/comunidades/${encodeURIComponent(id)}/nova-mobilizacao">+ Criar mobilização</a>` : ''}</div>${upcoming.length ? `<div class="card-grid grid-2">${upcoming.map((m) => mobilizationCard(m, { interest: true })).join('')}</div>` : emptyState('Ainda não há mobilizações', isAdmin ? 'Crie a primeira mobilização desta comunidade.' : 'Acompanhe esta página para conhecer os próximos encontros.')}</section>
    <section class="section card"><div class="section-heading"><h2>Membros</h2><span class="muted">${Number(community.totalMembros || members.length)}</span></div><div class="member-list">${memberList || '<p class="muted">Os nomes dos membros ainda não estão disponíveis.</p>'}</div></section>
    ${community.avisos?.length ? callout(community.avisos.join(' · '), 'warning', 'Aviso') : ''}`, '/comunidades');
}

async function renderAdmin(id) {
  const eventQuery = new URLSearchParams({ comunidadeId: id, futuras: 'false', estado: 'TODAS' });
  const [community, panel, events] = await Promise.all([
    api(`/api/web/comunidades/${encodeURIComponent(id)}`),
    api('/api/web/painel'),
    api(`/api/web/mobilizacoes?${eventQuery}`),
  ]);
  profile = panel.perfil;
  const isAdmin = (community.membros || []).some((m) => m.doadorId === profile?.id && m.papel === 'admin');
  if (!isAdmin) {
    app.innerHTML = layout(`${pageHeader('Área da comunidade', 'Acesso restrito', 'Somente administradores podem gerenciar mobilizações.')}<a class="btn" href="#/comunidades/${encodeURIComponent(id)}">Voltar à comunidade</a>`, '/comunidades');
    return;
  }
  const confirmed = events.filter((m) => String(m.estado || 'CONFIRMADA').toUpperCase() === 'CONFIRMADA').length;
  const pending = events.filter((m) => String(m.estado || '').toUpperCase() === 'PENDENTE').length;
  app.innerHTML = layout(`${pageHeader('Área de administração', community.nome, 'Organize a comunidade, acompanhe pessoas e mobilizações.')}
    <section class="card soft-red"><span class="badge admin">Administrador</span><h3 style="margin-top:20px">${esc(profile.nome.split(' ')[0])}, você está administrando ${esc(community.nome)}.</h3><p class="muted">${esc(community.cidade)}, ${esc(community.uf)} · comunidade</p></section>
    <div class="metric-cards"><div class="card metric-card"><strong>${Number(community.totalMembros || (community.membros || []).length)}</strong><span>membros na comunidade</span></div><div class="card metric-card"><strong>${confirmed}</strong><span>mobilizações confirmadas</span></div><div class="card metric-card"><strong>${pending}</strong><span>solicitações pendentes</span></div></div>
    <a class="btn btn-primary" href="#/comunidades/${encodeURIComponent(id)}/nova-mobilizacao">+ Criar mobilização</a>
    <div class="community-details section"><section class="card"><div class="section-heading"><h2>Mobilizações da comunidade</h2><a class="text-link" href="#/comunidades/${encodeURIComponent(id)}">Ver comunidade</a></div>${events.length ? `<div class="card-grid">${events.map((m) => mobilizationCard(m)).join('')}</div>` : emptyState('Nenhuma mobilização criada', 'Quando criar uma mobilização, ela aparecerá aqui.')}</section>
    <aside class="card"><h2>Membros</h2><div class="member-list">${(community.membros || []).slice(0, 20).map((m) => `<div class="member-row"><span>${esc(m.nome || 'Membro')}</span><span class="badge ${m.papel === 'admin' ? 'admin' : ''}">${m.papel === 'admin' ? 'Administrador' : 'Membro'}</span></div>`).join('')}</div></aside></div>`, '/comunidades');
}

function renderCommunityCreate() {
  app.innerHTML = layout(`${pageHeader('Comunidades / nova', 'Criar comunidade', 'Uma nova rede começa com um encontro.')}
    <form id="community-create" class="card"><div class="form-grid"><div class="field full"><label for="nome">Nome da comunidade</label><input id="nome" name="nome" required minlength="3" placeholder="Ex.: Doadores da região central" /></div><div class="field full"><label for="descricao">Descrição</label><textarea id="descricao" name="descricao" placeholder="Conte como a comunidade incentiva a doação e conecta pessoas."></textarea></div><div class="field"><label for="cidade">Cidade</label><input id="cidade" name="cidade" required minlength="2" placeholder="Sua cidade" /></div><div class="field"><label for="uf">Estado (UF)</label><input id="uf" name="uf" required minlength="2" maxlength="2" placeholder="MG" /></div></div><div class="form-actions"><button class="btn btn-primary" type="submit">Criar comunidade</button><a class="btn" href="#/comunidades">Cancelar</a></div></form>
    ${callout('Ao criar, você se torna administrador da comunidade e poderá propor mobilizações.', 'info', 'Como funciona')}`, '/comunidades');
}

async function renderMobilizationCreate(id) {
  const community = await api(`/api/web/comunidades/${encodeURIComponent(id)}`);
  const [profileData, hospitals] = await Promise.all([api('/api/web/painel'), api('/api/web/info/hemocentros').catch(() => [])]);
  profile = profileData.perfil;
  const isAdmin = (community.membros || []).some((m) => m.doadorId === profile?.id && m.papel === 'admin');
  if (!isAdmin) {
    app.innerHTML = layout(`${pageHeader('Administração / nova mobilização', 'Acesso restrito', 'Somente administradores podem criar mobilizações.')}<a class="btn" href="#/comunidades/${encodeURIComponent(id)}">Voltar à comunidade</a>`, '/comunidades');
    return;
  }
  const hospitalOptions = hospitals.map((h) => `<option value="${esc(h.id)}">${esc(h.nome)} · ${esc(h.cidade)}</option>`).join('');
  app.innerHTML = layout(`${pageHeader('Administração / nova mobilização', 'Criar mobilização', 'Preencha os dados e envie para confirmação.', `<a class="btn" href="#/comunidades/${encodeURIComponent(id)}/admin">← Voltar à administração</a>`)}
    ${callout('Informe detalhes reais da mobilização. Não use os locais fictícios da demonstração como endereço de atendimento.', 'info', 'Dados da mobilização')}
    <div class="split-layout"><form id="mobilization-create" class="card"><h2>Informações da mobilização</h2><input type="hidden" name="comunidadeId" value="${esc(id)}" />
      <div class="form-grid"><div class="field full"><label for="titulo">Título</label><input id="titulo" name="titulo" required minlength="3" placeholder="Ex.: Encontro solidário da comunidade" /></div><div class="field full"><label for="descricao">Descrição</label><textarea id="descricao" name="descricao" placeholder="Compartilhe informações úteis sobre o encontro."></textarea></div>
      <div class="field"><label for="data">Data</label><input id="data" name="data" type="date" required /></div><div class="field"><label for="hora">Horário de início</label><input id="hora" name="hora" type="time" required /></div><div class="field full"><label for="local">Local</label><input id="local" name="local" placeholder="Endereço ou ponto de encontro" /></div><div class="field"><label for="hemocentroId">Hemocentro <span class="muted">(opcional)</span></label><select id="hemocentroId" name="hemocentroId"><option value="">Não vincular agora</option>${hospitalOptions}</select><span class="hint">Unidades listadas podem conter dados ilustrativos; confirme diretamente.</span></div><div class="field"><label for="vagas">Vagas <span class="muted">(opcional)</span></label><input id="vagas" name="vagas" type="number" min="1" placeholder="Sem limite informado" /></div></div>
      <div class="form-actions"><button class="btn btn-primary" type="submit">Revisar mobilização</button><a class="btn" href="#/comunidades/${encodeURIComponent(id)}/admin">Cancelar</a></div></form>
      <aside class="card soft-amber sticky-card"><h3>Criar não é confirmar.</h3><p>Após o envio, acompanhe o retorno do serviço. Enquanto o status estiver pendente, não divulgue a mobilização como confirmada.</p><p><strong>Comunidade responsável</strong><br />${esc(community.nome)}</p>${callout('O 4Life facilita a mobilização e a comunicação. O atendimento e a triagem são do hemocentro.', 'info', 'Não é agendamento')}</aside></div>`, '/comunidades');
}

function renderReviewModal() {
  if (!mobilizationDraft) return;
  const d = mobilizationDraft;
  const modal = document.createElement('div');
  modal.className = 'modal-backdrop';
  modal.innerHTML = `<section class="card modal" role="dialog" aria-modal="true" aria-labelledby="review-title"><p class="eyebrow">Revisão</p><h2 id="review-title">Enviar para confirmação?</h2><h3>${esc(d.titulo)}</h3><p class="muted">${esc(formatDate(d.dataHora))}<br />${esc(d.local || 'Local a confirmar')}<br />${esc(d.cidade)}, ${esc(d.uf)}</p>${callout('O status inicial será pendente. O envio não garante a realização da mobilização.', 'warning', 'Acompanhe o retorno')}
    <div class="modal-actions"><button class="btn btn-primary btn-block" data-action="submit-mobilization">Enviar solicitação</button><button class="btn btn-block" data-action="close-review">Continuar editando</button></div></section>`;
  document.body.append(modal);
}

async function renderSagaStatus(id) {
  const [mob, saga] = await Promise.all([
    api(`/api/web/mobilizacoes/${encodeURIComponent(id)}`),
    api(`/api/web/mobilizacoes/${encodeURIComponent(id)}/saga`).catch((error) => ({ historico: [], aviso: error.message })),
  ]);
  const isPending = String(mob.estado || '').toUpperCase() === 'PENDENTE';
  app.innerHTML = layout(`${pageHeader('Mobilização / confirmação', 'Acompanhe a solicitação', 'A criação passou por uma validação assíncrona.')}
    <section class="card"><div class="section-heading"><h2>${esc(mob.titulo)}</h2>${statusBadge(mob.estado)}</div><p>${esc(formatDate(mob.dataHora))} · ${esc(mob.cidade)}, ${esc(mob.uf)}</p>${mob.estado === 'CANCELADA' ? callout(mob.motivoCancelamento || 'A solicitação não pôde ser confirmada.', 'error', 'Mobilização cancelada') : mob.estado === 'CONFIRMADA' ? callout('A mobilização foi confirmada pelo serviço. Agora você pode compartilhar as informações com sua comunidade.', 'success', 'Tudo certo por aqui') : callout('A solicitação está sendo processada. Aguarde a confirmação antes de divulgar como confirmada.', 'warning', 'Aguardando confirmação')}
    <div class="section"><h3>Etapas do processo</h3>${saga.historico?.length ? `<div class="timeline">${saga.historico.map((item) => `<div class="timeline-item"><span class="timeline-dot${isPending ? ' pending' : ''}"></span><div><strong>${esc(item.etapa || 'Etapa')}</strong><p class="muted small">${esc(item.descricao || '')} · ${esc(formatDate(item.em))}</p></div></div>`).join('')}</div>` : '<p class="muted">As etapas aparecerão aqui conforme o serviço atualizar o processo.</p>'}</div>
    ${saga.motivo ? callout(saga.motivo, 'warning', 'Retorno do processo') : ''}<div class="form-actions"><button class="btn" data-action="refresh-status" data-id="${esc(mob.id)}">Atualizar status</button><a class="btn btn-primary" href="#/comunidades/${encodeURIComponent(mob.comunidadeId)}/admin">Voltar à administração</a></div></section>`, '/comunidades');
  if (isPending) pollTimer = window.setTimeout(() => { if (routeParts().path === `/mobilizacoes/${id}/status`) renderSagaStatus(id).catch((e) => showToast(e.message, true)); }, 4000);
}

async function renderInformation(params) {
  const q = params.get('q') || '';
  const category = params.get('categoria') || '';
  const [contents, faq] = await Promise.all([api('/api/web/info/conteudos'), api('/api/web/info/faq').catch(() => [])]);
  const filtered = contents.filter((c) => (!category || c.categoria === category) && (!q || `${c.titulo} ${c.resumo} ${categories[c.categoria] || ''}`.toLocaleLowerCase('pt-BR').includes(q.toLocaleLowerCase('pt-BR'))));
  const cards = filtered.map((c) => `<a class="card quick-card" href="#/informacoes/${encodeURIComponent(c.slug)}"><p class="eyebrow">${esc(categories[c.categoria] || c.categoria)}</p><strong>${esc(c.titulo)} →</strong><span>${esc(c.resumo)}</span></a>`).join('');
  app.innerHTML = layout(`${pageHeader('Informações para doar', 'Informação também é cuidado', 'Encontre orientações e saiba o que confirmar com o hemocentro.')}
    <section class="card soft-green community-hero"><h2>Cada dúvida merece uma boa orientação.</h2><p class="body-copy">O 4Life ajuda você a se informar. A avaliação individual e as orientações de atendimento são do hemocentro.</p><a class="btn" href="#/assistente">Conversar com o assistente</a></section>
    <form id="information-search" class="section"><div class="field"><label for="q">Buscar nos conteúdos</label><input id="q" name="q" class="search-control" value="${esc(q)}" placeholder="O que você gostaria de saber?" /></div></form>
    <section class="section"><div class="section-heading"><h2>Explore por tema</h2></div><div class="card-grid grid-4">${Object.entries(categories).map(([key, label]) => `<a class="card quick-card" href="#/informacoes?categoria=${encodeURIComponent(key)}"><p class="eyebrow">${String(Object.keys(categories).indexOf(key) + 1).padStart(2, '0')}</p><strong>${label} →</strong></a>`).join('')}</div></section>
    <section class="section"><div class="section-heading"><h2>${category ? esc(categories[category] || category) : 'Conteúdos para você'}</h2><a class="text-link" href="#/hemocentros">Encontrar hemocentros</a></div>${cards ? `<div class="card-grid grid-3">${cards}</div>` : emptyState('Nenhum conteúdo encontrado', 'Experimente outra busca.')}</section>
    <section class="section card"><div class="section-heading"><h2>Perguntas frequentes</h2></div><div class="faq-list">${faq.map((item) => `<details><summary>${esc(item.pergunta)}</summary><p>${esc(item.resposta)}</p></details>`).join('') || '<p class="muted">As perguntas frequentes estão indisponíveis no momento.</p>'}</div></section>`, '/informacoes');
  const searchForm = document.querySelector('#information-search');
  if (searchForm) searchForm.addEventListener('submit', (event) => { event.preventDefault(); const data = new FormData(searchForm); const value = String(data.get('q') || '').trim(); go(`/informacoes${value ? `?q=${encodeURIComponent(value)}` : ''}`); });
}

async function renderArticle(slug) {
  const article = await api(`/api/web/info/conteudos/${encodeURIComponent(slug)}`);
  const [faq] = await Promise.all([api('/api/web/info/faq').catch(() => [])]);
  const relatedFaq = faq.filter((item) => item.categoria === article.categoria).slice(0, 4);
  app.innerHTML = layout(`${pageHeader(categories[article.categoria] || 'Informações', article.titulo, article.resumo, '<a class="btn" href="#/informacoes">← Voltar às informações</a>')}
    <div class="split-layout section"><article class="card"><p class="eyebrow">${esc(categories[article.categoria] || article.categoria)}</p><div class="article-body">${esc(article.corpo)}</div><p class="small muted section">Conteúdo orientativo. Confirme informações atualizadas com o hemocentro.</p></article><aside class="card soft-teal sticky-card"><h3>Precisa de mais orientação?</h3><p>O assistente pode ajudar com dúvidas gerais sobre doação e sobre a plataforma.</p><a class="btn btn-block" href="#/assistente">Conversar com o assistente</a><a class="btn btn-block" href="#/hemocentros">Encontrar um hemocentro</a></aside></div>
    ${relatedFaq.length ? `<section class="section card"><h2>Perguntas relacionadas</h2><div class="faq-list">${relatedFaq.map((item) => `<details><summary>${esc(item.pergunta)}</summary><p>${esc(item.resposta)}</p></details>`).join('')}</div></section>` : ''}`, '/informacoes');
}

async function renderHemocenters(params) {
  const city = params.get('cidade') || '';
  const uf = params.get('uf') || '';
  const query = new URLSearchParams();
  if (city) query.set('cidade', city);
  if (uf) query.set('uf', uf);
  const hospitals = await api(`/api/web/info/hemocentros${query.size ? `?${query}` : ''}`);
  const cards = hospitals.map((h) => `<article class="card"><p class="eyebrow">Informação de referência</p><h3>${esc(h.nome)}</h3><p>${esc(h.endereco)}</p><p class="muted">${esc(h.cidade)}, ${esc(h.uf)}</p><p class="muted small">${esc(h.horarios || 'Horários não informados')}${h.telefone ? ` · ${esc(h.telefone)}` : ''}</p><a class="btn btn-block" href="#/hemocentros/${encodeURIComponent(h.id)}">Ver detalhes</a></article>`).join('');
  app.innerHTML = layout(`${pageHeader('Rede de atendimento', 'Encontre um hemocentro', 'Consulte informações de contato e confirme os detalhes antes da visita.')}
    ${callout('Algumas unidades deste ambiente são dados de exemplo. Confirme endereço, horário e atendimento diretamente com o hemocentro.', 'info', 'Confira antes de visitar')}
    <form id="hospital-search" class="card search-panel"><div class="search-row" style="grid-template-columns:1fr 1fr"><div class="field"><label for="cidade">Cidade</label><input id="cidade" name="cidade" value="${esc(city)}" placeholder="Sua cidade" /></div><div class="field"><label for="uf">Estado</label><input id="uf" name="uf" maxlength="2" value="${esc(uf)}" placeholder="MG" /></div></div><div class="form-actions"><button class="btn btn-primary" type="submit">Buscar hemocentros</button><button class="btn" type="button" data-action="clear-hospital-filters">Limpar filtros</button></div></form>
    <section class="section"><div class="section-heading"><h2>${hospitals.length} unidades listadas</h2></div>${cards ? `<div class="card-grid grid-2">${cards}</div>` : emptyState('Nenhum hemocentro encontrado', 'Tente outra cidade ou estado.')}</section>`, '/hemocentros');
}

async function renderHemocenterDetail(id) {
  const h = await api(`/api/web/info/hemocentros/${encodeURIComponent(id)}`);
  app.innerHTML = layout(`${pageHeader('Rede de atendimento / detalhe', h.nome, 'Confira as informações e confirme os detalhes diretamente com a unidade.', '<a class="btn" href="#/hemocentros">← Voltar à busca</a>')}
    ${callout('Os dados podem ser ilustrativos. Não utilize um endereço de exemplo para planejar uma visita.', 'info', 'Confirme os canais oficiais')}
    <section class="card section"><p class="eyebrow">${esc(h.cidade)}, ${esc(h.uf)}</p><h2>Informações da unidade</h2><p class="body-copy">${esc(h.endereco)}</p><p><strong>Horários:</strong> ${esc(h.horarios || 'Não informados')}</p><p><strong>Telefone:</strong> ${esc(h.telefone || 'Não informado')}</p><div class="form-actions"><a class="btn" href="#/hemocentros">Encontrar outro hemocentro</a><a class="btn btn-primary" href="#/assistente">Tirar uma dúvida</a></div></section>`, '/hemocentros');
}

function renderAssistant() {
  const chat = assistantHistory.map((item) => `<div class="chat-message ${item.role}"><strong>${item.role === 'user' ? 'Você' : 'Assistente 4Life'}</strong>${esc(item.text)}${item.sources?.length ? `<p class="small"><strong>Fontes:</strong> ${item.sources.map(esc).join(' · ')}</p>` : ''}${item.notice ? `<p class="small"><strong>Aviso:</strong> ${esc(item.notice)}</p>` : ''}</div>`).join('');
  const waiting = assistantBusy ? '<div class="chat-message assistant"><strong>Assistente 4Life</strong><span class="icon-text"><span class="spinner" aria-hidden="true"></span> Buscando uma orientação…</span></div>' : '';
  app.innerHTML = layout(`${pageHeader('Assistente 4Life', 'Como posso ajudar você hoje?', 'Um espaço para dúvidas gerais sobre doação e sobre a plataforma.')}
    ${callout('O assistente não confirma se você pode doar e não substitui o hemocentro. Evite compartilhar dados pessoais ou de saúde na conversa.', 'info', 'Orientação, não avaliação médica')}
    <div class="split-layout section"><section class="card"><div class="section-heading"><div><h2>Assistente 4Life</h2><p class="small muted">Respostas orientativas baseadas nas informações do projeto.</p></div><button class="btn" data-action="clear-chat" type="button">Limpar conversa</button></div>
      <div class="chat-history" id="chat-history">${chat || '<div class="empty-state"><h3>Vamos conversar</h3><p class="muted">Escreva uma dúvida geral para começar.</p></div>'}${waiting}</div>
      <form id="assistant-form" class="chat-form"><div class="field"><label for="pergunta">Sua mensagem</label><textarea id="pergunta" name="pergunta" required minlength="3" maxlength="500" placeholder="Escreva uma dúvida geral…" ${assistantBusy ? 'disabled' : ''}></textarea></div><button class="btn btn-primary" type="submit" ${assistantBusy ? 'disabled' : ''}>Enviar</button></form></section>
      <aside class="card soft-green sticky-card"><h2>Quer começar por aqui?</h2><div class="suggestions"><button class="btn" data-action="ask-suggestion" data-question="O que preciso confirmar antes de participar de uma mobilização?">O que preciso confirmar?</button><button class="btn" data-action="ask-suggestion" data-question="Onde encontro um hemocentro?">Onde encontro um hemocentro?</button><a class="btn" href="#/informacoes">Informações para doar</a></div></aside></div>`, '/assistente');
  const history = document.querySelector('#chat-history');
  if (history) history.scrollTop = history.scrollHeight;
}

async function sendAssistantQuestion(question) {
  if (assistantBusy || !question.trim()) return;
  assistantHistory.push({ role: 'user', text: question.trim() });
  assistantBusy = true;
  renderAssistant();
  try {
    const answer = await api('/api/web/assistente/perguntar', { method: 'POST', body: { pergunta: question.trim(), usarRag: true, usarCache: true }, timeout: 58000 });
    assistantHistory.push({ role: 'assistant', text: answer.resposta || 'Não recebi uma resposta do assistente.', sources: answer.fontes || [], notice: answer.aviso || '' });
  } catch (error) {
    assistantHistory.push({ role: 'assistant', text: 'Não consegui responder agora. Você pode tentar novamente ou consultar os conteúdos e perguntas frequentes.', notice: error.message });
  } finally {
    assistantBusy = false;
    renderAssistant();
  }
}

async function renderRoute() {
  clearTimeout(pollTimer);
  const { path, params } = routeParts();
  if (path === '/login' || path === '/signup' || !token()) {
    if (token() && (path === '/login' || path === '/signup')) { go('/dashboard'); return; }
    renderAuth(path === '/signup');
    return;
  }
  app.innerHTML = `<div class="container">${loading()}</div>`;
  try {
    if (path === '/' || path === '/dashboard') return await renderDashboard();
    if (path === '/mobilizacoes') return await renderMobilizations(params);
    if (/^\/mobilizacoes\/[^/]+\/status$/.test(path)) return await renderSagaStatus(decodeURIComponent(path.split('/')[2]));
    if (/^\/mobilizacoes\/[^/]+$/.test(path)) return await renderMobilizationDetail(decodeURIComponent(path.split('/')[2]));
    if (path === '/comunidades') return await renderCommunities(params);
    if (path === '/comunidades/nova') return renderCommunityCreate();
    if (/^\/comunidades\/[^/]+\/admin$/.test(path)) return await renderAdmin(decodeURIComponent(path.split('/')[2]));
    if (/^\/comunidades\/[^/]+\/nova-mobilizacao$/.test(path)) return await renderMobilizationCreate(decodeURIComponent(path.split('/')[2]));
    if (/^\/comunidades\/[^/]+$/.test(path)) return await renderCommunityDetail(decodeURIComponent(path.split('/')[2]));
    if (path === '/informacoes') return await renderInformation(params);
    if (/^\/informacoes\/[^/]+$/.test(path)) return await renderArticle(decodeURIComponent(path.split('/')[2]));
    if (path === '/hemocentros') return await renderHemocenters(params);
    if (/^\/hemocentros\/[^/]+$/.test(path)) return await renderHemocenterDetail(decodeURIComponent(path.split('/')[2]));
    if (path === '/assistente') return renderAssistant();
    go('/dashboard');
  } catch (error) {
    const retryLink = `<button class="btn" data-action="retry">Tentar novamente</button>`;
    app.innerHTML = layout(`${pageHeader('Não foi possível carregar', 'Algo não saiu como esperado', 'Confira sua conexão com o serviço e tente novamente.')}${callout(error.message, 'error', 'Resposta do sistema')}${retryLink}`);
  }
}

function formValues(form) {
  return Object.fromEntries(new FormData(form).entries());
}

app.addEventListener('submit', async (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  event.preventDefault();
  const values = formValues(form);
  const submit = form.querySelector('[type="submit"]');
  if (submit) submit.disabled = true;
  try {
    if (form.id === 'login-form') {
      const result = await api('/auth/login', { method: 'POST', body: { email: values.email, senha: values.senha } });
      localStorage.setItem(TOKEN_KEY, result.token);
      profile = null;
      go('/dashboard');
    } else if (form.id === 'signup-form') {
      const payload = { nome: values.nome, email: values.email, senha: values.senha, cidade: values.cidade, uf: values.uf.toUpperCase(), tipoSanguineo: values.tipoSanguineo || null };
      await api('/api/web/cadastro', { method: 'POST', body: payload });
      showToast('Conta criada. Entre com seu e-mail e senha.');
      go('/login');
    } else if (form.id === 'community-create') {
      const created = await api('/api/web/comunidades', { method: 'POST', body: { nome: values.nome.trim(), descricao: values.descricao.trim(), cidade: values.cidade.trim(), uf: values.uf.toUpperCase() } });
      profile = null;
      showToast('Comunidade criada. Você agora é administrador.');
      go(`/comunidades/${encodeURIComponent(created.id)}`);
    } else if (form.id === 'community-search') {
      const search = new URLSearchParams();
      for (const key of ['q', 'cidade', 'uf']) if (String(values[key] || '').trim()) search.set(key, String(values[key]).trim());
      go(`/comunidades${search.size ? `?${search}` : ''}`);
    } else if (form.id === 'mobilization-search') {
      const search = new URLSearchParams();
      for (const key of ['q', 'cidade', 'uf', 'data']) if (String(values[key] || '').trim()) search.set(key, String(values[key]).trim());
      if (values.comunidade) search.set('comunidadeId', values.comunidade);
      go(`/mobilizacoes${search.size ? `?${search}` : ''}`);
    } else if (form.id === 'hospital-search') {
      const search = new URLSearchParams();
      if (values.cidade.trim()) search.set('cidade', values.cidade.trim());
      if (values.uf.trim()) search.set('uf', values.uf.trim().toUpperCase());
      go(`/hemocentros${search.size ? `?${search}` : ''}`);
    } else if (form.id === 'mobilization-create') {
      const date = new Date(`${values.data}T${values.hora}`);
      if (Number.isNaN(date.getTime()) || date <= new Date()) throw new Error('Escolha uma data e horário futuros.');
      mobilizationDraft = {
        comunidadeId: values.comunidadeId,
        titulo: values.titulo.trim(),
        descricao: values.descricao.trim(),
        dataHora: date.toISOString(),
        cidade: profile?.cidade || '',
        uf: profile?.uf || '',
        local: values.local.trim(),
        hemocentroId: values.hemocentroId || null,
        vagas: values.vagas ? Number(values.vagas) : null,
      };
      renderReviewModal();
    } else if (form.id === 'assistant-form') {
      await sendAssistantQuestion(values.pergunta);
    }
  } catch (error) {
    showToast(error.message, true);
    if (submit) submit.disabled = false;
  }
});

app.addEventListener('click', async (event) => {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;
  const id = target.dataset.id;
  if (action === 'toggle-menu') {
    const nav = document.querySelector('.main-nav');
    const open = nav?.classList.toggle('open');
    target.setAttribute('aria-expanded', String(Boolean(open)));
    return;
  }
  if (action === 'logout') {
    localStorage.removeItem(TOKEN_KEY);
    profile = null;
    assistantHistory = [];
    go('/login');
    return;
  }
  if (action === 'forgot-password') return showToast('A recuperação de senha ainda não tem uma rota disponível no backend.', true);
  if (action === 'retry') return renderRoute();
  if (action === 'clear-chat') { assistantHistory = []; return renderAssistant(); }
  if (action === 'ask-suggestion') return sendAssistantQuestion(target.dataset.question || '');
  if (action === 'clear-community-filters') return go('/comunidades');
  if (action === 'clear-mobilization-filters') return go('/mobilizacoes');
  if (action === 'clear-hospital-filters') return go('/hemocentros');
  if (action === 'close-review') { document.querySelector('.modal-backdrop')?.remove(); return; }
  if (action === 'refresh-status') return renderRoute();
  if (action === 'submit-mobilization') {
    if (!mobilizationDraft) return;
    target.disabled = true;
    try {
      const created = await api(`/api/web/comunidades/${encodeURIComponent(mobilizationDraft.comunidadeId)}/mobilizacoes`, { method: 'POST', body: mobilizationDraft });
      const newId = created.id;
      mobilizationDraft = null;
      document.querySelector('.modal-backdrop')?.remove();
      showToast('Solicitação enviada para confirmação.');
      go(`/mobilizacoes/${encodeURIComponent(newId)}/status`);
    } catch (error) {
      target.disabled = false;
      showToast(error.message, true);
    }
    return;
  }
  if (action === 'join-community') {
    target.disabled = true;
    try {
      await api(`/api/web/comunidades/${encodeURIComponent(id)}/membros`, { method: 'POST', body: {} });
      showToast('Você entrou na comunidade.');
      await renderRoute();
    } catch (error) { target.disabled = false; showToast(error.message, true); }
    return;
  }
  if (action === 'interest' || action === 'cancel-interest') {
    target.disabled = true;
    try {
      await api(`/api/web/mobilizacoes/${encodeURIComponent(id)}/interesse`, { method: action === 'interest' ? 'POST' : 'DELETE' });
      showToast(action === 'interest' ? 'Interesse registrado.' : 'Interesse removido.');
      await renderRoute();
    } catch (error) { target.disabled = false; showToast(error.message, true); }
  }
});

window.addEventListener('hashchange', renderRoute);
renderRoute();
