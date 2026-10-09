/**
 * A rotation pool over one provider's API keys.
 *
 * `label` names the PROVIDER for logs ("gemini", "azure", "org-gemini"), never the key: the one
 * log line that used to identify a key printed `key.slice(0, 8) + "..."`, i.e. key material in
 * another spelling. An index plus a size says which credential is in use and how many exist —
 * enough to spot "all 5 keys are cycling" or "key 1 keeps failing" — without revealing anything
 * derived from the value itself. Key material does not leave `next()` in any form.
 */
export class KeyPool {
  private idx = 0;
  private cooldownUntil = new Map<string, number>(); // key -> epoch ms

  constructor(private keys: string[], readonly label = "llm") {
    if (!keys.length) throw new Error("KeyPool: no API keys configured");
  }

  /** The entry `next()` returns, plus everything safe to log about it. */
  nextEntry(): { key: string; label: string; index: number; size: number } {
    const now = Date.now();
    for (let i = 0; i < this.keys.length; i++) {
      const k = this.keys[(this.idx + i) % this.keys.length];
      if ((this.cooldownUntil.get(k) ?? 0) <= now) {
        const index = (this.idx + i) % this.keys.length;
        this.idx = (index + 1) % this.keys.length;
        return { key: k, label: this.label, index, size: this.keys.length };
      }
    }
    let bestIdx = 0;
    let bestT = Infinity;
    for (let i = 0; i < this.keys.length; i++) {
      const t = this.cooldownUntil.get(this.keys[i]) ?? 0;
      if (t < bestT) { bestT = t; bestIdx = i; }
    }
    return { key: this.keys[bestIdx], label: this.label, index: bestIdx, size: this.keys.length };
  }

  /** Next key not in cooldown; if all are cooling down, the soonest-available one. */
  next(): string {
    return this.nextEntry().key;
  }

  penalize(key: string, ms: number): void {
    this.cooldownUntil.set(key, Date.now() + ms);
  }

  size(): number { return this.keys.length; }
}

export function poolFromEnv(varName: string, label = "llm"): KeyPool {
  const singularVar = varName.endsWith("S") ? varName.slice(0, -1) : varName;
  const raw = process.env[varName] || process.env[singularVar] || "";
  const keys = raw.split(",").map(s => s.trim()).filter(Boolean);
  return new KeyPool(keys, label);
}
