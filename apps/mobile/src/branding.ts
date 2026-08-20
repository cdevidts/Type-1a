/**
 * Identidad visual que se define **una sola vez**.
 *
 * El logo es lo que más veces va a cambiar en la vida de la app. Si cada
 * componente escribe `require('../assets/icon.png')` por su cuenta, cambiarlo
 * obliga a buscar y editar cada sitio, y siempre queda uno atrás. Acá se
 * define la variable y todo lo demás la importa: cambiar el logo es cambiar
 * **esta línea**.
 *
 * Hoy apunta al icono de la app; cuando exista un logo propio, se reemplaza
 * el archivo o la ruta y nada más se toca. Ver la skill `/iconography`.
 */
// Metro resuelve los assets estáticos por `require`: un `import` de PNG no
// produce el módulo numérico que espera `<Image source>`. Por eso la regla se
// desactiva solo en esta línea.
// eslint-disable-next-line @typescript-eslint/no-require-imports
export const APP_LOGO: number = require('../assets/icon.png');
