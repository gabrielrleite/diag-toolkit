# diag-scripts

Scripts de coleta (Windows). Só leem o sistema; geram .zip com SHA256 e podem enviar ao servidor.

Diagnóstico do computador (manutenção):
- `diagnostico.bat`: menu em texto (dois cliques; pede admin)
- `diagnostico.ps1`: saúde de discos/memória/vídeo, telas azuis, erros, dispositivos com problema, serviços, impressoras, rede, ativação, antivírus, programas

Remoção de hardware:
- `diag-hardware.bat` / `diag-hardware.ps1`: histórico de dispositivos, boots, PnP, logons e logs .evtx (inclui saúde)

`diag-servidor.cfg`: endereço do servidor e token de envio. O jeito fácil é baixar os pacotes prontos em http://SERVIDOR/download/.
