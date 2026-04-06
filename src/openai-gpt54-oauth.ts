type VariantMap = Record<string, Record<string, unknown>>;

type ModelShape = {
  id: string;
  providerID: string;
  api: {
    id: string;
    npm?: string;
    url?: string;
  };
  name: string;
  family?: string;
  capabilities: {
    temperature: boolean;
    reasoning: boolean;
    attachment: boolean;
    toolcall: boolean;
    input: {
      text: boolean;
      audio: boolean;
      image: boolean;
      video: boolean;
      pdf: boolean;
    };
    output: {
      text: boolean;
      audio: boolean;
      image: boolean;
      video: boolean;
      pdf: boolean;
    };
    interleaved: boolean | { field: "reasoning_content" | "reasoning_details" };
  };
  cost: {
    input: number;
    output: number;
    cache: {
      read: number;
      write: number;
    };
  };
  limit: {
    context: number;
    input?: number;
    output: number;
  };
  status: "alpha" | "beta" | "deprecated" | "active";
  options: Record<string, unknown>;
  headers: Record<string, string>;
  release_date: string;
  variants: VariantMap;
};

type ProviderShape = {
  models: Record<string, ModelShape>;
};

type AuthShape = {
  type: string;
};

function cloneModel(
  base: ModelShape,
  id: string,
  name: string,
  family: string,
  variants: VariantMap,
  apiID?: string,
): ModelShape {
  return {
    ...base,
    id,
    name,
    family,
    api: {
      ...base.api,
      id: apiID ?? id,
    },
    capabilities: {
      ...base.capabilities,
      reasoning: true,
      attachment: true,
      toolcall: true,
      input: {
        ...base.capabilities.input,
        text: true,
        image: true,
      },
      output: {
        ...base.capabilities.output,
        text: true,
      },
    },
    status: "active",
    release_date: "2026-03-05",
    variants,
  };
}

const GPT54_VARIANTS: VariantMap = {
  none: {
    reasoningEffort: "none",
    reasoningSummary: "auto",
    include: ["reasoning.encrypted_content"],
    textVerbosity: "medium",
  },
  low: {
    reasoningEffort: "low",
    reasoningSummary: "auto",
    include: ["reasoning.encrypted_content"],
    textVerbosity: "medium",
  },
  medium: {
    reasoningEffort: "medium",
    reasoningSummary: "auto",
    include: ["reasoning.encrypted_content"],
    textVerbosity: "medium",
  },
  high: {
    reasoningEffort: "high",
    reasoningSummary: "detailed",
    include: ["reasoning.encrypted_content"],
    textVerbosity: "medium",
  },
  xhigh: {
    reasoningEffort: "xhigh",
    reasoningSummary: "detailed",
    include: ["reasoning.encrypted_content"],
    textVerbosity: "medium",
  },
};

const GPT54_PRO_VARIANTS: VariantMap = {
  medium: {
    reasoningEffort: "medium",
    reasoningSummary: "detailed",
    include: ["reasoning.encrypted_content"],
    textVerbosity: "medium",
  },
  high: {
    reasoningEffort: "high",
    reasoningSummary: "detailed",
    include: ["reasoning.encrypted_content"],
    textVerbosity: "medium",
  },
  xhigh: {
    reasoningEffort: "xhigh",
    reasoningSummary: "detailed",
    include: ["reasoning.encrypted_content"],
    textVerbosity: "medium",
  },
};

export default async function OpenAIGpt54OAuthPlugin() {
  return {
    auth: {
      provider: "openai",
      methods: [],
      async loader(getAuth: () => Promise<AuthShape>, provider: ProviderShape) {
        const auth = await getAuth();
        if (auth.type !== "oauth") return {};

        const template = provider.models["gpt-5.2"] ?? provider.models["gpt-5-codex"] ?? Object.values(provider.models)[0];
        if (!template) return {};

        if (!provider.models["gpt-5.4"]) {
          provider.models["gpt-5.4"] = cloneModel(template, "gpt-5.4", "GPT 5.4 (OAuth)", "gpt", GPT54_VARIANTS);
        }

        if (!provider.models["gpt-5.4-pro"]) {
          provider.models["gpt-5.4-pro"] = cloneModel(
          template,
          "gpt-5.4-pro",
          "GPT 5.4 Pro (OAuth)",
          "gpt-pro",
          GPT54_PRO_VARIANTS,
          "gpt-5.4",
        );
      }

        return {};
      },
    },
  };
}
