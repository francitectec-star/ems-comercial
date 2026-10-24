# EMS Comercial — Electro-Moz-Solar E.I.

Sistema de gestão comercial (cotações, facturas, stock, caixa). Ficheiro único: `index.html`.

Este repositório existe para o EMS ter **domínio próprio no Render** (com as iniciais EMS),
separado do domínio do sistema escolar (spi-francitec).

## Criar o serviço no Render (1 vez, ~2 minutos)
1. Entrar em https://dashboard.render.com → **New +** → **Static Site**
2. Ligar o repositório GitHub `francitectec-star/ems-comercial`
3. **Name:** `ems-comercial` (ou outro com iniciais EMS — o nome define o URL: `https://<name>.onrender.com`)
4. **Build Command:** deixar vazio · **Publish Directory:** `.` (ponto)
5. **Create Static Site** — fica online em ~1 minuto

## Atualizações futuras
`index.html` aqui é cópia exata de `comercial.html` do repositório `spi-francitec`:
copiar o ficheiro mais recente para `index.html`, commit e push — o Render republica sozinho.
