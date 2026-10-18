/** Keychain access. The shell backs this with macOS Keychain or Windows Credential Manager. */
export interface SecretStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export class MemorySecretStore implements SecretStore {
  readonly values = new Map<string, string>();
  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }
  async set(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

/** Remembers which keys Murmur wrote (names only), so "Delete all data" can remove them. */
export class IndexedSecretStore implements SecretStore {
  constructor(
    private readonly inner: SecretStore,
    private readonly index: { read(): string[]; write(keys: string[]): void },
  ) {}
  get(key: string): Promise<string | undefined> {
    return this.inner.get(key);
  }
  async set(key: string, value: string): Promise<void> {
    await this.inner.set(key, value);
    const keys = this.index.read();
    if (!keys.includes(key)) this.index.write([...keys, key]);
  }
  async delete(key: string): Promise<void> {
    await this.inner.delete(key);
    this.index.write(this.index.read().filter((k) => k !== key));
  }
  async deleteAll(): Promise<void> {
    for (const key of this.index.read()) await this.inner.delete(key);
    this.index.write([]);
  }
}

/** Prefix of a value that points into the keychain instead of holding the secret. */
export const SECRET_REF_PREFIX = "keychain:";

const SECRET_NAME = /token|key|secret|password|authorization|cookie/i;

/** Header and env names whose values must not be written to config files. */
export const looksSecret = (name: string) => SECRET_NAME.test(name);
export const isSecretRef = (value: string) => value.startsWith(SECRET_REF_PREFIX);
export const secretRef = (key: string) => `${SECRET_REF_PREFIX}${key}`;
export const refKey = (value: string) => value.slice(SECRET_REF_PREFIX.length);
