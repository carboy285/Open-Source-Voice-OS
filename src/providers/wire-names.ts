/** Maps Murmur tool names (with dots) to names provider APIs accept: [a-zA-Z0-9_-]{1,64}. */
export class WireNames {
  private readonly toWire = new Map<string, string>();
  private readonly fromWire = new Map<string, string>();

  wire(name: string): string {
    const known = this.toWire.get(name);
    if (known) return known;
    let base = name
      .replace(/\./g, "__")
      .replace(/[^a-zA-Z0-9_-]/g, "_")
      .slice(0, 60);
    let candidate = base;
    for (let n = 2; this.fromWire.has(candidate); n++) candidate = `${base.slice(0, 58)}_${n}`;
    base = candidate;
    this.toWire.set(name, base);
    this.fromWire.set(base, name);
    return base;
  }

  unwire(wire: string): string {
    return this.fromWire.get(wire) ?? wire;
  }
}
