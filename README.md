# Servidor de Oasis

Guarda las claves fuera de la aplicación y consulta Steam y Xbox. Node 18 o superior, sin dependencias.
Se probó localmente con servicios simulados; **no se ha probado contra Steam ni OpenXBL reales**.

## Publicarlo gratis en Render

1. Crea un repositorio en GitHub y sube estos archivos (`index.js`, `package.json`, `README.md`) en la raíz.
2. En render.com: **New**, **Web Service**, conecta ese repositorio.
   Runtime: Node. Build command: `npm install`. Start command: `npm start`. Instance type: **Free**.
3. En **Environment** agrega:
   - `STEAM_API_KEY`: tu clave de Steam. **Genera una nueva** en steamcommunity.com/dev/apikey y revoca la anterior.
   - `PUBLIC_URL`: la dirección que te asigne Render, por ejemplo `https://oasis-server.onrender.com`. Se conoce después de crear el servicio; luego edita la variable.
   - `XBL_APP_KEY`: la clave pública de tu "Xbox App" de OpenXBL (ver abajo).
4. Comprueba que `https://TU-SERVICIO.onrender.com/health` responda `{"ok":true,...}`.

Aviso: el plan gratuito de Render apaga el servicio tras 15 minutos sin uso y tarda cerca de un minuto en volver a encender. La primera consulta después de ese tiempo será lenta.

## Xbox con OpenXBL

1. Crea una cuenta en xbl.io y una "Xbox App" en tu perfil. Su guía está en xbl.io/training/xboxapp (no pude abrirla, revísala).
2. En OpenXBL, la URL de redirección de la app debe ser: `PUBLIC_URL/auth/xbox/return`.
3. Según esa guía, también hay que registrar una aplicación de Microsoft; sus mensajes de foros antiguos mencionan la redirección `https://xbl.io/app/callback`. Confírmalo en la guía actual.
4. Las direcciones de inicio de sesión y canje (`XBL_AUTH_URL`, `XBL_CLAIM_URL`) y la de datos (`XBL_API_BASE`) tienen valores por defecto tomados de la documentación pública, pero no pude confirmarlos. Si fallan, cámbialos con esas variables.
4. El plan gratuito de OpenXBL permite unas 150 solicitudes por hora en total.

## Rutas

- `/health`: estado.
- `/auth/steam` y `/auth/steam/return`: inicio de sesión de Steam (OpenID); termina en `oasis://auth?steamid=...`.
- `/auth/xbox` y `/auth/xbox/return`: inicio de sesión de Xbox; termina en `oasis://auth?ticket=...`.
- `/auth/ticket/:ticket`: la app canjea el boleto, una sola vez, por la clave del usuario.
- `/api/steam/:steamid`: biblioteca, horas, logros (12 juegos más jugados), foto y juego actual.
- `/api/xbox` (cabecera `X-Xbl-Key`): juegos y logros. Las horas de Xbox no se obtienen.
