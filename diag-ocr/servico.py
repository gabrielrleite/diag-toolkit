#!/usr/bin/env python3
"""
diag-ocr: OCR de manuscrito (TrOCR) para a Central diag, rodando com ONNX Runtime (sem PyTorch).

Lê recortes de UMA linha de texto (as células Local, SELB e Data das folhas de recebimento) e devolve
o texto com uma confiança 0-100. Só a Central diag chama este serviço (rede interna do Docker).

  GET  /saude  -> {"estado": "baixando|carregando|pronto|erro", "modelo": ..., "detalhe": ...}
  POST /ocr    <- {"imagens": ["<PNG/JPEG em base64>", ...]}   (até OCR_LOTE_MAX imagens)
               -> {"textos": [{"texto": "...", "conf": 87}, ...], "ms": 1234, "modelo": ...}

Variáveis de ambiente:
  OCR_MODELO     repositório no Hugging Face com a exportação ONNX do TrOCR, ou uma pasta local
                 (padrão: Xenova/trocr-base-handwritten)
  OCR_PRECISAO   q8 (padrão: modelo quantizado, ~4x menor e mais rápido em CPU) ou fp32
  OCR_DIR        onde guardar os modelos baixados (padrão: /modelos)
  HF_ENDPOINT    endereço do Hugging Face ou de um espelho (padrão: https://huggingface.co)
  OCR_PORTA      porta HTTP (padrão: 8000)
  OCR_THREADS    threads do ONNX Runtime (padrão: automático)
  OCR_MAX_TOKENS tamanho máximo do texto gerado, em tokens (padrão: 32)
"""
import base64
import io
import json
import os
import re
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import onnxruntime as ort
from PIL import Image
from tokenizers import Tokenizer

MODELO = os.environ.get('OCR_MODELO', 'Xenova/trocr-base-handwritten')
PRECISAO = os.environ.get('OCR_PRECISAO', 'q8').lower()
DIR = os.environ.get('OCR_DIR', '/modelos')
HF = os.environ.get('HF_ENDPOINT', 'https://huggingface.co').rstrip('/')
PORTA = int(os.environ.get('OCR_PORTA', '8000'))
THREADS = int(os.environ.get('OCR_THREADS', '0'))
MAX_TOKENS = int(os.environ.get('OCR_MAX_TOKENS', '32'))
LOTE_MAX = int(os.environ.get('OCR_LOTE_MAX', '32'))
CORPO_MAX = 20 * 1024 * 1024

estado = {'estado': 'iniciando', 'modelo': MODELO, 'precisao': PRECISAO, 'detalhe': ''}
motor = None
trava = threading.Lock()


def log(*a):
    print(time.strftime('%Y-%m-%d %H:%M:%S'), *a, flush=True)


# ------------------------------------------------------------------ download do modelo
def baixar(url, destino):
    """Baixa url para destino (via .part). Devolve False em 404."""
    tmp = destino + '.part'
    req = urllib.request.Request(url, headers={'User-Agent': 'diag-ocr'})
    try:
        with urllib.request.urlopen(req, timeout=120) as r, open(tmp, 'wb') as f:
            total = int(r.headers.get('Content-Length') or 0)
            feito, ultimo = 0, 0
            while True:
                bloco = r.read(1 << 20)
                if not bloco:
                    break
                f.write(bloco)
                feito += len(bloco)
                if total and feito - ultimo > 20 << 20:
                    ultimo = feito
                    estado['detalhe'] = f'{os.path.basename(destino)}: {feito >> 20} de {total >> 20} MB'
                    log('  ', estado['detalhe'])
    except urllib.error.HTTPError as e:
        if os.path.exists(tmp):
            os.remove(tmp)
        if e.code == 404:
            return False
        raise
    os.replace(tmp, destino)
    return True


def arquivos_do_modelo():
    """Pasta com config.json, preprocessor_config.json, tokenizer.json e onnx/encoder*, onnx/decoder*."""
    if os.path.isdir(MODELO):
        return MODELO
    pasta = os.path.join(DIR, re.sub(r'[^\w.-]+', '__', MODELO))
    os.makedirs(os.path.join(pasta, 'onnx'), exist_ok=True)
    estado['estado'] = 'baixando'
    for nome, obrigatorio in [('config.json', True), ('generation_config.json', False),
                              ('preprocessor_config.json', True), ('tokenizer.json', True)]:
        dest = os.path.join(pasta, nome)
        if not os.path.exists(dest):
            log('baixando', nome)
            if not baixar(f'{HF}/{MODELO}/resolve/main/{nome}', dest) and obrigatorio:
                raise RuntimeError(f'{nome} não encontrado em {MODELO}')
    # nomes usados pelas exportações ONNX (Xenova / onnx-community)
    sufixos = ['_quantized', '_q8', '_int8', ''] if PRECISAO != 'fp32' else ['']
    for parte in ('encoder_model', 'decoder_model'):
        if any(os.path.exists(os.path.join(pasta, 'onnx', parte + s + '.onnx')) for s in sufixos):
            continue
        for s in sufixos:
            nome = f'onnx/{parte}{s}.onnx'
            log('baixando', nome, '(pode levar alguns minutos)')
            if baixar(f'{HF}/{MODELO}/resolve/main/{nome}', os.path.join(pasta, nome)):
                break
        else:
            raise RuntimeError(f'{parte}.onnx não encontrado em {MODELO}')
    return pasta


# ------------------------------------------------------------------ motor
class TrOCR:
    def __init__(self, pasta):
        cfg = json.load(open(os.path.join(pasta, 'config.json'), encoding='utf-8'))
        gen = {}
        if os.path.exists(os.path.join(pasta, 'generation_config.json')):
            gen = json.load(open(os.path.join(pasta, 'generation_config.json'), encoding='utf-8'))
        dec = cfg.get('decoder', {})
        pega = lambda k, padrao: next((d[k] for d in (gen, cfg, dec) if d.get(k) is not None), padrao)
        self.inicio = int(pega('decoder_start_token_id', 2))
        self.fim = int(pega('eos_token_id', 2))
        self.pad = int(pega('pad_token_id', 1))

        pp = json.load(open(os.path.join(pasta, 'preprocessor_config.json'), encoding='utf-8'))
        tam = pp.get('size', 384)
        self.alt, self.larg = (tam.get('height', 384), tam.get('width', 384)) if isinstance(tam, dict) else (tam, tam)
        self.media = np.array(pp.get('image_mean', [0.5, 0.5, 0.5]), dtype=np.float32).reshape(3, 1, 1)
        self.desvio = np.array(pp.get('image_std', [0.5, 0.5, 0.5]), dtype=np.float32).reshape(3, 1, 1)
        self.escala = float(pp.get('rescale_factor', 1 / 255)) if pp.get('do_rescale', True) else 1.0
        self.normaliza = pp.get('do_normalize', True)
        self.resample = {0: Image.NEAREST, 1: Image.LANCZOS, 2: Image.BILINEAR, 3: Image.BICUBIC}.get(pp.get('resample', 2), Image.BILINEAR)

        self.tok = Tokenizer.from_file(os.path.join(pasta, 'tokenizer.json'))
        opc = ort.SessionOptions()
        if THREADS:
            opc.intra_op_num_threads = THREADS
        acha = lambda parte: next(os.path.join(pasta, 'onnx', parte + s + '.onnx') for s in ['_quantized', '_q8', '_int8', '']
                                  if os.path.exists(os.path.join(pasta, 'onnx', parte + s + '.onnx')))
        self.enc = ort.InferenceSession(acha('encoder_model'), opc, providers=['CPUExecutionProvider'])
        self.dec = ort.InferenceSession(acha('decoder_model'), opc, providers=['CPUExecutionProvider'])
        self.ent_enc = self.enc.get_inputs()[0].name
        self.ent_dec = {i.name for i in self.dec.get_inputs()}
        self.saida_logits = next((o.name for o in self.dec.get_outputs() if 'logits' in o.name), self.dec.get_outputs()[0].name)

    def preparar(self, img):
        img = img.convert('RGB').resize((self.larg, self.alt), self.resample)
        a = np.asarray(img, dtype=np.float32).transpose(2, 0, 1) * self.escala
        if self.normaliza:
            a = (a - self.media) / self.desvio
        return a

    def ler(self, imagens):
        """Decodificação gulosa em lote. Devolve [(texto, confiança 0-100)]."""
        px = np.stack([self.preparar(i) for i in imagens]).astype(np.float32)
        oculto = self.enc.run(None, {self.ent_enc: px})[0]
        n = len(imagens)
        ids = np.full((n, 1), self.inicio, dtype=np.int64)
        probs = [[] for _ in range(n)]
        acabou = np.zeros(n, dtype=bool)
        for _ in range(MAX_TOKENS):
            ent = {'input_ids': ids, 'encoder_hidden_states': oculto}
            if 'encoder_attention_mask' in self.ent_dec:
                ent['encoder_attention_mask'] = np.ones(oculto.shape[:2], dtype=np.int64)
            if 'attention_mask' in self.ent_dec:
                ent['attention_mask'] = np.ones(ids.shape, dtype=np.int64)
            logits = self.dec.run([self.saida_logits], {k: v for k, v in ent.items() if k in self.ent_dec})[0][:, -1, :]
            logits = logits - logits.max(axis=1, keepdims=True)
            p = np.exp(logits)
            p /= p.sum(axis=1, keepdims=True)
            prox = p.argmax(axis=1)
            for i in range(n):
                if not acabou[i]:
                    if prox[i] == self.fim:
                        acabou[i] = True
                    else:
                        probs[i].append(float(p[i, prox[i]]))
            prox = np.where(acabou, self.pad, prox)
            ids = np.concatenate([ids, prox[:, None].astype(np.int64)], axis=1)
            if acabou.all():
                break
        saida = []
        for i in range(n):
            toks = [int(t) for t in ids[i, 1:] if t not in (self.fim, self.pad)]
            texto = self.tok.decode(toks, skip_special_tokens=True).strip()
            # confiança: média geométrica das probabilidades dos tokens
            conf = float(np.exp(np.mean(np.log(np.maximum(probs[i], 1e-9))))) * 100 if probs[i] else 0.0
            saida.append((texto, round(conf)))
        return saida


def carregar():
    global motor
    try:
        pasta = arquivos_do_modelo()
        estado['estado'] = 'carregando'
        estado['detalhe'] = ''
        log('carregando o modelo de', pasta)
        motor = TrOCR(pasta)
        # aquecimento (a primeira inferência é mais lenta)
        motor.ler([Image.new('RGB', (200, 50), 'white')])
        estado['estado'] = 'pronto'
        log('pronto:', MODELO, PRECISAO)
    except Exception as e:  # noqa: BLE001 - o motivo vai para /saude
        estado['estado'] = 'erro'
        estado['detalhe'] = f'{type(e).__name__}: {e}'
        log('ERRO ao preparar o modelo:', estado['detalhe'])


# ------------------------------------------------------------------ HTTP
class Http(BaseHTTPRequestHandler):
    server_version = 'diag-ocr'

    def log_message(self, fmt, *a):  # silencia o log padrão por requisição
        pass

    def responder(self, codigo, obj):
        corpo = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(codigo)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(corpo)))
        self.end_headers()
        self.wfile.write(corpo)

    def do_GET(self):
        if self.path.split('?')[0] == '/saude':
            return self.responder(200, estado)
        self.responder(404, {'erro': 'Rota não encontrada.'})

    def do_POST(self):
        if self.path.split('?')[0] != '/ocr':
            return self.responder(404, {'erro': 'Rota não encontrada.'})
        if estado['estado'] != 'pronto':
            return self.responder(503, {'erro': f"OCR do servidor ainda não está pronto ({estado['estado']}).", **estado})
        tam = int(self.headers.get('Content-Length') or 0)
        if tam <= 0 or tam > CORPO_MAX:
            return self.responder(413, {'erro': 'Corpo vazio ou grande demais.'})
        try:
            dados = json.loads(self.rfile.read(tam))
            imgs = [Image.open(io.BytesIO(base64.b64decode(str(b).split(',')[-1]))) for b in dados.get('imagens', [])][:LOTE_MAX]
        except Exception:  # noqa: BLE001
            return self.responder(400, {'erro': 'Imagens inválidas.'})
        if not imgs:
            return self.responder(400, {'erro': 'Nenhuma imagem.'})
        t0 = time.time()
        with trava:  # uma inferência por vez (usa todos os núcleos)
            res = motor.ler(imgs)
        ms = round((time.time() - t0) * 1000)
        self.responder(200, {'textos': [{'texto': t, 'conf': c} for t, c in res], 'ms': ms, 'modelo': MODELO})


def main():
    log(f'diag-ocr: modelo {MODELO} ({PRECISAO}), porta {PORTA}')
    threading.Thread(target=carregar, daemon=True).start()
    ThreadingHTTPServer(('0.0.0.0', PORTA), Http).serve_forever()


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '--baixar':  # só baixa o modelo e sai
        arquivos_do_modelo()
        sys.exit(0)
    main()
