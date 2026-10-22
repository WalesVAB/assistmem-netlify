/* Camada de compatibilidade: o app continua chamando "api.php", mas aqui
   essas chamadas são atendidas pelo Supabase (dados + login) e por uma
   Netlify Function (administração de usuários). */
(function () {
  // >>> PREENCHA com os dados do seu projeto Supabase (Settings > API) <<<
  var SUPABASE_URL = 'https://qijpbfheivtnlghopdaq.supabase.co';
  var SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFpanBiZmhlaXZ0bmxnaG9wZGFxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI1NjM4MTksImV4cCI6MjEwODEzOTgxOX0.lsNDQI9LBUQBSkELJETnh08SW9c2-4SQIUQNE8pABgU';
  // (a anon key é pública por design; a segurança está nas regras RLS do schema.sql)

  var ADMIN_FN = '/.netlify/functions/admin-users';
  var TTL_CADASTROS = 120000; // 2 min: agencias/agentes/ods
  var PAGE = 1000;

  var realFetch = window.fetch.bind(window);
  var sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: 'assistmem-auth' },
    global: { fetch: realFetch }
  });

  var TABLES = {
    agencias: { key: 'codigo', cols: ['codigo', 'nome', 'telefone'], order: 'codigo' },
    agentes: { key: 'codigo', cols: ['codigo', 'nome'], order: 'codigo' },
    ods: { key: 'codigo', cols: ['codigo', 'nome'], order: 'codigo' },
    tickets: { key: null, cols: ['tipo', 'resumo', 'texto', 'agente', 'data', 'hora'], order: 'id' },
    textos_padrao: { key: null, cols: ['dados', 'atualizado_por', 'atualizado_em'], order: 'id' }
  };

  function json(obj, status) {
    return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'Content-Type': 'application/json' } });
  }
  function slug(login) {
    var s = String(login).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (!s) { var h = 0; for (var i = 0; i < login.length; i++) h = (h * 31 + login.charCodeAt(i)) >>> 0; s = 'u' + h.toString(36); }
    return s;
  }
  function pub(p) { return { id: Number(p.num), nome: p.nome, login: p.login, cor: p.cor, is_admin: !!p.is_admin }; }
  function Err(msg, status) { var e = new Error(msg); e.status = status || 400; return e; }

  async function session() { var r = await sb.auth.getSession(); return r.data && r.data.session; }
  async function profile(uid) {
    var r = await sb.from('profiles').select('num,nome,login,cor,is_admin,ativo').eq('id', uid).maybeSingle();
    if (r.error) throw Err('Falha ao carregar perfil.', 500);
    return r.data;
  }
  async function requireSession() {
    var s = await session();
    if (!s) throw Err('Não autenticado. Faça login novamente.', 401);
    return s;
  }

  // Cache em memória
  var cache = {}; // tabela -> {rows:[], at:ms, maxId:n}
  function copy(rows) { return rows.map(function (r) { return Object.assign({}, r); }); }

  // Datas sempre no horário de Brasília (mesmo formato que o api.php devolvia: sem fuso)
  var BRT = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  function brt(row) {
    if (row && row.criado_em) {
      var d = new Date(row.criado_em);
      if (!isNaN(d)) row.criado_em = BRT.format(d).replace(' ', 'T');
    }
    return row;
  }

  async function fetchPages(table, cfg, sinceId) {
    var out = [], from = 0;
    for (;;) {
      var q = sb.from(table).select('*');
      if (sinceId != null) q = q.gt('id', sinceId);
      q = q.order(cfg.order, { ascending: true }).range(from, from + PAGE - 1);
      var r = await q;
      if (r.error) throw Err(r.error.message || 'Erro ao consultar.', r.status || 500);
      out = out.concat(r.data.map(brt));
      if (r.data.length < PAGE) break;
      from += PAGE;
    }
    return out;
  }

  async function listTable(table) {
    var cfg = TABLES[table];
    if (!cfg) throw Err('Tabela inválida: ' + table);
    await requireSession();
    var c = cache[table];
    if (c && document.hidden) return copy(c.rows); // aba em segundo plano: não gasta banda
    if (cfg.key) { // cadastros: recarrega por TTL
      if (c && Date.now() - c.at < TTL_CADASTROS) return copy(c.rows);
      var rows = await fetchPages(table, cfg, null);
      cache[table] = { rows: rows, at: Date.now() };
      return copy(rows);
    }
    // tabelas só-de-inserção: busca só o que é novo
    if (!c) c = cache[table] = { rows: [], at: 0, maxId: null };
    var novos = await fetchPages(table, cfg, c.maxId);
    if (novos.length) { c.rows = c.rows.concat(novos); c.maxId = novos[novos.length - 1].id; }
    c.at = Date.now();
    return copy(c.rows);
  }

  async function writeTable(body) {
    var table = body.table, cfg = TABLES[table];
    if (!cfg) throw Err('Tabela inválida: ' + table);
    await requireSession();
    if (body.action === 'delete') {
      if (!cfg.key) throw Err('Esta tabela não suporta exclusão.');
      if (!body.codigo) throw Err('Código não informado para exclusão.');
      var d = await sb.from(table).delete().eq(cfg.key, body.codigo);
      if (d.error) throw Err(d.error.message, 500);
      delete cache[table];
      return { ok: true };
    }
    var data = body.data || {}, row = {};
    cfg.cols.forEach(function (c) { if (c in data) row[c] = data[c]; });
    if (!Object.keys(row).length) throw Err('Nenhum dado válido enviado.');
    var r;
    if (cfg.key) {
      if (!(cfg.key in row)) throw Err('Campo "' + cfg.key + '" é obrigatório.');
      r = await sb.from(table).upsert(row, { onConflict: cfg.key });
      delete cache[table];
    } else {
      if (table === 'tickets') return insertTicketOnce(row);
      r = await sb.from(table).insert(row);
    }
    if (r.error) throw Err(r.error.message, 500);
    return { ok: true };
  }

  // Anti-duplicidade: o app pode mandar o mesmo ticket 2x em sequência.
  // Junta pedidos iguais (tipo+resumo+texto) feitos em até 0,4 s e ignora repetidos por 20 s.
  var pendT = {}, recentT = {};
  function insertTicketOnce(row) {
    var key = [row.tipo, row.resumo, row.texto].join('\u0001'), now = Date.now();
    if (recentT[key] && now - recentT[key] < 20000) return Promise.resolve({ ok: true });
    var p = pendT[key];
    if (p) { // completa campos que faltavam no primeiro pedido
      Object.keys(row).forEach(function (c) {
        if (row[c] != null && row[c] !== '' && (p.row[c] == null || p.row[c] === '' || p.row[c] === '—')) p.row[c] = row[c];
      });
      return p.promise;
    }
    p = pendT[key] = { row: Object.assign({}, row) };
    p.promise = new Promise(function (resolve, reject) {
      setTimeout(async function () {
        delete pendT[key];
        try {
          var r = await sb.from('tickets').insert(p.row);
          if (r.error) return reject(Err(r.error.message, 500));
          recentT[key] = Date.now();
          resolve({ ok: true });
        } catch (e) { reject(e); }
      }, 400);
    });
    return p.promise;
  }

  async function admin(body) {
    var s = await requireSession();
    var res = await realFetch(ADMIN_FN, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + s.access_token },
      body: JSON.stringify(body) });
    var j; try { j = await res.json(); } catch (_) { throw Err('Servidor de administração indisponível.', 502); }
    if (!res.ok) throw Err(j.error || 'Erro.', res.status);
    return j;
  }

  async function handleApi(url, init) {
    var q = new URL(url, location.href).searchParams;
    var method = (init.method || 'GET').toUpperCase();
    if (method === 'GET') {
      var a = q.get('action');
      if (a === 'me') {
        var s = await session();
        if (!s) return json({ error: 'Não autenticado.' }, 401);
        var p = await profile(s.user.id);
        if (!p || !p.ativo) { await sb.auth.signOut(); return json({ error: 'Não autenticado.' }, 401); }
        return json({ usuario: pub(p) });
      }
      if (a === 'list') return json(await listTable(q.get('table') || ''));
      return json({ error: 'Ação desconhecida: ' + a }, 400);
    }
    var body; try { body = JSON.parse(init.body || '{}'); } catch (_) { return json({ error: 'Corpo da requisição inválido.' }, 400); }
    switch (body.action) {
      case 'login': {
        var login = String(body.login || '').trim(), senha = String(body.senha || '');
        if (!login || !senha) return json({ error: 'Preencha usuário e senha.' }, 400);
        var r = await sb.auth.signInWithPassword({ email: slug(login) + '@assistmem.local', password: senha });
        if (r.error) return json({ error: 'Usuário ou senha incorretos.' }, 401);
        var pr = await profile(r.data.user.id);
        if (!pr || !pr.ativo) { await sb.auth.signOut(); return json({ error: 'Usuário ou senha incorretos.' }, 401); }
        cache = {};
        return json({ usuario: pub(pr) });
      }
      case 'logout': await sb.auth.signOut(); cache = {}; return json({ ok: true });
      case 'listar_usuarios': {
        await requireSession();
        var u = await sb.from('profiles').select('num,nome,login,cor,is_admin,ativo,criado_em').order('nome');
        if (u.error) throw Err(u.error.message, 500);
        return json(u.data.map(function (x) {
          return { id: Number(x.num), nome: x.nome, login: x.login, cor: x.cor,
            is_admin: x.is_admin ? 1 : 0, ativo: x.ativo ? 1 : 0, criado_em: x.criado_em };
        }));
      }
      case 'cadastrar_usuario': case 'alterar_senha': case 'desativar_usuario': case 'reativar_usuario':
        return json(await admin(body));
      default: return json(await writeTable(body));
    }
  }

  window.fetch = async function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    if (!/^(\.\/)?api\.php(\?|$)/.test(url)) return realFetch(input, init);
    try { return await handleApi(url, init || {}); }
    catch (e) { return json({ error: String(e.message || e) }, e.status || 500); }
  };
  window.__assistmemSupabase = sb;
})();
