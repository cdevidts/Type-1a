# Research sources

Verified on 2026-08-12. Product requirements and safety boundaries come first from the supplied `Type1A_Contexto_Maestro_v0.1(1).md`.

## FreeStyle and Junction

- [Junction — Abbott LibreView provider guide](https://docs.junction.com/wearables/guides/abbott-libreview): current provider slugs, practice-based `freestyle_libre` flow, supported regions, practice names, Link API, and floating-time warning.
- [LibreView patient quick-start](https://pat.libreview.com/articles/qsg/): official practice sharing flow and Practice ID behavior.
- [Abbott — What is LibreLinkUp?](https://www.support.freestyle.abbott/hc/en-us/articles/36332326812433-What-is-the-LibreLinkUp-app): intended family/friend/caregiver use, data transfer requirements, and dosing limitation.
- [Abbott — LibreLinkUp connection limit](https://www.support.freestyle.abbott/hc/en-us/articles/36336282993937-How-many-people-can-I-follow-with-my-LibreLinkUp-app): up to 20 connections and internet requirement.

The screenshot supplied with the project is the source for the current in-app wording of Libre Data Share as a temporary, healthcare-team access mechanism.

## Abacus RouteLLM

- [Abacus.AI — RouteLLM API reference](https://abacus.ai/help/developer-platform/route-llm/): base URL, bearer authentication, and `route-llm` routing model.
- [Abacus.AI — Chat Completions](https://abacus.ai/help/developer-platform/route-llm/chat-completions/): OpenAI-compatible endpoint, multimodal inputs, and structured outputs.

## Expo SDK 57

- [Expo SQLite](https://docs.expo.dev/versions/v57.0.0/sdk/sqlite/)
- [Expo Notifications](https://docs.expo.dev/versions/v57.0.0/sdk/notifications/)
- [Expo Image Picker](https://docs.expo.dev/versions/v57.0.0/sdk/imagepicker/)
- [Expo Image Manipulator](https://docs.expo.dev/versions/v57.0.0/sdk/imagemanipulator/)

Only exact SDK 57 documentation was used for the mobile implementation.

## Duración de acción de las insulinas (2026-08-25)

Fuentes de los valores de `packages/domain/src/insulin-catalog.ts`. Se usan
**solo para higiene de datos** (decidir si una dosis anterior todavía podía
estar actuando dentro de la ventana de un episodio), nunca para estimar
insulina activa ni para ningún cálculo de dosis — ver la cabecera de ese
módulo y `AGENTS.md`.

- [Cleveland Clinic — Injectable insulin medications](https://my.clevelandclinic.org/health/drugs/13902-injectable-insulin-medications):
  tabla de inicio/pico/duración por insulina. De acá salen los valores de
  lispro (Humalog), aspart (NovoRapid/NovoLog) y glulisina (Apidra), todas
  3-5 h; regular humana 5-8 h; NPH 14-24 h; detemir (Levemir) y glargina
  U-100 (Lantus/Basaglar) hasta 24 h; glargina U-300 (Toujeo) hasta 36 h;
  degludec (Tresiba) hasta 42 h.
- [Fiasp — fast-acting insulin aspart, Primary Care Notebook](https://primarycarenotebook.com/pages/diabetes-and-endocrinology/fast-acting-insulin-aspart-fiasp)
  y el meta-análisis de [aspart rápida vs. aspart en bomba (PMC9925142)](https://pmc.ncbi.nlm.nih.gov/articles/PMC9925142/):
  Fiasp adelanta el inicio ~5 min y adelanta el fin de exposición ~12 min
  respecto de aspart, con ~10 min menos de tiempo al pico. **La duración
  total se queda en el mismo rango de 3-5 h**, por eso el catálogo le asigna
  las mismas 5 h que a NovoRapid en vez de un número menor. Lyumjev es el
  equivalente dentro de la familia de lispro y recibe el mismo trato.

**Por qué se toma el extremo alto del rango** (5 h y no 4, 42 h y no 40):
para excluir un episodio confundido conviene errar por exceso. Excluir de
más cuesta muestra —y el `n` se muestra en pantalla y en el reporte—;
excluir de menos publica como patrón un promedio contaminado, que es el daño
que esta exclusión existe para evitar.

**Y por qué las elige la usuaria y no la app**: `AGENTS.md` prohíbe inferir
parámetros de terapia. Estos números son el dato del fabricante, no una
estimación de la app sobre esa persona, y se pueden sobrescribir con lo que
haya indicado su equipo clínico.
