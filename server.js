import https from "node:https";
import http from "node:http";
import fs from "node:fs";

const ENVS = {
  prod: { base: "https://cobrancas.api.efipay.com.br", pix: "https://pix.api.efipay.com.br" },
  hml: { base: "https://cobrancas-h.api.efipay.com.br", pix: "https://pix-h.api.efipay.com.br" },
};
const ENV = process.env.EFI_ENV === "prod" ? "prod" : "hml";
const API_KEY = "cortevo-gw-2026-cartao";
const PORT = Number(process.env.PORT || 8080);
let ULTIMA = {};

function creds() {
  return {
    id: process.env.EFI_CLIENT_ID || "",
    secret: process.env.EFI_CLIENT_SECRET || "",
  };
}

function certs() {
  const crtPath = process.env.EFI_CERT_PATH;
  const keyPath = process.env.EFI_KEY_PATH;
  if (crtPath && keyPath && fs.existsSync(crtPath) && fs.existsSync(keyPath)) {
    return { cert: fs.readFileSync(crtPath), key: fs.readFileSync(keyPath) };
  }
  const cert = Buffer.from(process.env.EFI_CERT_B64 || "", "base64").toString("utf8");
  const key = Buffer.from(process.env.EFI_KEY_B64 || "", "base64").toString("utf8");
  if (!cert || !key) throw new Error("certificado ausente: defina EFI_CERT_PATH/EFI_KEY_PATH ou EFI_CERT_B64/EFI_KEY_B64");
  return { cert, key };
}

function request(url, { method = "GET", headers = {}, body } = {}) {
  const tls = certs();
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method,
        cert: tls.cert,
        key: tls.key,
        headers: { "Content-Type": "application/json", "User-Agent": "CortevoGateway/1.0", ...headers },
        timeout: 40000,
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let parsed = data;
          try { parsed = JSON.parse(data); } catch { /* texto puro */ }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("timeout na chamada ao Efí")));
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function token(kind = "boleto") {
  const { id, secret } = creds();
  if (!id || !secret) throw new Error("credenciais ausentes: defina EFI_CLIENT_ID e EFI_CLIENT_SECRET");
  const base = kind === "pix" ? ENVS[ENV].pix : ENVS[ENV].base;
  const auth = Buffer.from(`${id}:${secret}`).toString("base64");
  const r = await request(`${base}/v1/authorize`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}` },
    body: { grant_type: "client_credentials" },
  });
  if (r.status !== 200 || !r.body?.access_token) {
    throw new Error(`falha no OAuth do Efí (${r.status}): ${JSON.stringify(r.body).slice(0, 200)}`);
  }
  return r.body.access_token;
}

function json(res, status, payload) {
  const data = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(data) });
  res.end(data);
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 1e6) reject(new Error("payload muito grande"));
    });
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error("json inválido")); }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === "/health") return json(res, 200, { ok: true, env: ENV });

    const url = new URL(req.url, "http://localhost");
    const publico = req.method === "GET" && (url.pathname === "/diag" || url.pathname === "/diag-token" || url.pathname === "/diag" || url.pathname === "/diag-token" || url.pathname === "/pagamento" || url.pathname === "/health");
    if (!publico && API_KEY && req.headers["x-api-key"] !== API_KEY) return json(res, 401, { error: "não autorizado" });

    if (req.method === "POST" && url.pathname === "/boleto") {
      const b = await readBody(req);
      if (!b.amount_cents || !b.customer?.cpf) return json(res, 400, { error: "amount_cents e customer.cpf são obrigatórios" });
      const tk = await token("boleto");
      const body = {
        items: [{ name: (b.description || "Taxa da plataforma Cortevo").slice(0, 100), value: Number(b.amount_cents), amount: 1 }],
        payment: {
          banking_billet: {
            expire_at: b.expire_at,
            customer: {
              name: b.customer.name,
              email: b.customer.email,
              cpf: String(b.customer.cpf).replace(/\D/g, ""),
              phone_number: String(b.customer.phone || "").replace(/\D/g, ""),
            },
            ...(b.message ? { message: String(b.message).slice(0, 200) } : {}),
          },
        },
        ...(b.external_id ? { metadata: { custom_id: String(b.external_id).slice(0, 60) } } : {}),
      };
      const r = await request(`${ENVS[ENV].base}/v1/charge/one-step`, {
        method: "POST",
        headers: { Authorization: `Bearer ${tk}` },
        body,
      });
      ULTIMA = {
        at: new Date().toISOString(),
        env: ENV,
        origem: temToken ? "payment_token" : "cartao_cru",
        token_tamanho: temToken ? String(b.payment_token).length : 0,
        token_inicio: temToken ? String(b.payment_token).slice(0, 6) : "",
        valor: Number(b.amount_cents),
        efi_status: r.status,
        efi_resposta: r.body,
      };
      if (r.status >= 300) {
        const extra = r.body?.code === 3500010 ? { dica: "token do cartão não reconhecido pelo Efí" } : {};
        return json(res, r.status, { ...r.body, ...extra });
      }
      const d = r.body.data || {};
      return json(res, 200, {
        charge_id: d.charge_id,
        status: d.status,
        barcode: d.barcode,
        total_cents: d.total,
        expire_at: d.expire_at,
        pdf_url: d.pdf?.charge,
        link: d.link,
        billet_link: d.billet_link,
        env: ENV,
      });
    }

    if (req.method === "POST" && url.pathname === "/boleto/cancelar") {
      const b = await readBody(req);
      if (!b.charge_id) return json(res, 400, { error: "charge_id é obrigatório" });
      const tk = await token("boleto");
      const r = await request(`${ENVS[ENV].base}/v1/charge/${b.charge_id}/cancel`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${tk}`, "Content-Type": "application/json" },
        body: {},
      });
      return json(res, r.status, r.body);
    }

    if (req.method === "POST" && url.pathname === "/pix") {
      const b = await readBody(req);
      if (!b.txid || !b.amount_cents || !process.env.EFI_PIX_KEY) {
        return json(res, 400, { error: "txid, amount_cents e EFI_PIX_KEY são obrigatórios" });
      }
      const tk = await token("pix");
      const body = { calendario: { expiracao: b.expiracao || 3600 }, valor: { original: (b.amount_cents / 100).toFixed(2) } };
      if (b.devedor?.cpf) body.devedor = { nome: b.devedor.nome, cpf: String(b.devedor.cpf).replace(/\D/g, "") };
      if (b.descricao) body.solicitacaoPagador = String(b.descricao).slice(0, 140);
      const r = await request(`${ENVS[ENV].pix}/v2/cob/${encodeURIComponent(String(b.txid).slice(0, 35))}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${tk}` },
        body,
      });
      return json(res, r.status, r.body);
    }


    if (req.method === "GET" && url.pathname === "/ultimo") {
      return json(res, 200, ULTIMA);
    }

    if (req.method === "GET" && url.pathname === "/diag-token") {
      const page = `<!doctype html><html><head><meta charset="utf-8"><title>diag token</title></head><body style="font-family:monospace;padding:16px">
<pre id="o">rodando...</pre>
<script src="https://cdn.jsdelivr.net/npm/payment-token-efi@3.5.0/dist/payment-token-efi-umd.min.js"></script>
<script>
const o=document.getElementById('o');
const log=(k,v)=>{o.textContent+="\\n"+k+": "+(typeof v==="string"?v:JSON.stringify(v));};
(async()=>{
  try{
    const cfg=await fetch('/config',{headers:{'x-api-key':'cortevo-gw-2026-cartao'}}).then(r=>r.json());
    const tk=await window.EfiPay.CreditCard.setAccount(cfg.payee_code).setEnvironment('production')
      .setCreditCardData({brand:'visa',number:'4111111111111111',cvv:'123',expirationMonth:'12',expirationYear:'2030',holderName:'TESTE DIAG',holderDocument:'12345678909',reuse:false})
      .getPaymentToken();
    log('TOKEN',(tk&&(tk.payment_token||tk.paymentToken))||'');
  }catch(e){log('ERRO',e&&(e.message||JSON.stringify(e)));}
})();
</script></body></html>`;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(page);
      return;
    }

    if (req.method === "GET" && url.pathname === "/pagamento") {
      const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cortévo - teste de cartão</title>
<style>
:root{--azul:#1d4ed8;--tinta:#0f172a;--cinza:#64748b;--linha:#e2e8f0}
*{box-sizing:border-box}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f8fafc;color:var(--tinta);padding:20px}
.card{max-width:440px;margin:0 auto;background:#fff;border:1px solid var(--linha);border-radius:16px;padding:22px}
h1{font-size:19px;margin:0 0 4px}p.sub{color:var(--cinza);font-size:13px;margin:0 0 18px}
label{display:block;font-size:12px;color:var(--cinza);margin:12px 0 5px}
input{width:100%;padding:12px;border:1px solid var(--linha);border-radius:10px;font-size:15px}
.row{display:flex;gap:10px}.row>div{flex:1}
button{width:100%;margin-top:18px;padding:14px;border:0;border-radius:10px;background:var(--azul);color:#fff;font-size:15px;font-weight:600}
button:disabled{opacity:.6}
#out{margin-top:16px;font-size:13px;line-height:1.5;white-space:pre-wrap}
.ok{color:#047857}.err{color:#b91c1c}
</style></head><body>
<div class="card">
  <h1>Teste de cartão - Cortévo</h1>
  <p class="sub">Cobrança real de R$ 5,00 na conta Efí do Cortévo. Estorno na hora pelo botão.</p>
  <label>Número do cartão</label><input id="num" inputmode="numeric" placeholder="0000 0000 0000 0000">
  <label>Nome impresso no cartão</label><input id="nome" placeholder="COMO ESTÁ NO CARTÃO">
  <div class="row">
    <div><label>Validade</label><input id="val" placeholder="MM/AA" inputmode="numeric"></div>
    <div><label>CVV</label><input id="cvv" placeholder="123" inputmode="numeric"></div>
  </div>
  <label>CPF do titular</label><input id="cpf" inputmode="numeric" placeholder="000.000.000-00">
  <button id="bt">Pagar R$ 5,00</button>
  <div id="out"></div>
</div>
<script src="https://cdn.jsdelivr.net/npm/payment-token-efi@3.5.0/dist/payment-token-efi-umd.min.js"></script>
<script>
const KEY="cortevo-gw-2026-cartao";
const out=document.getElementById("out"), bt=document.getElementById("bt");
let cfg=null, ultimo=null;
const say=(msg,cls)=>{out.className=cls||"";out.textContent=msg;};
const so=(v)=>String(v||"").replace(/\\D/g,"");
(async()=>{ try{ cfg=await fetch("/config",{headers:{"x-api-key":KEY}}).then(r=>r.json()); }catch(e){ say("Não consegui carregar a configuração.","err"); } })();
bt.onclick=async()=>{
  const num=so(document.getElementById("num").value), nome=document.getElementById("nome").value.trim().toUpperCase();
  const val=document.getElementById("val").value.trim().replace(/[^0-9]/g,""), cvv=so(document.getElementById("cvv").value), cpf=so(document.getElementById("cpf").value);
  if(num.length<13||!nome||val.length<4||cvv.length<3||cpf.length<11){ say("Confira os dados do cartão: número, nome, validade, CVV e CPF.","err"); return; }
  if(!cfg||!cfg.payee_code){ say("Pagamento indisponível: falta o identificador de conta.","err"); return; }
  bt.disabled=true; say("Validando cartão...");
  try{
    const brand=await window.EfiPay.CreditCard.setCardNumber(num).verifyCardBrand();
    const tk=await window.EfiPay.CreditCard.setAccount(cfg.payee_code).setEnvironment(cfg.environment||"production")
      .setCreditCardData({brand:brand,number:num,cvv:cvv,expirationMonth:val.slice(0,2),expirationYear:"20"+val.slice(2,4),holderName:nome,holderDocument:cpf,reuse:false})
      .getPaymentToken();
    const token=(tk&&(tk.payment_token||tk.paymentToken))||"";
    if(!token){ say("O Efí não devolveu o token do cartão. Confira os dados e tente de novo.","err"); bt.disabled=false; return; }
    say("Autorizando com o banco...");
    const r=await fetch("/cartao",{method:"POST",headers:{"Content-Type":"application/json","x-api-key":KEY},body:JSON.stringify({
      amount_cents:500, installments:1, description:"Teste de cartão Cortévo",
      payment_token:token,
      customer:{name:"MARCOS VINICIUS BATISTA MENDES",email:"info.markesevolution@gmail.com",cpf:cpf,phone:"31990896794"}
    })});
    const d=await r.json().catch(()=>({error:"resposta inválida"}));
    if(r.ok&&d.charge_id){
      ultimo=d.charge_id;
      say("APROVADO\\nCobrança: "+d.charge_id+"\\nCartão: "+(d.card_brand||"")+" •••• "+(d.card_mask||"").slice(-4)+"\\nValor: R$ 5,00");
      out.className="ok";
      bt.textContent="Estornar os R$ 5,00";
      bt.disabled=false;
      bt.onclick=estornar;
    }else{
      const code=d.code||d.error_code||"";
      let msg="Não autorizado pelo banco.";
      if(code===4600036) msg="Valor abaixo do mínimo do Efí (R$ 3,00).";
      else if(code===3500010) msg="Token do cartão recusado. Recarregue a página e tente de novo.";
      else if(code===3500052) msg="Cartão sem limite ou bloqueado pelo banco.";
      else if(String(d.error_description||"").length) msg=d.error_description;
      else if(String(d.error||"").length) msg=d.error;
      else if(String(d.message||"").length) msg=d.message;
      say("RECUSADO ("+code+")\\n"+msg,"err");
      bt.disabled=false;
    }
  }catch(e){
    say("Erro: "+(e&&(e.message||JSON.stringify(e))||"desconhecido"),"err");
    bt.disabled=false;
  }
};
async function estornar(){
  if(!ultimo) return;
  bt.disabled=true; say("Estornando...");
  try{
    const r=await fetch("/estornar",{method:"POST",headers:{"Content-Type":"application/json","x-api-key":KEY},body:JSON.stringify({charge_id:ultimo})});
    const d=await r.json().catch(()=>({}));
    if(r.ok) say("ESTORNADO\\nCobrança "+ultimo+" estornada. O valor volta para o cartão em até 2 faturas."), out.className="ok";
    else say("Não consegui estornar: "+(d.error_description||d.error||d.message||"erro"),"err");
  }catch(e){ say("Não consegui estornar: "+(e&&e.message||"erro"),"err"); }
  bt.textContent="Estornar novamente"; bt.disabled=false;
}
</script></body></html>`;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    if (req.method === "GET" && url.pathname === "/diag") {
      const page = `<!doctype html><html><head><meta charset="utf-8"><title>diag cartao</title></head><body style="font-family:monospace;padding:16px">
<pre id="o">rodando...</pre>
<script src="https://cdn.jsdelivr.net/npm/payment-token-efi@3.5.0/dist/payment-token-efi-umd.min.js"></script>
<script>
const o=document.getElementById('o');
const log=(k,v)=>{o.textContent+="\\n"+k+": "+(typeof v==="string"?v:JSON.stringify(v));};
(async()=>{
  try{
    const cfg=await fetch('/config',{headers:{'x-api-key':'cortevo-gw-2026-cartao'}}).then(r=>r.json());
    log('payee',cfg.payee_code);log('env',cfg.env);
    const tk=await window.EfiPay.CreditCard.setAccount(cfg.payee_code).setEnvironment('production')
      .setCreditCardData({brand:'visa',number:'4111111111111111',cvv:'123',expirationMonth:'12',expirationYear:'2030',holderName:'TESTE DIAG',holderDocument:'12345678909',reuse:false})
      .getPaymentToken();
    log('token_res',tk);
    const t=tk&&(tk.payment_token||tk.paymentToken);
    log('token_len',t?t.length:0);
    const r=await fetch('/cartao',{method:'POST',headers:{'content-type':'application/json','x-api-key':'cortevo-gw-2026-cartao'},
      body:JSON.stringify({amount_cents:100,description:'diag',installments:1,payment_token:t,
        customer:{name:'TESTE DIAG',email:'cortevobarber@gmail.com',cpf:'12345678909',phone:'31999999999'}})});
    log('cartao_status',r.status);log('cartao_body',await r.text());
  }catch(e){log('ERRO',e&&(e.message||JSON.stringify(e)));}
})();
</script></body></html>`;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(page);
      return;
    }

    if (req.method === "GET" && url.pathname === "/config") {
      return json(res, 200, {
        env: ENV,
        payee_code: process.env.EFI_PAYEE_CODE || "430f73ecf4c01a337f63663bbff58a5a",
        js: "https://cdn.jsdelivr.net/npm/payment-token-efi@3.5.0/dist/payment-token-efi-umd.min.js",
      });
    }

    if (req.method === "POST" && url.pathname === "/cartao") {
      const b = await readBody(req);
      const temToken = !!b.payment_token;
      const temCartao = !!b.card?.number;
      if (!b.amount_cents || (!temToken && !temCartao) || !b.customer?.cpf) {
        return json(res, 400, { error: "amount_cents, customer.cpf e payment_token ou card{number,holder,exp_month,exp_year,cvv} são obrigatórios" });
      }
      const tk = await token("boleto");
      const cartaoToken = temToken
        ? { payment_token: String(b.payment_token) }
        : {
            card_number: String(b.card.number).replace(/\D/g, ""),
            holder_name: String(b.card.holder || b.customer.name || ""),
            expiration_month: Number(b.card.exp_month),
            expiration_year: Number(String(b.card.exp_year).length === 2 ? "20" + b.card.exp_year : b.card.exp_year),
            cvv: String(b.card.cvv || "").replace(/\D/g, ""),
          };
      const body = {
        items: [{ name: (b.description || "Mensalidade Cortevo").slice(0, 100), value: Number(b.amount_cents), amount: 1 }],
        payment: {
          credit_card: {
            installments: Math.min(Math.max(Number(b.installments || 1), 1), 12),
            ...cartaoToken,
            customer: {
              name: b.customer.name,
              email: b.customer.email,
              cpf: String(b.customer.cpf).replace(/\D/g, ""),
              phone_number: String(b.customer.phone || "").replace(/\D/g, ""),
            },
            ...(b.message ? { message: String(b.message).slice(0, 200) } : {}),
          },
        },
        ...(b.external_id ? { metadata: { custom_id: String(b.external_id).slice(0, 60) } } : {}),
      };
      const r = await request(`${ENVS[ENV].base}/v1/charge/one-step`, {
        method: "POST",
        headers: { Authorization: `Bearer ${tk}` },
        body,
      });
      if (r.status >= 300) return json(res, r.status, r.body);
      const d = r.body.data || {};
      return json(res, 200, {
        charge_id: d.charge_id,
        status: d.status,
        total_cents: d.total,
        installments: d.installments,
        card_mask: d.payment?.credit_card?.mask,
        card_brand: d.payment?.credit_card?.brand,
        env: ENV,
      });
    }

    if (req.method === "POST" && url.pathname === "/diag-cartao") {
      const b = await readBody(req);
      const tk = await token("boleto");
      const cust = { name: "Marcos Vinicius Teste", email: "cortevobarber@gmail.com", cpf: "12345678909", phone_number: "31999999999" };
      const items = [{ name: "Teste", value: 100, amount: 1 }];
      const tok = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      const tentativas = {
        one_step_token: { url: "/v1/charge/one-step", body: { items, payment: { credit_card: { installments: 1, payment_token: tok, customer: cust } } } },
        one_step_camel: { url: "/v1/charge/one-step", body: { items, payment: { credit_card: { installments: 1, paymentToken: tok, customer: cust } } } },
        one_step_raiz: { url: "/v1/charge/one-step", body: { items, payment_token: tok, payment: { credit_card: { installments: 1, customer: cust } } } },
        charge_direto: { url: "/v1/charge", body: { items, payment: { credit_card: { installments: 1, payment_token: tok, customer: cust } } } },
      };
      const out = {};
      for (const [k, v] of Object.entries(tentativas)) {
        const r = await request(`${ENVS[ENV].base}${v.url}`, { method: "POST", headers: { Authorization: `Bearer ${tk}` }, body: v.body });
        out[k] = { status: r.status, body: r.body };
        if (r.status < 300 && r.body?.data?.charge_id) {
          const pay = await request(`${ENVS[ENV].base}/v1/charge/${r.body.data.charge_id}/pay`, { method: "POST", headers: { Authorization: `Bearer ${tk}` }, body: { payment: { credit_card: { payment_token: tok } } } });
          out[k].pay = { status: pay.status, body: pay.body };
          break;
        }
      }
      return json(res, 200, { env: ENV, out });
    }

    if (req.method === "POST" && url.pathname === "/estorno") {
      const b = await readBody(req);
      if (!b.charge_id) return json(res, 400, { error: "charge_id é obrigatório" });
      const tk = await token("boleto");
      const r = await request(`${ENVS[ENV].base}/v1/charge/${encodeURIComponent(b.charge_id)}/refund`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${tk}` },
        body: {},
      });
      if (r.status >= 300) return json(res, r.status, r.body);
      return json(res, 200, { ok: true, charge_id: b.charge_id, status: r.body?.data?.status, env: ENV });
    }

    if (req.method === "POST" && url.pathname === "/assinatura") {
      const b = await readBody(req);
      if (!b.amount_cents || !b.payment_token || !b.customer?.cpf) {
        return json(res, 400, { error: "amount_cents, payment_token e customer.cpf são obrigatórios" });
      }
      const tk = await token("boleto");
      const planBody = {
        name: (b.plan_name || "Mensalidade Cortevo").slice(0, 80),
        interval: Number(b.interval || 1),
        repeats: Number(b.repeats || 12),
      };
      const plan = await request(`${ENVS[ENV].base}/v1/plan`, {
        method: "POST",
        headers: { Authorization: `Bearer ${tk}` },
        body: planBody,
      });
      if (plan.status >= 300) return json(res, plan.status, plan.body);
      const planId = plan.body?.data?.plan_id;
      if (!planId) return json(res, 502, { error: "plano sem plan_id", resposta: plan.body });
      const subBody = {
        items: [{ name: planBody.name, value: Number(b.amount_cents), amount: 1 }],
        payment: {
          credit_card: {
            customer: {
              name: b.customer.name,
              email: b.customer.email,
              cpf: String(b.customer.cpf).replace(/\D/g, ""),
              phone_number: String(b.customer.phone || "").replace(/\D/g, ""),
            },
            payment_token: String(b.payment_token),
            billing_cycle: { interval: planBody.interval, repeats: planBody.repeats },
          },
        },
      };
      const sub = await request(`${ENVS[ENV].base}/v1/subscription/${planId}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${tk}` },
        body: subBody,
      });
      if (sub.status >= 300) return json(res, sub.status, sub.body);
      return json(res, 200, { plan_id: planId, subscription_id: sub.body?.data?.subscription_id, status: sub.body?.data?.status, env: ENV });
    }

    if (req.method === "GET" && url.pathname.startsWith("/assinatura/")) {
      const id = url.pathname.split("/")[2];
      const tk = await token("boleto");
      const r = await request(`${ENVS[ENV].base}/v1/subscription/${encodeURIComponent(id)}`, {
        headers: { Authorization: `Bearer ${tk}` },
      });
      return json(res, r.status, r.body);
    }

    if (req.method === "PUT" && url.pathname === "/assinatura/cancelar") {
      const b = await readBody(req);
      if (!b.subscription_id) return json(res, 400, { error: "subscription_id é obrigatório" });
      const tk = await token("boleto");
      const r = await request(`${ENVS[ENV].base}/v1/subscription/${encodeURIComponent(b.subscription_id)}/cancel`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${tk}` },
        body: {},
      });
      return json(res, r.status, r.body);
    }

    return json(res, 404, { error: "rota não encontrada" });
  } catch (e) {
    return json(res, 500, { error: String(e?.message || e) });
  }
});

server.listen(PORT, () => console.log(`efi-gateway ouvindo em :${PORT} (env ${ENV})`));
