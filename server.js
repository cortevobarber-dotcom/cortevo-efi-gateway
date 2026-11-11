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

    if (API_KEY && req.headers["x-api-key"] !== API_KEY) return json(res, 401, { error: "não autorizado" });

    const url = new URL(req.url, "http://localhost");

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
      if (r.status >= 300) return json(res, r.status, r.body);
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
