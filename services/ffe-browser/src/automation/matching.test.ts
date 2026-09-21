import { describe, expect, it } from "vitest";
import { findBestMatch, normalizeName, type FfeSearchCandidate } from "./matching.js";

const candidate = (name: string, birthYear: number, rowIndex = 0): FfeSearchCandidate => ({
  adherentCode: "000000",
  name,
  birthYear,
  rowIndex
});

describe("normalizeName", () => {
  it("retire les accents et uniformise la casse", () => {
    expect(normalizeName("Gérard Depardïeu")).toBe("GERARD DEPARDIEU");
  });
  it("réduit les espaces multiples", () => {
    expect(normalizeName("  Jean   Paul  ")).toBe("JEAN PAUL");
  });
});

describe("findBestMatch", () => {
  const member = { firstName: "Tom", lastName: "Garnier", birthYear: 1998 };

  it("trouve une correspondance exacte", () => {
    const result = findBestMatch(member, [candidate("M GARNIER Tom", 1998)]);
    expect(result).toEqual({ outcome: "matched", candidate: candidate("M GARNIER Tom", 1998), mode: "exact" });
  });

  it("refuse une correspondance sans la bonne année de naissance", () => {
    const result = findBestMatch(member, [candidate("M GARNIER Tom", 1999)]);
    expect(result.outcome).toBe("no_match");
  });

  it("tolère une petite variation d'orthographe si l'année correspond exactement", () => {
    const result = findBestMatch(member, [candidate("M GARNIERR Tom", 1998)]);
    expect(result.outcome).toBe("matched");
  });

  it("refuse de deviner en cas d'ambiguïté (plusieurs candidats à égalité)", () => {
    const result = findBestMatch(member, [candidate("M GARNIER Tom", 1998, 0), candidate("M GARNIER Tom", 1998, 1)]);
    expect(result.outcome).toBe("ambiguous");
  });

  it("n'accepte jamais une simple ressemblance de nom sans année exacte", () => {
    const result = findBestMatch(member, [candidate("M GARNIER Thomas", 1997)]);
    expect(result.outcome).toBe("no_match");
  });

  it("aucun résultat renvoie no_match", () => {
    expect(findBestMatch(member, []).outcome).toBe("no_match");
  });
});
