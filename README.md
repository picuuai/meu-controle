# Meu Controle

PWA de finanças pessoais para compras do Itaú e da CAIXA. O painel, os lançamentos e o tema ficam no armazenamento do navegador ou do app Android. Cada instalação tem uma base própria.

## PWA

Sirva a pasta dist por HTTPS ou por localhost. No Android, abra pelo Chrome e use a opção de adicionar à tela inicial. O PWA permite registrar compras, revisar alertas colados e importar faturas PDF.

Para importar uma fatura, selecione o mês de cobrança e o banco. Arraste o PDF até a área destacada ou use **Escolher PDF**. A leitura usa o texto do arquivo quando disponível e OCR em páginas digitalizadas. Todo o processamento roda no dispositivo. Revise as datas, os valores e o parcelamento antes de salvar.

## Android

Abra a pasta android no Android Studio com JDK 17, Gradle 8.9 e SDK 35. Use Run com um Android conectado ou gere o APK de depuração com gradle :app:assembleDebug. A versão Android inclui a mesma interface no aplicativo. No painel, toque em **Ativar notificações do Android**, autorize o Meu Controle na tela do sistema e volte ao painel. Alertas de compras dos pacotes configurados em CardAlerts aparecem para revisão. Ajuste o mês de cobrança ao revisar se a compra caiu na fatura seguinte.

O workflow **APK do Meu Controle** também gera um APK de teste no GitHub Actions. O APK de teste usa uma chave de depuração do ambiente de build. Para atualizar uma instalação mantendo os dados, use uma versão assinada pela mesma chave.

O acesso do sistema precisa ser habilitado pelo usuário. A lista de pacotes e os formatos de alerta são hipóteses iniciais a validar com Itaú e CAIXA em aparelho real. Para os testes de aceitação, confira uma compra à vista, uma parcelada, uma recusada, uma fatura com parcelas e a correspondência entre alerta e fatura. Faça os testes com exemplos anonimizados.

## Testes locais

Execute node --test ledger.test.mjs.
