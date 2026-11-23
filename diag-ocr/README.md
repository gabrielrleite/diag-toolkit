# diag-ocr

OCR de letra à mão para a Central diag: lê as células Local, SELB e Data das folhas de recebimento com o **TrOCR** (Microsoft, treinado em manuscrito), exportado em ONNX e rodando com **ONNX Runtime** em CPU — sem PyTorch e sem GPU.

- Na 1ª execução baixa o modelo do Hugging Face (padrão `Xenova/trocr-base-handwritten`, versão quantizada q8, ~350 MB) para `OCR_DIR`.
- `GET /saude` → estado (`baixando`, `carregando`, `pronto`, `erro`); `POST /ocr` com `{"imagens": ["<base64>"]}` → `{"textos": [{"texto", "conf"}]}`.
- Variáveis: `OCR_MODELO`, `OCR_PRECISAO` (`q8`/`fp32`), `OCR_DIR`, `HF_ENDPOINT`, `OCR_PORTA`, `OCR_THREADS`, `OCR_MAX_TOKENS` (detalhes no topo de `servico.py`).
- Na stack do Portainer é o serviço `ocr`; a Central diag o acessa por `OCR_URL=http://ocr:8000` (sem porta publicada).

## Teste

`python diag-ocr/teste/test_servico.py` (precisa de `onnx`, `onnxruntime`, `numpy`, `pillow`, `tokenizers`): gera um modelo sintético com a mesma estrutura da exportação do Hugging Face, publica num servidor local e testa download, leitura em lote, confiança e erros — sem internet. A precisão do modelo real só se mede com folhas reais (veja também `diag-viewer/test/ocr-bench.js`).
