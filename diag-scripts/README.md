# diag-scripts

Scripts de coleta (Windows). Só leem o sistema; geram .zip com SHA256 e podem enviar ao servidor.

Diagnóstico do computador (manutenção):
- `diagnostico.bat`: menu em texto (dois cliques; pede admin)
- `diagnostico.ps1`: saúde de discos/memória/vídeo, telas azuis, erros, dispositivos com problema, serviços, impressoras, rede, ativação, antivírus, programas
  - testes profundos e perfis: `-Perfil basico|padrao|completo|burnin` ou `-Testes benchmark,estresse,memoria,...` (lista no cabeçalho do script)
  - sensores gravados durante os testes em `10_sensores.csv`
- `baixar-sensores.ps1`: baixa o LibreHardwareMonitor para `sensores/` (tensões da fonte, ventoinhas, temperaturas de CPU/placa-mãe/GPU). Leve a pasta junto no pendrive. No servidor, copie-a para `diag-viewer/web/coleta/sensores/` e ela entra no pacote de download. Versões 0.9.5+ leem a placa-mãe pelo driver PawnIO, que precisa estar instalado no PC testado.

Remoção de hardware:
- `diag-hardware.bat` / `diag-hardware.ps1`: histórico de dispositivos, boots, PnP, logons e logs .evtx (inclui saúde)

`diag-servidor.cfg`: endereço do servidor e token de envio. O jeito fácil é baixar os pacotes prontos em http://SERVIDOR/download/.
