import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { fieldKey, isCampaignCurrent, normalizeGroupValue } from "./setup.js";

const baseEnvironment = {
  DATABASE_URL: "postgres://example",
  NODE_ENV: "test"
};

describe("loadConfig", () => {
  it("accepte une configuration sans HelloAsso", () => {
    const config = loadConfig(baseEnvironment);
    expect(config.helloasso.configured).toBe(false);
    expect(config.helloasso.baseUrl).toContain("sandbox");
  });

  it("accepte une configuration HelloAsso complète", () => {
    const config = loadConfig({
      ...baseEnvironment,
      HELLOASSO_CLIENT_ID: "client",
      HELLOASSO_CLIENT_SECRET: "secret",
      HELLOASSO_ORGANIZATION_SLUG: "club-test"
    });
    expect(config.helloasso.configured).toBe(true);
  });

  it("refuse une configuration HelloAsso partielle", () => {
    expect(() =>
      loadConfig({ ...baseEnvironment, HELLOASSO_CLIENT_ID: "client" })
    ).toThrow(/incomplète/);
  });

  it("charge une clé de chiffrement de réglages en base64", () => {
    const config = loadConfig({
      ...baseEnvironment,
      SETTINGS_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString("base64")
    });
    expect(config.settingsEncryptionKey).toEqual(Buffer.alloc(32, 4));
  });

  it("charge la clé publique des extensions depuis une variable base64", () => {
    const publicKey = "-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----\n";
    const config = loadConfig({
      ...baseEnvironment,
      EXTENSION_LICENSE_PUBLIC_KEY_BASE64: Buffer.from(publicKey).toString("base64")
    });
    expect(config.extensions.licensePublicKey).toBe(publicKey);
  });
});

describe("configuration HelloAsso", () => {
  it("reconnaît une campagne publique dans ses dates", () => {
    expect(
      isCampaignCurrent(
        {
          state: "Public",
          startDate: "2026-09-01T00:00:00Z",
          endDate: "2027-06-30T00:00:00Z"
        },
        new Date("2026-09-15T00:00:00Z")
      )
    ).toBe(true);
  });

  it("exclut une campagne désactivée", () => {
    expect(
      isCampaignCurrent(
        { state: "Disabled", startDate: null, endDate: null },
        new Date("2026-09-15T00:00:00Z")
      )
    ).toBe(false);
  });

  it("donne la même clé à un même champ venant de plusieurs campagnes", () => {
    expect(fieldKey("Date de naissance", "Date")).toBe(
      fieldKey("Date de naissance", "Date")
    );
  });

  it("réunit les tarifs quel que soit leur mode de paiement", () => {
    expect(normalizeGroupValue("M11 Débutant [Fleuret] - Paiement en 3 fois", true)).toBe(
      "M11 Débutant [Fleuret]"
    );
    expect(normalizeGroupValue("M9 Débutant  [Fleuret]\u00a0", true)).toBe(
      "M9 Débutant [Fleuret]"
    );
    expect(normalizeGroupValue("M9 Débutant [Fleuret] - Paiement par chèque", true)).toBe(
      "M9 Débutant [Fleuret]"
    );
  });
});
