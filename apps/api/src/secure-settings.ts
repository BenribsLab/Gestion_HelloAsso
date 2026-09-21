import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Database } from "./db.js";

type StoredSetting<TPublic> = {
  publicValue: TPublic;
  encryptedValue: string | null;
  updatedAt: Date;
};

type EncryptedPayload = {
  version: 1;
  iv: string;
  tag: string;
  ciphertext: string;
};

export class SecureSettingsStore {
  constructor(
    private readonly database: Database,
    private readonly encryptionKey: Buffer | null
  ) {}

  canWriteSecrets() {
    return this.encryptionKey !== null;
  }

  async read<TPublic extends object, TSecret extends object>(namespace: string) {
    const result = await this.database.query<StoredSetting<TPublic>>(`
      SELECT public_value AS "publicValue", encrypted_value AS "encryptedValue", updated_at AS "updatedAt"
      FROM secure_settings WHERE namespace = $1
    `, [validNamespace(namespace)]);
    const row = result.rows[0];
    if (!row) return null;
    return {
      publicValue: row.publicValue,
      secretValue: row.encryptedValue ? this.decrypt<TSecret>(namespace, row.encryptedValue) : null,
      updatedAt: row.updatedAt
    };
  }

  async write<TPublic extends object, TSecret extends object>(
    namespace: string,
    publicValue: TPublic,
    secretValue: TSecret | null,
    userId: string | null
  ) {
    const encryptedValue = secretValue === null ? null : this.encrypt(namespace, secretValue);
    await this.database.query(`
      INSERT INTO secure_settings (namespace, public_value, encrypted_value, updated_by)
      VALUES ($1, $2::jsonb, $3, $4)
      ON CONFLICT (namespace) DO UPDATE SET
        public_value = EXCLUDED.public_value,
        encrypted_value = EXCLUDED.encrypted_value,
        updated_by = EXCLUDED.updated_by,
        updated_at = now()
    `, [validNamespace(namespace), JSON.stringify(publicValue), encryptedValue, userId]);
  }

  async delete(namespace: string) {
    await this.database.query("DELETE FROM secure_settings WHERE namespace = $1", [validNamespace(namespace)]);
  }

  private encrypt(namespace: string, value: object) {
    if (!this.encryptionKey) {
      throw new SecureSettingsError(
        409,
        "Le stockage des secrets n'est pas configuré sur cette instance. Configurez SETTINGS_ENCRYPTION_KEY_FILE."
      );
    }
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.encryptionKey, iv);
    cipher.setAAD(Buffer.from(namespace, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    const payload: EncryptedPayload = {
      version: 1,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64")
    };
    return JSON.stringify(payload);
  }

  private decrypt<TSecret>(namespace: string, encoded: string): TSecret {
    if (!this.encryptionKey) {
      throw new SecureSettingsError(503, "La clé de déchiffrement des réglages est absente.");
    }
    try {
      const payload = JSON.parse(encoded) as EncryptedPayload;
      if (payload.version !== 1) throw new Error("version inconnue");
      const decipher = createDecipheriv("aes-256-gcm", this.encryptionKey, Buffer.from(payload.iv, "base64"));
      decipher.setAAD(Buffer.from(namespace, "utf8"));
      decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
      return JSON.parse(Buffer.concat([
        decipher.update(Buffer.from(payload.ciphertext, "base64")),
        decipher.final()
      ]).toString("utf8")) as TSecret;
    } catch {
      throw new SecureSettingsError(500, `Impossible de déchiffrer les réglages ${namespace}.`);
    }
  }
}

export class SecureSettingsError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}

export function parseEncryptionKey(value: string) {
  if (!value) return null;
  const decoded = /^[a-f0-9]{64}$/i.test(value)
    ? Buffer.from(value, "hex")
    : Buffer.from(value, "base64");
  if (decoded.length !== 32) {
    throw new Error("SETTINGS_ENCRYPTION_KEY doit représenter exactement 32 octets (base64 ou hexadécimal).");
  }
  return decoded;
}

function validNamespace(value: string) {
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(value) || value.length > 120) {
    throw new SecureSettingsError(400, "Espace de réglages invalide.");
  }
  return value;
}
