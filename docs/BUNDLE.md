# OpenCode Auth Bundle

Bundle portátil para macOS e Linux com bootstrap automático do helper `opencode-anthropic-auth`, plugins do OpenCode e manutenção agendada.

## O que este bundle faz

Ao rodar o bootstrap, ele:

1. instala o helper em `~/.local/bin` ou `~/bin` (preferindo um diretório já presente no `PATH`)
2. copia os plugins para `~/.config/opencode/plugins/`
3. corrige `~/.config/opencode/opencode.json` para apontar para os plugins locais
4. inicializa `~/.local/share/opencode/anthropic-plugin.json`
5. preserva os demais plugins existentes no `opencode.json`

O bundle não copia `auth.json`. Cada máquina autentica localmente.

## Comando principal

O helper agora é o ponto central. Em uma máquina nova, o comando recomendado é:

```bash
node ~/opencode-auth-bundle/install.mjs
```

Ou diretamente pelo helper dentro do bundle:

```bash
~/opencode-auth-bundle/opencode-anthropic-auth bootstrap ~/opencode-auth-bundle
```

`install.mjs` é apenas um wrapper fino para esse bootstrap.

## Como portar para outra máquina

Copie o diretório inteiro:

```bash
scp -r ~/bin/opencode-auth-bundle user@host:~/opencode-auth-bundle
```

Depois rode um destes comandos no host de destino:

```bash
node ~/opencode-auth-bundle/install.mjs
```

ou

```bash
~/opencode-auth-bundle/opencode-anthropic-auth bootstrap ~/opencode-auth-bundle
```

## Como autenticar Anthropic

No host de destino:

```bash
opencode-anthropic-auth oauth-url
```

Abra a URL no navegador, conclua o login e pegue o retorno `code#state`. Depois rode:

```bash
opencode-anthropic-auth oauth-exchange "code#state"
opencode-anthropic-auth status
```

## Comandos úteis

Diagnóstico local:

```bash
opencode-anthropic-auth doctor
```

Ver fontes oficiais monitoradas:

```bash
opencode-anthropic-auth sources
```

Checar drift de `user-agent` e `beta headers`:

```bash
opencode-anthropic-auth upstream-check
```

Ver ou ajustar a config compartilhada do plugin:

```bash
opencode-anthropic-auth plugin-config
opencode-anthropic-auth plugin-set-user-agent "claude-cli/2.1.81 (external, cli)"
opencode-anthropic-auth plugin-set-betas "oauth-2025-04-20,interleaved-thinking-2025-05-14"
opencode-anthropic-auth plugin-reset
```

## Modo cron / manutenção automática

O helper agora possui um modo não interativo preparado para agendamento:

```bash
opencode-anthropic-auth cron-run ~/opencode-auth-bundle
```

Esse modo:

1. sincroniza novamente helper + plugins + `opencode.json`
2. inicializa/corrige `anthropic-plugin.json` se necessário
3. renova OAuth se a credencial estiver perto de expirar
4. consulta as fontes oficiais da Anthropic
5. atualiza automaticamente o `user-agent` se ele estiver defasado
6. reporta drift de `beta headers` para revisão manual
7. evita execução concorrente com lock interno em `~/.local/state/opencode/anthropic-auth-cron.lock`

### Exemplo de cron (Linux ou macOS)

Executar a cada 6 horas:

```bash
0 */6 * * * $HOME/bin/opencode-anthropic-auth cron-run $HOME/opencode-auth-bundle >> $HOME/.local/state/opencode/anthropic-auth-cron.log 2>&1
```

Se a instalação escolheu `~/.local/bin`, ajuste o caminho:

```bash
0 */6 * * * $HOME/.local/bin/opencode-anthropic-auth cron-run $HOME/opencode-auth-bundle >> $HOME/.local/state/opencode/anthropic-auth-cron.log 2>&1
```

### Instalar no cron do usuário

```bash
(crontab -l 2>/dev/null; echo '0 */6 * * * $HOME/bin/opencode-anthropic-auth cron-run $HOME/opencode-auth-bundle >> $HOME/.local/state/opencode/anthropic-auth-cron.log 2>&1') | crontab -
```

## Verificação final

Teste o runtime do OpenCode:

```bash
opencode run -m anthropic/claude-sonnet-4-6 "Reply with exactly: ok"
```

## Observações

- o caminho oficial de monitoramento continua sendo:
  - `https://docs.anthropic.com/en/api/beta-headers`
  - `https://docs.anthropic.com/en/release-notes/api`
  - `https://docs.anthropic.com/en/release-notes/claude-code`
- `cron-run` atualiza automaticamente o `user-agent`, mas **não** altera `beta headers` sozinho
- `cron-run` possui lock interno; execuções concorrentes extras são ignoradas com segurança
- a configuração compartilhada do plugin fica em `~/.local/share/opencode/anthropic-plugin.json`
- o arquivo é escrito com `schemaVersion`, modo atômico e permissão `600`
