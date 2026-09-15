import { getServiceClient } from "../db.js";
import { AccessError, assertOrgAccess, type Role } from "./authz.js";
import { KeyPool } from "../llm/keyPool.js";
import { GEMINI_MODELS } from "../llm/gemini.js";
import type { LlmConfig } from "../llm/llmContext.js";
import {
  decryptSecret, encryptSecret, requireCustody, secretFingerprint, secretHint,
  SecretConfigError, type SealedSecret,
} from "./secretStore.js";

/**
 * Per-organisation LLM configuration — an organisation's own Gemini key, model and budget.
 *
 * Behind `ORG_LLM_CONFIG_ENABLED`, default OFF (`CLAUDE.md` rule 2). With the flag off nothing
 * here is reachable: the routes 404 and `llmConfigForOrg` returns null, so every run uses exactly
 * the process-wide env pool and `GEMINI_MODEL` it used before this file existed.
 *
 * THE KEY IS WRITE-ONLY. It goes in through `setOrgLlmConfig` and comes back out in exactly one
 * place — `llmConfigForOrg`, which builds an in-memory `KeyPool` for a run. It is never returned
 * by a read function, never logged, never put in an event, and never written to a run artifact.
 * `describeOrgLlmConfig` is the shape every client sees, and it cannot express a key.
 */

export function orgLlmConfigEnabled(): boolean {
  return process.env.ORG_LLM_CONFIG_ENABLED === "true";
}

function requireClient() {
  const client = getServiceClient();
  if (!client) {
    throw new AccessError(503, "the database is not configured — set DB_ENABLED=true and SUPABASE_SERVICE_ROLE_KEY");
  }
  return client;
}

function requireEnabled(): void {
  if (!orgLlmConfigEnabled()) {
    throw new AccessError(404, "per-organisation LLM configuration is not available — this server has ORG_LLM_CONFIG_ENABLED off");
  }
}

/** What a client is allowed to know. Note there is no field that could carry a key. */
export interface OrgLlmConfigView {
  organisationId: string;
  /** Whether a key is stored. The only thing a client learns about the key's existence. */
  keySet: boolean;
  /** Last four characters, e.g. "••••3f9a" — so an admin can tell WHICH key, never read it. */
  keyHint: string | null;
  model: string | null;
  modelLite: string | null;
  maxCallsPerRun: number | null;
  updatedAt: string | null;
  updatedBy: string | null;
  /** The models this server offers. Served with the config so the UI has one source of truth. */
  availableModels: string[];
  /** True when the server can encrypt at all — an admin needs to know before trying. */
  custodyConfigured: boolean;
}

interface ConfigRow {
  organisation_id: string;
  key_ct: string | null; key_iv: string | null; key_tag: string | null; key_custody: string | null;
  key_fingerprint: string | null; key_hint: string | null;
  model: string | null; model_lite: string | null;
  max_calls_per_run: number | null;
  updated_at: string | null; updated_by: string | null;
}

async function readRow(organisationId: string): Promise<ConfigRow | null> {
  const client = requireClient();
  const { data, error } = await client
    .from("org_llm_config").select("*").eq("organisation_id", organisationId).maybeSingle();
  if (error) throw new AccessError(500, `could not read LLM configuration: ${error.message}`);
  return (data as ConfigRow | null) ?? null;
}

/** The admin panel's read. Requires admin on the organisation — never returns key material. */
export async function describeOrgLlmConfig(
  userId: string, organisationId: string,
): Promise<OrgLlmConfigView> {
  requireEnabled();
  // The authorization boundary. An admin of org A asking for org B lands here and is refused;
  // there is no code path that reads a row before this resolves.
  await assertOrgAccess(userId, organisationId, "admin");

  const row = await readRow(organisationId);
  let custodyConfigured = true;
  try { requireCustody(); } catch { custodyConfigured = false; }

  return {
    organisationId,
    keySet: !!(row?.key_ct && row?.key_iv && row?.key_tag),
    keyHint: row?.key_hint ?? null,
    model: row?.model ?? null,
    modelLite: row?.model_lite ?? null,
    maxCallsPerRun: row?.max_calls_per_run ?? null,
    updatedAt: row?.updated_at ?? null,
    updatedBy: row?.updated_by ?? null,
    availableModels: [...GEMINI_MODELS],
    custodyConfigured,
  };
}

/**
 * Ask the provider which models THIS key can actually use.
 *
 * The allowlist in `gemini.ts` stops typos; this stops the allowlist from lying. A hardcoded list
 * goes stale every time Google ships or retires a model, and the cost of being wrong is a run
 * that dies at its first LLM call after discovery has already launched a browser. One cheap call
 * at save time moves that failure to the moment a person can fix it.
 *
 * Returns the model ids the key may call. Throws `AccessError(400)` if the key itself is bad,
 * which is the other thing worth learning before storing it.
 */
export async function verifyGeminiCredentials(apiKey: string): Promise<string[]> {
  let res: Response;
  try {
    res = await fetch("https://generativelanguage.googleapis.com/v1beta/models", {
      headers: { "x-goog-api-key": apiKey },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new AccessError(502, `could not reach Gemini to verify the key: ${(err as Error)?.message ?? err}`);
  }
  if (res.status === 400 || res.status === 401 || res.status === 403) {
    // Deliberately does not echo the provider's body — it can quote the key back.
    throw new AccessError(400, "Gemini rejected that API key. Check it and try again.");
  }
  if (!res.ok) {
    throw new AccessError(502, `Gemini could not be queried for its model list (HTTP ${res.status}).`);
  }
  const body = await res.json() as { models?: { name?: string }[] };
  // Names come back as "models/gemini-3.6-flash".
  return (body.models ?? [])
    .map((m) => (m.name ?? "").replace(/^models\//, ""))
    .filter(Boolean);
}

export interface SetOrgLlmConfigInput {
  /** New key. `undefined` leaves the stored one alone; `null` removes it. Never read back. */
  apiKey?: string | null;
  model?: string | null;
  modelLite?: string | null;
  maxCallsPerRun?: number | null;
}

/**
 * Write an organisation's configuration. Admin or owner only.
 *
 * A model is validated twice before it is stored: against `GEMINI_MODELS`, and against what the
 * provider says this key can call. A typo therefore fails here, with a message, instead of
 * failing mid-run.
 */
export async function setOrgLlmConfig(
  userId: string, organisationId: string, input: SetOrgLlmConfigInput,
): Promise<OrgLlmConfigView> {
  requireEnabled();
  await assertOrgAccess(userId, organisationId, "admin");
  const client = requireClient();

  const existing = await readRow(organisationId);
  const patch: Record<string, unknown> = {
    organisation_id: organisationId,
    updated_at: new Date().toISOString(),
    updated_by: userId,
  };

  // --- the key -------------------------------------------------------------
  let keyForVerification: string | null = null;
  if (input.apiKey === null) {
    patch.key_ct = null; patch.key_iv = null; patch.key_tag = null;
    patch.key_custody = null; patch.key_fingerprint = null; patch.key_hint = null;
  } else if (typeof input.apiKey === "string") {
    const key = input.apiKey.trim();
    if (!key) throw new AccessError(400, "an API key cannot be empty — send null to remove it");
    keyForVerification = key;

    let sealed: SealedSecret;
    try {
      sealed = encryptSecret(key);
    } catch (err) {
      if (err instanceof SecretConfigError) throw new AccessError(503, err.message);
      throw err;
    }
    patch.key_ct = sealed.ct; patch.key_iv = sealed.iv; patch.key_tag = sealed.tag;
    patch.key_custody = sealed.custody;
    patch.key_fingerprint = secretFingerprint(key);
    patch.key_hint = secretHint(key);
  } else if (existing?.key_ct && existing.key_iv && existing.key_tag) {
    // Model change with no new key: verify against the key already stored, so "this model does
    // not work with your key" is still caught. The column names differ from SealedSecret's
    // fields, so this maps explicitly rather than casting — a cast here silently produced an
    // undefined ciphertext and made every verification fail open.
    try {
      keyForVerification = decryptSecret({
        ct: existing.key_ct, iv: existing.key_iv, tag: existing.key_tag,
        custody: existing.key_custody ?? "unknown",
      });
    } catch { keyForVerification = null; }
  }

  // --- the models ----------------------------------------------------------
  const wanted: string[] = [];
  for (const [field, column] of [["model", "model"], ["modelLite", "model_lite"]] as const) {
    const value = input[field as "model" | "modelLite"];
    if (value === undefined) continue;
    if (value === null) { patch[column] = null; continue; }
    const name = String(value).trim();
    if (!(GEMINI_MODELS as readonly string[]).includes(name)) {
      throw new AccessError(
        400,
        `"${name}" is not a model this server offers. Choose one of: ${GEMINI_MODELS.join(", ")}.`,
      );
    }
    wanted.push(name);
    patch[column] = name;
  }

  if (wanted.length > 0 && keyForVerification) {
    const usable = await verifyGeminiCredentials(keyForVerification);
    // An empty list means the provider answered but told us nothing useful; do not fail a save
    // over that, since the allowlist check above already ran.
    if (usable.length > 0) {
      const rejected = wanted.filter((m) => !usable.includes(m));
      if (rejected.length > 0) {
        throw new AccessError(
          400,
          `Gemini reports that this API key cannot use ${rejected.join(", ")}. ` +
          `Models available to this key include: ${usable.slice(0, 8).join(", ")}.`,
        );
      }
    }
  } else if (keyForVerification && input.apiKey) {
    // A key with no model change still gets proved before it is stored.
    await verifyGeminiCredentials(keyForVerification);
  }

  if (input.maxCallsPerRun !== undefined) {
    const n = input.maxCallsPerRun;
    if (n !== null && (!Number.isFinite(n) || n < 1)) {
      throw new AccessError(400, "maxCallsPerRun must be a positive number, or null to use the server default");
    }
    patch.max_calls_per_run = n;
  }

  const { error } = await client.from("org_llm_config").upsert(patch, { onConflict: "organisation_id" });
  if (error) throw new AccessError(500, `could not save LLM configuration: ${error.message}`);

  return describeOrgLlmConfig(userId, organisationId);
}

/**
 * The run-time read: build an `LlmConfig` for one organisation, or null to use the env.
 *
 * THE ONLY PLACE A STORED KEY IS DECRYPTED. It goes straight into an in-memory `KeyPool` for the
 * duration of one run and is never returned to a caller, so there is no path from here to a
 * response body, a log line, an event or an artifact.
 *
 * Never throws for an unconfigured organisation: a server with the flag off, a row that does not
 * exist, or a key sealed by custody this process cannot open all degrade to "use the env", which
 * is the behaviour every organisation had before this feature. A broken key must not take runs
 * down — it must make them behave as they did last week, loudly in the log and quietly in the run.
 */
export async function llmConfigForOrg(organisationId: string | null): Promise<LlmConfig | null> {
  if (!orgLlmConfigEnabled() || !organisationId) return null;

  let row: ConfigRow | null;
  try {
    row = await readRow(organisationId);
  } catch (err) {
    console.error(`[llm-config] could not read configuration for org ${organisationId}:`, (err as Error)?.message ?? err);
    return null;
  }
  if (!row) return null;

  let pool: KeyPool | null = null;
  let fingerprint = "env";
  if (row.key_ct && row.key_iv && row.key_tag) {
    try {
      const key = decryptSecret({
        ct: row.key_ct, iv: row.key_iv, tag: row.key_tag, custody: row.key_custody ?? "unknown",
      });
      pool = new KeyPool(key.split(",").map((s) => s.trim()).filter(Boolean));
      fingerprint = row.key_fingerprint ?? "org";
    } catch (err) {
      // Says which organisation and why, never what. Falling back to the env key is the safe
      // direction: the run still happens, billed to the server's key, and the admin can see why.
      console.error(
        `[llm-config] org ${organisationId} has a stored API key that cannot be decrypted ` +
        `(${(err as Error)?.message ?? err}) — falling back to the server's own key for this run.`,
      );
      pool = null;
    }
  }

  if (!pool && !row.model && !row.model_lite) return null;

  return {
    pool,
    model: row.model,
    modelLite: row.model_lite,
    // When the org supplies no key of its own, its runs share the env key AND the env cache
    // entries — correct, because they are literally the same requests to the same credential.
    keyFingerprint: fingerprint,
    organisationId,
  };
}

/** An organisation's per-run call ceiling, or null for the shared `MAX_LLM_CALLS_PER_RUN`. */
export async function maxCallsForOrg(organisationId: string | null): Promise<number | null> {
  if (!orgLlmConfigEnabled() || !organisationId) return null;
  try {
    const row = await readRow(organisationId);
    return row?.max_calls_per_run ?? null;
  } catch {
    return null;
  }
}
