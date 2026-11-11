# cortevo-efi-gateway

Gateway mTLS para a API Cobranças do Efí, usado pelo CORTÉVO BARBER para cartão de crédito e assinatura recorrente da mensalidade.

## Rotas
- GET /health
- POST /cartao  { amount_cents, installments, payment_token, customer:{name,email,cpf,phone}, description, external_id }
- POST /assinatura { amount_cents, plan_name, interval, repeats, payment_token, customer:{...} }
- GET /assinatura/{id}
- PUT /assinatura/cancelar { subscription_id }
- POST /boleto, POST /boleto/cancelar, POST /pix (legado)
- GET /config (devolve payee_code para a tokenização no navegador)

Todas exigem o header `x-api-key` quando GATEWAY_API_KEY está definido.

## Deploy no Render
1. Suba esta pasta em um repositório no GitHub.
2. No Render: New > Web Service > conecte o repositório > runtime Node > plano Free.
3. Variáveis: copie de render.yaml e preencha:
   - EFI_CLIENT_ID e EFI_CLIENT_SECRET da aplicação "Cortevo Boletos"
   - EFI_CERT_B64 e EFI_KEY_B64 em base64 do .crt e .key (openssl base64 -w0)
   - GATEWAY_API_KEY gerada pelo Render ou escolhida por você
   - EFI_PAYEE_CODE com o identificador de pagamento do painel Efí
4. Health check em /health deve responder {"ok":true,"env":"prod"}.
