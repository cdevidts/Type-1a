# Plan de la próxima corrida — auditoría de UI/UX y de escenarios

Escrito al cierre de la corrida del 2026-09-03 (`0574b26`), mientras el
contexto está fresco. **No es una corrida de features**: es de cerrar cabos y
comprobar que lo construido dice la verdad en pantalla.

## Por qué esta corrida existe

Dos cosas de esta corrida la justifican:

1. El bug del IOB llevaba un día en el teléfono con un comentario que decía lo
   contrario de lo que el código hacía y un test que afirmaba el bug. Lo
   encontró Verónica usando la app, no la suite.
2. La revisión clínica levantó **diez** hallazgos sobre código recién escrito y
   verde, seis de ellos de UI: un registro que decía "ingresado a mano" sobre un
   número de la IA, una fórmula que no cuadraba con su propio total, un piso que
   pisaba una indicación médica.

El patrón es claro: lo que falla no es la lógica, es **la distancia entre lo que
el código hace y lo que la pantalla dice que hace**.

---

## Parte A — Auditoría por escenarios

El formato lo pidió ella: *"si hace 10 min comí y me corregí por un total de
7 + 3 respectivamente, y ahora quiero comer 20 g de carbohidratos, con el
cálculo actual de la app ¿cuánto me diría que me pinche? ¿es correcto?"*

Cada escenario se resuelve **con el código en la mano** —no de memoria—, se
escribe el número que la app daría, y se responde si es correcto y por qué.
Donde el número sea correcto pero la **pantalla** lo explique mal, es hallazgo
igual.

### A1 — La familia del bug que originó todo

1. Su caso literal: 7 U de comida + 3 U de corrección hace 10 min; ahora 20 g.
2. El mismo, pero con la glucosa en 260 (¿cuánto de la corrección sobrevive?).
3. El mismo, con la glucosa en 70 (¿la resta por hipo se conserva entera?).
4. Dos correcciones seguidas sin comida: ¿la segunda propone 0? ¿lo dice?
5. Sin insulina configurada en Ajustes: ¿el resultado es idéntico al de antes
   del ADR 0005, y la pantalla explica por qué no descuenta?
6. Insulina regular humana (8 h) con una dosis de hace 7 h: ¿entra a la ventana?
7. Con un override de tramo adoptado: ¿el mismo caso a las 8 am y a las 3 pm da
   números distintos, y la pantalla dice cuál duración usó?

### A2 — Agua

8. Foto de un plato con un vaso de agua → ¿se precarga, con qué procedencia?
9. Foto con un **jugo** → ¿el filtro lo descarta? ¿los carbohidratos del jugo
   quedan en la comida?
10. "Tomé un vaso de agua con el almuerzo" solo por texto → ¿`ai_text`?
11. Meta de 1.000 mL escrita a mano → ¿se respeta? ¿la barra deja de pedir más?
12. Entrada de glucosa + agua → editar la glucosa sin tocar el agua: ¿sobrevive?
13. Borrar una entrada que tenía agua → ¿desaparece del total del día?
14. Cambiar la hora de una entrada con agua → ¿el agua se mueve de día?

### A3 — Lo que se imprime

15. El PDF del médico de un día con dosis calculadas: leerlo entero y comprobar
    que cada dosis desglosada suma.
16. El Excel del mismo día.
17. El detalle de un evento de insulina con IOB descontado.

---

## Parte B — Barrido de UI/UX

Contra `contracts/ux-checklist.md`, pantalla por pantalla. **Todo `.tsx` que
esta corrida tocó**: `NutritionModal`, `SummaryModal`, `SummaryCharts`,
`UnifiedEntryModal`, `MealModal`, `MealEditModal`, `QuickNumericModal`,
`InsulinBreakdown`, `TimelineDetailModal`, `App.tsx`.

Lo que se busca, en este orden:

1. **Estados vacíos.** Cada pantalla nueva con su caso "todavía no hay nada" y
   qué hacer para que aparezca algo. La curva de efecto y la barra de agua son
   las dos más nuevas.
2. **Nada comunicado solo por color.** La barra de agua es azul; ¿lleva su
   etiqueta y su número siempre?
3. **44×44 pt** en todo lo presionable nuevo: atajos de vaso (tres sitios),
   botones de adoptar duración.
4. **Textos que tocan seguridad**: que ninguno prometa lo que la app ya no hace
   ni oculte lo que sí hace. `safetyCopy.test.ts` cubre una lista; el barrido
   busca lo que la lista no anticipó.
5. **El quinto acceso rápido.** Cinco botones en la grilla: ¿siguen cabiendo?
   ¿el orden tiene sentido, o el agua desplazó algo de más uso?
6. **Coherencia de los atajos de agua**: hay tres juegos (maestro, Comida,
   acceso rápido) con contenidos distintos. ¿Deberían compartir constante?

---

## Parte C — Cabos sueltos conocidos

- **`observeCorrectionsFrom` mezcla glucosa sintética.** La curva ya la excluye;
  la duración no. Mismo argumento, mismo arreglo.
- **`ai_text` nunca se produce desde `MealEditModal`**: ese editor declara el
  agua que la IA vio pero no la registra. Decidir si debe.
- **El agua no viaja al reporte clínico.** Está en Nutrición y en el timeline;
  no en el PDF ni en el Excel. ¿Debería?
- **`MASTER_SECTIONS` vs. lo que el maestro dibuja**: verificar que no haya otra
  sección declarada y no renderizada (así se encontró la de agua).

---

## Cómo se cierra

1. Escenarios de la Parte A resueltos con números concretos, en una tabla.
2. Hallazgos de B y C, cada uno con archivo y línea.
3. Lo que se arregle, con test.
4. `pnpm verify`, revisión clínica, commit.
5. **Ahí sí un build**, con la huella verificada contra el APK.

## Lo que NO entra

Features nuevas. Si aparece una idea, va al backlog de `activeContext.md`.
