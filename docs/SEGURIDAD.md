# Seguridad de la plataforma

Qué protege la plataforma, cómo se administra y, sobre todo, **cómo cambiar las llaves del sistema sin dejar a nadie fuera**.

## 1. Lo que ya está protegido

| Tema | Cómo |
|---|---|
| Contraseñas | scrypt con sal propia. Mínimo 8 caracteres y no triviales (se rechazan `12345678`, `password`, secuencias, repetidos, el propio correo o nombre). Aplica al crear usuarios, al restablecer y al cambiar la propia. |
| PIN de mostrador | Guardado como HMAC con `PIN_PEPPER`, único por empresa. Largo configurable por el dueño del grupo (de 4 a 6 dígitos; *Administración → Seguridad y permisos*). Los PIN ya creados siguen valiendo. Solo para roles operativos (cajero, producción, bodega, ventas, gerente). |
| Sesiones | JWT de 12 h con número de versión **y** fila en `core.sesiones_activas`: se pueden cerrar a distancia y desaparecen al instante. |
| Intentos | Límite por IP y por persona en contraseña, PIN y código de dos pasos. |
| Verificación en dos pasos | TOTP (RFC 6238), compatible con Google Authenticator, Microsoft Authenticator, Authy y 1Password. Secreto cifrado en la base. Un código no sirve dos veces. 10 códigos de recuperación de un solo uso. |
| Bitácora inalterable | Cadena de hashes; los eventos de seguridad (2FA, sesiones cerradas, políticas) quedan en ella. |
| Datos | Cada consulta lleva la empresa del contexto autenticado; la prueba `qa-seguridad.test.js` recorre **todas** las rutas con un usuario sin permisos y con un token de otra empresa. |

## 2. Verificación en dos pasos

* **Opcional para todos** los que entran con correo y contraseña: *Mi seguridad* (candado de la barra superior → «Mi seguridad»).
* **Obligatoria para dueño y administradores** cuando el dueño del grupo la enciende en *Administración → Seguridad y permisos → Reglas y dos pasos*. Condiciones:
  1. Quien la enciende debe tener la suya activa primero (si no, el sistema no lo deja: así no te quedas fuera).
  2. La persona que aún no la tiene la configura **en el momento de entrar** (escanea el QR, escribe el primer código, guarda sus códigos).
  3. Mientras sea obligatoria, no se puede desactivar.
* El PIN de mostrador **no** lleva 2FA (es un acceso de caja, no de dirección).
* **Perdió el teléfono:** primero con un código de recuperación. Si tampoco los tiene: otro dueño/administrador abre *Usuarios → la persona → «Reiniciar sus dos pasos»* (queda en bitácora y se cierran sus sesiones); al entrar la configura de nuevo.
* **El único dueño perdió teléfono y códigos:** se reinicia desde la base (ver §6).

## 3. Mis sesiones y cierre remoto

*Mi seguridad → Mis sesiones* lista cada equipo con sesión abierta (navegador, sistema, IP, última actividad) y permite cerrar uno o «cerrar las demás». Un administrador puede cerrar todas las sesiones de alguien de su equipo (*Usuarios → Cerrar sus sesiones*); un dueño del grupo o un dueño en otra empresa solo lo cierra otro dueño. Cambiar o restablecer una contraseña cierra todas sus sesiones. «Cerrar sesión» ahora también cierra la sesión **en el servidor**.

## 4. Permisos finos

*Administración → Seguridad y permisos*:

* **Permisos por rol:** matriz con todos los permisos y qué rol los trae.
* **Ajustes por persona:** quién tiene permisos sumados o quitados fuera de su rol. Revísala cada mes. Se cambian en *Usuarios → la persona → Permisos finos*.

Un administrador no puede crear otro administrador ni un dueño, ni dar el acceso a Dirección (`grupo:ver`). Los permisos nuevos de este agente: `sistema:ver` (Estado del sistema y copias; solo el dueño).

## 5. Variables secretas (dónde viven)

Solo en variables de entorno del hosting (Render u otro). **Nunca** en el código ni en el repositorio.

| Variable | Para qué | Si se pierde o cambia sin cuidado |
|---|---|---|
| `DATABASE_URL` | Conexión a Postgres (Supabase, pooler). | El servicio no arranca. |
| `APP_JWT_SECRET` (≥ 32 caracteres) | Firma las sesiones. Si no existe `MFA_KEY`, también cifra los secretos del 2FA. Si no existe `PIN_PEPPER`, es también el pepper del PIN. | Todas las sesiones se cierran; sin precaución, también se pierden los 2FA y los PIN. |
| `PIN_PEPPER` | Pepper de los PIN. **Defínela siempre aparte.** | Todos los PIN dejan de funcionar. |
| `MFA_KEY` | Llave que cifra los secretos del 2FA. **Defínela siempre aparte.** | Se pierden los 2FA activados. |
| `GMAIL_USER`, `GMAIL_APP_PASSWORD` | Correo de avisos. | Los avisos quedan «pendientes de configurar»; nada falla. |
| `APP_JWT_SECRET_ANTERIOR`, `PIN_PEPPER_ANTERIOR` | **Solo durante una rotación** (ver abajo). | — |

> **Primer paso recomendado, hoy, una sola vez:** si `PIN_PEPPER` y `MFA_KEY` no están definidas, créalas con el **mismo valor** que hoy tiene `APP_JWT_SECRET` (que es el que están usando). No cambia nada para nadie, y desde ese momento cada llave se puede rotar por separado.

Generar un valor nuevo (en cualquier computadora con Node): `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`.

## 6. Rotación de secretos paso a paso

Hazla fuera del horario de venta (por ejemplo después del cierre de caja) y **antes sincroniza las ventas hechas sin conexión** (cada caja debe mostrar «sin ventas pendientes»).

### 6.1 `APP_JWT_SECRET` — sin cerrar sesiones

1. Verifica que `PIN_PEPPER` y `MFA_KEY` estén definidas (ver arriba). Si no, defínelas con el valor **actual** de `APP_JWT_SECRET` y despliega.
2. En el hosting: pon el **valor viejo** en `APP_JWT_SECRET_ANTERIOR` y el **valor nuevo** en `APP_JWT_SECRET`. Guarda (se redespliega).
3. Comprueba: entra con un usuario, y que quien ya tenía sesión abierta sigue trabajando. *Estado del sistema* debe seguir en verde.
4. Pasadas **24 horas** (las sesiones duran 12 h), borra `APP_JWT_SECRET_ANTERIOR`.
5. Si sospechas que la llave se filtró, no esperes: al paso 2 sigue «cerrar todas las sesiones» (ver 6.5).

### 6.2 `PIN_PEPPER` — sin que nadie cambie su PIN

1. Pon el pepper viejo en `PIN_PEPPER_ANTERIOR` y el nuevo en `PIN_PEPPER`. Despliega.
2. Cada PIN entra con el viejo la primera vez y se guarda de inmediato con el nuevo.
3. Cuando todos hayan entrado al menos una vez (una o dos semanas) quita `PIN_PEPPER_ANTERIOR`. Quien no haya entrado en ese tiempo deberá recibir un PIN nuevo (*Usuarios → PIN*).

### 6.3 `MFA_KEY`

Los secretos del 2FA se cifran con esta llave. Para cambiarla: pon la nueva en `MFA_KEY` y la **vieja** en `APP_JWT_SECRET_ANTERIOR` (el sistema prueba ambas al descifrar). Cada secreto se **re-cifra solo** con la llave nueva la primera vez que su dueño entra con su código. Cuando todas las personas con 2FA hayan entrado una vez (o pasen un par de semanas), quita `APP_JWT_SECRET_ANTERIOR`. Quien no haya entrado en ese plazo se reinicia (*Reiniciar sus dos pasos*).

### 6.4 `DATABASE_URL` (contraseña de la base)

Supabase invalida la contraseña vieja en el instante en que la cambias, así que hay unos minutos sin servicio:

1. Avisa que habrá 5 minutos de pausa. Descarga una copia exportable por empresa (*Estado del sistema → Copia exportable*).
2. Supabase → *Project Settings → Database → Reset database password*. Copia la nueva cadena de conexión del **pooler** (Session pooler, puerto 5432 o 6543 según la que usabas) con la contraseña nueva.
3. Hosting → *Environment* → reemplaza `DATABASE_URL` y guarda (redespliega).
4. Verifica: `https://TU-DOMINIO/api/health` devuelve `{"ok":true}` y *Estado del sistema* muestra la base respondiendo.
5. Si algo falla: vuelve a pegar la cadena con la contraseña nueva (revisa que no tenga espacios ni caracteres sin codificar: `@`, `#`, `/` en la contraseña deben ir con %-codificación).

### 6.5 «Cerrar todas las sesiones» (emergencia)

Con acceso a la base (Supabase → SQL Editor):

```sql
update core.sesiones_activas set revocada_at = now(), revocada_motivo = 'emergencia' where revocada_at is null;
update core.usuarios set token_version = token_version + 1;
```

Todos tendrán que entrar de nuevo. Después cambia las contraseñas de dirección y rota `APP_JWT_SECRET` (6.1).

### 6.6 Reiniciar el 2FA del único dueño

```sql
delete from core.usuarios_mfa where usuario_id = (select id from core.usuarios where email = 'dueno@tuempresa.com');
delete from core.mfa_recuperacion where usuario_id = (select id from core.usuarios where email = 'dueno@tuempresa.com');
```

Al entrar, si la política es obligatoria, lo configura de nuevo.

### 6.7 `GMAIL_APP_PASSWORD`

Google → Cuenta → Seguridad → Contraseñas de aplicaciones: crea una nueva, reemplaza la variable y borra la vieja.

## 7. Calendario sugerido

| Cada | Qué |
|---|---|
| Mes | Revisar *Ajustes por persona* y las personas de dirección sin 2FA; cerrar los accesos de quien ya no trabaja. |
| 6 meses | Rotar `APP_JWT_SECRET` y `PIN_PEPPER` (6.1 y 6.2). |
| Año | Rotar la contraseña de la base (6.4) y la contraseña de aplicación de Gmail. |
| Siempre que salga alguien con acceso de dirección | 6.5 de esa persona (cerrar sesiones), cambiar contraseñas compartidas y rotar lo que conocía. |
