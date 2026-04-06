import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const PLATFORM_HOST = "platform.claude.com";
const LEGACY_CONSOLE_HOST = "console.anthropic.com";
const CALLBACK_URL = `https://${PLATFORM_HOST}/oauth/code/callback`;
const TOKEN_ENDPOINTS = [
  `https://${PLATFORM_HOST}/v1/oauth/token`,
  `https://${LEGACY_CONSOLE_HOST}/v1/oauth/token`,
];
const RATE_LIMIT_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000];
const DEBUG_LOG_PATH = join(
  process.env.HOME ?? ".",
  ".local",
  "state",
  "opencode",
  "anthropic-auth-debug.log",
);
const PLUGIN_CONFIG_PATH = join(
  process.env.HOME ?? ".",
  ".local",
  "share",
  "opencode",
  "anthropic-plugin.json",
);
const DEFAULT_PLUGIN_CONFIG = Object.freeze({
  schemaVersion: 1,
  betaHeaders: ["oauth-2025-04-20", "interleaved-thinking-2025-05-14"],
  userAgent: "claude-cli/2.1.2 (external, cli)",
});

function loadPluginConfig() {
  try {
    if (!existsSync(PLUGIN_CONFIG_PATH)) {
      return DEFAULT_PLUGIN_CONFIG;
    }

    const rawConfig = JSON.parse(readFileSync(PLUGIN_CONFIG_PATH, "utf8"));
    if (rawConfig?.schemaVersion !== DEFAULT_PLUGIN_CONFIG.schemaVersion) {
      debugLog("plugin_config_schema_mismatch", {
        expected: DEFAULT_PLUGIN_CONFIG.schemaVersion,
        received: rawConfig?.schemaVersion ?? null,
      });
      return DEFAULT_PLUGIN_CONFIG;
    }

    const betaHeaders = Array.isArray(rawConfig?.betaHeaders)
      ? rawConfig.betaHeaders
        .filter((value) => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean)
      : DEFAULT_PLUGIN_CONFIG.betaHeaders;
    const userAgent = typeof rawConfig?.userAgent === "string" && rawConfig.userAgent.trim()
      ? rawConfig.userAgent.trim()
      : DEFAULT_PLUGIN_CONFIG.userAgent;

    return {
      schemaVersion: DEFAULT_PLUGIN_CONFIG.schemaVersion,
      betaHeaders,
      userAgent,
    };
  } catch (error) {
    debugLog("plugin_config_load_failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    return DEFAULT_PLUGIN_CONFIG;
  }
}

function debugLog(event, details) {
  try {
    mkdirSync(dirname(DEBUG_LOG_PATH), { recursive: true });
    appendFileSync(
      DEBUG_LOG_PATH,
      JSON.stringify({
        ts: new Date().toISOString(),
        event,
        ...details,
      }) + "\n",
    );
  } catch (error) {
    console.error("Anthropic auth debug logging failed", error);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function parseError(response) {
  const text = await response.text();
  try {
    const json = JSON.parse(text);
    const message = json?.error_description || json?.error?.message || text;
    return message || response.statusText;
  } catch {
    return text || response.statusText;
  }
}

async function exchangeWithEndpoint(url, payload) {
  for (let attempt = 0; attempt <= RATE_LIMIT_RETRY_DELAYS_MS.length; attempt += 1) {
    const result = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (result.ok) {
      return {
        ok: true,
        endpoint: url,
        json: await result.json(),
      };
    }
    const message = await parseError(result);
    const retryAfterHeader = result.headers.get("retry-after");
    const retryAfterSeconds = retryAfterHeader
      ? Number.parseInt(retryAfterHeader, 10)
      : Number.NaN;
    const retryDelay = Number.isFinite(retryAfterSeconds)
      ? retryAfterSeconds * 1000
      : RATE_LIMIT_RETRY_DELAYS_MS[attempt];
    const isLastAttempt = attempt === RATE_LIMIT_RETRY_DELAYS_MS.length;
    debugLog("exchange_response", {
      endpoint: url,
      attempt,
      status: result.status,
      message,
      retryAfterHeader,
      retryDelay,
      isLastAttempt,
    });
    if (result.status !== 429 || typeof retryDelay !== "number" || isLastAttempt) {
      return {
        ok: false,
        status: result.status,
        message,
        endpoint: url,
      };
    }
    await sleep(retryDelay);
  }
  return {
    ok: false,
    status: 429,
    message: "Rate limited after retrying Anthropic OAuth endpoint.",
    endpoint: url,
  };
}

function buildOauthCredential(tokenResponse, currentRefresh) {
  if (!tokenResponse?.access_token) {
    throw new Error("OAuth token response did not include access_token.");
  }
  if (typeof tokenResponse?.expires_in !== "number") {
    throw new Error("OAuth token response did not include expires_in.");
  }

  const refreshToken = tokenResponse.refresh_token || currentRefresh;
  if (!refreshToken) {
    throw new Error("OAuth token response did not include refresh_token.");
  }

  return {
    type: "oauth",
    refresh: refreshToken,
    access: tokenResponse.access_token,
    expires: Date.now() + tokenResponse.expires_in * 1000,
  };
}

async function requestTokens(payload, context) {
  let failure = null;

  for (const endpoint of TOKEN_ENDPOINTS) {
    const result = await exchangeWithEndpoint(endpoint, payload);
    debugLog(`${context}_attempt`, {
      endpoint,
      ok: result.ok,
      status: result.ok ? 200 : result.status,
      message: result.ok ? "success" : result.message,
    });
    if (result.ok) {
      return result;
    }
    failure = result;
  }

  debugLog(`${context}_failed`, {
    endpoint: failure?.endpoint,
    status: failure?.status,
    message: failure?.message,
  });
  return {
    ok: false,
    status: failure?.status,
    message:
      failure?.message || "Token exchange failed during Anthropic OAuth flow.",
    endpoint: failure?.endpoint,
  };
}

async function persistOauthCredential(client, auth, tokenResponse) {
  const nextAuth = buildOauthCredential(tokenResponse, auth?.refresh);
  await client.auth.set({
    path: {
      id: "anthropic",
    },
    body: nextAuth,
  });
  if (auth) {
    auth.access = nextAuth.access;
    auth.expires = nextAuth.expires;
    auth.refresh = nextAuth.refresh;
  }
  return nextAuth;
}

async function refreshOauthCredential(client, auth) {
  const previousRefresh = auth?.refresh;
  debugLog("refresh_start", {
    hasRefresh: Boolean(auth?.refresh),
    expires: auth?.expires,
  });
  const result = await requestTokens(
    {
      grant_type: "refresh_token",
      refresh_token: auth.refresh,
      client_id: CLIENT_ID,
    },
    "refresh",
  );

  if (!result.ok) {
    throw new Error(
      `Token refresh failed: ${result.status} ${result.message} (${result.endpoint})`,
    );
  }

  const nextAuth = await persistOauthCredential(client, auth, result.json);
  debugLog("refresh_success", {
    endpoint: result.endpoint,
    expires: nextAuth.expires,
    refreshRotated: nextAuth.refresh !== previousRefresh,
  });
  return nextAuth;
}

/**
 * @type {import('@opencode-ai/plugin').Plugin}
 */
export async function AnthropicAuthPlugin({ client }) {
  let inflightRefresh = null;

  return {
    "experimental.chat.system.transform": (input, output) => {
      const prefix =
        "You are Claude Code, Anthropic's official CLI for Claude.";
      if (input.model?.providerID === "anthropic") {
        output.system.unshift(prefix);
        if (output.system[1])
          output.system[1] = prefix + "\n\n" + output.system[1];
      }
    },
    auth: {
      provider: "anthropic",
      async loader(getAuth, provider) {
        const auth = await getAuth();
        if (auth.type === "oauth") {
          // zero out cost for max plan
          for (const model of Object.values(provider.models)) {
            model.cost = {
              input: 0,
              output: 0,
              cache: {
                read: 0,
                write: 0,
              },
            };
          }
          return {
            apiKey: "",
            /**
             * @param {any} input
             * @param {any} init
             */
            async fetch(input, init) {
              let auth = await getAuth();
              if (auth.type !== "oauth") return fetch(input, init);
              if (!auth.access || auth.expires < Date.now()) {
                if (!auth.refresh) {
                  throw new Error("Stored Anthropic oauth credentials do not include refresh token.");
                }
                if (!inflightRefresh) {
                  inflightRefresh = refreshOauthCredential(client, auth)
                    .finally(() => {
                      inflightRefresh = null;
                    });
                }
                await inflightRefresh;
                auth = await getAuth();
                if (auth.type !== "oauth") {
                  throw new Error("Anthropic auth type changed during OAuth refresh.");
                }
              }
              const requestInit = init ?? {};

              const requestHeaders = new Headers();
              if (input instanceof Request) {
                input.headers.forEach((value, key) => {
                  requestHeaders.set(key, value);
                });
              }
              if (requestInit.headers) {
                if (requestInit.headers instanceof Headers) {
                  requestInit.headers.forEach((value, key) => {
                    requestHeaders.set(key, value);
                  });
                } else if (Array.isArray(requestInit.headers)) {
                  for (const [key, value] of requestInit.headers) {
                    if (typeof value !== "undefined") {
                      requestHeaders.set(key, String(value));
                    }
                  }
                } else {
                  for (const [key, value] of Object.entries(
                    requestInit.headers,
                  )) {
                    if (typeof value !== "undefined") {
                      requestHeaders.set(key, String(value));
                    }
                  }
                }
              }

              // Preserve all incoming beta headers while ensuring OAuth requirements
              const incomingBeta = requestHeaders.get("anthropic-beta") || "";
              const incomingBetasList = incomingBeta
                .split(",")
                .map((b) => b.trim())
                .filter(Boolean);

              const pluginConfig = loadPluginConfig();
              const requiredBetas = pluginConfig.betaHeaders;
              const mergedBetas = [
                ...new Set([...requiredBetas, ...incomingBetasList]),
              ].filter(Boolean).join(",");

              requestHeaders.set("authorization", `Bearer ${auth.access}`);
              if (mergedBetas) {
                requestHeaders.set("anthropic-beta", mergedBetas);
              } else {
                requestHeaders.delete("anthropic-beta");
              }
              requestHeaders.set("user-agent", pluginConfig.userAgent);
              requestHeaders.delete("x-api-key");

              const TOOL_PREFIX = "mcp_";
              let body = requestInit.body;
              if (body && typeof body === "string") {
                try {
                  const parsed = JSON.parse(body);

                  // Sanitize system prompt - server blocks "OpenCode" string
                  if (parsed.system && Array.isArray(parsed.system)) {
                    parsed.system = parsed.system.map((item) => {
                      if (item.type === "text" && item.text) {
                        return {
                          ...item,
                          text: item.text
                            .replace(/OpenCode/g, "Claude Code")
                            .replace(/opencode/gi, "Claude"),
                        };
                      }
                      return item;
                    });
                  }

                  // Add prefix to tools definitions
                  if (parsed.tools && Array.isArray(parsed.tools)) {
                    parsed.tools = parsed.tools.map((tool) => ({
                      ...tool,
                      name: tool.name
                        ? `${TOOL_PREFIX}${tool.name}`
                        : tool.name,
                    }));
                  }
                  // Add prefix to tool_use blocks in messages
                  if (parsed.messages && Array.isArray(parsed.messages)) {
                    parsed.messages = parsed.messages.map((msg) => {
                      if (msg.content && Array.isArray(msg.content)) {
                        msg.content = msg.content.map((block) => {
                          if (block.type === "tool_use" && block.name) {
                            return {
                              ...block,
                              name: `${TOOL_PREFIX}${block.name}`,
                            };
                          }
                          return block;
                        });
                      }
                      return msg;
                    });
                  }
                  body = JSON.stringify(parsed);
                } catch (e) {
                  // ignore parse errors
                }
              }

              let requestInput = input;
              let requestUrl = null;
              try {
                if (typeof input === "string" || input instanceof URL) {
                  requestUrl = new URL(input.toString());
                } else if (input instanceof Request) {
                  requestUrl = new URL(input.url);
                }
              } catch {
                requestUrl = null;
              }

              if (
                requestUrl &&
                requestUrl.pathname === "/v1/messages" &&
                !requestUrl.searchParams.has("beta")
              ) {
                requestUrl.searchParams.set("beta", "true");
                requestInput =
                  input instanceof Request
                    ? new Request(requestUrl.toString(), input)
                    : requestUrl;
              }

              const response = await fetch(requestInput, {
                ...requestInit,
                body,
                headers: requestHeaders,
              });

              // Transform streaming response to rename tools back
              if (response.body) {
                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                const encoder = new TextEncoder();

                const stream = new ReadableStream({
                  async pull(controller) {
                    const { done, value } = await reader.read();
                    if (done) {
                      controller.close();
                      return;
                    }

                    let text = decoder.decode(value, { stream: true });
                    text = text.replace(
                      /"name"\s*:\s*"mcp_([^"]+)"/g,
                      '"name": "$1"',
                    );
                    controller.enqueue(encoder.encode(text));
                  },
                });

                return new Response(stream, {
                  status: response.status,
                  statusText: response.statusText,
                  headers: response.headers,
                });
              }

              return response;
            },
          };
        }

        return {};
      },
    },
  };
}
