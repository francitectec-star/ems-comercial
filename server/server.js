/* EMS Comercial — Servidor central (Fase C — portal público)
   Estado único em PostgreSQL (tabelas ems_state / ems_state_hist / ems_audit /
   ems_public_catalog / ems_public_quotes), mesmo banco do SPI, tabelas separadas.
   Sem DATABASE_URL funciona em modo ficheiro local (testes/uso individual).
   Serve o comercial.html do repositório.

   Fase C — endpoints públicos do portal Electro-Moz-Solar:
     GET    /api/public/catalog        → catálogo publicado (sem preços/stock/dados internos)
     POST   /api/public/quote          → cotação do portal → ems_public_quotes (limite 8/h/IP)
     POST   /api/admin/catalog/publish → publica o catálogo (token; higieniza chaves internas)
     GET    /api/admin/catalog         → catálogo publicado atual (token)
     DELETE /api/admin/catalog         → despublicar (token)
     GET    /api/admin/quotes          → cotações recebidas (token)
     POST   /api/admin/quotes/estado   → marcar/reabrir cotação (token)
   /api/public/* e /api/admin/* enviam CORS aberto (o portal vive noutro domínio);
   os /api/admin/* exigem token obtido em /api/auth/login. */
const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const ROOT=path.join(__dirname,'..'),PORT=Number(process.env.PORT||3000),HOST=process.env.HOST||'0.0.0.0';
const BUILD='faseC-v1';
const DBFILE=process.env.EMS_DATA_FILE||path.join(__dirname,'ems-server-data.json');
const PUBFILE=process.env.EMS_PUBLIC_FILE||path.join(__dirname,'ems-public-data.json');
const {Pool}=require('pg');
const DATABASE_URL=process.env.DATABASE_URL||'';
const pool=DATABASE_URL?new Pool({connectionString:DATABASE_URL,ssl:{rejectUnauthorized:false},max:5}):null;
let DB_CACHE=null,writeQueue=Promise.resolve();
let PUB=null,PUB_TS=0;
let PUBF={catalogo:null,cotacoes:[]};
const TOKENS=new Map(),TOKEN_TTL=12*3600*1000;
function sha(p){return crypto.createHash('sha256').update(String(p)).digest('hex')}
function seed(){return {revision:1,data:{v:1,config:{loja:'Electro-Moz-Solar E.I.',nuit:'',contactos:'',endereco:'',proxFac:1,proxCot:1,proxServ:1,ivaPct:16,aplicarIva:false,senhaHash:null},produtos:[],fornecedores:[],clientes:[],compras:[],vendas:[],cotacoes:[],servicos:[],despesas:[],caixa:[],fechosCaixa:[],encomendas:[],anuladas:[],usuarios:[{id:'u1',nome:'Administrador',perfil:'admin',pinHash:null,ativo:true}],audit:[],movimentos:[],catServicos:[]}}}
function queueDbWrite(d){if(!pool)return;const snap=JSON.stringify(d);writeQueue=writeQueue.then(()=>pool.query('INSERT INTO ems_state(id,revision,data,updated_at) VALUES(1,$1,$2::jsonb,NOW()) ON CONFLICT(id) DO UPDATE SET revision=EXCLUDED.revision,data=EXCLUDED.data,updated_at=NOW()',[Number(d.revision)||0,snap]));writeQueue=writeQueue.catch(e=>console.error('Falha ao gravar PostgreSQL:',e.message))}
function save(d){DB_CACHE=d;if(!pool){const tmp=DBFILE+'.tmp';fs.writeFileSync(tmp,JSON.stringify(d,null,2),'utf8');fs.renameSync(tmp,DBFILE);return}queueDbWrite(d)}
function savePubF(){const tmp=PUBFILE+'.tmp';fs.writeFileSync(tmp,JSON.stringify(PUBF,null,2),'utf8');fs.renameSync(tmp,PUBFILE)}
function snapshotPrev(){if(!pool||!DB_CACHE)return;const prev=JSON.stringify(DB_CACHE);writeQueue=writeQueue.then(()=>pool.query('INSERT INTO ems_state_hist(data,created_at) VALUES($1::jsonb,NOW())',[prev]).catch(e=>console.error('Snapshot falhou:',e.message)));writeQueue=writeQueue.then(()=>pool.query('DELETE FROM ems_state_hist WHERE id NOT IN (SELECT id FROM ems_state_hist ORDER BY id DESC LIMIT 100)').catch(()=>{}))}
async function initPersistence(){
  if(!pool){DB_CACHE=fs.existsSync(DBFILE)?JSON.parse(fs.readFileSync(DBFILE,'utf8')):seed();
    if(fs.existsSync(PUBFILE)){try{const j=JSON.parse(fs.readFileSync(PUBFILE,'utf8'));if(j&&typeof j==='object')PUBF=Object.assign({catalogo:null,cotacoes:[]},j)}catch(e){}}
    if(PUBF.catalogo)PUB={revision:1,data:PUBF.catalogo};
    return}
  await pool.query('CREATE TABLE IF NOT EXISTS ems_state(id INTEGER PRIMARY KEY,revision INTEGER NOT NULL,data JSONB NOT NULL,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
  await pool.query('CREATE TABLE IF NOT EXISTS ems_state_hist(id BIGSERIAL PRIMARY KEY,data JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
  await pool.query('CREATE TABLE IF NOT EXISTS ems_audit(id BIGSERIAL PRIMARY KEY,data JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
  await pool.query('CREATE TABLE IF NOT EXISTS ems_public_catalog(id INTEGER PRIMARY KEY,revision INTEGER NOT NULL,data JSONB NOT NULL,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
  await pool.query('CREATE TABLE IF NOT EXISTS ems_public_quotes(id BIGSERIAL PRIMARY KEY,data JSONB NOT NULL,processado BOOLEAN NOT NULL DEFAULT FALSE,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
  const r=await pool.query('SELECT revision,data FROM ems_state WHERE id=1');
  if(r.rowCount){DB_CACHE={revision:Number(r.rows[0].revision)||1,data:r.rows[0].data}}else{DB_CACHE=seed();await pool.query('INSERT INTO ems_state(id,revision,data) VALUES(1,$1,$2::jsonb)',[DB_CACHE.revision,JSON.stringify(DB_CACHE)])}
  const p=await pool.query('SELECT revision,data FROM ems_public_catalog WHERE id=1');
  if(p.rowCount)PUB={revision:Number(p.rows[0].revision)||1,data:p.rows[0].data};
}
/* Recuperacao NAO destrutiva: EMS_RESET_ADMIN redefine apenas a senha do admin */
async function applyReset(){const v=process.env.EMS_RESET_ADMIN;if(!v||!DB_CACHE)return;const us=(DB_CACHE.data.config&&DB_CACHE.data.config.usuarios)||[];const adm=us.find(x=>x.login==='admin')||us[0];if(!adm)return;const marca=(DB_CACHE.data.config.resetAdminMarca)||'';if(marca===sha(v)){console.error('EMS: EMS_RESET_ADMIN ja aplicado — nada alterado.');return}adm.pinHash=sha(v);adm.ativo=true;DB_CACHE.data.config.senhaHash=sha(v);DB_CACHE.data.config.resetAdminMarca=sha(v);await save(DB_CACHE);delete process.env.EMS_RESET_ADMIN;console.error('EMS: senha redefinida via EMS_RESET_ADMIN — DADOS MANTIDOS')}
function send(res,code,obj,type){const b=typeof obj==='string'?obj:JSON.stringify(obj);res.writeHead(code,{'Content-Type':type||'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(b)}
function readBody(req){return new Promise(r=>{let d='';req.on('data',c=>{d+=c;if(d.length>30e6)req.destroy()});req.on('end',()=>r(d))})}
function auth(req){const h=req.headers.authorization||'';const t=h.replace(/^Bearer\s+/i,'');const e=TOKENS.get(t);if(!e||Date.now()>e)return null;return t}
/* ---------- Fase C: auxiliares ---------- */
const RL=new Map();
function rlOk(ip){const now=Date.now();const a=(RL.get(ip)||[]).filter(t=>now-t<3600e3);RL.set(ip,a);if(a.length>=8)return false;a.push(now);return true}
const CHAVE_INTIMA=/^(precoCusto|precoVenda|stock|stockMin|senhaHash|pinHash)$/;
function limpar(x){if(Array.isArray(x))return x.map(limpar);if(x&&typeof x==='object'){const o={};for(const k in x){if(CHAVE_INTIMA.test(k))continue;o[k]=limpar(x[k])}return o}return x}
function campo(s,min,max){s=String(s==null?'':s).trim();return s.length>=min&&s.length<=max?s:null}
async function pubAtual(){if(!pool)return PUB;const now=Date.now();if(!PUB||now-PUB_TS>60e3){PUB_TS=now;try{const p=await pool.query('SELECT revision,data FROM ems_public_catalog WHERE id=1');PUB=p.rowCount?{revision:Number(p.rows[0].revision)||1,data:p.rows[0].data}:null}catch(e){}}return PUB}
const MIME={'.html':'text/html; charset=utf-8','.png':'image/png','.svg':'image/svg+xml','.ico':'image/x-icon'};
const server=http.createServer(async(req,res)=>{
  try{
    const u=new URL(req.url,'http://x');
    if(u.pathname.startsWith('/api/public/')||u.pathname.startsWith('/api/admin/')){
      res.setHeader('Access-Control-Allow-Origin','*');
      res.setHeader('Access-Control-Allow-Methods','GET,POST,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers','content-type,authorization');
      res.setHeader('Access-Control-Max-Age','600');
      if(req.method==='OPTIONS'){res.writeHead(204);res.end();return}
    }
    if(u.pathname==='/api/health')return send(res,200,{ok:true,app:'ems',build:BUILD});
    if(req.method==='POST'&&u.pathname==='/api/auth/login'){
      const b=JSON.parse((await readBody(req))||'{}');const s=String(b.senha||'').trim();if(!s)return send(res,400,{erro:'Escreva a palavra-passe.'});
      const d=DB_CACHE.data,us=(d.config&&d.config.usuarios)||[];const refs=[sha('ems2026'),sha('EMS2026')];
      if(d.config&&d.config.senhaHash)refs.push(String(d.config.senhaHash).toLowerCase());
      us.forEach(x=>{if(x&&x.pinHash)refs.push(String(x.pinHash).toLowerCase())});
      if(refs.indexOf(sha(s))<0)return send(res,401,{erro:'PIN / palavra-passe incorreto.',build:BUILD});
      const adm=us[0]||{id:'u1',nome:'Administrador',perfil:'admin'};const tok=crypto.randomBytes(24).toString('hex');
      TOKENS.set(tok,Date.now()+TOKEN_TTL);console.error('EMS: login OK; db revision',DB_CACHE.revision);
      return send(res,200,{ok:true,token:tok,user:{id:adm.id,nome:adm.nome,perfil:adm.perfil},db:d,revision:DB_CACHE.revision});
    }
    if(u.pathname==='/api/db'){
      const t=auth(req);if(!t)return send(res,401,{erro:'Sessão expirada — entre de novo.'});
      if(req.method==='GET')return send(res,200,{revision:DB_CACHE.revision,data:DB_CACHE.data});
      if(req.method==='POST'){const b=JSON.parse((await readBody(req))||'{}');if(!b||typeof b.data!=='object')return send(res,400,{erro:'Dados inválidos.'});
        snapshotPrev();DB_CACHE.revision=Number(DB_CACHE.revision||0)+1;DB_CACHE.data=b.data;await save(DB_CACHE);
        return send(res,200,{ok:true,revision:DB_CACHE.revision})}
      return send(res,405,{erro:'Método não permitido'})
    }
    /* ---------- Fase C: público ---------- */
    if(req.method==='GET'&&u.pathname==='/api/public/catalog'){const P=await pubAtual();return send(res,200,{ok:true,publicado:!!P,revision:P?P.revision:0,catalogo:P?P.data:null,atualizado:(P&&P.data&&P.data.atualizado)?P.data.atualizado:null})}
    if(req.method==='POST'&&u.pathname==='/api/public/quote'){
      if(!rlOk(req.socket.remoteAddress||'?'))return send(res,429,{erro:'Muitos pedidos a partir deste endereço. Tente dentro de uma hora.'});
      const raw=await readBody(req);if(raw.length>100e3)return send(res,413,{erro:'Pedido demasiado grande.'});
      let b;try{b=JSON.parse(raw||'{}')}catch(e){return send(res,400,{erro:'Pedido inválido.'})}
      if(b.site)return send(res,400,{erro:'Pedido rejeitado.'});
      const nome=campo(b.nome,2,120),tel=campo(b.telefone,5,40),email=campo(b.email,5,120);
      if(!nome||(!tel&&!email))return send(res,400,{erro:'Indique o nome e um contacto (telefone ou email).'});
      if(String(b.desc||'').trim().length>2000)return send(res,400,{erro:'Descrição demasiado longa (máx. 2000 caracteres).'});
      const d={origem:'portal',refLocal:String(b.refLocal||'').slice(0,30),nome,telefone:tel||'',email:email||'',empresa:campo(b.empresa,0,120)||'',tipo:campo(b.tipo,0,60)||'',produto:campo(b.produto,0,120)||'',servico:campo(b.servico,0,120)||'',produtoNome:campo(b.produtoNome,0,160)||'',servicoNome:campo(b.servicoNome,0,160)||'',qtd:campo(b.qtd,0,20)||'',local:campo(b.local,0,120)||'',prazo:campo(b.prazo,0,60)||'',desc:String(b.desc||'').trim().slice(0,2000),quando:new Date().toISOString()};
      let ref;
      if(pool){const r=await pool.query('INSERT INTO ems_public_quotes(data) VALUES($1::jsonb) RETURNING id',[JSON.stringify(d)]);const id=Number(r.rows[0].id);ref='WEB-'+new Date().getFullYear()+'-'+String(id).padStart(4,'0');d.ref=ref;await pool.query('UPDATE ems_public_quotes SET data=$1::jsonb WHERE id=$2',[JSON.stringify(d),id])}
      else{const id=PUBF.cotacoes.length+1;ref='WEB-'+new Date().getFullYear()+'-'+String(id).padStart(4,'0');d.ref=ref;PUBF.cotacoes.push(d);savePubF()}
      console.error('EMS: cotação portal recebida',ref);
      return send(res,200,{ok:true,ref})
    }
    /* ---------- Fase C: administração (token) ---------- */
    if(req.method==='POST'&&u.pathname==='/api/admin/catalog/publish'){
      const t=auth(req);if(!t)return send(res,401,{erro:'Sessão expirada — entre de novo.'});
      let b;try{b=JSON.parse((await readBody(req))||'{}')}catch(e){return send(res,400,{erro:'JSON inválido.'})}
      const cat=limpar(b&&b.catalogo?b.catalogo:b);
      if(!cat||!Array.isArray(cat.produtos))return send(res,400,{erro:'Catálogo inválido — falta a lista de produtos.'});
      const revision=(PUB?Number(PUB.revision)||0:0)+1;PUB={revision,data:cat};PUB_TS=Date.now();
      if(pool)await pool.query('INSERT INTO ems_public_catalog(id,revision,data,updated_at) VALUES(1,$1,$2::jsonb,NOW()) ON CONFLICT(id) DO UPDATE SET revision=EXCLUDED.revision,data=EXCLUDED.data,updated_at=NOW()',[revision,JSON.stringify(cat)]);
      else{PUBF.catalogo=cat;savePubF()}
      console.error('EMS: catálogo publicado (revisão '+revision+')');
      return send(res,200,{ok:true,revision,publicado:true})
    }
    if(req.method==='GET'&&u.pathname==='/api/admin/catalog'){const t=auth(req);if(!t)return send(res,401,{erro:'Sessão expirada — entre de novo.'});const P=await pubAtual();return send(res,200,{ok:true,publicado:!!P,revision:P?P.revision:0,catalogo:P?P.data:null})}
    if(req.method==='DELETE'&&u.pathname==='/api/admin/catalog'){const t=auth(req);if(!t)return send(res,401,{erro:'Sessão expirada — entre de novo.'});PUB=null;PUB_TS=Date.now();if(pool)await pool.query('DELETE FROM ems_public_catalog WHERE id=1');else{PUBF.catalogo=null;savePubF()}return send(res,200,{ok:true,publicado:false})}
    if(req.method==='GET'&&u.pathname==='/api/admin/quotes'){
      const t=auth(req);if(!t)return send(res,401,{erro:'Sessão expirada — entre de novo.'});
      let cot=[];
      if(pool){const r=await pool.query("SELECT id,data,processado,to_char(created_at,'YYYY-MM-DD HH24:MI') AS quando FROM ems_public_quotes ORDER BY id DESC LIMIT 500");cot=r.rows.map(x=>({id:Number(x.id),data:x.data,processado:!!x.processado,quando:x.quando}))}
      else{cot=PUBF.cotacoes.slice().reverse().map((c,i)=>({id:i+1,data:c,processado:!!c.processado,quando:c.quando||''}))}
      return send(res,200,{ok:true,cotacoes:cot,total:cot.length})
    }
    if(req.method==='POST'&&u.pathname==='/api/admin/quotes/estado'){
      const t=auth(req);if(!t)return send(res,401,{erro:'Sessão expirada — entre de novo.'});
      let b;try{b=JSON.parse((await readBody(req))||'{}')}catch(e){return send(res,400,{erro:'JSON inválido.'})}
      const id=Number(b.id),st=!!b.processado;
      if(pool){if(!id)return send(res,400,{erro:'Id inválido.'});await pool.query('UPDATE ems_public_quotes SET processado=$1 WHERE id=$2',[st,id])}
      else{const c=PUBF.cotacoes.find(x=>String(x.ref)===String(b.ref));if(!c)return send(res,404,{erro:'Cotação não encontrada.'});c.processado=st;savePubF()}
      return send(res,200,{ok:true})
    }
    if(u.pathname==='/'||u.pathname==='/comercial.html'||u.pathname==='/index.html'){const cand=[path.join(__dirname,'index.html'),path.join(__dirname,'comercial.html'),path.join(ROOT,'comercial.html'),path.join(ROOT,'index.html')];const f=cand.find(function(x){return fs.existsSync(x);});if(f)return send(res,200,fs.readFileSync(f,'utf8'),'text/html; charset=utf-8');return send(res,404,'comercial.html não encontrado','text/plain')}
    if(u.pathname==='/health')return send(res,200,{status:'ok'});
    return send(res,404,{erro:'Não encontrado'})
  }catch(e){console.error('EMS server erro:',e.message);return send(res,500,{erro:'Erro interno'})}
});
(async()=>{await initPersistence();await applyReset();server.listen(PORT,HOST,()=>console.error('EMS servidor central ('+(pool?'PostgreSQL':'ficheiro local')+') a escutar em '+HOST+':'+PORT+' ['+BUILD+']'))})();
