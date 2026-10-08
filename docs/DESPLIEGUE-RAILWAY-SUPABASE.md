# Poner la plataforma en línea (Railway + Supabase)

Tiempo estimado: 30–45 minutos. Todo se hace desde navegador salvo dos comandos en tu computadora.

> Los precios de Railway y Supabase cambian: confírmalos antes de contratar. Para producción real
> conviene el plan de pago de Supabase (backups diarios automáticos; el plan gratis pausa proyectos
> inactivos y no es apto para facturación).

## 1. Supabase (la base de datos)

1. Crea un proyecto **nuevo** (no reutilices el de `italo-facturacion` ni el de EcoStone: esos siguen
   vivos hasta terminar la migración). Región cercana a Honduras: **us-east** (N. Virginia/Ohio).
   Guarda la contraseña de la base en tu gestor de contraseñas.
2. *Project Settings → Database → Connection string* → pestaña **Session pooler** (puerto 5432).
   Copia la cadena `postgresql://postgres.<ref>:<contraseña>@aws-0-us-east-1.pooler.supabase.com:5432/postgres`.
   Ese es tu `DATABASE_URL`. (Usa el *pooler* y no la conexión directa: la directa es IPv6 y Railway
   puede no alcanzarla.)
3. Nada más: **no hace falta crear tablas a mano**; la plataforma aplica sus migraciones sola.

## 2. Preparar los datos iniciales (desde tu computadora, una sola vez)

```bash
git clone <repo> && cd <repo>/plataforma && npm install
export DATABASE_URL='postgresql://postgres.xxxx:CONTRASEÑA@aws-0-us-east-1.pooler.supabase.com:5432/postgres'

npm run migrate        # crea todas las tablas (core, rrhh, pos, inv, fin) y siembra las 4 empresas
npm run crear-dueno -- tucorreo@dominio.com "Juan Carlos Funes" "una-contraseña-larga-y-unica"
```

Opcional, para ver Origen con datos de ejemplo (jugos, recetas, existencias):
`npm run seed:origen` (los precios y recetas son de demostración: se ajustan desde el sistema).

## 3. Railway (donde corre la aplicación)

1. *New Project → Deploy from GitHub repo* → elige el repositorio. En *Settings → Root Directory*
   pon `plataforma`. Railway lee `railway.json` (build, start y chequeo de salud `/api/health`).
2. *Variables* (todas obligatorias salvo donde se indica):

   | Variable | Valor |
   |---|---|
   | `DATABASE_URL` | la cadena del paso 1.2 |
   | `APP_JWT_SECRET` | 48+ caracteres aleatorios: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
   | `PIN_PEPPER` | otra cadena aleatoria distinta (no la cambies después, o todos los PIN dejan de servir) |
   | `NODE_ENV` | `production` |

3. *Settings → Networking → Generate Domain* (o conecta tu dominio, ej. `app.tugrupo.com`).
4. Abre el dominio: debes ver la pantalla con los logos. Entra con **Dirección del Grupo** y el correo
   del paso 2.

El servidor aplica solo las migraciones nuevas cada vez que arranca. Cada `git push` a la rama
conectada redespliega.

## 4. Primeros pasos dentro del sistema (en este orden)

1. **Administración → Datos de la empresa**: RTN, razón social y dirección fiscal reales de cada empresa
   (salen impresos en la factura).
2. **Administración → Sucursales**: ajusta nombres/direcciones; agrega las que falten.
3. **Administración → Usuarios**: crea gerentes (correo + contraseña) y cajeros/cocina (PIN).
   Una misma persona con correo puede tener rol distinto en cada empresa.
4. **Catálogo** y **Inventario → Recetas**: productos, opciones y recetas con costos reales.
5. **Administración → Facturación (CAI)**: mientras no cargues el CAI real todo sale **BORRADOR**. Carga
   el CAI, rango y fecha límite de la resolución del SAR por sucursal **cuando el contador lo confirme**.
6. Pon una tablet en la caja, abre el dominio, "Agregar a pantalla de inicio" (es una PWA), entra con PIN.

## 5. Respaldo y recuperación

- Plan de pago de Supabase: respaldos diarios automáticos (y recuperación a un punto en el tiempo como
  complemento). Revisa en *Database → Backups*.
- Respaldo propio adicional, recomendado semanal, desde tu computadora:
  `pg_dump "$DATABASE_URL" -Fc -f respaldo-$(date +%F).dump`
- La **bitácora de auditoría** se puede verificar en cualquier momento (Administración → Auditoría →
  "Verificar integridad").

## 6. Lista de seguridad antes de facturar de verdad

- [ ] `APP_JWT_SECRET` y `PIN_PEPPER` únicos y guardados fuera del repositorio.
- [ ] Contraseña de dueño larga y única; sin cuentas de demostración (`npm run demo` solo es local).
- [ ] RLS activa: en Supabase *Database → Advisors* no debe aparecer "RLS disabled".
- [ ] CAI real cargado y probado con una factura de prueba por sucursal.
- [ ] Un cierre de turno de prueba cuadrado en cada sucursal.
- [ ] Respaldo restaurado al menos una vez en un proyecto de prueba.
