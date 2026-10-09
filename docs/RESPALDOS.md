# Respaldos, restauración y estado del sistema

## 1. Qué cubre cada copia (y qué no)

| Copia | Quién la hace | Qué cubre | Qué **no** cubre |
|---|---|---|---|
| **Respaldos de Supabase** | Supabase, automáticos (diarios; en el plan gratuito sin retención larga ni restauración a un momento exacto, en planes de pago con PITR) | Toda la base de datos: todas las empresas, usuarios, bitácora, archivos guardados en la base (documentos) | Si se borra el proyecto o se pierde la cuenta, se pierde la copia. Restaurar vuelve **toda** la base a ese día (no una sola empresa). No incluye las variables de entorno del hosting. |
| **Copia exportable** (esta plataforma) | El dueño, desde *Estado del sistema → Copia exportable* | Todos los datos de **una** empresa en un ZIP (CSV para Excel + JSON para restaurar) y su bitácora | No incluye sesiones, 2FA, errores ni las llaves del servidor. No es automática: hay que descargarla. |
| **Variables de entorno** | Tú, en un gestor de contraseñas | `DATABASE_URL`, `APP_JWT_SECRET`, `PIN_PEPPER`, `MFA_KEY`, `GMAIL_*` | — |

**Regla práctica:** Supabase protege contra un accidente de la base; la copia exportable protege contra perder Supabase y te deja los datos en un formato que abre cualquiera. Descarga una copia de cada empresa **una vez al mes** y antes de cualquier cambio grande (rotar la contraseña de la base, migraciones, cambiar de proveedor). Guárdalas cifradas, fuera de la computadora de trabajo.

## 2. Descargar la copia de una empresa

1. Entra como **dueño** a la empresa (la copia es de la empresa activa; para las otras, cambia de empresa).
2. *Estado del sistema → Copia exportable → Descargar copia de la empresa*.
3. Se baja `respaldo-<empresa>-<fecha>.zip` con:
   * `datos/<esquema>.<tabla>.json`: una tabla por archivo con los tipos exactos. **Es el que usa la restauración.**
   * `csv/<esquema>.<tabla>.csv`: lo mismo para Excel (UTF‑8, con las fórmulas neutralizadas).
   * `manifiesto.json`: tablas, filas y suma de control (SHA‑256) de cada archivo; migraciones aplicadas.
   * `LEEME.txt`.
4. Queda registrado en la bitácora (`respaldo_exportado`) y en *Estado del sistema*.

Por defecto el ZIP **no incluye contraseñas ni PIN**. La casilla «Incluir contraseñas y PIN cifrados» los agrega (hashes) para que, al restaurar, todos entren con lo mismo; trátalo como un secreto.

Las tablas se descubren solas en la base: cualquier módulo nuevo entra al respaldo sin tocar código. Una tabla pertenece a la empresa si tiene `empresa_id` o cuelga por llave foránea de otra que lo tiene (por ejemplo `detalle_venta` por `ventas`). Los usuarios y terceros (clientes/proveedores) son comunes al grupo y van completos.

## 3. Restaurar sobre una base vacía

Probado en las pruebas automáticas (`apps/api/test/respaldo.test.js`): se exporta una empresa con ventas, se restaura en una base nueva y se comprueba que hay las mismas filas, los mismos totales, la bitácora con sus hashes originales y que el inventario **no** se descuenta otra vez.

### 3.1 Preparar el destino

* Un proyecto de Supabase **nuevo** (o una base Postgres vacía) y su `DATABASE_URL` en tu terminal; sin `DATABASE_URL` el script restaura en la base local `data/pglite` (útil para ensayar).
* El código del repositorio y `npm install`.

### 3.2 Comprobar los archivos (no escribe nada)

```bash
node apps/api/src/db/restaurar.js italo.zip origen.zip ecostone.zip diserco.zip --solo-revisar
```

Verifica que cada ZIP no está dañado ni alterado (suma de control) y muestra cuántas filas trae.

### 3.3 Restaurar

```bash
export DATABASE_URL='postgresql://…'   # base DE DESTINO
node apps/api/src/db/restaurar.js italo.zip origen.zip ecostone.zip diserco.zip \
     --limpiar --confirmo=BORRAR-Y-RESTAURAR
```

El script: 1) aplica las migraciones, 2) vacía las tablas de la plataforma (**también lo que las migraciones siembran**, porque las empresas de la base nueva tienen otros identificadores) solo antes del **primer** ZIP, 3) carga cada ZIP en **una sola transacción** (si algo falla no queda nada a medias), 4) ajusta los contadores (números de orden, etc.) para que se pueda seguir vendiendo.

* `--limpiar` es destructivo y exige la frase `--confirmo=BORRAR-Y-RESTAURAR`. **Nunca lo apuntes a la base de producción en uso.**
* Sin `--limpiar` se suma a lo que haya (los registros repetidos se ignoran: restaurar dos veces no duplica).
* `--sin-replica`: por defecto usa `session_replication_role = replica` (carga rápida, no dispara los triggers de inventario ni de la bitácora). Si tu proveedor no lo permite, el script lo detecta y carga por **orden de dependencias** con los triggers de usuario apagados tabla por tabla (más lento). En ese modo restaura primero todas las empresas que se refieren entre sí en una sola ejecución (como en el ejemplo).

### 3.4 Después de restaurar

1. Apunta el servicio (`DATABASE_URL` en el hosting) a la base nueva y revisa *Estado del sistema*.
2. Si el ZIP no incluía claves: restablece contraseñas (*Usuarios → Restablecer clave*) o crea al dueño con `npm run crear-dueno`; los PIN se reasignan. Con las claves incluidas funcionan solas **si `PIN_PEPPER` es la misma**.
3. Cada persona vuelve a activar su verificación en dos pasos (no viaja en la copia).
4. **Bitácora:** se restaura con sus hashes y fechas originales. Como cada ZIP trae solo los eventos de su empresa, la cadena global tendrá «huecos» donde había eventos de otras empresas o del sistema; `core.verificar_auditoria()` puede señalarlos. Al restaurar las cuatro empresas el hueco se limita a los eventos sin empresa.

### 3.5 Lo que el script no hace

No restaura la configuración del hosting ni las variables de entorno, ni Supabase Auth (la plataforma usa su propio acceso), ni el contenido de otras apps (WizPOS no se toca).

## 4. Estado del sistema

*Administración → Estado del sistema* (solo el dueño del grupo):

* **Semáforo** de chequeos: base, espacio (contra `DB_LIMITE_MB`, 500 por defecto = plan gratuito de Supabase), migraciones, errores del servidor y de los navegadores en 24 h, caídas, correo, llaves del servidor, última copia exportable y 2FA de dirección.
* **Errores:** los del servidor (cualquier error 500, con ruta, usuario y empresa) y los de las pantallas del navegador, agrupados con el número de veces. Se conservan 30 días.
* **Caídas:** cuando el servicio arranca compara con su «latido» de cada minuto; si estuvo más de 4 minutos sin responder lo registra. Con **3 caídas en 24 h** manda un correo al dueño (`AVISO_CAIDAS_MIN` cambia el número; `0` lo apaga). Sin Gmail configurado queda como «aviso sin enviar» en esta misma pantalla.
* **Límite honesto:** un servidor caído no puede avisar que está caído. Para enterarte **en el momento**, crea un monitor externo gratuito (UptimeRobot, Better Stack) que consulte `https://TU-DOMINIO/api/health` cada 5 minutos y te avise por correo/SMS. `/api/health` es público y solo dice si el servicio y la base responden (`{"ok":true,"ms":…}`); el detalle está en la pantalla, que exige ser dueño.
* Si tu plan de hosting «duerme» el servicio por inactividad, esos reinicios cuentan como caídas; en ese caso conviene un plan sin suspensión.

## 5. Lista de comprobación mensual (10 minutos)

- [ ] Abrir *Estado del sistema*: todo en verde o con motivo conocido.
- [ ] Descargar la copia de cada empresa y guardarla cifrada fuera de la computadora de trabajo.
- [ ] Revisar *Errores*: ninguno repetido sin explicación.
- [ ] Una vez al trimestre, ensayar la restauración en una base de prueba (3.2 y 3.3 apuntando a un Supabase temporal o a la base local).
