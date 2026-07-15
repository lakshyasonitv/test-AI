export class KeyPool {
  private idx = 0;
  private cooldownUntil = new Map<string, number>(); // key -> epoch ms

  constructor(private keys: string[]) {
    if (!keys.length) throw new Error("KeyPool: no API keys configured");
  }

  /** Next key not in cooldown; if all are cooling down, the soonest-available one. */
  next(): string {
    const now = Date.now();
    for (let i = 0; i < this.keys.length; i++) {
      const k = this.keys[(this.idx + i) % this.keys.length];
      if ((this.cooldownUntil.get(k) ?? 0) <= now) {
        this.idx = (this.idx + i + 1) % this.keys.length;
        return k;
      }
    }
    let best = this.keys[0];
    let bestT = Infinity;
    for (const k of this.keys) {
      const t = this.cooldownUntil.get(k) ?? 0;
      if (t < bestT) { bestT = t; best = k; }
    }
    return best;
  }

  penalize(key: string, ms: number): void {
    this.cooldownUntil.set(key, Date.now() + ms);
  }

  size(): number { return this.keys.length; }
}

export function poolFromEnv(varName: string): KeyPool {
  const keys = (process.env[varName] ?? "")
    .split(",").map(s => s.trim()).filter(Boolean);
  return new KeyPool(keys);
}
