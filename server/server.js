/* EMS Comercial — Servidor central (Etapa 7)
   Estado unico em PostgreSQL (tabelas ems_state / ems_state_hist / ems_audit),
   mesmo banco do SPI, tabelas separadas. Sem DATABASE_URL funciona em modo
   ficheiro local (testes/uso individual). Serve o comercial.html do repositorio. */
const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const ROOT=path.join(__dirname,'..'),PORT=Number(process.env.PORT||3000),HOST=process.env.HOST||'0.0.0.0';
const BUILD='etapa7-v1';
const DBFILE=process.env.EMS_DATA_FILE||path.join(__dirname,'ems-server-data.json');
const {Pool}=require('pg');
const DATABASE_URL=process.env.DATABASE_URL||'';
const pool=DATABASE_URL?new Pool({connectionString:DATABASE_URL,ssl:{rejectUnauthorized:false},max:5}):null;
let DB_CACHE=null,writeQueue=Promise.resolve();
const TOKENS=new Map(),TOKEN_TTL=12*3600*1000;
function sha(p){return crypto.createHash('sha256').update(String(p)).digest('hex')}
function seed(){return {revision:1,data:{v:1,config:{loja:'Electro-Moz-Solar E.I.',nuit:'',contactos:'',endereco:'',proxFac:1,proxCot:1,proxServ:1,ivaPct:16,aplicarIva:false,senhaHash:null},produtos:[],fornecedores:[],clientes:[],compras:[],vendas:[],cotacoes:[],servicos:[],despesas:[],caixa:[],fechosCaixa:[],encomendas:[],anuladas:[],usuarios:[{id:'u1',nome:'Administrador',perfil:'admin',pinHash:null,ativo:true}],audit:[],movimentos:[],catServicos:[]}}}
function queueDbWrite(d){if(!pool)return;const snap=JSON.stringify(d);writeQueue=writeQueue.then(()=>pool.query('INSERT INTO ems_state(id,revision,data,updated_at) VALUES(1,$1,$2::jsonb,NOW()) ON CONFLICT(id) DO UPDATE SET revision=EXCLUDED.revision,data=EXCLUDED.data,updated_at=NOW()',[Number(d.revision)||0,snap]));writeQueue=writeQueue.catch(e=>console.error('Falha ao gravar PostgreSQL:',e.message))}
function save(d){DB_CACHE=d;if(!pool){const tmp=DBFILE+'.tmp';fs.writeFileSync(tmp,JSON.stringify(d,null,2),'utf8');fs.renameSync(tmp,DBFILE);return}queueDbWrite(d)}
function snapshotPrev(){if(!pool||!DB_CACHE)return;const prev=JSON.stringify(DB_CACHE);writeQueue=writeQueue.then(()=>pool.query('INSERT INTO ems_state_hist(data,created_at) VALUES($1::jsonb,NOW())',[prev]).catch(e=>console.error('Snapshot falhou:',e.message)));writeQueue=writeQueue.then(()=>pool.query('DELETE FROM ems_state_hist WHERE id NOT IN (SELECT id FROM ems_state_hist ORDER BY id DESC LIMIT 100)').catch(()=>{}))}
async function initPersistence(){if(!pool){DB_CACHE=fs.existsSync(DBFILE)?JSON.parse(fs.readFileSync(DBFILE,'utf8')):seed();return}
  await pool.query('CREATE TABLE IF NOT EXISTS ems_state(id INTEGER PRIMARY KEY,revision INTEGER NOT NULL,data JSONB NOT NULL,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
  await pool.query('CREATE TABLE IF NOT EXISTS ems_state_hist(id BIGSERIAL PRIMARY KEY,data JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
  await pool.query('CREATE TABLE IF NOT EXISTS ems_audit(id BIGSERIAL PRIMARY KEY,data JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
  const r=await pool.query('SELECT revision,data FROM ems_state WHERE id=1');
  if(r.rowCount){DB_CACHE={revision:Number(r.rows[0].revision)||1,data:r.rows[0].data}}else{DB_CACHE=seed();await pool.query('INSERT INTO ems_state(id,revision,data) VALUES(1,$1,$2::jsonb)',[DB_CACHE.revision,JSON.stringify(DB_CACHE)])}}
/* Recuperacao NAO destrutiva: EMS_RESET_ADMIN redefine apenas a senha do admin */
async function applyReset(){const v=process.env.EMS_RESET_ADMIN;if(!v||!DB_CACHE)return;const us=(DB_CACHE.data.config&&DB_CACHE.data.config.usuarios)||[];const adm=us.find(x=>x.login==='admin')||us[0];if(!adm)return;const marca=(DB_CACHE.data.config.resetAdminMarca)||'';if(marca===sha(v)){console.error('EMS: EMS_RESET_ADMIN ja aplicado — nada alterado.');return}adm.pinHash=sha(v);adm.ativo=true;DB_CACHE.data.config.senhaHash=sha(v);DB_CACHE.data.config.resetAdminMarca=sha(v);await save(DB_CACHE);delete process.env.EMS_RESET_ADMIN;console.error('EMS: senha redefinida via EMS_RESET_ADMIN — DADOS MANTIDOS')}
function send(res,code,obj,type){const b=typeof obj==='string'?obj:JSON.stringify(obj);res.writeHead(code,{'Content-Type':type||'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(b)}
function readBody(req){return new Promise(r=>{let d='';req.on('data',c=>{d+=c;if(d.length>30e6)req.destroy()});req.on('end',()=>r(d))})}
function auth(req){const h=req.headers.authorization||'';const t=h.replace(/^Bearer\s+/i,'');const e=TOKENS.get(t);if(!e||Date.now()>e)return null;return t}
const MIME={'.html':'text/html; charset=utf-8','.png':'image/png','.svg':'image/svg+xml','.ico':'image/x-icon'};
const server=http.createServer(async(req,res)=>{
  try{
    const u=new URL(req.url,'http://x');
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
    if(u.pathname==='/'||u.pathname==='/comercial.html'||u.pathname==='/index.html'){const cand=[path.join(__dirname,'index.html'),path.join(__dirname,'comercial.html'),path.join(ROOT,'comercial.html'),path.join(ROOT,'index.html')];const f=cand.find(function(x){return fs.existsSync(x);});if(f)return send(res,200,fs.readFileSync(f,'utf8'),'text/html; charset=utf-8');return send(res,404,'comercial.html não encontrado','text/plain')}
    if(u.pathname==='/health')return send(res,200,{status:'ok'});
    return send(res,404,{erro:'Não encontrado'})
  }catch(e){console.error('EMS server erro:',e.message);return send(res,500,{erro:'Erro interno'})}
});
(async()=>{await initPersistence();await applyReset();server.listen(PORT,HOST,()=>console.error('EMS servidor central ('+(pool?'PostgreSQL':'ficheiro local')+') a escutar em '+HOST+':'+PORT+' ['+BUILD+']'))})();
