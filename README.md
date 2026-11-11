# diag

Ferramentas de diagnóstico de hardware para PCs Windows, com um servidor web para análise das coletas e emissão de laudos técnicos.

## Componentes

| Pasta | O que é |
|---|---|
| `diag-scripts/` | Scripts de coleta (PowerShell + menu `.bat`). Só leem o sistema. |
| `diag-viewer/` | Servidor Node.js sem dependências + interface web. |
| `docs/` | Instalação com Docker/Portainer. |

### Scripts

- **`diagnostico.bat` / `diagnostico.ps1`**: diagnóstico de manutenção. Inclui:
  - saúde e SMART dos discos, memória, vídeo;
  - telas azuis e erros de hardware, dispositivos com problema;
  - serviços, impressoras, rede e conectividade;
  - ativação, antivírus, atualizações, drivers e programas.

  Testes profundos opcionais: DISM/SFC, chkdsk (só análise, ou análise com correção automática dos erros), leitura completa da superfície do disco, WinSAT, benchmark próprio (processador, memória e disco), teste de RAM, estresse do processador com temperatura e frequência, rede prolongada, verificação do Defender e relatório de energia.

  Perfis prontos, do mais básico ao mais completo (`-Perfil` ou menu de testes): `rapido`, `basico` (~12 min), `padrao` (~1 h 15), `completo` e `burnin`.

  Sensores: durante os testes, temperaturas, tensões da fonte, ventoinhas e potência são gravados a cada 5 s em `10_sensores.csv` e aparecem no site com gráfico, mínimo/média/máximo e alertas (tensão fora de ±5%, superaquecimento, ventoinha parada). O Windows sozinho só informa zona térmica ACPI, discos, GPU NVIDIA e bateria; para tensões e ventoinhas rode `baixar-sensores.ps1`, que baixa o [LibreHardwareMonitor](https://github.com/LibreHardwareMonitor/LibreHardwareMonitor) (MPL-2.0) para a pasta `sensores/`.
- **`diag-hardware.bat` / `diag-hardware.ps1`**: histórico de dispositivos (instalação, chegada e remoção), boots, eventos de PnP e logons, com cópia dos logs `.evtx` e hashes SHA-256.

Cada execução gera um `.zip` com hashes e pode enviá-lo ao servidor (`diag-servidor.cfg`).

### Servidor e interface (`diag-viewer`)

- **Coletas**: recebimento por upload com token. Análise com linha do tempo, tabelas, aba Saúde e testes profundos. Relatório imprimível com anexos.
- **Laudos de manutenção**:
  - numerados e com modelos personalizáveis;
  - histórico de revisões;
  - PDF gerado no navegador (pdfmake/pdf-lib).
- **Assinatura de laudos**:
  - digital, com o certificado instalado no Windows (A1/A3), via agente local (`web/agente/`);
  - física, com upload da via digitalizada.
- **Equipamentos**: histórico por patrimônio.
- **Downloads** (`/download/`): pacotes dos scripts já configurados para o servidor.

## Execução rápida

```sh
cd diag-viewer
UPLOAD_TOKEN=... READ_TOKEN=... DATA_DIR=./data node server.js   # Node 18+
```

Com Docker, veja `docs/INSTALAR-PORTAINER.txt` e `diag-viewer/README.md`.

## Segurança

- Tokens ficam em variáveis de ambiente (`.env`, fora do repositório).
- O tráfego é HTTP: use apenas em rede interna ou atrás de um proxy HTTPS.
