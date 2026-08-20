---
name: iconography
description: Elegir, crear o cambiar cualquier icono de Type 1A — iconos de la interfaz, el logo de la app, y los iconos de las notificaciones de Android (que son un caso aparte y necesitan recursos nativos). Úsala SIEMPRE que vayas a poner un símbolo en pantalla, toques el logo, o cambies cómo se ve una notificación.
---

## Regla 1: nada de glifos Unicode como iconos

La app arrastra iconos hechos con caracteres (`◔`, `◍`, `•••`, `ƒ(x)`, `◎`).
**No agregues más, y reemplázalos cuando toques la zona.** Un glifo:

- se renderiza distinto en cada dispositivo y versión de Android, porque
  depende de la fuente del sistema;
- no tiene tamaño ni grosor controlables de forma fiable;
- se lee mal a tamaño chico, que es justo el de una barra de navegación;
- no comunica significado a alguien que no lo reconozca.

## Regla 2: los iconos vienen de Lucide, no se dibujan a mano

**`lucide-react-native` es la fuente de iconos del proyecto** (2026-08-20).
Está construida sobre `react-native-svg`, que ya era dependencia, así que no
agrega motor nuevo: cada icono es un componente SVG nativo.

- Licencia **ISC** (permisiva, sin atribución obligatoria en la app).
- ~1.500 iconos con trazo consistente entre sí.
- **Tree-shakeable**: solo entra al bundle lo que importas por nombre.
- Peer deps verificadas contra este repo: react 19 ✓, react-native-svg 15 ✓.

Por qué Lucide y no dibujar los SVG a mano: dibujarlos gasta tokens, sale
inconsistente entre iconos y no aguanta cuando la app necesita el vigésimo.
Catálogo para buscar el nombre exacto: <https://lucide.dev/icons/>.

### Importa por subpath, NO por nombre desde el barrel

Esto está **medido en este repo**, no supuesto:

```tsx
// ❌ mete los ~1.500 iconos al bundle: 1.263 → 3.088 módulos
import { Plus, UtensilsCrossed } from 'lucide-react-native';

// ✅ solo lo que usas: 1.263 → 1.316 módulos con cinco iconos
import Plus from 'lucide-react-native/icons/plus';
import UtensilsCrossed from 'lucide-react-native/icons/utensils-crossed';
```

**Metro no hace tree-shaking de un barrel export.** Aunque el paquete declare
`sideEffects: false`, importar por nombre desde la raíz arrastra el índice
completo. El subpath `lucide-react-native/icons/*` es oficial (está en el
`exports` del paquete) y trae los tipos, así que TypeScript lo resuelve sin
configuración extra.

El nombre del archivo es el del icono en **kebab-case**:
`UtensilsCrossed` → `icons/utensils-crossed`.

Convenciones:

- **Tamaño por prop `size`**, con 24 por defecto; el área tocable la pone el
  contenedor (44×44 mínimo), nunca el icono.
- **Color por prop `color`**, siempre desde `theme.ts`. Nunca un hex suelto.
- **`strokeWidth` 2** (el de Lucide por defecto). No lo cambies icono por
  icono: la consistencia del trazo es el motivo de usar una sola familia.
- Si un icono que necesitas no existe en Lucide, **primero busca un sinónimo**
  en el catálogo. Dibujar uno a mano es el último recurso, y entonces sí va
  como componente propio en `apps/mobile/src/components/icons/` imitando el
  trazo de Lucide.
- **Un icono nunca comunica solo**: en la barra de navegación va con su
  etiqueta; en un estado (sintético, atrasado, error) va con texto.

## Regla 3: el logo va en una variable, nunca en línea

El logo de la app es lo que va a cambiar más veces. Se define **una sola vez**
y todo lo demás lo referencia:

```ts
// apps/mobile/src/branding.ts
export const APP_LOGO = require('../assets/logo.png');
```

Ningún componente hace `require('../assets/logo.png')` por su cuenta ni
escribe el nombre del archivo. Cambiar el logo tiene que ser cambiar **una
línea**. Esto aplica también al icono del botón del chat de IA, que es el
logo.

## Regla 4: cada alarma con su propio icono y su propia estética

Es un problema de seguridad, no de estética: cuando las tres alarmas
(post-comida, corrección, capilar) llegan con el mismo símbolo y el mismo
color, se vuelven indistinguibles y la usuaria empieza a ignorarlas todas —
incluidas las que importan. Fatiga de alarma.

Cada tipo lleva:

- **icono propio**, reconocible de un vistazo en la bandeja;
- **color propio** (`color` en el payload de la notificación de Android);
- **título propio** que diga de qué es, sin abreviar.

### El caso aparte: iconos de notificación en Android

Los iconos de notificación de Android **no** pueden ser SVG de
`react-native-svg`: tienen que ser **recursos drawable nativos**, y el icono
pequeño de la barra de estado tiene que ser **monocromo con transparencia**
(Android lo pinta de un solo color y descarta el resto; un PNG a color sale
como un cuadrado blanco).

Consecuencia de planificación: cambiar los iconos de notificación **requiere
un build nuevo**, porque toca la configuración nativa vía `app.json`
(`expo-notifications` → `icon`/`color`) o un config plugin. No se puede
entregar en una corrida "sin build". Tenlo en cuenta al agrupar el trabajo.

## Antes de dar por terminado

1. Ningún glifo Unicode nuevo en la zona que tocaste.
2. Ningún hex suelto: todo color desde `theme.ts`.
3. El logo referenciado por variable.
4. Si tocaste notificaciones, anota en el roadmap que esa parte necesita build.
