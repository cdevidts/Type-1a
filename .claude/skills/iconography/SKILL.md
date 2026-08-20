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

## Regla 2: los iconos son SVG en el repo, sin dependencia nueva

`react-native-svg` **ya es dependencia** de `apps/mobile` (la usan
`GlucoseChart` y `SummaryCharts`). Los iconos se escriben como componentes
SVG propios en `apps/mobile/src/components/icons/`, no se instala una
librería de iconos.

Por qué no una librería: pesa cientos de iconos para usar ocho, y no tenemos
control sobre el trazo. Con `react-native-svg` un icono son ~10 líneas y queda
exactamente con el grosor del resto del sistema.

Convenciones:

- **Tamaño por prop `size`**, con 24 por defecto; el área tocable la pone el
  contenedor (44×44 mínimo), nunca el icono.
- **Color por prop `color`**, siempre desde `theme.ts`. Nunca un hex suelto.
- **Trazo de 2 px** a tamaño 24, `strokeLinecap="round"`, sin relleno salvo
  que el icono lo pida. Consistente con las marcas de los gráficos.
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
