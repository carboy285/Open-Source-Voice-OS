import { createHash } from "node:crypto";

/** Maps Murmur tool names (with dots) to names provider APIs accept: [a-zA-Z0-9_-]{1,64}. */
export class WireNames {
  private readonly toWire = new Map<string, string>();
  private readonly fromWire = new Map<string, string>();

  wire(name: string): string {
    const known = this.toWire.get(name);
    if (known) return known;
    const base = name.replace(/\./g, "__").replace(/[^a-zA-Z0-9_-]/g, "_");
    // Hash lossy names before registration so reordering tools never changes a name used in history.
    const lossy = !base || base.length > 64 || /[^a-zA-Z0-9_.-]|__|_\.|\._/.test(name);
    const hash = createHash("sha256").update(name).digest("hex").slice(0, 16);
    const wire = lossy ? `${base.slice(0, 47)}_${hash}` : base;
    if (this.fromWire.has(wire) && this.fromWire.get(wire) !== name)
      throw new Error(`Tool wire-name collision: ${wire}`);
    this.toWire.set(name, wire);
    this.fromWire.set(wire, name);
    return wire;
  }

  unwire(wire: string): string {
    return this.fromWire.get(wire) ?? wire;
  }
}
