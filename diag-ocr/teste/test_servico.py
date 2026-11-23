#!/usr/bin/env python3
"""
Teste do serviço diag-ocr com o modelo de teste (sem internet):
  1. gera o modelo de teste e o publica num "Hugging Face" local (http://127.0.0.1:PORTA/<repo>/resolve/main/...)
  2. sobe o serviço apontando HF_ENDPOINT para ele (testa o download e os nomes de arquivo quantizados)
  3. confere /saude, a leitura em lote (escura -> A123, clara -> SALA 12), a confiança e os erros

Uso: python diag-ocr/teste/test_servico.py      (precisa de onnx, onnxruntime, numpy, pillow, tokenizers)
"""
import base64
import io
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

from PIL import Image

AQUI = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, AQUI)
import gerar_modelo_teste  # noqa: E402


def png(cor):
    b = io.BytesIO()
    Image.new('RGB', (180, 48), cor).save(b, 'PNG')
    return base64.b64encode(b.getvalue()).decode()


def pedir(url, corpo=None):
    req = urllib.request.Request(url, data=json.dumps(corpo).encode() if corpo is not None else None,
                                 headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def main():
    tmp = tempfile.mkdtemp(prefix='diag-ocr-')
    hub = os.path.join(tmp, 'hub')
    gerar_modelo_teste.main(os.path.join(hub, 'teste', 'trocr', 'resolve', 'main'))
    # "Hugging Face" local
    srv = ThreadingHTTPServer(('127.0.0.1', 0), partial(type('H', (SimpleHTTPRequestHandler,), {'log_message': lambda *a: None}), directory=hub))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    porta_ocr = 18765
    env = {**os.environ, 'OCR_MODELO': 'teste/trocr', 'HF_ENDPOINT': f'http://127.0.0.1:{srv.server_port}',
           'OCR_DIR': os.path.join(tmp, 'modelos'), 'OCR_PORTA': str(porta_ocr)}
    proc = subprocess.Popen([sys.executable, os.path.join(AQUI, '..', 'servico.py')], env=env)
    base = f'http://127.0.0.1:{porta_ocr}'
    try:
        for _ in range(100):
            time.sleep(0.2)
            try:
                st, saude = pedir(base + '/saude')
                if saude['estado'] in ('pronto', 'erro'):
                    break
            except OSError:
                pass
        assert saude['estado'] == 'pronto', saude
        baixados = sorted(os.listdir(os.path.join(tmp, 'modelos', 'teste__trocr', 'onnx')))
        assert baixados == ['decoder_model_quantized.onnx', 'encoder_model_quantized.onnx'], baixados

        st, r = pedir(base + '/ocr', {'imagens': [png('black'), png('white'), 'data:image/png;base64,' + png((20, 20, 20))]})
        assert st == 200, r
        textos = [t['texto'] for t in r['textos']]
        assert textos == ['A123', 'SALA 12', 'A123'], textos
        assert all(80 <= t['conf'] <= 100 for t in r['textos']), r['textos']

        st, r = pedir(base + '/ocr', {'imagens': []})
        assert st == 400, r
        st, r = pedir(base + '/ocr', {'imagens': ['não é imagem']})
        assert st == 400, r
        st, r = pedir(base + '/nada')
        assert st == 404, r
        print('diag-ocr: ok')
    finally:
        proc.terminate()
        srv.shutdown()


if __name__ == '__main__':
    main()
