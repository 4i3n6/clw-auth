# claude-oauth

Gerenciador standalone de credenciais Anthropic OAuth. Produz arquivos padronizados que qualquer sistema consome.

## O que faz

1. Autentica via OAuth 2.0 PKCE ou API key
2. Persiste tokens em `~/.local/share/claude-oauth/auth.json`
3. Gera `api-reference.json` com URL, headers e authorization prontos para uso
4. Renova tokens automaticamente via cron
5. Monitora drift de user-agent e beta headers contra docs oficiais da Anthropic
6. Exporta credenciais para sistemas especificos (OpenCode, etc.) via exportadores opcionais

## Como funciona

```
claude-oauth (este projeto)
    |
    |-- auth.json          (credenciais: access, refresh, expires)
    |-- api-reference.json (como chamar: URL, headers, authorization)
    |-- config.json        (beta headers, user-agent)
    |
    +--> OpenCode le e usa (via export opencode)
    +--> OpenClaw le e usa (via export openclaw)
    +--> Script Python le e usa (le api-reference.json direto)
    +--> curl le e usa (le api-reference.json direto)
    +--> qualquer sistema le e usa
```

Nenhum sistema e especial. O projeto produz arquivos padronizados em `~/.local/share/claude-oauth/`. Quem quiser consumir, consome.

## Requisitos

- Node.js >= 18

## Estrutura

```
claude-oauth/
  src/
    cli.mjs              # Entry point + command dispatch
    store.mjs            # Persistencia atomica (auth.json, api-reference.json, config.json)
    auth.mjs             # OAuth PKCE, exchange, refresh, API key
    config.mjs           # Beta headers, user-agent, defaults
    api-reference.mjs    # Geracao do api-reference.json
    upstream.mjs         # Fetch + analise de docs Anthropic
    cron.mjs             # Lock + refresh condicional + upstream check
    exporters/
      index.mjs          # Registry de exportadores
      opencode.mjs       # Exportador OpenCode (unico lugar com logica OpenCode)
  scripts/
    setup-cron.mjs       # Instala entrada no cron
  package.json
```

## Arquivos de saida (`~/.local/share/claude-oauth/`)

| Arquivo | Permissao | Descricao |
|---|---|---|
| `auth.json` | 600 | Credenciais brutas (access, refresh, expires, type) |
| `auth.json.bak` | 600 | Backup automatico antes de qualquer escrita |
| `api-reference.json` | 644 | URL + headers + authorization prontos para consumo |
| `config.json` | 600 | Beta headers e user-agent configurados |
| `cron.lock` | 600 | Lock de execucao concorrente |
| `debug.log` | 600 | Log JSONL de operacoes |

### Exemplo de `api-reference.json`

```json
{
  "endpoint": "https://api.anthropic.com/v1/messages",
  "authorization": "Bearer sk-ant-oat01-...",
  "headers": {
    "anthropic-beta": "interleaved-thinking-2025-05-14",
    "user-agent": "claude-cli/2.1.92 (external, cli)",
    "anthropic-version": "2023-06-01",
    "content-type": "application/json"
  },
  "auth_type": "oauth",
  "token_expires": "2026-04-07T23:42:35.196Z",
  "token_expired": false,
  "last_updated": "2026-04-06T20:42:35.000Z"
}
```

Qualquer sistema le esse arquivo e faz a chamada. Sem plugin, sem patch, sem acoplamento.

## Autenticacao

### OAuth (recomendado)

```bash
# 1. Gerar URL de login
node src/cli.mjs oauth-url

# 2. Abrir no navegador, completar login, copiar o retorno code#state

# 3. Trocar por tokens
node src/cli.mjs oauth-exchange "code#state"

# 4. Verificar
node src/cli.mjs status
```

### API key

```bash
node src/cli.mjs api "$ANTHROPIC_API_KEY"
node src/cli.mjs status
```

## Comandos

### Core

```bash
claude-oauth oauth-url                    # Gera URL OAuth (PKCE)
claude-oauth oauth-exchange <input>       # Troca code#state por tokens
claude-oauth refresh                      # Renova token OAuth
claude-oauth status                       # Status de auth atual
claude-oauth doctor                       # Status + api-ref + config + sources
claude-oauth api <key>                    # Salva API key
```

### API reference

```bash
claude-oauth api-ref                      # Mostra api-reference.json
claude-oauth api-ref-update               # Regenera api-reference.json
```

### Config

```bash
claude-oauth config                       # Mostra config atual
claude-oauth set-betas <csv|none>         # Define beta headers
claude-oauth set-user-agent <ua|default>  # Define user-agent
claude-oauth config-reset                 # Restaura defaults
```

### Upstream

```bash
claude-oauth upstream-check               # Compara local vs docs Anthropic
claude-oauth sources                      # Mostra URLs monitoradas
```

### Exportadores

```bash
claude-oauth export                       # Lista exportadores disponiveis
claude-oauth export opencode              # Exporta config para OpenCode
```

### Manutencao

```bash
claude-oauth cron-run                     # Executa manutencao (para cron/launchd)
```

## Manutencao automatica (cron)

Instala entrada no cron para rodar a cada 6 horas:

```bash
node scripts/setup-cron.mjs
```

O cron executa:
1. Refresh OAuth se o token expira em menos de 1 hora
2. Coleta dados upstream (docs Anthropic)
3. Atualiza user-agent automaticamente se estiver defasado
4. Regenera api-reference.json
5. Reporta drift de beta headers (sem alterar automaticamente)

Execucao manual:

```bash
node src/cli.mjs cron-run
```

## Exportadores

O sistema de exportadores permite integrar com qualquer ferramenta sem acoplar o core.

### OpenCode

```bash
node src/cli.mjs export opencode
```

Esse exportador:
- Copia credenciais para `~/.local/share/opencode/auth.json` (preserva outros providers)
- Gera plugin Anthropic em `~/.config/opencode/plugins/`
- Patcha `~/.config/opencode/opencode.json` para incluir o plugin

### Adicionar um novo exportador

1. Criar `src/exporters/<sistema>.mjs` com `export async function run() { ... }`
2. Registrar em `src/exporters/index.mjs`

O core nao muda. Cada exportador le `auth.json` e `api-reference.json` e gera o que o sistema alvo precisar.

## Portabilidade

```bash
# Copiar para outra maquina
scp -r ~/Sistemas/claude-oauth user@host:~/claude-oauth

# Na maquina destino, autenticar
node ~/claude-oauth/src/cli.mjs oauth-url
node ~/claude-oauth/src/cli.mjs oauth-exchange "code#state"
node ~/claude-oauth/src/cli.mjs status

# Opcional: exportar para OpenCode
node ~/claude-oauth/src/cli.mjs export opencode

# Opcional: instalar cron
node ~/claude-oauth/scripts/setup-cron.mjs
```

## Fontes upstream monitoradas

- https://docs.anthropic.com/en/api/beta-headers
- https://docs.anthropic.com/en/release-notes/api
- https://docs.anthropic.com/en/release-notes/claude-code

## Seguranca

- Credenciais nunca sao commitadas (`.gitignore`)
- `auth.json` e `config.json` gravados com permissao `600`
- `api-reference.json` gravado com permissao `644` (leitura por outros processos)
- Todas as escritas sao atomicas (write tmp + rename)
- Backup automatico de `auth.json` antes de qualquer sobrescrita
- Lock interno para evitar execucoes concorrentes do cron
