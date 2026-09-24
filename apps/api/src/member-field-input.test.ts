import { describe, expect, it } from "vitest";
import { inferMemberFieldInput } from "./setup.js";

describe("inferMemberFieldInput", () => {
  it("utilise une liste pour un champ de choix déclaré par HelloAsso", () => {
    expect(inferMemberFieldInput("ChoiceList", ["Homme", "Femme"])).toEqual({
      inputMode: "select",
      options: ["Femme", "Homme"]
    });
  });

  it("détecte une petite liste récurrente dans un champ générique", () => {
    expect(inferMemberFieldInput("TextInput", ["Droitier", "Gaucher", "Droitier", "Droitier", "Gaucher"])).toEqual({
      inputMode: "select",
      options: ["Droitier", "Gaucher"]
    });
  });

  it("ne transforme pas deux réponses isolées en liste fermée", () => {
    expect(inferMemberFieldInput("TextInput", ["Paris", "Yerres"])).toEqual({
      inputMode: "text",
      options: ["Paris", "Yerres"]
    });
  });

  it("fusionne les variantes de casse sans dupliquer les choix", () => {
    expect(inferMemberFieldInput("ChoiceList", ["Homme", " homme ", "Femme"])).toEqual({
      inputMode: "select",
      options: ["Femme", "homme"]
    });
  });
});
