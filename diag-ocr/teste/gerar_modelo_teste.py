#!/usr/bin/env python3
"""
Gera um "TrOCR de mentira" com a MESMA estrutura de arquivos de uma exportação ONNX do Hugging Face
(config.json, generation_config.json, preprocessor_config.json, tokenizer.json,
onnx/encoder_model_quantized.onnx, onnx/decoder_model_quantized.onnx), para testar o serviço sem
baixar o modelo real: imagem escura -> "A123", imagem clara -> "SALA 12".

Uso: python gerar_modelo_teste.py PASTA_DESTINO
"""
import json
import os
import sys

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper
from tokenizers import ByteLevelBPETokenizer

ESCURA, CLARA = 'A123', 'SALA 12'


def main(dest):
    os.makedirs(os.path.join(dest, 'onnx'), exist_ok=True)

    # tokenizador byte-level BPE (como o do TrOCR), com <s>=0 <pad>=1 </s>=2 <unk>=3
    tok = ByteLevelBPETokenizer()
    tok.train_from_iterator([ESCURA, CLARA, '12/11/2026 ALMOXARIFADO B77'] * 50, vocab_size=300, min_frequency=1,
                            special_tokens=['<s>', '<pad>', '</s>', '<unk>'])
    tok.save(os.path.join(dest, 'tokenizer.json'))
    V = tok.get_vocab_size()
    alvo = {k: tok.encode(t).ids + [2] for k, t in (('escura', ESCURA), ('clara', CLARA))}
    tmax = 40

    def tabela(ids):
        t = np.full((tmax, V), -5.0, dtype=np.float32)
        for j in range(tmax):
            t[j, ids[j] if j < len(ids) else 2] = 8.0
        return t

    # codificador: média da imagem -> [B, 1, 1]
    enc = helper.make_graph(
        [helper.make_node('ReduceMean', ['pixel_values'], ['m'], keepdims=1, axes=[1, 2, 3]),
         helper.make_node('Reshape', ['m', 'forma'], ['last_hidden_state'])],
        'encoder',
        [helper.make_tensor_value_info('pixel_values', TensorProto.FLOAT, ['B', 3, 'H', 'W'])],
        [helper.make_tensor_value_info('last_hidden_state', TensorProto.FLOAT, ['B', 1, 1])],
        [numpy_helper.from_array(np.array([-1, 1, 1], dtype=np.int64), 'forma')])

    # decodificador: logits[pos] = mistura das duas tabelas conforme a imagem ser escura (w~1) ou clara (w~0)
    dec = helper.make_graph(
        [helper.make_node('Shape', ['input_ids'], ['s']),
         helper.make_node('Gather', ['s', 'um'], ['t'], axis=0),
         helper.make_node('Unsqueeze', ['t', 'zero1'], ['t1']),
         helper.make_node('Slice', ['tab_escura', 'zero1', 't1', 'zero1'], ['te']),
         helper.make_node('Slice', ['tab_clara', 'zero1', 't1', 'zero1'], ['tc']),
         helper.make_node('Mul', ['encoder_hidden_states', 'menos20'], ['z']),
         helper.make_node('Sigmoid', ['z'], ['w']),
         helper.make_node('Sub', ['umf', 'w'], ['w2']),
         helper.make_node('Mul', ['w', 'te'], ['a']),
         helper.make_node('Mul', ['w2', 'tc'], ['b']),
         helper.make_node('Add', ['a', 'b'], ['logits'])],
        'decoder',
        [helper.make_tensor_value_info('input_ids', TensorProto.INT64, ['B', 'T']),
         helper.make_tensor_value_info('encoder_hidden_states', TensorProto.FLOAT, ['B', 1, 1])],
        [helper.make_tensor_value_info('logits', TensorProto.FLOAT, ['B', 'T', V])],
        [numpy_helper.from_array(tabela(alvo['escura']), 'tab_escura'),
         numpy_helper.from_array(tabela(alvo['clara']), 'tab_clara'),
         numpy_helper.from_array(np.array(1, dtype=np.int64), 'um'),
         numpy_helper.from_array(np.array([0], dtype=np.int64), 'zero1'),
         numpy_helper.from_array(np.array(-20.0, dtype=np.float32), 'menos20'),
         numpy_helper.from_array(np.array(1.0, dtype=np.float32), 'umf')])

    for g, nome in ((enc, 'encoder_model_quantized'), (dec, 'decoder_model_quantized')):
        m = helper.make_model(g, opset_imports=[helper.make_opsetid('', 17)])
        m.ir_version = 8
        onnx.checker.check_model(m)
        onnx.save(m, os.path.join(dest, 'onnx', nome + '.onnx'))

    json.dump({'model_type': 'vision-encoder-decoder', 'decoder_start_token_id': 2, 'pad_token_id': 1,
               'decoder': {'eos_token_id': 2, 'bos_token_id': 0, 'pad_token_id': 1}},
              open(os.path.join(dest, 'config.json'), 'w'))
    json.dump({'decoder_start_token_id': 2, 'eos_token_id': 2, 'pad_token_id': 1}, open(os.path.join(dest, 'generation_config.json'), 'w'))
    json.dump({'do_normalize': True, 'do_rescale': True, 'do_resize': True, 'image_mean': [0.5, 0.5, 0.5],
               'image_std': [0.5, 0.5, 0.5], 'resample': 2, 'rescale_factor': 1 / 255, 'size': {'height': 384, 'width': 384}},
              open(os.path.join(dest, 'preprocessor_config.json'), 'w'))
    print('modelo de teste em', dest)


if __name__ == '__main__':
    main(sys.argv[1])
