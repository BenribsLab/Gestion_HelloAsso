import { describe, expect, it } from "vitest";
import type { Database } from "./db.js";
import { parseEncryptionKey, SecureSettingsStore } from "./secure-settings.js";

describe("stockage chiffré des réglages", () => {
  it("chiffre le secret et le relit dans son espace de noms", async () => {
    const state: { row: { publicValue: object; encryptedValue: string | null; updatedAt: Date } | null } = { row: null };
    const database = {
      query: async (sql: string, params: unknown[] = []) => {
        if (sql.includes("SELECT public_value")) return { rows: state.row ? [state.row] : [], rowCount: state.row ? 1 : 0 };
        if (sql.includes("INSERT INTO secure_settings")) {
          state.row = {
            publicValue: JSON.parse(String(params[1])),
            encryptedValue: params[2] as string,
            updatedAt: new Date("2026-09-21T10:00:00Z")
          };
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes("DELETE FROM secure_settings")) { state.row = null; return { rows: [], rowCount: 1 }; }
        throw new Error(`Requête inattendue : ${sql}`);
      }
    } as unknown as Database;
    const store = new SecureSettingsStore(database, Buffer.alloc(32, 7));

    await store.write("core.helloasso", { clientId: "client" }, { clientSecret: "très-secret" }, null);

    expect(state.row?.encryptedValue).not.toContain("très-secret");
    await expect(store.read<{ clientId: string }, { clientSecret: string }>("core.helloasso")).resolves.toMatchObject({
      publicValue: { clientId: "client" },
      secretValue: { clientSecret: "très-secret" }
    });
  });

  it("refuse l'écriture d'un secret sans clé d'instance", async () => {
    const database = { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as Database;
    const store = new SecureSettingsStore(database, null);
    await expect(store.write("core.helloasso", {}, { secret: "x" }, null)).rejects.toThrow(/SETTINGS_ENCRYPTION_KEY_FILE/);
  });

  it("accepte une clé de 32 octets en base64 ou hexadécimal", () => {
    expect(parseEncryptionKey(Buffer.alloc(32, 1).toString("base64"))).toHaveLength(32);
    expect(parseEncryptionKey(Buffer.alloc(32, 1).toString("hex"))).toHaveLength(32);
    expect(() => parseEncryptionKey("trop-court")).toThrow(/32 octets/);
  });
});
