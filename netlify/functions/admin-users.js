// Netlify Function: ações de administração de usuários (precisam da service role).
// Variáveis de ambiente (Netlify > Site settings > Environment variables):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY
const J = (status, obj) => ({ statusCode: status,
  headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });

function slug(login) {
  let s = String(login).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!s) { let h = 0; for (const c of String(login)) h = (h * 31 + c.charCodeAt(0)) >>> 0; s = 'u' + h.toString(36); }
  return s;
}
const emailOf = (login) => slug(login) + '@assistmem.local';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return J(405, { error: 'Método não suportado.' });
  const URL_ = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const SRK = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!URL_ || !SRK) return J(500, { error: 'Servidor sem configuração (variáveis de ambiente).' });
  const svc = { apikey: SRK, Authorization: 'Bearer ' + SRK, 'Content-Type': 'application/json' };

  let body; try { body = JSON.parse(event.body || '{}'); } catch (_) { return J(400, { error: 'Corpo inválido.' }); }

  // Quem está chamando?
  const tok = ((event.headers.authorization || event.headers.Authorization || '').match(/^Bearer (.+)$/) || [])[1];
  if (!tok) return J(401, { error: 'Não autenticado. Faça login novamente.' });
  const ur = await fetch(URL_ + '/auth/v1/user', { headers: { apikey: SRK, Authorization: 'Bearer ' + tok } });
  if (!ur.ok) return J(401, { error: 'Sessão expirada. Faça login novamente.' });
  const caller = await ur.json();
  const pr = await fetch(URL_ + '/rest/v1/profiles?id=eq.' + caller.id + '&select=is_admin,ativo', { headers: svc });
  const prof = ((await pr.json()) || [])[0];
  if (!prof || !prof.ativo || !prof.is_admin) return J(403, { error: 'Apenas administradores podem fazer isso.' });

  const rest = (path, opt) => fetch(URL_ + '/rest/v1/' + path, Object.assign({ headers: Object.assign({ Prefer: 'return=representation' }, svc) }, opt));
  const profByLogin = async (login) => ((await (await rest('profiles?login=eq.' + encodeURIComponent(login) + '&select=id,num')).json()) || [])[0];
  const setAtivo = async (num, ativo) => {
    const r = await rest('profiles?num=eq.' + Number(num), { method: 'PATCH', body: JSON.stringify({ ativo }) });
    const rows = await r.json();
    if (!r.ok || !rows.length) return J(404, { error: 'Usuário não encontrado.' });
    // bloqueia/desbloqueia também no Auth
    await fetch(URL_ + '/auth/v1/admin/users/' + rows[0].id, { method: 'PUT', headers: svc,
      body: JSON.stringify({ ban_duration: ativo ? 'none' : '876000h' }) });
    return J(200, { ok: true });
  };

  try {
    switch (body.action) {
      case 'cadastrar_usuario': {
        const nome = String(body.nome || '').trim(), login = String(body.login || '').trim();
        const senha = String(body.senha || ''); let cor = String(body.cor || '#0070f3').trim();
        if (!nome || !login || !senha) return J(400, { error: 'Preencha nome, login e senha.' });
        if (senha.length < 6) return J(400, { error: 'A senha precisa ter pelo menos 6 caracteres.' });
        if (!/^#[0-9a-fA-F]{6}$/.test(cor)) cor = '#0070f3';
        if (await profByLogin(login)) return J(400, { error: 'Já existe um usuário com esse login.' });
        const cr = await fetch(URL_ + '/auth/v1/admin/users', { method: 'POST', headers: svc,
          body: JSON.stringify({ email: emailOf(login), password: senha, email_confirm: true }) });
        const u = await cr.json();
        if (!cr.ok) return J(400, { error: u.msg || u.message || u.error_description || 'Falha ao criar usuário.' });
        const ins = await rest('profiles', { method: 'POST',
          body: JSON.stringify({ id: u.id, nome, login, cor, is_admin: !!body.is_admin, ativo: true }) });
        const row = await ins.json();
        if (!ins.ok) { await fetch(URL_ + '/auth/v1/admin/users/' + u.id, { method: 'DELETE', headers: svc });
          return J(400, { error: 'Falha ao salvar perfil (login já usado?).' }); }
        return J(200, { ok: true, id: row[0].num });
      }
      case 'alterar_senha': {
        const login = String(body.login || '').trim(), senha = String(body.senha || '');
        if (!login || !senha) return J(400, { error: 'Informe o login e a nova senha.' });
        if (senha.length < 6) return J(400, { error: 'A senha precisa ter pelo menos 6 caracteres.' });
        const p = await profByLogin(login);
        if (!p) return J(404, { error: 'Usuário não encontrado.' });
        const r = await fetch(URL_ + '/auth/v1/admin/users/' + p.id, { method: 'PUT', headers: svc, body: JSON.stringify({ password: senha }) });
        if (!r.ok) return J(400, { error: 'Falha ao alterar a senha.' });
        return J(200, { ok: true });
      }
      case 'desativar_usuario':
        if (!Number(body.id)) return J(400, { error: 'Usuário não informado.' });
        return await setAtivo(body.id, false);
      case 'reativar_usuario':
        if (!Number(body.id)) return J(400, { error: 'Usuário não informado.' });
        return await setAtivo(body.id, true);
      default: return J(400, { error: 'Ação desconhecida.' });
    }
  } catch (e) { return J(500, { error: 'Erro interno: ' + e.message }); }
};
