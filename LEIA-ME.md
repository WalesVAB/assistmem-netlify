# Lançador de Tickets SAP — Netlify + Supabase

Estrutura: `public/` (site estático) · `netlify/functions/admin-users.js` (criar/alterar/desativar usuários) · `supabase/schema.sql` (banco + regras RLS).

## 1. Supabase
1. Crie um projeto em supabase.com (plano Free).
2. **SQL Editor** → cole e rode `supabase/schema.sql`.
3. **Authentication → Sign In / Providers → Email**: desligue **"Allow new users to sign up"** e **"Confirm email"**.
4. **Authentication → Users → Add user → Create new user**: e-mail `wales@assistmem.local` (login em minúsculas, sem acentos/espaços; ex.: login `Wales` → `wales@assistmem.local`), uma senha NOVA (mín. 6 caracteres), marque *Auto Confirm User*.
5. No SQL Editor, crie o perfil de admin:
   ```sql
   insert into public.profiles (id, nome, login, cor, is_admin)
   select id, 'Wales', 'Wales', '#0070f3', true from auth.users where email = 'wales@assistmem.local';
   ```
6. **Settings → API**: copie *Project URL*, *anon public key* e *service_role key*.

## 2. Configurar o site
Edite `public/supabase-shim.js` (topo): preencha `SUPABASE_URL` e `SUPABASE_ANON_KEY` (a anon é pública, pode ficar no código).

## 3. Netlify
1. Suba esta pasta num repositório GitHub e conecte no Netlify (*Add new site → Import*), ou use `netlify deploy --prod` (CLI). Não precisa de build.
2. **Site settings → Environment variables**: `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` (a service_role NUNCA vai no código/front).
3. Faça um novo deploy e abra o site; entre com Wales e crie os demais usuários em "Gerenciar usuários".

## Diferenças em relação ao InfinityFree
- Senhas agora têm no mínimo **6** caracteres. O login offline "Admin/admin123" foi removido.
- Usuários antigos precisam ser recriados (as senhas bcrypt do MySQL não migram).
- Dados antigos: exporte as tabelas do phpMyAdmin em CSV e importe em *Table Editor → Import data* (em `tickets`, sem a coluna `id`).
- Sincronização a cada 60 s (era 20 s), com cache e busca incremental de tickets para poupar banda; abas em segundo plano não consultam.
- Projetos Free do Supabase pausam após ~1 semana sem uso: basta clicar em *Restore* no painel.
- Segurança: a regra RLS exige login; ninguém sem conta lê ou grava dados. **Troque** a senha do banco MySQL antigo e a senha temporária do `bootstrap_admin.sql`, pois foram expostas na conversa.
