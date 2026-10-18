import { MODELS } from "./catalog.js";
import type { ModelManager } from "./manager.js";

export interface ModelsCliDeps {
  manager: ModelManager;
  out: (line: string) => void;
  /** Reads and writes the active model and engine (the same settings the app uses). */
  getActive: () => string;
  setActive: (id: string) => void;
}

const mb = (bytes: number) => `${Math.round(bytes / 1_000_000)} MB`;

/** `murmur models [list | download <id> | use <id> | remove <id>]` */
export async function runModelsCli(args: string[], deps: ModelsCliDeps): Promise<number> {
  const [command = "list", id] = args;
  const { manager, out } = deps;
  const known = (value: string | undefined) => MODELS.some((m) => m.id === value);

  switch (command) {
    case "list": {
      const active = deps.getActive();
      for (const m of manager.list()) {
        const state = m.installed ? (m.id === active ? "in use" : "downloaded") : `about ${m.approxMB} MB`;
        out(
          `${m.id === active ? "*" : " "} ${m.id.padEnd(28)} ${m.variant.padEnd(9)} ${state}${m.recommended ? " (recommended)" : ""}`,
        );
      }
      out(`Models are stored in ${manager.dir}`);
      return 0;
    }
    case "download": {
      if (!known(id)) return usage(out);
      let lastPercent = -1;
      const path = await manager.download(id!, ({ received, total }) => {
        const percent = total ? Math.floor((received / total) * 100) : -1;
        if (percent !== lastPercent && percent % 10 === 0) {
          lastPercent = percent;
          out(total ? `${percent}% (${mb(received)} of ${mb(total)})` : mb(received));
        }
      });
      out(`Saved ${path}`);
      if (!deps.getActive()) {
        deps.setActive(id!);
        out(`Murmur now uses ${id}.`);
      }
      return 0;
    }
    case "use": {
      if (!known(id)) return usage(out);
      if (!manager.isInstalled(id!)) {
        out(`Download it first: murmur models download ${id}`);
        return 1;
      }
      deps.setActive(id!);
      out(`Murmur now uses ${id}.`);
      return 0;
    }
    case "remove": {
      if (!known(id)) return usage(out);
      manager.remove(id!);
      if (deps.getActive() === id) deps.setActive("");
      out(`Removed ${id}.`);
      return 0;
    }
    default:
      return usage(out);
  }
}

function usage(out: (line: string) => void): number {
  out("Usage: murmur models [list | download <id> | use <id> | remove <id>]");
  out(`Models: ${MODELS.map((m) => m.id).join(", ")}`);
  return 2;
}
