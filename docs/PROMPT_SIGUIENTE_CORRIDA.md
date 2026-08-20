# Prompt para la corrida siguiente — Fase 16

Copiar y pegar **todo lo que está dentro del bloque**. Está escrito para que la
corrida no gaste tokens re-explorando: las decisiones ya están tomadas y los
archivos y constantes ya están localizados.

---

```
Fase 16 del roadmap (barra inferior, swipe, iconos SVG, marcas de hora). Todo
es JS, no toca nada nativo, así que no requiere build hasta el final.

Lee primero docs/ROADMAP_V0.2.md § "Fase 16" — está el detalle completo y las
decisiones ya tomadas. No re-explores el repo: los datos que necesitas están
abajo. Invoca /app-shell y /iconography (son del repo, disparo automático).

TRABAJO, en este orden:

1. ICONOS. Usa lucide-react-native, que YA está instalado (v1.33, ISC,
   construido sobre react-native-svg). NO dibujes SVG a mano. Importa por
   nombre, nunca `import *` (mata el tree-shaking).
   CRÍTICO: importa por subpath, no por nombre desde el barrel. Metro no hace
   tree-shaking y el barrel mete los ~1.500 iconos (medido: 1.263 → 3.088
   módulos; por subpath quedan 1.316).
     import Plus from 'lucide-react-native/icons/plus';   // ✅
     import { Plus } from 'lucide-react-native';          // ❌
   El archivo va en kebab-case: UtensilsCrossed → icons/utensils-crossed.
   size=24, color desde theme.ts, strokeWidth por defecto.
   Crea apps/mobile/src/branding.ts con `export const APP_LOGO = require(...)`
   apuntando a apps/mobile/assets/icon.png. Ningún componente puede escribir
   el nombre del archivo — solo la variable.

2. BARRA INFERIOR. Componente nuevo apps/mobile/src/components/BottomNav.tsx.
   Cinco destinos: Nutrición | Catálogo | (+) | Chat IA | Resumen.
   - El (+) va al centro, más grande, fondo colors.teal — es la acción
     primaria.
   - El botón de Chat IA usa APP_LOGO y queda inerte (Fase 8): al tocarlo,
     un aviso de que aún no está.
   - El de Catálogo también queda inerte hasta la Fase 18, con su aviso.
   - Fija: position absolute, bottom 0. Suma useSafeAreaInsets().bottom al
     padding — con edge-to-edge la barra de Android tapa el contenido. NO
     ocultes la barra del sistema.
   - 44x44 mínimo tocable en los cinco.

3. MOVER, NO DUPLICAR. En App.tsx:
   - Elimina el Pressable de styles.entryButton (línea ~787, el botón grande
     "Nueva entrada" del cuerpo) — su función pasa al (+) de la barra.
   - Los botones ◔ (Resumen) y ◍ (Nutrición) de la barra superior se eliminan
     de arriba y pasan a la barra inferior.
   - Ajustes (•••) SE QUEDA arriba a la derecha, pero con icono SVG.
   - Agrega paddingBottom al ScrollView de la pantalla principal para que la
     barra no tape la última tarjeta.

4. SWIPE. PanResponder (sin librería nueva) para navegar lateralmente entre
   los cinco destinos, en el mismo orden que la barra.
   CUIDADO: GlucoseChart es un ScrollView HORIZONTAL. El reconocedor debe
   exigir |dx| claramente mayor que |dy| y no activarse si el gesto empezó
   sobre el gráfico, o le robas el scroll al gráfico principal.

5. MARCAS DE HORA. apps/mobile/src/components/GlucoseChart.tsx:
   HOUR_TICK_STEP (línea 26) pasa de 6 a 1.
   PROBLEMA A RESOLVER: PIXELS_PER_HOUR es 30 (línea 14); con una etiqueta por
   hora se solapan. Dibuja la LÍNEA de cada hora pero etiqueta solo cada 2 o 3
   según quepa (o sube PIXELS_PER_HOUR). Líneas finas en colors.line,
   etiquetas en colors.muted.

CIERRE OBLIGATORIO (CLAUDE.md § Cierre de corrida):
- pnpm verify en verde.
- npx expo export:embed --eager --platform android --dev false desde
  apps/mobile, para reproducir el bundle de Metro ANTES de gastar build.
- Actualiza docs/CODE_MAP.md (BottomNav, icons/, branding.ts) y marca la
  Fase 16 como completada en docs/ROADMAP_V0.2.md.
- docs/DEEPAGENT_REDEPLOY_PROMPT.md: agrega la fila "no requirió redeploy".
- domain-safety-reviewer NO hace falta si no tocas packages/domain ni textos
  sobre dosis. Si terminas tocándolos, sí.
- Commit + push a claude/revision-build-prep-b6p20n.

Si sobra contexto después de la Fase 16, sigue con la Fase 17 (editar con IA)
leyendo su sección del roadmap. Si no, para en un commit limpio y dime dónde
quedaste.

Haz el build al final solo si todo quedó verde.
```

---

## Por qué este prompt y no otro

- **La Fase 16 es la base de las demás.** Las Fases 17 y 18 agregan pantallas
  que tienen que colgar de la barra nueva; hacerlas antes obligaría a rehacer
  la navegación después.
- **Es la única de las tres que no toca el backend**, así que no arrastra la
  pregunta del redeploy ni gasta créditos de Abacus.
- **Cabe en una corrida.** Las Fases 17 y 18 juntas no caben con la 16, y
  partirlas a la mitad deja la app en un estado peor que antes.

## Ruta completa sin build nuevo (contexto, no para pegar)

| Fase | Alcance | ¿Build? | ¿Redeploy? |
|---|---|---|---|
| **16** | Barra inferior, swipe, iconos, marcas de hora | No (JS) | No |
| **17** | Editar con IA (foto, texto, "explícale el cambio") | No (JS) | **Sí** — modo nuevo en `/v1/ai/meal-analysis` |
| **18** | Catálogo editable, porciones, pregunta de 3 salidas | No (JS) | Solo la parte de editar catálogo con IA |

Las tres se acumulan en **un solo build al final**. Las Fases 19
(notificaciones) y 20 (widget) quedan fuera: ambas tocan configuración nativa
y **cada una necesita su propio build**, así que no entran en una ruta "sin
build".
