# Notas do vault (repo1)

Este repositório (`Goblinjg/repo1`) é o meu vault pessoal de mudanças.
O repositório oficial da equipe é o **`Goblinjg/Nibble-4Life`**: nada daqui é enviado para lá automaticamente.

## Como sincronizar com o Nibble

O histórico do Nibble foi mesclado aqui, então daqui em diante é só um merge normal:

```bash
git remote add nibble https://github.com/Goblinjg/Nibble-4Life.git   # só na primeira vez
git fetch nibble
git merge nibble/main          # use -X theirs para priorizar o conteúdo do Nibble
git push origin main           # sobe só para o repo1
```

**Nunca** faça `git push nibble ...` a partir daqui. Mudanças no Nibble vão por branch + PR lá.

## O que existe só aqui (não está no Nibble)

- `docs/perguntas-arguicao-parte3.md`: perguntas da arguição da Parte 3
- `docs/video-roteiro-parte3.md`: roteiro do vídeo da Parte 3
- Este arquivo

## Dica que ficou de fora do README do Nibble

| Sintoma | Solução |
|---|---|
| `password authentication failed` depois de gerar um `.env` novo | O PostgreSQL guarda a senha da **primeira** inicialização no volume/PVC. Recrie os dados: `docker compose down -v` e/ou `./scripts/k8s-down.sh` |
